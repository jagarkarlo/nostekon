# Rehearse a real PostgreSQL backup

Nostekon can restore an existing PostgreSQL custom-format backup into a
disposable local database. This is the first path beyond generated lab data:
an approved production-origin backup can be tested without production
credentials, contacting the source, or deleting a source namespace.

Verified locally on 2026-10-12 with PostgreSQL 16.8, a real `pg_dump -Fc`,
three restored rows, an intentionally wrong count, bound restore plans,
post-plan archive mutation rejection, independent Go evaluation and cleanup.
No production backup was used in that test.

## Prerequisites and boundaries

- Linux, the Python CLI installed from the checkout, and local Docker access.
- A trusted PostgreSQL 16.8 image already cached. The runner never pulls images.
- An approved, completed `pg_dump -Fc` file of at most 64 MiB. Plain SQL,
  directory, tar, physical/PITR and encrypted backups are not supported.
- At most 20 optional `schema.table=COUNT` expectations from the **same backup
  snapshot**, not a live database that changed since the snapshot.
- Approval to handle the backup on this machine. Prefer sanitized data for the
  first pilot; protect the source archive and evidence files.

This CLI is separate from the portable evidence-viewer app. The app gets no
Docker socket or backup-execution endpoint. Existing k3d guards stay intact.
Docker is not a security boundary for arbitrary hostile code: use approved
backups and images on a trusted dedicated host, not untrusted uploads on a shared
daemon.

Install with `python -m pip install -e .` in a virtual environment. After your
normal image-approval process, cache and inspect the image explicitly:

```bash
docker --host unix:///var/run/docker.sock pull postgres:16.8
docker --host unix:///var/run/docker.sock image inspect postgres:16.8 --format '{{.Id}}'
```

The runner freezes that immutable image ID for the attempt. It always uses
`unix:///var/run/docker.sock`, ignoring remote Docker host/context environment
settings. It uses no Kubernetes context, application credentials or DSN.

## Bind and review inputs before restoring

For a pilot, create a reviewable plan before execution. Replace the archive and
expected count with the approved snapshot's inputs:

```bash
nostekon backup plan \
  --file /approved/backups/orders.dump \
  --output ./plans/orders-plan.json \
  --expect-table public.orders=1250 \
  --timeout 300
python -m json.tool ./plans/orders-plan.json
```

Planning freezes and hashes a private archive copy and inspects the cached image;
it does not create a container or run a restore. The private JSON binds the backup's
SHA-256 and byte size, the immutable image ID, selected table expectations and the
execution timeout. It contains no source path, credentials or rows. Review those
fields with the backup owner, confirm the count against that snapshot and follow
your normal data-handling and image-approval process. Protect the plan alongside
the approved archive, outside the source repository.

Then execute exactly those settings:

```bash
nostekon backup restore \
  --file /approved/backups/orders.dump \
  --plan ./plans/orders-plan.json \
  --output ./evidence/orders-rehearsal.run.json
```

`--plan` rejects `--expect-table` and `--timeout` overrides, even if the supplied
values appear equivalent. A changed archive, including one of the same size, is
rejected with exit `2` before Docker commands or evidence-output creation. The
runner looks up the saved image ID, not the current tag; if that image is missing
or mismatched, the rehearsal fails without creating a target and retains failure
evidence. It never pulls or falls back to a different image. Retain the approved
cached image, or create and review a new plan after approving a replacement.

Plans are bounded to 16 KiB, strict versioned UTF-8 JSON with no unknown or
duplicate fields, symlinks, pipes, nonfinite numbers or invalid settings. New
plans are published atomically with private permissions and never overwrite an
existing path. Planning exits `0` on success, `2` on input/image/publication error
and `130` on interruption. After interruption, inspect the output before retrying;
a complete plan may already have been published. This is not a recovery manager.

Evidence includes a **Restore plan binding** V0 check with the SHA-256 of the
parsed plan's sorted, compact JSON. Whitespace and key order do not change that
canonical fingerprint; changing a setting does. Retain the plan to compare its
settings with the evidence. The fingerprint is not a signature, approval or
authenticated provenance. Editing expectations can produce a different passing
plan; the tool cannot prove that the backup owner's expectations were correct.
Production authorization, application consistency and RPO remain separate gates.

