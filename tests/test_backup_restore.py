import hashlib
import json
import os
import selectors
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

import pytest

from nostekon import backup_recovery as recovery
from nostekon import backup_restore as restore
from nostekon.backup_recovery import RecoveryJournal


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


def test_backup_preflight_checks_bound_bytes_and_queries_only_local_metadata(tmp_path, monkeypatch):
    source = tmp_path / "approved.dump"
    original = b"PGDMPsynthetic admission fixture, not a real archive"
    source.write_bytes(original)
    plan = tmp_path / "reviewed-plan.json"
    commands = []

    def metadata(arguments, *, timeout):
        commands.append(arguments)
        assert 0 < timeout <= 30
        if arguments[0] == "info":
            return json.dumps(
                {"os": "linux", "architecture": "x86_64", "memoryBytes": 2**30, "cpus": 2}
            ).encode()
        if arguments[:2] == ["image", "inspect"] and "--format={{.Id}}" in arguments:
            return b"sha256:" + b"a" * 64
        assert arguments[:2] == ["image", "inspect"]
        assert arguments[-1] == "sha256:" + "a" * 64
        return json.dumps(
            {"id": "sha256:" + "a" * 64, "os": "linux", "architecture": "amd64"}
        ).encode()

    monkeypatch.setattr(restore, "docker_command", metadata)
    restore.create_restore_plan(source, plan, tables={"public.orders": 3}, timeout=30)
    original_plan = plan.read_bytes()
    commands.clear()
    result = restore.preflight_backup(source, plan=plan)
    assert result["apiVersion"] == "nostekon/backup-preflight/v1alpha1"
    assert result["kind"] == "PostgreSQLBackupPreflight"
    assert result["passed"] is True
    assert result["backupMatches"] is True
    assert all(check["passed"] for check in result["checks"])
    assert len(commands) == 2
    assert commands[0][0] == "info"
    assert commands[1][:2] == ["image", "inspect"]
    assert len(result["limitations"]) >= 3
    assert source.read_bytes() == original
    assert plan.read_bytes() == original_plan
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "approved.dump",
        "reviewed-plan.json",
    ]


@pytest.fixture
def preflight_inputs(tmp_path):
    source = tmp_path / "approved.dump"
    source.write_bytes(b"PGDMPsynthetic preflight input, not a valid restore archive")
    plan = tmp_path / "plan.json"
    plan.write_text(
        json.dumps(
            {
                "apiVersion": "nostekon/restore-plan/v1alpha1",
                "kind": "PostgreSQLRestorePlan",
                "backup": {
                    "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "bytes": source.stat().st_size,
                },
                "imageId": "sha256:" + "a" * 64,
                "tables": {"public.orders": 3},
                "timeoutSeconds": 300,
            }
        )
    )
    return source, plan


@pytest.mark.parametrize(
    "scenario",
    [
        "daemon-error",
        "daemon-json",
        "daemon-shape",
        "daemon-extra",
        "daemon-os",
        "daemon-arch",
        "memory-bool",
        "memory-float",
        "memory-low",
        "cpu-bool",
        "cpu-float",
        "cpu-zero",
        "image-error",
        "image-id",
        "image-os",
        "image-arch",
        "image-extra",
        "image-json",
        "image-shape",
        "no-counts",
    ],
)
def test_backup_preflight_rejects_host_or_image_blockers(preflight_inputs, monkeypatch, scenario):
    source, plan = preflight_inputs
    commands = []
    if scenario == "no-counts":
        reviewed = json.loads(plan.read_text())
        reviewed["tables"] = {}
        plan.write_text(json.dumps(reviewed))

    def metadata(arguments, *, timeout):
        commands.append(arguments)
        assert arguments[0] == "info" or arguments[:2] == ["image", "inspect"]
        if arguments[0] == "info":
            if scenario == "daemon-error":
                raise RuntimeError("private-sentinel-daemon-output")
            if scenario == "daemon-json":
                return b"private-sentinel-invalid-json"
            if scenario == "daemon-shape":
                return b"[]"
            payload = {"os": "linux", "architecture": "x86_64", "memoryBytes": 2**30, "cpus": 2}
            changes = {
                "daemon-extra": {"extra": "private-sentinel"},
                "daemon-os": {"os": "windows"},
                "daemon-arch": {"architecture": "unsupported"},
                "memory-bool": {"memoryBytes": True},
                "memory-float": {"memoryBytes": float(2**30)},
                "memory-low": {"memoryBytes": 1},
                "cpu-bool": {"cpus": True},
                "cpu-float": {"cpus": 2.0},
                "cpu-zero": {"cpus": 0},
            }
        else:
            if scenario == "image-error":
                raise subprocess.TimeoutExpired("private-sentinel", timeout)
            if scenario == "image-json":
                return b"private-sentinel-invalid-json"
            if scenario == "image-shape":
                return b"[]"
            payload = {"id": "sha256:" + "a" * 64, "os": "linux", "architecture": "amd64"}
            changes = {
                "image-id": {"id": "sha256:" + "b" * 64},
                "image-os": {"os": "windows"},
                "image-arch": {"architecture": "arm64"},
                "image-extra": {"extra": "private-sentinel"},
            }
        payload.update(changes.get(scenario, {}))
        return json.dumps(payload).encode()

    monkeypatch.setattr(restore, "docker_command", metadata)
    result = restore.preflight_backup(source, plan=plan)
    assert result["passed"] is False
    assert result["backupMatches"] is True
    assert any(not check["passed"] for check in result["checks"])
    assert "private-sentinel" not in json.dumps(result)
    assert len(commands) <= 2


@pytest.mark.parametrize("scenario", ["non-linux", "invalid-plan", "invalid-header"])
def test_backup_preflight_admission_never_queries_docker(preflight_inputs, monkeypatch, scenario):
    source, plan = preflight_inputs
    monkeypatch.setattr(
        restore, "docker_command", lambda *args, **kwargs: pytest.fail("Docker queried")
    )
    if scenario == "non-linux":
        monkeypatch.setattr(restore.sys, "platform", "darwin")
    elif scenario == "invalid-plan":
        plan.write_text("{}")
    else:
        source.write_bytes(b"not a PostgreSQL custom archive")
    with pytest.raises((ValueError, RuntimeError)):
        restore.preflight_backup(source, plan=plan)


def test_backup_preflight_changed_bytes_never_query_docker(preflight_inputs, monkeypatch):
    source, plan = preflight_inputs
    source.write_bytes(source.read_bytes() + b"changed")
    monkeypatch.setattr(
        restore, "docker_command", lambda *args, **kwargs: pytest.fail("Docker queried")
    )
    result = restore.preflight_backup(source, plan=plan)
    assert result["passed"] is False
    assert result["backupMatches"] is False
    assert {check["name"] for check in result["checks"]} == {
        "backup-plan-binding",
        "snapshot-count-coverage",
    }


