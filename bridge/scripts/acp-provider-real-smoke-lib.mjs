import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
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

function ensureGitWorkspace(directory) {
  try {
    execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { stdio: "ignore" })
  } catch {
    execFileSync("git", ["-C", directory, "init", "--quiet", "--initial-branch=main"], { stdio: "ignore" })
  }
  try {
    execFileSync("git", ["-C", directory, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" })
  } catch {
    execFileSync("git", ["-C", directory, "config", "user.email", "harness-remote-smoke@example.invalid"], { stdio: "ignore" })
    execFileSync("git", ["-C", directory, "config", "user.name", "Harness Remote smoke"], { stdio: "ignore" })
    execFileSync("git", ["-C", directory, "add", "--all"], { stdio: "ignore" })
    execFileSync("git", ["-C", directory, "commit", "--quiet", "-m", "Initialize Harness Remote smoke workspace"], { stdio: "ignore" })
  }
}

export async function runAcpProviderRealSmoke(providerID, {
  displayName,
  executable,
  marker,
  temporaryPrefix,
  defaultDirectory,
  checkCommands = false,
  checkModels = false,
  requireModelSwitch = false,
  requiresGitWorkspace = false,
  adjustLaunchArgs = ({ args }) => args,
  debugLaunchArgs = []
} = {}) {
  const failures = []
  const check = (condition, description) => {
    console.log(`${condition ? "ok  " : "FAIL"} ${description}`)
    if (!condition) failures.push(description)
  }

  const profile = harnessProfile(providerID)
  const executableName = executable ?? profile.detectCommands?.[0] ?? profile.command
  const label = displayName ?? profile.label ?? providerID
  if (executableName && !findExecutable(executableName) && !profile.allowPackageFallback) {
    console.error(`${JSON.stringify(executableName)} is not on PATH. Install and authenticate ${label} first.`)
    process.exitCode = 2
    return
  }

  const requestedDirectory = argument("cwd")
  // ACP providers persist native Session ids beyond this process and several do not expose native
  // deletion. Removing a temporary workspace afterwards leaves a permanently broken Session in the
  // provider index. Use one stable internal workspace instead; the Session rail filters this path.
  const internalWorkspace = path.join(homedir(), ".harness-remote", "smoke-workspaces", providerID)
  const fallbackDirectory = requestedDirectory ?? defaultDirectory ?? internalWorkspace
  await mkdir(fallbackDirectory, { recursive: true })
  // Some ACP adapters (notably MiMo) reject session/new in a truly empty workspace. Seed only the
  // Harness Remote-owned workspace; an explicit user --cwd/defaultDirectory is never modified.
  if (!requestedDirectory && !defaultDirectory) {
    await writeFile(
      path.join(internalWorkspace, ".harness-remote-smoke-workspace"),
      "Harness Remote internal provider smoke workspace.\n",
      { flag: "a" }
    )
  }
  const directory = path.resolve(fallbackDirectory)
  if (!requestedDirectory && !defaultDirectory && requiresGitWorkspace) ensureGitWorkspace(directory)
  const launch = resolveAcpLaunch(profile)
  const debug = process.argv.includes("--debug")
  const launchArgs = adjustLaunchArgs({
    command: launch.command,
    args: debug && debugLaunchArgs.length ? [...debugLaunchArgs] : [...launch.args],
    directory
  })
  const responseMarker = marker ?? `${providerID.toUpperCase()}-HR-SMOKE`

  function runtime() {
    const acp = new AcpClient({
      command: launch.command,
      args: launchArgs,
      cwd: directory,
      permissionMode: profile.permissionMode,
      preferredAuthMethod: profile.authMethod,
      authenticate: profile.authenticate,
      environment: profile.environment
    })
    acp.on("stderr", (line) => process.stderr.write(`[${providerID}] ${line}\n`))
    const service = new AcpService(new AcpPromptEchoFilter(acp), {
      historyLoader: profile.historyLoader,
      preserveListedTimestamps: profile.preserveListedTimestamps,
      reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
      replaySettleMs: profile.replaySettleMs,
      promptSettleMs: profile.promptSettleMs,
      modelVariantConfigIDs: profile.modelVariantConfigIDs,
      excludedModelValuePrefixes: profile.excludedModelValuePrefixes,
      requireAssistantResponse: profile.requireAssistantResponse
    })
    return { acp, service }
  }

  let first
  let second
  try {
    first = runtime()
    await first.acp.start()
    console.log(`${label} ${first.acp.agentInfo?.version ?? "?"} via ${launch.command} ${launchArgs.join(" ")}`)
    console.log(`workspace ${directory}`)
    check(Boolean(first.acp.agentInfo), "ACP initialize returned agentInfo")

    const before = await first.service.listSessions(directory)
    check(Array.isArray(before), "native session/list succeeds")

    const created = await first.service.createSession({ directory })
    check(Boolean(created?.id), "session/new returned a native Session id")
    console.log(`session ${created.id}`)

    const listed = await first.service.listSessions(directory)
    check(listed.some((session) => session.id === created.id), "new native Session is rediscovered by session/list")

    await sleep(500)
    if (checkCommands) {
      const commands = await first.service.commands(created.id)
      const commandNames = commands.map((command) => command.name)
      check(commandNames.length > 0, "runtime command catalog is available")
      console.log(`commands: ${commandNames.slice(0, 12).map((name) => `/${name}`).join(", ")}${commandNames.length > 12 ? ", …" : ""}`)
    }

    if (checkModels) {
      const models = await first.service.models(created.id)
      check(models.length > 0, "runtime model catalog is available through ACP config options")
      console.log(`models: ${models.slice(0, 8).map((model) => model.value ?? model.name ?? "?").join(", ")}${models.length > 8 ? ", …" : ""}`)
      const requestedModel = argument("model")
      const preferredSmokeModel = requestedModel
        ?? models.find((model) => (model.value ?? model.name) === "opencode/big-pickle")?.value
        ?? models.find((model) => (model.value ?? model.name) === "opencode/big-pickle")?.name
        ?? (requireModelSwitch
          ? models.find((model) => !model.currentValue)?.value ?? models.find((model) => !model.currentValue)?.name
          : undefined)
      if (requireModelSwitch) {
        check(models.length >= 2, "runtime model catalog exposes at least two selectable models")
        check(Boolean(preferredSmokeModel), "an alternate advertised model is available for switching")
      }
      if (preferredSmokeModel) {
        await first.service.setModel(created.id, preferredSmokeModel)
        const switched = await first.service.models(created.id)
        check(
          switched.some((model) => (model.value ?? model.name) === preferredSmokeModel && model.currentValue),
          `runtime model switch is reflected by the Session (${preferredSmokeModel})`
        )
        console.log(`smoke model: ${preferredSmokeModel}`)
      }
    }

    await first.service.promptAndWait(created.id, `Reply with exactly ${responseMarker} and nothing else.`)
    let page = await first.service.messagePage(created.id, { limit: 200 })
    let answer = visibleText(page.messages)
    check(answer.includes(responseMarker), "prompt streams a complete assistant reply through AcpService")
    check(first.service.status(created.id).type === "idle", "Session returns to Ready after the prompt")

    const afterStopMarker = `${responseMarker}-AFTER-STOP`
    const cancellable = first.service.promptAndWait(
      created.id,
      `Run the shell command node -e "setTimeout(()=>console.log('DONE'),20000)" and then reply ${responseMarker}-CANCEL-TOO-LATE.`
    ).catch((error) => error)
    await sleep(1_000)
    check(first.service.status(created.id).type === "busy", "Session enters Working before Stop")
    first.service.abort(created.id)
    await cancellable
    check(first.service.status(created.id).type === "idle", "Stop returns the Session to Ready")
    await sleep(500)

    await first.service.promptAndWait(created.id, `Reply with exactly ${afterStopMarker} and nothing else.`)
    page = await first.service.messagePage(created.id, { limit: 300 })
    answer = visibleText(page.messages)
    check(answer.includes(afterStopMarker), "same native Session accepts a new prompt after Stop")

    first.acp.close()
    first = null

    second = runtime()
    await second.acp.start()
    const reopened = await second.service.claimSession(created.id)
    check(reopened === true, "fresh ACP process reopens the native Session through session/load or resume")

    page = await second.service.messagePage(created.id, { limit: 400 })
    answer = visibleText(page.messages)
    check(answer.includes(responseMarker), "reopened native Session history contains the original assistant reply before a new prompt")
    check(answer.includes(afterStopMarker), "reopened native Session history contains the post-Stop reply before a new prompt")

    const reopenMarker = `${responseMarker}-REOPENED`
    await second.service.promptAndWait(created.id, `Reply with exactly ${reopenMarker} and nothing else.`)
    page = await second.service.messagePage(created.id, { limit: 400 })
    answer = visibleText(page.messages)
    check(answer.includes(reopenMarker), "reopened native Session continues successfully")
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
    process.exitCode = 1
    return
  }

  console.log(`\nall ${label} ACP checks passed`)
}
