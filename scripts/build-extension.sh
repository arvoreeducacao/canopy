#!/usr/bin/env bash
# Packs extension/ into dist/canopy-extension.zip for the Chrome Web Store.
# The zip must have manifest.json at its root — not nested under extension/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/dist/canopy-extension.zip"

mkdir -p "$root/dist"
rm -f "$out"

cd "$root/extension"
# icon.svg is the source for the PNGs, not shipped — reviewers ask about unused files.
zip -r -X "$out" . -x 'icons/icon.svg' '.DS_Store' '*/.DS_Store' >/dev/null

version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
echo "built $out (v$version)"
unzip -l "$out"
