import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"
import { createTranscriptSearch } from "../src/session-transcript-search.js"

class FakeAcp extends EventEmitter {
  agentInfo = { version: "test" }
  async start() {}
  async listSessions() {
    return [
      { sessionId: "older", title: "Revisione PR", cwd: process.cwd(), updatedAt: "2026-08-16T00:00:00.000Z" },
      { sessionId: "newer", title: "Firma del pacchetto", cwd: process.cwd(), updatedAt: "2026-08-17T00:00:00.000Z" },
      { sessionId: "live", title: "Senza journal", cwd: process.cwd(), updatedAt: "2026-08-18T00:00:00.000Z" }
    ]
  }
  async request() { return {} }
  notify() {}
}

const listen = (server) => new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

const config = { backend: "omp", username: "", password: "", corsOrigins: [], roots: [process.cwd()] }

async function transcriptSearch() {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-search-route-"))
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "20260816_older.jsonl"),
    `${JSON.stringify({ role: "user", content: "la firma del deb non passa" })}\n`)
  await writeFile(path.join(root, "20260817_newer.jsonl"),
    `${JSON.stringify({ role: "assistant", content: "ho rigenerato la firma" })}\n${JSON.stringify({ role: "user", content: "e la firma di macOS?" })}\n`)
  return createTranscriptSearch({ root })
}

test("searches transcripts newest first and names what it could not reach", async () => {
  const server = createBridgeServer({
    config,
    acp: new FakeAcp(),
    serviceOptions: { transcriptSearch: await transcriptSearch() }
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/session/search?q=firma`)
    assert.equal(response.status, 200)
    const body = await response.json()
    // Newest first, because a search for something said recently should not be behind a year of
    // older Sessions when the bound is reached.
    assert.deepEqual(body.results.map((result) => result.sessionID), ["newer", "older"])
    assert.deepEqual(body.results.map((result) => result.title), ["Firma del pacchetto", "Revisione PR"])
    assert.equal(body.results[0].count, 2)
    assert.equal(body.results[0].matches.length, 2)
    assert.match(body.results[0].matches[0].snippet, /firma/)
    // The live Session has no journal on disk. Reporting it as searched-and-missed would be a lie
    // about the one thing a search result is for.
    assert.deepEqual(body.unsearched, ["live"])
    assert.equal(body.scanned, 2)
    assert.equal(body.truncated, false)
  } finally {
    await close(server)
  }
})

test("a query too short to mean anything costs nothing", async () => {
  let searched = 0
  const server = createBridgeServer({
    config,
    acp: new FakeAcp(),
    serviceOptions: { transcriptSearch: { search: async () => { searched += 1; return { query: "", hits: [], scanned: 0, unsearched: [], truncated: false } } } }
  })
  const base = await listen(server)
  try {
    const body = await (await fetch(`${base}/session/search?q=f`)).json()
    assert.deepEqual(body, { query: "f", results: [], scanned: 0, unsearched: [], truncated: false })
    assert.equal(searched, 0, "one keystroke must not read a single journal")
  } finally {
    await close(server)
  }
})

test("the literal search route wins over the Session-id route it shares a namespace with", async () => {
  // `/session/search` sits in the same namespace as `/session/<id>`, whose pattern accepts any
  // segment. Matched in the wrong order, a search would be answered as a lookup of a Session called
  // "search" - a 200 with a body that has nothing to do with searching.
  const server = createBridgeServer({ config, acp: new FakeAcp(), serviceOptions: { transcriptSearch: await transcriptSearch() } })
  const base = await listen(server)
  try {
    const body = await (await fetch(`${base}/session/search`)).json()
    assert.deepEqual(Object.keys(body).sort(), ["query", "results", "scanned", "truncated", "unsearched"])
    // And the literal that was already there still answers.
    const statuses = await (await fetch(`${base}/session/status`)).json()
    assert.deepEqual(Object.keys(statuses).sort(), ["live", "newer", "older"])
  } finally {
    await close(server)
  }
})
