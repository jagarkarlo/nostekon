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

### Check local technical prerequisites

Before executing the reviewed plan, run the metadata-only preflight on the
**dedicated restore host**, using the same Linux account that will run the restore:

```bash
umask 077
set -o noclobber
nostekon backup preflight \
  --file /approved/backups/orders.dump \
  --plan ./plans/orders-plan.json \
  > ./evidence/orders-preflight.json
```

Create the protected evidence directory first and choose a new output filename.
The command emits `PostgreSQLBackupPreflight` JSON with named checks, the canonical
plan fingerprint, observed archive digest/size, pinned image ID and limitations.
It freezes a bounded private temporary copy, then deletes that copy. Source and
plan are unchanged. Byte drift returns a blocked result **before any Docker query**.

The only Docker operations are local daemon information and inspection of the
exact cached image ID. They share a 30-second metadata deadline. The check requires
a Linux daemon on native amd64/arm64, a matching Linux image, at least 512 MiB and
one CPU advertised by the daemon, and at least one declared snapshot count. It
never pulls an image, creates/starts/executes/removes a container, queries a
database, connects to production or writes a recovery checkpoint. Raw daemon
errors and host metadata are not included in the result.

Exit `0` means **these technical prerequisites passed**, `1` means valid inputs
with blocked prerequisites, `2` means invalid/unreadable inputs or output failure,
and `130` means interruption. A redirect may leave an empty/partial file on error;
check the exit status, not just file existence. On any nonzero exit, stop, resolve
the cause and rerun using a fresh output filename. Do not bypass a missing image
or edit the plan to fit a different backup.

Preflight does not validate the complete archive, measure available memory/disk,
verify source version/extensions, prove counts accurate, execute semantic checks
or authorize data handling. `requestedLevel` is the plan's requested depth, **not
an achieved recovery verdict**. Even an intentionally wrong count can pass
preflight. The restore and independent gate must still measure and review it.

You can also gate the recorded preflight JSON offline against its restore plan in
Go or Studio before starting the restore:

```bash
go run ./cmd/nostekon-report --backup-plan ./plans/orders-plan.json \
  --backup-preflight ./evidence/orders-preflight.json
```

In Studio, open **Plan review**, attach the restore plan, and attach the
preflight JSON under **Host preflight**. The shared Go engine verifies canonical
plan identity, archive byte binding, pinned image ID, requested depth and host
prerequisite checks without contacting Docker.

After passing preflight **and obtaining the approvals below**, execute exactly
the reviewed settings:

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

## Author and inspect profiles

Studio's **Profiles** view creates and edits the same validation-profile files
accepted by `backup plan`. It is available in the local app at `/#/profiles` and
the browser demo at `/demo/#/profiles`; neither path starts a restore or connects
to a database. Select Orders, Inventory or an empty template, then edit names,
types, tables, columns and foreign-key parent fields. Rules can be added,
removed and reordered, up to the 20-rule limit. An empty profile is a draft,
not an admitted contract.

Edits are validated through the shared Go engine. **Valid structure** means only
strict profile admission passed. The view lists required tables, null-coverage
and parent-key coverage warnings, and explicitly leaves data, snapshot counts
and owner approval unverified. A warning is not a measured data violation or a
business-rule approval; no warning is not proof of complete domain coverage.

Import requires a nonempty, strict UTF-8 JSON file within 16 KiB. Invalid imports
retain the current draft and display an error. Downloads require a fresh
successful inspection of the current source; an edit immediately invalidates
the previous result. Unedited imports export their exact original bytes.
An explicit form edit produces a new versioned JSON document and a new original
SHA-256; the hash is an identity check, not a signature or approval.

The browser stores one local draft, including invalid intermediate JSON, up to
64 KiB. Reload revalidates it through Go, without trusting a cached result.
This draft is browser-local, not a shared or approved contract. If storage is
unavailable or full, Studio warns that the draft was not saved. Download a
validated copy before leaving; clearing browser storage removes the draft.

From a source checkout with Go installed, inspect a profile offline:

```bash
go run ./cmd/nostekon-report --validation-profile examples/validation-profiles/orders.json
```

The installed `nostekon-report` executable accepts the same flag. Output is
`PostgreSQLProfileReview` JSON with `valid`, exact original `profileSHA256`,
admitted rules, sorted required tables, warnings and limitations. There is no
`passed` data verdict. Exit `0` means admitted structure, including any coverage
warnings; exit `2` means invalid/unreadable input, conflicting flags or output
failure. This mode cannot be combined with evidence, suite, signature, bundle
or Pushgateway options, even when they explicitly supply a default value.

