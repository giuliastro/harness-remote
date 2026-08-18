import { readFileSync, writeFileSync } from "node:fs"

function update(path, transform) {
  const before = readFileSync(path, "utf8")
  const after = transform(before)
  if (after === before) throw new Error(`No change applied to ${path}`)
  writeFileSync(path, after)
}

function replaceExact(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected source block: ${label}`)
  return source.replace(before, after)
}

update("bridge/src/harness-profiles.js", (source) => {
  source = source.replaceAll("@automatalabs/pi-acp@0.2.5", "@automatalabs/pi-acp@0.3.0")
  source = replaceExact(source,
`    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    // PI may flush the last replay chunks just after session/load resolves, most visibly on Windows.
    replaySettleMs: 250,`,
`    preserveListedTimestamps: true,
    // Opening a PI session explicitly asks the bridge for fresh history. Honour that request so a
    // stale bridge snapshot can never hide assistant output that PI has already persisted.
    reloadOnHistoryRefresh: true,
    // PI owns its display names. The app must show the same title as PI /resume and propagate rename
    // through PI's own /name command rather than maintaining a competing bridge-only nickname.
    preferListedTitles: true,
    nativeRenameCommand: "name",
    // "pi-acp" is a binary name used by more than one package. Use the exact pinned adapter below
    // unless the user explicitly overrides --acp-command/--acp-arg.
    preferInstalledAdapter: false,
    // PI may flush the last replay chunks just after session/load resolves, most visibly on Windows.
    replaySettleMs: 250,`, "PI profile metadata")
  source = replaceExact(source,
`  const installed = find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }`,
`  const installed = profile.preferInstalledAdapter === false ? undefined : find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }`, "adapter path preference")
  return source
})

update("bridge/src/server.js", (source) => replaceExact(source,
`  const service = new AcpService(acp, { ...serviceOptions, actionProviders: profile.actionProviders })`,
`  const service = new AcpService(acp, {
    ...serviceOptions,
    actionProviders: profile.actionProviders,
    preferListedTitles: profile.preferListedTitles,
    nativeRenameCommand: profile.nativeRenameCommand
  })`, "AcpService profile options"))

update("bridge/src/acp-service.js", (source) => {
  source = replaceExact(source,
`  #preserveListedTimestamps
  #reloadOnHistoryRefresh
  #replaySettleMs`,
