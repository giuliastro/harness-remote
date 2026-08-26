import { findExecutable } from "./launcher.js"
import { createCodexHistoryLoader } from "./codex-session-history.js"
import { createOmpHistoryLoader } from "./omp-session-history.js"
import { createPiHistoryLoader } from "./pi-session-history.js"
import { OMP_EXTENSION_ACTION_PROVIDERS } from "./extension-actions.js"

const COMMON_CAPABILITIES = {
  sessions: true,
  prompt: true,
  abort: true,
  streaming: true,
  agents: false,
  diff: false,
  filesystemBrowser: true,
  questions: false,
  permissions: false,
  sessionRename: false,
  sessionDelete: false
}

export const HARNESS_PROFILES = {
  omp: {
    id: "omp",
    label: "Oh My Pi",
    command: "omp",
    args: ["acp"],
    permissionMode: "allow",
    historyLoader: createOmpHistoryLoader(),
    // OMP exposes thinking as a real ACP config option. We probe only ids the running adapter
    // actually advertises; this list is a routing hint, never a source of invented variants.
    modelVariantConfigIDs: ["thinking"],
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: true,
      commands: true,
      actions: true,
      sessionRename: true,
      sessionDelete: true
    },
    actionProviders: OMP_EXTENSION_ACTION_PROVIDERS
  },
  pi: {
    id: "pi",
    label: "PI",
    // @automatalabs/pi-acp embeds PI through its published SDK and runs on Node. Version 0.5.0
    // advertises PI's credential- and provider-filter-aware model catalog directly over ACP, so
    // Harness Remote must not launch a second native `pi` process just to filter membership.
    // npx cannot reliably infer a scoped package's executable from a package spec. Add the package
    // explicitly and invoke the binary the package publishes, otherwise npm may try to execute the
    // literal package spec and exit 127 on a real machine.
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "--package=@automatalabs/pi-acp@0.5.0", "pi-acp"],
    adapterCommand: "pi-acp",
    permissionMode: "allow",
    historyLoader: createPiHistoryLoader(),
    preserveListedTimestamps: true,
    // PI journals are authoritative for transcript and title metadata. session/load is a live-session
    // operation and cannot be used as a refresh primitive because PI rejects a second open.
    reloadOnHistoryRefresh: false,
    preferListedTitles: true,
    // Keep the replay tail for the one real session/load used when the bridge takes ownership to prompt.
    replaySettleMs: 250,
    // Current PI ACP calls this `thinkingLevel`. The aliases are harmless compatibility hints for
    // adapter versions that rename the wire id; a variant is emitted only when that option exists.
    modelVariantConfigIDs: ["thinkingLevel", "thinking_level", "thinking"],
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: false,
      commands: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    // Uses the official ACP adapter for the Claude Agent SDK. The adapter speaks ACP JSON-RPC
    // over stdio and wraps @anthropic-ai/claude-agent-sdk under the hood. The user must have
    // run `claude login` or set ANTHROPIC_API_KEY before starting the bridge.
    // Requires Node 22+ (same as the PI adapter it mirrors).
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    // Pinned to avoid the `notarget` scenario that PI hit. Like PI, install the scoped package
    // explicitly and invoke its published binary instead of relying on npx package-spec inference.
    args: ["--yes", "--package=@agentclientprotocol/claude-agent-acp@0.63.0", "claude-agent-acp"],
    adapterCommand: "claude-agent-acp",
    permissionMode: "allow",
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    // The current adapter exposes model/mode but no low/medium/high reasoning-effort selector.
    // Keep this empty rather than fabricating OpenCode-style variants.
    modelVariantConfigIDs: [],
    capabilities: {
      ...COMMON_CAPABILITIES,
      // The adapter advertises a `model` config option like OMP and PI do; its values are bare ids
      // rather than `provider/model`, which is handled where the response is built.
      models: true,
      todos: true,
      commands: false,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    // Uses the official ACP adapter for the OpenAI Codex CLI. The adapter speaks ACP JSON-RPC
    // over stdio and embeds @openai/codex, so no separate Codex installation is needed. The
    // user must have run `codex login` (ChatGPT account) or set an OpenAI API key first.
    // Requires Node 22+ (same as the PI and Claude adapters it mirrors).
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    // Pinned to avoid the `notarget` scenario that PI hit. Like PI, install the scoped package
    // explicitly and invoke its published binary instead of relying on npx package-spec inference.
    args: ["--yes", "--package=@agentclientprotocol/codex-acp@1.1.14", "codex-acp"],
    adapterCommand: "codex-acp",
    permissionMode: "allow",
    // The adapter offers `api-key` before `chat-gpt`; the former demands CODEX_API_KEY or
    // OPENAI_API_KEY, while a `codex login` leaves ChatGPT credentials the `chat-gpt` method
    // reads from disk. Prefer the login, exactly like the generic default already avoids
    // env-var methods for the other harnesses.
    authMethod: "chat-gpt",
    // Codex holds a single-writer lock for as long as a client keeps a thread open, so a session the
    // desktop app is showing cannot be loaded over ACP at all. Its rollout file can, which is what
    // lets those sessions be read here. `messages` already forces a reload for every session this
    // bridge does not own, so a conversation still running in Codex keeps updating without asking
    // for the replay that the sessions we do own would otherwise repeat on each refresh.
    historyLoader: createCodexHistoryLoader(),
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    // The official adapter exposes reasoning effort independently from model selection.
    modelVariantConfigIDs: ["reasoning_effort", "reasoningEffort"],
    capabilities: {
      ...COMMON_CAPABILITIES,
      // The adapter advertises model ids as bare ids rather than `provider/model`, which is
      // handled where the response is built. Slash commands and plan updates arrive through
      // the same notifications OMP emits, so commands and todos reflect the actual wire data.
      models: true,
      todos: true,
      commands: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  }
}

export function harnessProfile(id) {
  const profile = HARNESS_PROFILES[id]
  if (!profile) throw new Error(`Unsupported backend: ${id}`)
  return profile
}

/**
 * The harness and its ACP adapter are two different installations. `pi` from the project's own
 * installer puts the harness on PATH and no adapter with it, so detecting the harness and then
 * assuming `npx` can fetch an adapter is how a machine with PI installed ends up unable to run PI.
 *
 * An adapter already on PATH is preferred over fetching one: it is what the user installed, it
 * starts without a network round trip, and it sidesteps environments where `npx` cannot link a
 * binary - which is exactly what happens under proot on Android.
 */
export function resolveAcpLaunch(profile, { find = findExecutable } = {}) {
  if (!profile.adapterCommand) return { command: profile.command, args: [...profile.args], source: "harness" }
  const installed = find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }
  return { command: profile.command, args: [...profile.args], source: "npx" }
}
