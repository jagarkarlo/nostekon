---
title: k3d isolated cluster runbook
description: Step-by-step guide to executing a real PostgreSQL disaster recovery drill across two local k3d clusters.
---

This runbook guides you through provisioning two segregated Kubernetes clusters on your workstation using k3d, executing a PostgreSQL logical backup and restore drill, and verifying the evidence.

## Prerequisites

Ensure the following tools are installed:
- **Docker:** 24.0+ (engine running)
- **k3d:** v5.4+ (`k3d version`)
- **kubectl:** v1.28+
- **Python:** 3.12+ with Nostekon installed (`pip install -e .`)
- **Go:** 1.25+ (for `nostekon-report`)

## 1. Create the segregated clusters

Nostekon bundles declarative cluster definitions in `lab/k3d/source.yaml` and `lab/k3d/restore.yaml`. Run:

```bash
make lab-up
```

Or manually:

```bash
k3d cluster create --config lab/k3d/source.yaml
k3d cluster create --config lab/k3d/restore.yaml
```

This creates:
- `k3d-nostekon-source`: Source cluster on dedicated Docker bridge network.
- `k3d-nostekon-restore`: Target cluster with isolated API server, network, and storage.

## 2. Proxy and offline image caching (if needed)

If running in corporate or restricted network environments where nodes cannot pull from Docker Hub, import the required images from the host daemon into both clusters:

```bash
docker pull rancher/mirrored-pause:3.10.2
docker pull postgres:16.8

k3d image import -c nostekon-source -c nostekon-restore \
  rancher/mirrored-pause:3.10.2 \
  postgres:16.8
```

## 3. Verify cluster readiness

Check that both clusters are reachable and have ready nodes:

```bash
nostekon lab status
```

Expected output:
```
source   [READY    ] context=k3d-nostekon-source nodes=2
restore  [READY    ] context=k3d-nostekon-restore nodes=2
```

## 4. Execute the recovery drill

Run the automated PostgreSQL disaster recovery drill:

```bash
nostekon lab run --writes 10 --output /tmp/k3d-evidence.json
```

What this does:
1. Validates that `k3d-nostekon-source` and `k3d-nostekon-restore` address distinct Kubernetes control planes.
2. Creates an ephemeral `nostekon-<id>` namespace in both clusters.
3. Launches PostgreSQL in the source cluster and records ten successfully
  acknowledged writes in a private host-side SQLite ledger.
4. Performs a `pg_dump` logical backup.
5. Injects catastrophic failure by **deleting the source namespace** and awaiting termination.
6. Streams the backup into the PostgreSQL instance in the separate restore cluster.
7. Executes V2 connectivity checks, confirms the backed-up V3 row count,
   preserves the original V4 probe and compares all recovered IDs with the ledger.
8. Writes a `DrillRun` with acknowledged-write evidence and a zero-loss objective.
9. Automatically cleans up test namespaces in both clusters.

## 5. Evaluate the evidence report

Pass the generated evidence to `nostekon-report`:

```bash
go run ./cmd/nostekon-report /tmp/k3d-evidence.json
```

The evaluator will output the JSON report and exit with `0` (Verified), `1` (Failed), or `2` (Incomplete/Invalid). This previously captured V3 run is a historical example; a current successful lab run requests V4:

```json
{
  "name": "checkride-31efc5783dea",
  "scenario": "isolated-postgresql-logical-restore",
  "verdict": "verified",
  "headline": "Verified to V3",
  "requestedLevel": "V3",
  "deepestPassed": "V3"
}
```

Current runs also contain ledger evidence. With `--writes 10` and no tail, the
report should show ten acknowledged and recovered writes, zero lost writes,
RPO `0s`, and `met: true` for the `0s` objective. This was verified against
a real local k3d restore on 2026-10-05.

### Demonstrate acknowledged-write loss

Run a separate drill that inserts two more writes after taking the dump:

```bash
nostekon lab run --writes 10 --after-backup-writes 2 --output /tmp/k3d-tail-loss.json
go run ./cmd/nostekon-report /tmp/k3d-tail-loss.json
```

