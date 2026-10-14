# Nostekon

**Don't assume you can recover. Prove it, every day.**

[![CI](https://github.com/jagarkarlo/nostekon/actions/workflows/ci.yml/badge.svg)](https://github.com/jagarkarlo/nostekon/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Nostekon verifies recovery evidence and runs a narrow, disposable PostgreSQL
logical-restore drill across two separate k3d clusters. It measures recovery
phases and acknowledged-write loss, then checks them against explicit policy.
Whole-application recovery of GitOps state, CloudNativePG point-in-time backups,
volumes, Secrets and object storage is planned, not implemented.

> *Nostekon* (pronounced nos-TEK-on) is coined from the Greek *nóstos*
> (return, homecoming) and *tekmḗrion* (conclusive proof). A finished backup
> suggests recovery might work. A verified restore proves it.

> [!NOTE]
> **Status: pre-alpha.** Nostekon is being built as a master's thesis project
> (2026-2027). Interfaces will change without notice. The project was called
> Checkride until October 2026: evidence, drills and signatures recorded with
> `checkride/v1alpha1` versions still verify, but `checkride_*` metrics and the
> `checkride` command were renamed.

Current packages, commands, clusters, metrics and branding use Nostekon. Legacy
wire identifiers and captured evidence retain their original names so their
bytes and signatures remain valid. Studio imports saved browser runs once into
`nostekon-runs`, without changing evidence bytes; its old database is retained
as a backup. Storage migration is limited to the same browser origin.

The Nostekon name and stepping-stones logo use TM to state a trademark claim,
not registration or legal clearance. The code remains Apache-2.0; section 6 of
the license keeps general trademark rights separate.

## Why

Backup tools report `Completed`. That proves a backup was written, not that
your application can be restored from it.

- CloudNativePG documents an RPO of at most five minutes with WAL archiving and
  asks users to "regularly test restoring from your backups" and "measure the
  time required for a full recovery".
- EU DORA Article 12 requires periodic restore testing, restoration onto
  segregated systems, and reconciliation checks so data stays consistent
  between systems.
- Most restore tests stop at "the pods are healthy" or "the tables have rows".
  Neither proves that acknowledged writes survived.

## Verification levels

| Level | Question | Evidence |
|---|---|---|
| V0 | Did the backup report success? | Backup tool status |
| V1 | Did the restore report success? | Restore tool status |
| V2 | Is the workload healthy? | Pods ready, HTTP and TCP checks |
| V3 | Is the data structurally intact? | Tables, row counts, checksums |
| V4 | Is the data correct? | Business invariants, acknowledged-write ledger, cross-store consistency |

Every drill reports the deepest level it passed and the first level that
caught a failure.

## How it works

```mermaid
flowchart LR
    Spec[Drill spec] --> Orchestrator
    Orchestrator --> Source[Source cluster]
    Source -- acknowledged writes --> Ledger[(Write ledger)]
    Source --> Backup[CloudNativePG + Velero backups]
    Orchestrator --> Fault[Fault injection]
    Backup --> Restore[Separate restore cluster]
    Restore --> Verifier[Verifier V0-V4]
    Ledger --> Verifier
    Verifier --> Report[RTO phases, exact RPO, evidence]
    Report --> Studio[Studio UI]
    Report --> Gate[CI gate]
```

## Components

| Component | Purpose | State |
|---|---|---|
| Drill spec | Declarative YAML description of a drill | Validation in Python, Go API and Studio |
| Ledger | Records acknowledged writes outside the cluster and computes exact RPO | Python ledger; Go report evaluation |
| DrillRun | Bounded JSON evidence document with a published JSON Schema | Available; local API can verify detached signatures when a trusted-key directory is configured |
| Verifier | Evaluates recorded V0-V4 checks, RTO phases and RPO ledger | Available for submitted evidence; no restore execution |
| API | Go HTTP control plane, validation, schema and report endpoints | Available locally; optional server-configured Ed25519 verification |
| Report CLI | Evaluates DrillRun files and returns gate-friendly exit codes | Available as `go run ./cmd/nostekon-report` |
| Attestation CLI | Signs exact DrillRun bytes and verifies detached signatures against trusted keys | Available as `go run ./cmd/nostekon-attest` |
| Metrics | Pushes per-drill gauges to a Prometheus Pushgateway, with a bundled Grafana dashboard | Available via `nostekon-report --pushgateway-url` |
| Lab | Disposable k3d source and restore clusters | Available; bounded PostgreSQL workload and V4 ledger checks |
| Lab jobs | Starts the fixed PostgreSQL policy suite, exposes checkpoints/output and supports cancellation | Available as a Linux host opt-in; one active job |
| Orchestrator | Executes general application recovery scenarios | Planned |
| Analyzer | Predicts restore failures before a drill from manifests and configuration | Planned |
| Studio | Drill specification workbench and evidence report UI with JSON/Markdown export | Available locally |
| Copilot | LLM that diagnoses failed drills and proposes fixes that must pass a re-run | Planned |
| Gate | CI recovery checks | Manual lab regression gate available; general freshness and deployment policy planned |

## Run the app

The installable app serves Studio and the Go verification API from one process.
It can review recorded or imported evidence, compare policy suites, save runs
in your browser, and export original evidence and reports. The default container
cannot launch restore jobs. A separate Linux host opt-in enables the fixed lab
suite; shared server-side run history is not implemented.

From this checkout, with Docker and Docker Compose available:

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:8080`. To use another port:

```bash
NOSTEKON_PORT=8180 docker compose up --build -d
```

The container runs as a non-root user with a read-only filesystem, no added
capabilities, and a localhost-only published port. It needs no Python, Node,
Go, kubeconfig or cloud credentials at runtime. Use `docker compose down` to
stop it. No public image or renamed app release is published by these commands.

Saved runs live in this browser's IndexedDB, not the container. They survive
container restarts, but a different host, port or browser has a separate
library. Clearing browser storage deletes them; export evidence before doing
so. The app has no authentication. Do not expose it on a public network; an
authenticated TLS gateway is required before a shared deployment.

If your network intercepts registry TLS, pass its trusted CA bundle as a
build-only secret rather than disabling certificate verification:

```bash
DOCKER_BUILDKIT=1 docker build --network host \
  --secret id=npm_ca,src=/etc/ssl/certs/ca-certificates.crt \
  -t nostekon:local .
docker compose up -d --no-build
```

Replace the CA bundle path for your workstation. The secret is not copied
into the final image; ordinary networks do not need this option.

### Without Docker

Build Studio once and serve it with the API:

```bash
npm ci --prefix studio
npm run build --prefix studio
NOSTEKON_ADDR=127.0.0.1:8080 NOSTEKON_STUDIO_DIR=./studio/dist go run ./cmd/nostekon-api
```

Build portable archives locally, or obtain the Linux artifact from a successful
Studio CI job. No renamed Nostekon tag release is published yet:

```bash
NOSTEKON_VERSION=dev NOSTEKON_APP_TARGETS=linux/amd64 bash scripts/build-app.sh
cd dist/app
sha256sum --check SHA256SUMS
mkdir nostekon-local
tar -xzf nostekon-app_linux_amd64.tar.gz -C nostekon-local
./nostekon-local/start-nostekon.sh
```

Studio is discovered beside the executable, independent of working directory;
default listener is `127.0.0.1:8080`. `--addr` selects a port, `--studio-dir`
overrides the UI root, `--api-only` disables Studio and `--version` identifies
the build without starting. Windows ZIPs include `Start-Nostekon.cmd`; Unix
archives include `start-nostekon.sh`. Six OS/architecture targets are supported.
Invalid Studio directories fail startup. See
[portable installation and browser backup](site/src/content/docs/guides/portable-app.md)
for checksums, platform caveats and migration. The UI stays in your browser,
but the app runs locally without a hosted site or language runtimes.
Public-key signature verification still uses `NOSTEKON_TRUSTED_KEYS_DIR`;
container installations must mount only trusted public keys read-only.

### Enable local lab jobs

On a Linux workstation with the dedicated k3d lab prepared, Studio can launch
the existing three-case policy suite, show case checkpoints and process output,
cancel a job, download its JSON evidence and open it in Suite review. Execution
must be explicitly enabled with a CLI executable and private data directory;
the listener must be loopback-only. The default container remains disabled and
does not receive kubeconfig, a Docker socket or cluster permissions.

See [the lab job runbook](site/src/content/docs/guides/k3d-isolated-restore.md#run-the-suite-from-studio)
for prerequisites, the exact launch command, request safeguards and interruption
limits. Private job metadata and terminal log tails survive restart and are
reloaded automatically. Unfinished records become interrupted and block new
jobs until the operator explicitly confirms process and namespace cleanup.
Automatic resume and retention pruning are not implemented.

Verified locally on 2026-10-07: the actual image served Studio and its HTTP API;
desktop and mobile browser tests reviewed all three policy cases, saved them,
reloaded Runs and opened the strict-loss report. The historical `v0.1.0` tag
predates the rename and is not an installable Nostekon app release.

## Quick start (development)

```bash
git clone https://github.com/jagarkarlo/nostekon.git
cd nostekon
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

nostekon levels
nostekon validate examples/drills/*.yaml
pytest
```

For release preparation and PyPI trusted-publisher settings, see
[Contributing](CONTRIBUTING.md#releases).

The Go API is in early development. From the repository root:

```bash
go test -race ./...
go run ./cmd/nostekon-api
```

It listens on `:8080` by default. Set `NOSTEKON_ADDR` to change the address;
`GET /healthz` and `GET /readyz` return `204 No Content` while the process is
healthy. Readiness will become dependency-aware as the API gains external
services.

The first Studio-facing endpoint validates a JSON drill document:

```bash
curl -sS http://localhost:8080/api/v1/drills/validate \
  -H 'Content-Type: application/json' \
  --data-binary @drill.json
```

It returns `200` with `valid`, `errors` and `warnings` for valid documents,
`422` for well-formed but invalid drills, `400` for malformed or unknown JSON,
`413` for bodies over 1 MiB, and `415` for other media types. The API currently
validates the core drill contract; it does not create or execute a drill.

Recorded evidence can be evaluated through `POST /api/v1/runs/report` or the
standalone Go command:

```bash
go run ./cmd/nostekon-report examples/runs/mlflow-namespace-loss.run.json
```

The API accepts up to 16 MiB and evaluates at most four reports concurrently.
`GET /api/v1/schemas/drillrun` returns the versioned JSON Schema. The command
prints a JSON report and exits `0` for verified, `1` for failed, and `2` for
incomplete or invalid evidence. The original MLflow and CRUD example runs are synthetic; the four k3d PostgreSQL examples are locally captured lab runs. The evaluator
checks submitted claims; it does not execute restores or authenticate who
recorded the evidence. `V4` requires a write ledger or a declared invariant
with a matching check; ledger loss must also meet any declared RPO objective.

### Sign and verify evidence

An operator can create a detached Ed25519 signature over the exact DrillRun
file bytes. The public key must be distributed and trusted independently:

```bash
install -d -m 700 "$HOME/.config/nostekon/signing" "$HOME/.config/nostekon/trusted-keys"
go run ./cmd/nostekon-attest keygen --private "$HOME/.config/nostekon/signing/signing-key.pem" --public "$HOME/.config/nostekon/trusted-keys/operator.pem"
go run ./cmd/nostekon-attest sign --evidence /tmp/nostekon-drill.json --key "$HOME/.config/nostekon/signing/signing-key.pem" --output /tmp/nostekon-drill.attestation.json
go run ./cmd/nostekon-attest verify --evidence /tmp/nostekon-drill.json --attestation /tmp/nostekon-drill.attestation.json --trusted-key "$HOME/.config/nostekon/trusted-keys/operator.pem"
go run ./cmd/nostekon-report --attestation /tmp/nostekon-drill.attestation.json --trusted-key "$HOME/.config/nostekon/trusted-keys/operator.pem" /tmp/nostekon-drill.json
```

Keep the private key outside the repository and distribute the public key
through a trusted channel. Key generation refuses to overwrite files, and
signing refuses private keys accessible to group or other users on Unix-like
systems. On Windows, restrict the key with filesystem ACLs. Verification
checks the evidence-byte digest, key fingerprint and signature. This proves
that the exact file was signed by the holder of the trusted key; it does not
prove that the runner was truthful, identify a person without an independently
maintained key-to-identity mapping, or establish when the signature was made.
By default, `nostekon-report` marks evidence as `unverified`; with both
`--attestation` and `--trusted-key`, it verifies the signature and includes the
provenance status, key ID and evidence digest in its JSON report. Invalid
attestations fail report generation.

To verify signatures in the local API and local Studio, configure a **public-
keys-only** trust directory before starting the API:

```bash
NOSTEKON_TRUSTED_KEYS_DIR="$HOME/.config/nostekon/trusted-keys" go run ./cmd/nostekon-api
```

Every `*.pem` file in that directory must be a PKIX Ed25519 public key. The API
loads at most 128 keys at startup and refuses to start if the configured
directory is empty or contains an invalid key. The Studio's **Attach
attestation** control sends the sidecar to this API; an unsigned request remains
`unverified`, and a signature from an unknown key is rejected. The static
browser demo cannot verify signatures because it has no server-side trust
store; it warns instead of claiming verification. Never put private keys in
the trusted-keys directory.

For a direct API request, base64-encode the detached sidecar into the
`X-Nostekon-Attestation` header. The server verifies the signature against its
configured keys and returns the verified key ID and evidence digest in the
report. An unknown key or changed evidence is rejected; sending a signature to
an API with no configured trust store returns `503`.

```bash
sidecar=$(base64 < /tmp/nostekon-drill.attestation.json | tr -d '\n')
curl -sS http://localhost:8080/api/v1/runs/report \
  -H 'Content-Type: application/json' \
  -H "X-Nostekon-Attestation: $sidecar" \
  --data-binary @/tmp/nostekon-drill.json
```

### Push recovery metrics to Grafana

`nostekon-report` can push one gauge per drill to a Prometheus Pushgateway,
so results land in the same dashboards as the rest of your stack instead of
only a CI log:

```bash
go run ./cmd/nostekon-report --pushgateway-url http://pushgateway:9091 /tmp/nostekon-drill.json
```

The instance label defaults to the evidence's `metadata.name`; set
`--pushgateway-instance` explicitly in a scheduled job so every run keeps its
own series instead of overwriting the last one. A push failure is printed as
a warning and does not change the exit code. Import
[`grafana/nostekon-recovery-dashboard.json`](grafana/nostekon-recovery-dashboard.json)
for a ready dashboard, or read the
[full guide](site/src/content/docs/guides/metrics-and-dashboard.md).

To use the Studio locally, start the API and Studio in separate terminals:

```bash
go run ./cmd/nostekon-api
cd studio && npm ci && npm run dev
```

Open `http://127.0.0.1:5173`. The development server proxies `/api` and
`/healthz` requests to the Go API on port 8080. The **Design drill** view
starts from a scenario template or imported JSON; the plan and V0-V4 depth
update as you edit. Syntax errors show their line, and selecting a validation
problem jumps to its field. `Ctrl+Enter` validates. The **Evidence report**
view imports a DrillRun, plots recovery phases and ledger outcomes, and exports
JSON or Markdown. Run Studio tests with `npm test`.

The **Suite** view reviews all three PostgreSQL policy cases together. It
evaluates original DrillRuns against the runner summary, separates expected
failure from unexpected mismatch, and opens individual reports. Try the
recorded bundle in `examples/suites/postgresql-policy/`, or import a suite
summary and its available DrillRun JSON files. Agreement is not authenticated
provenance; see the [suite review guide](site/src/content/docs/guides/k3d-isolated-restore.md#review-a-suite-in-studio).

Completed host jobs also offer **Export bundle**: one portable ZIP containing
available original JSON and a versioned SHA-256 manifest. **Import bundle** in
Suite validates the archive before reviewing it in either the installed app or
browser demo. Active jobs and interrupted jobs awaiting cleanup confirmation
cannot be exported. Checksums are not signatures, and missing evidence remains
missing. Bundles exclude process logs and SQLite ledgers; keep whole job
directories for full history archiving. See the
[bundle guide](site/src/content/docs/guides/k3d-isolated-restore.md#export-and-import-evidence-bundles)
for limits and safe transfer.

Captured suites can now be gated without Kubernetes using
`nostekon-report --suite <suite-directory-or-evidence.zip>`. The command
independently evaluates all cases and emits a versioned review with source
digests, findings and a conservative gate result. Studio's **Export review**
produces the same report contract. Partial agreement is not a passing suite,
and an unrelated failure cannot substitute for the intentional strict-tail
loss. See the [CI suite gate](site/src/content/docs/guides/k3d-isolated-restore.md#gate-a-captured-suite-in-ci)
for exit codes, build commands and trust limits.

To run the disposable isolated PostgreSQL source-loss drill, install Docker,
k3d, kubectl, Python 3.12+ and Go, then use only the dedicated lab contexts:

```bash
make lab-up
python3 scripts/lab/restore.py --writes 10 --output /tmp/nostekon-drill.json
go run ./cmd/nostekon-report /tmp/nostekon-drill.json
make lab-down
```

The runner checks that the two clusters differ, records successful PostgreSQL
writes in a private host-side SQLite ledger, dumps the data, deletes the source
namespace and restores in the other cluster. V3 checks the backed-up row count;
V4 compares recovered IDs with every acknowledgement and requires zero loss by default.
The Go report now measures RPO from this bounded workload. Add
`--after-backup-writes 2` to demonstrate two acknowledged writes lost from the
older dump; the drill and report should both exit `1`. Total writes are capped
at 100, and the default remains one backed-up write with no tail. Each evidence
file has a non-overwriting `<output>.ledger.db` sidecar.

To permit a bounded tail-loss window, set `--rpo-seconds 60` before running the
drill (whole seconds, `0` to `86400`). The budget is recorded in the evidence.
A verified run may still lose writes within that objective; holes and unexpected
IDs always fail. Studio includes three real V4 captures for zero loss, exceeded
RPO and loss within a 60-second budget. Their original bytes are retained in
`examples/runs/k3d-ledger-*.run.json`; the historical V3 sample remains unchanged.
See the [lab runbook](site/src/content/docs/guides/k3d-isolated-restore.md)
for the tested commands and exact captured measurements.

These are host-observed PostgreSQL acknowledgements, not application-specific
business validation or authenticated provenance. The runner attempts cleanup
even on failure; check for leftover `nostekon-*` namespaces if cleanup reports
an error. The [lab walkthrough](site/src/content/docs/start.md) covers
prerequisites and proxy-restricted image pulls. This is not production-safe
orchestration.

The Astro product site connects the full browser Studio with MkDocs Material
documentation under `/docs/`. Install Python 3.12+, Node 22+ and Go, then build
the demo and documentation before starting the site:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[docs]"
npm ci --prefix studio
npm ci --prefix site
npm run build --prefix site
npm run dev --prefix site
```

Open `http://127.0.0.1:4321`. Rebuild docs after Markdown changes with
`bash scripts/build-docs.sh`; `mkdocs build --strict` checks navigation and
internal Markdown links. The demo at `/demo/` evaluates reports in the browser;
the standalone Studio can also connect to the local Go API. Nostekon is
pre-alpha and only executes the narrow disposable lab drill. A paid enterprise
edition is not planned until the open-source restore workflow works reliably
end to end and operators validate a concrete need for supported deployments,
policy controls, or fleet-wide reporting.

## Rehearse a real backup

The host CLI can test an approved PostgreSQL custom-format backup without
connecting to production. It restores into a disposable local Docker target with
no network, no writable host mount and bounded resources. Linux, the Python CLI,
local Docker and a cached trusted `postgres:16.8` image are required:

```bash
nostekon backup plan --file /approved/backups/orders.dump \
  --output plans/orders-plan.json --expect-table public.orders=1250
python -m json.tool plans/orders-plan.json
nostekon backup preflight --file /approved/backups/orders.dump \
  --plan plans/orders-plan.json
nostekon backup restore --file /approved/backups/orders.dump \
  --plan plans/orders-plan.json --output evidence/orders-rehearsal.run.json
```

Planning runs no restore: it binds the backup checksum/size, cached immutable
image, expectations and timeout. Review the plan first; execution rejects changed
backups and setting overrides. Plans are not signed approvals or proof of identity.
Use an expected count from the same snapshot. Input is bounded to 64 MiB;
database storage to 512 MiB. Requested depth is V2 without counts or V3 with them.

`backup preflight` checks bound bytes, declared counts and local daemon/pinned-image
metadata without starting a target. Stop on any nonzero exit. A pass is not approval,
archive validity, available capacity or restore evidence; obtain owner approval and
use a dedicated host before executing. The guide includes a first-pilot checklist.

Add `--validation-profile ./profiles/orders-profile.json` during planning for V4:
strict, bound null/uniqueness/reference rules evaluated with generated read-only
queries. At least one snapshot-specific count is required; passing proves only
selected rules, not complete business correctness. Full scopes and measured
violations remain visible in Studio and its Markdown export.
Reusable [orders](examples/validation-profiles/orders.json) and
[inventory](examples/validation-profiles/inventory.json) starters include explicit
mandatory references and parent-key checks. Synthetic real-Docker regressions
prove equal row counts cannot hide the covered semantic corruption. Adapt these
examples with the backup owner; they are not approved business contracts.

Studio's **Profiles** workspace now authors these contracts directly: choose a
starter or empty draft, edit/reorder up to 20 rules, inspect required tables and
coverage warnings, and import/export exact originals. A local draft survives
reload, but validation is recomputed by the shared native/WASM Go engine.
Downloads require fresh valid structure, not a cached or measured-data verdict.
Inspect the same file offline, without Docker or database access:

```bash
go run ./cmd/nostekon-report --validation-profile examples/validation-profiles/orders.json
```

Exit `0` means structurally valid, including any warnings; `2` means invalid input,
mode conflict or output failure. Data, snapshot counts and owner approval remain
unverified. See the [profile authoring guide](site/src/content/docs/guides/postgresql-backup-rehearsal.md#author-and-inspect-profiles)
for exact-file handling, draft limits and the shared HTTP contract.

Each attempt keeps a private locked `OUTPUT.json.recovery` checkpoint. After a
hard stop or failed cleanup, inspect it without mutation:

```bash
nostekon backup recover --directory evidence/orders-rehearsal.run.json.recovery
# Only after the runner has stopped and pending Docker creation has settled:
nostekon backup recover --directory evidence/orders-rehearsal.run.json.recovery --confirm-cleanup
```

Confirmed cleanup verifies exact target ownership and removes only that container
and its private snapshot. It preserves source/evidence, refuses active or
unverifiable attempts, and never resumes a restore or fills an empty report.
Actual SIGKILL at create/start boundaries and repeated cleanup are tested locally;
host power loss and staging deployment recovery are not established by those tests.
Import the recorded JSON into Studio or evaluate it with `nostekon-report`.
Gate a planned capture independently, without Docker or a production connection:

```bash
go build -o /tmp/nostekon-report ./cmd/nostekon-report
/tmp/nostekon-report --backup-plan plans/orders-plan.json evidence/orders-rehearsal.run.json
```

Studio's **Plan review** tab uses the same independent Go gate in the browser or
installed app. Attach the original plan, inspect completeness/binding separately
from pass/fail, and export/import an exact-original plan/run/review ZIP. Imports
verify integrity and calculate a fresh unverified review; cached verdicts never
grant trust. Explicitly saving a run preserves its original attached plan across
reloads and original-only history backup/restore; reopening reviews it afresh.
Native offline portability is also available:

```bash
umask 077
set -o noclobber
/tmp/nostekon-report --backup-plan plans/orders-plan.json --export-backup-bundle \
  evidence/orders-rehearsal.run.json > evidence/orders.backup-review.zip
/tmp/nostekon-report --backup-bundle evidence/orders.backup-review.zip
```

ZIP export retains gate exits (`0` pass, `1` valid failed/incomplete capture with
a valid ZIP, `2` admission/write error). Discard any partial redirected output
after an error. The bounded four-entry bundle contains no backup dump or recovery
checkpoint; checksums are not authentication. See the guide below for limits.

The gate checks the canonical plan binding, archive/image identities, selected
counts and semantic scopes/measurements, required cleanup and recorded pass flags.
It returns JSON plus exit `0` for a passing gate, `1` for a failed/incomplete or
mismatched review, and `2` for invalid input/output. Original-byte hashes are
included; consistency is not authenticated capture or operator approval. A
matching failed rehearsal stays failed. CI retains original synthetic plan/run/
review JSON, never backup dumps or recovery copies.
Timing is rehearsal duration, not incident RTO; RPO remains unmeasured without a
ledger. Direct production access, application readiness and in-place restoration
are not provided. See the
[backup rehearsal runbook and production gates](site/src/content/docs/guides/postgresql-backup-rehearsal.md).

## Related projects

Nostekon builds on these tools and is evaluated against them:

- [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg) with the
  [Barman Cloud plugin](https://github.com/cloudnative-pg/plugin-barman-cloud)
  and [Velero](https://github.com/velero-io/velero) create the backups that
  Nostekon restores.
- [Kymaros](https://github.com/kymaroshq/kymaros) restores Velero backups into
  sandbox namespaces and checks workload health (V2).
- [Databasus](https://github.com/databasus/databasus) restores PostgreSQL
  backups into a container and reports row counts per table (V3).
- [KubeStash](https://github.com/kubestash) offers a `BackupVerifier` that
  restores and runs queries for KubeDB-managed databases.
- [AWS Backup restore testing](https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html)
  schedules test restores for AWS services; Kubernetes is not covered.

## Roadmap

| Milestone | Exit criteria |
|---|---|
| M0 Pilot |  Timed namespace-loss and cluster-loss drills on k3d |
| M1 Harness | Five scenarios automated; at least 30 unattended drills per night, 90% valid |
| M2 Failure study |  Failure classes from real incidents reproduced and measured at V0-V4 |
| M3 Analyzer |  Pre-drill failure prediction evaluated against baselines |
| M4 Copilot |  Drill-verified LLM repair evaluated |
| M5 Studio and Gate |  Web UI and CI gate usable end to end |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
