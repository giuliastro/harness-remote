#!/usr/bin/env node
import { catalogFingerprint, catalogOwnershipEvidence } from "./session-first-soak-evidence.mjs"

/*
 * Session-first model-lifecycle soak probe.
 *
 * Speaks exactly the HTTP contract the Session-first web client uses, against a real daemon and real
 * harness processes, so the reported failure class can be reproduced and measured without a browser:
 *
 *   open A -> load catalog -> change model -> send -> open B -> change model
 *           -> switch harness -> return A -> change model -> send
 *
 * It asserts what the release gate actually requires: catalogs stay per harness, every prompt reaches
 * the Session it was addressed to exactly once, Stop leaves a visible interruption and a usable
 * Session, and listeners/streams/in-flight work return to a stable state.
 *
 * Usage:
 *   HR_URL=http://127.0.0.1:4097 HR_USER=... HR_PASS=... \
 *   HR_PRIMARY=pi HR_SECONDARY=opencode HR_DIR_A=/path/one HR_DIR_B=/path/two \
 *   node bridge/scripts/session-first-soak.mjs
 *
 * HR_PRIMARY is the harness that must complete real turns. HR_SECONDARY is only switched to, so a
 * harness whose inference is unavailable can still prove catalog and Session isolation.
 * Nothing here prints credentials, prompt bodies beyond the markers it sends, or catalog contents.
 */

const URL_ROOT = (process.env.HR_URL ?? "http://127.0.0.1:4097").replace(/\/$/, "")
const AUTH = "Basic " + Buffer.from(`${process.env.HR_USER ?? ""}:${process.env.HR_PASS ?? ""}`).toString("base64")
const PRIMARY = process.env.HR_PRIMARY ?? "pi"
const SECONDARY = process.env.HR_SECONDARY ?? "opencode"
const DIR_A = process.env.HR_DIR_A ?? process.cwd()
const DIR_B = process.env.HR_DIR_B ?? DIR_A
const CYCLES = Number(process.env.HR_CYCLES ?? "5")
const TURN_BUDGET_MS = Number(process.env.HR_TURN_BUDGET_MS ?? "120000")
/*
 * Whether the primary harness can be trusted to echo a marker back verbatim.
 *
 * Echoing is the strongest available proof that a prompt reached the Session it was addressed to,
 * so it stays the default. Set HR_ECHO_MARKERS=0 for a harness or model that will not follow the
 * instruction: routing is then judged by turn arrival and ordering instead, which is weaker
 * evidence, and the summary says so rather than quietly claiming the stronger check ran.
 */
const ECHO_MARKERS = process.env.HR_ECHO_MARKERS !== "0"
/*
 * Whether a turn the harness answered with a native error still counts as delivered.
 *
 * Off by default: a real run should produce real replies. Turn it on when the harness is reachable
 * but a provider will not serve inference - an unset or rejected credential, a provider outage - so
 * the control plane can still be soaked. The summary then says so and reports how many turns ended
 * in a native error, rather than presenting a run with no successful reply as a clean pass.
 */
const ALLOW_TURN_ERRORS = process.env.HR_ALLOW_TURN_ERRORS === "1"
let erroredTurns = 0

const problems = []
const log = (...parts) => console.log(...parts)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function check(ok, message) {
  if (!ok) problems.push(message)
  log(`  ${ok ? "ok  " : "FAIL"} ${message}`)
}