Both commands should exit `1`: the backup and V3 row count pass, but V4 fails
the zero-loss objective. The report should show twelve acknowledged writes,
ten recovered and two lost, with no holes or unexpected IDs. The measured
RPO duration depends on this run's acknowledgement and failure timestamps.
Do not treat this intentional failure as a broken backup command.

### Permit a bounded loss window explicitly

If the drill's policy allows up to 60 seconds of tail loss, declare it before
execution. Use a new output path; existing evidence and ledger files are never
overwritten:

```bash
nostekon lab run --writes 10 --after-backup-writes 2 --rpo-seconds 60 \
  --output /tmp/k3d-budget-loss.json
go run ./cmd/nostekon-report /tmp/k3d-budget-loss.json
```

Both commands exit `0` only if the measured RPO is within the declared budget
and all checks pass. The report still shows two lost writes; **verified does
not mean zero loss**. A budget never permits holes in the recovered prefix or
unexpected restored IDs. The runner also rejects blank, duplicate or truncated
restored-ID results that contradict its verified V3 row count; such failures
emit failed V4 evidence without a measured ledger.

Three unchanged real captures from 2026-10-05 are checked into `examples/runs/`
and available in Studio alongside the historical V3 example:

| File | Acknowledged / recovered / lost | RPO | Budget | Verdict |
| --- | --- | --- | --- | --- |
| `k3d-ledger-zero-loss.run.json` | 10 / 10 / 0 | 0s | 0s | Verified V4 |
| `k3d-ledger-tail-loss.run.json` | 12 / 10 / 2 | 0.978107s | 0s | Failed V4 |
| `k3d-ledger-budget-loss.run.json` | 12 / 10 / 2 | 0.949153s | 60s | Verified V4 |

These durations describe the captured runs, not a performance guarantee.
All three have zero holes and zero unexpected IDs. To inspect the permitted-loss
capture without creating clusters:

```bash
go run ./cmd/nostekon-report examples/runs/k3d-ledger-budget-loss.run.json
```

### Run the three-case policy suite

Run all three outcomes as one regression gate against the same two disposable
clusters. Choose an output directory that does not already exist:

```bash
nostekon lab suite --output-dir /tmp/nostekon-suite-001
```

The suite defaults to ten writes before each backup and runs these cases in order:

| Case | Writes after backup | RPO objective | Expected drill exit |
| --- | --- | --- | --- |
| `zero-loss` | 0 | 0s | 0 |
| `tail-loss` | 2 | 0s | 1 |
| `budget-loss` | 2 | 60s | 0 |

The **suite exits 0 when all three measured outcomes match their expectations**.
The strict `tail-loss` DrillRun remains failed; it is not rewritten as verified.
The suite checks the lost-write counts, holes, unexpected IDs, objectives and
V0-V4 evidence, including the original probe. An unrelated restore, query or
cleanup error does not count as the expected strict-policy failure. An unexpected
outcome stops the suite and returns 1 without executing later cases.

Each case produces `<case>.drillrun.json` and its SQLite ledger. The directory
uses mode `0700`; the summary, evidence and ledger files use `0600`. The suite
rejects an existing output directory before accessing clusters. It persists
`suite.json` before each case and after evaluation, including expected and
observed exits, measured RPO and the final suite status. Keep individual evidence
files for independent evaluation; the summary is a regression result, not a
replacement for a DrillRun report or authenticated provenance.

Each checkpoint is serialized into a private `0600` temporary file in the
suite directory. The runner flushes and syncs that file, atomically replaces
`suite.json`, then syncs the directory. A serialization, file-sync or replacement
failure leaves the previous published snapshot unchanged. A directory-sync
failure occurs after replacement: the new JSON is complete, but durability is
unconfirmed and execution stops with an error.

Once a snapshot has been published, interruption during a later write does not
replace it with partial JSON. Before the first publication, there may be no
complete summary. Atomic publication does not make all suite artifacts one
transaction or automatically resume an interrupted run.

To evaluate the intentionally failed case independently, build the Go binary
so its exit status is preserved:

```bash
go build -o /tmp/nostekon-report ./cmd/nostekon-report
/tmp/nostekon-report /tmp/nostekon-suite-001/tail-loss.drillrun.json
```

