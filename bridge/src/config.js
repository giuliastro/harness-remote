import { homedir } from "node:os"
import path from "node:path"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

const HARNESS_KINDS = new Set(["omp", "pi"])

function defaultAgentBin(harness) {
  return harness === "pi" ? "pi-acp" : "omp"
}

function requireValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`)
  return value
}

function parsePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535")
  }
  return port
}

export function parseConfig(args, environment = process.env) {
  const harness = environment.HARNESS_REMOTE_HARNESS ?? "omp"
  if (!HARNESS_KINDS.has(harness)) throw new Error(`Unsupported harness: ${harness}`)
  const config = {
    host: environment.HARNESS_REMOTE_HOST ?? "127.0.0.1",
    port: parsePort(environment.HARNESS_REMOTE_PORT ?? "4097"),
    username: environment.HARNESS_REMOTE_USERNAME ?? "",
    password: environment.HARNESS_REMOTE_PASSWORD ?? "",
    harness,
    agentBin: environment.HARNESS_REMOTE_AGENT_BIN ?? defaultAgentBin(harness),
    agentArgs: [],
    piBin: environment.HARNESS_REMOTE_PI_BIN ?? "pi",
    roots: environment.HARNESS_REMOTE_ROOT ? [environment.HARNESS_REMOTE_ROOT] : [],
    corsOrigins: environment.HARNESS_REMOTE_CORS ? [environment.HARNESS_REMOTE_CORS] : [],
    logRequests: environment.HARNESS_REMOTE_LOG_REQUESTS === "1",
    stateDirectory: environment.HARNESS_REMOTE_STATE_DIR ?? path.join(homedir(), ".harness-remote"),
  }

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    switch (option) {
      case "--host":
        config.host = requireValue(args, index, option)
        index += 1
        break
      case "--port":
        config.port = parsePort(requireValue(args, index, option))
        index += 1
        break
      case "--username":
        config.username = requireValue(args, index, option)
        index += 1
        break
      case "--password":
        config.password = requireValue(args, index, option)
        index += 1
        break
      case "--harness":
        config.harness = requireValue(args, index, option)
        if (!HARNESS_KINDS.has(config.harness)) throw new Error(`Unsupported harness: ${config.harness}`)
        if (!environment.HARNESS_REMOTE_AGENT_BIN) config.agentBin = defaultAgentBin(config.harness)
        index += 1
        break
      case "--agent-bin":
        config.agentBin = requireValue(args, index, option)
        index += 1
        break
      case "--agent-arg":
        if (args[index + 1] === undefined) throw new Error(`${option} requires a value`)
        config.agentArgs.push(args[index + 1])
        index += 1
        break
      case "--pi-bin":
        config.piBin = requireValue(args, index, option)
        index += 1
        break
      case "--root":
        config.roots.push(requireValue(args, index, option))
        index += 1
        break
      case "--cors":
        config.corsOrigins.push(requireValue(args, index, option))
        index += 1
        break
      case "--state-dir":
        config.stateDirectory = requireValue(args, index, option)
        index += 1
        break
      case "--log-requests":
        config.logRequests = true
        break
      case "--help":
        config.help = true
        break
      default:
        throw new Error(`Unknown option: ${option}`)
    }
  }

  if (Boolean(config.username) !== Boolean(config.password)) {
    throw new Error("--username and --password must be supplied together")
  }
  if (!LOOPBACK_HOSTS.has(config.host) && !config.username) {
    throw new Error("A username and password are required when binding beyond loopback")
  }
  return config
}

export function usage() {
  return `Usage: harness-remote [options]\n\nOptions:\n  --harness <omp|pi>     Harness profile (default: omp)\n  --agent-bin <path>     ACP agent executable (default: profile-specific)\n  --agent-arg <value>    ACP agent argument; repeatable\n  --pi-bin <path>        PI executable for the PI profile (default: pi)\n  --host <host>          Bind host (default: 127.0.0.1)\n  --port <port>          Bind port (default: 4097)\n  --username <username>  Enable HTTP Basic Auth\n  --password <password>  Enable HTTP Basic Auth\n  --root <path>          Allowed worktree root; repeatable\n  --state-dir <path>     Persist bridge session snapshots (default: ~/.harness-remote)\n  --cors <origin>        Allow browser requests from this exact origin; repeatable\n  --log-requests         Log request method, path, and query\n  --help                 Show this help`
}
