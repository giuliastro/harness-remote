#!/usr/bin/env bash
# Collect evidence for the real-device background battery soak described in
# docs/ANDROID_NOTIFICATION_GUIDE.md. This script does not change app state; it only resets and
# reads Android diagnostics, then waits.
set -euo pipefail

ADB=${ADB:-adb}
DURATION=${SOAK_SECONDS:-7200}
OUT=${OUT:-"android-soak-$(date +%Y%m%d-%H%M%S)"}

mkdir -p "$OUT"
if [ -n "${ANDROID_SERIAL:-}" ]; then
  ADB=("$ADB" -s "$ANDROID_SERIAL")
else
  ADB=("$ADB")
fi

echo "Collecting baseline into $OUT"
"${ADB[@]}" shell dumpsys battery > "$OUT/battery-before.txt"
"${ADB[@]}" shell dumpsys notification --noredact > "$OUT/notifications-before.txt"
"${ADB[@]}" shell dumpsys batterystats --reset
"${ADB[@]}" shell dumpsys batterystats > "$OUT/batterystats-before.txt" || true

echo "Keeping the device unplugged and the screen off for ${DURATION}s"
sleep "$DURATION"

echo "Collecting final evidence into $OUT"
"${ADB[@]}" shell dumpsys battery > "$OUT/battery-after.txt"
"${ADB[@]}" shell dumpsys notification --noredact > "$OUT/notifications-after.txt"
"${ADB[@]}" shell dumpsys batterystats > "$OUT/batterystats-after.txt"
"${ADB[@]}" shell dumpsys deviceidle > "$OUT/deviceidle-after.txt"

echo "Done. Stop the service from the notification and keep $OUT as the soak evidence."
