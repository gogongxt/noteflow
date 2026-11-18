#!/usr/bin/env bash
# =============================================================================
# Regenerate the theme icon set from assets/noteflow-icon.png.
#
# The source artwork is a 1229×824 transparent PNG; the theme ships raster
# derivatives instead of inline SVG, because the detailed render would repeat
# ~20 KB of markup on every page. Run this after replacing the source, then
# commit both it and the output.
#
# Requires ImageMagick 7 (`magick`). Keep the master a PNG, not an SVG: the SVG
# delegate flattens transparency onto white, which shows as a pale box on the
# dark theme.
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

# The square icon is a tighter crop centred on the N, so the tab thumbnail reads
# at 16 px; the wide mark keeps the full artwork for the header and footer.
CROP="900x740+160+40"

magick "$TMP/src.png" -filter Lanczos -resize 144x -strip -depth 8 \
  -define png:compression-level=9 -define png:color-type=6 "$OUT/mark.png"

magick "$TMP/src.png" -crop "$CROP" +repage -filter Lanczos -resize 112x112^ \
  -gravity center -extent 112x112 -strip -depth 8 \
  -define png:compression-level=9 -define png:color-type=6 "$OUT/favicon.png"

magick -size 180x180 xc:'#f4f8ff' \
  \( "$TMP/src.png" -crop "$CROP" +repage -filter Lanczos -resize 160x160^ -gravity center -extent 160x160 \) \
  -gravity center -compose over -composite -strip -depth 8 \
  -define png:compression-level=9 -define png:color-type=6 "$OUT/apple-touch-icon.png"

echo "✓ icons: $(ls -1 "$OUT"/*.png | tr '\n' ' ')"