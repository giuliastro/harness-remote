// The daemon receives its Basic Auth credentials through these variables. Coding-agent processes
// it starts must not inherit them: every tool command an agent runs would otherwise be able to
// read the gateway password from its own environment and act as a paired client.
const GATEWAY_CREDENTIAL_VARIABLES = new Set([
  "HARNESS_REMOTE_USERNAME",
  "HARNESS_REMOTE_PASSWORD",
  "OMP_BRIDGE_USERNAME",
  "OMP_BRIDGE_PASSWORD"
])

export function withoutGatewayCredentials(environment = process.env) {
  const result = {}
  for (const [name, value] of Object.entries(environment)) {
    // Windows environment names are case-insensitive.
    if (!GATEWAY_CREDENTIAL_VARIABLES.has(name.toUpperCase())) result[name] = value
  }
  return result
}
