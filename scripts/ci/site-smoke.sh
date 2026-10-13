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
  if ! test -s "$site_dir/dist${route}index.html"; then
    printf 'Missing or empty site route: %s\n' "$site_dir/dist${route}index.html" >&2
    exit 1
  fi
done
for asset in "${expected_assets[@]}"; do
  if ! test -s "$site_dir/dist$asset"; then
    printf 'Missing or empty site asset: %s\n' "$site_dir/dist$asset" >&2
    exit 1
  fi
done

content_routes=(/ /product/ /evidence/ /download/ /roadmap/ /demo/ /docs/)
content_markers=(
  'What a report tells you'
  'Restore. Record. Review.'
  'How deep did the recovery actually go'
  'Download Nostekon'
  'Make one drill trustworthy'
  'Nostekon Studio'
  'Project overview'
)
for index in "${!content_routes[@]}"; do
  route=${content_routes[$index]}
  needle=${content_markers[$index]}
  if ! grep -Fq -- "$needle" "$site_dir/dist${route}index.html"; then
    printf 'Missing site content in %s: %s\n' "$route" "$needle" >&2
    exit 1
  fi
done

printf '%s\n' 'Nostekon site route and asset checks passed.'
