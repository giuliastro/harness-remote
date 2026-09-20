#!/usr/bin/env node
import { runAcpProviderRealSmoke } from "./acp-provider-real-smoke-lib.mjs"

await runAcpProviderRealSmoke("mimo", {
  displayName: "MiMo Code",
  executable: "mimo",
  marker: "MIMO-HR-SMOKE",
  // MiMo rejects a truly empty workspace on some releases. The shared smoke helper seeds a stable
  // Harness Remote-owned workspace, so this gate never creates persistent test Sessions in the
  // caller's real project.
  temporaryPrefix: "harness-mimo-smoke-",
  checkCommands: false,
  checkModels: true,
  requireModelSwitch: true,
  debugLaunchArgs: ["--print-logs", "--log-level", "DEBUG", "acp"]
})
