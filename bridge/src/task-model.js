/**
 * A task's model selection, in the shape the client already speaks and the agents already accept.
 * Kept separate from the task store so the daemon has one place that decides what a valid selection
 * is, rather than each route trimming strings its own way.
 */
export function normalizeTaskModel(value) {
  if (!value || typeof value !== "object") return null
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
  const modelID = typeof value.modelID === "string" ? value.modelID.trim() : ""
  if (!providerID || !modelID) return null
  const variant = typeof value.variant === "string" ? value.variant.trim() : ""
  return variant ? { providerID, modelID, variant } : { providerID, modelID }
}

/** `POST /session` names the model id `id`; `POST /session/:id/prompt_async` names it `modelID`. */
export function sessionModelBody(model) {
  if (!model) return undefined
  return model.variant
    ? { providerID: model.providerID, id: model.modelID, variant: model.variant }
    : { providerID: model.providerID, id: model.modelID }
}

export function promptModelBody(model) {
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.modelID }
}
