#!/usr/bin/env bash
set -euo pipefail

site_dir=${1:-site}
expected_routes=(/ /product/ /evidence/ /download/ /demo/ /roadmap/ /legal/privacy/ /legal/terms/ /legal/trademark/ /legal/license/ /docs/ /start/ /levels/ /comparison/
  /guides/k3d-isolated-restore/ /guides/ci-recovery-gate/ /guides/metrics-and-dashboard/
  /concepts/how-it-works/ /concepts/write-ledger-rpo/ /concepts/isolated-restores/
  /reference/drill-spec/ /reference/drillrun-evidence/)
docs_routes=(/docs/ /docs/start/ /docs/levels/ /docs/comparison/
  /docs/guides/portable-app/
  /docs/guides/postgresql-backup-rehearsal/
  /docs/guides/k3d-isolated-restore/ /docs/guides/ci-recovery-gate/ /docs/guides/metrics-and-dashboard/
  /docs/concepts/how-it-works/ /docs/concepts/write-ledger-rpo/ /docs/concepts/isolated-restores/
  /docs/reference/drill-spec/ /docs/reference/drillrun-evidence/)
expected_assets=(/images/report-lab-dark.png /images/report-lab-light.png /images/report-failed-dark.png
  /images/report-failed-light.png /fonts/dm-sans-latin-400-normal.woff2 /fonts/ibm-plex-mono-latin-400-normal.woff2
  /demo/nostekon-browser.wasm /demo/wasm_exec.js)

for route in "${expected_routes[@]}" "${docs_routes[@]}"; do
  test -s "$site_dir/dist${route}index.html"
done
for asset in "${expected_assets[@]}"; do
  test -s "$site_dir/dist$asset"
done

for needle in \
  'Find out whether a restore really worked' \
  'What Nostekon is made of' \
  'How deep did the recovery actually go' \
  'Make one drill trustworthy' \
  'Nostekon Studio' \
  'Project overview'; do
  grep -Rqs "$needle" "$site_dir/dist"
done

printf '%s\n' 'Nostekon site route and asset checks passed.'
