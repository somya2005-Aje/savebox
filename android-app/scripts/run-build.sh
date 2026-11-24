#!/usr/bin/env bash
set -x
export JAVA_HOME="$HOME/workspace/.jdks/jdk-17.0.21.1+2"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$HOME/Android/sdk"
export ANDROID_SDK_ROOT="$HOME/Android/sdk"
export GRADLE_USER_HOME="$HOME/workspace/savebox/android-app/.gradle-home"
cd "$HOME/workspace/savebox/android-app/android"
./gradlew assembleDebug --no-daemon
echo "GRADLE_EXIT=$?"
