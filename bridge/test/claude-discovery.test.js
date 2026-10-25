import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { claudeAdapterEnvironment, findClaudeExecutable } from "../src/executable-discovery.js"

test("Claude discovery prefers an explicit executable and finds the CLI on PATH", () => {
  const onPath = path.join("/tools", "claude")
  const explicit = path.join("/custom", "claude")
  const exists = (value) => value === explicit || value === onPath
  assert.equal(findClaudeExecutable({ pathValue: "/tools", exists, access() {} }), onPath)
  assert.equal(findClaudeExecutable({ claudePath: explicit, pathValue: "/tools", exists, access() {} }), explicit)
  assert.equal(findClaudeExecutable({ pathValue: "", exists: () => false }), null)
})

test("Claude discovery falls back to the official user-local install", () => {
  const home = path.join("/home", "person")
  const expected = path.join(home, ".local", "bin", "claude")
  const options = {
    pathValue: "",
    homeDirectory: home,
    exists: (value) => value === expected,
    access() {}
  }
  assert.equal(findClaudeExecutable(options), expected)
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
