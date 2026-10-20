import { findExecutable, codexAdapterEnvironment } from "./executable-discovery.js"
import { createCodexHistoryLoader } from "./codex-session-history.js"
import { createOmpHistoryLoader } from "./omp-session-history.js"
import { createPiHistoryLoader } from "./pi-session-history.js"
import { OMP_EXTENSION_ACTION_PROVIDERS } from "./extension-actions.js"
import { createAcpProviderRegistry, defineAcpProvider } from "./acp-provider-kit.js"
import { resolveOpenCodeCommand } from "./opencode-discovery.js"
import { CopilotModelCatalog } from "./copilot-model-catalog.js"
import { createOpenCode2HistoryLoader } from "./opencode2-session-history.js"

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
  sessionRename: true,
  sessionDelete: true,
  // What a prompt decoded while the harness is still working does. `steer` posts it into the live
  // turn, where the official adapter documents that behavior; `queue` holds it until that turn
  // completes, which is what every other ACP harness does. The UI presentation of one Send falls out
  // of this capability, so it must match what AcpService actually does per harness.
  midTurnPrompt: "queue"
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
    // session-load fixes while keeping the same ACP executable contract. 0.84.0 embeds 0.3.284,
    // whose model catalog includes Opus 5.5.
    args: ["--yes", "--package=@agentclientprotocol/claude-agent-acp@0.84.0", "claude-agent-acp"],
    adapterCommand: "claude-agent-acp",
    permissionMode: "allow",
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    // session/load replays the complete native transcript, split per Anthropic API message, while
    // a live turn is recorded as one bridge-owned message. Merging the two kept both copies.
    replayAuthoritative: true,
    recoverMissingSessionOnPrompt: true,
    // Every chunk carries the Anthropic message id it belongs to (stable within one API message).
    assistantMessageIDsSeparateReplies: true,
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
    // Current Copilot ACP omits model options. Its native SDK transport exposes the live catalog.
    createModelCatalog: (options) => new CopilotModelCatalog({ ...options, includeAuto: true }),
    modelCatalogSource: "copilot-sdk-models-list",
    fallbackModelSelectionMethod: "session/prompt",
    fallbackModelCommand: "model",
    replayAuthoritative: true,
    replayUserChunksAreMessages: true,
    label: "GitHub Copilot CLI",
    command: "copilot",
    detectCommands: ["copilot"],
    launchPriority: 50,
    args: ["--acp", "--stdio", ...(process.env.HARNESS_REMOTE_COPILOT_MODEL ? ["--model", process.env.HARNESS_REMOTE_COPILOT_MODEL] : [])],
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
      models: true,
      todos: false,
      // Copilot ACP advertises its current slash-command set through available_commands_update.
      commands: true,
      questions: false,
      permissions: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  }),
  opencode2: defineAcpProvider({
    id: "opencode2",
    label: "OpenCode 2",
    createHistoryLoader: createOpenCode2HistoryLoader,
    requireExistingDirectory: true,
    replaySettleMs: 250,
    promptSettleMs: 250,
    // Both official command names are version-probed before launch. A v1 `opencode` stays on
    // the legacy HTTP path; explicit v2 selection can fetch this verified release independently.
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    detectCommands: ["opencode2", "opencode"],
    launchPriority: 60,
    args: ["--yes", "--package=@opencode/cli@2.0.28", "opencode2", "acp"],
    adapterCommand: "opencode2",
    adapterArgs: ["acp"],
    executableGeneration: 2,
    // Native exports retain message boundaries and final text across restarts without opening a
    // removed project. ACP replay remains authoritative when loading writer configuration.
    replayAuthoritative: true,
    allowPackageFallback: true,
    permissionMode: "allow",
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    modelVariantConfigIDs: ["effort"],
    modelVariantDefaultValues: ["default"],
    sessionContract: {
      authority: "native-harness",
      discovery: "native-list",
      transcript: "native-export",
      externalWriterObservation: "supported-via-native-export",
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
      sessionRename: true,
      sessionDelete: true
    }
  }),
  mimo: defineAcpProvider({
    id: "mimo",
    label: "MiMo Code",
    command: "mimo",
    detectCommands: ["mimo"],
    launchPriority: 70,
    args: ["acp"],
    permissionMode: "allow",
    // Current MiMo ACP advertises `opencode-login` but its authenticate RPC throws
    // "Authentication not implemented". It relies on credentials configured in the CLI itself.
    authenticate: false,
    environment: {
      // Every `mimo` start copies new ~/.claude/projects transcripts into MiMo's own Session index,
      // so each Claude Code Session would reappear in the rail as a MiMo Session with the same turns.
      MIMOCODE_DISABLE_CLAUDE_IMPORT: "1",
      // Keep the user's configured provider; the historical hosted MiMo Auto service is retired.
      ...(process.env.HARNESS_REMOTE_MIMO_CONFIG_CONTENT
        ? { MIMOCODE_CONFIG_CONTENT: process.env.HARNESS_REMOTE_MIMO_CONFIG_CONTENT }
        : {})
    },
    sessionListScope: "project",
    // MiMo replays the complete native transcript. Replacing a cached partial transcript is also
    // required when an idle project process was retired and the Session is opened again.
    replayAuthoritative: true,
    refreshSessionListOnRead: false,
    catalogSessionCleanup: { command: "mimo", args: ["session", "delete"] },
    excludedModelValuePrefixes: ["mimo/mimo-auto"],
    inlineModelVariantValues: ["none", "low", "medium", "high", "xhigh"],
    modelProviderOrder: ["xiaomi", "openai"],
    requireAssistantResponse: true,
    lifecycleContract: COMMON_ACP_LIFECYCLE_CONTRACT,
    // Native model options include reasoning as provider/model/variant wire values.
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
      models: true,
      todos: false,
      commands: false,
      permissions: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  }),
  codex: defineAcpProvider({
    id: "codex",
    label: "Codex",
    // Uses the official ACP adapter for the OpenAI Codex CLI. The adapter speaks ACP JSON-RPC
    // over stdio and embeds @openai/codex, so no separate Codex installation is needed. The
    // user needs a cached Codex login (desktop app or CLI) or configured provider credentials.
    // Requires Node 22+ (same as the PI and Claude adapters it mirrors).
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    detectCommands: ["codex"],
    // Use the detected CLI or desktop binary rather than an unrelated npm copy.
    environment: codexAdapterEnvironment(),
    launchPriority: 10,
    // Pinned to avoid the `notarget` scenario that PI hit. Like PI, install the scoped package
    // explicitly and invoke its published binary instead of relying on npx package-spec inference.
    args: ["--yes", "--package=@agentclientprotocol/codex-acp@1.13.1", "codex-acp"],
    adapterCommand: "codex-acp",
    permissionMode: "allow",
    // The adapter checks the existing account before each operation. Calling authenticate
    // during discovery forces token refresh and can open a browser login on app startup.
    // Reuse the native account; a missing login should surface as an auth error instead.
    authenticate: false,
    authMethod: "chat-gpt",
    // Codex holds a single-writer lock for as long as a client keeps a thread open, so a session the
    // desktop app is showing cannot be loaded over ACP at all. Its rollout file can, which is what
    // lets those sessions be read here. `messages` already forces a reload for every session this
    // bridge does not own, so a conversation still running in Codex keeps updating without asking
    // for the replay that the sessions we do own would otherwise repeat on each refresh.
    historyLoader: createCodexHistoryLoader(),
    // Rollout byte-offset ids differ from live ACP message ids. Seed an owned Session from its
    // journal once, then keep the live stream authoritative while this daemon writes it.
    journalPageWhileOwned: false,
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
      // Codex accepts new input while it is still working: its turn keeps running and the input
      // joins it, which is what typing into the Codex CLI mid-task feels like. The official adapter
      // exposes exactly that through `_session/steering`, injected into or starting a turn, so this
      // bridge forwards mid-turn prompts as steering instead of queueing them.
      midTurnPrompt: "steer",
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
export function resolveAcpLaunch(profile, { find = findExecutable, readVersion } = {}) {
  if (!profile.adapterCommand) return { command: profile.command, args: [...profile.args], source: "harness" }
  const installed = profile.executableGeneration
    ? resolveOpenCodeCommand(profile.executableGeneration, { find, ...(readVersion ? { readVersion } : {}) })
    : find(profile.adapterCommand)
  if (installed) return { command: installed, args: [...(profile.adapterArgs ?? [])], source: "path" }
  return { command: profile.command, args: [...profile.args], source: "npx" }
}
