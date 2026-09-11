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
const notificationPermission = "android.permission.POST_NOTIFICATIONS"
if (!manifestText.includes(notificationPermission)) {
  manifestText = manifestText.replace(
    /(<manifest\b[^>]*>)/,
    `$1\n    <uses-permission android:name="${notificationPermission}" />`
  )
  writeFileSync(manifest, manifestText)
}

console.log("Synced Harness Remote live-events plugin and Attention notification permission")
