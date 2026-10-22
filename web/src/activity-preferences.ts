import { useEffect, useState } from "react"
import { APP_PREFERENCES_CHANGED_EVENT, notifyPreferencesChanged } from "./appPreferences"

/**
 * How much of a turn's Activity - the agent's notes, reasoning and tool calls - the transcript shows.
 *
 * Two moments need different answers. While the agent works, the reader wants to know what it is
 * doing and what it last said, without the transcript filling with tool rows. Once it has answered,
 * the answer is what matters and the work behind it is reference material. So each moment has its
 * own setting, plus one for reasoning, which is the longest and least often read part of a turn.
 */
export type LiveActivityMode = "latest" | "highlights" | "expanded" | "collapsed"
export type FinishedActivityMode = "collapsed" | "highlights" | "expanded"
export type ReasoningMode = "collapsed" | "expanded" | "hidden"

export type ActivityPreferences = {
  live: LiveActivityMode
  finished: FinishedActivityMode
  reasoning: ReasoningMode
}

export const LIVE_ACTIVITY_MODES: LiveActivityMode[] = ["latest", "highlights", "expanded", "collapsed"]
export const FINISHED_ACTIVITY_MODES: FinishedActivityMode[] = ["collapsed", "highlights", "expanded"]
export const REASONING_MODES: ReasoningMode[] = ["collapsed", "expanded", "hidden"]

export const DEFAULT_ACTIVITY_PREFERENCES: ActivityPreferences = {
  live: "latest",
  finished: "collapsed",
  reasoning: "collapsed"
}

export const ACTIVITY_PREFERENCES_STORAGE_KEY = "harness-remote.activity"

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

export function loadActivityPreferences(): ActivityPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVITY_PREFERENCES_STORAGE_KEY) || "{}") as Record<string, unknown>
    return {
      live: pick(saved.live, LIVE_ACTIVITY_MODES, DEFAULT_ACTIVITY_PREFERENCES.live),
      finished: pick(saved.finished, FINISHED_ACTIVITY_MODES, DEFAULT_ACTIVITY_PREFERENCES.finished),
      reasoning: pick(saved.reasoning, REASONING_MODES, DEFAULT_ACTIVITY_PREFERENCES.reasoning)
    }
  } catch {
    return { ...DEFAULT_ACTIVITY_PREFERENCES }
  }
}

export function persistActivityPreferences(preferences: ActivityPreferences): void {
  try {
    localStorage.setItem(ACTIVITY_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    /* a private-mode browser keeps the choice for this page only */
  }
  notifyPreferencesChanged()
}

/** The current preferences, following Settings live: a change re-lays out every open transcript. */
export function useActivityPreferences(): ActivityPreferences {
  const [preferences, setPreferences] = useState(loadActivityPreferences)

  useEffect(() => {
    const follow = () => {
      const next = loadActivityPreferences()
      setPreferences((current) => (
        current.live === next.live && current.finished === next.finished && current.reasoning === next.reasoning
          ? current
          : next
      ))
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, follow)
    window.addEventListener("storage", follow)
    return () => {
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, follow)
      window.removeEventListener("storage", follow)
    }
  }, [])

  return preferences
}
