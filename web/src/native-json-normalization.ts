export function normalizeNativeResponseData(data: unknown): unknown {
  if (typeof data !== "string") return data
  const trimmed = data.trim()
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return data
  try {
    return JSON.parse(trimmed)
  } catch {
    return data
  }
}