async function call(path, { method = "GET", body, timeoutMs = 180_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${URL_ROOT}${path}`, {
      method,
      headers: { Accept: "application/json", Authorization: AUTH, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 200) } }
    return { status: response.status, data, ms: Date.now() - started }
  } catch (error) {
    return { status: 0, data: { error: error.name === "AbortError" ? `probe timeout after ${timeoutMs}ms` : error.message }, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** Mirrors the client's bounded catalog poll: a 202 means discovery is still owned by the daemon. */
async function catalog(agentID, totalMs = 120_000) {
  const started = Date.now()
  let attempts = 0
  let last
  while (Date.now() - started < totalMs) {
    attempts += 1
    last = await call(`/v1/agents/${encodeURIComponent(agentID)}/models?waitMs=4000`, { timeoutMs: 30_000 })
    if (last.status !== 202 && last.data?.loading !== true) break
    await sleep(750)
  }
  const models = Array.isArray(last?.data?.models) ? last.data.models : []
  return { attempts, ms: Date.now() - started, status: last?.status, models, error: last?.data?.error }
}

async function diagnostics() { return (await call("/v1/diagnostics", { timeoutMs: 30_000 })).data ?? {} }

function stableState(value) {
  const state = { agents: {}, services: {} }
  for (const agent of value.agents ?? []) {
    state.agents[agent.id] = {
      processListeners: agent.process?.listenerCount ?? 0,
      pending: agent.process?.pendingRequestCount ?? 0,
      catalogListeners: agent.modelCatalog?.adapterProcess?.listenerCount ?? 0,
      catalogModels: agent.modelCatalog?.cachedModels ?? 0,
      catalogPhase: agent.modelCatalog?.phase ?? null,
      catalogSource: agent.modelCatalog?.source ?? null,
      catalogLastError: agent.modelCatalog?.lastError ?? null
    }
  }
  for (const [agentID, service] of Object.entries(value.services ?? {})) {
    state.services[agentID] = {
      subscribers: service.subscribers ?? 0,
      inFlightLoads: service.inFlightLoads ?? 0,
      activeSessions: service.activeSessions ?? 0,
      queuedSessions: service.queuedSessions ?? 0,
      transcriptEntries: service.transcriptCache?.entries ?? null
    }
  }
  state.eventStreams = Object.keys(value.eventStreams ?? {}).length
  state.claimedWriters = (value.nativeSessions?.claimedWriters ?? []).length
  state.unresolvedOperations = value.nativeSessions?.operationLedger?.unresolvedCount ?? 0
  return state
}

const requestID = () => `soak-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

async function createSession(agentID, directory, title) {
  return call(`/v1/agents/${encodeURIComponent(agentID)}/session?directory=${encodeURIComponent(directory)}`, { method: "POST", body: { title } })
}

async function prompt(agentID, sessionID, directory, text, model) {
  return call(`/v1/agents/${encodeURIComponent(agentID)}/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    body: {
      clientRequestId: requestID(),
      text,
      directory,
      model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
      variant: model?.variant || undefined
    }
  })
}

async function messages(agentID, sessionID, directory) {
  const result = await call(`/v1/agents/${encodeURIComponent(agentID)}/session/${encodeURIComponent(sessionID)}/message?limit=60&directory=${encodeURIComponent(directory)}`, { timeoutMs: 60_000 })
  return Array.isArray(result.data) ? result.data : (result.data?.messages ?? [])
}

function transcriptText(list, role) {
  return list
    .filter((message) => message.info?.role === role)
    .map((message) => (message.parts ?? []).filter((part) => part.type === "text").map((part) => part.text).join(" "))
}

/**
 * Wait for this exact turn rather than a bare count, so a slow turn cannot look like a lost one.
 *
 * With echo checking on, the marker appearing in an assistant reply proves delivery and routing
 * together. With it off, the probe waits for the expected number of completed assistant turns.
 */
async function waitForTurn(agentID, sessionID, directory, marker, expectedAssistants, budgetMs = TURN_BUDGET_MS) {
  const started = Date.now()
  let list = []
  while (Date.now() - started < budgetMs) {
    list = await messages(agentID, sessionID, directory)
    const replied = list.filter((message) => message.info?.role === "assistant" && !message.info?.error)
    const failed = list.filter((message) => message.info?.role === "assistant" && message.info?.error)
    const arrived = ALLOW_TURN_ERRORS ? replied.length + failed.length : replied.length
    const done = ECHO_MARKERS && !ALLOW_TURN_ERRORS
      ? transcriptText(list, "assistant").some((text) => text.includes(marker))
      : arrived >= expectedAssistants
    if (done) {
      erroredTurns = Math.max(erroredTurns, failed.length)
      return { found: true, list, ms: Date.now() - started }
    }
    await sleep(1500)
  }
  return { found: false, list, ms: Date.now() - started }
}

function distinctModels(models, count) {
  const seen = new Set()
  const picked = []
  for (const model of models) {
    const key = `${model.providerID}/${model.modelID}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(model)
    if (picked.length === count) break
  }
  return picked
}

log(`Session-first soak against ${URL_ROOT}`)
log(`primary=${PRIMARY} secondary=${SECONDARY} cycles=${CYCLES}`)

log("\n== cold state ==")
log(JSON.stringify(stableState(await diagnostics()), null, 1))

log("\n== catalogs stay per harness ==")
const primaryCatalog = await catalog(PRIMARY)
const secondaryCatalog = await catalog(SECONDARY)
log(`  ${PRIMARY}: ${primaryCatalog.models.length} models in ${primaryCatalog.ms}ms (${primaryCatalog.attempts} request(s))${primaryCatalog.error ? ` error=${primaryCatalog.error}` : ""}`)
log(`  ${SECONDARY}: ${secondaryCatalog.models.length} models in ${secondaryCatalog.ms}ms (${secondaryCatalog.attempts} request(s))${secondaryCatalog.error ? ` error=${secondaryCatalog.error}` : ""}`)
const ownership = catalogOwnershipEvidence({
  primary: PRIMARY,
  secondary: SECONDARY,
  primaryModels: primaryCatalog.models,
  secondaryModels: secondaryCatalog.models,
  state: stableState(await diagnostics())
})
for (const evidence of ownership.checks) check(evidence.ok, evidence.message)
if (ownership.catalogsIdentical) {
  log("  note identical normalized catalogs are valid; isolation is proven by agent-scoped diagnostics and Session routing")
}

const models = distinctModels(primaryCatalog.models, 3)
check(models.length >= 2, `${PRIMARY} offers at least two distinct models to switch between (${models.length})`)
if (models.length < 2) {
  log("\nCannot exercise model switching without two models. Stopping.")
  process.exit(1)
}

log("\n== two Sessions, repeated model changes ==")
const created = await Promise.all([createSession(PRIMARY, DIR_A, "Soak A"), createSession(PRIMARY, DIR_B, "Soak B")])
const A = created[0].data?.id
const B = created[1].data?.id
check(Boolean(A && B), `two native Sessions created on ${PRIMARY}`)
if (!A || !B) process.exit(1)

// Start the secondary harness too, so the baseline is taken with every adapter already running:
// lazy startup adds listeners once and must not be mistaken for a leak. Growth measured from here
// on is growth caused by the repeated work below.
const warmup = await createSession(SECONDARY, DIR_A, "Soak warmup")
check(warmup.status === 200, `${SECONDARY} started and created a native Session`)
const before = stableState(await diagnostics())
log("\n== warm baseline (after both harnesses have started) ==")
log(JSON.stringify(before, null, 1))

// `expected` holds prompts that must receive an answer. `userTurns` counts every prompt the daemon
// accepted, including the one deliberately cancelled below, which must stay visible without a reply.
const expected = { A: [], B: [] }
const userTurns = { A: 0, B: 0 }
for (let turn = 1; turn <= 3; turn += 1) {
  for (const [name, sessionID, directory, offset] of [["A", A, DIR_A, 0], ["B", B, DIR_B, 1]]) {
    const model = models[(turn + offset) % models.length]
    const marker = `${name}-TURN-${turn}`
    const result = await prompt(PRIMARY, sessionID, directory, `Reply with exactly: ${marker}`, model)
    check(result.data?.status === "accepted", `${name} turn ${turn} accepted with model ${model.modelID}${model.variant ? `:${model.variant}` : ""}`)
    expected[name].push(marker)
    userTurns[name] += 1
    const answered = await waitForTurn(PRIMARY, sessionID, directory, marker, expected[name].length)
    check(answered.found, `${name} turn ${turn} completed in ${answered.ms}ms`)
  }
}

log(`\n== ${CYCLES} cross-harness cycles: ${PRIMARY} -> ${SECONDARY} -> ${PRIMARY} ==`)
for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
  const away = await catalog(SECONDARY)
  const secondarySession = await createSession(SECONDARY, cycle % 2 ? DIR_A : DIR_B, `Soak ${SECONDARY} ${cycle}`)
  const back = await catalog(PRIMARY)
  const name = cycle % 2 ? "A" : "B"
  const sessionID = cycle % 2 ? A : B
  const directory = cycle % 2 ? DIR_A : DIR_B
  const model = models[cycle % models.length]
  const marker = `CYCLE-${cycle}`
  const result = await prompt(PRIMARY, sessionID, directory, `Reply with exactly: ${marker}`, model)
  expected[name].push(marker)
  userTurns[name] += 1
  log(`  cycle ${cycle}: ${SECONDARY}=${away.models.length} ${PRIMARY}=${back.models.length} session=${secondarySession.status} prompt(${model.modelID})=${result.data?.status}`)
  check(catalogFingerprint(away.models) === ownership.secondaryFingerprint, `cycle ${cycle}: ${SECONDARY} catalog unchanged while switching away and back`)
  check(catalogFingerprint(back.models) === ownership.primaryFingerprint, `cycle ${cycle}: ${PRIMARY} catalog unchanged after visiting ${SECONDARY}`)
  check(result.data?.status === "accepted", `cycle ${cycle}: ${PRIMARY} prompt accepted after harness switch and model change`)
  const answered = await waitForTurn(PRIMARY, sessionID, directory, marker, expected[name].length)
  check(answered.found, `cycle ${cycle}: ${name} completed ${marker} in ${answered.ms}ms`)
}

async function assertTranscriptFidelity(label) {
  log(`\n== transcript fidelity (${label}) ==`)
  for (const [name, sessionID, directory] of [["A", A, DIR_A], ["B", B, DIR_B]]) {
    const list = await messages(PRIMARY, sessionID, directory)
    const users = transcriptText(list, "user")
    const assistants = transcriptText(list, "assistant").join(" | ")
    check(users.length === userTurns[name], `${name}: one user turn per accepted prompt, no duplicates (${users.length}/${userTurns[name]})`)
    check(new Set(users).size === users.length, `${name}: no duplicated user prompt`)
    if (ECHO_MARKERS && !ALLOW_TURN_ERRORS) {
      const missing = expected[name].filter((marker) => !assistants.includes(marker))
      check(missing.length === 0, `${name}: every prompt answered with its own marker${missing.length ? ` (missing ${missing.join(", ")})` : ""}`)
    } else {
      // Count turns the harness answered, not characters it produced: with HR_ALLOW_TURN_ERRORS a
      // native error is a real answer for control-plane purposes, and it carries no text.
      const answered = list.filter((message) => message.info?.role === "assistant"
        && (Boolean(message.info?.error)
          ? ALLOW_TURN_ERRORS
          : (message.parts ?? []).some((part) => part.type === "text" && part.text?.trim())))
      const failed = list.filter((message) => message.info?.role === "assistant" && message.info?.error).length
      check(
        answered.length >= expected[name].length,
        `${name}: one assistant turn per prompt (${answered.length}/${expected[name].length}${failed ? `, ${failed} native error(s)` : ""}); marker echo not asserted`
      )
    }
  }
}

await assertTranscriptFidelity("after cross-harness cycles")

log("\n== harness-advertised variant, when this harness offers one ==")
// Pick from the model with the most advertised variants, and take its last one: the first is usually
// the harness default ("off", "default"), which would not change anything. A harness whose variant
// range differs per model - PI advertises a different thinkingLevel set for each - makes picking any
// arbitrary pair unsafe, so keep the variant with the model that actually offers it.
const variantsByModel = new Map()
for (const model of primaryCatalog.models) {
  if (!model.variant || !model.variantConfigId) continue
  const key = `${model.providerID}/${model.modelID}`
  if (!variantsByModel.has(key)) variantsByModel.set(key, [])
  variantsByModel.get(key).push(model)
}
const richest = [...variantsByModel.values()].sort((left, right) => right.length - left.length)[0] ?? []
const variantModel = richest[richest.length - 1]
if (!variantModel) {
  log(`  skipped: ${PRIMARY} advertises no model variant, so none is invented`)
} else {
  // The HTTP surface does not report back which variant served a turn, so this leg proves the
  // variant is accepted and does not wedge the Session. That the variant is applied after the model
  // - the defect that silently dropped it - is proven by the acp-service unit regressions.
  const marker = "VARIANT-TURN"
  const result = await prompt(PRIMARY, B, DIR_B, `Reply with exactly: ${marker}`, variantModel)
  log(`  ${variantModel.providerID}/${variantModel.modelID} ${variantModel.variantConfigId}=${variantModel.variant} -> ${result.data?.status ?? result.status}`)
  check(result.data?.status === "accepted", `a prompt with variant ${variantModel.variantConfigId}=${variantModel.variant} is accepted`)
  expected.B.push(marker)
  userTurns.B += 1
  const answered = await waitForTurn(PRIMARY, B, DIR_B, marker, expected.B.length)
  check(answered.found, `the variant turn completed in ${answered.ms}ms`)
  const followUp = await prompt(PRIMARY, B, DIR_B, "Reply with exactly: AFTER-VARIANT", models[0])
  check(followUp.data?.status === "accepted", "the Session still accepts a plain model after a variant turn")
  expected.B.push("AFTER-VARIANT")
  userTurns.B += 1
  const recovered = await waitForTurn(PRIMARY, B, DIR_B, "AFTER-VARIANT", expected.B.length)
  check(recovered.found, `the Session recovered from the variant turn in ${recovered.ms}ms`)
}

log("\n== Stop leaves a visible interruption and a usable Session ==")
await prompt(PRIMARY, A, DIR_A, "Count slowly from 1 to 400, one number per line.", models[0])
await sleep(2500)
const stopped = await call(`/v1/agents/${encodeURIComponent(PRIMARY)}/session/${encodeURIComponent(A)}/stop`, {
  method: "POST",
  body: { clientRequestId: requestID(), directory: DIR_A, operationToken: requestID() }
})
check(stopped.data?.status === "accepted", `Stop accepted for ${PRIMARY} (${stopped.status})`)
await sleep(3000)
const afterStop = await prompt(PRIMARY, A, DIR_A, "Reply with exactly: AFTER-STOP", models[1])
check(afterStop.data?.status === "accepted", "Session accepts a new prompt with a new model after Stop")
expected.A.push("AFTER-STOP")
userTurns.A += 2 // the cancelled turn plus this one
const resumed = await waitForTurn(PRIMARY, A, DIR_A, "AFTER-STOP", expected.A.length)
check(resumed.found, `Session answered after Stop in ${resumed.ms}ms`)
const stopList = await messages(PRIMARY, A, DIR_A)
const cancelledIndex = transcriptText(stopList, "user").findIndex((text) => text.includes("Count slowly"))
check(cancelledIndex >= 0, "the interrupted turn stays visible in the transcript")

await assertTranscriptFidelity("final")

log("\n== state returns to a stable point ==")
// Let the last accepted turn settle before judging in-flight work.
for (let attempt = 0; attempt < 40; attempt += 1) {
  const value = await diagnostics()
  const busy = (value.agents ?? []).some((agent) => (agent.process?.pendingRequestCount ?? 0) > 0)
    || Object.values(value.services ?? {}).some((service) => (service.activeSessions ?? 0) > 0)
  if (!busy) break
  await sleep(1500)
}
const after = stableState(await diagnostics())
log(JSON.stringify(after, null, 1))

for (const [agentID, state] of Object.entries(after.agents)) {
  const baseline = before.agents[agentID]
  if (!baseline) continue
  const listenerGrowth = state.processListeners - baseline.processListeners
  const catalogGrowth = state.catalogListeners - baseline.catalogListeners
  check(listenerGrowth <= 2, `${agentID}: adapter listeners did not grow unboundedly (${baseline.processListeners} -> ${state.processListeners})`)
  check(catalogGrowth <= 2, `${agentID}: catalog adapter listeners did not grow unboundedly (${baseline.catalogListeners} -> ${state.catalogListeners})`)
  check(state.pending === 0, `${agentID}: no pending ACP request left (${state.pending})`)
}
for (const [agentID, state] of Object.entries(after.services)) {
  const baseline = before.services[agentID]
  check(state.inFlightLoads === 0, `${agentID}: no in-flight Session load left (${state.inFlightLoads})`)
  check(state.queuedSessions === 0, `${agentID}: no queued prompt left (${state.queuedSessions})`)
  if (baseline) check(state.subscribers - baseline.subscribers <= 2, `${agentID}: subscribers did not grow unboundedly (${baseline.subscribers} -> ${state.subscribers})`)
}
check(after.unresolvedOperations === 0, `no unresolved native Session mutation left (${after.unresolvedOperations})`)

log("\n================================")
if (!ECHO_MARKERS) log("NOTE: HR_ECHO_MARKERS=0 - per-turn routing was judged by turn arrival, not by echoed markers.")
if (ALLOW_TURN_ERRORS) {
  log("NOTE: HR_ALLOW_TURN_ERRORS=1 - turns answered with a native harness error counted as delivered.")
  log(`      ${erroredTurns} turn(s) ended in a native error, so this run soaked the control plane only, not inference.`)
}
if (problems.length === 0) {
  log("ALL CHECKS PASSED")
} else {
  log(`${problems.length} PROBLEM(S):`)
  for (const problem of problems) log(`  - ${problem}`)
  process.exitCode = 1
}
