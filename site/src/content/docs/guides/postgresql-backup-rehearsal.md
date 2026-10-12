# Rehearse a real PostgreSQL backup

Nostekon can restore an existing PostgreSQL custom-format backup into a
disposable local database. This is the first path beyond generated lab data:
an approved production-origin backup can be tested without production
credentials, contacting the source, or deleting a source namespace.

Verified locally on 2026-10-12 with PostgreSQL 16.8, a real `pg_dump -Fc`,
three restored rows, an intentionally wrong count, bound restore plans,
post-plan archive mutation rejection, independent Go evaluation and cleanup.
Semantic profiles were also verified against nulls, duplicates and orphaned
references despite matching row counts; nullable-key semantics, missing tables,
failed restores, read-only sessions and desktop/mobile evidence export were tested.
Hard-stop recovery was verified with actual SIGKILL at Docker create and start
boundaries, including creation before the container ID was journaled, active-lock
refusal, read-only inspection and repeated exact-target cleanup. The crash-boundary
tests use synthetic archive bytes and stop before restore; the separate restore
test uses the real custom dump described above. Host power loss was not tested.
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

## Add reviewed semantic checks

Row counts can match while important relationships are broken. For V4, define an
owner-reviewed profile for the approved snapshot, for example
`./profiles/orders-profile.json`:

```json
{
  "apiVersion": "nostekon/validation-profile/v1alpha1",
  "kind": "PostgreSQLValidationProfile",
  "invariants": [
    {
      "name": "orders-id-required",
      "type": "not_null",
      "table": "public.orders",
      "column": "id"
    },
    {
      "name": "orders-id-unique",
      "type": "unique",
      "table": "public.orders",
      "column": "id"
    },
    {
      "name": "orders-customer-exists",
      "type": "foreign_key",
      "table": "public.orders",
      "column": "customer_id",
      "reference": { "table": "public.customers", "column": "id" }
    }
  ]
}
```

Replace those relations and rules with the backup owner's expectations. Then
freeze them into a new plan, alongside at least one snapshot-specific row count:

```bash
nostekon backup plan \
  --file /approved/backups/orders.dump \
  --output ./plans/orders-semantic-plan.json \
  --expect-table public.orders=1250 \
  --validation-profile ./profiles/orders-profile.json
python -m json.tool ./plans/orders-semantic-plan.json
nostekon backup restore \
  --file /approved/backups/orders.dump \
  --plan ./plans/orders-semantic-plan.json \
  --output ./evidence/orders-semantic-rehearsal.run.json
```

Profiles require 1..20 uniquely named rules and the same strict 16 KiB JSON/file
admission as plans. Names are lowercase slugs of at most 63 characters. Tables
and columns use validated lowercase SQL identifiers; system schemas, arbitrary
SQL, filters and unknown fields are rejected. Checks support single columns only:

| Type | Violation counted | Null semantics |
| --- | --- | --- |
| `not_null` | Rows whose selected column is null | Each null row fails |
| `unique` | Distinct non-null values appearing more than once | Nulls are ignored |
| `foreign_key` | Non-null child rows with no matching parent value | Null child keys are ignored |

Combine `not_null` with the other rules when a value is mandatory. A reference
check proves existence, not parent uniqueness, cardinality, composite keys or
cross-store consistency. These checks can pass on an empty relation; use counts
and owner-reviewed coverage to avoid vacuous success. The rules do not need to
be declared as database constraints in the source schema.

Planning with a profile creates `nostekon/restore-plan/v2alpha1` with the complete
rule definitions embedded, not a profile filename. Execution does not reread the
profile; changing or deleting that file cannot change a saved plan. Legacy v1
plans remain supported. V2 plans require a row-count expectation so V3 cannot be
silently skipped before V4. There is no execution-time `--validation-profile`
override. The canonical plan fingerprint includes all rule definitions; it still
does not authenticate their correctness or operator approval.

After restore and counts, generated SELECT queries run in read-only PostgreSQL
sessions with a 5-second statement timeout and 1-second lock timeout, also bounded
by the overall rehearsal deadline. Raw rows, stderr and arbitrary SQL are not
retained. Each rule records its scope and measured violation count; zero passes.
A missing relation, incompatible comparison, timeout or query error fails the
rule with a sanitized detail. Other rules are still attempted within the deadline.
An early restore failure or handled interruption records remaining declared rules
as failed/not evaluated, never passed. Cleanup failure also fails the attempt.

