import { readFileSync, writeFileSync } from "node:fs"

function edit(path, transform) {
  const before = readFileSync(path, "utf8")
  writeFileSync(path, transform(before))
}
function mustReplace(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected source block: ${label}`)
  return source.replace(before, after)
}

edit("bridge/src/harness-profiles.js", (source) => {
  source = source.replaceAll("@automatalabs/pi-acp@0.2.5", "@automatalabs/pi-acp@0.3.0")
  source = mustReplace(source,
`    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    // PI may flush the last replay chunks just after session/load resolves, most visibly on Windows.
    replaySettleMs: 250,`,
`    preserveListedTimestamps: true,
    // Opening a PI session explicitly asks for fresh history. Honour that request so a stale bridge
    // snapshot cannot hide assistant output that PI has already persisted.
    reloadOnHistoryRefresh: true,
    preferListedTitles: true,
    nativeRenameCommand: "name",
    // Several unrelated packages install a binary named pi-acp. Keep PI deterministic by using the
    // exact Automata Labs package unless the user explicitly overrides the ACP launch command.
    preferInstalledAdapter: false,
    // PI may flush the last replay chunks just after session/load resolves, most visibly on Windows.
    replaySettleMs: 250,`, "PI profile")
  source = mustReplace(source,
`  const installed = find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }`,
`  const installed = profile.preferInstalledAdapter === false ? undefined : find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }`, "adapter launch")
  return source
})

edit("bridge/src/server.js", (source) => mustReplace(source,
`  const service = new AcpService(acp, { ...serviceOptions, actionProviders: profile.actionProviders })`,
`  const service = new AcpService(acp, {
    ...serviceOptions,
    actionProviders: profile.actionProviders,
    preferListedTitles: profile.preferListedTitles,
    nativeRenameCommand: profile.nativeRenameCommand
  })`, "service profile options"))

edit("bridge/src/acp-service.js", (source) => {
  source = mustReplace(source,
`  #preserveListedTimestamps
  #reloadOnHistoryRefresh
  #replaySettleMs`,
