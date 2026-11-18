#!/usr/bin/env bash
# =============================================================================
# Regenerate the theme icon set from assets/noteflow-icon.png.
#
# The source is one transparent PNG; the theme ships raster derivatives instead
# of inline SVG, because the render would repeat ~20 KB of markup on every page.
# Run this after replacing the source, then commit both it and the output.
#
# Requires ImageMagick 7 (`magick`). Keep the master a PNG, not an SVG: the SVG
# delegate flattens transparency onto white, which shows as a pale box on the
# dark theme — and `-extent` without `-background none` pads white the same way.
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

# The wide mark keeps the artwork's aspect; the square icons pad it to 1:1.
magick "$TMP/src.png" -filter Lanczos -resize 144x $PNG8 "$OUT/mark.png"

magick "$TMP/src.png" -filter Lanczos -resize 112x112 \
  -background none -gravity center -extent 112x112 $PNG8 "$OUT/favicon.png"

magick -size 180x180 xc:'#f4f8ff' \
  \( "$TMP/src.png" -filter Lanczos -resize 164x164 -background none -gravity center -extent 164x164 \) \
  -gravity center -compose over -composite -strip -depth 8 \
  -define png:compression-level=9 -define png:color-type=6 "$OUT/apple-touch-icon.png"

echo "✓ icons: $(ls -1 "$OUT"/*.png | tr '\n' ' ')"