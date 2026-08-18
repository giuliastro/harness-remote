import assert from "node:assert/strict"
import test from "node:test"
import { harnessProfile } from "../src/harness-profiles.js"
import { PrimeAcpClient } from "../src/prime-acp-client.js"

test("Prime Agent profile uses native ACP mode", () => {
  const profile = harnessProfile("prime")
  assert.equal(profile.command, "prime-agent")
  assert.deepEqual(profile.args, ["--mode", "acp"])
  assert.equal(profile.capabilities.streaming, true)
  assert.equal(profile.capabilities.models, false)
})

test("Prime ACP client treats session listing as empty", async () => {
  const client = new PrimeAcpClient()
  let started = false
  client.start = async () => { started = true }

  assert.deepEqual(await client.listSessions(), [])
  assert.equal(started, true)
})