def test_backup_preflight_metadata_deadline_and_missing_counts(preflight_inputs, monkeypatch):
    source, plan = preflight_inputs
    reviewed = json.loads(plan.read_text())
    reviewed["tables"] = {}
    plan.write_text(json.dumps(reviewed))
    clock = iter([100, 100, 131])
    monkeypatch.setattr(restore.time, "monotonic", lambda: next(clock))
    commands = []

    def metadata(arguments, *, timeout):
        commands.append(arguments)
        assert arguments[0] == "info"
        return b'{"os":"linux","architecture":"x86_64","memoryBytes":1073741824,"cpus":2}'

    monkeypatch.setattr(restore, "docker_command", metadata)
    result = restore.preflight_backup(source, plan=plan)
    assert result["passed"] is False
    assert result["requestedLevel"] == "V2"
    assert len(commands) == 1
    assert not next(
        check["passed"] for check in result["checks"] if check["name"] == "native-pinned-image"
    )
    assert not next(
        check["passed"] for check in result["checks"] if check["name"] == "snapshot-count-coverage"
    )


def test_backup_preflight_cli_routes_json_and_distinct_exits(preflight_inputs, monkeypatch, capsys):
    from nostekon.cli import main

    source, plan = preflight_inputs
    result = {
        "apiVersion": "nostekon/backup-preflight/v1alpha1",
        "kind": "PostgreSQLBackupPreflight",
        "passed": True,
    }
    monkeypatch.setattr(restore, "preflight_backup", lambda backup, *, plan: result)
    arguments = ["backup", "preflight", "--file", str(source), "--plan", str(plan)]
    assert main(arguments) == 0
    assert json.loads(capsys.readouterr().out) == result
    result["passed"] = False
    assert main(arguments) == 1
    assert json.loads(capsys.readouterr().out) == result

    def invalid(*args, **kwargs):
        raise ValueError("strict admission rejected")

    monkeypatch.setattr(restore, "preflight_backup", invalid)
    assert main(arguments) == 2
    captured = capsys.readouterr()
    assert not captured.out
    assert "strict admission rejected" in captured.err

    import signal

    previous = signal.getsignal(signal.SIGTERM)

    def interrupted(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(restore, "preflight_backup", interrupted)
    assert main(arguments) == 130
    assert signal.getsignal(signal.SIGTERM) == previous
    captured = capsys.readouterr()
    assert not captured.out
    assert "no restore was started" in captured.err
    for forbidden in ["--output", "--expect-table", "--timeout", "--confirm-cleanup"]:
        with pytest.raises(SystemExit) as error:
            main([*arguments, forbidden, "unsupported"])
        assert error.value.code == 2
        capsys.readouterr()


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


def fake_docker(
    commands, *, fail_restore=False, fail_cleanup=False, count=b"3\n", invariant_count=None
):
    target = None

    def execute(arguments, *, timeout):
        nonlocal target
        commands.append(arguments)
        if arguments[:2] == ["image", "inspect"]:
            return b"sha256:" + b"a" * 64
        if arguments[:2] == ["rm", "--force"] and fail_cleanup:
            raise subprocess.CalledProcessError(1, "docker")
        if arguments[0] == "create":
            labels = {
                argument.split("=", 2)[1]: argument.split("=", 2)[2]
                for argument in arguments
                if argument.startswith("--label=")
            }
            target = {
                "id": "c" * 64,
                "name": "/" + arguments[arguments.index("--name") + 1],
                "image": next(argument for argument in arguments if argument.startswith("sha256:")),
                "purpose": labels["io.nostekon.purpose"],
                "runId": labels["io.nostekon.run-id"],
                "journal": labels["io.nostekon.journal"],
            }
            return b"c" * 64
        if arguments[0] == "ps":
            return target["id"].encode() if target is not None else b""
        if arguments[0] == "inspect":
            return json.dumps(target).encode()
        if arguments[:2] == ["rm", "--force"]:
            target = None
        if "pg_restore" in arguments and "--exit-on-error" in arguments and fail_restore:
            raise subprocess.CalledProcessError(1, "docker")
        if "psql" in arguments:
            if invariant_count is not None and " WHERE " in arguments[-1]:
                return invariant_count
            return count if "count(*)" in arguments[-1] else b"1\n"
        return b""

    return execute


def test_recovery_checkpoint_is_private_durable_and_exclusively_locked(tmp_path):
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(
        directory, run_id="a" * 32, image_id="sha256:" + "b" * 64
    ) as journal:
        recorded = json.loads((directory / "recovery.json").read_text())
        assert recorded == journal.record
        assert recorded["status"] == "prepared"
        assert recorded["containerId"] is None
        assert recorded["name"] == "nostekon-backup-" + "a" * 12
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
        assert stat.S_IMODE((directory / "recovery.json").stat().st_mode) == 0o600
        with pytest.raises(ValueError, match="active"), RecoveryJournal.open(directory):
            pass
    with RecoveryJournal.open(directory) as journal:
        assert journal.record == recorded


@pytest.mark.parametrize(
    "change",
    [
        {"apiVersion": "unknown"},
        {"kind": "Approval"},
        {"status": "resume"},
        {"runId": "x" * 32},
        {"name": "other-container"},
        {"imageId": "postgres:latest"},
        {"containerId": "short"},
        {"containerId": []},
        {"status": "running"},
        {"pid": 123},
    ],
)
def test_recovery_rejects_invalid_or_unknown_metadata(tmp_path, change):
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(
        directory, run_id="a" * 32, image_id="sha256:" + "b" * 64
    ) as journal:
        record = {**journal.record, **change}
    (directory / "recovery.json").write_text(json.dumps(record))
    with pytest.raises(ValueError), RecoveryJournal.open(directory):
        pass


@pytest.mark.parametrize(
    "unsafe",
    [
        "directory-mode",
        "file-mode",
        "metadata-symlink",
        "metadata-hardlink",
        "metadata-fifo",
        "lock-symlink",
        "lock-hardlink",
        "lock-fifo",
        "directory-symlink",
    ],
)
def test_recovery_rejects_unsafe_checkpoint_paths(tmp_path, unsafe):
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(directory, run_id="a" * 32, image_id="sha256:" + "b" * 64):
        pass
    if unsafe == "directory-mode":
        directory.chmod(0o755)
    elif unsafe == "file-mode":
        (directory / "recovery.json").chmod(0o644)
    elif unsafe == "directory-symlink":
        moved = tmp_path / "moved"
        directory.rename(moved)
        directory.symlink_to(moved)
    else:
        target = directory / ("lock" if unsafe.startswith("lock") else "recovery.json")
        original = tmp_path / "original"
        target.rename(original)
        if unsafe.endswith("symlink"):
            target.symlink_to(original)
        elif unsafe.endswith("hardlink"):
            os.link(original, target)
        else:
            os.mkfifo(target)
    with pytest.raises((OSError, ValueError)), RecoveryJournal.open(directory):
        pass


@pytest.mark.parametrize(
    "payload", [b"{", b"\xff", b"x" * 4097, b"[" * 1100 + b"]" * 1100, b'{"runId":"a","runId":"b"}']
)
def test_recovery_metadata_is_bounded_unambiguous_json(tmp_path, payload):
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(directory, run_id="a" * 32, image_id="sha256:" + "b" * 64):
        pass
    (directory / "recovery.json").write_bytes(payload)
    with pytest.raises(ValueError), RecoveryJournal.open(directory):
        pass


def test_recovery_publication_failure_preserves_previous_checkpoint(tmp_path, monkeypatch):
    from nostekon import backup_recovery

    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(
        directory, run_id="a" * 32, image_id="sha256:" + "b" * 64
    ) as journal:
        previous = (directory / "recovery.json").read_bytes()

        def fail(*arguments, **kwargs):
            raise OSError("publication failed")

        monkeypatch.setattr(backup_recovery.os, "replace", fail)
        with pytest.raises(OSError, match="publication failed"):
            journal.update("running", container_id="c" * 64)
        assert (directory / "recovery.json").read_bytes() == previous
        assert journal.record["status"] == "prepared"
        assert list(directory.glob(".recovery-*")) == []


def test_runner_checkpoints_ownership_before_create_and_exact_id_before_start(
    tmp_path, monkeypatch
):
    commands = []
    delegate = fake_docker(commands)
    output = tmp_path / "run.json"
    directory = tmp_path / "run.json.recovery"

    def execute(arguments, *, timeout):
        if arguments[0] == "create":
            record = json.loads((directory / "recovery.json").read_text())
            assert record["status"] == "prepared"
            assert record["containerId"] is None
            assert f"--label=io.nostekon.run-id={record['runId']}" in arguments
            assert (directory / "backup.dump").read_bytes() == b"PGDMPfixture"
            assert stat.S_IMODE((directory / "backup.dump").stat().st_mode) == 0o444
            with pytest.raises(ValueError, match="active"), RecoveryJournal.open(directory):
                pass
        if arguments[0] == "start":
            record = json.loads((directory / "recovery.json").read_text())
            assert record["status"] == "running"
            assert record["containerId"] == "c" * 64
            assert arguments[1] == "c" * 64
        return delegate(arguments, timeout=timeout)

    monkeypatch.setattr(restore, "docker_command", execute)
    backup = tmp_path / "source.dump"
    backup.write_bytes(b"PGDMPfixture")
    run = restore.execute_backup_restore(backup, output)
    assert all(check["passed"] for check in run["status"]["checks"])
    record = json.loads((directory / "recovery.json").read_text())
    assert record["status"] == "cleaned"
    assert record["name"] == run["metadata"]["name"]
    assert commands[-1] == ["rm", "--force", "c" * 64]
    assert not (directory / "backup.dump").exists()
    assert backup.read_bytes() == b"PGDMPfixture"


def test_failed_cleanup_retains_private_snapshot_and_recovery_state(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands, fail_cleanup=True))
    source = tmp_path / "source.dump"
    source.write_bytes(b"PGDMPfixture")
    output = tmp_path / "run.json"
    run = restore.execute_backup_restore(source, output)
    directory = tmp_path / "run.json.recovery"
    with RecoveryJournal.open(directory) as journal:
        assert journal.record["status"] == "cleanup-required"
        assert journal.record["containerId"] == "c" * 64
    assert (directory / "backup.dump").read_bytes() == source.read_bytes()
    assert any(
        check["name"] == "Isolated target cleanup" and not check["passed"]
        for check in run["status"]["checks"]
    )