## Restore and evaluate

For an ad hoc rehearsal without a saved plan, use a backup from the approved
backup process. Do not put production credentials
in commands, evidence, the repository or Studio. Replace the file and
snapshot-specific expected count below:

```bash
nostekon backup restore \
  --file /approved/backups/orders.dump \
  --output ./evidence/orders-rehearsal.run.json \
  --expect-table public.orders=1250 \
  --timeout 300
```

Without `--expect-table`, requested depth is V2: restore completion and a database
health query. With expectations, V3 checks each selected row count. Identifiers
must be lowercase `schema.table`, not system schemas or arbitrary SQL. Counts
can be zero and must be nonnegative integers. Duplicate expectations fail.
Timeout accepts 30..1800 seconds. Existing output files are never overwritten.

The runner copies bounded regular input into a private temporary directory,
rejects symlinks/pipes and concurrent changes, and hashes the frozen bytes. Only
that read-only copy is mounted. The fresh target has no network, published ports,
service credentials, writable host mounts or retained container logs. Its root is
read-only, capabilities dropped, UID non-root, CPU/memory/PIDs bounded. Database
storage is temporary RAM-backed storage capped at 512 MiB; compressed backups may
expand beyond this and fail.

`pg_restore` uses a single transaction, stops on errors, and omits owners,
privileges, tablespaces and security labels. Extension/version/role compatibility
may fail; do not silently skip restore errors. Counts use quoted validated
identifiers. Raw rows and stderr are not saved. Commands have deadlines and output
limits.

Exit codes: `0` requested checks passed; `1` rehearsal or cleanup failed;
`2` input/output/configuration error; `130` interrupted. Normal failures retain a
private DrillRun. Handled interruptions retain failure evidence when cleanup and
publication complete. Hard host termination cannot guarantee cleanup or a
completed report: a reserved empty output is not success.

Independently evaluate the original JSON:

```bash
go build -o /tmp/nostekon-report ./cmd/nostekon-report
/tmp/nostekon-report ./evidence/orders-rehearsal.run.json
```

Import it into Studio's Runs or Report view. Recovery is evaluated again;
signatures remain unverified. Studio and Markdown call the interval **Rehearsal
duration**, not incident RTO. `failureAt` means rehearsal start for compatibility
with the current contract. No ledger is manufactured: RPO and acknowledged-write
loss remain unmeasured. A V3 pass proves only specified checks, not all data,
semantic consistency, application readiness, or a production recovery objective.

## Cleanup and failure handling

The generated `nostekon-backup-*` target is force-removed after success, failure,
timeout or a handled interruption. Failed cleanup is a failed check. Inspect the
exact name in evidence before removing it manually:

```bash
docker --host unix:///var/run/docker.sock ps -a \
  --filter label=io.nostekon.purpose=backup-rehearsal
# Only after identifying this attempt's generated container:
docker --host unix:///var/run/docker.sock rm --force nostekon-backup-REPLACE_WITH_RUN_ID
```

Never prune all containers or remove unrelated targets. Reports stay outside the
temporary database. Keep original approved backups according to retention policy;
the runner never erases the source. Investigate a count mismatch; do not lower
expectations until the report turns green.

## Production-readiness gates

**Available now:** local isolated rehearsals of approved PostgreSQL backup files.
**Next pilot:** one sanitized production-origin backup, matching server/extensions,
snapshot-specific expectations, reviewable evidence and successful cleanup on a
dedicated restore host. That requires an approved backup and owner, not another
synthetic test.

**Before direct production integration:** read-only backup-store credentials,
allowlisted isolated targets, least privilege and egress controls, operator
approval/audit, authenticated remote execution, interruption recovery,
application-specific read-only V4 invariants, and an independently captured
acknowledged-write ledger for RPO. Prove these on staging first. Production failure
injection, source deletion, in-place restore, schedules and general remote
orchestration are not supported or authorized by this feature.