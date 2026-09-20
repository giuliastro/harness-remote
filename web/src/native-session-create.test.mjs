import assert from "node:assert/strict"
import { api } from "./api.ts"
import { canCreateNativeSession, createNativeSessionTarget } from "./native-session-create.ts"

const originalCreateSession = api.createSession

const baseConfig = {
  backend: "opencode",
  host: "machine.invalid",
  port: 4097,
  username: "harness",
  password: "secret"
}

const agent = {
  id: "codex",
  label: "Codex",
  backend: "codex",
  transport: "acp",
  managed: true,
  state: "available",
  capabilities: {
    sessions: true,
    prompt: true,
    abort: true,
    models: true,
    sessionRename: true,
    sessionDelete: true
  },
  contract: {
    sessions: {
      stop: "owned-session-native-cancel"
    }
  }
}

assert.equal(canCreateNativeSession({ ...agent, transport: "stdio" }), false, "native create must reject transports outside the validated ACP/HTTP surface")
assert.equal(canCreateNativeSession({ ...agent, capabilities: { ...agent.capabilities, sessions: false } }), false, "native create must honor an explicit sessions=false capability")
assert.equal(canCreateNativeSession({ ...agent, capabilities: { ...agent.capabilities, prompt: false } }), false, "native create must honor an explicit prompt=false capability")

try {
  const calls = []
  api.createSession = async (...args) => {
    calls.push(args)
    return {
      id: "ses-new",
      title: "Implement the fix",
      directory: "/repo/project",
      time: { created: 1, updated: 2 },
      model: {
        providerID: "openai",
        id: "gpt-test",
        variant: "high"
      }
    }
  }

  const { target, record } = await createNativeSessionTarget({
    machineID: "machine-1",
    baseConfig,
    agent,
    directory: "/repo/project",
    title: "  Implement the fix  "
  })

  assert.equal(calls.length, 1, "native create must issue exactly one harness Session creation")
  const [config, title, model, directory] = calls[0]
  assert.deepEqual(config, {
    ...baseConfig,
    backend: "codex",
    agentId: "codex"
  }, "native create must scope the request to the selected harness")

  const dynamicAgent = { ...agent, id: "mimo", label: "MiMo Code", backend: "mimo" }
  const dynamic = await createNativeSessionTarget({
    machineID: "machine-1",
    baseConfig,
    agent: dynamicAgent,
    directory: "/repo/project"
  })
  const [dynamicConfig] = calls.at(-1)
  assert.equal(dynamicConfig.backend, "mimo", "dynamic providers must never fall back to the saved OpenCode backend")
  assert.equal(dynamicConfig.agentId, "mimo")
  assert.equal(dynamic.record.backend, "mimo")
  assert.equal(title, "Implement the fix", "native create must trim the optional title")
  assert.equal(model, undefined, "native create must not invent or reuse a stale explicit model")
  assert.equal(directory, "/repo/project", "native create must stay in the selected Project directory")

  assert.equal(record.key, "codex:ses-new")
  assert.equal(record.writerOwned, true, "a Session created by this daemon must already be writer-owned")
  assert.equal(record.backend, "codex")
  assert.equal(record.modelsSupported, true)
  assert.equal(record.renameSupported, true)
  assert.equal(record.deleteSupported, true)

  assert.equal(target.machineID, "machine-1")
  assert.equal(target.sessionID, "ses-new")
  assert.equal(target.agentID, "codex")
  assert.equal(target.directory, "/repo/project")
  assert.equal(target.requiresExplicitClaim, false, "fresh ACP Sessions must not ask the user for a redundant claim")
  assert.equal(target.canStop, true)
  assert.deepEqual(target.model, {
    providerID: "openai",
    modelID: "gpt-test",
    variant: "high"
  })

  api.createSession = async () => ({
    title: "Missing id",
    directory: "/repo/project"
  })
  await assert.rejects(
    createNativeSessionTarget({
      machineID: "machine-1",
      baseConfig,
      agent,
      directory: "/repo/project"
    }),
    /did not return a native Session id/,
    "native create must fail closed when the harness does not return an identity"
  )
} finally {
  api.createSession = originalCreateSession
}

console.log("native Session create behavioral tests passed")
