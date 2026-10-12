import hashlib
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

import pytest

from nostekon import backup_restore as restore


def test_snapshot_preserves_exact_bytes_without_mutating_original(tmp_path):
    source = tmp_path / "original.dump"
    original = b"PGDMP\x01\x0f\x00\x04\x08original backup bytes"
    source.write_bytes(original)
    workspace = tmp_path / "private"
    workspace.mkdir(mode=0o700)
    snapshot = restore.snapshot_backup(source, workspace)
    assert snapshot.read_bytes() == original
    assert source.read_bytes() == original
    assert stat.S_IMODE(snapshot.stat().st_mode) == 0o444
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == hashlib.sha256(original).hexdigest()


@pytest.mark.parametrize("payload", [b"", b"SELECT 1;", b"PGDM", b"PGDMP" + b"x" * 64])
def test_bad_or_oversized_backup_leaves_no_snapshot(tmp_path, monkeypatch, payload):
    source = tmp_path / "input.dump"
    source.write_bytes(payload)
    workspace = tmp_path / "private"
    workspace.mkdir(mode=0o700)
    monkeypatch.setattr(restore, "MAX_BACKUP_BYTES", 32)
    with pytest.raises(ValueError):
        restore.snapshot_backup(source, workspace)
    assert list(workspace.iterdir()) == []


def fake_docker(commands, *, fail_restore=False, fail_cleanup=False, count=b"3\n"):
    def execute(arguments, *, timeout):
        commands.append(arguments)
        if arguments[:2] == ["image", "inspect"]:
            return b"sha256:" + b"a" * 64
        if arguments[:2] == ["rm", "--force"] and fail_cleanup:
            raise subprocess.CalledProcessError(1, "docker")
        if "pg_restore" in arguments and "--exit-on-error" in arguments and fail_restore:
            raise subprocess.CalledProcessError(1, "docker")
        if "psql" in arguments:
            return count if "count(*)" in arguments[-1] else b"1\n"
        return b""

    return execute


