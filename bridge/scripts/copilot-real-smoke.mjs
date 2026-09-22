#!/usr/bin/env node
/*
 * Real GitHub Copilot CLI ACP smoke for the Provider Kit.
 *
 * This is deliberately opt-in: it starts the user's real Copilot CLI, creates a real native
 * Session and spends a small amount of inference. By default it uses a stable internal workspace
 *
 *   node bridge/scripts/copilot-real-smoke.mjs
 *   node bridge/scripts/copilot-real-smoke.mjs --cwd /absolute/path
 *
 * Coverage:
 *   1. provider launch + ACP initialize;
 *   2. native session/list + session/new rediscovery;
 *   3. the native model policy (the current Copilot ACP does not expose a model catalog);
 *   4. runtime available_commands_update;
 *   5. prompt streaming through AcpService;
 *   6. Stop/cancel and reuse of the same Session;
 *   7. a fresh ACP process reopens the native Session through session/load and continues it.
 */
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { AcpClient } from "../src/acp-client.js"
import { AcpPromptEchoFilter } from "../src/acp-prompt-echo-filter.js"
import { AcpService } from "../src/acp-service.js"
import { findExecutable } from "../src/executable-discovery.js"
import { harnessProfile, resolveAcpLaunch } from "../src/harness-profiles.js"

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function visibleText(messages, role = "assistant") {
  return messages
    .filter((message) => message?.info?.role === role)
    .map((message) => (message.parts ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join(""))
    .join("\n")
}

const failures = []
function check(condition, description) {
  console.log(`${condition ? "ok  " : "FAIL"} ${description}`)
  if (!condition) failures.push(description)
}

const profile = harnessProfile("copilot")
if (!findExecutable("copilot")) {
  console.error("`copilot` is not on PATH. Install and authenticate GitHub Copilot CLI first.")
  process.exit(2)
}

const requestedDirectory = argument("cwd")
const internalWorkspace = path.join(homedir(), ".harness-remote", "smoke-workspaces", "copilot")
const directory = path.resolve(requestedDirectory ?? internalWorkspace)
await mkdir(directory, { recursive: true })
const launch = resolveAcpLaunch(profile)

function runtime() {
  const acp = new AcpClient({
    command: launch.command,
    args: launch.args,
    permissionMode: profile.permissionMode,
    preferredAuthMethod: profile.authMethod
  })
  acp.on("stderr", (line) => process.stderr.write(`[copilot] ${line}\n`))
  const service = new AcpService(new AcpPromptEchoFilter(acp), {
    historyLoader: profile.historyLoader,
    preserveListedTimestamps: profile.preserveListedTimestamps,
    reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
    replaySettleMs: profile.replaySettleMs,
    promptSettleMs: profile.promptSettleMs,
    modelVariantConfigIDs: profile.modelVariantConfigIDs
  })
  return { acp, service }
}

let first
let second
try {
  first = runtime()
  await first.acp.start()
  console.log(`Copilot ${first.acp.agentInfo?.version ?? "?"} via ${launch.command} ${launch.args.join(" ")}`)
  console.log(`workspace ${directory}`)
  check(Boolean(first.acp.agentInfo), "ACP initialize returned agentInfo")

  const before = await first.service.listSessions(directory)
  check(Array.isArray(before), "native session/list succeeds")

  const created = await first.service.createSession({ directory })
  check(Boolean(created?.id), "session/new returned a native Session id")
  console.log(`session ${created.id}`)

  const listed = await first.service.listSessions(directory)
  check(listed.some((session) => session.id === created.id), "new native Session is rediscovered by session/list")

  check(profile.modelSelection === "harness-default", "Copilot uses the native CLI model policy")
  check(profile.capabilities.models === false, "Copilot does not require a model catalog")
  console.log("ok   Copilot ACP exposes no model catalog; the bridge will not request one")

  // Copilot sends available_commands_update asynchronously just after session/new.
  await sleep(500)
  const commands = await first.service.commands(created.id)
  const commandNames = commands.map((command) => command.name)
  check(commandNames.length > 0, "available_commands_update produced a runtime command catalog")
  check(commandNames.includes("context"), "runtime command catalog includes /context")
  console.log(`commands: ${commandNames.slice(0, 12).map((name) => `/${name}`).join(", ")}${commandNames.length > 12 ? ", …" : ""}`)

  await first.service.promptAndWait(created.id, "Reply with exactly COPILOT-HR-SMOKE and nothing else.")
  let page = await first.service.messagePage(created.id, { limit: 200 })
  let answer = visibleText(page.messages)
  check(answer.includes("COPILOT-HR-SMOKE"), "prompt streams a complete assistant reply through AcpService")
  check(first.service.status(created.id).type === "idle", "Session returns to Ready after the prompt")

  const cancellable = first.service.promptAndWait(
    created.id,
    "Run the shell command node -e \"setTimeout(()=>console.log('DONE'),20000)\" and then reply COPILOT-CANCEL-TOO-LATE."
  ).catch((error) => error)
  await sleep(1_000)
  check(first.service.status(created.id).type === "busy", "Session enters Working before Stop")
  first.service.abort(created.id)
  await cancellable
  check(first.service.status(created.id).type === "idle", "Stop returns the Session to Ready")
  await sleep(500)

  await first.service.promptAndWait(created.id, "Reply with exactly COPILOT-AFTER-STOP and nothing else.")
  page = await first.service.messagePage(created.id, { limit: 300 })
  answer = visibleText(page.messages)
  check(answer.includes("COPILOT-AFTER-STOP"), "same native Session accepts a new prompt after Stop")

  first.acp.close()
  first = null

  second = runtime()
  await second.acp.start()
  const reopened = await second.service.claimSession(created.id)
  check(reopened === true, "fresh ACP process reopens the native Session through session/load")

  page = await second.service.messagePage(created.id, { limit: 400 })
  answer = visibleText(page.messages)
  check(answer.includes("COPILOT-HR-SMOKE"), "reopened native Session history contains the original assistant reply before a new prompt")
  check(answer.includes("COPILOT-AFTER-STOP"), "reopened native Session history contains the post-Stop reply before a new prompt")

  await second.service.promptAndWait(created.id, "Reply with exactly COPILOT-REOPENED and nothing else.")
  page = await second.service.messagePage(created.id, { limit: 400 })
  answer = visibleText(page.messages)
  check(answer.includes("COPILOT-REOPENED"), "reopened native Session continues successfully")
  check(second.service.status(created.id).type === "idle", "reopened Session settles back to Ready")
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(error)
} finally {
  first?.acp.close()
  second?.acp.close()
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log("\nall Copilot ACP checks passed")
