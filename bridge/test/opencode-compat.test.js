import assert from "node:assert/strict"
import test from "node:test"
import { normalizeOpenCodeV2Message, normalizeOpenCodeV2Response, normalizeOpenCodeV2Session, openCodeApiBody, openCodeApiModelBody, openCodeApiPath } from "../src/opencode-compat.js"

const v2Host = { apiBasePath: "/api" }

test("maps stable OpenCode routes to the v2 API", () => {
  assert.equal(openCodeApiPath(v2Host, "/session/status", "?directory=%2Fwork"), "/api/session/active?directory=%2Fwork")
  assert.equal(openCodeApiPath(v2Host, "/session/ses_1/prompt_async"), "/api/session/ses_1/prompt")
  assert.equal(openCodeApiPath(v2Host, "/session/ses_1/message", "?limit=40"), "/api/session/ses_1/message?limit=40")
  assert.equal(openCodeApiPath(v2Host, "/session/ses_1/stop"), "/api/session/ses_1/interrupt")
  assert.equal(openCodeApiPath(v2Host, "/global/event"), "/api/event")
  assert.equal(openCodeApiPath({ apiBasePath: "" }, "/session/ses_1/prompt_async"), "/session/ses_1/prompt_async")
})

test("translates the legacy prompt and command bodies to v2", () => {
  assert.deepEqual(openCodeApiBody(v2Host, "/session", { title: "New", model: { providerID: "openrouter", modelID: "free" }, directory: "/ignored" }, "/work"), {
    title: "New",
    model: { providerID: "openrouter", id: "free" },
    location: { directory: "/work" }
  })
  assert.deepEqual(openCodeApiModelBody(v2Host, "/session/ses_1/prompt", {
    model: { providerID: "openrouter", modelID: "free" },
    variant: "high"
  }), {
    model: { providerID: "openrouter", id: "free", variant: "high" }
  })
  assert.deepEqual(openCodeApiModelBody(v2Host, "/session/ses_1/command", { model: "openrouter/free" }), {
    model: { providerID: "openrouter", id: "free" }
  })
  assert.deepEqual(openCodeApiBody(v2Host, "/session/ses_1/prompt_async", {
    parts: [
      { type: "text", text: "hello" },
      { type: "file", filename: "note.txt", url: "data:text/plain;base64,SGk=" }
    ],
    model: { providerID: "openrouter", modelID: "free" }
  }), {
    text: "hello",
    files: [{ data: "SGk=", mime: "text/plain", source: { type: "inline" }, name: "note.txt" }]
  })
  assert.deepEqual(openCodeApiBody(v2Host, "/session/ses_1/prompt", {
    text: "hello",
    directory: "/work",
    clientRequestId: "client-1",
    attachments: [{ filename: "note.txt", url: "data:text/plain;base64,SGk=" }]
  }), {
    text: "hello",
    files: [{ data: "SGk=", mime: "text/plain", source: { type: "inline" }, name: "note.txt" }]
  })
  assert.deepEqual(openCodeApiBody(v2Host, "/session/ses_1/command", { command: "help", arguments: "now" }), {
    name: "help",
    text: "now"
  })
  assert.deepEqual(openCodeApiBody(v2Host, "/session/ses_1/stop", { operationToken: "opaque" }), {})
})

test("normalizes v2 session pages and message content for the web contract", () => {
  const session = normalizeOpenCodeV2Session({
    id: "ses_1",
    title: "Existing session",
    location: { directory: "/work" },
    time: { created: 10, updated: 20 },
    model: { providerID: "openrouter", id: "free", variant: "default" }
  })
  assert.equal(session.directory, "/work")
  assert.deepEqual(session.model, { providerID: "openrouter", id: "free", variant: "default" })

  const normalized = normalizeOpenCodeV2Response({
    pathname: "/session/ses_1/message",
    statusCode: 200,
    sessionID: "ses_1",
    payload: {
      data: [
        { id: "msg_user", type: "user", time: { created: 30 }, text: "hello" },
        { id: "msg_assistant", type: "assistant", time: { created: 31, completed: 32 }, content: [{ type: "text", text: "hi" }] },
        { id: "msg_idle", type: "idle", time: { created: 33 } }
      ],
      cursor: { next: "older" }
    }
  })
  assert.equal(normalized.payload.length, 2)
  assert.equal(normalized.payload[0].info.role, "user")
  assert.equal(normalized.payload[1].parts[0].text, "hi")
  assert.equal(normalized.nextCursor, "older")
})
