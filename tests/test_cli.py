import json
from pathlib import Path

import pytest

from nostekon import __version__
from nostekon.cli import main

EXAMPLES = Path(__file__).parent.parent / "examples" / "drills"


def test_version_command_prints_version(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["version"]) == 0
    assert capsys.readouterr().out.strip() == __version__


def test_a_command_is_required() -> None:
    with pytest.raises(SystemExit) as exit_info:
        main([])
    assert exit_info.value.code == 2


@pytest.mark.parametrize("action", ["restore", "plan"])
def test_backup_restore_rejects_duplicate_expectations_before_execution(tmp_path, capsys, action):
    assert (
        main(
            [
                "backup",
                action,
                "--file",
                str(tmp_path / "missing.dump"),
                "--output",
                str(tmp_path / "run.json"),
                "--expect-table",
                "public.orders=3",
                "--expect-table",
                "public.orders=4",
            ]
        )
        == 2
    )
    assert "duplicate" in capsys.readouterr().err
    assert not (tmp_path / "run.json").exists()


@pytest.mark.parametrize("failed", [False, True])
def test_backup_restore_cli_exits_match_evidence(tmp_path, monkeypatch, capsys, failed):
    from nostekon import backup_restore

    captured = []

    def execute(backup, output, **kwargs):
        captured.append(kwargs)
        return {"status": {"checks": [{"passed": not failed}]}}

    monkeypatch.setattr(backup_restore, "execute_backup_restore", execute)
    assert main(
        [
            "backup",
            "restore",
            "--file",
            "backup.dump",
            "--output",
            str(tmp_path / "run.json"),
            "--expect-table",
            "public.orders=3",
        ]
    ) == int(failed)
    assert captured == [{"tables": {"public.orders": 3}, "timeout": 300}]
    assert "not measured" in capsys.readouterr().out


@pytest.mark.parametrize("timeout_args, expected_timeout", [([], 300), (["--timeout", "90"], 90)])
@pytest.mark.parametrize(
    "profile_args, profile",
    [([], None), (["--validation-profile", "profile.json"], Path("profile.json"))],
)
def test_backup_plan_cli_creates_plan_without_execution(
    tmp_path, monkeypatch, capsys, timeout_args, expected_timeout, profile_args, profile
):
    from nostekon import backup_restore

    captured = []

    def create(backup, output, **kwargs):
        captured.append((backup, output, kwargs))
        return {}

    monkeypatch.setattr(backup_restore, "create_restore_plan", create)
    assert (
        main(
            [
                "backup",
                "plan",
                "--file",
                "backup.dump",
                "--output",
                str(tmp_path / "plan.json"),
                "--expect-table",
                "public.orders=3",
                *timeout_args,
                *profile_args,
            ]
        )
        == 0
    )
    settings = {"tables": {"public.orders": 3}, "timeout": expected_timeout}
    if profile is not None:
        settings["validation_profile"] = profile
    assert captured == [
        (
            Path("backup.dump"),
            tmp_path / "plan.json",
            settings,
        )
    ]
    assert "not operator approval" in capsys.readouterr().out


def test_profile_cannot_override_a_saved_plan_at_execution(tmp_path):
    output = tmp_path / "run.json"
    with pytest.raises(SystemExit) as error:
        main(
            [
                "backup",
                "restore",
                "--file",
                "backup.dump",
                "--output",
                str(output),
                "--plan",
                "plan.json",
                "--validation-profile",
                "profile.json",
            ]
        )
    assert error.value.code == 2
    assert not output.exists()


def test_planned_restore_cli_forwards_only_the_plan(tmp_path, monkeypatch):
    from nostekon import backup_restore

    captured = []

    def execute(backup, output, **kwargs):
        captured.append(kwargs)
        return {"status": {"checks": [{"passed": True}]}}

    monkeypatch.setattr(backup_restore, "execute_backup_restore", execute)
    assert (
        main(
            [
                "backup",
                "restore",
                "--file",
                "backup.dump",
                "--output",
                str(tmp_path / "run.json"),
                "--plan",
                str(tmp_path / "plan.json"),
            ]
        )
        == 0
    )
    assert captured == [{"plan": tmp_path / "plan.json"}]


