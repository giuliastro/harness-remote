import assert from "node:assert/strict"
import test from "node:test"
import { nativeSessionRouteTargetRecord } from "./native-session-routing.ts"

const source = {
  machineID: "machine-1",
  agentID: "codex",
  agentLabel: "Codex CLI",
  backend: "codex",
  transport: "acp",
  sessionID: "source-session",
  directory: "/work/project",
  title: "Source",
  ref: { machineID: "machine-1", agentID: "codex", sessionID: "source-session", directory: "/work/project" },
  config: { backend: "codex", agentId: "codex", host: "127.0.0.1", port: 4097, username: "harness", password: "test" }
}
const ref = { machineID: "machine-1", agentID: "target", sessionID: "target-session", directory: "/work/project" }

for (const [id, label] of [
  ["opencode", "OpenCode"],
  ["opencode2", "OpenCode 2"],
  ["copilot", "GitHub Copilot CLI"],
  ["mimo", "MiMo Code"],
  ["codex", "Codex CLI"],
  ["claude", "Claude Code"],
  ["omp", "Oh My Pi"],
  ["pi", "PI"]
]) {
  test(`same-machine continuation preserves provider identity for ${id}`, () => {
    const record = nativeSessionRouteTargetRecord(source, { ...ref, agentID: id }, {
      id,
      label,
      backend: id,
      transport: id === "opencode" ? "http" : "acp",
      managed: true,
      state: "available",
      capabilities: { sessions: true, prompt: true, abort: true, models: id === "opencode2" }
    })
    assert.equal(record.agentId, id)
    assert.equal(record.backend, id)
    assert.equal(record.agentLabel, label)
  })
}

test("routing prefers the provider registry backend when it differs from a display/agent id", () => {
  const record = nativeSessionRouteTargetRecord(source, { ...ref, agentID: "provider-alias" }, {
    id: "provider-alias",
    label: "Provider Alias",
    backend: "provider-runtime-id",
    transport: "acp",
    managed: true,
    state: "available",
    capabilities: { sessions: true, prompt: true }
  })
  assert.equal(record.backend, "provider-runtime-id")
  assert.equal(record.agentId, "provider-alias")
})