def test_restore_is_isolated_and_reports_only_measured_checks(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    source = tmp_path / "input.dump"
    source.write_bytes(b"PGDMP" + b"fixture" * 3)
    output = tmp_path / "run.json"
    result = restore.execute_backup_restore(source, output, tables={"public.orders": 3})
    create = next(command for command in commands if command[0] == "create")
    for restriction in (
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=999:999",
        "--log-driver=none",
        "--memory=512m",
        "--pids-limit=128",
    ):
        assert restriction in create
    mounts = [argument for argument in create if argument.startswith("type=bind,")]
    assert len(mounts) == 1 and mounts[0].endswith("dst=/backup.dump,readonly")
    assert result["spec"] == {"scenario": "postgresql-backup-rehearsal", "upTo": "V3"}
    assert "ledger" not in result["status"]
    assert all(check["passed"] for check in result["status"]["checks"])
    assert commands[-1][:2] == ["rm", "--force"]
    assert output.stat().st_mode & 0o777 == 0o600
    assert source.read_bytes() == b"PGDMP" + b"fixture" * 3


@pytest.mark.parametrize("failure", ["restore", "mismatch", "bad_count", "cleanup"])
def test_restore_failure_never_becomes_a_passing_run(tmp_path, monkeypatch, failure):
    commands = []
    monkeypatch.setattr(
        restore,
        "docker_command",
        fake_docker(
            commands,
            fail_restore=failure == "restore",
            fail_cleanup=failure == "cleanup",
            count=b"invalid" if failure == "bad_count" else b"2\n",
        ),
    )
    source = tmp_path / "input.dump"
    source.write_bytes(b"PGDMP" + b"fixture" * 3)
    result = restore.execute_backup_restore(
        source, tmp_path / "run.json", tables={"public.orders": 3}
    )
    assert any(not check["passed"] for check in result["status"]["checks"])
    assert commands[-1][:2] == ["rm", "--force"]
    assert "ledger" not in result["status"]


@pytest.mark.parametrize(
    "tables",
    [
        {"public.orders;DROP DATABASE postgres": 3},
        {"orders": 3},
        {"pg_catalog.pg_class": 3},
        {"public.orders": -1},
        {"public.orders": True},
    ],
)
def test_bad_expectations_fail_before_commands_or_output(tmp_path, monkeypatch, tables):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    source = tmp_path / "input.dump"
    source.write_bytes(b"PGDMPfixture")
    output = tmp_path / "run.json"
    with pytest.raises(ValueError):
        restore.execute_backup_restore(source, output, tables=tables)
    assert not commands and not output.exists()


def test_existing_output_is_never_overwritten(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    source = tmp_path / "input.dump"
    source.write_bytes(b"PGDMPfixture")
    output = tmp_path / "run.json"
    output.write_bytes(b"keep this")
    with pytest.raises(FileExistsError):
        restore.execute_backup_restore(source, output)
    assert output.read_bytes() == b"keep this" and not commands


def test_docker_transport_is_fixed_local_and_ignores_remote_environment(monkeypatch):
    original = subprocess.Popen
    captured = []

    def popen(arguments, **kwargs):
        captured.append((arguments, kwargs))
        return original([sys.executable, "-c", "print('safe')"], **kwargs)

    monkeypatch.setenv("DOCKER_HOST", "tcp://production:2375")
    monkeypatch.setenv("DOCKER_CONTEXT", "production")
    monkeypatch.setattr(restore.subprocess, "Popen", popen)
    assert restore.docker_command(["version"], timeout=1) == b"safe\n"
    assert captured[0][0][:3] == ["docker", "--host", "unix:///var/run/docker.sock"]
    assert "DOCKER_HOST" not in captured[0][1]["env"]
    assert "DOCKER_CONTEXT" not in captured[0][1]["env"]


@pytest.mark.parametrize(
    "script",
    [
        "import sys; sys.stdout.write('x'*8192)",
        "import sys; sys.stderr.write('x'*131072)",
        "raise SystemExit(3)",
    ],
)
def test_subprocess_limits_and_errors_omit_database_output(monkeypatch, script):
    original = subprocess.Popen
    monkeypatch.setattr(
        restore.subprocess,
        "Popen",
        lambda arguments, **kwargs: original([sys.executable, "-c", script], **kwargs),
    )
    with pytest.raises(RuntimeError) as error:
        restore.docker_command(["exec"], timeout=1)
    assert "xxx" not in str(error.value)


def test_hung_docker_command_is_killed_at_deadline(monkeypatch):
    original = subprocess.Popen
    children = []

    def popen(arguments, **kwargs):
        child = original([sys.executable, "-c", "while True: pass"], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(restore.subprocess, "Popen", popen)
    with pytest.raises(TimeoutError):
        restore.docker_command(["exec"], timeout=0.1)
    assert children[0].poll() is not None


def test_interrupt_retains_failure_evidence_and_cleans_target(tmp_path, monkeypatch):
    commands = []
    execute = fake_docker(commands)

    def interrupted(arguments, *, timeout):
        if "pg_restore" in arguments:
            raise KeyboardInterrupt
        return execute(arguments, timeout=timeout)

    monkeypatch.setattr(restore, "docker_command", interrupted)
    source = tmp_path / "input.dump"
    source.write_bytes(b"PGDMPfixture")
    output = tmp_path / "run.json"
    with pytest.raises(KeyboardInterrupt):
        restore.execute_backup_restore(source, output)
    result = json.loads(output.read_text())
    assert any(not check["passed"] for check in result["status"]["checks"])
    assert commands[-1][:2] == ["rm", "--force"]


def test_symlink_and_fifo_are_rejected_without_reading(tmp_path):
    source = tmp_path / "original.dump"
    source.write_bytes(b"PGDMP" + b"x" * 20)
    link = tmp_path / "linked.dump"
    link.symlink_to(source)
    fifo = tmp_path / "pipe.dump"
    os.mkfifo(fifo)
    workspace = tmp_path / "private"
    workspace.mkdir(mode=0o700)
    for path in (link, fifo):
        with pytest.raises((OSError, ValueError)):
            restore.snapshot_backup(path, workspace)
    assert list(workspace.iterdir()) == []


@pytest.mark.skipif(
    os.environ.get("NOSTEKON_BACKUP_INTEGRATION") != "1",
    reason="explicit local Docker backup integration opt-in",
)
def test_real_custom_backup_restore_and_independent_go_report(tmp_path):
    name = f"nostekon-backup-fixture-{uuid4().hex[:10]}"
    try:
        restore.docker_command(
            [
                "run",
                "--detach",
                "--name",
                name,
                "--pull=never",
                "--network=none",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                "--user=999:999",
                "--log-driver=none",
                "--memory=512m",
                "--pids-limit=128",
                "--tmpfs",
                "/var/lib/postgresql/data:rw,noexec,nosuid,size=128m,uid=999,gid=999",
                "--tmpfs",
                "/var/run/postgresql:rw,noexec,nosuid,size=16m,uid=999,gid=999",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
                "--env=POSTGRES_HOST_AUTH_METHOD=trust",
                "--env=POSTGRES_DB=nostekon",
                "postgres:16.8",
                "postgres",
                "-c",
                "listen_addresses=127.0.0.1",
            ],
            timeout=30,
        )
        deadline = time.monotonic() + 30
        while True:
            try:
                restore.docker_command(
                    ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], timeout=5
                )
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        restore.docker_command(
            [
                "exec",
                name,
                "psql",
                "-U",
                "postgres",
                "-d",
                "nostekon",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                "CREATE TABLE public.orders(id integer PRIMARY KEY); "
                "INSERT INTO public.orders VALUES (1),(2),(3);",
            ],
            timeout=10,
        )
        backup = tmp_path / "real.dump"
        with backup.open("xb") as archive:
            os.fchmod(archive.fileno(), 0o600)
            subprocess.run(
                [
                    "docker",
                    "--host",
                    "unix:///var/run/docker.sock",
                    "exec",
                    name,
                    "pg_dump",
                    "-U",
                    "postgres",
                    "-d",
                    "nostekon",
                    "-Fc",
                ],
                stdout=archive,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=15,
                env={
                    key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")
                },
            )
        from nostekon.cli import main

        passing = tmp_path / "passed.json"
        failing = tmp_path / "failed.json"
        assert (
            main(
                [
                    "backup",
                    "restore",
                    "--file",
                    str(backup),
                    "--output",
                    str(passing),
                    "--expect-table",
                    "public.orders=3",
                ]
            )
            == 0
        )
        assert (
            main(
                [
                    "backup",
                    "restore",
                    "--file",
                    str(backup),
                    "--output",
                    str(failing),
                    "--expect-table",
                    "public.orders=4",
                ]
            )
            == 1
        )
        report_binary = tmp_path / "report"
        repository = Path(__file__).parent.parent
        subprocess.run(
            ["go", "build", "-o", str(report_binary), "./cmd/nostekon-report"],
            cwd=repository,
            check=True,
            timeout=60,
        )
        for source, exit_code, verdict in [(passing, 0, "verified"), (failing, 1, "failed")]:
            evaluation = subprocess.run(
                [str(report_binary), str(source)], capture_output=True, timeout=15
            )
            assert evaluation.returncode == exit_code, evaluation.stderr.decode()
            report = json.loads(evaluation.stdout)
            assert report["verdict"] == verdict
            assert report["requestedLevel"] == "V3"
            assert report["rpo"] is None
            assert report["provenance"]["status"] == "unverified"
            container = json.loads(source.read_text())["metadata"]["name"]
            assert (
                restore.docker_command(["ps", "-aq", f"--filter=name=^/{container}$"], timeout=5)
                == b""
            )
    finally:
        restore.docker_command(["rm", "--force", name], timeout=15)
