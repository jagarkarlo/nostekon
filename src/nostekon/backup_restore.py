import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from nostekon.lab import utc_timestamp

MAX_BACKUP_BYTES = 64 * 1024 * 1024
MAX_PLAN_BYTES = 16 * 1024


def docker_command(arguments: list[str], *, timeout: float) -> bytes:
    environment = os.environ.copy()
    for key in (
        "DOCKER_CONTEXT",
        "DOCKER_HOST",
        "DOCKER_TLS",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
    ):
        environment.pop(key, None)
    with subprocess.Popen(
        ["docker", "--host", "unix:///var/run/docker.sock", *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        start_new_session=True,
    ) as process:
        deadline = time.monotonic() + timeout
        output = bytearray()
        errors = 0
        try:
            with selectors.DefaultSelector() as streams:
                streams.register(process.stdout, selectors.EVENT_READ, "output")
                streams.register(process.stderr, selectors.EVENT_READ, "error")
                while streams.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Docker command deadline exceeded")
                    for event, _mask in streams.select(remaining):
                        chunk = os.read(event.fileobj.fileno(), 4096)
                        if not chunk:
                            streams.unregister(event.fileobj)
                        elif event.data == "output":
                            output.extend(chunk)
                        else:
                            errors += len(chunk)
                        if len(output) > 4096 or errors > 65536:
                            raise RuntimeError("Docker command output exceeded its safety limit")
            result = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            if result:
                raise RuntimeError(
                    f"Docker {arguments[0]} failed (exit {result}); database output omitted"
                )
            return bytes(output)
        except BaseException:
            process.kill()
            process.wait()
            raise


def _restore_settings(tables, timeout) -> dict:
    if type(timeout) is not int or not 30 <= timeout <= 1800:
        raise ValueError("timeout must be a whole number between 30 and 1800 seconds")
    tables = {} if tables is None else dict(tables)
    if len(tables) > 20:
        raise ValueError("at most 20 table expectations are supported")
    for table, count in tables.items():
        if (
            not isinstance(table, str)
            or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}", table)
            or table.split(".")[0] in ("pg_catalog", "information_schema")
            or table.split(".")[0].startswith("pg_")
        ):
            raise ValueError(
                "table must be a non-system schema.table with lowercase SQL identifiers"
            )
        if type(count) is not int or not 0 <= count <= 2**63 - 1:
            raise ValueError("expected row count must be a nonnegative 64-bit integer")
    return tables


def _validate_invariants(invariants) -> list:
    if type(invariants) is not list or not 1 <= len(invariants) <= 20:
        raise ValueError("validation profile requires 1..20 invariants")
    names = set()
    for invariant in invariants:
        if type(invariant) is not dict or invariant.get("type") not in (
            "not_null",
            "unique",
            "foreign_key",
        ):
            raise ValueError("unsupported invariant type")
        fields = {"name", "type", "table", "column"}
        if invariant["type"] == "foreign_key":
            fields.add("reference")
        if set(invariant) != fields:
            raise ValueError("invariant contains missing or unknown fields")
        name = invariant["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", name):
            raise ValueError("invariant name must be a lowercase slug of at most 63 characters")
        if name in names:
            raise ValueError("duplicate invariant names are not allowed")
        names.add(name)
        relations = [(invariant["table"], invariant["column"])]
        if invariant["type"] == "foreign_key":
            reference = invariant["reference"]
            if type(reference) is not dict or set(reference) != {"table", "column"}:
                raise ValueError("foreign-key reference requires exactly table and column")
            relations.append((reference["table"], reference["column"]))
        for table, column in relations:
            if (
                not isinstance(table, str)
                or not isinstance(column, str)
                or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", column)
            ):
                raise ValueError("invariant table and column must be validated SQL identifiers")
            _restore_settings({table: 0}, 300)
    return invariants


