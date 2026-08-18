import type { BackendKind } from "./types"

/** Declaration order everywhere a harness has to be listed, so the Settings picker, the connect
 *  wizard and the docs links can never drift out of sync with each other. */
export const BACKEND_KINDS: BackendKind[] = ["opencode", "omp", "pi", "claude", "codex"]

export function backendDisplayName(backend: BackendKind): string {
  if (backend === "omp") return "Oh My Pi"
  if (backend === "pi") return "PI"
  if (backend === "claude") return "Claude Code"
  if (backend === "codex") return "Codex CLI"
  return "OpenCode"
}

/** Whether the harness is reached through the bundled bridge rather than by talking to a server it
 *  runs itself. Kept for API compatibility paths; the normal v3 connection wizard points every
 *  harness at the machine daemon. */
export function isBridgeBackend(backend: BackendKind): boolean {
  return backend === "omp" || backend === "pi" || backend === "claude" || backend === "codex"
}

/** v3 connects to the public machine daemon. Managed OpenCode may still use 4096 internally, but
 *  clients must never be configured with that loopback-only implementation detail. */
export function backendDefaultPort(_backend: BackendKind): number {
  return 4097
}

export function backendDefaultUsername(_backend: BackendKind): string {
  return "harness"
}

export function backendDocsAnchor(backend: BackendKind): string {
  if (backend === "pi") return "pi-bridge-setup"
  if (backend === "claude") return "claude-code-bridge-setup"
  if (backend === "codex") return "codex-bridge-setup"
  if (backend === "omp") return "oh-my-pi-bridge-setup"
  return "opencode-server-setup"
}

/**
 * The normal v3 host setup is harness-neutral: one launcher detects the installed harnesses and
 * exposes them through the public machine daemon. The selected harness only affects which agent
 * the client chooses after discovery, not which command the user has to start on the host.
 */
export function backendSetupCommand(
  _backend: BackendKind,
  options: { port?: number; username?: string; password?: string } = {}
): string {
  const port = options.port && options.port > 0 ? options.port : 4097
  const username = options.username?.trim() || "harness"
  const password = options.password?.trim() || "your-password"
  return [
    `npx github:giuliastro/harness-remote \\`,
    `  --host 0.0.0.0 --port ${port} \\`,
    `  --username ${username} --password ${password} \\`,
    `  --root "$PWD"`
  ].join("\n")
}
