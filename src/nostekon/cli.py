import argparse
import csv
import json
import signal
import sqlite3
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, TextIO

import yaml
from pydantic import ValidationError

from nostekon import __version__
from nostekon.ledger import Ledger, RpoReport, measure_rpo
from nostekon.levels import LEVELS
from nostekon.spec import describe_errors, drill_schema, lint, load_drill


def _timestamp(text: str) -> datetime:
    try:
        moment = datetime.fromisoformat(text.strip())
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"invalid ISO 8601 timestamp {text!r}") from error
    if moment.utcoffset() is None:
        raise argparse.ArgumentTypeError(f"timestamp {text!r} needs a UTC offset such as Z")
    return moment


@contextmanager
def _open_input(name: str) -> Iterator[TextIO]:
    if name == "-":
        yield sys.stdin
    else:
        with Path(name).open(encoding="utf-8", newline="") as handle:
            yield handle


def _cmd_version(_: argparse.Namespace) -> int:
    print(__version__)
    return 0


def _table_expectation(text: str) -> tuple[str, int]:
    try:
        table, count = text.rsplit("=", 1)
        if not count.isascii() or not count.isdigit():
            raise ValueError
        return table, int(count)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected schema.table=NONNEGATIVE_COUNT") from error


def _backup_expectations(args: argparse.Namespace) -> dict:
    tables = dict(args.expect_table)
    if len(tables) != len(args.expect_table):
        raise ValueError("duplicate table expectations are not allowed")
    return tables


def _cmd_backup_plan(args: argparse.Namespace) -> int:
    from nostekon.backup_restore import create_restore_plan

    def interrupt(signum, frame):
        raise KeyboardInterrupt("restore planning interrupted")

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        settings = {
            "tables": _backup_expectations(args),
            "timeout": args.timeout if args.timeout is not None else 300,
        }
        if args.validation_profile is not None:
            settings["validation_profile"] = Path(args.validation_profile)
        create_restore_plan(
            Path(args.file),
            Path(args.output),
            **settings,
        )
        print(f"Recorded restore plan in {args.output}")
        print(
            "Input binding only; not operator approval or authenticated provenance. No restore ran."
        )
        return 0
    except KeyboardInterrupt:
        print(
            "error: planning interrupted; inspect the plan output before retrying", file=sys.stderr
        )
        return 130
    except (OSError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, previous)


def _cmd_backup_restore(args: argparse.Namespace) -> int:
    from nostekon.backup_restore import execute_backup_restore

    def interrupt(signum, frame):
        raise KeyboardInterrupt("backup rehearsal interrupted")

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        if args.plan is not None:
            if args.expect_table or args.timeout is not None:
                raise ValueError("cannot override settings when --plan is supplied")
            result = execute_backup_restore(
                Path(args.file), Path(args.output), plan=Path(args.plan)
            )
        else:
            result = execute_backup_restore(
                Path(args.file),
                Path(args.output),
                tables=_backup_expectations(args),
                timeout=args.timeout if args.timeout is not None else 300,
            )
        print(f"Recorded backup rehearsal in {args.output}")
        print(
            "Local backup rehearsal only; incident RTO and acknowledged-write RPO are not measured."
        )
        return 0 if all(check["passed"] for check in result["status"]["checks"]) else 1
    except KeyboardInterrupt:
        print(
            "error: rehearsal interrupted; inspect retained evidence and cleanup", file=sys.stderr
        )
        return 130
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, previous)


def _cmd_backup_preflight(args: argparse.Namespace) -> int:
    from nostekon.backup_restore import preflight_backup

    def interrupt(signum, frame):
        raise KeyboardInterrupt("backup preflight interrupted")

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        result = preflight_backup(Path(args.file), plan=Path(args.plan))
        print(json.dumps(result, indent=2))
        print(
            "Technical preflight only; not approval or restore evidence. No target created.",
            file=sys.stderr,
        )
        return 0 if result["passed"] else 1
    except KeyboardInterrupt:
        print("error: preflight interrupted; no restore was started", file=sys.stderr)
        return 130
    except (OSError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, previous)


def _cmd_backup_recover(args: argparse.Namespace) -> int:
    def interrupt(signum, frame):
        raise KeyboardInterrupt("backup recovery interrupted")

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        if sys.platform != "linux":
            raise ValueError("backup recovery requires Linux and a local Docker daemon")
        from nostekon.backup_recovery import recover_backup

        review = recover_backup(Path(args.directory), confirm_cleanup=args.confirm_cleanup)
        print(json.dumps(review, indent=2))
        print(
            "Cleanup state only; not restore evidence, incident RTO or RPO. No restore resumed.",
            file=sys.stderr,
        )
        return 0
    except KeyboardInterrupt:
        print(
            "error: recovery interrupted; inspect the checkpoint before retrying", file=sys.stderr
        )
        return 130
    except (OSError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, previous)