`  #preserveListedTimestamps
  #reloadOnHistoryRefresh
  #replaySettleMs
  #preferListedTitles
  #nativeRenameCommand`, "service fields")
  source = replaceExact(source,
`    preserveListedTimestamps = false,
    reloadOnHistoryRefresh = true,
    replaySettleMs = 0,
    actionProviders = []`,
`    preserveListedTimestamps = false,
    reloadOnHistoryRefresh = true,
    replaySettleMs = 0,
    preferListedTitles = false,
    nativeRenameCommand,
    actionProviders = []`, "service constructor options")
  source = replaceExact(source,
`    this.#preserveListedTimestamps = preserveListedTimestamps
    this.#reloadOnHistoryRefresh = reloadOnHistoryRefresh
    this.#replaySettleMs = replaySettleMs
    this.#actionProviders = actionProviders`,
`    this.#preserveListedTimestamps = preserveListedTimestamps
    this.#reloadOnHistoryRefresh = reloadOnHistoryRefresh
    this.#replaySettleMs = replaySettleMs
    this.#preferListedTitles = preferListedTitles
    this.#nativeRenameCommand = nativeRenameCommand
    this.#actionProviders = actionProviders`, "service constructor assignments")

  source = replaceExact(source,
`  async renameSession(sessionID, title) {
    const normalized = title.trim()
    if (!normalized) throw new Error("A session title is required")
    await this.#requireSession(sessionID)
    this.#titles.set(sessionID, normalized)
    this.#persistSnapshot(sessionID)
    this.#emit("session.updated", sessionID)
    return sessionView(
      this.#sessions.get(sessionID),
      this.#isBusy(sessionID) ? "busy" : "idle",
      normalized,
      Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    )
  }`,
`  async renameSession(sessionID, title) {
    const normalized = title.trim().replace(/\\s+/g, " ")
    if (!normalized) throw new Error("A session title is required")
    await this.#requireSession(sessionID)

    if (this.#nativeRenameCommand) {
      // A native PI rename must operate on the real resumed session. Keep it out of the visible
      // transcript: /name changes PI metadata, it is not a user/model turn.
      await this.#load(sessionID, true)
      const messagesBefore = structuredClone(this.#messages.get(sessionID) ?? [])
      const todosBefore = structuredClone(this.#todos.get(sessionID) ?? [])
      const command = \`/\${this.#nativeRenameCommand} \${normalized}\`
      const wasActive = this.#active.has(sessionID)
      if (!wasActive) this.#active.add(sessionID)
      try {
        await this.#acp.request("session/prompt", {
          sessionId: sessionID,
          prompt: [{ type: "text", text: command }]
        }, 300_000)
      } finally {
        if (!wasActive) this.#active.delete(sessionID)
        this.#messages.set(sessionID, messagesBefore)
        this.#todos.set(sessionID, todosBefore)
        this.#chunkMessageIDs.delete(\`\${sessionID}:user\`)
        this.#chunkMessageIDs.delete(\`\${sessionID}:assistant\`)
      }

      // Do not leave an old bridge nickname in front of PI's authoritative title. A fresh list
      // reads the name PI persisted, which is the same name its /resume picker will show.
      this.#titles.delete(sessionID)
      await this.#refreshSessions()
      const session = this.#sessions.get(sessionID)
      if (!session) throw new Error("Harness session not found after rename")
      this.#persistSnapshot(sessionID)
      this.#emit("session.updated", sessionID)
      return sessionView(
        session,
        this.#isBusy(sessionID) ? "busy" : "idle",
        this.#titleFor(sessionID),
        Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
      )
    }

    this.#titles.set(sessionID, normalized)
    this.#persistSnapshot(sessionID)
    this.#emit("session.updated", sessionID)
    return sessionView(
      this.#sessions.get(sessionID),
      this.#isBusy(sessionID) ? "busy" : "idle",
      normalized,
      Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    )
  }`, "native rename")

  source = replaceExact(source,
`      if (typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)`,
`      if (!this.#preferListedTitles && typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)`, "native-title snapshot migration")

  source = replaceExact(source,
`  #titleFor(sessionID) {
    const known = this.#titles.get(sessionID)
    if (known) return known
    const firstPrompt = this.#messages.get(sessionID)?.find((message) => message.info.role === "user")
    const text = firstPrompt?.parts?.[0]?.text?.trim()
    if (!text) return undefined
    const derived = text.split("\\n")[0].slice(0, 60)
    this.#titles.set(sessionID, derived)
    return derived
  }`,
`  #titleFor(sessionID) {
    const listed = this.#sessions.get(sessionID)?.title?.trim()
    if (this.#preferListedTitles && listed) return listed
    const known = this.#titles.get(sessionID)
    if (known) return known
    const firstPrompt = this.#messages.get(sessionID)?.find((message) => message.info.role === "user")
    const text = firstPrompt?.parts?.[0]?.text?.trim()
    if (!text) return undefined
    const derived = text.split("\\n")[0].slice(0, 60)
    this.#titles.set(sessionID, derived)
    return derived
  }`, "native title preference")
  return source
})

update("bridge/test/config.test.js", (source) => source.replaceAll("@automatalabs/pi-acp@0.2.5", "@automatalabs/pi-acp@0.3.0"))

for (const path of ["README.md", "docs/DEPENDENCIES.md"]) {
  update(path, (source) => source.replaceAll("@automatalabs/pi-acp@0.2.5", "@automatalabs/pi-acp@0.3.0"))
}

