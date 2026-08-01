#!/usr/bin/env bash
# Rasterizes extension/icons/icon.svg into the PNG sizes the manifest and the
# Chrome Web Store listing need, then rebuilds the store promo tile.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icons="$root/extension/icons"
store="$root/docs/store"

mkdir -p "$store"

for s in 16 32 48 128; do
  magick -background none "$icons/icon.svg" -resize ${s}x${s} "$icons/icon-${s}.png"
done

# Small promo tile: brand mark, wordmark, one line of what it does.
magick -background '#12161C' -fill '#F3F4F6' -font Helvetica-Bold -pointsize 42 label:'Canopy' "$store/.wordmark.png"
magick -background '#12161C' -fill '#9CA3AF' -font Helvetica -pointsize 17 -interline-spacing 6 \
  label:'Watch AI agents drive\nyour real browser' "$store/.tagline.png"
magick -size 440x280 xc:'#12161C' \
  \( "$icons/icon-128.png" -resize 96x96 \) -gravity northwest -geometry +42+92 -composite \
  "$store/.wordmark.png" -gravity northwest -geometry +162+96 -composite \
  "$store/.tagline.png" -gravity northwest -geometry +164+148 -composite \
  "$store/promo-tile-440x280.png"
rm -f "$store/.wordmark.png" "$store/.tagline.png"

echo "icons: $icons/icon-{16,32,48,128}.png"
echo "tile:  $store/promo-tile-440x280.png"
