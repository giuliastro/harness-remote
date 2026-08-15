import { homedir } from "node:os"
import path from "node:path"
import { harnessProfile } from "./harness-profiles.js"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

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

function parseArgumentList(value, fallback) {
  if (value === undefined) return [...fallback]
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("ACP arguments must be a JSON array")
  }
  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== "string")) {
    throw new Error("ACP arguments must be a JSON array of strings")
  }
  return parsed
}

function parseBackend(value) {
  return harnessProfile(value).id
}


function environmentValue(environment, name) {
  return environment[`HARNESS_REMOTE_${name}`] ?? environment[`OMP_BRIDGE_${name}`]
}


export function parseConfig(args, environment = process.env) {
  const backend = parseBackend(environmentValue(environment, "BACKEND") ?? "omp")
  const profile = harnessProfile(backend)
  const acpCommand = environmentValue(environment, "ACP_COMMAND")
  const acpArgs = environmentValue(environment, "ACP_ARGS")
  const root = environmentValue(environment, "ROOT")
  const cors = environmentValue(environment, "CORS")
  const config = {
    backend,
    host: environmentValue(environment, "HOST") ?? "127.0.0.1",
    port: parsePort(environmentValue(environment, "PORT") ?? "4097"),
    username: environmentValue(environment, "USERNAME") ?? "",
    password: environmentValue(environment, "PASSWORD") ?? "",
    acpCommand: acpCommand ?? profile.command,
    acpArgs: parseArgumentList(acpArgs, profile.args),
    roots: root ? [root] : [],
    corsOrigins: cors ? [cors] : [],
    logRequests: environmentValue(environment, "LOG_REQUESTS") === "1",
    stateDirectory: environmentValue(environment, "STATE_DIR") ?? path.join(homedir(), ".harness-remote")
  }
  let acpCommandOverridden = acpCommand !== undefined
  let acpArgsOverridden = acpArgs !== undefined

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    switch (option) {
      case "--backend":
        config.backend = parseBackend(requireValue(args, index, option))
        if (!acpCommandOverridden) config.acpCommand = harnessProfile(config.backend).command
        if (!acpArgsOverridden) config.acpArgs = [...harnessProfile(config.backend).args]
        index += 1
        break
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
      case "--acp-command":
        config.acpCommand = requireValue(args, index, option)
        acpCommandOverridden = true
        index += 1
        break
      case "--acp-arg":
        if (!acpArgsOverridden) {
          config.acpArgs = []
          acpArgsOverridden = true
        }
        config.acpArgs.push(requireValue(args, index, option))
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
      case "--log-requests":
        config.logRequests = true
        break
      case "--state-dir":
        config.stateDirectory = requireValue(args, index, option)
        index += 1
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
  return `Usage: harness-remote-bridge [options]\n\nOptions:\n  --backend <name>       ACP backend: omp or pi (default: omp)\n  --host <host>          Bind host (default: 127.0.0.1)\n  --port <port>          Bind port (default: 4097)\n  --username <username>  Enable HTTP Basic Auth\n  --password <password>  Enable HTTP Basic Auth\n  --acp-command <path>   ACP adapter command (default depends on backend)\n  --acp-arg <arg>        ACP adapter argument; repeatable\n  --root <path>          Allowed worktree root; repeatable\n  --cors <origin>        Allow browser requests from this exact origin; repeatable\n  --state-dir <path>     Persist bridge session snapshots\n  --log-requests         Log request method, path, and query\n  --help                 Show this help`
}
