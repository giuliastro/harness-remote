import { api } from "./api"
import { nativeSessionConfig } from "./native-session-discovery"
import type { MachineAgentHost, ServerConfig, TranscriptSearchMatch } from "./types"

/** One Session whose transcript contains the query, wherever it lives. */
export type TranscriptHit = {
  /** `${machineID}:${agentID}:${sessionID}` - the same identity the rail rows use. */
  key: string
  machineID: string
  agentID: string
  sessionID: string
  count: number
  matches: TranscriptSearchMatch[]
}

/**
 * What a transcript search across every configured machine actually covered.
 *
 * A search that quietly skips what it could not read is worse than no search: the user concludes
 * the phrase was never said. `unsearched` counts the Sessions with no journal to read and
 * `truncated` says a bound was hit, so the rail can state the limit instead of implying completeness.
 */
export type TranscriptSearchOutcome = {
  query: string
  hits: TranscriptHit[]
  scanned: number
  unsearched: number
  truncated: boolean
}

/** Below this a query is a keystroke: it would match everything and cost a journal read per Session. */
export const TRANSCRIPT_SEARCH_MIN_CHARS = 3

export const EMPTY_TRANSCRIPT_SEARCH: TranscriptSearchOutcome = {
  query: "", hits: [], scanned: 0, unsearched: 0, truncated: false
}

export type TranscriptSearchApi = Pick<typeof api, "searchTranscripts">

export async function searchAgentTranscripts(
  machineID: string,
  base: ServerConfig,
  agent: MachineAgentHost,
  query: string,
  client: TranscriptSearchApi = api
): Promise<TranscriptSearchOutcome> {
  if (agent.capabilities?.sessions === false) return { ...EMPTY_TRANSCRIPT_SEARCH, query }
  const response = await client.searchTranscripts(nativeSessionConfig(base, agent), query)
  return {
    query: response.query ?? query,
    hits: (response.results ?? []).map((result) => ({
      key: `${machineID}:${agent.id}:${result.sessionID}`,
      machineID,
      agentID: agent.id,
      sessionID: result.sessionID,
      count: result.count,
      matches: result.matches ?? []
    })),
    scanned: response.scanned ?? 0,
    unsearched: (response.unsearched ?? []).length,
    truncated: response.truncated === true
  }
}

/**
 * Search every harness on every machine at once.
 *
 * One machine being asleep, or one harness serving an older daemon with no search route, must not
 * take the whole result down: a failed agent contributes nothing and is counted as unsearched, so
 * the totals stay honest about coverage.
 */
export async function searchNativeTranscripts(
  sources: { machineID: string; config: ServerConfig; agents: MachineAgentHost[] }[],
  query: string,
  client: TranscriptSearchApi = api
): Promise<TranscriptSearchOutcome> {
  const trimmed = query.trim()
  if (trimmed.length < TRANSCRIPT_SEARCH_MIN_CHARS) return { ...EMPTY_TRANSCRIPT_SEARCH, query: trimmed }
  const targets = sources.flatMap((source) =>
    source.agents.map((agent) => ({ machineID: source.machineID, config: source.config, agent })))
  const outcomes = await Promise.all(targets.map((target) =>
    searchAgentTranscripts(target.machineID, target.config, target.agent, trimmed, client)
      .catch(() => null)))

  const hits: TranscriptHit[] = []
  let scanned = 0
  let unsearched = 0
  let truncated = false
  for (const outcome of outcomes) {
    if (!outcome) { truncated = true; continue }
    hits.push(...outcome.hits)
    scanned += outcome.scanned
    unsearched += outcome.unsearched
    truncated = truncated || outcome.truncated
  }
  // Most matches first: a Session that mentions the phrase eight times is more likely the one the
  // user is looking for than one that mentions it once.
  hits.sort((left, right) => right.count - left.count)
  return { query: trimmed, hits, scanned, unsearched, truncated }
}
