#!/usr/bin/env node
import { runAcpProviderRealSmoke } from "./acp-provider-real-smoke-lib.mjs"

await runAcpProviderRealSmoke("mimo", {
  displayName: "MiMo Code",
  executable: "mimo",
  marker: "MIMO-HR-SMOKE",
  // MiMo 0.1.14 requires a Git workspace for session/new. The shared smoke helper initializes the
  // stable Harness Remote-owned workspace without touching the caller's real project.
  temporaryPrefix: "harness-mimo-smoke-",
  checkCommands: false,
  checkModels: true,
  requireModelSwitch: true,
  requiresGitWorkspace: true,
  adjustLaunchArgs: ({ args, directory }) => [...args, "--cwd", directory],
  debugLaunchArgs: ["--print-logs", "--log-level", "DEBUG", "acp"]
})