@pytest.mark.parametrize(
    "change",
    [
        {"id": "d" * 64},
        {"name": "/unrelated"},
        {"image": "sha256:" + "e" * 64},
        {"purpose": "other"},
        {"runId": "e" * 32},
        {"journal": "f" * 64},
    ],
)
def test_cleanup_refuses_changed_target_ownership(tmp_path, monkeypatch, change):
    commands = []
    delegate = fake_docker(commands)

    def execute(arguments, *, timeout):
        result = delegate(arguments, timeout=timeout)
        if arguments[0] == "inspect":
            target = json.loads(result)
            target.update(change)
            return json.dumps(target).encode()
        return result

    monkeypatch.setattr(restore, "docker_command", execute)
    source = tmp_path / "source.dump"
    source.write_bytes(b"PGDMPfixture")
    output = tmp_path / "run.json"
    run = restore.execute_backup_restore(source, output)
    assert not any(command[0] == "rm" for command in commands)
    assert any(
        check["name"] == "Isolated target cleanup" and not check["passed"]
        for check in run["status"]["checks"]
    )
    assert (tmp_path / "run.json.recovery" / "backup.dump").exists()


def test_recovery_inspection_is_read_only_and_confirmed_cleanup_is_idempotent(
    tmp_path, monkeypatch
):
    commands = []
    delegate = fake_docker(commands)

    def fail_cleanup(arguments, *, timeout):
        if arguments[0] == "rm":
            raise RuntimeError("controlled removal failure")
        return delegate(arguments, timeout=timeout)

    monkeypatch.setattr(restore, "docker_command", fail_cleanup)
    source = tmp_path / "source.dump"
    source.write_bytes(b"PGDMPfixture")
    output = tmp_path / "run.json"
    restore.execute_backup_restore(source, output)
    previous_evidence = output.read_bytes()
    directory = tmp_path / "run.json.recovery"
    previous_checkpoint = (directory / "recovery.json").read_bytes()
    monkeypatch.setattr(restore, "docker_command", delegate)
    commands.clear()
    review = recovery.recover_backup(directory)
    assert review["checkpointStatus"] == "cleanup-required"
    assert review["containerPresent"] is True
    assert review["snapshotPresent"] is True
    assert all(command[0] in ("ps", "inspect") for command in commands)
    assert (directory / "recovery.json").read_bytes() == previous_checkpoint
    assert output.read_bytes() == previous_evidence
    result = recovery.recover_backup(directory, confirm_cleanup=True)
    assert result["checkpointStatus"] == "cleaned"
    assert result["containerRemoved"] is True
    assert commands[-1] == ["rm", "--force", "c" * 64]
    assert output.read_bytes() == previous_evidence
    assert source.read_bytes() == b"PGDMPfixture"
    assert not (directory / "backup.dump").exists()
    commands.clear()
    again = recovery.recover_backup(directory, confirm_cleanup=True)
    assert again["containerRemoved"] is False
    assert not any(command[0] == "rm" for command in commands)


