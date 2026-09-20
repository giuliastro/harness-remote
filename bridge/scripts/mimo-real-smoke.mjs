#!/usr/bin/env node
import { runAcpProviderRealSmoke } from "./acp-provider-real-smoke-lib.mjs"

await runAcpProviderRealSmoke("mimo", {
  displayName: "MiMo Code",
  executable: "mimo",
  marker: "MIMO-HR-SMOKE",
  temporaryPrefix: "harness-mimo-smoke-",
  checkCommands: false,
  checkModels: false,
  debugLaunchArgs: ["--print-logs", "--log-level", "DEBUG", "acp"]
})
