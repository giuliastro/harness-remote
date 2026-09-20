#!/usr/bin/env node
import { runAcpProviderRealSmoke } from "./acp-provider-real-smoke-lib.mjs"

await runAcpProviderRealSmoke("opencode2", {
  displayName: "OpenCode 2",
  executable: "opencode2",
  marker: "OPENCODE2-HR-SMOKE",
  temporaryPrefix: "harness-opencode2-smoke-",
  checkCommands: true,
  checkModels: true
})
