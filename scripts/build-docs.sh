#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
python=${PYTHON:-python3}
if [[ -z ${PYTHON:-} && -x .venv/bin/python ]]; then
  python=.venv/bin/python
fi
"$python" -m zensical build --strict --clean
mkdir -p site/public/docs/assets/fonts
cp studio/node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2 site/public/docs/assets/fonts/
cp studio/node_modules/@fontsource/dm-sans/files/dm-sans-latin-700-normal.woff2 site/public/docs/assets/fonts/
cp studio/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2 site/public/docs/assets/fonts/