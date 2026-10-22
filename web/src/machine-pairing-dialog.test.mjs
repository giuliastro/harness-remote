import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MachineHttpError } from "./machine-request-error.ts"
import {
  MachinePairingDialog,
  PAIRING_STATUS_POLL_MS,
  pairingCountdown,
  pairingFailureState,
  preferredPairingEndpoint
} from "./components/machine-pairing-dialog.tsx"

const machine = {
  id: "studio-pc",
  name: "Studio PC",
  config: { backend: "opencode", host: "192.168.1.20", port: 4097, username: "harness", password: "secret" }
}

const link = (endpoint) => ({
  endpoint,
  uri: `harnessremote://pair?endpoint=${encodeURIComponent(endpoint)}&token=${"a".repeat(43)}&expires=${Date.now() + 60_000}`
})

test("the pairing countdown formats M:SS and clamps an expired code at zero", () => {
  assert.equal(pairingCountdown(300_000), "5:00")
  assert.equal(pairingCountdown(61_000), "1:01")
  assert.equal(pairingCountdown(59_000), "0:59")
  assert.equal(pairingCountdown(1), "0:01")
  assert.equal(pairingCountdown(0), "0:00")
  assert.equal(pairingCountdown(-2_500), "0:00")
  assert.equal(PAIRING_STATUS_POLL_MS, 2_000, "a claim must be confirmed within seconds of it happening")
})

test("regenerating keeps the address the user picked when the new grant still offers it", () => {
  const grant = {
    expiresAt: Date.now() + 300_000,
    loopbackOnly: false,
    links: [link("http://192.168.1.20:4097"), link("http://10.0.0.5:4097")]
  }
  assert.equal(preferredPairingEndpoint(grant, "http://10.0.0.5:4097"), "http://10.0.0.5:4097", "an offered address must survive regeneration")
  assert.equal(preferredPairingEndpoint(grant, "http://192.168.99.99:4097"), "http://192.168.1.20:4097", "a vanished address must fall back to the daemon's first choice")
  assert.equal(preferredPairingEndpoint(grant, null), "http://192.168.1.20:4097")
  assert.equal(preferredPairingEndpoint({ expiresAt: grant.expiresAt, loopbackOnly: false, links: [] }, "http://192.168.1.20:4097"), null)
})

test("a daemon without the grant route maps to the update story; other failures keep their detail", () => {
  assert.deepEqual(pairingFailureState(new MachineHttpError("no route", 404)), { phase: "unsupported" })
  assert.deepEqual(pairingFailureState(new MachineHttpError("no route", 405)), { phase: "unsupported" })
  assert.deepEqual(
    pairingFailureState(new MachineHttpError("This app is not authorized to manage this machine.", 401)),
    { phase: "failed", detail: "This app is not authorized to manage this machine." }
  )
  assert.deepEqual(
    pairingFailureState(new Error("Cannot reach 192.168.1.20:4097.")),
    { phase: "failed", detail: "Cannot reach 192.168.1.20:4097." }
  )
  assert.deepEqual(pairingFailureState("boom"), { phase: "failed", detail: "The pairing request failed." })
})

test("the pairing dialog opens as a modal on the named machine and starts by issuing a grant", () => {
  const markup = renderToStaticMarkup(createElement(MachinePairingDialog, { machine, onClose: () => undefined }))
  assert.match(markup, /role="dialog"/)
  assert.match(markup, /aria-modal="true"/)
  assert.match(markup, /data-machine-pairing-phase="preparing"/)
  assert.match(markup, /Preparing a pairing code…/)
  assert.match(markup, /Studio PC/)
})

console.log("machine pairing dialog behavioral tests passed")