def _cmd_levels(_: argparse.Namespace) -> int:
    for level, info in LEVELS.items():
        print(f"{level.name}  {info.question:<34}  {info.evidence}")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    failed = False
    for path in args.files:
        try:
            drill = load_drill(path)
        except OSError as error:
            problems = [error.strerror or str(error)]
        except yaml.YAMLError as error:
            problems = [f"invalid YAML: {error}"]
        except ValidationError as error:
            problems = describe_errors(error)
        else:
            for warning in lint(drill):
                print(f"warn  {path}: {warning}")
            print(f"ok    {path}")
            continue
        failed = True
        for problem in problems:
            print(f"error {path}: {problem}")
    return 1 if failed else 0


def _cmd_schema(_: argparse.Namespace) -> int:
    print(json.dumps(drill_schema(), indent=2))
    return 0


def _cmd_import_acks(args: argparse.Namespace) -> int:
    imported = 0
    with Ledger(args.ledger) as ledger, _open_input(args.file) as handle:
        for line, row in enumerate(csv.reader(handle), start=1):
            if not row or row[0].startswith("#"):
                continue
            try:
                if len(row) != 2:
                    raise ValueError(f"expected write_id,acked_at but got {len(row)} columns")
                ledger.record(row[0], _timestamp(row[1]))
            except sqlite3.IntegrityError:
                print(f"error {args.file}:{line}: duplicate write id {row[0]!r}", file=sys.stderr)
                return 1
            except (ValueError, argparse.ArgumentTypeError) as error:
                print(f"error {args.file}:{line}: {error}", file=sys.stderr)
                return 1
            imported += 1
    print(f"imported {imported} acknowledged writes into {args.ledger}")
    return 0


def _report_json(report: RpoReport) -> dict[str, Any]:
    def iso(moment: datetime | None) -> str | None:
        return moment.isoformat() if moment else None

    resolution = report.resolution
    return {
        "failureAt": iso(report.failure_at),
        "acknowledged": report.acknowledged,
        "recovered": report.recovered,
        "lost": report.lost,
        "holes": report.holes,
        "unexpected": report.unexpected,
        "consistent": report.consistent,
        "recoveryPoint": iso(report.recovery_point),
        "firstLostAt": iso(report.first_lost_at),
        "rpoSeconds": report.rpo.total_seconds(),
        "resolutionSeconds": resolution.total_seconds() if resolution else None,
    }


def _cmd_rpo(args: argparse.Namespace) -> int:
    if not Path(args.ledger).is_file():
        print(f"error: ledger {args.ledger} does not exist", file=sys.stderr)
        return 2
    with Ledger(args.ledger) as ledger:
        acks = ledger.acks()
    with _open_input(args.present) as handle:
        present = [line.strip() for line in handle if line.strip()]
    report = measure_rpo(acks, present, args.failure_at)

    if args.json:
        print(json.dumps(_report_json(report), indent=2))
    else:
        rpo = f"{report.rpo.total_seconds():.3f}s"
        if report.resolution is not None:
            rpo += f" (true value within {report.resolution.total_seconds():.3f}s)"
        rows = [
            ("acknowledged", report.acknowledged),
            ("recovered", report.recovered),
            ("lost", report.lost),
            ("holes", report.holes),
            ("unexpected", report.unexpected),
            ("recovery point", report.recovery_point.isoformat() if report.recovery_point else "-"),
            ("first lost", report.first_lost_at.isoformat() if report.first_lost_at else "-"),
            ("rpo", rpo),
        ]
        for label, value in rows:
            print(f"{label:<15} {value}")
    return 0 if report.consistent else 1


