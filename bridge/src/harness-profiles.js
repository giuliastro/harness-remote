import { findExecutable } from "./launcher.js"
import { createCodexHistoryLoader } from "./codex-session-history.js"
import { createOmpHistoryLoader } from "./omp-session-history.js"
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
    // @automatalabs/pi-acp embeds PI through its published SDK and runs on Node.
    // @victor-software-house/pi-acp declares engines.bun and shells out to `bun`, which this
    // project deliberately does not depend on. The version is pinned because an unpinned
    // default failed with `notarget` when a release outran its own tarball in the registry.
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@automatalabs/pi-acp@0.2.5"],
    adapterCommand: "pi-acp",
    permissionMode: "allow",
    preserveListedTimestamps: true,
    // Opening a PI session explicitly asks for fresh history. Honour that request so a stale bridge
    // snapshot cannot hide assistant output that PI has already persisted.
    reloadOnHistoryRefresh: true,
    // PI owns its display names. The bridge must use the title from session/list and propagate an
    // app rename through PI's own /name command so the app and PI /resume cannot drift apart.
    preferListedTitles: true,
    nativeRenameCommand: "name",
    // PI may flush the last replay chunks just after session/load resolves, most visibly on Windows.
    replaySettleMs: 250,
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
    // Pinned to avoid the `notarget` scenario that PI hit: an unpinned default failed when a
    // release appeared in the registry index before its tarball could be fetched.
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.63.0"],
    adapterCommand: "claude-agent-acp",
    permissionMode: "allow",
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
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
    // Pinned to avoid the `notarget` scenario that PI hit: an unpinned default failed when a
    // release appeared in the registry index before its tarball could be fetched.
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.14"],
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
 * binary — which is exactly what happens under proot on Android.
 */
export function resolveAcpLaunch(profile, { find = findExecutable } = {}) {
  if (!profile.adapterCommand) return { command: profile.command, args: [...profile.args], source: "harness" }
  const installed = find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }
  return { command: profile.command, args: [...profile.args], source: "npx" }
}
