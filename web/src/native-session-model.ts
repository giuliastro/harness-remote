import { api } from "./api"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import type { MessageEnvelope, ModelOption, ModelSelection } from "./types"

type NativeMessageInfo = MessageEnvelope["info"] & {
  model?: {
    providerID?: unknown
    modelID?: unknown
    id?: unknown
    variant?: unknown
  }
  providerID?: unknown
  modelID?: unknown
  variant?: unknown
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function normalizeModel(value: unknown): ModelSelection | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<ModelSelection>
  const providerID = typeof candidate.providerID === "string" ? candidate.providerID.trim() : ""
  const modelID = typeof candidate.modelID === "string" ? candidate.modelID.trim() : ""
  if (!providerID || !modelID) return null
  const variant = typeof candidate.variant === "string" && candidate.variant.trim() ? candidate.variant.trim() : undefined
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

export function sameModel(left?: ModelSelection | null, right?: ModelSelection | null): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return left.providerID === right.providerID && left.modelID === right.modelID && (left.variant || "") === (right.variant || "")
}

/**
 * Copilot can expose a single `auto` entry even though a native Session has no recoverable model
 * metadata yet. That exact catalog shape proves the harness default that will be used, so it is
 * safe to show/select while preserving the normal metadata-first rule for every other harness.
 */
export function provenCopilotAutoDefault(backend: string | undefined, models: ModelOption[]): ModelOption | null {
  if (backend !== "copilot" || models.length !== 1) return null
  const [model] = models
  return model.providerID === "copilot" && model.modelID === "auto" && model.isDefault === true
    ? model
    : null
}

export function shouldClearDeferredCatalogDefault(input: {
  deferModelFallback: boolean
  routeChanged: boolean
  hasUserPrompt: boolean
  currentModelKey: string | null
  selectionTouched: boolean
  selectedModelKey: string
  models: ModelOption[]
  backend?: string
}): boolean {
  if (!input.deferModelFallback || input.routeChanged || !input.hasUserPrompt || input.currentModelKey) return false
  if (input.selectionTouched) return false
  const copilotAuto = provenCopilotAutoDefault(input.backend, input.models)
  if (copilotAuto && input.selectedModelKey === `${copilotAuto.providerID}|${copilotAuto.modelID}|${copilotAuto.variant || ""}`) return false
  return true
}

function userMessageModel(info: NativeMessageInfo): ModelSelection | null {
  const providerID = text(info.model?.providerID)
  const modelID = text(info.model?.modelID) ?? text(info.model?.id)
  if (!providerID || !modelID) return null
  const variant = text(info.model?.variant)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function assistantMessageModel(info: NativeMessageInfo): ModelSelection | null {
  // OpenCode v2 keeps the served model on the assistant envelope as `info.model`.
  // Older releases exposed the provider/model pair as flat info fields, so retain that
  // shape as a compatibility fallback rather than tying Session-first to one server version.
  const providerID = text(info.model?.providerID) ?? text(info.providerID)
  const modelID = text(info.model?.modelID) ?? text(info.model?.id) ?? text(info.modelID)
  if (!providerID || !modelID) return null
  const variant = text(info.model?.variant) ?? text(info.variant)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function priorUserVariant(
  messages: MessageEnvelope[],
  assistantIndex: number,
  assistantModel: ModelSelection
): string | undefined {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.info.role !== "user") continue
    const info = message.info as NativeMessageInfo
    const model = userMessageModel(info)
    if (!model) return undefined
    if (model.providerID !== assistantModel.providerID || model.modelID !== assistantModel.modelID) return undefined
    return model.variant
  }
  return undefined
}

/**
 * Recover the most recent model-bearing native message, not merely the most recent message of one
 * role. Newer OpenCode versions put model identity on assistant envelopes while older versions also
 * put it on user turns. Scanning role-by-role let an old user envelope beat a newer assistant one and
 * made reopening a Session fall back to the catalog default even though its actual model was present.
 *
 * Some OpenCode versions omit the reasoning variant from the assistant envelope even though the
 * immediately preceding user turn records it. When the assistant confirms the same provider/model,
 * inherit only that adjacent turn's variant instead of dropping it or searching older unrelated turns.
 */
export function lastNativeMessageModel(messages: MessageEnvelope[]): ModelSelection | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const info = message?.info as NativeMessageInfo | undefined
    if (!info) continue
    if (message.info.role === "user") {
      const model = userMessageModel(info)
      if (model) return model
      continue
    }
    if (message.info.role === "assistant") {
      const model = assistantMessageModel(info)
      if (!model) continue
      if (model.variant) return model
      const variant = priorUserVariant(messages, index, model)
      return variant ? { ...model, variant } : model
    }
  }
  return null
}

const PAGE_MODEL_BACKENDS = new Set(["opencode2", "omp", "pi", "codex", "copilot", "mimo"])

/**
 * Recover the last model from native Session state without persisting a second Harness Remote model.
 *
 * OpenCode stores the served/requested model on native message metadata. OMP and PI report the model
 * selected on their exact native JSONL branch and Codex reports it from the newest rollout
 * turn_context. Claude has no journal authority of its own here, but its transcript already requires
 * ACP session/load; after that load the adapter's current model config option is available through
 * the normal models endpoint, so reading it adds no parallel Session-first model state. If a harness
 * cannot prove a current model, leave it unset and let its own native default win rather than
 * resurrecting stale browser state.
 */
export async function resolveNativeSessionTargetModel(
  target: NativeSessionSurfaceTarget
): Promise<NativeSessionSurfaceTarget> {
  if (target.backend !== "opencode" && target.backend !== "claude" && !PAGE_MODEL_BACKENDS.has(target.backend)) return target
  try {
    const page = await api.loadMessagePage(
      target.config,
      target.sessionID,
      target.directory,
      undefined,
      20,
      false
    )
    let model = page.model ?? (target.backend === "opencode" ? lastNativeMessageModel(page.messages) : null)
    if (!model && target.backend === "claude") {
      const models = await api.listModels(target.config, target.directory, target.sessionID)
      const current = models.find((candidate) => candidate.isDefault)
      if (current) model = {
        providerID: current.providerID,
        modelID: current.modelID,
        ...(current.variant ? { variant: current.variant } : {})
      }
    }
    return model ? { ...target, model } : target
  } catch {
    return target
  }
}
