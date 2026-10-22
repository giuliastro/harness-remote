import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const source = resolve(root, "native-android")
const target = resolve(root, "android/app/src/main/java/ai/harness/remote")
const manifest = resolve(root, "android/app/src/main/AndroidManifest.xml")
const appGradle = resolve(root, "android/app/build.gradle")

if (!existsSync(target)) throw new Error("Android project not found; run npx cap sync android first")
for (const file of ["MainActivity.java", "LiveEventsPlugin.java", "PairingScannerPlugin.java", "SessionMonitorPlugin.java", "SessionMonitorService.java"]) {
  cpSync(resolve(source, file), resolve(target, file))
}

// Monochrome small icon for session monitor notifications.
const drawableTarget = resolve(root, "android/app/src/main/res/drawable")
mkdirSync(drawableTarget, { recursive: true })
cpSync(resolve(source, "res/drawable/ic_stat_harness.xml"), resolve(drawableTarget, "ic_stat_harness.xml"))

if (!existsSync(manifest)) throw new Error("Android manifest not found after Capacitor sync")
let manifestText = readFileSync(manifest, "utf8")
let changed = false

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

// Google Code Scanner owns its camera UI inside Play services, so Harness Remote does not request
// CAMERA permission. Pre-declaring barcode_ui lets Play installs fetch the scanner module early;
// debug/sideloaded builds may download it on the first scan instead.
const scannerMetadataMarker = 'android:name="com.google.mlkit.vision.DEPENDENCIES"'
if (!manifestText.includes(scannerMetadataMarker)) {
  const applicationPattern = /(<application\b[^>]*>)/
  if (!applicationPattern.test(manifestText)) throw new Error("Android application element not found after Capacitor sync")
  manifestText = manifestText.replace(
    applicationPattern,
    `$1\n        <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />`
  )
  changed = true
}

// Opt-in session monitor: foreground service (special use) polling the user's own agents, no Firebase.
const monitorPermissions = [
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
  "android.permission.WAKE_LOCK",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"
]
const missingPermissions = monitorPermissions.filter((name) => !manifestText.includes(`android:name="${name}"`))
if (missingPermissions.length > 0) {
  const lines = missingPermissions.map((name) => `    <uses-permission android:name="${name}" />`).join("\n")
  if (!/<application\b/.test(manifestText)) throw new Error("Android application element not found after Capacitor sync")
  manifestText = manifestText.replace(/(\s*)(<application\b)/, `\n${lines}\n$1$2`)
  changed = true
}

const serviceMarker = 'android:name=".SessionMonitorService"'
if (!manifestText.includes(serviceMarker)) {
  const serviceElement = `
        <service android:name=".SessionMonitorService" android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Opt-in monitor that notifies the user when their own AI agent sessions finish or need attention" />
        </service>`
  if (!/<\/application>/.test(manifestText)) throw new Error("Android application closing tag not found after Capacitor sync")
  manifestText = manifestText.replace(/(\s*)<\/application>/, `\n${serviceElement}\n    </application>`)
  changed = true
}

if (changed) writeFileSync(manifest, manifestText)

if (!existsSync(appGradle)) throw new Error("Android app Gradle file not found after Capacitor sync")
let gradleText = readFileSync(appGradle, "utf8")
const scannerDependency = "implementation 'com.google.android.gms:play-services-code-scanner:16.1.0'"
if (!gradleText.includes("com.google.android.gms:play-services-code-scanner")) {
  if (!/dependencies\s*\{/.test(gradleText)) throw new Error("Android dependencies block not found after Capacitor sync")
  gradleText = gradleText.replace(/dependencies\s*\{/, `dependencies {\n    ${scannerDependency}`)
  writeFileSync(appGradle, gradleText)
}

console.log("Synced Harness Remote native live events, QR machine pairing and session monitor")
