#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=${NOSTEKON_VERSION:-dev}
targets=${NOSTEKON_APP_TARGETS:-"linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64"}
if [[ $# -gt 1 || ! "$version" =~ ^[a-zA-Z0-9._+-]{1,80}$ ]]; then
  printf '%s\n' 'Usage: NOSTEKON_VERSION=VERSION NOSTEKON_APP_TARGETS="os/arch ..." bash scripts/build-app.sh [output-directory]' >&2
  exit 2
fi
if [[ ! -f "$root/studio/dist/index.html" ]]; then
  printf '%s\n' 'Build Studio first: npm ci --prefix studio && npm run build --prefix studio' >&2
  exit 2
fi
if grep -q '/demo/assets/' "$root/studio/dist/index.html"; then
  printf '%s\n' 'Site-base Studio build cannot be packaged. Rebuild: npm run build --prefix studio' >&2
  exit 2
fi
if [[ -n "$(find "$root/studio/dist" -type l -print -quit)" ]]; then
  printf '%s\n' 'Studio build must not contain symlinks.' >&2
  exit 2
fi
target_count=0
for target in $targets; do
  ((target_count+=1))
  case "$target" in
    linux/amd64|linux/arm64|darwin/amd64|darwin/arm64|windows/amd64|windows/arm64) ;;
    *) printf 'Unsupported app target: %s\n' "$target" >&2; exit 2 ;;
  esac
  if [[ "$target" == windows/* ]]; then command -v zip >/dev/null; fi
done
if [[ "$target_count" -eq 0 ]]; then printf '%s\n' 'At least one app target is required.' >&2; exit 2; fi

mkdir -p "${1:-$root/dist/app}"
output=$(cd "${1:-$root/dist/app}" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
cd "$root"
revision=$(git rev-parse HEAD)
ldflags="-s -w -X github.com/jagarkarlo/nostekon/internal/buildinfo.Version=$version -X github.com/jagarkarlo/nostekon/internal/buildinfo.Revision=$revision"
archives=()

for target in $targets; do
  os=${target%/*}; arch=${target#*/}; extension=""
  if [[ "$os" == windows ]]; then extension=.exe; fi
  bundle="$temporary/nostekon-${os}-${arch}"
  mkdir -p "$bundle/studio"
  for tool in nostekon-api nostekon-report nostekon-attest; do
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags="$ldflags" -o "$bundle/$tool$extension" "./cmd/$tool"
  done
  cp -R studio/dist/. "$bundle/studio/"
  cp LICENSE README.md "$bundle/"
  if [[ "$os" == windows ]]; then
    cp scripts/launchers/Start-Nostekon.cmd "$bundle/"
    archive="$output/nostekon-app_${os}_${arch}.zip"
    rm -f "$temporary/app.zip"
    (cd "$bundle" && zip -q -r "$temporary/app.zip" .)
    mv "$temporary/app.zip" "$archive"
  else
    cp scripts/launchers/start-nostekon.sh "$bundle/"
    chmod 755 "$bundle/start-nostekon.sh"
    archive="$output/nostekon-app_${os}_${arch}.tar.gz"
    tar -czf "$temporary/app.tar.gz" -C "$bundle" .
    mv "$temporary/app.tar.gz" "$archive"
  fi
  printf 'Built %s\n' "$archive"
  archives+=("${archive##*/}")
done

(cd "$output" && if command -v sha256sum >/dev/null; then sha256sum "${archives[@]}" > "$temporary/SHA256SUMS"; else shasum -a 256 "${archives[@]}" > "$temporary/SHA256SUMS"; fi)
mv "$temporary/SHA256SUMS" "$output/SHA256SUMS"
node -e '
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
  const [directory, version, revision, ...names] = process.argv.slice(1);
  const artifacts = names.map(name => {
    const file = path.join(directory, name);
    return { name, size: fs.statSync(file).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  });
  fs.writeFileSync(path.join(directory, "app-build.json"), JSON.stringify({ kind: "AppBuild", version, revision, artifacts }, null, 2) + "\n");
' "$output" "$version" "$revision" "${archives[@]}"
printf 'App version: %s; revision: %s\n' "$version" "$revision"