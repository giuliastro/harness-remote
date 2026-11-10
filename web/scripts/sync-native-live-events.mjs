import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const source = resolve(root, "native-android")
const target = resolve(root, "android/app/src/main/java/ai/harness/remote")
const manifest = resolve(root, "android/app/src/main/AndroidManifest.xml")
const appGradle = resolve(root, "android/app/build.gradle")

if (!existsSync(target)) throw new Error("Android project not found; run npx cap sync android first")
const javaFiles = [
  "MainActivity.java",
  "LiveEventsPlugin.java",
  "PairingScannerPlugin.java",
  "BackgroundAttentionPlugin.java",
  "BackgroundAttentionService.java",
  "BackgroundAttentionConfig.java",
  "BackgroundAttentionStatus.java",
  "BackgroundAttentionNotifications.java",
  "BackgroundAttentionUrls.java",
  "ReconnectBackoff.java",
  "AttentionDeepLink.java",
  "AttentionEventParser.java",
  "AttentionNotificationCenter.java",
  "AttentionRequest.java"
]
for (const file of javaFiles) {
  cpSync(resolve(source, file), resolve(target, file))
}

// Native tests and the icon/strings the service needs are kept beside the Java sources and copied
// into the generated project, because web/android itself is intentionally not tracked.
const testSource = resolve(source, "test")
if (existsSync(testSource)) {
  cpSync(testSource, resolve(root, "android/app/src/test"), { recursive: true })
}
const androidTestSource = resolve(source, "androidTest")
if (existsSync(androidTestSource)) {
  cpSync(androidTestSource, resolve(root, "android/app/src/androidTest"), { recursive: true })
}
const resourceSource = resolve(source, "res")
if (existsSync(resourceSource)) {
  for (const folder of readdirSync(resourceSource)) {
    const from = join(resourceSource, folder)
    const to = resolve(root, "android/app/src/main/res", folder)
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
  }
}

if (!existsSync(manifest)) throw new Error("Android manifest not found after Capacitor sync")
let manifestText = readFileSync(manifest, "utf8")
let changed = false

// The background service is an explicit opt-in consequence of pairing: notification permission is
// requested at runtime, and the battery exemption is the one system dialog Android requires for
// reliable background execution. No Google push dependency is added.
const requiredPermissions = [
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "android.permission.ACCESS_NETWORK_STATE"
]
for (const permission of requiredPermissions) {
  if (manifestText.includes(`android:name="${permission}"`)) continue
  manifestText = manifestText.replace(
    /(<manifest\b[^>]*>)/,
    `$1\n    <uses-permission android:name="${permission}" />`
  )
  changed = true
}

const backgroundServiceMarker = 'android:name=".BackgroundAttentionService"'
if (!manifestText.includes(backgroundServiceMarker)) {
  const applicationPattern = /(<application\b[^>]*>)/
  if (!applicationPattern.test(manifestText)) throw new Error("Android application element not found after Capacitor sync")
  manifestText = manifestText.replace(
    applicationPattern,
    `$1\n        <service\n            android:name=".BackgroundAttentionService"\n            android:exported="false"\n            android:foregroundServiceType="remoteMessaging"\n            android:stopWithTask="false" />`
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

// Attention notifications reopen the exact native Session through the same singleTask activity.
// The URI carries only machine, agent and Session identity; no transcript or prompt text.
const attentionMarker = 'android:host="attention"'
if (!manifestText.includes(attentionMarker)) {
  const activityPattern = /(<activity\b[^>]*android:name="\.MainActivity"[^>]*>)([\s\S]*?)(<\/activity>)/
  if (!activityPattern.test(manifestText)) throw new Error("MainActivity not found in Android manifest after Capacitor sync")
  const attentionFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="harnessremote" android:host="attention" />
            </intent-filter>`
  manifestText = manifestText.replace(activityPattern, `$1$2${attentionFilter}\n        $3`)
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

if (changed) writeFileSync(manifest, manifestText)

if (!existsSync(appGradle)) throw new Error("Android app Gradle file not found after Capacitor sync")
let gradleText = readFileSync(appGradle, "utf8")
const scannerDependency = "implementation 'com.google.android.gms:play-services-code-scanner:16.1.0'"
if (!gradleText.includes("com.google.android.gms:play-services-code-scanner")) {
  if (!/dependencies\s*\{/.test(gradleText)) throw new Error("Android dependencies block not found after Capacitor sync")
  gradleText = gradleText.replace(/dependencies\s*\{/, `dependencies {\n    ${scannerDependency}`)
  writeFileSync(appGradle, gradleText)
}

console.log("Synced Harness Remote native live events, background attention service and QR machine pairing")
