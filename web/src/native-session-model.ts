import { api } from "./api"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import type { MessageEnvelope, ModelSelection } from "./types"

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

const PAGE_MODEL_BACKENDS = new Set(["omp", "pi", "codex"])

async function currentSessionModel(target: NativeSessionSurfaceTarget): Promise<ModelSelection | null> {
  const models = await api.listModels(target.config, target.directory, target.sessionID)
  const current = models.find((candidate) => candidate.isDefault)
  if (!current) return null
  return {
    providerID: current.providerID,
    modelID: current.modelID,
    ...(current.variant ? { variant: current.variant } : {})
  }
}

/**
 * Recover the last model from native Session state without persisting a second Harness Remote model.
 *
 * OpenCode stores the served/requested model on native message metadata. OMP and PI report the model
 * selected on their exact native JSONL branch and Codex reports it from the newest rollout
 * turn_context. Claude has no journal authority of its own here, but its transcript already requires
 * ACP session/load; after that load the adapter's current model config option is available through
 * the normal models endpoint. OMP deliberately does not use that fallback: its selected model belongs
 * to the JSONL branch/page header. Loading an existing OMP Session merely to populate the picker can
 * replay a huge transcript on the single ACP adapter and block the independent machine model catalog.
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
      model = await currentSessionModel(target)
    }
    return model ? { ...target, model } : target
  } catch {
    return target
  }
}
