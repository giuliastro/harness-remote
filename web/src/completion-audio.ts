import { CapacitorHttp } from "@capacitor/core"
import type { SessionStatus } from "./types"

const COMPLETION_AUDIO_SUFFIX = "audio/staplebops-01.aac"
const WORKING_STATES = new Set(["busy", "retry", "waiting", "listening"])
const PROMPT_PATH = /\/session\/([^/?]+)\/(?:prompt_async|command)(?:\?|$)/
const ABORT_PATH = /\/session\/([^/?]+)\/abort(?:\?|$)/

type ArmedCompletion = {
  sessionID: string
  armedAt: number
  sawWorking: boolean
  sawAssistantActivity: boolean
}

let installed = false
let nativePlay: ((this: HTMLMediaElement) => Promise<void>) | null = null
let playbackAudio: HTMLAudioElement | null = null
const armed = new Map<string, ArmedCompletion>()

function requestURL(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  return typeof Request !== "undefined" && input instanceof Request ? input.method.toUpperCase() : "GET"
}

function isCompletionAudio(element: HTMLMediaElement): boolean {
  const source = element.currentSrc || (element instanceof HTMLAudioElement ? element.src : "")
  return source.includes(COMPLETION_AUDIO_SUFFIX)
}

function mostLikelyActiveCompletion(): ArmedCompletion | null {
  const values = [...armed.values()]
  if (values.length === 0) return null
  const working = values.filter((entry) => entry.sawWorking)
  return (working.length > 0 ? working : values).sort((a, b) => b.armedAt - a.armedAt)[0] ?? null
}

function primePlayback(): void {
  if (!playbackAudio || !nativePlay) return
  const audio = playbackAudio
  audio.muted = true
  audio.currentTime = 0
  try {
    void nativePlay.call(audio).then(() => {
      audio.pause()
      audio.currentTime = 0
      audio.muted = false
    }).catch(() => {
      audio.muted = false
    })
  } catch {
    audio.muted = false
  }
}

function playCompletion(): void {
  if (!playbackAudio || !nativePlay) return
  const audio = playbackAudio
  audio.muted = false
  audio.currentTime = 0
  try {
    void nativePlay.call(audio).catch(() => undefined)
  } catch {
    // Playback is best-effort and must never interfere with session state.
  }
}

export function armCompletionAudio(sessionID: string): void {
  armed.set(sessionID, {
    sessionID,
    armedAt: Date.now(),
    sawWorking: false,
    sawAssistantActivity: false
  })
  // This runs at prompt submission time, while the user gesture is still active. Priming the
  // element here makes later completion playback reliable in Capacitor/WebView without making a
  // sound at send time.
  primePlayback()
}

export function cancelCompletionAudio(sessionID: string): void {
  armed.delete(sessionID)
}

/**
 * Returns the sessions this observation completed, in the order they played. The transport callers
 * ignore it; it is what makes the timing rules — armed but idle plays nothing, working then idle
 * plays once, an aborted or failed turn plays never — checkable without a DOM to hear through.
 */
export function observeCompletionStatuses(statuses: Record<string, SessionStatus>): string[] {
  const completed: string[] = []
  for (const [sessionID, entry] of armed) {
    const sessionStatus = statuses[sessionID]
    if (!sessionStatus) continue
    if (WORKING_STATES.has(sessionStatus.type)) {
      entry.sawWorking = true
      continue
    }
    if (!entry.sawWorking && !entry.sawAssistantActivity) continue
    armed.delete(sessionID)
    completed.push(sessionID)
    playCompletion()
  }
  return completed
}

/**
 * The first assistant fragment. It is evidence that the turn produced output — which is what lets a
 * harness that never reports a working status still complete — and explicitly not a reason to play:
 * the sound waits for the status to come back idle.
 */
export function noteAssistantActivity(): void {
  const entry = mostLikelyActiveCompletion()
  if (entry) entry.sawAssistantActivity = true
}

function inspectRequest(url: string, method: string): string | null {
  if (method !== "POST") return null
  const abort = url.match(ABORT_PATH)
  if (abort) {
    cancelCompletionAudio(decodeURIComponent(abort[1]))
    return null
  }
  const prompt = url.match(PROMPT_PATH)
  if (!prompt) return null
  const sessionID = decodeURIComponent(prompt[1])
  armCompletionAudio(sessionID)
  return sessionID
}

function parseStatusPayload(value: unknown): Record<string, SessionStatus> | null {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return parseStatusPayload(JSON.parse(value))
    } catch {
      return null
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, SessionStatus> : null
}

function installFetchTracking(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestURL(input)
    const method = requestMethod(input, init)
    const armedSessionID = inspectRequest(url, method)
    let response: Response
    try {
      response = await originalFetch(input, init)
    } catch (error) {
      if (armedSessionID) cancelCompletionAudio(armedSessionID)
      throw error
    }
    if (armedSessionID && !response.ok) cancelCompletionAudio(armedSessionID)
    if (method === "GET" && url.includes("/session/status") && response.ok) {
      void response.clone().json().then((payload) => {
        const statuses = parseStatusPayload(payload)
        if (statuses) observeCompletionStatuses(statuses)
      }).catch(() => undefined)
    }
    return response
  }
}

function installCapacitorTracking(): void {
  const originalRequest = CapacitorHttp.request.bind(CapacitorHttp)
  CapacitorHttp.request = async (options) => {
    const method = (options.method ?? "GET").toUpperCase()
    const armedSessionID = inspectRequest(options.url, method)
    try {
      const response = await originalRequest(options)
      if (armedSessionID && response.status >= 400) cancelCompletionAudio(armedSessionID)
      if (method === "GET" && options.url.includes("/session/status") && response.status < 400) {
        const statuses = parseStatusPayload(response.data)
        if (statuses) observeCompletionStatuses(statuses)
      }
      return response
    } catch (error) {
      if (armedSessionID) cancelCompletionAudio(armedSessionID)
      throw error
    }
  }
}

export function installCompletionAudioGuard(): void {
  if (installed || typeof HTMLMediaElement === "undefined" || typeof Audio === "undefined") return
  installed = true
  nativePlay = HTMLMediaElement.prototype.play
  playbackAudio = new Audio(`${import.meta.env.BASE_URL}${COMPLETION_AUDIO_SUFFIX}`)
  playbackAudio.preload = "auto"

  HTMLMediaElement.prototype.play = function guardedCompletionPlay(this: HTMLMediaElement): Promise<void> {
    if (!isCompletionAudio(this)) return nativePlay!.call(this)
    // App.tsx currently requests its completion sound as soon as the first assistant fragment
    // arrives. Suppress that premature playback and use it only as evidence that assistant output
    // has started; the authoritative playback happens after session/status returns to idle.
    noteAssistantActivity()
    return Promise.resolve()
  }

  installFetchTracking()
  installCapacitorTracking()
}

export function resetCompletionAudioForTests(): void {
  armed.clear()
}