def _validate_plan(plan) -> dict:
    if type(plan) is not dict:
        raise ValueError("restore plan must be an object")
    fields = {
        "apiVersion",
        "kind",
        "backup",
        "imageId",
        "tables",
        "timeoutSeconds",
    }
    if plan.get("apiVersion") == "nostekon/restore-plan/v2alpha1":
        fields.add("invariants")
    if set(plan) != fields:
        raise ValueError("restore plan must contain exactly the versioned plan fields")
    if (
        plan["apiVersion"]
        not in ("nostekon/restore-plan/v1alpha1", "nostekon/restore-plan/v2alpha1")
        or plan["kind"] != "PostgreSQLRestorePlan"
    ):
        raise ValueError("unsupported restore plan version or kind")
    backup = plan["backup"]
    if type(backup) is not dict or set(backup) != {"sha256", "bytes"}:
        raise ValueError("restore plan backup must contain only sha256 and bytes")
    if (
        not isinstance(backup["sha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", backup["sha256"])
        or type(backup["bytes"]) is not int
        or not 5 <= backup["bytes"] <= MAX_BACKUP_BYTES
    ):
        raise ValueError("restore plan backup digest or size is invalid")
    if not isinstance(plan["imageId"], str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", plan["imageId"]
    ):
        raise ValueError("restore plan image must be an immutable local image ID")
    if type(plan["tables"]) is not dict:
        raise ValueError("restore plan tables must be an object")
    _restore_settings(plan["tables"], plan["timeoutSeconds"])
    if "invariants" in plan:
        _validate_invariants(plan["invariants"])
        if not plan["tables"]:
            raise ValueError("semantic validation requires at least one table-count expectation")
    return plan


def _load_bounded_json(path: Path, label: str):
    def unique_fields(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{label} contains duplicate JSON fields")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError(f"{label} cannot contain nonfinite numbers")

    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or not 1 <= metadata.st_size <= MAX_PLAN_BYTES:
            raise ValueError(f"{label} must be a regular file of at most 16 KiB")
        payload = handle.read(MAX_PLAN_BYTES + 1)
    if len(payload) > MAX_PLAN_BYTES:
        raise ValueError(f"{label} exceeds 16 KiB")
    try:
        plan = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=unique_fields,
            parse_constant=invalid_constant,
        )
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError(f"{label} must be bounded UTF-8 JSON") from error
    return plan


def load_restore_plan(path: Path) -> dict:
    return _validate_plan(_load_bounded_json(path, "restore plan"))


def load_validation_profile(path: Path) -> list:
    profile = _load_bounded_json(path, "validation profile")
    if type(profile) is not dict or set(profile) != {"apiVersion", "kind", "invariants"}:
        raise ValueError("validation profile must contain exactly the versioned profile fields")
    if (
        profile["apiVersion"] != "nostekon/validation-profile/v1alpha1"
        or profile["kind"] != "PostgreSQLValidationProfile"
    ):
        raise ValueError("unsupported validation profile version or kind")
    return _validate_invariants(profile["invariants"])


def create_restore_plan(
    backup: Path, output: Path, *, tables=None, timeout=300, validation_profile: Path | None = None
) -> dict:
    if sys.platform != "linux":
        raise ValueError("backup rehearsal currently requires Linux and a local Docker daemon")
    tables = _restore_settings(tables, timeout)
    invariants = (
        load_validation_profile(validation_profile) if validation_profile is not None else None
    )
    if invariants is not None and not tables:
        raise ValueError("semantic validation requires at least one table-count expectation")
    with tempfile.TemporaryDirectory(prefix="nostekon-plan-") as directory:
        snapshot = snapshot_backup(backup, Path(directory))
        with snapshot.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        image = (
            docker_command(
                ["image", "inspect", "--format={{.Id}}", "postgres:16.8"], timeout=timeout
            )
            .decode()
            .strip()
        )
        plan = {
            "apiVersion": "nostekon/restore-plan/v1alpha1",
            "kind": "PostgreSQLRestorePlan",
            "backup": {"sha256": digest, "bytes": snapshot.stat().st_size},
            "imageId": image,
            "tables": tables,
            "timeoutSeconds": timeout,
        }
        if invariants is not None:
            plan["apiVersion"] = "nostekon/restore-plan/v2alpha1"
            plan["invariants"] = invariants
        _validate_plan(plan)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=output.parent, prefix=".nostekon-plan-", delete=False
    ) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(plan, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            os.link(temporary, output)
            parent = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            temporary.unlink(missing_ok=True)
    return plan


def _invariant_description(invariant: dict) -> str:
    description = f"{invariant['type']}: {invariant['table']}.{invariant['column']}"
    if invariant["type"] == "foreign_key":
        reference = invariant["reference"]
        description += f" -> {reference['table']}.{reference['column']}"
    return description


def _invariant_sql(invariant: dict) -> str:
    table = ".".join(f'"{part}"' for part in invariant["table"].split("."))
    column = f'"{invariant["column"]}"'
    if invariant["type"] == "not_null":
        return f"SELECT count(*) FROM {table} WHERE {column} IS NULL"
    if invariant["type"] == "unique":
        return (
            f"SELECT count(*) FROM (SELECT {column} FROM {table} "
            f"WHERE {column} IS NOT NULL GROUP BY {column} HAVING count(*) > 1) AS violations"
        )
    reference = invariant["reference"]
    parent = ".".join(f'"{part}"' for part in reference["table"].split("."))
    parent_column = f'"{reference["column"]}"'
    return (
        f"SELECT count(*) FROM {table} AS child WHERE child.{column} IS NOT NULL "
        f"AND NOT EXISTS (SELECT 1 FROM {parent} AS parent "
        f"WHERE parent.{parent_column} = child.{column})"
    )


def execute_backup_restore(
    backup: Path, output: Path, *, tables=None, timeout=None, plan: Path | None = None
) -> dict:
    if sys.platform != "linux":
        raise ValueError("backup rehearsal currently requires Linux and a local Docker daemon")
    restore_plan = None
    if plan is not None:
        if tables is not None or timeout is not None:
            raise ValueError("cannot override table expectations or timeout from a restore plan")
        restore_plan = load_restore_plan(plan)
        tables = restore_plan["tables"]
        timeout = restore_plan["timeoutSeconds"]
    elif timeout is None:
        timeout = 300
    tables = _restore_settings(tables, timeout)
    invariants = restore_plan.get("invariants", []) if restore_plan else []
    checks = []
    phases = []
    name = f"nostekon-backup-{uuid4().hex[:12]}"
    level = "V0"
    started_at = utc_timestamp()
    deadline = time.monotonic() + timeout
    attempted = False
    interrupted = False

    def command(*arguments):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("backup rehearsal deadline exceeded")
        return docker_command(list(arguments), timeout=remaining)

    def phase(title, action):
        start = utc_timestamp()
        try:
            return action()
        finally:
            phases.append({"name": title, "startedAt": start, "endedAt": utc_timestamp()})

    with tempfile.TemporaryDirectory(prefix="nostekon-restore-") as directory:
        snapshot = snapshot_backup(backup, Path(directory))
        if "," in str(snapshot):
            raise ValueError("backup workspace path cannot contain Docker mount separators")
        with snapshot.open("rb") as original:
            digest = hashlib.file_digest(original, "sha256").hexdigest()
        if restore_plan is not None and restore_plan["backup"] != {
            "sha256": digest,
            "bytes": snapshot.stat().st_size,
        }:
            raise ValueError("backup does not match the restore plan checksum and size")
        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        try:
            checks.append(
                {
                    "level": "V0",
                    "name": "Frozen custom archive",
                    "passed": True,
                    "detail": f"SHA-256 {digest}; {snapshot.stat().st_size} bytes",
                }
            )
            image_reference = restore_plan["imageId"] if restore_plan else "postgres:16.8"
            image = (
                command("image", "inspect", "--format={{.Id}}", image_reference).decode().strip()
            )
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
                raise ValueError("local PostgreSQL image must have a valid immutable image ID")
            if restore_plan is not None and image != restore_plan["imageId"]:
                raise ValueError("local PostgreSQL image does not match the restore plan")
            checks.append(
                {
                    "level": "V0",
                    "name": "Pinned local PostgreSQL image",
                    "passed": True,
                    "detail": image,
                }
            )
            if restore_plan is not None:
                identity = hashlib.sha256(
                    json.dumps(restore_plan, sort_keys=True, separators=(",", ":")).encode("utf-8")
                ).hexdigest()
                checks.append(
                    {
                        "level": "V0",
                        "name": "Restore plan binding",
                        "passed": True,
                        "detail": f"Canonical plan SHA-256 {identity}; backup and image matched; "
                        "not operator approval or authenticated provenance",
                    }
                )
            attempted = True
            phase(
                "Create isolated target",
                lambda: command(
                    "create",
                    "--name",
                    name,
                    "--label=io.nostekon.purpose=backup-rehearsal",
                    "--pull=never",
                    "--network=none",
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges",
                    "--user=999:999",
                    "--log-driver=none",
                    "--memory=512m",
                    "--cpus=1",
                    "--pids-limit=128",
                    "--tmpfs",
                    "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m,uid=999,gid=999,mode=0700",
                    "--tmpfs",
                    "/var/run/postgresql:rw,noexec,nosuid,size=16m,uid=999,gid=999",
                    "--tmpfs",
                    "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
                    "--mount",
                    f"type=bind,src={snapshot},dst=/backup.dump,readonly",
                    "--env=POSTGRES_HOST_AUTH_METHOD=trust",
                    "--env=POSTGRES_DB=nostekon",
                    image,
                    "postgres",
                    "-c",
                    "listen_addresses=127.0.0.1",
                ),
            )
            level = "V1"
            command("start", name)

            def wait_ready():
                while True:
                    try:
                        command(
                            "exec",
                            name,
                            "pg_isready",
                            "-h",
                            "127.0.0.1",
                            "-U",
                            "postgres",
                            "-d",
                            "nostekon",
                        )
                        return
                    except RuntimeError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("PostgreSQL readiness deadline exceeded") from None
                        time.sleep(min(0.2, max(0, deadline - time.monotonic())))

            phase("Start PostgreSQL", wait_ready)
            phase(
                "Restore custom archive",
                lambda: command(
                    "exec",
                    name,
                    "pg_restore",
                    "--exit-on-error",
                    "--single-transaction",
                    "--no-owner",
                    "--no-privileges",
                    "--no-tablespaces",
                    "--no-security-labels",
                    "--username=postgres",
                    "--dbname=nostekon",
                    "/backup.dump",
                ),
            )
            checks.append(
                {
                    "level": "V1",
                    "name": "Archive restore completed",
                    "passed": True,
                    "detail": "pg_restore --exit-on-error --single-transaction",
                }
            )
            level = "V2"

            def query(sql):
                return (
                    command(
                        "exec",
                        "--env=PGOPTIONS=-c default_transaction_read_only=on "
                        "-c statement_timeout=5000 -c lock_timeout=1000",
                        name,
                        "psql",
                        "--no-psqlrc",
                        "--username=postgres",
                        "--dbname=nostekon",
                        "--tuples-only",
                        "--no-align",
                        "--set=ON_ERROR_STOP=1",
                        "--command",
                        sql,
                    )
                    .decode()
                    .strip()
                )

            if phase("Database query", lambda: query("SELECT 1")) != "1":
                raise ValueError("restored database did not return the expected health result")
            checks.append(
                {
                    "level": "V2",
                    "name": "Restored database query",
                    "passed": True,
                    "detail": "SELECT 1 returned 1; not an application-health proof",
                }
            )
            level = "V3"
            for table, expected in tables.items():
                schema, relation = table.split(".")
                sql = f'SELECT count(*) FROM "{schema}"."{relation}"'
                raw = phase(f"Count {table}", lambda sql=sql: query(sql))
                if not re.fullmatch(r"[0-9]{1,19}", raw):
                    raise ValueError("table count response was not a bounded nonnegative integer")
                measured = int(raw)
                checks.append(
                    {
                        "level": "V3",
                        "name": f"Row count: {table}",
                        "passed": measured == expected,
                        "detail": f"expected {expected}; measured {measured}",
                    }
                )
            level = "V4"
            for invariant in invariants:
                passed = False
                description = _invariant_description(invariant)
                detail = f"{description}; query failed; no raw database output retained"
                try:
                    raw = phase(
                        f"Validate {invariant['name']}",
                        lambda invariant=invariant: query(_invariant_sql(invariant)),
                    )
                    if not re.fullmatch(r"[0-9]{1,19}", raw) or int(raw) > 2**63 - 1:
                        raise ValueError("invariant response was not a bounded nonnegative integer")
                    measured = int(raw)
                    passed = measured == 0
                    detail = f"{description}; measured violations: {measured}; expected 0"
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                    pass
                checks.append(
                    {"level": "V4", "name": invariant["name"], "passed": passed, "detail": detail}
                )
        except (
            OSError,
            ValueError,
            RuntimeError,
            subprocess.SubprocessError,
            TimeoutError,
            KeyboardInterrupt,
        ) as error:
            interrupted = isinstance(error, KeyboardInterrupt)
            checks.append(
                {
                    "level": level,
                    "name": "Backup rehearsal interrupted"
                    if interrupted
                    else "Backup rehearsal error",
                    "passed": False,
                    "detail": str(error)[:500]
                    if not isinstance(error, subprocess.SubprocessError)
                    else "Docker command failed or timed out; no raw database output retained",
                }
            )
        finally:
            if attempted:
                try:
                    phase(
                        "Remove isolated target",
                        lambda: docker_command(["rm", "--force", name], timeout=30),
                    )
                    checks.append(
                        {
                            "level": "V2",
                            "name": "Isolated target removed",
                            "passed": True,
                            "detail": name,
                        }
                    )
                except (
                    OSError,
                    RuntimeError,
                    subprocess.SubprocessError,
                    KeyboardInterrupt,
                ) as error:
                    interrupted = interrupted or isinstance(error, KeyboardInterrupt)
                    checks.append(
                        {
                            "level": "V2",
                            "name": "Isolated target cleanup",
                            "passed": False,
                            "detail": f"Cleanup failed for {name}; manual removal required",
                        }
                    )
            evaluated = {check["name"] for check in checks if check["level"] == "V4"}
            for invariant in invariants:
                if invariant["name"] not in evaluated:
                    checks.append(
                        {
                            "level": "V4",
                            "name": invariant["name"],
                            "passed": False,
                            "detail": f"{_invariant_description(invariant)}; not evaluated because "
                            "the rehearsal did not reach validation",
                        }
                    )
            result = {
                "apiVersion": "nostekon/v1alpha1",
                "kind": "DrillRun",
                "metadata": {"name": name},
                "spec": {
                    "scenario": "postgresql-backup-rehearsal",
                    "upTo": "V4" if invariants else "V3" if tables else "V2",
                },
                "status": {
                    "failureAt": started_at,
                    "completedAt": utc_timestamp(),
                    "phases": phases,
                    "checks": checks,
                },
            }
            if invariants:
                result["spec"]["v4Evidence"] = {"invariants": [rule["name"] for rule in invariants]}
            with tempfile.NamedTemporaryFile(
                mode="w", dir=output.parent, prefix=".nostekon-run-", delete=False
            ) as handle:
                temporary = Path(handle.name)
                try:
                    json.dump(result, handle, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                    os.replace(temporary, output)
                    parent = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(parent)
                    finally:
                        os.close(parent)
                finally:
                    temporary.unlink(missing_ok=True)
        if interrupted:
            raise KeyboardInterrupt("backup rehearsal interrupted; evidence retained")
        return result


def snapshot_backup(source: Path, workspace: Path) -> Path:
    snapshot = workspace / "backup.dump"
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    created = False
    try:
        with os.fdopen(descriptor, "rb") as original:
            metadata = os.fstat(original.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError("backup must be a regular file, not a symlink or pipe")
            if not 5 <= metadata.st_size <= MAX_BACKUP_BYTES:
                raise ValueError("backup must be nonempty and at most 64 MiB")
            if original.read(5) != b"PGDMP":
                raise ValueError(
                    "only PostgreSQL custom-format archives (pg_dump -Fc) are supported"
                )
            original.seek(0)
            with snapshot.open("xb") as destination:
                created = True
                os.fchmod(destination.fileno(), 0o600)
                size = 0
                while chunk := original.read(65536):
                    size += len(chunk)
                    if size > MAX_BACKUP_BYTES:
                        raise ValueError("backup grew beyond the 64 MiB limit")
                    destination.write(chunk)
                destination.flush()
                os.fsync(destination.fileno())
            after = os.fstat(original.fileno())
            if size != metadata.st_size or (metadata.st_mtime_ns, metadata.st_ctime_ns) != (
                after.st_mtime_ns,
                after.st_ctime_ns,
            ):
                raise ValueError(
                    "backup changed size while being copied; retry from a completed backup"
                )
            snapshot.chmod(0o444)
        return snapshot
    except BaseException:
        if created:
            snapshot.unlink(missing_ok=True)
        raise
