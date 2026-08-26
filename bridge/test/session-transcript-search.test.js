import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createTranscriptSearch } from "../src/session-transcript-search.js"

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`

async function journalRoot(files) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-transcript-search-"))
  for (const [relative, records] of Object.entries(files)) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, typeof records === "string" ? records : jsonl(records))
  }
  return root
}

test("finds a phrase in every journal layout the harnesses use", async () => {
  // Codex files a rollout as `rollout-<stamp>-<id>.jsonl` under year/month/day, OMP and PI as
  // `<stamp>_<id>.jsonl`, Claude Code as `<id>.jsonl` under a per-project directory. Nothing here
  // parses a format, which is what lets one implementation search all four.
  const root = await journalRoot({
    "2026/08/07/rollout-2026-08-07T11-28-49-codex-1.jsonl": [
      { timestamp: "2026-08-07T09:28:51.290Z", type: "event_msg", payload: { type: "user_message", message: "il deb non passa la firma" } }
    ],
    "20260807_omp-1.jsonl": [
      { role: "assistant", content: [{ type: "text", text: "ho corretto la firma del pacchetto deb" }] }
    ],
    "20260807_pi-1.jsonl": [
      { id: "r1", timestamp: 1_770_000_000, message: { role: "user", content: "e la firma del deb?" } }
    ],
    "-home-user-harness-remote/claude-1.jsonl": [
      { type: "user", timestamp: "2026-08-07T09:30:00.000Z", message: { role: "user", content: [{ type: "text", text: "verifica la firma" }] } }
    ]
  })

  const search = createTranscriptSearch({ root })
  const outcome = await search.search(["codex-1", "omp-1", "pi-1", "claude-1"], "firma")
  assert.deepEqual(outcome.hits.map((hit) => hit.sessionID), ["codex-1", "omp-1", "pi-1", "claude-1"])
  assert.equal(outcome.scanned, 4)
  assert.deepEqual(outcome.unsearched, [])
  assert.equal(outcome.truncated, false)
  for (const hit of outcome.hits) {
    assert.equal(hit.count, 1)
    assert.match(hit.matches[0].snippet, /firma/, `${hit.sessionID} must show the matching text`)
  }
  assert.deepEqual(outcome.hits.map((hit) => hit.matches[0].role), ["user", "assistant", "user", "user"])
})

test("reports Sessions it could not search instead of calling them misses", async () => {
  // A Session with no journal on disk - a live Claude Session whose id does not name a file, a
  // harness never run on this machine - is not evidence that the phrase is absent. Presenting it as
  // a miss is the one outcome a search must not produce.
  const root = await journalRoot({ "20260807_omp-1.jsonl": [{ role: "user", content: "trovami questo" }] })
  const outcome = await createTranscriptSearch({ root }).search(["omp-1", "ghost-1"], "trovami")
  assert.deepEqual(outcome.hits.map((hit) => hit.sessionID), ["omp-1"])
  assert.deepEqual(outcome.unsearched, ["ghost-1"])
  assert.equal(outcome.scanned, 1)
})

test("does not match machine identity, encoded blobs, or an unreadable root", async () => {
  // Searching for a project name once matched every line of every journal through `cwd`, and a
  // base64 screenshot matched almost any short query by coincidence.
  const root = await journalRoot({
    "20260807_omp-1.jsonl": [
      { role: "user", cwd: "/home/giulio/Software/harness-remote", gitBranch: "checkpoint/v3", content: "ciao" },
      { role: "user", content: [{ type: "image", mime: "image/png", data: `${"QUJD".repeat(900)}` }] }
    ]
  })
  const search = createTranscriptSearch({ root })
  assert.deepEqual((await search.search(["omp-1"], "harness-remote")).hits, [])
  assert.deepEqual((await search.search(["omp-1"], "checkpoint")).hits, [])
  assert.deepEqual((await search.search(["omp-1"], "QUJD")).hits, [])
  assert.deepEqual((await search.search(["omp-1"], "ciao")).hits.map((hit) => hit.sessionID), ["omp-1"])

  const missing = createTranscriptSearch({ root: path.join(root, "does-not-exist") })
  assert.deepEqual(await missing.search(["omp-1"], "ciao"), { query: "ciao", hits: [], scanned: 0, unsearched: ["omp-1"], truncated: false })
})

test("bounds the work and says so rather than answering slowly or partially in silence", async () => {
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `20260807_s-${index}.jsonl`,
    [{ role: "user", content: "cerca questo" }, { role: "assistant", content: "cerca anche questo" }, { role: "user", content: "e cerca questo" }]
  ]))
  const search = createTranscriptSearch({ root: await journalRoot(many) })
  const ids = Array.from({ length: 6 }, (_, index) => `s-${index}`)

  const capped = await search.search(ids, "cerca", { maxSessions: 2 })
  assert.deepEqual(capped.hits.map((hit) => hit.sessionID), ["s-0", "s-1"], "the bound applies in the order the caller asked for")
  assert.equal(capped.truncated, true, "a query that did not reach every Session must say so")

  const perSession = await search.search(ids, "cerca", { matchesPerSession: 1 })
  assert.equal(perSession.hits[0].matches.length, 1, "snippets are capped per Session")
  assert.equal(perSession.hits[0].count, 3, "the total is still counted, so the row can say how many")

  const total = await search.search(ids, "cerca", { limit: 3 })
  assert.equal(total.hits.length, 3)
  assert.equal(total.truncated, true)

  assert.deepEqual(await search.search(ids, "c"), { query: "c", hits: [], scanned: 0, unsearched: [], truncated: false },
    "one character is a keystroke, not a query")
})

test("searches the tail of a transcript too large to read whole, without a fragment line", async () => {
  // A 40MB journal cannot be read on every keystroke. The cap drops the beginning rather than the
  // end, because a transcript is searched for something recent far more often than for its opening
  // line - and starting mid-file lands inside a record, which must not be reported as a match.
  const filler = jsonl(Array.from({ length: 400 }, (_, index) => ({ role: "assistant", content: `riga ${index} ${"riempimento ".repeat(20)}` })))
  const root = await journalRoot({
    "20260807_big-1.jsonl": `${jsonl([{ role: "user", content: "frase iniziale" }])}${filler}${jsonl([{ role: "user", content: "frase finale" }])}`
  })
  const search = createTranscriptSearch({ root })
  const tail = await search.search(["big-1"], "frase", { maxBytesPerSession: 64 * 1024 })
  assert.equal(tail.truncated, true)
  assert.deepEqual(tail.hits[0].matches.map((match) => match.snippet), ["frase finale"], "only the tail was read, and only whole records")

  const whole = await search.search(["big-1"], "frase", { maxBytesPerSession: 64 * 1024 * 1024 })
  assert.equal(whole.hits[0].count, 2)
  assert.equal(whole.truncated, false)
})
