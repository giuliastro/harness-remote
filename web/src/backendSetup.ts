import type { BackendKind } from "./types"

/** Declaration order everywhere a harness has to be listed, so the Settings picker, the connect
 *  wizard and the docs links can never drift out of sync with each other. */
export const BACKEND_KINDS: BackendKind[] = ["opencode", "opencode2", "omp", "pi", "claude", "codex"]

export function backendDisplayName(backend: BackendKind): string {
  if (backend === "opencode2") return "OpenCode 2"
  if (backend === "omp") return "Oh My Pi"
  if (backend === "pi") return "PI"
  if (backend === "claude") return "Claude Code"
  if (backend === "codex") return "Codex CLI"
  return "OpenCode"
}

/** Whether the harness is reached through the bundled bridge rather than by talking to a server it
 *  runs itself — which is what decides the command the user has to run on the host machine. */
export function isBridgeBackend(backend: BackendKind): boolean {
  return backend === "omp" || backend === "pi" || backend === "claude" || backend === "codex"
}

export function backendDefaultPort(backend: BackendKind): number {
  return backend === "opencode" || backend === "opencode2" ? 4096 : 4097
}

export function backendDefaultUsername(backend: BackendKind): string {
  return backend === "opencode" || backend === "opencode2" ? "opencode" : backend
}

export function backendDocsAnchor(backend: BackendKind): string {
  if (backend === "opencode2") return "opencode-2-server-setup"
  if (backend === "pi") return "pi-bridge-setup"
  if (backend === "claude") return "claude-code-bridge-setup"
  if (backend === "codex") return "codex-bridge-setup"
  if (backend === "omp") return "oh-my-pi-bridge-setup"
  return "opencode-server-setup"
}

/**
 * The exact line to paste on the machine that runs the agent, filled in with the address and
 * credentials the user has just typed. Setting a server up used to mean reading the Help page,
 * finding the right snippet for the chosen harness and editing four values into it by hand; the
 * wizard shows the finished command instead, which is the single biggest thing standing between a
 * new user and a working connection.
 */
export function backendSetupCommand(
  backend: BackendKind,
  options: { port?: number; username?: string; password?: string } = {}
): string {
  const port = options.port && options.port > 0 ? options.port : backendDefaultPort(backend)
  const username = options.username?.trim() || backendDefaultUsername(backend)
  const password = options.password?.trim() || "your-password"
  if (backend === "opencode") {
    return [
      `OPENCODE_SERVER_USERNAME=${username} \\`,
      `OPENCODE_SERVER_PASSWORD=${password} \\`,
      `npx -y opencode-ai serve --hostname 0.0.0.0 --port ${port}`
    ].join("\n")
  }
  if (backend === "opencode2") {
    return [
      `OPENCODE_PASSWORD=${password} \\`,
      `opencode2 serve --hostname 0.0.0.0 --port ${port}`
    ].join("\n")
  }
  return [
    `npx --yes ./bridge --backend ${backend} \\`,
    `  --host 0.0.0.0 --port ${port} \\`,
    `  --username ${username} --password ${password} \\`,
    `  --root "$PWD"`
  ].join("\n")
}
