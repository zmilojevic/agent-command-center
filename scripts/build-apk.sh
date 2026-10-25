#!/usr/bin/env bash
# Builds the Android WebView shell (android/) and copies the debug APK to ~/Downloads.
# Debug-signed with ~/.android/debug.keystore: updates over an installed copy only work
# when built on the same machine / with the same keystore.
set -euo pipefail
cd "$(dirname "$0")/../android"

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/share/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export PATH="$JAVA_HOME/bin:$PATH"

echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug

out="$HOME/Downloads/agent-command-center.apk"
mkdir -p "$HOME/Downloads"
cp app/build/outputs/apk/debug/app-debug.apk "$out"
echo "$out"
