import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  claimMachinePairing,
  parseMachinePairingActivation,
  parseMachinePairingGrant,
  parseMachinePairingGrantStatus,
  scanAndroidMachinePairing,
  upsertPairedMachine
} from "./machine-pairing.ts"

const future = () => Date.now() + 60_000
const pairingURL = (endpoint = "http://192.168.1.20:4097", expiresAt = future()) =>
  `harnessremote://pair?endpoint=${encodeURIComponent(endpoint)}&token=${"a".repeat(43)}&expires=${expiresAt}`

function grantBody(overrides = {}) {
  const uri = pairingURL()
  return {
    version: 1,
    expiresAt: future(),
    loopbackOnly: false,
    links: [{ endpoint: "http://192.168.1.20:4097", uri }],
    ...overrides
  }
}

test("pairing activation accepts only the private explicit daemon endpoint shape", () => {
  const expiresAt = future()
  const url = pairingURL("http://192.168.1.20:4097", expiresAt)
  assert.deepEqual(parseMachinePairingActivation(url), {
    endpoint: "http://192.168.1.20:4097",
    token: "a".repeat(43),
    expiresAt
  })
  assert.equal(parseMachinePairingActivation("https://example.com"), null)
  assert.equal(parseMachinePairingActivation(pairingURL("http://user:secret@192.168.1.20:4097")), null)
  assert.equal(parseMachinePairingActivation(pairingURL("http://192.168.1.20")), null)
  assert.equal(parseMachinePairingActivation(pairingURL("http://192.168.1.20:4097/path")), null)
})

test("Android in-app scanner accepts only Harness Remote pairing QR values", async () => {
  const url = pairingURL()
  const expected = parseMachinePairingActivation(url)
  assert.deepEqual(await scanAndroidMachinePairing({
    platform: "android",
    scan: async () => ({ value: url })
  }), expected)
  assert.equal(await scanAndroidMachinePairing({
    platform: "android",
    scan: async () => ({ cancelled: true })
  }), null)
  await assert.rejects(() => scanAndroidMachinePairing({
    platform: "android",
    scan: async () => ({ value: "https://example.com/not-a-pairing-code" })
  }), /not a valid Harness Remote machine pairing code/i)
})

test("native pairing claim exchanges the one-time token for the existing daemon credentials", async () => {
  const activation = parseMachinePairingActivation(pairingURL())
  assert.ok(activation)
  let requestOptions
  const paired = await claimMachinePairing(activation, {
    native: true,
    nativeRequest: async (options) => {
      requestOptions = options
      return {
        status: 200,
        data: {
          version: 1,
          machine: { id: "physical-machine-1", name: "Studio PC" },
          credentials: { username: "harness", password: "generated-secret" }
        },
        headers: {},
        url: options.url
      }
    }
  })

  assert.equal(requestOptions.url, "http://192.168.1.20:4097/v1/pairing/claim")
  assert.equal(requestOptions.method, "POST")
  assert.deepEqual(requestOptions.data, { token: "a".repeat(43) })
  assert.deepEqual(paired, {
    id: "physical-machine-1",
    name: "Studio PC",
    config: {
      backend: "opencode",
      host: "192.168.1.20",
      port: 4097,
      username: "harness",
      password: "generated-secret",
      agentId: undefined
    }
  })
})

test("re-pairing updates an existing endpoint in place instead of duplicating it", () => {
  const existing = {
    id: "local-stable-id",
    name: "Old name",
    config: {
      backend: "opencode",
      host: "192.168.1.20",
      port: 4097,
      username: "harness",
      password: "old-secret"
    }
  }
  const paired = {
    id: "physical-machine-1",
    name: "Studio PC",
    config: {
      backend: "opencode",
      host: "192.168.1.20",
      port: 4097,
      username: "harness",
      password: "new-secret"
    }
  }
  const result = upsertPairedMachine([existing], paired)
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "local-stable-id")
  assert.equal(result[0].name, "Studio PC")
  assert.equal(result[0].config.password, "new-secret")
})

test("a pairing grant parses only complete, internally consistent daemon answers", () => {
  const valid = grantBody()
  assert.deepEqual(parseMachinePairingGrant(valid), {
    expiresAt: valid.expiresAt,
    loopbackOnly: false,
    links: [{ endpoint: "http://192.168.1.20:4097", uri: valid.links[0].uri }]
  })
  assert.deepEqual(parseMachinePairingGrant({ ...valid, loopbackOnly: true, links: [] }), {
    expiresAt: valid.expiresAt,
    loopbackOnly: true,
    links: []
  })
  assert.equal(parseMachinePairingGrant({ ...valid, version: 2 }), null)
  assert.equal(parseMachinePairingGrant({ ...valid, expiresAt: 0 }), null)
  assert.equal(parseMachinePairingGrant({ ...valid, loopbackOnly: undefined }), null)
  assert.equal(parseMachinePairingGrant({ ...valid, links: "not-a-list" }), null)
  // A link whose endpoint and URI disagree would render a QR for a different address than the one
  // the picker shows, so the mismatched pair is rejected outright.
  assert.equal(parseMachinePairingGrant({
    ...valid,
    links: [{ endpoint: "http://192.168.1.21:4097", uri: valid.links[0].uri }]
  }), null)
  assert.equal(parseMachinePairingGrant({
    ...valid,
    links: [{ endpoint: "http://192.168.1.20:4097", uri: "https://example.com" }]
  }), null)
})

