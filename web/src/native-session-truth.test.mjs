import assert from "node:assert/strict"
import test from "node:test"
import { corroboratedSessionStatus, WORKING_STATUS_GRACE_MS } from "./native-session-discovery.ts"
import { nativeSessionDisplayTitle } from "./native-session-title.ts"

const now = 1_800_000_000_000

function session(updated) {
  return {
    id: "session-1",
    title: "A Session",
    directory: "/repo",
    time: { created: updated, updated }
  }
}

test("a working status is honoured while the Session is still producing activity", () => {
  const fresh = session(now - 5_000)
  assert.deepEqual(corroboratedSessionStatus(fresh, { type: "busy" }, now), { type: "busy" })
})

test("a working status the Session's own activity contradicts is reported idle", () => {
  const stale = session(now - WORKING_STATUS_GRACE_MS - 1)
  assert.deepEqual(corroboratedSessionStatus(stale, { type: "busy" }, now), { type: "idle" })
})

test("every working synonym is corroborated the same way", () => {
  const stale = session(now - WORKING_STATUS_GRACE_MS - 1)
  for (const type of ["busy", "running", "working", "waiting", "retry", "in_progress", "in-progress"]) {
    assert.equal(corroboratedSessionStatus(stale, { type }, now).type, "idle", type)
  }
})

test("a non-working status is never rewritten, however old the Session is", () => {
  const stale = session(now - WORKING_STATUS_GRACE_MS * 10)
  assert.deepEqual(corroboratedSessionStatus(stale, { type: "error", message: "boom" }, now), { type: "error", message: "boom" })
  assert.deepEqual(corroboratedSessionStatus(stale, { type: "idle" }, now), { type: "idle" })
  assert.equal(corroboratedSessionStatus(stale, undefined, now), undefined)
})

test("a Session with no activity timestamp keeps whatever the harness reported", () => {
  const unknown = { id: "session-2", title: "", directory: "/repo", time: { created: 0, updated: 0 } }
  assert.deepEqual(corroboratedSessionStatus(unknown, { type: "busy" }, now), { type: "busy" })
})

test("an ordinary native title is passed through with whitespace collapsed", () => {
  assert.equal(nativeSessionDisplayTitle("Correggere  glitch\ndell'interfaccia mobile"), "Correggere glitch dell'interfaccia mobile")
  assert.equal(nativeSessionDisplayTitle(""), "Untitled Session")
  assert.equal(nativeSessionDisplayTitle(undefined, "Untitled Codex Session"), "Untitled Codex Session")
})

test("a Session titled with a handoff packet is named by its instruction", () => {
  const flattened = "You are taking over an existing TaskDesk task. The context below was transferred by TaskDesk."
    + " It is not native conversational memory from another harness. TASK OBJECTIVE Lavora sul workspace condiviso"
    + " CURRENT STATE running YOUR ROLE implement TARGET HARNESS codex USER INSTRUCTION Correggi il parser"
    + " Continue from the shared workspace and the transferred Task Context."
  assert.equal(nativeSessionDisplayTitle(flattened), "Correggi il parser")
})

test("a handoff packet with no instruction falls back to its Task objective", () => {
  const flattened = "You are taking over an existing TaskDesk task. The context below was transferred by TaskDesk."
    + " TASK OBJECTIVE Lavora sul workspace condiviso CURRENT STATE running USER INSTRUCTION"
  assert.equal(nativeSessionDisplayTitle(flattened), "Lavora sul workspace condiviso")
})

test("a handoff packet with neither is still named, never shown as its envelope", () => {
  assert.equal(
    nativeSessionDisplayTitle("You are taking over an existing TaskDesk task. The context below was transferred by TaskDesk."),
    "Transferred TaskDesk Task"
  )
})

test("a long recovered title is clipped rather than filling the rail", () => {
  const objective = "x".repeat(400)
  const title = nativeSessionDisplayTitle(`You are taking over an existing TaskDesk task. TASK OBJECTIVE ${objective}`)
  assert.equal(title.length, 160)
  assert.ok(title.endsWith("…"))
})