This evaluator should return 1 and still report the measured two lost writes.
Studio comparisons display both recovery objectives and warn when policies
differ, so a budget change is not mistaken for an improved recovery.

Suite `--writes` accepts 1-98; the two tail writes keep the total at most 100.
Suite `--rpo-seconds` accepts 1-86400 and changes only the `budget-loss` objective
(default 60). The other two cases retain `0s`. Optional `--source-context`,
`--restore-context` and `--image` use the same isolation checks as `lab run`.
SIGINT or SIGTERM returns 130 and attempts normal cleanup. Inspect the summary
and cleanup messages before rerunning with a fresh directory. A forcibly killed
process can leave the last complete summary marked **running**, with fewer cases
than the available evidence, and namespaces requiring cleanup. It can also leave
private `.suite-*.tmp` files. Do not promote those files into `suite.json`; retain
the published snapshot and inspect the individual evidence and ledger files.
The suite does not automatically recover or clean up after an uncatchable stop.

Cancellation during cleanup takes precedence over an earlier execution error.
The runner still attempts cleanup for both created namespaces and records both
the original failure and cleanup cancellation in the DrillRun checks. Cleanup
is best-effort: an attempted deletion does not prove that the namespace was
removed. Check any cleanup failures before starting another suite.

Cancellation during case execution records `observedExitCode: 130`. If the
drill has already finished and cancellation occurs during policy evaluation,
its original observed exit (`0` or `1`) is preserved instead. In both cases,
the summary records `status: interrupted`, `passed: false` and a completion
timestamp. The unfinished case records `error: lab interrupted`; earlier
completed case results and artifacts are retained, and no later case starts.
Repeated cancellation during final evidence/checkpoint writing is not covered
by the final-status guarantee. The published summary remains a complete snapshot,
but other artifacts may be partial and the latest progress may not be published.

Verified on 2026-10-05 with three real two-cluster restores: drill exits 0/1/0,
lost writes 0/2/2, every measured RPO field matching the independent Go evaluator,
private artifact permissions and all six temporary namespaces removed.
The cancellation precedence and evaluation checkpoints above were verified
separately with command-boundary tests on 2026-10-05, including interruption
during each of the three cases. Those tests did not run against live clusters.
Atomic checkpoint publication was verified on 2026-10-07 with serialization,
file-sync, replacement and directory-sync failure tests, plus a bounded child
process killed with SIGKILL while writing its next snapshot. The preceding
published summary was retained byte-for-byte; no live clusters were involved.

### Manual CI suite gate

The **Isolated restore lab** GitHub Actions workflow is manual-only. A repository
operator can select **Run workflow** for an approved revision; ordinary pushes
do not start Kubernetes lab clusters. The job uses a disposable Ubuntu runner,
creates the two dedicated k3d clusters and runs:

```bash
nostekon lab suite --writes 10 --rpo-seconds 60 --output-dir lab-results/suite
```

The suite must exit `0` with its expected case exits `0/1/0`. The workflow then
evaluates all three original DrillRuns independently with the Go report binary,
retaining the zero-loss, strict-loss and budgeted-loss verdict checks. Its final
gate requires a completed, passed summary with the three ordered cases and
compares all eight RPO fields against those Go reports. Loss-window seconds
allow a difference of at most `0.000001`; counts, budget and `met` must agree
exactly. A missing case, unexpected exit or changed summary claim fails the job.

The retained artifact contains the summary, original case evidence and SQLite
ledgers under `lab-results/suite/`, plus the three independent reports under
`lab-results/`. Cleanup and artifact upload are attempted even after a failed
step. Retention remains seven days; interrupted jobs are not automatically
resumed, and cleanup is still best-effort.

Verified locally on 2026-10-07: workflow lint, all three Go report shell steps
against the unchanged recorded bundle, and summary-gate tests for every RPO
field, allowed timing tolerance, case order, exits and incomplete results.
Those checks do not establish that this revised manual lab job has run on
GitHub; a successful ordinary CI run is not a live-cluster lab result.

### Run the suite from Studio