test("a pairing grant status parses pending, claimed and expired answers", () => {
  const expiresAt = future()
  assert.deepEqual(parseMachinePairingGrantStatus({ version: 1, expiresAt, claimed: false, expired: false }), {
    expiresAt,
    claimed: false,
    expired: false
  })
  assert.deepEqual(parseMachinePairingGrantStatus({ version: 1, expiresAt, claimed: true, expired: false }), {
    expiresAt,
    claimed: true,
    expired: false
  })
  assert.equal(parseMachinePairingGrantStatus({ version: 1, claimed: true }), null)
  assert.equal(parseMachinePairingGrantStatus({ version: 1, expiresAt, claimed: "yes", expired: false }), null)
})

test("Android packaging exposes deep-link and in-app QR pairing without CAMERA or notification permission", () => {
  const sync = readFileSync(new URL("../scripts/sync-native-live-events.mjs", import.meta.url), "utf8")
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
  const workspace = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
  const activity = readFileSync(new URL("../native-android/MainActivity.java", import.meta.url), "utf8")
  const scanner = readFileSync(new URL("../native-android/PairingScannerPlugin.java", import.meta.url), "utf8")
  assert.match(sync, /android:scheme="harnessremote" android:host="pair"/)
  assert.match(sync, /android\.intent\.category\.BROWSABLE/)
  assert.match(sync, /play-services-code-scanner:16\.1\.0/)
  assert.match(sync, /barcode_ui/)
  assert.doesNotMatch(sync, /android\.permission\.CAMERA/)
  assert.doesNotMatch(sync, /POST_NOTIFICATIONS/)
  assert.match(activity, /registerPlugin\(PairingScannerPlugin\.class\)/)
  assert.match(scanner, /Barcode\.FORMAT_QR_CODE/)
  assert.match(scanner, /enableAutoZoom\(\)/)
  assert.match(main, /subscribeAndroidMachinePairing/)
  assert.match(main, /scanAndroidMachinePairing\(\)/)
  assert.match(main, /upsertPairedMachine\(machinesRef\.current, paired\)/)
  assert.match(main, /persistMachines\(nextMachines\)/)
  assert.match(main, /setPairingSuccessMachineName\(paired\.name\)/)
  assert.match(main, /setPairingSuccessRevision\(\(value\) => value \+ 1\)/)
  assert.match(main, /onScanMachinePairing=\{Capacitor\.getPlatform\(\) === "android" \? scanPairingQR : undefined\}/)
  assert.match(main, /t\("sf\.pairingConnected", \{ name: paired\.name \}\)/)
  assert.doesNotMatch(main, /hr-machine-pairing-editor-action/, "scanner must not depend on the manual editor being open")
  assert.doesNotMatch(main, /<strong>Machine pairing<\/strong>|Connecting to this machine|QR pairing failed/, "pairing status must use i18n rather than hardcoded English")
  assert.match(workspace, /machines\.length === 0 && editingID !== "new"[\s\S]*data-machine-pairing-scan[\s\S]*sf\.scanMachineQR/, "first-run Machines must expose QR scan directly")
  assert.match(workspace, /pairingSuccessRevision <= 0[\s\S]*setEditingID\(null\)[\s\S]*setCompletionMachineName\(pairingSuccessMachineName\)/, "successful pairing must dismiss any stale manual machine draft and expose completion")
  assert.match(workspace, /data-machine-view-sessions[\s\S]*sf\.viewSessions/, "pairing completion must expose an explicit primary path to Sessions")
  assert.match(workspace, /machines\.length > 0[\s\S]*data-machine-pairing-scan[\s\S]*sf\.scanAnotherMachine/, "configured Machines must keep an explicit scan-another action")
})

