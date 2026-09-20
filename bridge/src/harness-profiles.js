import { findExecutable } from "./executable-discovery.js"
import { createCodexHistoryLoader } from "./codex-session-history.js"
import { createOmpHistoryLoader } from "./omp-session-history.js"
import { createPiHistoryLoader } from "./pi-session-history.js"
import { OMP_EXTENSION_ACTION_PROVIDERS } from "./extension-actions.js"
import { createAcpProviderRegistry, defineAcpProvider } from "./acp-provider-kit.js"

const COMMON_ACP_LIFECYCLE_CONTRACT = {
  sessionAuthority: "native-harness",
  create: "native-session",
  resume: "native-session-when-supported",
  stop: "native-abort",
  reconnect: "daemon-reconciliation"
}

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
  omp: defineAcpProvider({
    id: "omp",
    label: "Oh My Pi",
    command: "omp",
    detectCommands: ["omp"],
    launchPriority: 30,
    args: ["acp"],
    permissionMode: "allow",
    historyLoader: createOmpHistoryLoader(),
    // OMP's journal is the only place a message has a stable identity. Its ACP stream mints a new
    // `messageId` for every live message and mints new ones again on every `session/load` replay,
    // so a Session read once from each source is one conversation with two sets of ids. The journal
    // is therefore the transcript until this bridge takes the writer, and this bridge's own stream
    // is the transcript from then on - never both at once. See AcpService#journalPageWhileOwned.
    journalPageWhileOwned: false,
    // OMP stores a Session's name itself - `/rename` calls `setSessionName(title, "user")`, which
    // writes the title slot and marks it user-set so OMP's own auto-titling leaves it alone. A name
    // kept only in this bridge's snapshot was invisible in the Session index, which reads the
    // harness's lightweight listing, and gone entirely for a Session reopened from OMP.
    nativeRenameCommand: "rename",
    preferListedTitles: true,
    // A transcript that already came from the journal must not be asked for again over ACP, so an
    // owned OMP Session is opened with `session/resume` rather than the replaying `session/load`.
    // Reloading on refresh would reintroduce exactly that replay.
    reloadOnHistoryRefresh: false,
    // OMP exposes thinking as a real ACP config option. We probe only ids the running adapter
    // actually advertises; this list is a routing hint, never a source of invented variants.
    modelVariantConfigIDs: ["thinking"],
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "native-journal",
      externalWriterObservation: "unverified-via-journal",
      continuation: "session-load",
      writerOwnership: "adapter-defined",
      stop: "owned-session-native-cancel"
    },
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
  }),
  pi: defineAcpProvider({
    id: "pi",
    label: "PI",
    // @automatalabs/pi-acp embeds PI through its published SDK and runs on Node. Version 0.5.0
    // advertises PI's credential- and provider-filter-aware model catalog directly over ACP, so
    // Harness Remote must not launch a second native `pi` process just to filter membership.
    // npx cannot reliably infer a scoped package's executable from a package spec. Add the package
    // explicitly and invoke the binary the package publishes, otherwise npm may try to execute the
    // literal package spec and exit 127 on a real machine.
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    detectCommands: ["pi"],
    launchPriority: 40,
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
    // PI can acknowledge session/prompt before its final session/update notifications arrive. Keep
    // that same short drain window around a completed prompt so late reasoning closes as Done.
    promptSettleMs: 250,
    // Current PI ACP calls this `thinkingLevel`. The aliases are harmless compatibility hints for
    // adapter versions that rename the wire id; a variant is emitted only when that option exists.
    modelVariantConfigIDs: ["thinkingLevel", "thinking_level", "thinking"],
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "native-journal-authoritative",
      externalWriterObservation: "supported-via-journal",
      continuation: "session-load",
      writerOwnership: "claim-on-session-load",
      stop: "owned-session-native-cancel"
    },
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: false,
      commands: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  }),
  claude: defineAcpProvider({
    id: "claude",
    label: "Claude Code",
    // Uses the official ACP adapter for the Claude Agent SDK. The adapter speaks ACP JSON-RPC
    // over stdio and wraps @anthropic-ai/claude-agent-sdk under the hood. The user must have
    // run `claude login` or set ANTHROPIC_API_KEY before starting the bridge.
    // Requires Node 22+ (same as the PI adapter it mirrors).
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    detectCommands: ["claude"],
    launchPriority: 20,
    // Pinned to avoid the `notarget` scenario that PI hit. Like PI, install the scoped package
    // explicitly and invoke its published binary instead of relying on npx package-spec inference.
    // 0.63.0 embeds Claude Agent SDK 0.3.220, whose Claude Code core rejects newer advertised
    // models such as Fable 5.1 at prompt time. 0.75.1 embeds 0.3.257 and retains the adapter's
    // session-load fixes while keeping the same ACP executable contract.
    args: ["--yes", "--package=@agentclientprotocol/claude-agent-acp@0.75.1", "claude-agent-acp"],
    adapterCommand: "claude-agent-acp",
    permissionMode: "allow",
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    // The current adapter exposes model/mode but no low/medium/high reasoning-effort selector.
    // Keep this empty rather than fabricating OpenCode-style variants.
    modelVariantConfigIDs: [],
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "session-load",
      externalWriterObservation: "unverified-session-load",
      continuation: "session-load",
      writerOwnership: "adapter-defined",
      stop: "owned-session-native-cancel"
    },
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
  }),
  copilot: defineAcpProvider({
    id: "copilot",
    label: "GitHub Copilot CLI",
    command: "copilot",
    detectCommands: ["copilot"],
    launchPriority: 50,
    args: ["--acp", "--stdio"],
    permissionMode: "allow",
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    modelVariantConfigIDs: [],
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "session-load",
      externalWriterObservation: "unverified-session-load",
      continuation: "session-load",
      writerOwnership: "adapter-defined",
      stop: "owned-session-native-cancel"
    },
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: false,
      todos: false,
      // Copilot ACP advertises its current slash-command set through available_commands_update.
      commands: true,
      questions: false,
      permissions: true,
      actions: false,
      sessionRename: false,
      sessionDelete: false
    }
  }),
  opencode2: defineAcpProvider({
    id: "opencode2",
    label: "OpenCode 2",
    // Official OpenCode 2 still publishes the executable name `opencode`, which collides with
    // the existing OpenCode installation on machines that want both generations. Prefer an
    // optional `opencode2` alias when present; otherwise explicit selection launches the official
    // v2 npm package without replacing the user's current `opencode` binary.
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    detectCommands: ["opencode2"],
    launchPriority: 60,
    args: ["--yes", "--package=@opencode/cli", "opencode", "acp"],
    adapterCommand: "opencode2",
    adapterArgs: ["acp"],
    allowPackageFallback: true,
    permissionMode: "allow",
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    modelVariantConfigIDs: ["effort"],
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "session-load",
      externalWriterObservation: "unverified-session-load",
      continuation: "session-load",
      writerOwnership: "adapter-defined",
      stop: "owned-session-native-cancel"
    },
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: false,
      commands: true,
      permissions: true,
      actions: false,
      sessionRename: false,
      sessionDelete: false
    }
  }),
  mimo: defineAcpProvider({
    id: "mimo",
    label: "MiMo Code",
    command: "mimo",
    // Keep MiMo explicit-only until its real ACP session/new path is proven on a released build.
    // v0.1.14 initializes and lists Sessions but currently fails session/new upstream.
    detectCommands: [],
    experimental: true,
    launchPriority: 70,
    args: ["acp"],
    permissionMode: "allow",
    // Current MiMo ACP advertises `opencode-login` but its authenticate RPC throws
    // "Authentication not implemented". It relies on credentials configured in the CLI itself.
    authenticate: false,
    // Work around upstream #865 without mutating the user's config: MiMo's ACP ignores the
    // DB-backed default set by `mimo auth login`, while inline config is honored by defaultModel().
    // The override is process-scoped and only supplies a safe bootstrap model for session/new.
    environment: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "mimo/mimo-auto" })
    },
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    // MiMo Code is OpenCode-derived, but its ACP implementation currently has open
    // compatibility issues around model defaults and Session prompting. Start with a
    // fail-safe surface and widen it only after a real-machine smoke proves the wire.
    modelVariantConfigIDs: [],
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "session-load",
      externalWriterObservation: "unverified-session-load",
      continuation: "session-load",
      writerOwnership: "adapter-defined",
      stop: "owned-session-native-cancel"
    },
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: false,
      todos: false,
      commands: false,
      permissions: true,
      actions: false,
      sessionRename: false,
      sessionDelete: false
    }
  }),
  codex: defineAcpProvider({
    id: "codex",
    label: "Codex CLI",
    // Uses the official ACP adapter for the OpenAI Codex CLI. The adapter speaks ACP JSON-RPC
    // over stdio and embeds @openai/codex, so no separate Codex installation is needed. The
    // user must have run `codex login` (ChatGPT account) or set an OpenAI API key first.
    // Requires Node 22+ (same as the PI and Claude adapters it mirrors).
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    detectCommands: ["codex"],
    launchPriority: 10,
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
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "native-journal",
      externalWriterObservation: "supported-via-journal",
      continuation: "session-load",
      writerOwnership: "single-writer",
      stop: "owned-session-native-cancel"
    },
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
  })
}

const ACP_PROVIDER_REGISTRY = createAcpProviderRegistry(Object.values(HARNESS_PROFILES))

export function harnessProfile(id) {
  return ACP_PROVIDER_REGISTRY.get(id)
}

export function acpProviderProfile(id) {
  return ACP_PROVIDER_REGISTRY.get(id)
}

export function listAcpProviderProfiles() {
  return ACP_PROVIDER_REGISTRY.list()
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
  if (installed) return { command: installed, args: [...(profile.adapterArgs ?? [])], source: "path" }
  return { command: profile.command, args: [...profile.args], source: "npx" }
}