def _cmd_lab_run(args: argparse.Namespace) -> int:
    from nostekon.lab import (
        DEFAULT_POSTGRES_IMAGE,
        DEFAULT_RESTORE_CONTEXT,
        DEFAULT_SOURCE_CONTEXT,
        execute_isolated_drill,
    )

    def interrupt(signum, frame):
        raise KeyboardInterrupt("lab interrupted")

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        execute_isolated_drill(
            output=Path(args.output),
            source_context=args.source_context or DEFAULT_SOURCE_CONTEXT,
            restore_context=args.restore_context or DEFAULT_RESTORE_CONTEXT,
            image=args.image or DEFAULT_POSTGRES_IMAGE,
            write_count=args.writes,
            after_backup_writes=args.after_backup_writes,
            rpo_seconds=args.rpo_seconds,
        )
        return 0
    except KeyboardInterrupt:
        print("error: lab interrupted; inspect evidence and cleanup messages", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"error: lab restore drill failed: {error}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


def _cmd_lab_suite(args: argparse.Namespace) -> int:
    from nostekon.lab_suite import (
        DEFAULT_POSTGRES_IMAGE,
        DEFAULT_RESTORE_CONTEXT,
        DEFAULT_SOURCE_CONTEXT,
        execute_lab_suite,
    )

    def interrupt(signum, frame):
        raise KeyboardInterrupt("lab suite interrupted")

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        result = execute_lab_suite(
            output=Path(args.output_dir),
            source_context=args.source_context or DEFAULT_SOURCE_CONTEXT,
            restore_context=args.restore_context or DEFAULT_RESTORE_CONTEXT,
            image=args.image or DEFAULT_POSTGRES_IMAGE,
            write_count=args.writes,
            rpo_seconds=args.rpo_seconds,
        )
        for case in result["cases"]:
            state = "PASS" if case["passed"] else "FAIL"
            measurement = case.get("rpo")
            detail = (
                f"{measurement['lost']} writes lost, RPO {measurement['seconds']:.6f}s"
                if measurement
                else "RPO unmeasured"
            )
            print(f"{state:<5} {case['name']:<12} {detail}")
        print(f"Lab suite {result['status']}; summary: {Path(args.output_dir) / 'suite.json'}")
        return 0 if result["passed"] else 1
    except KeyboardInterrupt:
        print("error: lab suite interrupted; inspect summary and cleanup messages", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"error: lab suite failed: {error}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


def _cmd_lab_status(args: argparse.Namespace) -> int:
    from nostekon.lab import DEFAULT_RESTORE_CONTEXT, DEFAULT_SOURCE_CONTEXT, check_cluster_health

    contexts = [
        ("source", args.source_context or DEFAULT_SOURCE_CONTEXT),
        ("restore", args.restore_context or DEFAULT_RESTORE_CONTEXT),
    ]
    all_ok = True
    identities = []
    for role, ctx in contexts:
        health = check_cluster_health(ctx)
        ready = health["reachable"] and health["ready_nodes"] > 0
        ready = ready and health["ready_nodes"] == health.get("total_nodes", health["ready_nodes"])
        status = "READY" if ready else "NOT READY"
        identities.append(health.get("uid"))
        if status != "READY":
            all_ok = False
        print(f"{role:<8} [{status:<9}] context={ctx} nodes={health['ready_nodes']}")
    if all(identities) and identities[0] == identities[1]:
        print("error: source and restore contexts address the same cluster", file=sys.stderr)
        all_ok = False
    return 0 if all_ok else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nostekon",
        description="Prove, don't assume, that you can recover.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    version = commands.add_parser("version", help="print the Nostekon version")
    version.set_defaults(handler=_cmd_version)

    levels = commands.add_parser("levels", help="list the verification levels V0-V4")
    levels.set_defaults(handler=_cmd_levels)

    validate = commands.add_parser("validate", help="validate drill spec files")
    validate.add_argument("files", nargs="+", metavar="FILE")
    validate.set_defaults(handler=_cmd_validate)

    schema = commands.add_parser("schema", help="print the drill spec JSON Schema")
    schema.set_defaults(handler=_cmd_schema)

    import_acks = commands.add_parser(
        "import-acks", help="load acknowledged writes (CSV: write_id,acked_at) into a ledger"
    )
    import_acks.add_argument("--ledger", required=True, help="ledger database to append to")
    import_acks.add_argument("file", metavar="CSV", help="CSV file, or - for standard input")
    import_acks.set_defaults(handler=_cmd_import_acks)

    rpo = commands.add_parser("rpo", help="measure the exact RPO of a restore")
    rpo.add_argument("--ledger", required=True, help="ledger of acknowledged writes")
    rpo.add_argument(
        "--present",
        required=True,
        metavar="FILE",
        help="write IDs found in the restored database, one per line, or - for standard input",
    )
    rpo.add_argument(
        "--failure-at", required=True, type=_timestamp, help="failure time, e.g. 2026-10-01T10:00Z"
    )
    rpo.add_argument("--json", action="store_true", help="print the report as JSON")
    rpo.set_defaults(handler=_cmd_rpo)

    backup = commands.add_parser("backup", help="test real backup files in a local isolated target")
    backup_commands = backup.add_subparsers(dest="backup_command", required=True, metavar="ACTION")
    backup_plan = backup_commands.add_parser(
        "plan", help="bind backup bytes, cached image and expectations without restoring"
    )
    backup_plan.set_defaults(handler=_cmd_backup_plan)
    backup_plan.add_argument(
        "--validation-profile", help="strict declarative PostgreSQL profile to freeze in a v2 plan"
    )
    backup_restore = backup_commands.add_parser(
        "restore", help="restore a PostgreSQL custom archive; no production connection"
    )
    for action in (backup_plan, backup_restore):
        action.add_argument("--file", required=True, help="completed pg_dump -Fc archive, <=64 MiB")
        action.add_argument("--output", required=True, help="new private JSON output file")
        action.add_argument(
            "--expect-table",
            action="append",
            default=[],
            type=_table_expectation,
            metavar="SCHEMA.TABLE=COUNT",
            help="up to 20 snapshot-specific row-count expectations",
        )
        action.add_argument(
            "--timeout", type=int, default=None, help="30..1800 seconds; default 300"
        )
    backup_restore.add_argument(
        "--plan", help="strict restore plan; no expectation or timeout overrides"
    )
    backup_restore.set_defaults(handler=_cmd_backup_restore)
    backup_preflight = backup_commands.add_parser(
        "preflight",
        help="check reviewed backup binding and local metadata without creating a target",
    )
    backup_preflight.add_argument("--file", required=True, help="approved custom archive, <=64 MiB")
    backup_preflight.add_argument("--plan", required=True, help="reviewed strict restore plan")
    backup_preflight.set_defaults(handler=_cmd_backup_preflight)
    backup_recover = backup_commands.add_parser(
        "recover", help="inspect a private recovery checkpoint; cleanup requires confirmation"
    )
    backup_recover.add_argument(
        "--directory", required=True, help="original OUTPUT.json.recovery directory"
    )
    backup_recover.add_argument(
        "--confirm-cleanup",
        action="store_true",
        help="assert runner and Docker creation have stopped; "
        "remove only the matching target and snapshot",
    )
    backup_recover.set_defaults(handler=_cmd_backup_recover)

    lab = commands.add_parser("lab", help="manage and run disposable k3d lab restore drills")
    lab_commands = lab.add_subparsers(dest="lab_command", required=True, metavar="ACTION")

    lab_status = lab_commands.add_parser(
        "status", help="check connectivity and node readiness for lab clusters"
    )
    lab_status.add_argument(
        "--source-context",
        default=None,
        help="kubectl context for source cluster (default: k3d-nostekon-source)",
    )
    lab_status.add_argument(
        "--restore-context",
        default=None,
        help="kubectl context for restore cluster (default: k3d-nostekon-restore)",
    )
    lab_status.set_defaults(handler=_cmd_lab_status)

    lab_run = lab_commands.add_parser(
        "run", help="run an isolated PostgreSQL restore drill across k3d clusters"
    )
    lab_run.add_argument(
        "--output", required=True, metavar="FILE", help="output DrillRun JSON file path"
    )
    lab_run.add_argument(
        "--source-context",
        default=None,
        help="kubectl context for source cluster (default: k3d-nostekon-source)",
    )
    lab_run.add_argument(
        "--restore-context",
        default=None,
        help="kubectl context for restore cluster (default: k3d-nostekon-restore)",
    )
    lab_run.add_argument(
        "--image", default=None, help="PostgreSQL image to use (default: postgres:16.8)"
    )
    lab_run.add_argument(
        "--writes",
        type=int,
        default=1,
        help="acknowledged writes before backup (default: 1; total capped at 100)",
    )
    lab_run.add_argument(
        "--after-backup-writes",
        type=int,
        default=0,
        help="writes after backup to demonstrate zero-loss failure (default: 0)",
    )
    lab_run.add_argument(
        "--rpo-seconds",
        type=int,
        default=0,
        help="permitted tail-loss window, 0 to 86400 seconds (default: 0)",
    )
    lab_run.set_defaults(handler=_cmd_lab_run)

    lab_suite = lab_commands.add_parser(
        "suite", help="run zero-loss, expected-loss and budgeted-loss policy regression cases"
    )
    lab_suite.add_argument(
        "--output-dir",
        required=True,
        metavar="DIR",
        help="new private directory for suite evidence",
    )
    lab_suite.add_argument("--source-context", default=None, help="source lab kubectl context")
    lab_suite.add_argument("--restore-context", default=None, help="restore lab kubectl context")
    lab_suite.add_argument(
        "--image", default=None, help="PostgreSQL image (default: postgres:16.8)"
    )
    lab_suite.add_argument(
        "--writes", type=int, default=10, help="writes before each backup, 1 to 98 (default: 10)"
    )
    lab_suite.add_argument(
        "--rpo-seconds",
        type=int,
        default=60,
        help="budget for the permitted-loss case, 1 to 86400 seconds (default: 60)",
    )
    lab_suite.set_defaults(handler=_cmd_lab_suite)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.handler(args)
