import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"
import { closeOwnedChildProcess, ownChildProcess } from "../src/managed-child-process.js"

test("waits for native child exit and escalates when SIGTERM can be ignored", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"]
  })
  ownChildProcess(child)
  await once(child.stdout, "data")

  const startedAt = Date.now()
  const closing = closeOwnedChildProcess(child, { graceMs: 100 })
  assert.equal(closeOwnedChildProcess(child, { graceMs: 1 }), closing, "concurrent closes must reuse one promise")
  await closing

  // Windows terminates children immediately for SIGTERM; installing a JS handler cannot ignore it.
  // Unix must instead exhaust the grace period and escalate for this child.
  if (process.platform === "win32") {
    assert.equal(child.signalCode, "SIGTERM", "Windows must observe native termination before close resolves")
  } else {
    assert.equal(child.signalCode, "SIGKILL", "the child that ignored SIGTERM must receive SIGKILL")
    assert.ok(Date.now() - startedAt >= 75, "close must wait through the SIGTERM grace period")
  }
})

test("close resolves for a child that already exited", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
  ownChildProcess(child)
  await once(child, "exit")
  await closeOwnedChildProcess(child)
  assert.equal(child.exitCode, 0)
})