@pytest.mark.parametrize(
    "failure,code",
    [
        (OSError("cannot read archive"), 2),
        (RuntimeError("image unavailable"), 2),
        (KeyboardInterrupt(), 130),
    ],
)
def test_backup_plan_errors_restore_signal_handler(tmp_path, monkeypatch, failure, code):
    import signal

    from nostekon import backup_restore

    previous = signal.getsignal(signal.SIGTERM)

    def fail(backup, output, **kwargs):
        raise failure

    monkeypatch.setattr(backup_restore, "create_restore_plan", fail)
    assert (
        main(
            [
                "backup",
                "plan",
                "--file",
                "backup.dump",
                "--output",
                str(tmp_path / "plan.json"),
            ]
        )
        == code
    )
    assert signal.getsignal(signal.SIGTERM) == previous
    assert not (tmp_path / "plan.json").exists()


@pytest.mark.parametrize("override", [["--timeout", "300"], ["--expect-table", "public.orders=3"]])
def test_planned_restore_cli_rejects_overrides_before_execution(tmp_path, capsys, override):
    assert (
        main(
            [
                "backup",
                "restore",
                "--file",
                "missing.dump",
                "--output",
                str(tmp_path / "run.json"),
                "--plan",
                "missing-plan.json",
                *override,
            ]
        )
        == 2
    )
    assert "override" in capsys.readouterr().err
    assert not (tmp_path / "run.json").exists()


