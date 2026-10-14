# Install the portable app

Nostekon can run as a downloaded local application. Its Go executable serves
Studio in your browser; no hosted account or public server is required. A
dedicated desktop window is not implemented. The portable evidence app needs
neither Docker, Python, Node nor Go at runtime.

Verified on Linux on 2026-10-13 with `preview-c6c4708`: the extracted launcher
finds Studio from a different working directory, reports the packaged source
revision and keeps lab execution disabled. Ten desktop/mobile workflows passed
against that actual package, including semantic profile authoring, exact exports,
saved restore plans and original-only backups. All six archives passed checksum
and launcher/tool inventory checks. Six OS/architecture packages can be built.
Windows and macOS are cross-build targets, not locally verified executions.
There is no renamed Nostekon release yet; historical `v0.1.0` predates it.

The local download preview can offer unsigned builds with an explicit version,
source revision and SHA-256. These are not an official release. Check the version
you downloaded with `./nostekon-api --version` (or `nostekon-api.exe --version`)
and compare it with the download page before use.

## Obtain a matching build

Use a successful **Studio** job in the repository's
[CI workflow](https://github.com/jagarkarlo/nostekon/actions/workflows/ci.yml).
Its `nostekon-app-linux-amd64` artifact contains the Linux archive and checksums.
GitHub may require sign-in to download CI artifacts; artifacts expire after
seven days. A tag release will provide persistent platform-specific assets.
Do not use an older Checkride artifact as a current Nostekon installation.

Alternatively, from this checkout with Go 1.25, Node 22, npm and Bash:

```bash
npm ci --prefix studio
npm run build --prefix studio
NOSTEKON_VERSION=dev NOSTEKON_APP_TARGETS=linux/amd64 \
  bash scripts/build-app.sh
```

The output is in `dist/app/`. Available targets are `linux/amd64`, `linux/arm64`,
`darwin/amd64`, `darwin/arm64`, `windows/amd64` and `windows/arm64`. Omit
`NOSTEKON_APP_TARGETS` to build all six; Windows packaging also requires `zip`.
`amd64` is x86-64, including most Intel/AMD PCs; `arm64` includes Apple Silicon.
Check the machine you will run on, not just the build host.

Build Studio with the default `/` base before packaging. A preceding site build
uses `/demo/`; rebuild with `npm run build --prefix studio` afterward. The package
builder rejects that incompatible site build with exit `2` before creating output.
An archive being produced is not proof that its browser assets work: verify the
extracted Linux app below and inspect its reported revision.

## Verify and extract

Obtain the archive and its `SHA256SUMS` together from a trusted source. On Linux:

```bash
cd dist/app
sha256sum --check SHA256SUMS
mkdir nostekon-local
tar -xzf nostekon-app_linux_amd64.tar.gz -C nostekon-local
cd nostekon-local
./nostekon-api --version
./start-nostekon.sh
```

Open `http://127.0.0.1:8080`. Keep the terminal open; Ctrl+C stops the app.
The launcher uses its own directory, so it works from another working directory.
On macOS use the matching `darwin` archive and
`shasum -a 256 --check SHA256SUMS`.

Windows packages are ordinary ZIPs. Verify the selected file in PowerShell:

```powershell
Get-FileHash .\nostekon-app_windows_amd64.zip -Algorithm SHA256
Expand-Archive .\nostekon-app_windows_amd64.zip .\nostekon-local
Set-Location .\nostekon-local
.\nostekon-api.exe --version
.\nostekon-api.exe
```

Compare the hash with the matching line in `SHA256SUMS`. `Start-Nostekon.cmd`
also starts the app from its own directory. These binaries are not OS-signed;
SmartScreen or Gatekeeper may block them. Do not bypass organizational security
controls. Use an approved source build or Docker when appropriate. Checksums
detect transfer damage, not publisher identity or recovery success.

## Review backup plans offline

Current source builds include Studio's **Plan review** and the independent report
binary. Open the app, import the original captured DrillRun, then attach its original
restore plan; or use the packaged binary without starting a server:

```bash
./nostekon-report --backup-plan /protected/orders-plan.json /protected/orders.run.json
./nostekon-report --backup-bundle /protected/orders.backup-review.zip
```

Use the `.exe` filename on Windows. A failed or incomplete original stays failed;
cached bundle receipts are never authoritative. See the
[backup rehearsal guide](postgresql-backup-rehearsal.md) for gate exit codes,
bundle limits, approval and evidence-handling rules. These commands evaluate
existing files only; they do not restore a database.

The portable archive does **not** include the Python backup runner. Planning,
preflight, restore and guarded cleanup require the separate Python installation,
approved inputs and dedicated local Docker host described in that guide. Installing
the evidence app does not authorize production access or enable backup execution.

## Author validation profiles offline

Open **Profiles** in Studio to edit the Orders or Inventory starter, or import
an exact original profile. The same packaged Go engine admits its structure and
exports the JSON consumed by the Python runner. You can inspect a profile without
starting the app:

```bash
./nostekon-report --validation-profile /protected/orders-profile.json
```

Use `nostekon-report.exe` on Windows. Exit `0` means the profile structure was
admitted; `2` means invalid input or an input/output error. This does not check
database contents, approve business rules, authorize a restore or prove recovery.

## Configure and identify

```bash
./nostekon-api --help
./nostekon-api --addr 127.0.0.1:8181
./nostekon-api --studio-dir /path/to/studio --addr 127.0.0.1:8181
./nostekon-api --api-only
```

Stop an existing invocation before starting the next. `--addr` overrides
`NOSTEKON_ADDR`; default is `127.0.0.1:8080`. Studio is selected from
`--studio-dir`, then `NOSTEKON_STUDIO_DIR`, then `studio/` beside the executable.
`--api-only` suppresses configured and bundled Studio; it cannot be combined
with `--studio-dir`. Missing optional bundles retain API-only behavior, while
invalid existing bundles fail startup. Studio roots remain filesystem-confined.

**About Nostekon** shows the build, engine, actual lab capability and
browser-storage origin. `GET /api/v1/info` exposes build/capability metadata,
not local paths or keys. `--version` does not start the server.

The app has no authentication: keep it loopback-only. Explicit wildcard addresses
are allowed for container wiring, not permission to expose it publicly. Lab
execution is disabled unless a Linux host explicitly configures the trusted
executable, private data root and loopback listener in the
[lab runbook](k3d-isolated-restore.md#run-the-suite-from-studio).

## Back up before moving

Saved runs, suites and public-key trust belong to the browser origin: scheme,
host and port. Use the same address after restarting. Changing ports does not
automatically migrate that library.

In Runs, **Back up saved runs** exports `nostekon-runs.backup.json`: exact evidence
and optional attestation sidecars, restore plans and host preflight originals,
each with its own SHA-256.
To export a subset, select the required rows and use **Back up selected runs**.
**Visible runs** selects the current filtered results; changing filters does not
discard an existing selection. Clear the selection before choosing a different
subset. The exported backup contains originals, not comparison results or trust.
Backups containing preflights use `nostekon/run-backup/v3alpha1`, plan-only exports
use `v2alpha1`, and plan-free exports retain `v1alpha1`; restore accepts all
three versions. Attached plans and preflights are bounded to 16 KiB each. **Restore run backup**
validates hashes and previews new versus already-saved identities, including
whether attachments are supplied or preserved. Cancel leaves the library
unchanged. After confirmation, it evaluates every run, then saves the
batch atomically. Invalid input, failed evaluation and quota/capacity failures do
not partially replace the library. Existing evidence identities can be updated;
other runs are not deleted. Backups are bounded to 64 MiB and 50 runs.

Reports, sample labels, public keys, verification receipts and trust are not
backed up; cached plan-review or preflight-review verdicts are not exported either. Reopening a run
with an attached plan or preflight calculates a fresh review. Restored evidence is Imported,
even if originally an example.
Re-import authenticated public keys separately and make a fresh signature check.
Backup updates without a sidecar, plan or preflight preserve the corresponding existing
attachment. To remove a plan or preflight, reopen the run, remove it and explicitly save.
Saved suites and host-job
history are separate; export their original files with existing controls. A run
backup is not Import bundle or Import signed archive. Protect sensitive backups.

Saved history can be ordered by newest save, oldest save or run name. Search
matches each term across the run name, scenario and drill; attachment filters
only describe presence, not signature validity. Compare exactly two selected
runs: the first is the baseline, and the direction can be swapped. Missing
measurements remain unmeasured, while differing scenarios, requested depths or
objectives are disclosed separately. Saved timestamps describe browser saves,
not authenticated capture times.

## Troubleshoot safely

| Symptom | Action |
| --- | --- |
| Address already in use | Stop the process you own or choose an unused loopback port; do not kill an unknown service. |
| Studio missing | Keep extracted `studio/` beside the binary, or select its root with `--studio-dir`. |
| Permission denied or OS blocks launch | Check the source and organizational policy; do not bypass security controls. |
| Checksum mismatch | Do not execute the extracted binaries. Download again from the approved source and recheck. |
| Empty library after moving | Reopen the old browser origin and export before clearing site data. |
| Restore error | Keep originals, address the reported limit/evaluation/quota error and retry; no pruning occurs. |
| Signature cannot verify | Authenticate/import the correct public key, explicitly grant trust and recheck exact originals. |

If a `.tar.gz` download repeatedly fails its checksum while the server's archive
matches, check its HTTP headers. The archive is already compressed; labeling it
as transport-encoded `Content-Encoding: gzip` makes clients decompress it and
changes its bytes. The local Astro preview preserves the originals. Independent
hosting must also preserve the advertised archive size and SHA-256.

To uninstall, stop the app and remove the extracted directory. Browser data is
separate; export and verify originals before deliberately clearing site storage.
No service, automatic updater or background installation is created.