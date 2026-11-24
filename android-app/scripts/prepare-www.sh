#!/usr/bin/env bash
# Prepare the Capacitor webDir from the SaveBox source of truth (final-deploy).
# The APK opens the APP directly, not a landing page: final-deploy/ is copied
# into android-app/www/app/ and the bundled root index.html is a tiny redirect
# to app/index.html.
# Usage: bash android-app/scripts/prepare-www.sh   (run from the repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$ROOT/android-app/www"
mkdir -p "$ROOT/android-app/www/app"
cp -r "$ROOT/final-deploy/." "$ROOT/android-app/www/app/"
rm -f "$ROOT/android-app/www/app"/*.apk  # never bundle a previous APK inside the new one
cat > "$ROOT/android-app/www/index.html" <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SaveBox</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#102A43;color:#fff;font-family:system-ui,sans-serif}</style>
<script>location.replace('app/index.html');</script>
</head><body><p>Loading SaveBox…</p></body></html>
HTML
echo "www prepared: $(find "$ROOT/android-app/www" -type f | wc -l) files"
