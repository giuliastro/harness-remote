function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))]
}

/**
 * Session-first needs a more precise contract than `capabilities.sessions = true`.
 * Discovery, transcript observation and writer acquisition are independent properties: Codex can
 * read a rollout while its desktop/CLI writer owns the native thread, PI treats its journal as the
 * transcript authority, while Claude currently has no out-of-band history reader and therefore
 * reaches the native Session through ACP session/load.
 *
 * Keep uncertain behavior explicit. "unverified" is intentional here: the UI must not turn the
 * existence of a Session list or history loader into a promise that a second client can safely take
 * ownership of the Session.
 */
function acpSessionContract(profile) {
  if (profile?.sessionContract) return { ...profile.sessionContract }
  return {
    authority: "native-harness",
    discovery: "native-list",
    transcript: profile?.historyLoader ? "native-journal" : "session-load",
    externalWriterObservation: "unverified",
    continuation: "session-load",
    writerOwnership: "adapter-defined",
    stop: "owned-session-native-cancel"
  }
}

export function acpHarnessCapabilityContract(profile) {
  const variantConfigIDs = uniqueStrings(profile?.modelVariantConfigIDs)
  return {
    version: 2,
    protocol: "acp",
    transport: {
      control: "stdio-json-rpc",
      events: "acp-session-update"
    },
    toolCalls: {
      representation: "acp-session-update"
    },
    models: {
      source: "acp-config-options",
      // The release candidate deliberately keeps the last real-machine-validated ownership model:
      // one daemon-owned technical catalog Session per harness adapter lifetime. Project-scoped ACP
      // discovery was audited in isolation but regressed PI, Codex and Claude on Windows, so it is
      // not part of the promotion candidate until it has its own real-harness proof.
      cacheScope: "machine",
      variants: variantConfigIDs.length ? "runtime-advertised-config-options" : "runtime-advertised-only",
      variantConfigIDs
    },
    sessions: acpSessionContract(profile),
    lifecycle: profile?.lifecycleContract
      ? { ...profile.lifecycleContract }
      : {
          // Retain the v1 lifecycle shape for compatibility while Session-first consumers migrate to
          // the more precise `sessions` contract above.
          sessionAuthority: "native-harness",
          create: "native-session",
          resume: "native-session-when-supported",
          stop: "native-abort",
          reconnect: "daemon-reconciliation"
        }
  }
}

export function openCodeCapabilityContract() {
  return {
    version: 2,
    protocol: "opencode-http",
    transport: {
      control: "http-json",
      events: "sse-daemon-fanout"
    },
    toolCalls: {
      representation: "opencode-message-parts"
    },
    models: {
      source: "runtime-provider-api",
      cacheScope: "machine",
      variants: "provider-advertised",
      variantConfigIDs: []
    },
    sessions: {
      authority: "native-harness",
      discovery: "native-http",
      transcript: "native-http",
      externalWriterObservation: "native-http-server",
      continuation: "native-session-id",
      writerOwnership: "native-http-server",
      stop: "native-abort"
    },
    lifecycle: {
      sessionAuthority: "native-harness",
      create: "native-session",
      resume: "native-session-id",
      stop: "native-abort",
      reconnect: "daemon-sse-fanout-and-reconciliation"
    }
  }
}