test("every saved Machine can show a phone pairing QR from the Machines list", () => {
  const dialog = readFileSync(new URL("./components/machine-pairing-dialog.tsx", import.meta.url), "utf8")
  const workspace = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
  const css = readFileSync(new URL("./machine-pairing.css", import.meta.url), "utf8")
  const baseCSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8")

  // The dialog asks the daemon it opened on for a fresh grant and polls the same route for the
  // claim/expiry truth, instead of rendering whatever the startup terminal announced.
  assert.match(dialog, /requestMachinePairingGrant\(machine\.config\)/)
  assert.match(dialog, /readMachinePairingGrantStatus\(machine\.config\)/)
  assert.match(dialog, /window\.setInterval\(poll, PAIRING_STATUS_POLL_MS\)/)
  // The QR is drawn client-side from the daemon's one-time URI and re-renders per chosen address.
  assert.match(dialog, /pairingQRCode\(link\.uri\)/)
  assert.match(dialog, /data-machine-pairing-qr/)
  assert.match(dialog, /grant\.links\.length > 1[\s\S]{0,400}data-machine-pairing-address/)
  // Countdown, claimed confirmation, expiry and regeneration are all real states.
  assert.match(dialog, /pairingCountdown\(state\.grant\.expiresAt - now\)/)
  assert.match(dialog, /data-machine-pairing-countdown/)
  assert.match(dialog, /status\.claimed[\s\S]{0,120}phase: "claimed"/)
  assert.match(dialog, /status\.expired[\s\S]{0,120}phase: "expired"/)
  assert.match(dialog, /data-machine-pairing-claimed/)
  assert.match(dialog, /data-machine-pairing-regenerate/)
  assert.match(dialog, /data-machine-pairing-another/)
  // A loopback-bound daemon shows the explanation instead of a dead QR, and an old daemon that
  // predates the grant route (404/405) is told to update rather than to retry the same code.
  assert.match(dialog, /grant\.loopbackOnly[\s\S]{0,120}phase: "loopback"/)
  assert.match(dialog, /pair\.loopbackBody/)
  // A loopback-bound desktop-local runtime is not a terminal-only dead end: the dialog offers the
  // jump to this computer's settings, where LAN pairing can be switched on in place. Remote
  // machines keep the plain explanation.
  assert.match(dialog, /onOpenSettings[\s\S]{0,120}pair\.loopbackLocalHint/)
  assert.match(dialog, /data-machine-pairing-loopback-local/)
  assert.match(dialog, /data-machine-pairing-open-settings/)
  assert.match(dialog, /pair\.loopbackLocalAction/)
  assert.match(dialog, /reason\.status === 404 \|\| reason\.status === 405/)
  assert.match(dialog, /pair\.unsupportedBody/)
  assert.match(dialog, /data-machine-pairing-no-address/)
  assert.match(dialog, /data-machine-pairing-failed/)
  // Modal behaviour: the shared dismiss hook owns Escape, and the backdrop click only closes the dialog.
  assert.match(dialog, /useDialogDismiss\(dialogRef, onClose\)/)
  assert.match(dialog, /aria-modal="true"/)

  // Machine cards expose the action for every machine; the nested dialog takes over Escape while
  // open so dismissing it does not also throw away the Machines list underneath.
  assert.match(workspace, /data-machine-pair-phone onClick=\{\(\) => setPairingMachineID\(machine\.id\)\}[\s\S]{0,120}pair\.action/)
  assert.match(workspace, /useDialogDismiss\(dialogRef, dismiss, \{ enabled: !pairingMachine \}\)/)
  assert.match(workspace, /pairingMachine \? <MachinePairingDialog machine=\{pairingMachine\} onClose=\{\(\) => setPairingMachineID\(null\)\} onOpenSettings=\{isDesktopLocalMachine\(pairingMachine\) \? onOpenSettings : undefined\}/)
  assert.match(workspace, /onOpenSettings=\{showSettings\}/, "the loopback jump must open the app Settings page, not a machine editor")

  // LAN pairing is the local daemon's network exposure, an app-level setting: the toggle lives in
  // the app Settings page, applies immediately through the main process, and re-syncs from its
  // answer, so a cancelled native confirmation snaps the checkbox back instead of lying about the
  // runtime's bind. The machine editor configures machines and must not grow the toggle back.
  assert.match(workspace, /function MobileSettingsPage[\s\S]*machine\.networkPairingEnable/)
  assert.match(workspace, /machine\.networkPairingHint/)
  assert.match(workspace, /data-settings-network-pairing/)
  assert.match(workspace, /setDesktopNetworkSettings\(enabled\)[\s\S]{0,200}setNetwork\(\{ lanPairing: result\.lanPairing \}\)/)
  const editor = workspace.match(/function MachineEditor[\s\S]*?\nfunction MachineManager/)?.[0] || ""
  assert.ok(editor, "the machine editor slice is found")
  assert.doesNotMatch(editor, /networkPairing|NetworkSettings/, "machine settings must not configure the app's own backend")
  // The base sheet's text-field shell (full width, control height, border) used to reach the
  // checkbox too: it rendered as an oversized box squeezing the row text against the 100% width.
  // Checkboxes and radios must stay out of that shell; the settings row sizes its own control.
  assert.match(baseCSS, /input:where\(:not\(\[type="checkbox"\], \[type="radio"\]\)\),/)

  assert.match(css, /\.uw-machine-pairing-backdrop \{/)
  assert.match(css, /\.uw-machine-pairing-qr \{/)
  assert.match(css, /\.uw-machine-pairing-countdown \{/)
  assert.match(css, /\.uw-machine-pairing-actions \{/)
})
