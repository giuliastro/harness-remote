import { readFile, writeFile, unlink } from "node:fs/promises"

function replaceExact(source, before, after, label) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`)
  return source.replace(before, after)
}

const servicePath = "bridge/src/acp-service.js"
let service = await readFile(servicePath, "utf8")
service = replaceExact(service,
`  async messages(sessionID, refresh = false) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    const externalHistory = Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    const reloadHistory = refresh && this.#reloadOnHistoryRefresh
    await this.#load(sessionID, reloadHistory || externalHistory)
    return this.#messages.get(sessionID) ?? []
  }
`,
`  async messages(sessionID, refresh = false) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#historyLoader?.authoritativeHistory) {
      try {
        const persistedMessages = mergeFragmentedPiSnapshot(await this.#historyLoader(sessionID))
        const cachedMessages = mergeFragmentedPiSnapshot(this.#messages.get(sessionID) ?? [])
        const messages = this.#isBusy(sessionID)
          ? mergeFragmentedPiSnapshot(mergeExternalHistory(persistedMessages, cachedMessages))
          : persistedMessages
        if (semanticHistorySignature(messages) !== semanticHistorySignature(cachedMessages)) {
          this.#resetActionsForSessionChange(sessionID)
        }
        this.#messages.set(sessionID, messages)
        this.#loaded.add(sessionID)
        this.#persistSnapshot(sessionID)
        return messages
      } catch {
        this.#emit("session.error", sessionID, { message: "Harness session history could not be read" })
      }
    }
    const externalHistory = Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    const reloadHistory = refresh && this.#reloadOnHistoryRefresh
    await this.#load(sessionID, reloadHistory || externalHistory)
    return this.#messages.get(sessionID) ?? []
  }
`, "messages authoritative history")
await writeFile(servicePath, service)

const loaderPath = "bridge/src/pi-session-history.js"
let loader = await readFile(loaderPath, "utf8")
loader = replaceExact(loader,
`  loadPiHistory.claimOnLoad = true
  loadPiHistory.renameSession = async (sessionID, title) => {
`,
`  // PI's JSONL journal remains the source of truth for transcript reads even after ACP takes
  // ownership for models/prompts. A live ACP session is lifecycle state, not history authority.
  loadPiHistory.authoritativeHistory = true
  loadPiHistory.claimOnLoad = true
  loadPiHistory.renameSession = async (sessionID, title) => {
`, "PI authoritative flag")
await writeFile(loaderPath, loader)

const testPath = "bridge/test/pi-session-history.test.js"
let test = await readFile(testPath, "utf8")
const marker = `test("PI journal rename appends the same session_info record PI list/resume uses", async () => {`
if (!test.includes(marker)) throw new Error("test insertion marker missing")
const newTest = `test("PI journal stays authoritative after an ACP load when a provider error was retried", async () => {
  const { root, sessionID, file } = await fixture()
  const records = (await readFile(file, "utf8")).trim().split("\\n").map(JSON.parse)
  records.splice(2, 1,
    {
      type: "message",
      id: "a-error",
      parentId: "u1",
      timestamp: "2026-08-18T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Partial reasoning before provider failure" }],
        stopReason: "error",
        errorMessage: "Streaming response failed: [502] Upstream error from NVidia: Internal server error"
      }
    },
    {
      type: "message",
      id: "a-retry",
      parentId: "a-error",
      timestamp: "2026-08-18T10:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }], stopReason: "stop" }
    },
    {
      type: "message",
      id: "u2",
      parentId: "a-retry",
      timestamp: "2026-08-18T10:00:04.000Z",
      message: { role: "user", content: [{ type: "text", text: "Follow-up" }] }
    },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "2026-08-18T10:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Follow-up answer" }], stopReason: "stop" }
    },
    { type: "session_info", id: "n2", parentId: "a2", timestamp: "2026-08-18T10:00:06.000Z", name: "PI native title" }
  )
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n")

  const loader = createPiHistoryLoader(root)
  class PartialReplayPiAcp extends StrictPiAcp {
    async request(method, params) {
      if (method === "session/load") {
        if (this.open) throw new Error("Invalid params: session already open")
        this.open = true
        this.loads += 1
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "user_message_chunk", messageId: "replayed-user", content: { type: "text", text: "First prompt" } }
          }
        })
        return { configOptions: [{ id: "model", currentValue: "pi-model", options: [{ value: "pi-model", name: "PI model" }] }] }
      }
      return super.request(method, params)
    }
  }
  const session = { root, sessionID, file, project: path.dirname(file) }
  const acp = new PartialReplayPiAcp(loader, session)
  const service = new AcpService(acp, { historyLoader: loader, reloadOnHistoryRefresh: false, preferListedTitles: true })

  const expected = [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Partial reasoning before provider failure" },
    { role: "assistant", text: "Recovered answer" },
    { role: "user", text: "Follow-up" },
    { role: "assistant", text: "Follow-up answer" }
  ]
  assert.deepEqual(visible(await service.messages(sessionID, true)), expected)
  await service.models(sessionID)
  assert.equal(acp.loads, 1)
  assert.deepEqual(visible(await service.messages(sessionID, true)), expected,
    "opening PI via ACP for models must not replace the journal with a partial replay")
})

`
test = test.replace(marker, newTest + marker)
await writeFile(testPath, test)

await unlink(new URL(import.meta.url))
