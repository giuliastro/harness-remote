export function catalogFingerprint(models = []) {
  return models
    .map((model) => `${model.providerID ?? ""}/${model.modelID ?? ""}/${model.variantConfigId ?? ""}/${model.variant ?? ""}`)
    .sort()
    .join("|")
}

export function catalogOwnershipEvidence({ primary, secondary, primaryModels = [], secondaryModels = [], state = {} }) {
  const primaryState = state.agents?.[primary]
  const secondaryState = state.agents?.[secondary]
  const primaryFingerprint = catalogFingerprint(primaryModels)
  const secondaryFingerprint = catalogFingerprint(secondaryModels)

  return {
    primaryFingerprint,
    secondaryFingerprint,
    catalogsIdentical: primaryFingerprint === secondaryFingerprint,
    checks: [
      { ok: primaryModels.length > 0, message: `${primary} advertises a model catalog` },
      { ok: secondaryModels.length > 0, message: `${secondary} advertises a model catalog` },
      { ok: Boolean(primaryState), message: `${primary}: diagnostics expose its registered agent entry` },
      { ok: Boolean(secondaryState), message: `${secondary}: diagnostics expose its registered agent entry` },
      {
        ok: (primaryState?.catalogModels ?? 0) > 0,
        message: `${primary}: diagnostics own a populated model catalog (${primaryState?.catalogModels ?? 0})`
      },
      {
        ok: (secondaryState?.catalogModels ?? 0) > 0,
        message: `${secondary}: diagnostics own a populated model catalog (${secondaryState?.catalogModels ?? 0})`
      },
      {
        ok: Boolean(primaryState?.catalogSource),
        message: `${primary}: diagnostics identify the catalog source (${primaryState?.catalogSource ?? "missing"})`
      },
      {
        ok: Boolean(secondaryState?.catalogSource),
        message: `${secondary}: diagnostics identify the catalog source (${secondaryState?.catalogSource ?? "missing"})`
      }
    ]
  }
}
