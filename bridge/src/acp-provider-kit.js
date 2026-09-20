const REQUIRED_SESSION_CONTRACT_FIELDS = [
  "authority",
  "discovery",
  "transcript",
  "externalWriterObservation",
  "continuation",
  "writerOwnership",
  "stop"
]

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ACP provider ${field} must be a non-empty string`)
  }
  return value
}

function stringArray(values, field) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`ACP provider ${field} must be an array of strings`)
  }
  return [...values]
}

/**
 * Define the provider-facing portion of an ACP harness profile.
 *
 * Harness-specific history/reconciliation hooks remain valid extension fields. The provider kit
 * validates only the transport/runtime contract that generic daemon code is allowed to depend on.
 */
export function defineAcpProvider(definition) {
  if (!definition || typeof definition !== "object") throw new Error("ACP provider definition is required")
  const id = requireNonEmptyString(definition.id, "id")
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`ACP provider id '${id}' is invalid`)
  const label = requireNonEmptyString(definition.label, "label")
  const command = requireNonEmptyString(definition.command, "command")
  const args = stringArray(definition.args ?? [], "args")
  const detectCommands = stringArray(definition.detectCommands ?? [], "detectCommands")
  const launchPriority = definition.launchPriority ?? 100
  if (!Number.isFinite(launchPriority)) throw new Error(`ACP provider '${id}' launchPriority must be a finite number`)
  if (!definition.capabilities || typeof definition.capabilities !== "object") {
    throw new Error(`ACP provider '${id}' must declare capabilities`)
  }
  if (!definition.sessionContract || typeof definition.sessionContract !== "object") {
    throw new Error(`ACP provider '${id}' must declare a Session contract`)
  }
  for (const field of REQUIRED_SESSION_CONTRACT_FIELDS) {
    requireNonEmptyString(definition.sessionContract[field], `'${id}' Session contract.${field}`)
  }

  return {
    ...definition,
    id,
    label,
    command,
    args,
    detectCommands,
    launchPriority,
    capabilities: { ...definition.capabilities },
    modelVariantConfigIDs: stringArray(definition.modelVariantConfigIDs ?? [], "modelVariantConfigIDs"),
    sessionContract: { ...definition.sessionContract }
  }
}

/** Build an immutable lookup facade so generic runtime code never needs harness-name conditionals. */
export function createAcpProviderRegistry(providers) {
  if (!Array.isArray(providers)) throw new Error("ACP provider registry requires an array")
  const byID = new Map()
  for (const provider of providers) {
    if (!provider || typeof provider !== "object") throw new Error("ACP provider registry received an invalid provider")
    if (byID.has(provider.id)) throw new Error(`Duplicate ACP provider id: ${provider.id}`)
    byID.set(provider.id, provider)
  }

  return Object.freeze({
    get(id) {
      const provider = byID.get(id)
      if (!provider) throw new Error(`Unsupported backend: ${id}`)
      return provider
    },
    has(id) {
      return byID.has(id)
    },
    list() {
      return [...byID.values()]
    },
    ids() {
      return [...byID.keys()]
    }
  })
}
