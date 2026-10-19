/**
 * Mid-turn prompt policy.
 *
 * While a turn is already streaming, a new prompt takes one of two roads, declared by the harness's
 * `midTurnPrompt` capability:
 *
 * - "steer": the daemon forwards the prompt into the live turn (Codex streams it straight into the
 *   running reply). It becomes a turn of the conversation at once.
 * - "queue": the daemon holds the prompt behind the running turn. Its transcript row carries
 *   `info.queued` until the daemon starts it; the app shows it above the composer meanwhile, and it
 *   becomes a turn only when the flag clears.
 *
 * The daemon reports which road a prompt took, so the policy here only words the composer hint.
 * Agents that publish no capabilities (legacy OpenCode over http) read as queue.
 */

export type MidTurnPromptPolicy = "steer" | "queue"

/** One prompt waiting behind the running turn, as shown above the composer. */
export type QueuedPromptEntry = {
  id: string
  text: string
  attachmentCount: number
  queuedAt: number
}

type CapabilitiesLike = { capabilities?: Record<string, unknown> | null }

const POLICIES: readonly MidTurnPromptPolicy[] = ["steer", "queue"]

/** The policy this agent's capabilities declare, defaulting to queue when nothing is published. */
export function midTurnPromptPolicy(agent: CapabilitiesLike | null | undefined): MidTurnPromptPolicy {
  const value = agent?.capabilities?.midTurnPrompt as unknown
  return typeof value === "string" && (POLICIES as readonly string[]).includes(value)
    ? (value as MidTurnPromptPolicy)
    : "queue"
}

/** The flattened transcript text of one message row. */
export function messageRowText(message: { parts: Array<{ type: string; text?: string }> }): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .trim()
}