This is an opt-in Linux host feature, not remote cluster management. Prepare the
two dedicated clusters and PostgreSQL image using this guide first. The host
needs the editable Python installation (`.[dev]`), `kubectl`, the lab kubeconfig,
Go 1.25 and a built Studio. Jobs always use the CLI's fixed local
`k3d-nostekon-source` and `k3d-nostekon-restore` contexts; the browser cannot choose
an executable, command, image, cluster context or filesystem path.

From the repository root, after installing the Python package and preparing the
lab:

```bash
npm ci --prefix studio
npm run build --prefix studio
NOSTEKON_ADDR=127.0.0.1:8181 \
  NOSTEKON_STUDIO_DIR="$PWD/studio/dist" \
  NOSTEKON_LAB_EXECUTABLE="$PWD/.venv/bin/nostekon" \
  NOSTEKON_LAB_DATA_DIR="$HOME/.local/share/nostekon/lab-jobs" \
  go run ./cmd/nostekon-api
```

Use an unused loopback port if `8181` is occupied. The executable path assumes
this guide's `.venv` installation; change it to the actual trusted CLI path.
The data directory is created with mode `0700`; an existing directory must be
private and must not be a symlink. Do not reuse another application's directory.
Open `http://127.0.0.1:8181/#/lab` and choose **Run suite**. Default settings are
10 writes and a 60-second tail-loss budget; input bounds remain 1..98 writes and
1..86400 seconds. This deletes source test namespaces after their backups, not
arbitrary workloads. Never point this feature at production clusters.

Only one job can run at a time. Persistent history admits at most 50 jobs without
silently evicting prior results. Checkpoints expose case-level progress; process
output is the latest 64 KiB, marked when truncated. Output can be buffered until
the CLI finishes. A job's `completed` status means its process exited zero,
not that captures are authenticated. **Review suite** evaluates original case
JSON through the existing Go report API; saved cases remain Imported evidence
and signature-unverified.

**Cancel job**, the 15-minute timeout and graceful server shutdown send SIGINT
to the entire job process group. After 30 seconds, remaining processes are
forcibly stopped. SIGKILL cannot guarantee namespace cleanup or the final
checkpoint. Inspect retained files and namespace cleanup checks before starting
another run. Each job has private, versioned `job.json` metadata beside its
`suite/` directory. Metadata is written before execution, on cancellation and
after completion using file sync, atomic rename and directory sync. Completed
metadata and the final log tail are reloaded on startup, newest first. Live log
output is not checkpointed continuously; a crash can lose that output tail.

### Recover lab history after restart

An unfinished `running` or `cancelling` record becomes **interrupted**, with
`recoveryRequired: true` and no invented exit code. Its completion timestamp
is the reconciliation time, not proof that the old process stopped then.
Original summary/evidence files remain unchanged. New jobs are blocked until
every interrupted record is acknowledged. No process is reattached, resumed
or signalled using a stored PID; a crashed API's descendants may still be running.

Before acknowledgement:

1. Stop any old lab suite process and its descendants using the operating
  system's process tools. Confirm the exact command and process identity;
  never terminate a process merely because its PID appears in old notes.
2. Inspect the dedicated source and restore contexts and cleanup checks.
  Identify only the test namespaces owned by the interrupted job. Remove
  retained test resources only after confirming ownership; do not delete
  namespaces by a broad wildcard or assume every prefix match is disposable.
3. Review the published summary and available original case JSON. Keep partial
  files for diagnosis; do not promote temporary checkpoint files or invent
  missing measurements.
4. In Studio, select the interrupted job, check **Old runner processes stopped
  and lab namespaces checked**, then choose **Confirm cleanup**. This stores
  the operator's acknowledgement, not an automated cleanup verification.

For an explicitly reviewed job, the equivalent local API request is:

```bash
JOB_ID='<24-character-job-id-from-Studio>'
curl --fail-with-body -X POST \
  -H 'Content-Type: application/json' -H 'X-Nostekon-Lab: true' \
  --data '{"cleanupConfirmed":true}' \
  "http://127.0.0.1:8181/api/v1/lab/jobs/$JOB_ID/acknowledge-recovery"
```

Use the actual configured loopback port. The checkbox starts unchecked; the
API rejects missing/false acknowledgement and unexpected fields. Persisting
the acknowledgement does not change the interrupted verdict into success.

