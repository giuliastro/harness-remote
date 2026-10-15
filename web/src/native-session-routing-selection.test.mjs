import assert from "node:assert/strict"
import { nativeSessionRouteChanged } from "./native-session-routing.ts"

const routing = { currentMachineID: "machine-1" }

assert.equal(
  nativeSessionRouteChanged(routing, false, "mimo", "claude"),
  false,
  "a transient agent mismatch must not create a linked Session"
)
assert.equal(
  nativeSessionRouteChanged(routing, true, "mimo", "claude"),
  true,
  "an explicitly selected different harness must still route the next prompt"
)
assert.equal(
  nativeSessionRouteChanged(routing, true, "claude", "claude"),
  false,
  "returning to the current harness must stay on the open Session"
)
assert.equal(
  nativeSessionRouteChanged(undefined, true, "mimo", "claude"),
  false,
  "without routing support the composer must never create a handoff"
)

console.log("native Session route-selection tests passed")
