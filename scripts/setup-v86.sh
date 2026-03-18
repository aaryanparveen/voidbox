#!/bin/bash

set -e

DEST="public/v86"
mkdir -p "$DEST"

V86_VERSION="latest"
V86_BASE="https://github.com/niclin/niclin.github.io/raw/refs/heads/master/v86"
COPY_BASE="https://copy.sh/v86"

echo "downloading v86 assets..."

if [ ! -f "$DEST/v86.wasm" ]; then
  echo "  -> v86.wasm"
  curl -L -o "$DEST/v86.wasm" "$COPY_BASE/build/v86.wasm" 2>/dev/null || \
  curl -L -o "$DEST/v86.wasm" "https://unpkg.com/v86@latest/build/v86.wasm"
fi

if [ ! -f "$DEST/seabios.bin" ]; then
  echo "  -> seabios.bin"
  curl -L -o "$DEST/seabios.bin" "$COPY_BASE/bios/seabios.bin" 2>/dev/null || \
  curl -L -o "$DEST/seabios.bin" "https://unpkg.com/v86@latest/bios/seabios.bin"
fi

if [ ! -f "$DEST/vgabios.bin" ]; then
  echo "  -> vgabios.bin"
  curl -L -o "$DEST/vgabios.bin" "$COPY_BASE/bios/vgabios.bin" 2>/dev/null || \
  curl -L -o "$DEST/vgabios.bin" "https://unpkg.com/v86@latest/bios/vgabios.bin"
fi

if [ ! -f "$DEST/buildroot-bzimage68.bin" ]; then
  echo "  -> buildroot-bzimage68.bin (tiny Linux)"
  curl -L -o "$DEST/buildroot-bzimage68.bin" "$COPY_BASE/images/buildroot-bzimage68.bin"
fi

echo "v86 assets are in $DEST/"
ls -la "$DEST/"


