const REQUIRED_LIFECYCLE_CONTRACT_FIELDS = ["sessionAuthority", "create", "resume", "stop", "reconnect"]

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
  const excludedModelValuePrefixes = stringArray(
    definition.excludedModelValuePrefixes ?? [],
    "excludedModelValuePrefixes"
  )
  for (const prefix of excludedModelValuePrefixes) {
    requireNonEmptyString(prefix, `'${id}' excluded model value prefix`)
  }
  const launchPriority = definition.launchPriority ?? 100
  if (definition.workingDirectory !== undefined && definition.workingDirectory !== "common-root") {
    throw new Error(`ACP provider '${id}' workingDirectory must be 'common-root'`)
  }
  if (definition.authenticate !== undefined && typeof definition.authenticate !== "boolean") {
    throw new Error(`ACP provider '${id}' authenticate must be a boolean`)
  }
  if (definition.environment !== undefined) {
    if (!definition.environment || typeof definition.environment !== "object" || Array.isArray(definition.environment)) {
      throw new Error(`ACP provider '${id}' environment must be an object`)
    }
    for (const [name, value] of Object.entries(definition.environment)) {
      requireNonEmptyString(name, `'${id}' environment key`)
      if (typeof value !== "string") throw new Error(`ACP provider '${id}' environment values must be strings`)
    }
  }
  if (!Number.isFinite(launchPriority)) throw new Error(`ACP provider '${id}' launchPriority must be a finite number`)
  if (!definition.capabilities || typeof definition.capabilities !== "object") {
    throw new Error(`ACP provider '${id}' must declare capabilities`)
  }
  const modelSelection = definition.modelSelection
    ?? (definition.capabilities.models === true ? "required" : "harness-default")
  if (!["required", "optional", "harness-default"].includes(modelSelection)) {
    throw new Error(`ACP provider '${id}' modelSelection must be required, optional, or harness-default`)
  }
  if (modelSelection !== "harness-default" && definition.capabilities.models !== true) {
    throw new Error(`ACP provider '${id}' modelSelection '${modelSelection}' requires capabilities.models=true`)
  }
  if (!definition.sessionContract || typeof definition.sessionContract !== "object") {
    throw new Error(`ACP provider '${id}' must declare a Session contract`)
  }
  for (const field of REQUIRED_SESSION_CONTRACT_FIELDS) {
    requireNonEmptyString(definition.sessionContract[field], `'${id}' Session contract.${field}`)
  }
  if (!definition.lifecycleContract || typeof definition.lifecycleContract !== "object") {
    throw new Error(`ACP provider '${id}' must declare a lifecycle contract`)
  }
  for (const field of REQUIRED_LIFECYCLE_CONTRACT_FIELDS) {
    requireNonEmptyString(definition.lifecycleContract[field], `'${id}' lifecycle contract.${field}`)
  }

  return {
    ...definition,
    id,
    label,
    command,
    args,
    detectCommands,
    excludedModelValuePrefixes,
    launchPriority,
    authenticate: definition.authenticate !== false,
    ...(definition.environment ? { environment: { ...definition.environment } } : {}),
    capabilities: { ...definition.capabilities },
    modelSelection,
    modelVariantConfigIDs: stringArray(definition.modelVariantConfigIDs ?? [], "modelVariantConfigIDs"),
    sessionContract: { ...definition.sessionContract },
    lifecycleContract: { ...definition.lifecycleContract }
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
