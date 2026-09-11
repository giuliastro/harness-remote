import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { MachineDaemon, createMachineDaemonServer } from "../src/machine-daemon.js"

class FakeAcp extends EventEmitter {
  async start() {}
  close() {}
}

test("machine daemon wires the cross-machine target boundary behind the native Session claim layer", () => {
  const daemon = new MachineDaemon({ id: "machine-target", name: "target" })
  const acp = new FakeAcp()
  daemon.registerAcpHost({ id: "pi", agent: acp, capabilities: { sessions: true } })

  const projects = async () => [{
    id: "machine-target:repo",
    machineId: "machine-target",
    name: "repo",
    path: "/repo",
    kind: "git"
  }]
  const ledger = { marker: "operation-ledger" }
  const links = { marker: "session-links" }
  const claimServer = { marker: "claim" }
  const targetServer = { marker: "cross-machine-target" }
  let handoffOptions
  let launchOptions

  const value = createMachineDaemonServer({
    daemon,
    config: { backend: "pi", port: 4097 },
    primaryAcp: acp,
    projectCatalog: projects,
    sessionOperationLedger: ledger,
    sessionLinkStore: links,
    createServer: () => ({
      acpService: {
        async listSessions() { return [] },
        async createSession() { return { id: "target-native-1", directory: "/repo" } },
        async claimSession() { return true },
        async prompt() {},
        async abort() {}
      },
      emit() {}
    }),
    createRouter: () => ({ marker: "router" }),
    createClaimServer: () => claimServer,
    createCrossMachineHandoffServerFactory: (options) => {
      handoffOptions = options
      return targetServer
    },
    createLaunchServer: (options) => {
      launchOptions = options
      return options.innerServer
    },
    createModelServer: ({ innerServer }) => innerServer,
    createFinishServer: ({ innerServer }) => innerServer,
    createWorkThreadServerFactory: ({ innerServer }) => innerServer
  })

  assert.equal(value, targetServer)
  assert.equal(handoffOptions.innerServer, claimServer)
  assert.equal(handoffOptions.projectCatalog, projects)
  assert.equal(handoffOptions.operationLedger, ledger)
  assert.equal(typeof handoffOptions.createTargetSession, "function")
  assert.equal(typeof handoffOptions.reconcileTargetSession, "function")
  assert.equal(launchOptions.innerServer, targetServer)
})
