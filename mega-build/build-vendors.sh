#!/bin/bash
# Rebuild the vendored browser files for SaveBox MEGA (v1.4.0).
# Run from ~/workspace/savebox/mega-build (npm install first).
# - buffer-vendor.js: Buffer polyfill (buffer@6.0.3). REQUIRED because
#   megajs' browser upload streams reject plain Uint8Array chunks — they
#   only accept real Buffer instances (isBuffer checks the _isBuffer flag).
#   The shim sets window.Buffer so js/mega.js can write Buffer chunks.
# - mega-vendor.js: megajs 1.3.10 browser UMD, copied as-is, no changes.
set -e
cd "$(dirname "$0")"
npx esbuild node_modules/buffer/index.js --bundle --format=iife --global-name=Buffer --minify \
  "--footer:js=globalThis.Buffer = Buffer.Buffer;" \
  --outfile=../final-deploy/js/buffer-vendor.js
{
  echo '/* SaveBox — Buffer polyfill (buffer@6.0.3) for the MEGA browser client.'
  echo ' * megajs browser upload streams only accept real Buffer instances,'
  echo ' * not plain Uint8Array — this shim provides window.Buffer.'
  echo ' * Rebuild: bash mega-build/build-vendors.sh (npm install first). */'
  cat ../final-deploy/js/buffer-vendor.js
} > ../final-deploy/js/buffer-vendor.js.tmp
mv ../final-deploy/js/buffer-vendor.js.tmp ../final-deploy/js/buffer-vendor.js
cp node_modules/megajs/dist/main.browser-umd.js ../final-deploy/js/mega-vendor.js
echo "vendors rebuilt:"
ls -la ../final-deploy/js/buffer-vendor.js ../final-deploy/js/mega-vendor.js
