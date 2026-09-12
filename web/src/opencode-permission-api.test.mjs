import assert from "node:assert/strict"
import test from "node:test"
import { api } from "./api"

const config = {
  backend: "opencode",
  host: "127.0.0.1",
  port: 4096,
  username: "",
  password: "",
  agentId: "opencode"
}

async function withFetch(fake, run) {
  const previous = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await run()
  } finally {
    globalThis.fetch = previous
  }
}

test("OpenCode Deny sends the exact native reject payload", async () => {
  const calls = []
  await withFetch(async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } })
  }, async () => {
    const result = await api.replyPermission(config, "per_fail_closed", "reject", "/repo")
    assert.equal(result, true)
  })

  assert.equal(calls.length, 1)
  const call = calls[0]
  const target = new URL(call.url)
  assert.equal(target.pathname, "/permission/per_fail_closed/reply")
  assert.equal(target.searchParams.get("directory"), "/repo")
  assert.equal(call.options?.method, "POST")
  assert.deepEqual(JSON.parse(call.options?.body || "{}"), { reply: "reject" })
})

test("a failed OpenCode permission reply rejects and remains retryable", async () => {
  let attempts = 0
  await withFetch(async (_url, options) => {
    attempts += 1
    assert.deepEqual(JSON.parse(options?.body || "{}"), { reply: "reject" })
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: "native permission reply failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      })
    }
    return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } })
  }, async () => {
    await assert.rejects(
      api.replyPermission(config, "per_retry", "reject", "/repo"),
      /native permission reply failed/
    )

    // The transport layer must not turn a failed mutation into a synthetic success. The exact same
    // native decision can be retried after the UI keeps the authoritative request visible.
    assert.equal(await api.replyPermission(config, "per_retry", "reject", "/repo"), true)
  })

  assert.equal(attempts, 2)
})