The data directory has an exclusive Linux file lock. A second manager using
that same directory is rejected; do not remove `.manager.lock` while running.
Different data directories do not coordinate cluster access. Run only one
enabled API instance for these shared lab clusters, including direct CLI jobs.

Missing, corrupt, unsupported, oversized, public-readable or symlinked metadata
stops startup instead of silently discarding history. This includes old job
directories created before metadata persistence was added. Stop the server,
check processes/cleanup, preserve the entire affected directory in an archive
outside the live data root, then restart. Do not hand-edit records to declare
success. Unpublished private `.job-*.tmp` files are not authoritative metadata.

At the 50-job cap, stop the server and archive whole older job directories
outside the live root. Keep metadata, summary, case evidence and ledgers together.
Restarting alone does not reset the cap. There is no automatic resume,
cross-directory cluster lock or retention pruning. A metadata-write error is
visible in job details and blocks additional starts until storage is repaired
and the server restarted; already retained evidence remains separate.

Lab API routes are disabled without both opt-in variables. Enabled requests
require a loopback listener, loopback Host and peer, same-origin browser context
and `X-Nostekon-Lab: true`; foreign origins/hosts and cross-site requests are
rejected. These checks prevent browser-driven cross-origin execution, not access
by other local programs or OS users. This is a trusted single-operator tool,
not authentication or multi-user authorization. Do not enable it behind a public
proxy or mount host credentials/Docker sockets into the default app container.

Verified on 2026-10-07 with real subprocess command, cancellation and timeout
tests; request-origin/input boundary tests; and desktop/mobile browser tests
using controlled job responses plus actual Go evidence evaluation. The default
Docker app's disabled mode was also tested. No live Kubernetes job was launched
as part of this verification.

Persistent history was additionally verified on 2026-10-07: a real helper
process completes and survives manager recreation with matching metadata/logs
and original artifacts; unfinished-record fixtures require durable explicit
acknowledgement; concurrent directory ownership and malformed/missing metadata
are rejected. The browser recovery checkbox and blocked start were tested at
390px. These are not power-loss, remote-storage or live-cluster crash tests.

### Export and import evidence bundles

For a stopped host job, **Export bundle** downloads
`nostekon-lab-<job-id>.zip`. Export requires an idle lab and a completed process
record. Interrupted records require the cleanup acknowledgement above first;
this is still the operator's assertion, not automatic cleanup verification.
The export does not run a drill, alter outcomes, delete files or acknowledge
recovery. Individual JSON downloads remain available.

The local API equivalent is:

```bash
JOB_ID='<24-character-job-id-from-Studio>'
curl --fail-with-body -H 'X-Nostekon-Lab: true' \
  --output "nostekon-lab-${JOB_ID}.zip" \
  "http://127.0.0.1:8181/api/v1/lab/jobs/$JOB_ID/export"
```

Use the actual opt-in loopback port. Disabled execution returns `503`; an unknown
job returns `404`; active work or pending cleanup returns `409`. Unreadable,
symlinked, non-regular or oversized evidence fails export instead of silently
being labelled missing. Inspect the original directory before retrying; do not
delete evidence to make the error disappear.

The uncompressed ZIP contains `manifest.json` and only the available allowlisted
`suite.json` and three case DrillRuns. The manifest has
`apiVersion: nostekon/evidence-bundle/v1alpha1`, `kind: LabEvidenceBundle`, a
redacted job snapshot, each original file's byte size and lowercase SHA-256, and
an explicit `missingArtifacts` list. Original JSON bytes are not reformatted,
even if malformed. Malformed evidence still fails its later report evaluation.
Partial jobs can export partial bundles; a metadata-only bundle does not become
a successful suite. File permission hints are `0600`, but extraction tools may
ignore them; use a private destination.

In **Suite**, choose **Import bundle** and select the exported ZIP. The installed
app and static browser demo both support this action on HTTPS or localhost.
Before evaluation, Studio rejects unknown or duplicate filenames, compressed
entries, inconsistent manifests, invalid UTF-8, size violations and checksum
mismatches. Version one intentionally accepts only Nostekon's uncompressed ZIP
format; do not re-compress it with another archiver. Limits are 49 MiB per ZIP,
64 KiB for the manifest and summary, and 16 MiB per case. Every allowlisted name
must appear once as present or missing. A corrupt import clears the old review
and disables saving; correct the input and retry with the original export.

