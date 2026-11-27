/**
 * ACP session modes as the harness itself advertises them.
 *
 * A harness describes its modes in one of two shapes: the current `configOptions` entry whose
 * `category` is `"mode"`, or the older `modes` field (`availableModes` + `currentModeId`). Every
 * adapter probed so far sends both, so the config option is the authority and `modes` is only a
 * fallback. Nothing here invents a mode: ids, names and descriptions are the harness's own, which
 * is what lets each harness keep its own vocabulary (Claude Code's "Accept edits", Codex's "Full
 * access", OpenCode's "build"/"plan").
 */

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** A select option list may group its values; modes are read flat. */
function flattenSelectOptions(options) {
  if (!Array.isArray(options)) return []
  return options.flatMap((option) => Array.isArray(option?.options) ? flattenSelectOptions(option.options) : [option])
}

/**
 * Whether a mode removes the harness's own approval prompts altogether. Codex marks this explicitly
 * (`_meta.kind: "full_access"`); Claude Code names it `bypassPermissions`. The UI uses it only to
 * ask before switching into such a mode and to tint the indicator, never to decide what the mode does.
 */
export function modeIsUnrestricted(mode) {
  const kind = mode?._meta?.kind
  if (kind === "full_access") return true
  return typeof mode?.id === "string" && /^(bypassPermissions|.*full[-_]?access|yolo)$/i.test(mode.id)
}

function describeMode(id, name, description, meta) {
  const mode = { id, name: text(name) ?? id }
  const detail = text(description)
  if (detail) mode.description = detail
  if (modeIsUnrestricted({ id, _meta: meta })) mode.unrestricted = true
  return mode
}

/** The config option that carries the Session's mode, if the harness advertises one. */
export function modeConfigOption(configOptions) {
  if (!Array.isArray(configOptions)) return undefined
  const candidates = configOptions.filter((option) => option?.category === "mode" && typeof option.id === "string")
  return candidates.find((option) => option.id === "mode") ?? candidates[0]
}

/**
 * The Session's modes in one shape: `{ currentModeId, modes: [{ id, name, description?, unrestricted? }],
 * configId? }`, or undefined when the harness advertises none. `configId` is present when the mode
 * is changed through `session/set_config_option`; without it the legacy `session/set_mode` applies.
 */
export function sessionModeState(configOptions, legacyModes) {
  const option = modeConfigOption(configOptions)
  if (option) {
    const modes = flattenSelectOptions(option.options)
      .filter((candidate) => typeof candidate?.value === "string" && candidate.value)
      .map((candidate) => describeMode(candidate.value, candidate.name, candidate.description, candidate._meta))
    if (modes.length) {
      return {
        configId: option.id,
        ...(typeof option.currentValue === "string" ? { currentModeId: option.currentValue } : {}),
        modes
      }
    }
  }
  const available = Array.isArray(legacyModes?.availableModes) ? legacyModes.availableModes : []
  const modes = available
    .filter((candidate) => typeof candidate?.id === "string" && candidate.id)
    .map((candidate) => describeMode(candidate.id, candidate.name, candidate.description, candidate._meta))
  if (!modes.length) return undefined
  return {
    ...(typeof legacyModes.currentModeId === "string" ? { currentModeId: legacyModes.currentModeId } : {}),
    modes
  }
}
