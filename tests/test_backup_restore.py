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


def fake_docker(
    commands, *, fail_restore=False, fail_cleanup=False, count=b"3\n", invariant_count=None
):
    def execute(arguments, *, timeout):
        commands.append(arguments)
        if arguments[:2] == ["image", "inspect"]:
            return b"sha256:" + b"a" * 64
        if arguments[:2] == ["rm", "--force"] and fail_cleanup:
            raise subprocess.CalledProcessError(1, "docker")
        if "pg_restore" in arguments and "--exit-on-error" in arguments and fail_restore:
            raise subprocess.CalledProcessError(1, "docker")
        if "psql" in arguments:
            if invariant_count is not None and " WHERE " in arguments[-1]:
                return invariant_count
            return count if "count(*)" in arguments[-1] else b"1\n"
        return b""

    return execute


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
            assert any(
                check["name"] == "Restore plan binding" and check["passed"]
                for check in recorded["status"]["checks"]
            )
            planned_runs.append((planned_output, exit_code, verdict))
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