def test_recovery_journal_rejects_identity_changes_and_state_regression(tmp_path):
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(
        directory, run_id="a" * 32, image_id="sha256:" + "b" * 64
    ) as journal:
        journal.update("running", container_id="c" * 64)
        before = (directory / "recovery.json").read_bytes()
        with pytest.raises(ValueError, match="container identity"):
            journal.update("cleanup-required", container_id="d" * 64)
        with pytest.raises(ValueError, match="transition"):
            journal.update("prepared")
        assert (directory / "recovery.json").read_bytes() == before
        journal.update("cleanup-required")
        with pytest.raises(ValueError, match="transition"):
            journal.update("running")
        journal.update("cleaned")
        before = (directory / "recovery.json").read_bytes()
        with pytest.raises(ValueError, match="transition"):
            journal.update("cleanup-required")
        assert (directory / "recovery.json").read_bytes() == before


def test_recovery_of_active_runner_does_not_call_docker(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    directory = tmp_path / "attempt.recovery"
    with (
        RecoveryJournal.create(directory, run_id="a" * 32, image_id="sha256:" + "b" * 64),
        pytest.raises(ValueError, match="active"),
    ):
        recovery.recover_backup(directory, confirm_cleanup=True)
    assert commands == []


def test_prepared_recovery_requires_confirmation_to_remove_snapshot(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(directory, run_id="a" * 32, image_id="sha256:" + "b" * 64):
        snapshot = directory / "backup.dump"
        snapshot.write_bytes(b"PGDMPfixture")
        snapshot.chmod(0o444)
    assert recovery.recover_backup(directory)["snapshotPresent"] is True
    assert snapshot.exists()
    assert recovery.recover_backup(directory, confirm_cleanup=True)["checkpointStatus"] == "cleaned"
    assert not snapshot.exists()
    assert not any(command[0] == "rm" for command in commands)


def test_unrecorded_create_is_adopted_only_after_full_ownership_validation(tmp_path, monkeypatch):
    commands = []
    execute = fake_docker(commands)
    monkeypatch.setattr(restore, "docker_command", execute)
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(
        directory, run_id="a" * 32, image_id="sha256:" + "a" * 64
    ) as journal:
        identity = execute(
            [
                "create",
                "--name",
                journal.record["name"],
                "--label=io.nostekon.purpose=backup-rehearsal",
                "--label=io.nostekon.run-id=" + "a" * 32,
                f"--label=io.nostekon.journal={journal.binding}",
                journal.record["imageId"],
            ],
            timeout=30,
        ).decode()
    before = (directory / "recovery.json").read_bytes()
    review = recovery.recover_backup(directory)
    assert review["containerId"] is None
    assert review["observedContainerId"] == identity
    assert (directory / "recovery.json").read_bytes() == before
    result = recovery.recover_backup(directory, confirm_cleanup=True)
    assert result["containerId"] == identity
    assert result["containerRemoved"] is True
    assert commands[-1] == ["rm", "--force", identity]


def test_copied_checkpoint_cannot_remove_the_original_target(tmp_path, monkeypatch):
    commands = []
    delegate = fake_docker(commands)

    def fail_cleanup(arguments, *, timeout):
        if arguments[0] == "rm":
            raise RuntimeError("controlled removal failure")
        return delegate(arguments, timeout=timeout)

    monkeypatch.setattr(restore, "docker_command", fail_cleanup)
    source = tmp_path / "source.dump"
    source.write_bytes(b"PGDMPfixture")
    restore.execute_backup_restore(source, tmp_path / "run.json")
    original = tmp_path / "run.json.recovery"
    copied = tmp_path / "copied.recovery"
    shutil.copytree(original, copied)
    monkeypatch.setattr(restore, "docker_command", delegate)
    commands.clear()
    with pytest.raises(ValueError, match="ownership"):
        recovery.recover_backup(copied, confirm_cleanup=True)
    assert not any(command[0] == "rm" for command in commands)
    assert (original / "backup.dump").exists()
    assert (copied / "backup.dump").exists()


@pytest.mark.parametrize("unsafe", ["symlink", "fifo", "mode", "hardlink"])
def test_unsafe_recovery_snapshot_is_rejected_before_docker(tmp_path, monkeypatch, unsafe):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    directory = tmp_path / "attempt.recovery"
    with RecoveryJournal.create(directory, run_id="a" * 32, image_id="sha256:" + "b" * 64):
        pass
    source = tmp_path / "source.dump"
    source.write_bytes(b"PGDMPfixture")
    source.chmod(0o444)
    snapshot = directory / "backup.dump"
    if unsafe == "symlink":
        snapshot.symlink_to(source)
    elif unsafe == "fifo":
        os.mkfifo(snapshot)
    elif unsafe == "hardlink":
        os.link(source, snapshot)
    else:
        snapshot.write_bytes(b"PGDMPfixture")
        snapshot.chmod(0o644)
    with pytest.raises((OSError, ValueError)):
        recovery.recover_backup(directory, confirm_cleanup=True)
    assert commands == []
    assert source.read_bytes() == b"PGDMPfixture"


def test_plan_binds_exact_backup_and_cached_image_without_restoring(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    source = tmp_path / "input.dump"
    original = b"PGDMPcompleted backup"
    source.write_bytes(original)
    output = tmp_path / "restore-plan.json"
    plan = restore.create_restore_plan(source, output, tables={"public.orders": 3}, timeout=90)
    assert plan == {
        "apiVersion": "nostekon/restore-plan/v1alpha1",
        "kind": "PostgreSQLRestorePlan",
        "backup": {"sha256": hashlib.sha256(original).hexdigest(), "bytes": len(original)},
        "imageId": "sha256:" + "a" * 64,
        "tables": {"public.orders": 3},
        "timeoutSeconds": 90,
    }
    assert json.loads(output.read_text()) == plan
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert source.read_bytes() == original
    assert commands == [["image", "inspect", "--format={{.Id}}", "postgres:16.8"]]
    assert restore.load_restore_plan(output) == plan
    with pytest.raises(FileExistsError):
        restore.create_restore_plan(source, output)
    assert json.loads(output.read_text()) == plan


@pytest.mark.parametrize(
    "change",
    [
        {"apiVersion": "nostekon/restore-plan/v999"},
        {"kind": "ProductionApproval"},
        {"approved": True},
        {"imageId": "postgres:latest"},
        {"tables": {"public.orders": True}},
        {"tables": {"pg_catalog.pg_class": 1}},
        {"tables": []},
        {"timeoutSeconds": True},
        {"timeoutSeconds": 1801},
        {"backup": {"sha256": "a" * 64, "bytes": True}},
        {"backup": {"sha256": "a" * 63, "bytes": 12}},
        {"backup": {"sha256": "a" * 64, "bytes": 12, "path": "/production"}},
    ],
)
def test_plan_loader_rejects_unknown_fields_and_invalid_settings(tmp_path, monkeypatch, change):
    monkeypatch.setattr(restore, "docker_command", fake_docker([]))
    source = tmp_path / "backup.dump"
    source.write_bytes(b"PGDMPfixture")
    path = tmp_path / "plan.json"
    plan = restore.create_restore_plan(source, path)
    plan.update(change)
    path.write_text(json.dumps(plan))
    with pytest.raises(ValueError):
        restore.load_restore_plan(path)


@pytest.mark.parametrize(
    "payload",
    [
        b'{"kind":"PostgreSQLRestorePlan","kind":"PostgreSQLRestorePlan"}',
        b'{"backup":{"bytes":12,"bytes":13}}',
        b'{"timeoutSeconds":NaN}',
        b"\xff",
        b"{",
        b"x" * 16385,
        b"[" * 1100 + b"]" * 1100,
    ],
)
@pytest.mark.parametrize("loader", [restore.load_restore_plan, restore.load_validation_profile])
def test_plan_loader_rejects_ambiguous_or_unbounded_json(tmp_path, payload, loader):
    path = tmp_path / "plan.json"
    path.write_bytes(payload)
    with pytest.raises(ValueError):
        loader(path)


@pytest.mark.parametrize("loader", [restore.load_restore_plan, restore.load_validation_profile])
def test_plan_loader_rejects_symlink_and_fifo(tmp_path, loader):
    source = tmp_path / "plan.json"
    source.write_text("{}")
    link = tmp_path / "linked.json"
    link.symlink_to(source)
    fifo = tmp_path / "pipe.json"
    os.mkfifo(fifo)
    for path in (link, fifo):
        with pytest.raises((OSError, ValueError)):
            loader(path)


def test_plan_publication_failure_leaves_no_partial_plan(tmp_path, monkeypatch):
    monkeypatch.setattr(restore, "docker_command", fake_docker([]))
    source = tmp_path / "backup.dump"
    source.write_bytes(b"PGDMPfixture")
    output = tmp_path / "plan.json"

    def fail_link(source, destination):
        raise OSError("publication failed")

    monkeypatch.setattr(restore.os, "link", fail_link)
    with pytest.raises(OSError, match="publication failed"):
        restore.create_restore_plan(source, output)
    assert not output.exists()
    assert list(tmp_path.glob(".nostekon-plan-*")) == []


def validation_profile():
    return {
        "apiVersion": "nostekon/validation-profile/v1alpha1",
        "kind": "PostgreSQLValidationProfile",
        "invariants": [
            {
                "name": "orders-id-required",
                "type": "not_null",
                "table": "public.orders",
                "column": "id",
            },
            {
                "name": "orders-id-unique",
                "type": "unique",
                "table": "public.orders",
                "column": "id",
            },
            {
                "name": "orders-customer-exists",
                "type": "foreign_key",
                "table": "public.orders",
                "column": "customer_id",
                "reference": {"table": "public.customers", "column": "id"},
            },
        ],
    }


def test_validation_profile_is_frozen_inside_v2_plan_without_execution(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    backup = tmp_path / "backup.dump"
    backup.write_bytes(b"PGDMPfixture")
    profile_path = tmp_path / "profile.json"
    profile = validation_profile()
    profile_path.write_text(json.dumps(profile))
    output = tmp_path / "plan.json"
    plan = restore.create_restore_plan(
        backup, output, tables={"public.orders": 3}, validation_profile=profile_path
    )
    assert plan["apiVersion"] == "nostekon/restore-plan/v2alpha1"
    assert plan["invariants"] == profile["invariants"]
    profile_path.write_text("{}")
    assert restore.load_restore_plan(output) == plan
    assert commands == [["image", "inspect", "--format={{.Id}}", "postgres:16.8"]]


@pytest.mark.parametrize(
    "change",
    [
        {"type": "sql", "sql": "DELETE FROM public.orders"},
        {"name": True},
        {"name": "x" * 64},
        {"name": ""},
        {"table": []},
        {"table": "pg_catalog.pg_class"},
        {"table": "pg_temp.orders"},
        {"table": "public.orders; DROP TABLE orders"},
        {"column": "id) IS NULL; DELETE FROM orders"},
        {"column": True},
        {"column": "id", "sql": "SELECT 0"},
        {"type": "foreign_key", "reference": {}},
        {
            "type": "foreign_key",
            "reference": {"table": "public.customers", "column": "id", "where": "true"},
        },
        {"type": "foreign_key", "reference": {"table": "pg_catalog.pg_class", "column": "oid"}},
    ],
)
def test_invalid_profile_rules_are_rejected_before_backup_or_docker(tmp_path, monkeypatch, change):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    profile = validation_profile()
    profile["invariants"][0].update(change)
    path = tmp_path / "profile.json"
    path.write_text(json.dumps(profile))
    output = tmp_path / "plan.json"
    with pytest.raises(ValueError):
        restore.create_restore_plan(tmp_path / "missing.dump", output, validation_profile=path)
    assert commands == []
    assert not output.exists()


@pytest.mark.parametrize(
    "change",
    [
        {"apiVersion": "nostekon/validation-profile/v999"},
        {"kind": "Approval"},
        {"sql": "SELECT 0"},
        {"invariants": []},
        {"invariants": {}},
        {"invariants": validation_profile()["invariants"][:1] * 2},
        {"invariants": validation_profile()["invariants"][:1] * 21},
    ],
)
def test_profile_rejects_unsupported_shapes_and_duplicate_names(tmp_path, change):
    profile = validation_profile()
    profile.update(change)
    path = tmp_path / "profile.json"
    path.write_text(json.dumps(profile))
    with pytest.raises(ValueError):
        restore.load_validation_profile(path)


def test_v2_plan_loader_revalidates_embedded_rules(tmp_path, monkeypatch):
    monkeypatch.setattr(restore, "docker_command", fake_docker([]))
    backup = tmp_path / "backup.dump"
    backup.write_bytes(b"PGDMPfixture")
    profile = tmp_path / "profile.json"
    profile.write_text(json.dumps(validation_profile()))
    output = tmp_path / "plan.json"
    plan = restore.create_restore_plan(
        backup, output, tables={"public.orders": 3}, validation_profile=profile
    )
    plan["invariants"][0]["column"] = "id; SELECT 1"
    output.write_text(json.dumps(plan))
    with pytest.raises(ValueError):
        restore.load_restore_plan(output)


@pytest.fixture
def semantic_plan(tmp_path, monkeypatch):
    monkeypatch.setattr(restore, "docker_command", fake_docker([]))
    backup = tmp_path / "backup.dump"
    backup.write_bytes(b"PGDMPfixture")
    profile = tmp_path / "profile.json"
    profile.write_text(json.dumps(validation_profile()))
    plan = tmp_path / "plan.json"
    restore.create_restore_plan(
        backup, plan, tables={"public.orders": 3}, validation_profile=profile
    )
    return backup, plan


@pytest.mark.parametrize("count,passed", [(b"0\n", True), (b"2\n", False)])
def test_semantic_checks_use_read_only_generated_queries(
    tmp_path, monkeypatch, semantic_plan, count, passed
):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands, invariant_count=count))
    backup, plan = semantic_plan
    run = restore.execute_backup_restore(backup, tmp_path / "run.json", plan=plan)
    expected = [rule["name"] for rule in validation_profile()["invariants"]]
    assert run["spec"]["upTo"] == "V4"
    assert run["spec"]["v4Evidence"] == {"invariants": expected}
    checks = [check for check in run["status"]["checks"] if check["level"] == "V4"]
    assert [check["name"] for check in checks] == expected
    assert all(check["passed"] == passed for check in checks)
    assert all("measured violations: " in check["detail"] for check in checks)
    queries = [command for command in commands if "psql" in command and " WHERE " in command[-1]]
    assert len(queries) == 3
    for command in queries:
        assert (
            "--env=PGOPTIONS=-c default_transaction_read_only=on "
            "-c statement_timeout=5000 -c lock_timeout=1000" in command
        )
    assert queries[0][-1] == 'SELECT count(*) FROM "public"."orders" WHERE "id" IS NULL'
    assert "HAVING count(*) > 1" in queries[1][-1]
    assert "NOT EXISTS" in queries[2][-1]
    assert '"public"."customers"' in queries[2][-1]
    assert "ledger" not in run["status"]
    assert commands[-1][0:2] == ["rm", "--force"]


def test_semantic_plans_require_structural_expectations_before_effects(
    tmp_path, monkeypatch, semantic_plan
):
    backup, plan = semantic_plan
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    output = tmp_path / "incomplete-plan.json"
    with pytest.raises(ValueError, match="table-count expectation"):
        restore.create_restore_plan(backup, output, validation_profile=tmp_path / "profile.json")
    assert commands == []
    assert not output.exists()
    payload = json.loads(plan.read_text())
    payload["tables"] = {}
    plan.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="table-count expectation"):
        restore.load_restore_plan(plan)


@pytest.mark.parametrize("response", [b"NaN", b"-1", b"1\n2", b"9223372036854775808"])
def test_malformed_invariant_results_fail_without_retaining_output(
    tmp_path, monkeypatch, semantic_plan, response
):
    monkeypatch.setattr(restore, "docker_command", fake_docker([], invariant_count=response))
    backup, plan = semantic_plan
    run = restore.execute_backup_restore(backup, tmp_path / "run.json", plan=plan)
    checks = [check for check in run["status"]["checks"] if check["level"] == "V4"]
    assert len(checks) == 3
    assert all(not check["passed"] for check in checks)
    for check, rule in zip(checks, validation_profile()["invariants"], strict=True):
        assert (
            check["detail"] == f"{restore._invariant_description(rule)}; query failed; "
            "no raw database output retained"
        )


@pytest.mark.parametrize(
    "failure", [RuntimeError("private database output"), subprocess.TimeoutExpired("docker", 1)]
)
def test_invariant_query_errors_are_sanitized_and_other_rules_continue(
    tmp_path, monkeypatch, semantic_plan, failure
):
    commands = []
    delegate = fake_docker(commands, invariant_count=b"0\n")

    def execute(arguments, *, timeout):
        if "psql" in arguments and arguments[-1].endswith('"id" IS NULL'):
            commands.append(arguments)
            raise failure
        return delegate(arguments, timeout=timeout)

    monkeypatch.setattr(restore, "docker_command", execute)
    backup, plan = semantic_plan
    run = restore.execute_backup_restore(backup, tmp_path / "run.json", plan=plan)
    checks = [check for check in run["status"]["checks"] if check["level"] == "V4"]
    assert [check["passed"] for check in checks] == [False, True, True]
    assert "private database output" not in json.dumps(run)
    assert commands[-1][0:2] == ["rm", "--force"]


def test_interrupted_invariants_retain_matching_failed_declarations(
    tmp_path, monkeypatch, semantic_plan
):
    commands = []
    delegate = fake_docker(commands)

    def execute(arguments, *, timeout):
        if "psql" in arguments and " WHERE " in arguments[-1]:
            raise KeyboardInterrupt
        return delegate(arguments, timeout=timeout)

    monkeypatch.setattr(restore, "docker_command", execute)
    backup, plan = semantic_plan
    output = tmp_path / "run.json"
    with pytest.raises(KeyboardInterrupt):
        restore.execute_backup_restore(backup, output, plan=plan)
    run = json.loads(output.read_text())
    names = run["spec"]["v4Evidence"]["invariants"]
    checks = [check for check in run["status"]["checks"] if check["name"] in names]
    assert len(checks) == 3
    assert all(not check["passed"] and "not evaluated" in check["detail"] for check in checks)
    assert commands[-1][0:2] == ["rm", "--force"]


def test_failed_restore_records_all_declared_invariants_as_not_evaluated(
    tmp_path, monkeypatch, semantic_plan
):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands, fail_restore=True))
    backup, plan = semantic_plan
    run = restore.execute_backup_restore(backup, tmp_path / "run.json", plan=plan)
    checks = [check for check in run["status"]["checks"] if check["level"] == "V4"]
    assert len(checks) == 3
    assert all(not check["passed"] and "not evaluated" in check["detail"] for check in checks)
    assert not any("psql" in command for command in commands)
    assert commands[-1][0:2] == ["rm", "--force"]


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