The local/native and browser/WASM APIs share
`POST /api/v1/backups/profile`, with `Content-Type: application/json` and an exact
one-field envelope whose `profile` value is the original JSON **string**, not
a parsed object. HTTP `200` returns the same inspection; `400` rejects an
ambiguous envelope, `413` an oversized envelope, `415` the wrong media type,
`422` an invalid profile and `503` exhausted review capacity. The profile itself
remains bounded to 16 KiB; the envelope allows up to `6 * 16384 + 1024` bytes for
JSON escaping. Resolve the admission error, or retry capacity/network failures;
never treat a failed request as an approved profile.

Verified locally on 2026-10-13: desktop/mobile authoring, native/WASM inspection,
exact imported exports, authored-export CLI parity, invalid-draft recovery,
strict duplicate rejection and the rule cap. Structural inspection does not
replace owner review, snapshot-specific counts, isolated-host preflight, actual
restore or the independent evidence gate below. The production-origin pilot
remains deferred.

## Reusable profile starters

Source checkouts include two profiles tested with synthetic PostgreSQL 16.8
custom archives. Copy and adapt a starter before planning; it is not an approved
business contract or an instruction to run against production.

| Starter | Relations and selected coverage | Rules |
| --- | --- | --- |
| [Orders](https://github.com/jagarkarlo/nostekon/blob/main/examples/validation-profiles/orders.json) | Required, unique customer/order IDs; required order customer ID with an existing customer | 6 |
| [Inventory](https://github.com/jagarkarlo/nostekon/blob/main/examples/validation-profiles/inventory.json) | Required, unique product/warehouse/stock IDs; required stock product and warehouse IDs with existing parents | 10 |

These starters assume every child reference is mandatory. If the domain permits
an absent customer, product or warehouse, ask the owner to review the matching
`not_null` rule rather than copying that assumption unchanged. Parent uniqueness
is checked separately from reference existence. Inventory does not check stock
quantity, reservations, composite product/warehouse uniqueness or valuation;
orders do not check totals, currency or lifecycle transitions. Those rules are
not supported by the current single-column profile schema.

From the source checkout, create a working copy without overwriting an existing
profile:

```bash
mkdir -p profiles plans evidence
cp --no-clobber examples/validation-profiles/inventory.json profiles/inventory.json
```

Have the owner review relation names, key types, mandatory fields and omitted
business rules in that copy. Set `BACKUP` to the approved frozen custom archive,
and `PRODUCT_COUNT`, `WAREHOUSE_COUNT` and `STOCK_COUNT` to independently recorded
counts from that same snapshot. Do not substitute the synthetic test counts.
Choose new plan and evidence output names:

```bash
nostekon backup plan \
  --file "${BACKUP:?Set the approved archive path}" \
  --output plans/inventory-plan.json \
  --expect-table "public.products=${PRODUCT_COUNT:?Set the snapshot count}" \
  --expect-table "public.warehouses=${WAREHOUSE_COUNT:?Set the snapshot count}" \
  --expect-table "public.stock=${STOCK_COUNT:?Set the snapshot count}" \
  --validation-profile profiles/inventory.json &&
nostekon backup preflight \
  --file "${BACKUP:?}" --plan plans/inventory-plan.json
```

Stop on any nonzero exit. Obtain owner approval of the isolated host before
continuing with execution:

```bash
nostekon backup restore \
  --file "${BACKUP:?}" --plan plans/inventory-plan.json \
  --output evidence/inventory-rehearsal.run.json &&
nostekon-report --backup-plan plans/inventory-plan.json \
  evidence/inventory-rehearsal.run.json
```

Stop after any nonzero command exit; do not execute the block unattended. A
preflight pass remains a prerequisites check, not a restore verdict. The final
independent gate must evaluate the original plan and capture. On failed checks,
retain both originals, identify each measured V4 violation with the owner, and
follow the existing cleanup/recovery instructions before another attempt. Do
not lower expectations or remove a rule just to produce a pass.

Verified on 2026-10-13 using the existing opt-in Docker integration test: both
starters pass on matching synthetic data. Corrupted variants keep every declared
row count unchanged, pass all V3 counts, and fail the exact expected V4 rules for
duplicate IDs, missing mandatory values and orphan references. Independent Go
review confirms complete, matching but failed captures, unauthenticated
provenance and no RPO measurement; all owned restore targets are removed. This
does not validate a production schema, the owner's business rules or crash
recovery of an application using these examples.

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

## Gate a captured rehearsal against its plan

Verified locally on 2026-10-12 against actual Python-generated v1/v2 plans and
isolated PostgreSQL captures: passing counts/rules, wrong counts, equal-count
semantic corruption, missing relations and incomplete restores. A numerically
altered capture which still received a normal `verified` report was rejected by
this independent gate. No Docker or production connection is needed for review.

Use the reviewed plan and its original captured JSON. For the semantic example
above, using the report binary built in the preceding section:

```bash
/tmp/nostekon-report --backup-plan ./plans/orders-semantic-plan.json \
  ./evidence/orders-semantic-rehearsal.run.json
```

The same flag accepts v1 plans without semantic rules. It emits a JSON
`PostgreSQLBackupReview`, not a new DrillRun. The Go reviewer independently checks:

- Strict, bounded plan schema and canonical plan fingerprint; archive digest/size
  and immutable image identity must match the recorded V0 checks.
- Exactly one required restore, health and cleanup check, with the recorded
  cleanup target matching the evidence run name.
- Every planned table count, its expected value and numeric measurement;
  the recorded pass flag must agree with the measured result.
- Every planned semantic rule's full type/table/column/reference scope,
  numeric violation result or explicit failure/not-evaluated state.
- Exact requested depth and ordered invariant declarations; no extra count/rule
  scope, missing/duplicate checks, invented ledger or unplanned objectives.

`passed` is true only for complete, matching evidence with an independently
passing report. `complete` means required observations are present; an explicit
query failure or not-evaluated rule is not a measurement. `evidenceMatches` means
the recorded claims agree with the supplied plan and their numeric pass flags,
**not** that the data passed. A real count mismatch or semantic violation can be
complete and matching while still failing. `issues` explains drift or omissions;
the nested `report` retains the ordinary recovery verdict and unmeasured RPO.

Exit codes are `0` passing gate, `1` valid failed/incomplete/mismatched review,
and `2` invalid/unreadable/oversized input or output failure. Plans are limited to
16 KiB and evidence to 16 MiB; symlinks and known non-regular inputs are rejected.
Duplicate fields, nonfinite numbers, excessive nesting, unknown plan fields and
invalid identifier/count types fail admission. Gate mode cannot mix `--suite`,
per-run attestation or Pushgateway options; it performs no network call or restore.

Keep the JSON review beside the originals. `planSHA256` is the canonical settings
identity; `planFileSHA256` and `evidenceSHA256` bind the exact supplied bytes.
Formatting can change the plan file digest without changing canonical identity.
These are consistency checks, not signatures, approval or authenticated capture;
provenance remains `unverified`. Independently review the plan with the backup
owner. A party able to forge both plan and evidence can forge consistent claims.
Studio's **Plan review** tab attaches the original plan to the original DrillRun;
do not import the gate JSON as evidence. Signature verification is a separate
operation and does not establish runner truth.

The synthetic backup CI job retains only original plans, captures and independent
reviews for seven days, including expected failed scenarios. Dumps, recovery
snapshots, locks and raw database output are excluded. Hosted execution must be
checked separately; local tests do not establish a passing hosted run.

## Review in Studio and share a portable bundle

Verified locally on 2026-10-12 in the static browser/WASM engine and installed Go
app, at desktop and mobile widths. Import the captured DrillRun in Report, open
**Plan review**, and **Attach plan**. The independent gate shows three separate
states: pass/fail, complete/incomplete measurements, and matching/mismatched plan
claims. Changing either original invalidates the previous review. Original plan,
evidence and fresh review downloads remain available; no database is contacted.

**Export backup bundle** produces a portable ZIP with four known entries
(`manifest.json`, `plan.json`, `run.json`, and `review.json`) under
`nostekon/backup-bundle/v1alpha1`, or five entries including `preflight.json`
under `nostekon/backup-bundle/v2alpha1` when a host preflight original is
attached. The manifest records
SHA-256 and byte lengths for the included documents. Plan, preflight and run bytes are preserved,
including whitespace. Failed and incomplete captures can be shared; exporting
does not turn their gate into a pass. No dump, recovery snapshot, checkpoint,
private key, credential or raw database output is added by the exporter.

**Import backup bundle** verifies the inventory, sizes and checksums, then
evaluates the original plan/run (and optional preflight) again. The cached review is never authoritative:
even a forged passing receipt with updated checksums cannot upgrade the fresh
verdict or provenance. Import does not grant signature trust or save anything
automatically. **Save run** explicitly stores the exact attached plan and preflight alongside
the original evidence in this browser. Reopening it calculates a fresh plan and preflight
review, not a cached verdict. Save again after removing or replacing a plan or preflight.
Runs can download the original plan or preflight, or back up and restore attached originals
across browser origins. Export a bundle to share the plan/preflight/run/review inventory;
it is separate from the saved-run history backup.

The native report binary supports the same offline round-trip. Use a new output
filename; the Bash shell below prevents overwrites and creates private files:

```bash
umask 077
set -o noclobber
/tmp/nostekon-report --backup-plan ./plans/orders-semantic-plan.json \
  --export-backup-bundle ./evidence/orders-semantic-rehearsal.run.json \
  > ./evidence/orders.backup-review.zip
/tmp/nostekon-report --backup-bundle ./evidence/orders.backup-review.zip
```

Export writes binary ZIP to stdout, not JSON. Its exit status remains the gate
status: `0` pass, `1` valid failed/incomplete/mismatched capture (a valid ZIP is
still written), `2` admission or output error. A redirect can leave an empty or
partial file on error; discard that file, do not treat its existence as success.
Bundle import emits a freshly calculated JSON review with the same exit codes.
These modes cannot mix suite, attestation or Pushgateway flags.

Admission permits only uncompressed regular ZIP entries with unique known names;
no paths are extracted. ZIP directory metadata is checked before allocating
entries and is limited to four or five records within 4 KiB; ZIP64, multiple disks,
archive comments and trailing bytes are rejected. Total archive size is limited
to 20 MiB, plan and optional preflight to 16 KiB each,
run to 16 MiB, cached review to 2 MiB, and manifest to 16 KiB. The browser preserves
valid UTF-8 originals and rejects lossy file decoding. Checksums establish
integrity and consistency, **not authenticity**: a party able to forge both
originals can still forge consistent claims. Backup-owner approval and independent
capture remain separate requirements.

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

### First production-origin pilot checklist

The local workflow is implemented; an actual production-origin pilot still needs
an approved asset, owner and dedicated execution host. No production-origin backup
has been used in the verification described here. A file named `approved.dump`, a
checksum or a passing preflight is not an approval record.

1. **Backup owner:** record approval to copy/process one completed, sanitized
  custom-format backup, its snapshot time, source server version and required
  extensions. Confirm it contains no prohibited data and fits the 64 MiB limit.
  Do not obtain production credentials or export source data as part of this runbook.
2. **Restore-host operator:** approve a dedicated Linux host and trusted cached
  compatible image. Assess expanded database size against the 512 MiB limit,
  currently free RAM/disk, temp-copy storage and workload isolation. Docker's total
  advertised memory is not available capacity; this is not a shared-daemon service.
3. **Coverage owner:** supply counts from that exact snapshot and review the selected
  semantic rules and omitted business checks. Keep this approval outside the
  unsigned plan/bundle. Do not lower a count or remove a rule just to obtain a pass.
4. **Evidence handling:** use a fresh private output directory on that host, choose
  an owner and retention period for the archive, plan, capture, preflight, review
  and any recovery snapshot. Do not upload production-origin assets to CI or commit
  them to Git. Bundles omit dumps but still contain schema names, counts and results.
5. **Admission:** generate the plan on the host, review it with the owners, then run
  the preflight above. Resolve every failed check; independently confirm the
  approvals, source compatibility and capacity that the command cannot establish.
6. **Execution:** run one plan-bound restore into the isolated target. Record the
  exit status and inspect restore, health, count/rule and cleanup observations.
  Exit `1` is failed evidence, not permission to weaken the plan. Exit `2`/`130`
  requires checking the output and recovery state before any new attempt.
7. **Independent review:** use the original plan/capture with the Go gate or Studio
  Plan review above. Require passing, complete, matching evidence and successful
  cleanup for pilot acceptance. Preserve honest failed evidence and investigate
  mismatches. Export a bundle only under the agreed data-handling policy.
8. **Closeout:** verify exact-target cleanup and private snapshot removal. After a
  hard stop, follow read-only recovery inspection and separately authorized,
  quiescent exact-target cleanup above. Have the owners accept the measured scope,
  limitations and retention decision; do not report RTO/RPO or production readiness
  from this isolated restore alone.

If any owner, approved backup, snapshot facts, compatible image or host is missing,
the pilot remains blocked. Synthetic test success is not a substitute. The evidence
viewer remains usable for offline plan/bundle review without any execution access.

### Direct Integration Boundary

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