#!/usr/bin/env node
/*
 * Real GitHub Copilot CLI ACP smoke. Opt-in: it starts the user's real Copilot CLI, creates a real
 * native Session and spends a small amount of inference. Defaults to a temporary empty workspace.
 *
 *   node bridge/scripts/copilot-real-smoke.mjs [--cwd /absolute/path]
 */
import { runAcpProviderRealSmoke } from "./acp-provider-real-smoke-lib.mjs"

await runAcpProviderRealSmoke("copilot", {
  displayName: "Copilot",
  executable: "copilot",
  marker: "COPILOT-HR-SMOKE",
  temporaryPrefix: "harness-copilot-smoke-",
  checkCommands: true,
  requiredCommands: ["context"]
})
