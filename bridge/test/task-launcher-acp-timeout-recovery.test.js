import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { isAcpPromptTimeout, recoverLateAcpOutcome } from "../src/task-launcher.js"

class FakeAcpService {
  #events = new EventEmitter()
  #messages = []

  subscribe(listener) {
    this.#events.on("event", listener)
    return () => this.#events.off("event", listener)
  }

  messages() {
    return Promise.resolve(this.#messages)
  }

  setMessages(messages) {
    this.#messages = messages
  }

  emit(event) {
    this.#events.emit("event", event)
  }
}

test("recognizes only the ACP session prompt transport timeout", () => {
  assert.equal(isAcpPromptTimeout(new Error("ACP adapter request timed out: session/prompt")), true)
  assert.equal(isAcpPromptTimeout(new Error("ACP adapter request timed out: session/load")), false)
  assert.equal(isAcpPromptTimeout(new Error("provider failed")), false)
})

test("late assistant output recovers a timed-out ACP Run after the stream goes quiet", async () => {
  const service = new FakeAcpService()
  const timeout = new Error("ACP adapter request timed out: session/prompt")
  const recovery = recoverLateAcpOutcome(service, "session-1", {
    timeoutError: timeout,
    quietMs: 5,
    maxMs: 100
  })

  service.setMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: "do work" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "finished successfully" }] }
  ])
  service.emit({ type: "message.updated", sessionId: "session-1" })

  assert.equal(await recovery, "finished successfully")
})

test("a prompt timeout remains a failure when no late ACP activity arrives", async () => {
  const service = new FakeAcpService()
  const timeout = new Error("ACP adapter request timed out: session/prompt")

  await assert.rejects(
    recoverLateAcpOutcome(service, "session-2", {
      timeoutError: timeout,
      quietMs: 5,
      maxMs: 15
    }),
    (error) => error === timeout
  )
})