update("README.md", (source) => {
  source = source.replace(
    "PI supports session listing, history replay, streaming prompts, cancellation, queued follow-up prompts, model selection, and bridge-local rename/delete.",
    "PI supports session listing, history replay, streaming prompts, cancellation, queued follow-up prompts, model selection, native rename, and bridge-local delete."
  )
  source = source.replace(
    "The nickname and hidden-session records live under the bridge state directory: clearing or moving it restores PI's native title and listing. ACP does not define physical session deletion, so deleted sessions remain in PI's own history.",
    "PI renames are propagated through PI's native `/name` command, so Harness Remote and PI's `/resume` list use the same display name. Hidden-session records remain bridge-local: clearing or moving the bridge state directory makes hidden sessions visible again. ACP does not define physical session deletion, so deleted sessions remain in PI's own history."
  )
  return source
})

writeFileSync("bridge/test/pi-native-history-metadata.test.js", `import assert from "node:assert/strict"\nimport { EventEmitter } from "node:events"\nimport test from "node:test"\nimport { AcpService } from "../src/acp-service.js"\nimport { HARNESS_PROFILES, resolveAcpLaunch } from "../src/harness-profiles.js"\n\nclass PiHistoryAcp extends EventEmitter {\n  constructor() {\n    super()\n    this.title = "PI native title"\n    this.loadCount = 0\n    this.prompts = []\n  }\n\n  async listSessions() {\n    return [{ sessionId: "pi-session", cwd: process.cwd(), title: this.title, updatedAt: new Date().toISOString() }]\n  }\n\n  async request(method, params) {\n    if (method === "session/load") {\n      this.loadCount += 1\n      this.emit("notification", {\n        method: "session/update",\n        params: { sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", messageId: "user-1", content: { type: "text", text: "First prompt" } } }\n      })\n      if (this.loadCount > 1) {\n        this.emit("notification", {\n          method: "session/update",\n          params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "Persisted PI answer" } } }\n        })\n      }\n      return { configOptions: [] }\n    }\n    if (method === "session/prompt") {\n      const text = params.prompt?.[0]?.text ?? ""\n      this.prompts.push(text)\n      if (text.startsWith("/name ")) this.title = text.slice(6)\n      return { stopReason: "end_turn" }\n    }\n    throw new Error(\`Unexpected request: \${method}\`)\n  }\n}\n\nfunction visible(messages) {\n  return messages.map((message) => ({\n    role: message.info.role,\n    text: message.parts.map((part) => part.text ?? "").join("")\n  }))\n}\n\ntest("PI refresh replaces an incomplete cached replay with fresh native history", async () => {\n  const acp = new PiHistoryAcp()\n  const service = new AcpService(acp, { reloadOnHistoryRefresh: true, preferListedTitles: true })\n\n  assert.deepEqual(visible(await service.messages("pi-session", true)), [{ role: "user", text: "First prompt" }])\n  assert.deepEqual(visible(await service.messages("pi-session", true)), [\n    { role: "user", text: "First prompt" },\n    { role: "assistant", text: "Persisted PI answer" }\n  ])\n  assert.equal(acp.loadCount, 2, "refresh=1 must really call session/load again for PI")\n})\n\ntest("PI list and rename use PI's native display name", async () => {\n  const acp = new PiHistoryAcp()\n  const service = new AcpService(acp, {\n    reloadOnHistoryRefresh: true,\n    preferListedTitles: true,\n    nativeRenameCommand: "name"\n  })\n\n  const listed = await service.listSessions()\n  assert.equal(listed[0].title, "PI native title")\n\n  const renamed = await service.renameSession("pi-session", "Renamed from Harness Remote")\n  assert.equal(acp.prompts.at(-1), "/name Renamed from Harness Remote")\n  assert.equal(renamed.title, "Renamed from Harness Remote")\n  assert.equal((await service.listSessions())[0].title, "Renamed from Harness Remote")\n})\n\ntest("PI uses the exact pinned Automata Labs adapter even if another pi-acp binary is on PATH", () => {\n  const launch = resolveAcpLaunch(HARNESS_PROFILES.pi, { find: () => "/usr/local/bin/pi-acp" })\n  assert.equal(launch.source, "npx")\n  assert.deepEqual(launch.args, ["-y", "@automatalabs/pi-acp@0.3.0"])\n})\n`)
