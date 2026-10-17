import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

const SESSION = "01a02000-0000-7000-8000-0000000000aa"

/**
 * Claude's adapter opens a shell call with the command line as its title, names the tool under
 * `_meta.claudeCode`, and often sends the input only on the first update. The client needs all three
 * to label the call "Ran <command>" rather than echoing the title as if it were the tool.
 */
class ClaudeShellAcp extends EventEmitter {
  async listSessions() {
    return [{ sessionId: SESSION, cwd: process.cwd(), title: "Claude shell", updatedAt: new Date().toISOString() }]
  }

  #update(update) {
    this.emit("notification", { method: "session/update", params: { sessionId: SESSION, update } })
  }

  async request(method) {
    if (method === "session/load") return { configOptions: [] }
    if (method !== "session/prompt") throw new Error(`Unexpected request: ${method}`)
    this.#update({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_1",
      title: "Terminal",
      kind: "execute",
      status: "pending",
      _meta: { claudeCode: { toolName: "Bash" } }
    })
    this.#update({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_1",
      title: "git status",
      rawInput: { command: "git status", description: "Show working tree status" }
    })
    this.#update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed", rawOutput: "clean" })
    this.#update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } })
    return { stopReason: "end_turn" }
  }

  notify() {}
}

test("an ACP tool call keeps Claude's tool name, the ACP kind and the input sent on a later update", async () => {
  const service = new AcpService(new ClaudeShellAcp())
  await service.prompt(SESSION, "status?")
  await new Promise((resolve) => setTimeout(resolve, 20))

  const tool = (await service.messages(SESSION)).flatMap((message) => message.parts).find((part) => part.type === "tool")
  assert.equal(tool.tool, "Bash")
  assert.equal(tool.kind, "execute")
  assert.equal(tool.state.title, "git status")
  assert.deepEqual(tool.state.input, { command: "git status", description: "Show working tree status" })
  // The input-only update carried no status; it must not have erased the call's state.
  assert.equal(tool.state.status, "completed")
  assert.equal(tool.state.output, "clean")
})
