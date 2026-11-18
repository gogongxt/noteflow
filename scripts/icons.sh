#!/usr/bin/env bash
# =============================================================================
# Regenerate the theme icon set from assets/noteflow-icon.png (one transparent
# PNG; raster derivatives instead of inline SVG). Run after replacing the
# source, then commit both it and the output.
#
# ImageMagick 7 only. Keep the master a PNG: the SVG delegate flattens
# transparency onto white, and `-extent` pads white without `-background none`.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="assets/noteflow-icon.png"
OUT="themes/default/img"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v magick >/dev/null || { echo "ImageMagick 7 (magick) is required" >&2; exit 1; }

magick "$SRC" -trim +repage -strip "$TMP/src.png"
PNG8="-strip -depth 8 -define png:compression-level=9 -define png:color-type=6"

# Cut to the ink first: a tab scales the artwork's transparent margin down with
# it. A near-zero alpha residue rings the canvas and defeats -trim, so the alpha
# channel is clamped first.
magick "$TMP/src.png" -channel A -level 3%,100% +channel -trim +repage "$TMP/ink.png"

# The mark keeps the artwork's aspect; the square icons pad the ink to 1:1.
magick "$TMP/ink.png" -filter Lanczos -resize 144x $PNG8 "$OUT/mark.png"

magick "$TMP/ink.png" -filter Lanczos -resize 112x112 \
  -background none -gravity center -extent 112x112 $PNG8 "$OUT/favicon.png"

magick -size 180x180 xc:'#f4f8ff' \
  \( "$TMP/ink.png" -filter Lanczos -resize 164x164 -background none -gravity center -extent 164x164 \) \
  -gravity center -compose over -composite -strip -depth 8 \
  -define png:compression-level=9 -define png:color-type=6 "$OUT/apple-touch-icon.png"

echo "✓ icons: $(ls -1 "$OUT"/*.png | tr '\n' ' ')"