Imported cases use the existing evaluator and **Save cases** transaction. They
remain **Imported evidence · signatures unverified**. Checksums establish
agreement with the submitted manifest, not authenticity: someone can change
both evidence and manifest. No keys, signatures or trusted identity are added,
and no host job is restored from this import.

The ZIP intentionally excludes process output, storage-error text, arbitrary
files, SQLite ledgers and original `job.json`. JSON can itself contain sensitive
details; inspect it before sharing. This is a portable review package, **not a
full backup**. To free the 50-job cap, follow the offline whole-directory
archiving procedure above and retain metadata and ledgers together. A downloaded
ZIP is not a reason to discard the source evidence.

Verified on 2026-10-07: Go ZIP/API tests preserve original bytes and checksums,
reject unsafe/oversized artifacts, enforce idle/recovery/origin guards and list
partial evidence. Studio tests cover manifest/size/hash/UTF-8/duplicate/entry
validation. Installed desktop/mobile workflows check download, import, actual
Go evaluation, saving and reload; corruption is rejected before evaluation.
Browser job responses are controlled fixtures, not a new live Kubernetes drill.

### Gate a captured suite in CI

Use the Go report command from this checkout to gate an existing suite directory
or exported ZIP. This evaluates captured JSON only: no Python, Docker, kubectl,
credentials, cluster access or running lab server is needed. Go 1.25 is required
to build the command. Build a binary for CI exit-code handling; `go run` wraps
nonzero program exits and does not preserve the distinction between `1` and `2`.

```bash
umask 077
REPORT_DIR=$(mktemp -d)
go build -o "$REPORT_DIR/nostekon-report" ./cmd/nostekon-report
"$REPORT_DIR/nostekon-report" --suite examples/suites/postgresql-policy \
  > /tmp/nostekon-suite-review.json
```

For your capture, replace the input directory with its path or the exported
`nostekon-lab-<job-id>.zip`. Use a private, unique report destination; the shell
redirection replaces an existing file. The directory reader only reads the
summary and three known case filenames. It rejects symlinked/non-regular and
oversized artifacts, ignoring unrelated directory files. ZIP input uses the
Store-only format, size/name/accounting/UTF-8/hash limits described above, without
extracting anything to disk. Missing declared case evidence remains a finding.

| Exit | Meaning |
|---|---|
| `0` | Complete passing runner summary; all three independently evaluated policy outcomes and measurements agree |
| `1` | A valid review was written, but the suite gate failed, including partial or missing case evidence |
| `2` | Usage, input, archive integrity, summary validation or output-write error; no successful review is available |

Let a nonzero exit fail the CI step. Do not use `|| true` or accept a report
because its filename exists: redirection can leave an empty file after an input
error. The existing single-DrillRun command is unchanged. Suite mode rejects
single-run attestation and Pushgateway options rather than implying verification
or inventing an aggregate metrics instance.

The gate checks ordered cases, expected exits `0, 1, 0`, V4 evaluation and all
eight RPO fields, with a `0.000001` second comparison tolerance. Expected lost
counts are `0, 2, 2`, without holes or unexpected writes. The strict-tail case
must reach V3, fail at V4 against a zero RPO budget and not also miss its RTO or
fail an unrelated reported check. The runner's canonical zero-budget ledger-loss
check is allowed alongside the generated ledger failure. An arbitrary failed
verdict is not sufficient. Partial captures can agree with their summary but
never pass the complete-suite gate.

The output has `apiVersion: nostekon/suite-review/v1alpha1`, `kind: SuiteReview`,
`passed`, `complete`, `runnerStatus`, `runnerPassed`, `evidenceMatches`,
`summarySHA256`, unverified `provenance`, and ordered `cases`. Each case contains
its expected/observed/evaluated exit codes, `evidenceSHA256`, evaluated `report`
and `issues`; unavailable evidence/report fields are `null`. It does not embed
raw source JSON, process logs or SQLite ledgers. Reports can still contain
sensitive identifiers and findings; inspect them before sharing.

