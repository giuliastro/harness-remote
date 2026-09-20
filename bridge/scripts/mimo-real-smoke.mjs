#!/usr/bin/env node
import { runAcpProviderRealSmoke } from "./acp-provider-real-smoke-lib.mjs"

await runAcpProviderRealSmoke("mimo", {
  displayName: "MiMo Code",
  executable: "mimo",
  marker: "MIMO-HR-SMOKE",
  // MiMo 0.1.14 session/new is validated against a real workspace. Empty temporary directories
  // can fail inside the upstream SDK before the Session is created, so default to the caller cwd.
  defaultDirectory: process.cwd(),
  temporaryPrefix: "harness-mimo-smoke-",
  checkCommands: false,
  checkModels: false,
  debugLaunchArgs: ["--print-logs", "--log-level", "DEBUG", "acp"]
})
