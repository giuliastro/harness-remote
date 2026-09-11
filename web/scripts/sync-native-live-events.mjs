import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const source = resolve(root, "native-android")
const target = resolve(root, "android/app/src/main/java/ai/harness/remote")
const manifest = resolve(root, "android/app/src/main/AndroidManifest.xml")

if (!existsSync(target)) throw new Error("Android project not found; run npx cap sync android first")
for (const file of ["MainActivity.java", "LiveEventsPlugin.java"]) {
  cpSync(resolve(source, file), resolve(target, file))
}

if (!existsSync(manifest)) throw new Error("Android manifest not found after Capacitor sync")
let manifestText = readFileSync(manifest, "utf8")
let changed = false
const notificationPermission = "android.permission.POST_NOTIFICATIONS"
if (!manifestText.includes(notificationPermission)) {
  manifestText = manifestText.replace(
    /(<manifest\b[^>]*>)/,
    `$1\n    <uses-permission android:name="${notificationPermission}" />`
  )
  changed = true
}

// A phone camera / QR scanner opens this custom URI through MainActivity. The token itself remains
// short-lived and one-use; this filter merely lets Android deliver the URI to Capacitor App.
const pairingMarker = 'android:host="pair"'
if (!manifestText.includes(pairingMarker)) {
  const activityPattern = /(<activity\b[^>]*android:name="\.MainActivity"[^>]*>)([\s\S]*?)(<\/activity>)/
  if (!activityPattern.test(manifestText)) throw new Error("MainActivity not found in Android manifest after Capacitor sync")
  const pairingFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="harnessremote" android:host="pair" />
            </intent-filter>`
  manifestText = manifestText.replace(activityPattern, `$1$2${pairingFilter}\n        $3`)
  changed = true
}

if (changed) writeFileSync(manifest, manifestText)
console.log("Synced Harness Remote live-events plugin, Attention permission and machine-pairing deep link")
