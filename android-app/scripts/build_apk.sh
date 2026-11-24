#!/usr/bin/env bash
# Build the SaveBox debug APK with Gradle.
# Usage: bash android-app/scripts/build_apk.sh   (run from the repo root)
# Prerequisites (run once, on a real machine — NOT in the Muse sandbox):
#   1. bash android-app/scripts/prepare-www.sh
#   2. npm install (inside android-app/) — installs @capacitor/cli + android
#   3. Android SDK installed (Android Studio or cmdline-tools) with
#      ANDROID_HOME pointing at it, e.g. $HOME/Android/Sdk
#   4. Java 17+ (Gradle 9 needs JDK 17+)
# NOTE: Gradle may FAIL in sandboxed environments (including the Muse VM)
# because the Gradle daemon communicates over a loopback TCP socket
# (127.0.0.1) and that is blocked there — the build dies with
# "Could not dispatch a message to the daemon" / Broken pipe. That is an
# environment limit, not a SaveBox bug. Build on a real machine instead:
# the user builds the APK on his own Windows machine where Flutter/Android
# tooling is already installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/android-app/.gradle-home}"
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -d "$HOME/Android/Sdk" ]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  elif [ -d "$HOME/Library/Android/sdk" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  else
    echo "ERROR: ANDROID_HOME is not set and no SDK found at \$HOME/Android/Sdk."
    echo "Install Android Studio (or cmdline-tools) and set ANDROID_HOME, then re-run."
    exit 1
  fi
fi
echo "ANDROID_HOME=$ANDROID_HOME"
echo "GRADLE_USER_HOME=$GRADLE_USER_HOME"
cd "$ROOT/android-app/android"
./gradlew assembleDebug
APK="$ROOT/android-app/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  cp "$APK" "$ROOT/savebox-v1.0.0-debug.apk"
  echo "APK built: $ROOT/savebox-v1.0.0-debug.apk"
fi