In Studio, **Suite gate** is separate from **Runner result** and evidence
agreement. **Export review** downloads `suite-review.json` for passing or failing
reviews; invalid imports clear the review and disable export. The installed app
and HTTPS/localhost browser demo use the same contract and retain signature-
unverified provenance. A digest binds the report to submitted bytes, not to a
trusted operator, execution history or actual restore. Keep the original inputs;
a review is not an evidence bundle or host-history backup.

The manual lab workflow retains its existing case checks and additionally writes
`lab-results/suite-review.json` after successful or failed captures. Cleanup and
artifact upload remain always-on; missing/invalid summaries fail closed rather
than fabricating a passing review. No workflow dispatch is required to use the
command locally.

Verified on 2026-10-07 against original recorded evidence and mutated local
fixtures: directory/ZIP reports agree; incomplete, tampered, unsafe and unrelated
failure inputs are rejected. Desktop/mobile review downloads match the real Go
CLI, including static WASM evaluation. The actual workflow shell step was tested
with passing/partial/missing inputs, without Kubernetes. This verification does
not claim a new live drill, hosted workflow result or authenticated capture.

### Review a suite in Studio

Open [Policy suite](/demo/index.html#/suite) to review the recorded three-case
PostgreSQL bundle. The original capture is stored unchanged under
`examples/suites/postgresql-policy/`.

To review your own completed run, choose **Import suite** and select these four
JSON files together from the suite output directory:

- `suite.json`
- `zero-loss.drillrun.json`
- `tail-loss.drillrun.json`
- `budget-loss.drillrun.json`

Failed or interrupted suites may have fewer cases and evidence files. Select
the summary and available JSON evidence; missing files remain visible as review
findings. SQLite ledgers are not imported. Imports are limited to four files,
a 64 KiB summary and 16 MiB per DrillRun.

Studio evaluates each DrillRun with the Go report engine and compares its exit
code and eight RPO fields with the summary. The view separates the runner's
suite result, each expected verdict and its independently evaluated verdict.
A strict tail-loss case can therefore show **Failed** while agreeing with the
suite's expected outcome. Each case opens in the existing report view for
inspection, original-evidence export and saving to the local run library. The
summary download preserves its original bytes.

Choose **Save cases** to save every captured case to **Runs** in one action.
Every case must have available evidence and an evaluated report; a **Failed**
verdict is still a valid report and can be saved. Summary mismatches remain
review findings and do not prevent saving otherwise valid case evidence.
Saving does not change the summary's runner result or agreement status.

The save is all-or-nothing. If the 50-run library has insufficient space or
browser storage fails, no cases are added and existing runs are unchanged.
Delete unneeded runs or resolve storage availability, then retry. Identical
original evidence is deduplicated, so repeated saves do not add extra copies.
Saved cases survive reload on the same browser origin. All cases saved this
way are labelled **Imported evidence**, including the built-in bundle; saving
does not add trusted provenance or verify signatures.

**Save cases** stores individual DrillRuns. **Save suite** preserves the original
summary and available case JSON together in a separate, 20-suite browser library.
Open **Saved suites** to reopen a snapshot, download its original files or delete
it. Reopening verifies the snapshot's content hash and evaluates the evidence
again; a saved snapshot is not a cached passing review. Interrupted and failed
captures can be retained, and their missing evidence is not filled in.

The saved timestamp is the browser's last successful save time, not the capture
time or a trusted attestation. Sort by **Newest saved** or **Oldest saved**;
equal timestamps use the snapshot identity as a deterministic tie-breaker.
Search matches all entered terms against the suite identity, runner status,
case names and original filenames, without searching inside evidence content.
The runner-status and capture filters combine with search. **Clear suite
filters** resets those filters without changing the selected sort order.

**Full captures** have all three cases declared in the summary and every
declared case's original file present. **Partial captures** include shorter
summaries and snapshots with a missing declared file. This is file coverage,
not evidence agreement, authenticity or a passing suite gate. A full capture
with runner status `failed` is still a failed runner claim; reopen the suite
for a fresh independent gate result.

Use **Inspect suite originals** to see the full snapshot identity, each original
file's UTF-8 byte size and SHA-256, and absent policy-case files. Inspection
first verifies the snapshot's identity against its stored originals. A failed
integrity check blocks the inventory without deleting or repairing evidence;
retain your original download and resolve the damaged browser copy explicitly.
Matching checksums establish byte integrity, not capture authenticity or trusted
operator identity. Close the inventory with its close control or Escape.

Identical filenames and exact sources are deduplicated regardless of import
order. At the 20-suite limit, an existing snapshot can still be saved again;
new snapshots require an explicit deletion. No suite is silently evicted.
Storage failure leaves existing snapshots and individual Runs unchanged.
The version-two database upgrade preserves saved Runs and the completed legacy
migration. Snapshots remain **Imported evidence**, with unverified signatures.

The download is a ZIP of the original JSON files, not a host-job evidence bundle:
it has no invented job ID or manifest. Extract it and select the JSON files with
**Import suite**, or point `nostekon-report --suite` at the extracted directory.
**Import bundle** remains reserved for manifest-verified host-job exports.
Deleting a snapshot does not delete case Runs, and deleting a Run does not alter
a snapshot. Clearing browser site data removes both libraries. These libraries
are scoped to the browser origin; changing the app's port creates a different
workspace. Retain original downloads outside the browser for durable backup.

**Evidence matches the summary** means the submitted claims agree with the
evaluated JSON evidence. It does not authenticate the capture, inspect the
SQLite ledger, reproduce every runner acceptance check, verify signatures or
prove that a restore actually happened. Imported bundles remain labelled
**Imported evidence**; the built-in bundle is **Recorded local lab**. Both
remain signature-unverified. Verify an individual original case and its sidecar
with the [Studio or CLI attestation workflow](../reference/drillrun-evidence.md#verify-in-studio-or-the-browser-demo).
That does not sign or authenticate the suite summary, gate or bundle manifest.

Verified on 2026-10-05 in the browser demo at 390px and 1440px: all three
recorded outcomes, changed-summary detection, missing/invalid imports and
original-byte downloads. Suite-case saving, reload persistence, deduplication
and simulated storage-failure rollback/retry were checked in the browser.
Library-limit rollback and concurrent saves were checked with IndexedDB tests.
Suite snapshots were verified on 2026-10-08 in the installed app at 390px and
1440px: exact-file downloads, reload and deduplication, fresh re-evaluation,
partial captures, damaged-snapshot rejection, independent deletion and keyboard
tabs. Version-one upgrades, quota rollback and concurrent final-slot saves
were verified with IndexedDB tests.

Saved-suite sorting, combined search/status/capture filters, empty results,
exact-original inventory hashes and byte sizes, missing-file labels, keyboard
dismissal and damaged-inventory rejection were verified on 2026-10-15 in both
the browser/WASM demo and installed Go app at 390px and 1440px. Light/dark
inventory and control layouts were checked. IndexedDB tests include an
independent three-byte UTF-8 hash oracle and preservation of damaged snapshots.

### Ledger And Measurement Limits

`--writes` defaults to one and must be positive; `--after-backup-writes`
defaults to zero and must be nonnegative. Together they are capped at 100.
`--rpo-seconds` defaults to `0` and accepts whole seconds from `0` to `86400`.
The declared budget is included in `spec.objectives.rpo`; it is not inferred
from the observed loss after the restore.
The runner records an acknowledgement only after `psql` returns success, then
commits it to the host-side SQLite ledger. The timestamp is when the host
observed success, not the database's internal commit time.

The `<output>.ledger.db` sidecar has private file permissions and must not
already exist, just like the evidence output. Keep it outside both clusters
and retain it with the evidence. If execution stops before restored IDs are
queried and validated, the sidecar retains completed acknowledgements, but the DrillRun
omits ledger measurements rather than claiming all writes were lost. A V3
row-count failure still emits V3-only evidence.

This measures loss for a bounded, sequential PostgreSQL test workload. It is
not application-level acknowledgement instrumentation, a business invariant,
PITR/WAL validation or authenticated provenance. The bundled historical V3
sample remains unchanged.

## 6. Teardown

To delete the test clusters when done:

```bash
make lab-down
```
