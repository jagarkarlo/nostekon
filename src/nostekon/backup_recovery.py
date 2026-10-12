import fcntl
import json
import os
import re
import stat
from contextlib import suppress
from pathlib import Path
from uuid import uuid4


def _private(descriptor: int, mode: int, *, directory: bool = False) -> None:
    metadata = os.fstat(descriptor)
    valid_kind = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if (
        not valid_kind
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != mode
        or (not directory and metadata.st_nlink != 1)
    ):
        raise ValueError("recovery files must be private, regular and owned by the current user")


def _validate(record) -> dict:
    if type(record) is not dict or set(record) != {
        "apiVersion",
        "kind",
        "runId",
        "name",
        "imageId",
        "containerId",
        "status",
    }:
        raise ValueError("recovery checkpoint has missing or unknown fields")
    if (
        record["apiVersion"] != "nostekon/backup-recovery/v1alpha1"
        or record["kind"] != "PostgreSQLBackupRecovery"
        or record["status"] not in ("prepared", "running", "cleanup-required", "cleaned")
    ):
        raise ValueError("unsupported recovery checkpoint version, kind or status")
    if not isinstance(record["runId"], str) or not re.fullmatch(r"[a-f0-9]{32}", record["runId"]):
        raise ValueError("invalid recovery run identity")
    if record["name"] != f"nostekon-backup-{record['runId'][:12]}":
        raise ValueError("recovery target name does not match its run identity")
    if not isinstance(record["imageId"], str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", record["imageId"]
    ):
        raise ValueError("invalid recovery image identity")
    identity = record["containerId"]
    if identity is not None and (
        not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity)
    ):
        raise ValueError("invalid recovery container identity")
    if record["status"] == "running" and identity is None:
        raise ValueError("running recovery checkpoint requires an exact container ID")
    return record


def _unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("recovery checkpoint contains duplicate fields")
        result[key] = value
    return result


class RecoveryJournal:
    def __init__(self, directory: Path, descriptor: int, lock: int, record: dict):
        self.directory = directory
        self._descriptor = descriptor
        self._lock = lock
        self.record = record

    @classmethod
    def _acquire(cls, directory: Path, *, create: bool):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        lock = None
        try:
            _private(descriptor, 0o700, directory=True)
            flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
            if create:
                flags |= os.O_CREAT | os.O_EXCL
            lock = os.open("lock", flags, 0o600, dir_fd=descriptor)
            _private(lock, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError("rehearsal is active; recovery is blocked") from error
            return descriptor, lock
        except BaseException:
            if lock is not None:
                os.close(lock)
            os.close(descriptor)
            raise

    @classmethod
    def create(cls, directory: Path, *, run_id: str, image_id: str):
        record = _validate(
            {
                "apiVersion": "nostekon/backup-recovery/v1alpha1",
                "kind": "PostgreSQLBackupRecovery",
                "runId": run_id,
                "name": f"nostekon-backup-{run_id[:12]}",
                "imageId": image_id,
                "containerId": None,
                "status": "prepared",
            }
        )
        directory.mkdir(mode=0o700)
        descriptor, lock = cls._acquire(directory, create=True)
        journal = cls(directory, descriptor, lock, record)
        try:
            journal._write(record)
            parent = os.open(directory.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        except BaseException:
            journal.close()
            raise
        return journal

    @classmethod
    def open(cls, directory: Path):
        descriptor, lock = cls._acquire(directory, create=False)
        try:
            metadata = os.open(
                "recovery.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor
            )
            with os.fdopen(metadata, "rb") as handle:
                _private(handle.fileno(), 0o600)
                if not 1 <= os.fstat(handle.fileno()).st_size <= 4096:
                    raise ValueError("recovery checkpoint must be at most 4 KiB")
                payload = handle.read(4097)
            if len(payload) > 4096:
                raise ValueError("recovery checkpoint exceeds 4 KiB")
            try:
                record = json.loads(payload.decode("utf-8"), object_pairs_hook=_unique_fields)
            except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
                raise ValueError("recovery checkpoint must be bounded UTF-8 JSON") from error
            return cls(directory, descriptor, lock, _validate(record))
        except BaseException:
            os.close(lock)
            os.close(descriptor)
            raise

    def _write(self, record: dict) -> None:
        payload = (json.dumps(_validate(record), indent=2, sort_keys=True) + "\n").encode()
        temporary = f".recovery-{uuid4().hex}"
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=self._descriptor,
        )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(
                temporary, "recovery.json", src_dir_fd=self._descriptor, dst_dir_fd=self._descriptor
            )
            os.fsync(self._descriptor)
            self.record = record
        finally:
            with suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=self._descriptor)

    def update(self, status: str, *, container_id: str | None = None) -> None:
        record = {**self.record, "status": status}
        if container_id is not None:
            record["containerId"] = container_id
        self._write(record)

    def close(self) -> None:
        if self._lock is not None:
            os.close(self._lock)
            os.close(self._descriptor)
            self._lock = None

    def __enter__(self):
        return self

    def __exit__(self, *arguments):
        self.close()