The evidence requests V4 and declares every rule with a matching reported check.
Independent Go and Studio evaluation retain those results; Studio's Markdown
includes complete reported V4 details, and original JSON export remains exact.
Passing means only the selected rules and preceding levels passed. It does not
prove full application correctness, authenticated capture, incident RTO or RPO.

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
Timeout accepts 30..1800 seconds. A profile-bound plan requests V4 as described
above. Existing output files are never overwritten.

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
identifiers and read-only sessions with the same query limits above. Raw rows and
stderr are not saved. Commands have deadlines and output
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

The runner attempts cleanup after success, failure, timeout or handled interruption.
Before creating a target it creates a private `OUTPUT.json.recovery` directory
(mode `0700`), atomic `recovery.json` and exclusive `lock` (mode `0600`), and a
read-only private `backup.dump` copy (mode `0444`). It holds the lock through
cleanup and evidence publication. Normal cleanup removes the owned target and
copy, but retains the cleaned checkpoint. Failed cleanup is a failed V2 check;
the copy remains available for guarded cleanup, not automatic resume.

After a failed cleanup or hard stop, inspect the **original** checkpoint directory
from the same Linux account and local Docker daemon:

```bash
nostekon backup recover \
  --directory ./evidence/orders-rehearsal.run.json.recovery
```

Without confirmation, this prints a JSON `PostgreSQLBackupRecoveryReview` and
changes no checkpoint, archive or container. Review `checkpointStatus`,
`containerPresent`, `snapshotPresent` and `observedContainerId`; a created target
may have an observed ID before its ID was saved. An active runner blocks recovery
before any Docker call.

Only after confirming that the runner has stopped **and any pending Docker create
activity has settled**, authorize cleanup:

```bash
nostekon backup recover \
  --directory ./evidence/orders-rehearsal.run.json.recovery \
  --confirm-cleanup
```

Confirmation is an operator assertion, not automatic proof of quiescence. This
matters when a stop interrupted creation before its outcome was recorded: current
absence alone cannot rule out a late create. Cleanup validates the full container
ID, generated name, immutable image and purpose/run/directory-identity labels;
only then does it remove that exact ID and the journal's snapshot. A copied
checkpoint cannot remove the original target. Known-ID lookup never falls back to
deleting a same-name replacement. The review reports `cleaned`; repeated confirmed
cleanup is a no-op after verifying absence. Inspection/cleanup share a 30-second
deadline. Exit codes are `0` for a successful review or cleanup, `2` for invalid,
busy, inaccessible or unverifiable state, and `130` for interruption.

On an error, stop and investigate with the backup owner/restore-host operator.
Do not alter metadata, bypass the lock, trust a copied directory, force removal
by name, or prune unrelated containers. A corrupt checkpoint or changed ownership
requires manual investigation, not a guessed target. A cleanup command failure
can be retried after resolving Docker access and confirming quiescence again.

Recovery never signals a saved PID, resumes a restore, or creates/overwrites a
DrillRun. A reserved empty output remains empty and is **not evidence of success**;
start a fresh attempt with a new output after cleanup. Treat retained snapshots
as backup data under the same access and retention policy. Hard stops before a
checkpoint exists, or the runner's original temporary frozen copy after SIGKILL,
are not swept by this command; inspect those residues offline on the dedicated
host. Filesystem sync is used, but no host-power-loss guarantee is claimed.

The approved source archive and existing evidence are never erased by recovery.
Investigate a count mismatch; do not lower expectations until the report turns
green. The review is cleanup state only, not restore evidence or an RTO/RPO result.

## Production-readiness gates

**Available now:** local isolated rehearsals of approved PostgreSQL backup files.
**Next pilot:** one sanitized production-origin backup, matching server/extensions,
snapshot-specific counts and reviewed semantic coverage, reviewable evidence and successful cleanup on a
dedicated restore host. That requires an approved backup and owner, not another
synthetic test.

**Before direct production integration:** read-only backup-store credentials,
allowlisted isolated targets, least privilege and egress controls, operator
approval/audit, authenticated remote execution, staging-validated interruption
handling for the chosen deployment mode,
owner-validated business-rule coverage beyond these three basic check types,
and an independently captured
acknowledged-write ledger for RPO. Prove these on staging first. Production failure
injection, source deletion, in-place restore, schedules and general remote
orchestration are not supported or authorized by this feature.