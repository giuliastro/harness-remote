import assert from "node:assert/strict"
import test from "node:test"
import { claudeAdapterEnvironment, findClaudeExecutable } from "../src/executable-discovery.js"

test("Claude discovery prefers an explicit executable and finds the CLI on PATH", () => {
  const exists = (value) => value === "/custom/claude" || value === "/tools/claude"
  assert.equal(findClaudeExecutable({ pathValue: "/tools", exists, access() {} }), "/tools/claude")
  assert.equal(findClaudeExecutable({ claudePath: "/custom/claude", pathValue: "/tools", exists, access() {} }), "/custom/claude")
  assert.equal(findClaudeExecutable({ pathValue: "", exists: () => false }), null)
})

test("Claude discovery falls back to the official user-local install", () => {
  const home = "/home/person"
  const options = {
    pathValue: "",
    homeDirectory: home,
    exists: (value) => value === "/home/person/.local/bin/claude",
    access() {}
  }
  assert.equal(findClaudeExecutable(options), "/home/person/.local/bin/claude")
})

test("the Claude adapter receives CLAUDE_CODE_EXECUTABLE without overriding an explicit value", () => {
  assert.deepEqual(claudeAdapterEnvironment({
    environment: { PATH: "/tools" },
    find: () => "/tools/claude"
  }), { CLAUDE_CODE_EXECUTABLE: "/tools/claude" })
  assert.deepEqual(claudeAdapterEnvironment({
    environment: { CLAUDE_CODE_EXECUTABLE: "/custom/claude" },
    find() { throw new Error("must not override") }
  }), { CLAUDE_CODE_EXECUTABLE: "/custom/claude" })
  assert.deepEqual(claudeAdapterEnvironment({ environment: {}, find: () => null }), {})
})
