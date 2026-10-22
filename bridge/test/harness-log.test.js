import assert from "node:assert/strict"
import test from "node:test"
import { createHarnessLogWriter, isHarnessErrorLine } from "../src/harness-log.js"

const replayTrace = "[session/replay] sessionId=1687613f-544a-444f-a02e-394311c5d52f phase=read durationMs=0 messages=247"
const unrecognisedEvent = 'Unexpected case: {"type":"system","subtype":"code_change_published","provider":"github","action":"created","error":null}'

test("treats adapter traces and unrecognised SDK events as diagnostics", () => {
  assert.equal(isHarnessErrorLine(replayTrace), false)
  assert.equal(isHarnessErrorLine("[session/load] sessionId=1 phase=replay durationMs=87 totalMs=1206"), false)
  assert.equal(isHarnessErrorLine(unrecognisedEvent), false)
  assert.equal(isHarnessErrorLine("Each session event is replayed once"), false)
  assert.equal(isHarnessErrorLine(""), false)
})

test("recognises failures in harness stderr", () => {
  assert.equal(isHarnessErrorLine("Error: Claude Code executable not found"), true)
  assert.equal(isHarnessErrorLine("Authentication failed, run claude /login"), true)
  assert.equal(isHarnessErrorLine("spawn claude ENOENT"), true)
  assert.equal(isHarnessErrorLine("TypeError: Cannot read properties of undefined"), true)
})

test("forwards only errors by default and everything when verbose", () => {
  const quiet = []
  const writeQuiet = createHarnessLogWriter({ write: (text) => quiet.push(text) })
  writeQuiet("claude", replayTrace)
  writeQuiet("claude", unrecognisedEvent)
  writeQuiet("claude", "Error: session not found")
  assert.deepEqual(quiet, ["[claude] Error: session not found\n"])

  const verbose = []
  const writeVerbose = createHarnessLogWriter({ verbose: true, write: (text) => verbose.push(text) })
  writeVerbose("claude", replayTrace)
  writeVerbose("claude", unrecognisedEvent)
  assert.deepEqual(verbose, [`[claude] ${replayTrace}\n`, `[claude] ${unrecognisedEvent}\n`])
})