`  #preserveListedTimestamps
  #reloadOnHistoryRefresh
  #replaySettleMs
  #preferListedTitles
  #nativeRenameCommand`, "fields")
  source = mustReplace(source,
`    reloadOnHistoryRefresh = true,
    replaySettleMs = 0,
    actionProviders = []`,
`    reloadOnHistoryRefresh = true,
    replaySettleMs = 0,
    preferListedTitles = false,
    nativeRenameCommand,
    actionProviders = []`, "constructor options")
  source = mustReplace(source,
`    this.#reloadOnHistoryRefresh = reloadOnHistoryRefresh
    this.#replaySettleMs = replaySettleMs
    this.#actionProviders = actionProviders`,
`    this.#reloadOnHistoryRefresh = reloadOnHistoryRefresh
    this.#replaySettleMs = replaySettleMs
    this.#preferListedTitles = preferListedTitles
    this.#nativeRenameCommand = nativeRenameCommand
    this.#actionProviders = actionProviders`, "constructor assignments")
  source = mustReplace(source,
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
      await this.#load(sessionID, true)
      const messagesBefore = structuredClone(this.#messages.get(sessionID) ?? [])
      const todosBefore = structuredClone(this.#todos.get(sessionID) ?? [])
      const wasActive = this.#active.has(sessionID)
      if (!wasActive) this.#active.add(sessionID)
      try {
        await this.#acp.request("session/prompt", {
          sessionId: sessionID,
          prompt: [{ type: "text", text: \`/\${this.#nativeRenameCommand} \${normalized}\` }]
        }, 300_000)
      } finally {
        if (!wasActive) this.#active.delete(sessionID)
        this.#messages.set(sessionID, messagesBefore)
        this.#todos.set(sessionID, todosBefore)
        this.#chunkMessageIDs.delete(\`\${sessionID}:user\`)
        this.#chunkMessageIDs.delete(\`\${sessionID}:assistant\`)
      }
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
  source = mustReplace(source,
`      if (typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)`,
`      if (!this.#preferListedTitles && typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)`, "snapshot title")
  source = mustReplace(source,
`  #titleFor(sessionID) {
    const known = this.#titles.get(sessionID)
    if (known) return known`,
`  #titleFor(sessionID) {
    const listed = this.#sessions.get(sessionID)?.title?.trim()
    if (this.#preferListedTitles && listed) return listed
    const known = this.#titles.get(sessionID)
    if (known) return known`, "native title")
  return source
})

edit("bridge/test/config.test.js", (source) => source.replaceAll("@automatalabs/pi-acp@0.2.5", "@automatalabs/pi-acp@0.3.0"))
for (const path of ["README.md", "docs/DEPENDENCIES.md"]) {
  edit(path, (source) => source.replaceAll("@automatalabs/pi-acp@0.2.5", "@automatalabs/pi-acp@0.3.0"))
}
edit("README.md", (source) => source
  .replace(
    "PI supports session listing, history replay, streaming prompts, cancellation, queued follow-up prompts, model selection, and bridge-local rename/delete.",
    "PI supports session listing, history replay, streaming prompts, cancellation, queued follow-up prompts, model selection, native rename, and bridge-local delete."
  )
  .replace(
    "The nickname and hidden-session records live under the bridge state directory: clearing or moving it restores PI's native title and listing. ACP does not define physical session deletion, so deleted sessions remain in PI's own history.",
    "PI renames are propagated through PI's native `/name` command, so Harness Remote and PI's `/resume` list use the same display name. Hidden-session records remain bridge-local: clearing or moving the bridge state directory makes hidden sessions visible again. ACP does not define physical session deletion, so deleted sessions remain in PI's own history."
  ))

writeFileSync("bridge/test/pi-native-history-metadata.test.js", `import assert from "node:assert/strict"\nimport { EventEmitter } from "node:events"\nimport test from "node:test"\nimport { AcpService } from "../src/acp-service.js"\nimport { HARNESS_PROFILES, resolveAcpLaunch } from "../src/harness-profiles.js"\n\nclass PiHistoryAcp extends EventEmitter {\n  constructor() {\n    super()\n    this.title = "PI native title"\n    this.loadCount = 0\n    this.prompts = []\n  }\n  async listSessions() {\n    return [{ sessionId: "pi-session", cwd: process.cwd(), title: this.title, updatedAt: new Date().toISOString() }]\n  }\n  async request(method, params) {\n    if (method === "session/load") {\n      this.loadCount += 1\n      this.emit("notification", { method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", messageId: "user-1", content: { type: "text", text: "First prompt" } } } })\n      if (this.loadCount > 1) this.emit("notification", { method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "Persisted PI answer" } } } })\n      return { configOptions: [] }\n    }\n    if (method === "session/prompt") {\n      const text = params.prompt?.[0]?.text ?? ""\n      this.prompts.push(text)\n      if (text.startsWith("/name ")) this.title = text.slice(6)\n      return { stopReason: "end_turn" }\n    }\n    throw new Error(\`Unexpected request: \${method}\`)\n  }\n}\n\nconst visible = (messages) => messages.map((message) => ({ role: message.info.role, text: message.parts.map((part) => part.text ?? "").join("") }))\n\ntest("PI refresh replays native history instead of keeping an incomplete cache", async () => {\n  const acp = new PiHistoryAcp()\n  const service = new AcpService(acp, { reloadOnHistoryRefresh: true, preferListedTitles: true })\n  assert.deepEqual(visible(await service.messages("pi-session", true)), [{ role: "user", text: "First prompt" }])\n  assert.deepEqual(visible(await service.messages("pi-session", true)), [\n    { role: "user", text: "First prompt" },\n    { role: "assistant", text: "Persisted PI answer" }\n  ])\n  assert.equal(acp.loadCount, 2)\n})\n\ntest("PI list and rename use PI's native display name", async () => {\n  const acp = new PiHistoryAcp()\n  const service = new AcpService(acp, { reloadOnHistoryRefresh: true, preferListedTitles: true, nativeRenameCommand: "name" })\n  assert.equal((await service.listSessions())[0].title, "PI native title")\n  const renamed = await service.renameSession("pi-session", "Renamed from Harness Remote")\n  assert.equal(acp.prompts.at(-1), "/name Renamed from Harness Remote")\n  assert.equal(renamed.title, "Renamed from Harness Remote")\n  assert.equal((await service.listSessions())[0].title, "Renamed from Harness Remote")\n})\n\ntest("PI ignores unrelated pi-acp binaries and uses the exact pinned adapter", () => {\n  const launch = resolveAcpLaunch(HARNESS_PROFILES.pi, { find: () => "/usr/local/bin/pi-acp" })\n  assert.equal(launch.source, "npx")\n  assert.deepEqual(launch.args, ["-y", "@automatalabs/pi-acp@0.3.0"])\n})\n`)
