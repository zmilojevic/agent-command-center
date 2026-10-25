#!/bin/sh
# Regenerates the packaging icons from resources/icon.svg (needs rsvg-convert and ImageMagick).
#   build/icon.png            1024 px, macOS-style padding (artwork ~824 px)
#   build/icon.ico            16..256 px, full bleed
#   resources/trayTemplate*.png  monochrome macOS menu-bar template (16 / 32 px), from resources/tray-template.svg
set -eu
cd "$(dirname "$0")/.."
mkdir -p build
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

rsvg-convert -w 824 -h 824 resources/icon.svg -o "$tmp/art.png"
magick -size 1024x1024 xc:none "$tmp/art.png" -gravity center -composite build/icon.png

for s in 16 24 32 48 64 128 256; do
  rsvg-convert -w $s -h $s resources/icon.svg -o "$tmp/$s.png"
done
magick "$tmp/16.png" "$tmp/24.png" "$tmp/32.png" "$tmp/48.png" "$tmp/64.png" "$tmp/128.png" "$tmp/256.png" build/icon.ico

rsvg-convert -w 16 -h 16 resources/tray-template.svg -o resources/trayTemplate.png
rsvg-convert -w 32 -h 32 resources/tray-template.svg -o resources/trayTemplate@2x.png
echo "icons written"
