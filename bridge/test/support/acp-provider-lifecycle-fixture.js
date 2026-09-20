import { EventEmitter } from "node:events"
import { createAcpProviderRuntime } from "../../src/acp-provider-runtime.js"
import { MachineDaemon } from "../../src/machine-daemon.js"

class LifecycleClient extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.starts = 0
    this.failNext = false
  }

  async start() {
    this.starts += 1
    if (this.failNext) {
      this.failNext = false
      throw new Error("fixture start failed")
    }
  }
}

class LifecycleCatalog {
  constructor(options) {
    this.options = options
    this.hiddenSessionIDs = new Set()
  }

  async preloadState() {}
}

export async function exerciseAcpProviderLifecycle(provider, {
  config = {
    roots: ["/work/project"],
    stateDirectory: "/state",
    acpCommand: "fixture-acp",
    acpArgs: []
  },
  launch = { command: "fixture-acp", args: [] }
} = {}) {
  const runtime = await createAcpProviderRuntime({
    provider,
    launch,
    config,
    Client: LifecycleClient,
    ModelCatalog: LifecycleCatalog,
    cwd: "/work/project"
  })
  const daemon = new MachineDaemon({ id: "machine_fixture", name: "fixture" })
  const agent = daemon.registerAcpHost(runtime.registration)
  const states = [daemon.registry.host(provider.id).state]

  await agent.start()
  states.push(daemon.registry.host(provider.id).state)

  agent.emit("exit", new Error("fixture crash"))
  states.push(daemon.registry.host(provider.id).state)

  await agent.start()
  states.push(daemon.registry.host(provider.id).state)

  agent.failNext = true
  let restartError
  try {
    await agent.start()
  } catch (error) {
    restartError = error
  }
  states.push(daemon.registry.host(provider.id).state)

  return {
    states,
    restartError,
    starts: agent.starts,
    contract: daemon.registry.host(provider.id).contract,
    runtime,
    daemon
  }
}
