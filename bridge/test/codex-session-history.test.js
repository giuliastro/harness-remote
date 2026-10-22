import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createCodexHistoryLoader } from "../src/codex-session-history.js"

const sessionID = "019fdb8d-c519-7cf3-8226-ae4a312d7b45"

async function writeRollout(records) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-codex-history-"))
  const nested = path.join(root, "2026", "08", "07")
  await mkdir(nested, { recursive: true })
  await writeFile(
    path.join(nested, `rollout-2026-08-07T11-28-49-${sessionID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  )
  return root
}

test("reads a Codex rollout as the conversation the user saw", async () => {
  // Codex writes both the turns the user saw (`event_msg`) and everything it fed the model
  // (`response_item`). The latter carries AGENTS.md and the desktop app's context blocks under the
  // `user` role, which would otherwise be shown as if the user had typed them.
  const root = await writeRollout([
    { timestamp: "2026-08-07T09:28:49.000Z", type: "session_meta", payload: { session_id: sessionID, cwd: "C:\\Software\\OCApp" } },
    { timestamp: "2026-08-07T09:28:50.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<app-context>desktop</app-context>" }] } },
    { timestamp: "2026-08-07T09:28:50.500Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } },
    { timestamp: "2026-08-07T09:28:51.290Z", type: "event_msg", payload: { type: "user_message", message: "Restyling dell'app", images: [] } },
    { timestamp: "2026-08-07T09:28:55.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "**Planning the restyle**" } },
    { timestamp: "2026-08-07T09:28:57.136Z", type: "event_msg", payload: { type: "agent_message", message: "Riprendo il restyling", phase: "commentary" } },
    { timestamp: "2026-08-07T09:29:00.000Z", type: "event_msg", payload: { type: "token_count", info: {} } },
    { timestamp: "2026-08-07T09:29:10.000Z", type: "event_msg", payload: { type: "agent_message", message: "Fatto", phase: "final" } }
  ])

  try {
    const messages = await createCodexHistoryLoader(root)(sessionID)
    assert.deepEqual(
      messages.map((message) => [message.info.role, message.parts[0].type, message.parts[0].text]),
      [
        ["user", "text", "Restyling dell'app"],
        ["assistant", "reasoning", "**Planning the restyle**"],
        ["assistant", "text", "Riprendo il restyling"],
        ["assistant", "text", "Fatto"]
      ],
      "instruction blocks and bookkeeping events must stay out of the transcript"
    )
    assert.equal(messages[0].info.time.created, Date.parse("2026-08-07T09:28:51.290Z"))
    assert.equal(new Set(messages.map((message) => message.info.id)).size, messages.length, "ids must be unique")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reads current Codex item-completed rollout events without exposing model input", async () => {
  const root = await writeRollout([
    { timestamp: "2026-09-03T07:55:05.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>private model input</skills_instructions>" }] } },
    { timestamp: "2026-09-03T07:55:05.100Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } },
    { timestamp: "2026-09-03T07:55:05.200Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "user-1", content: [{ type: "text", text: "Clona e testa i branch", text_elements: [] }] } } },
    { timestamp: "2026-09-03T07:55:06.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", id: "reasoning-1", summary_text: ["**Inspecting the branches**", "**Planning the tests**"], raw_content: [] } } },
    { timestamp: "2026-09-03T07:55:07.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "command-1", command: ["git", "status"], status: "completed" } } },
    { timestamp: "2026-09-03T07:55:08.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "assistant-1", content: [{ type: "text", text: "I test sono passati." }], phase: "final_answer" } } }
  ])

  try {
    const loader = createCodexHistoryLoader(root)
    const messages = await loader(sessionID)
    assert.deepEqual(
      messages.map((message) => [message.info.role, message.parts[0].type, message.parts[0].text]),
      [
        ["user", "text", "Clona e testa i branch"],
        ["assistant", "reasoning", "**Inspecting the branches**\n\n**Planning the tests**"],
        ["assistant", "text", "I test sono passati."]
      ]
    )

    const page = await loader.page(sessionID, { limit: 2 })
    assert.deepEqual(page.messages, messages.slice(-2))
    assert.equal(page.hasMore, true)
    assert.ok(page.before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("shows only the request a Codex desktop message wrapped in ambient UI context", async () => {
  const wrapped = '\n<in-app-browser-context source="ambient-ui-state">\nURL: http://localhost:5173\n</in-app-browser-context>\n\n## My request:\ndi nuovo, rispondimi "ok"\n'
  const root = await writeRollout([
    { timestamp: "2026-10-21T09:41:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: wrapped }] } },
    { timestamp: "2026-10-21T09:41:01.100Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "user-1", content: [{ type: "text", text: wrapped, text_elements: [] }] } } },
    { timestamp: "2026-10-21T09:41:02.000Z", type: "event_msg", payload: { type: "user_message", message: wrapped, images: [] } },
    { timestamp: "2026-10-21T09:41:03.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "assistant-1", content: [{ type: "text", text: "ok" }], phase: "final_answer" } } }
  ])

  try {
    const messages = await createCodexHistoryLoader(root)(sessionID)
    assert.deepEqual(
      messages.map((message) => [message.info.role, message.parts[0].text]),
      [["user", 'di nuovo, rispondimi "ok"'], ["user", 'di nuovo, rispondimi "ok"'], ["assistant", "ok"]]
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("restores the current Codex model and reasoning effort from the newest native turn context", async () => {
  const root = await writeRollout([
    { timestamp: "2026-08-07T09:28:49.000Z", type: "turn_context", payload: { model: "gpt-5.6-codex", effort: "medium" } },
    { timestamp: "2026-08-07T09:28:51.000Z", type: "event_msg", payload: { type: "user_message", message: "First" } },
    { timestamp: "2026-08-07T09:28:55.000Z", type: "event_msg", payload: { type: "agent_message", message: "One", phase: "final" } },
    { timestamp: "2026-08-07T09:29:00.000Z", type: "turn_context", payload: { model: "gpt-5.7-codex", effort: "high" } },
    { timestamp: "2026-08-07T09:29:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Second" } },
    { timestamp: "2026-08-07T09:29:05.000Z", type: "event_msg", payload: { type: "agent_message", message: "Two", phase: "final" } }
  ])

  try {
    const loader = createCodexHistoryLoader(root)
    const newest = await loader.page(sessionID, { limit: 2 })
    assert.deepEqual(newest.model, { providerID: "codex", modelID: "gpt-5.7-codex", variant: "high" })
    assert.equal(newest.hasMore, true)
    assert.ok(newest.before)

    // Older paging is transcript-only. A historical context must never rewind the model picker.
    const older = await loader.page(sessionID, { limit: 1, before: newest.before })
    assert.equal(older.model, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps message ids stable as a Codex rollout grows", async () => {
  // A rollout is append-only and re-read on every refresh. Byte-offset ids survive later turns being
  // appended and can also be recovered by the tail pager without scanning every older line first.
  const first = { timestamp: "2026-08-07T09:28:51.290Z", type: "event_msg", payload: { type: "user_message", message: "Prima" } }
  const second = { timestamp: "2026-08-07T09:29:51.290Z", type: "event_msg", payload: { type: "agent_message", message: "Seconda" } }
  const root = await writeRollout([first])
  const grown = await writeRollout([first, second])

  try {
    const before = await createCodexHistoryLoader(root)(sessionID)
    const loader = createCodexHistoryLoader(grown)
    const after = await loader(sessionID)
    const page = await loader.page(sessionID, { limit: 2 })
    assert.equal(after.length, 2)
    assert.equal(after[0].info.id, before[0].info.id)
    assert.equal(after[0].parts[0].id, before[0].parts[0].id)
    assert.deepEqual(page.messages.map((message) => message.info.id), after.map((message) => message.info.id))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(grown, { recursive: true, force: true })
  }
})

test("pages a Codex rollout newest-first without duplicate or skipped messages", async () => {
  const records = [
    { timestamp: "2026-08-07T09:28:49.000Z", type: "session_meta", payload: { session_id: sessionID, cwd: "/tmp/project" } }
  ]
  for (let index = 0; index < 37; index += 1) {
    records.push({
      timestamp: new Date(Date.parse("2026-08-07T09:29:00.000Z") + index * 1000).toISOString(),
      type: "event_msg",
      payload: index % 2 === 0
        ? { type: "user_message", message: `message-${index}` }
        : { type: "agent_message", message: `message-${index}`, phase: "final" }
    })
    // Non-visible records make the journal materially larger without becoming transcript messages.
    records.push({
      timestamp: new Date(Date.parse("2026-08-07T09:29:00.500Z") + index * 1000).toISOString(),
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "x".repeat(4096) }] }
    })
  }
  const root = await writeRollout(records)

  try {
    const loader = createCodexHistoryLoader(root)
    const first = await loader.page(sessionID, { limit: 10 })
    assert.equal(first.messages.length, 10)
    assert.equal(first.hasMore, true)
    assert.ok(first.before)
    assert.deepEqual(first.messages.map((message) => message.parts[0].text), Array.from({ length: 10 }, (_, offset) => `message-${27 + offset}`))

    const second = await loader.page(sessionID, { limit: 10, before: first.before })
    assert.equal(second.messages.length, 10)
    assert.equal(second.hasMore, true)
    assert.deepEqual(second.messages.map((message) => message.parts[0].text), Array.from({ length: 10 }, (_, offset) => `message-${17 + offset}`))
    assert.equal(new Set([...first.messages, ...second.messages].map((message) => message.info.id)).size, 20)

    let cursor = second.before
    const collected = [...second.messages, ...first.messages]
    while (cursor) {
      const page = await loader.page(sessionID, { limit: 10, before: cursor })
      collected.unshift(...page.messages)
      cursor = page.before
    }
    assert.deepEqual(collected.map((message) => message.parts[0].text), Array.from({ length: 37 }, (_, index) => `message-${index}`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects invalid Codex history cursors", async () => {
  const root = await writeRollout([
    { timestamp: "2026-08-07T09:28:51.290Z", type: "event_msg", payload: { type: "user_message", message: "Hello" } }
  ])
  try {
    const loader = createCodexHistoryLoader(root)
    await assert.rejects(() => loader.page(sessionID, { limit: 10, before: "not-a-cursor" }), /Invalid Codex history cursor/)
    await assert.rejects(() => loader.page(sessionID, { limit: 10, before: "999999999" }), /Invalid Codex history cursor/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reports no history rather than failing when a rollout is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-codex-history-"))
  try {
    const loadHistory = createCodexHistoryLoader(root)
    assert.deepEqual(await loadHistory(sessionID), [])
    assert.equal(await loadHistory.page(sessionID, { limit: 10 }), undefined)
    assert.deepEqual(await loadHistory("../escape"), [], "a session id must not be able to walk the filesystem")
    assert.deepEqual(await createCodexHistoryLoader(path.join(root, "missing"))(sessionID), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("default history reader follows the native CODEX_HOME used by the adapter", async () => {
  const root = await writeRollout([
    { timestamp: "2026-08-07T09:28:51.290Z", type: "event_msg", payload: { type: "user_message", message: "custom home history" } }
  ])
  try {
    await mkdir(path.join(root, "sessions"))
    await rename(path.join(root, "2026"), path.join(root, "sessions", "2026"))
    const moduleURL = new URL("../src/codex-session-history.js", import.meta.url).href
    const source = `import { createCodexHistoryLoader } from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify(await createCodexHistoryLoader()(${JSON.stringify(sessionID)})))`
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, CODEX_HOME: root }, encoding: "utf8"
    })
    assert.equal(JSON.parse(result)[0].parts[0].text, "custom home history")
  } finally { await rm(root, { recursive: true, force: true }) }
})