def test_planned_restore_uses_bound_image_counts_and_records_plan_digest(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    backup = tmp_path / "backup.dump"
    backup.write_bytes(b"PGDMPfixture")
    plan_path = tmp_path / "plan.json"
    plan = restore.create_restore_plan(backup, plan_path, tables={"public.orders": 3}, timeout=90)
    commands.clear()
    run = restore.execute_backup_restore(backup, tmp_path / "run.json", plan=plan_path)
    image_id = "sha256:" + "a" * 64
    assert commands[0] == ["image", "inspect", "--format={{.Id}}", image_id]
    create = next(command for command in commands if command[0] == "create")
    assert image_id in create and "postgres:16.8" not in create
    assert any(check["name"] == "Row count: public.orders" for check in run["status"]["checks"])
    identity = hashlib.sha256(
        json.dumps(plan, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    binding = next(
        check for check in run["status"]["checks"] if check["name"] == "Restore plan binding"
    )
    assert binding["passed"] and identity in binding["detail"]
    assert all(check["passed"] for check in run["status"]["checks"])
    assert run["spec"]["upTo"] == "V3"
    assert plan_path.read_bytes() and "ledger" not in run["status"]


@pytest.mark.parametrize("change", ["same_size", "size", "plan_size"])
def test_planned_backup_mismatch_rejects_before_commands_and_output(tmp_path, monkeypatch, change):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    backup = tmp_path / "backup.dump"
    backup.write_bytes(b"PGDMPfixture")
    plan_path = tmp_path / "plan.json"
    plan = restore.create_restore_plan(backup, plan_path)
    if change == "same_size":
        backup.write_bytes(b"PGDMPchanged")
    elif change == "size":
        backup.write_bytes(b"PGDMPdifferent size")
    else:
        plan["backup"]["bytes"] += 1
        plan_path.write_text(json.dumps(plan))
    commands.clear()
    output = tmp_path / "not-created" / "run.json"
    with pytest.raises(ValueError, match="does not match"):
        restore.execute_backup_restore(backup, output, plan=plan_path)
    assert not commands and not output.parent.exists()


@pytest.mark.parametrize("override", [{"tables": {}}, {"timeout": 300}])
def test_planned_settings_cannot_be_overridden(tmp_path, monkeypatch, override):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    with pytest.raises(ValueError, match="override"):
        restore.execute_backup_restore(
            tmp_path / "missing.dump",
            tmp_path / "run.json",
            plan=tmp_path / "plan.json",
            **override,
        )
    assert not commands and not (tmp_path / "run.json").exists()


def test_planned_image_mismatch_never_creates_a_target(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(restore, "docker_command", fake_docker(commands))
    backup = tmp_path / "backup.dump"
    backup.write_bytes(b"PGDMPfixture")
    plan_path = tmp_path / "plan.json"
    plan = restore.create_restore_plan(backup, plan_path)
    plan["imageId"] = "sha256:" + "b" * 64
    plan_path.write_text(json.dumps(plan))
    commands.clear()
    result = restore.execute_backup_restore(backup, tmp_path / "run.json", plan=plan_path)
    assert len(commands) == 1 and commands[0][-1] == plan["imageId"]
    assert any(not check["passed"] for check in result["status"]["checks"])


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


@pytest.mark.parametrize("boundary", ["create", "start"])
@pytest.mark.skipif(
    os.environ.get("NOSTEKON_BACKUP_INTEGRATION") != "1",
    reason="explicit local Docker backup integration opt-in",
)
def test_real_sigkill_recovery_preserves_evidence_and_source(tmp_path, boundary):
    archive = tmp_path / "boundary.dump"
    archive.write_bytes(b"PGDMP" + b"synthetic crash-boundary payload")
    original = archive.read_bytes()
    output = tmp_path / "interrupted.json"
    directory = output.with_name(output.name + ".recovery")
    worker_temp = tmp_path / "worker-temp"
    worker_temp.mkdir(mode=0o700)
    script = """
import sys
from pathlib import Path
from nostekon import backup_restore
command = backup_restore.docker_command
def stop_at_boundary(arguments, *, timeout):
    result = command(arguments, timeout=timeout)
    if arguments[0] == sys.argv[3]:
        print("boundary reached", flush=True)
        sys.stdin.readline()
    return result
backup_restore.docker_command = stop_at_boundary
backup_restore.execute_backup_restore(Path(sys.argv[1]), Path(sys.argv[2]))
"""
    child = subprocess.Popen(
        [sys.executable, "-u", "-c", script, str(archive), str(output), boundary],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "TMPDIR": str(worker_temp)},
    )
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            assert selector.select(45), "runner did not reach its controlled Docker boundary"
        assert child.stdout.readline() == b"boundary reached\n"
        checkpoint = json.loads((directory / "recovery.json").read_text())
        assert checkpoint["status"] == ("prepared" if boundary == "create" else "running")
        assert (checkpoint["containerId"] is None) == (boundary == "create")
        with pytest.raises(ValueError, match="active"):
            recovery.recover_backup(directory, confirm_cleanup=True)
        child.kill()
        _, errors = child.communicate(timeout=10)
        assert child.returncode == -9, errors.decode(errors="replace")
        assert output.read_bytes() == b""
        assert (directory / "backup.dump").read_bytes() == original
        before = (directory / "recovery.json").read_bytes()
        reviewed = recovery.recover_backup(directory)
        assert reviewed["containerPresent"] and reviewed["snapshotPresent"]
        assert not reviewed["cleanupConfirmed"] and not reviewed["containerRemoved"]
        assert (directory / "recovery.json").read_bytes() == before
        cleaned = recovery.recover_backup(directory, confirm_cleanup=True)
        assert cleaned["checkpointStatus"] == "cleaned"
        assert cleaned["containerRemoved"] and not cleaned["containerPresent"]
        assert not cleaned["snapshotPresent"]
        assert cleaned["containerId"] == reviewed["observedContainerId"]
        repeated = recovery.recover_backup(directory, confirm_cleanup=True)
        assert repeated["checkpointStatus"] == "cleaned" and not repeated["containerRemoved"]
        assert archive.read_bytes() == original and output.read_bytes() == b""
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=10)
        if directory.exists():
            recovery.recover_backup(directory, confirm_cleanup=True)


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
                "CREATE TABLE public.orders(id integer PRIMARY KEY, customer_id integer); "
                "INSERT INTO public.orders VALUES (1,1),(2,2),(3,NULL); "
                "CREATE TABLE public.customers(id integer PRIMARY KEY); "
                "INSERT INTO public.customers VALUES (1),(2); "
                "CREATE TABLE public.orders_bad(id integer, customer_id integer); "
                "INSERT INTO public.orders_bad VALUES (1,99),(1,1),(NULL,NULL); "
                "CREATE TABLE public.nullable(id integer, customer_id integer); "
                "INSERT INTO public.nullable VALUES (NULL,NULL),(NULL,NULL),(NULL,NULL);",
            ],
            timeout=10,
        )
        backup = tmp_path / "real.dump"
        readonly = [
            "exec",
            "--env=PGOPTIONS=-c default_transaction_read_only=on "
            "-c statement_timeout=5000 -c lock_timeout=1000",
            name,
            "psql",
            "-U",
            "postgres",
            "-d",
            "nostekon",
            "--tuples-only",
            "--no-align",
            "--set=ON_ERROR_STOP=1",
            "--command",
        ]
        assert (
            restore.docker_command(
                [
                    *readonly,
                    "SHOW default_transaction_read_only; SHOW statement_timeout; SHOW lock_timeout",
                ],
                timeout=10,
            )
            == b"on\n5s\n1s\n"
        )
        with pytest.raises(RuntimeError, match="database output omitted"):
            restore.docker_command(
                [*readonly, "INSERT INTO public.orders VALUES (4,1)"], timeout=10
            )
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
        planned_runs = []
        backup_reviews = []
        for expected, exit_code, verdict in [(3, 0, "verified"), (4, 1, "failed")]:
            plan_path = tmp_path / f"plan-{expected}.json"
            planned_output = tmp_path / f"planned-{expected}.json"
            assert (
                main(
                    [
                        "backup",
                        "plan",
                        "--file",
                        str(backup),
                        "--output",
                        str(plan_path),
                        "--expect-table",
                        f"public.orders={expected}",
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
                        str(planned_output),
                        "--plan",
                        str(plan_path),
                    ]
                )
                == exit_code
            )
            recorded = json.loads(planned_output.read_text())
            preflight = restore.preflight_backup(backup, plan=plan_path)
            assert preflight["passed"] is True
            assert preflight["backupMatches"] is True
            assert preflight["requestedLevel"] == "V3"
            assert all(check["passed"] for check in preflight["checks"])
            assert any(
                check["name"] == "Restore plan binding" and check["passed"]
                for check in recorded["status"]["checks"]
            )
            planned_runs.append((planned_output, exit_code, verdict))
            backup_reviews.append((plan_path, planned_output, exit_code, True))
        semantic_runs = []
        for scenario, table, exit_code in [
            ("good", "public.orders", 0),
            ("violations", "public.orders_bad", 1),
            ("nulls-ignored", "public.nullable", 0),
            ("missing-table", "public.missing", 1),
            ("restore-error", "public.orders", 1),
        ]:
            profile = validation_profile()
            for rule in profile["invariants"]:
                rule["table"] = table
            if scenario == "nulls-ignored":
                profile["invariants"] = profile["invariants"][1:]
            profile_path = tmp_path / f"{scenario}-profile.json"
            profile_path.write_text(json.dumps(profile))
            plan_path = tmp_path / f"{scenario}-plan.json"
            run_path = tmp_path / f"{scenario}-v4.json"
            source = backup
            if scenario == "restore-error":
                source = tmp_path / "truncated.dump"
                source.write_bytes(backup.read_bytes()[:32])
            assert (
                main(
                    [
                        "backup",
                        "plan",
                        "--file",
                        str(source),
                        "--output",
                        str(plan_path),
                        "--validation-profile",
                        str(profile_path),
                        "--expect-table",
                        "public.orders=3"
                        if scenario in ("missing-table", "restore-error")
                        else f"{table}=3",
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
                        str(source),
                        "--output",
                        str(run_path),
                        "--plan",
                        str(plan_path),
                    ]
                )
                == exit_code
            )
            recorded = json.loads(run_path.read_text())
            checks = [check for check in recorded["status"]["checks"] if check["level"] == "V4"]
            assert [check["name"] for check in checks] == [
                rule["name"] for rule in profile["invariants"]
            ]
            assert all(check["passed"] == (exit_code == 0) for check in checks)
            if scenario in ("good", "violations", "nulls-ignored"):
                violations = 1 if scenario == "violations" else 0
                assert all(
                    f"measured violations: {violations}; expected 0" in check["detail"]
                    for check in checks
                )
            if scenario == "restore-error":
                assert all("not evaluated" in check["detail"] for check in checks)
            semantic_runs.append((run_path, exit_code, "failed" if exit_code else "verified"))
            backup_reviews.append(
                (
                    plan_path,
                    run_path,
                    exit_code,
                    scenario in ("good", "violations", "nulls-ignored"),
                )
            )
        backup.write_bytes(backup.read_bytes() + b"changed after planning")
        rejected_output = tmp_path / "rejected.json"
        assert (
            main(
                [
                    "backup",
                    "restore",
                    "--file",
                    str(backup),
                    "--output",
                    str(rejected_output),
                    "--plan",
                    str(tmp_path / "plan-3.json"),
                ]
            )
            == 2
        )
        assert not rejected_output.exists()
        report_binary = tmp_path / "report"
        repository = Path(__file__).parent.parent
        subprocess.run(
            ["go", "build", "-o", str(report_binary), "./cmd/nostekon-report"],
            cwd=repository,
            check=True,
            timeout=60,
        )
        captures = tmp_path / "verified-captures"
        captures.mkdir(mode=0o700)
        for plan_path, source, exit_code, complete in backup_reviews:
            original = source.read_bytes()
            evaluation = subprocess.run(
                [str(report_binary), "--backup-plan", str(plan_path), str(source)],
                capture_output=True,
                timeout=15,
            )
            assert evaluation.returncode == exit_code, evaluation.stderr.decode()
            review = json.loads(evaluation.stdout)
            assert review["kind"] == "PostgreSQLBackupReview"
            assert review["passed"] == (exit_code == 0)
            assert review["complete"] == complete
            assert review["evidenceMatches"] == (source.name != "restore-error-v4.json")
            plan = restore.load_restore_plan(plan_path)
            identity = hashlib.sha256(
                json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            assert review["planSHA256"] == identity
            assert review["planFileSHA256"] == hashlib.sha256(plan_path.read_bytes()).hexdigest()
            assert review["evidenceSHA256"] == hashlib.sha256(original).hexdigest()
            assert review["provenance"]["status"] == "unverified"
            assert review["report"]["rpo"] is None
            assert source.read_bytes() == original
            for filename, payload in [
                (plan_path.name, plan_path.read_bytes()),
                (source.name, original),
                (source.stem + ".review.json", evaluation.stdout),
            ]:
                destination = captures / filename
                with destination.open("xb") as artifact:
                    os.fchmod(artifact.fileno(), 0o600)
                    artifact.write(payload)
        altered = tmp_path / "tampered-count.json"
        recorded = json.loads((tmp_path / "planned-3.json").read_text())
        for check in recorded["status"]["checks"]:
            if check["name"] == "Row count: public.orders":
                check["detail"] = "expected 3; measured 2"
        altered.write_text(json.dumps(recorded))
        evaluation = subprocess.run(
            [str(report_binary), "--backup-plan", str(tmp_path / "plan-3.json"), str(altered)],
            capture_output=True,
            timeout=15,
        )
        assert evaluation.returncode == 1, evaluation.stderr.decode()
        review = json.loads(evaluation.stdout)
        assert review["report"]["verdict"] == "verified"
        assert not review["passed"] and not review["evidenceMatches"]
        for source, exit_code, verdict in [
            (passing, 0, "verified"),
            (failing, 1, "failed"),
            *planned_runs,
            *semantic_runs,
        ]:
            evaluation = subprocess.run(
                [str(report_binary), str(source)], capture_output=True, timeout=15
            )
            assert evaluation.returncode == exit_code, evaluation.stderr.decode()
            report = json.loads(evaluation.stdout)
            assert report["verdict"] == verdict
            assert report["requestedLevel"] == (
                "V4" if (source, exit_code, verdict) in semantic_runs else "V3"
            )
            assert report["rpo"] is None
            assert report["provenance"]["status"] == "unverified"
            container = json.loads(source.read_text())["metadata"]["name"]
            assert (
                restore.docker_command(["ps", "-aq", f"--filter=name=^/{container}$"], timeout=5)
                == b""
            )
    finally:
        restore.docker_command(["rm", "--force", name], timeout=15)
