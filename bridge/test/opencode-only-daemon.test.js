import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import http from "node:http"
import test from "node:test"
import { parseDaemonOptions } from "../src/daemon-cli.js"
import { createAgentRoutingServer } from "../src/agent-router.js"
import { MachineDaemon, createMachineDaemonServer } from "../src/machine-daemon.js"
import { TaskLauncher } from "../src/task-launcher.js"

class FakeManagedHost extends EventEmitter {
  constructor() {
    super()
    this.host = "127.0.0.1"
    this.readinessHost = "127.0.0.1"
    this.port = 4096
    this.username = "harness"
    this.password = "secret"
  }
  async start() { this.emit("available") }
  stop() { return true }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function auth() {
  return `Basic ${Buffer.from("harness:secret").toString("base64")}`
}

test("daemon CLI accepts OpenCode as the only primary backend", () => {
  const parsed = parseDaemonOptions([
    "--backend", "opencode",
    "--host", "0.0.0.0",
    "--port", "4097",
    "--username", "harness",
    "--password", "secret",
    "--root", "/repo"
  ], {})

  assert.equal(parsed.config.backend, "opencode")
  assert.equal(parsed.config.host, "0.0.0.0")
  assert.equal(parsed.config.port, 4097)
  assert.deepEqual(parsed.config.roots, ["/repo"])
  assert.equal(parsed.openCode, true)
})

test("OpenCode-only mode rejects disabling its only agent", () => {
  assert.throws(() => parseDaemonOptions([
    "--backend", "opencode",
    "--no-opencode"
  ], {}), /cannot be combined with --no-opencode/)
})

test("machine server accepts a managed HTTP agent as primary without ACP", () => {
  const daemon = new MachineDaemon({ id: "machine_open", name: "phone-test" })
  const openCode = new FakeManagedHost()
  daemon.registerManagedHttpHost({ id: "opencode", label: "OpenCode", host: openCode })

  const httpBridge = { marker: "http-bridge" }
  const routed = { marker: "router" }
  const launched = { marker: "launch" }
  const finished = { marker: "finish" }
  let httpBridgeOptions
  let routerOptions

  const value = createMachineDaemonServer({
    daemon,
    config: { backend: "opencode", roots: ["/repo"], stateDirectory: "/tmp/harness-open-test" },
    primaryAgentID: "opencode",
    primaryAcp: undefined,
    taskStore: { list: async () => [] },
    worktreeManager: {},
    createHttpBridge: (options) => { httpBridgeOptions = options; return httpBridge },
    createRouter: (options) => { routerOptions = options; return routed },
    createLaunchServer: () => launched,
    createFinishServer: () => finished
  })

  assert.equal(value, finished)
  assert.equal(httpBridgeOptions.host, openCode)
  assert.equal(routerOptions.bridgeServer, httpBridge)
  assert.equal(routerOptions.primaryAgentID, "opencode")
})

test("one public daemon port serves machine routes and legacy OpenCode routes", async () => {
  const daemon = new MachineDaemon({ id: "machine_open", name: "phone-test" })
  const openCode = new FakeManagedHost()
  daemon.registerManagedHttpHost({ id: "opencode", label: "OpenCode", backend: "opencode", host: openCode })
  await daemon.startManagedHosts()

  const bridgeServer = http.createServer((request, response) => {
    if (request.url === "/session") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify([{ id: "ses_open", title: "OpenCode session" }]))
      return
    }
    response.writeHead(404)
    response.end()
  })

  const tasks = []
  const taskStore = {
    list: async () => tasks,
    create: async ({ project, agentId, prompt }) => {
      const task = { id: "task_open", projectId: project.id, project, agentId, prompt, status: "draft", workspace: { mode: "project", path: project.path } }
      tasks.push(task)
      return task
    }
  }
  const project = { id: "project_open", machineId: "machine_open", name: "repo", path: "/repo", kind: "directory" }
  const server = createAgentRoutingServer({
    daemon,
    config: { username: "harness", password: "secret", corsOrigins: [] },
    primaryAgentID: "opencode",
    bridgeServer,
    taskStore,
    projectCatalog: async () => [project],
    worktreeManager: {}
  })
  const port = await listen(server)

  try {
    const headers = { Authorization: auth() }
    const machineResponse = await fetch(`http://127.0.0.1:${port}/v1/machine`, { headers })
    assert.equal(machineResponse.status, 200)
    const machine = await machineResponse.json()
    assert.equal(machine.machine.id, "machine_open")
    assert.equal(machine.agents.length, 1)
    assert.equal(machine.agents[0].id, "opencode")
    assert.equal(machine.agents[0].state, "available")

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/session`, { headers })
    assert.equal(sessionResponse.status, 200)
    assert.equal((await sessionResponse.json())[0].id, "ses_open")

    const taskResponse = await fetch(`http://127.0.0.1:${port}/v1/tasks`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, agentId: "opencode", prompt: "Create smoke.txt" })
    })
    assert.equal(taskResponse.status, 201)
    const task = await taskResponse.json()
    assert.equal(task.agentId, "opencode")
    assert.equal(task.prompt, "Create smoke.txt")
  } finally {
    await close(server)
  }
})

test("TaskLauncher creates an OpenCode session and starts the task prompt", async () => {
  const daemon = new MachineDaemon({ id: "machine_open", name: "phone-test" })
  const openCode = new FakeManagedHost()
  daemon.registerManagedHttpHost({ id: "opencode", label: "OpenCode", backend: "opencode", host: openCode })
  await daemon.startManagedHosts()

  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).includes("/session?directory=")) {
      return new Response(JSON.stringify({ id: "ses_task" }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (String(url).includes("/session/ses_task/prompt_async?directory=")) {
      return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404, headers: { "Content-Type": "application/json" } })
  }

  const launcher = new TaskLauncher({ daemon, fetchImpl })
  const task = {
    id: "task_open",
    agentId: "opencode",
    prompt: "Create smoke.txt",
    workspace: { mode: "worktree", path: "/repo/.worktrees/task_open" }
  }
  const session = await launcher.createSession(task)
  assert.equal(session.sessionId, "ses_task")
  assert.equal(session.transport, "http")
  await launcher.startPrompt(task, session)

  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/session\?directory=%2Frepo%2F\.worktrees%2Ftask_open$/)
  assert.equal(calls[0].options.method, "POST")
  assert.match(calls[0].options.headers.Authorization, /^Basic /)
  assert.match(calls[1].url, /\/session\/ses_task\/prompt_async\?directory=%2Frepo%2F\.worktrees%2Ftask_open$/)
  assert.equal(JSON.parse(calls[1].options.body).parts[0].text, "Create smoke.txt")
})