def test_levels_command_lists_all_levels(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["levels"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert [line.split()[0] for line in lines] == ["V0", "V1", "V2", "V3", "V4"]


def test_validate_accepts_the_examples(capsys: pytest.CaptureFixture[str]) -> None:
    files = sorted(str(path) for path in EXAMPLES.glob("*.yaml"))
    assert main(["validate", *files]) == 0
    assert capsys.readouterr().out.count("ok    ") == len(files)


def test_validate_reports_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    broken = tmp_path / "broken.yaml"
    broken.write_text("apiVersion: nostekon/v1alpha1\nkind: Drill\n")
    missing = tmp_path / "missing.yaml"
    assert main(["validate", str(broken), str(missing)]) == 1
    output = capsys.readouterr().out
    assert f"error {broken}: metadata: Field required" in output
    assert f"error {missing}: No such file or directory" in output


def test_validate_reports_invalid_yaml(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    broken = tmp_path / "broken.yaml"
    broken.write_text("spec: [unclosed\n")
    assert main(["validate", str(broken)]) == 1
    assert "invalid YAML" in capsys.readouterr().out


def test_schema_command_prints_json(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["schema"]) == 0
    assert json.loads(capsys.readouterr().out)["title"] == "DrillSpec"


def write_acks(tmp_path: Path) -> Path:
    csv_file = tmp_path / "acks.csv"
    csv_file.write_text(
        "# write_id,acked_at\n"
        "w1,2026-10-01T10:00:00Z\n"
        "w2,2026-10-01T10:00:01Z\n"
        "w3,2026-10-01T10:00:02+00:00\n"
    )
    ledger = tmp_path / "run.ledger.db"
    assert main(["import-acks", "--ledger", str(ledger), str(csv_file)]) == 0
    return ledger


def test_rpo_command_reports_tail_loss(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ledger = write_acks(tmp_path)
    present = tmp_path / "present.txt"
    present.write_text("w1\nw2\n")
    capsys.readouterr()
    command = ["rpo", "--ledger", str(ledger), "--present", str(present)]
    assert main([*command, "--failure-at", "2026-10-01T10:00:03Z", "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert (report["lost"], report["holes"], report["rpoSeconds"]) == (1, 0, 2.0)


def test_rpo_command_fails_on_holes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ledger = write_acks(tmp_path)
    present = tmp_path / "present.txt"
    present.write_text("w1\nw3\n")
    command = ["rpo", "--ledger", str(ledger), "--present", str(present)]
    assert main([*command, "--failure-at", "2026-10-01T10:00:03Z"]) == 1
    assert "holes           1" in capsys.readouterr().out


def test_rpo_command_needs_an_existing_ledger(tmp_path: Path) -> None:
    missing = str(tmp_path / "missing.db")
    command = ["rpo", "--ledger", missing, "--present", "-", "--failure-at", "2026-10-01T10:00Z"]
    assert main(command) == 2


def test_rpo_command_rejects_naive_failure_time(tmp_path: Path) -> None:
    command = ["rpo", "--ledger", "x.db", "--present", "-", "--failure-at", "2026-10-01T10:00"]
    with pytest.raises(SystemExit) as exit_info:
        main(command)
    assert exit_info.value.code == 2


def test_import_acks_reports_bad_rows(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    csv_file = tmp_path / "acks.csv"
    csv_file.write_text("w1,2026-10-01T10:00:00Z\nw2,yesterday\n")
    assert main(["import-acks", "--ledger", str(tmp_path / "run.ledger.db"), str(csv_file)]) == 1
    assert f"error {csv_file}:2: invalid ISO 8601 timestamp" in capsys.readouterr().err


def test_import_acks_rejects_duplicates(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    csv_file = tmp_path / "acks.csv"
    csv_file.write_text("w1,2026-10-01T10:00:00Z\nw1,2026-10-01T10:00:01Z\n")
    assert main(["import-acks", "--ledger", str(tmp_path / "run.ledger.db"), str(csv_file)]) == 1
    assert "duplicate write id 'w1'" in capsys.readouterr().err


def test_lab_command_requires_subcommand() -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["lab"])
    assert exit_info.value.code == 2


@pytest.mark.parametrize(
    "workload_args,expected",
    [
        ([], (1, 0, 0)),
        (["--writes", "3", "--after-backup-writes", "2"], (3, 2, 0)),
        (["--writes", "3", "--after-backup-writes", "2", "--rpo-seconds", "60"], (3, 2, 60)),
    ],
)
def test_lab_run_invokes_execute_isolated_drill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, workload_args, expected
) -> None:
    from nostekon import lab

    called_kwargs: dict = {}

    def fake_execute(**kwargs):
        called_kwargs.update(kwargs)
        return {"status": "ok"}

    monkeypatch.setattr(lab, "execute_isolated_drill", fake_execute)
    output = tmp_path / "out.json"
    assert main(["lab", "run", "--output", str(output), *workload_args]) == 0
    assert called_kwargs["output"] == output
    assert called_kwargs["source_context"] == lab.DEFAULT_SOURCE_CONTEXT
    assert called_kwargs["restore_context"] == lab.DEFAULT_RESTORE_CONTEXT
    assert (
        called_kwargs["write_count"],
        called_kwargs["after_backup_writes"],
        called_kwargs["rpo_seconds"],
    ) == expected


def test_lab_run_returns_error_on_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from nostekon import lab

    def failing_execute(**kwargs):
        raise RuntimeError("cluster unreachable")

    monkeypatch.setattr(lab, "execute_isolated_drill", failing_execute)
    output = tmp_path / "out.json"
    assert main(["lab", "run", "--output", str(output)]) == 1
    assert "error: lab restore drill failed: cluster unreachable" in capsys.readouterr().err


@pytest.mark.parametrize("passed", [True, False])
def test_lab_suite_command_forwards_configuration_and_gates_result(tmp_path, monkeypatch, passed):
    from nostekon import lab_suite

    arguments = {}

    def execute(**kwargs):
        arguments.update(kwargs)
        return {"passed": passed, "status": "passed" if passed else "failed", "cases": []}

    monkeypatch.setattr(lab_suite, "execute_lab_suite", execute)
    output = tmp_path / "suite"
    code = main(
        [
            "lab",
            "suite",
            "--output-dir",
            str(output),
            "--writes",
            "5",
            "--rpo-seconds",
            "120",
            "--source-context",
            "k3d-nostekon-a",
            "--restore-context",
            "k3d-nostekon-b",
            "--image",
            "postgres:16.8",
        ]
    )
    assert code == (0 if passed else 1)
    assert arguments == {
        "output": output,
        "source_context": "k3d-nostekon-a",
        "restore_context": "k3d-nostekon-b",
        "image": "postgres:16.8",
        "write_count": 5,
        "rpo_seconds": 120,
    }


def test_lab_suite_command_defaults(tmp_path, monkeypatch):
    from nostekon import lab_suite

    arguments = {}

    def execute(**kwargs):
        arguments.update(kwargs)
        return {"passed": True, "status": "passed", "cases": []}

    monkeypatch.setattr(lab_suite, "execute_lab_suite", execute)
    assert main(["lab", "suite", "--output-dir", str(tmp_path / "suite")]) == 0
    assert arguments["write_count"] == 10
    assert arguments["rpo_seconds"] == 60


@pytest.mark.parametrize(
    "exception,code", [(RuntimeError("cluster broke"), 1), (KeyboardInterrupt(), 130)]
)
def test_lab_suite_command_restores_signal_handler_on_failure(
    tmp_path, monkeypatch, exception, code
):
    import signal

    from nostekon import lab_suite

    previous = signal.getsignal(signal.SIGTERM)

    def execute(**kwargs):
        raise exception

    monkeypatch.setattr(lab_suite, "execute_lab_suite", execute)
    assert main(["lab", "suite", "--output-dir", str(tmp_path / "suite")]) == code
    assert signal.getsignal(signal.SIGTERM) == previous


def test_lab_status_reports_ready_and_not_ready(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from nostekon import lab

    def fake_health(context: str):
        if "source" in context:
            return {"context": context, "reachable": True, "uid": "123", "ready_nodes": 2}
        return {
            "context": context,
            "reachable": False,
            "error": "connection refused",
            "ready_nodes": 0,
        }

    monkeypatch.setattr(lab, "check_cluster_health", fake_health)
    assert main(["lab", "status"]) == 1
    output = capsys.readouterr().out
    assert "source   [READY    ]" in output
    assert "restore  [NOT READY]" in output


def test_lab_status_rejects_same_cluster(monkeypatch, capsys):
    from nostekon import lab

    monkeypatch.setattr(
        lab,
        "check_cluster_health",
        lambda context: {
            "reachable": True,
            "uid": "same",
            "ready_nodes": 1,
            "total_nodes": 1,
        },
    )
    assert main(["lab", "status"]) == 1
    assert "same cluster" in capsys.readouterr().err


def test_lab_status_requires_all_nodes_ready(monkeypatch):
    from nostekon import lab

    monkeypatch.setattr(
        lab,
        "check_cluster_health",
        lambda context: {
            "reachable": True,
            "uid": context,
            "ready_nodes": 1,
            "total_nodes": 2,
        },
    )
    assert main(["lab", "status"]) == 1


def test_lab_sigterm_returns_interrupted_and_restores_handler(monkeypatch, tmp_path):
    import signal

    from nostekon import lab

    previous = signal.getsignal(signal.SIGTERM)

    def terminate(**kwargs):
        signal.raise_signal(signal.SIGTERM)

    monkeypatch.setattr(lab, "execute_isolated_drill", terminate)
    assert main(["lab", "run", "--output", str(tmp_path / "run.json")]) == 130
    assert signal.getsignal(signal.SIGTERM) == previous
