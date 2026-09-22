function sessionDirectory(session, fallbackDirectory = "") {
  return session?.location?.directory || session?.directory || fallbackDirectory
}

function sessionModel(model) {
  if (!model || typeof model !== "object") return undefined
  if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
  return {
    providerID: model.providerID,
    id: model.id,
    ...(typeof model.variant === "string" && model.variant ? { variant: model.variant } : {})
  }
}

export function normalizeOpenCodeV2Session(session, fallbackDirectory = "") {
  if (!session || typeof session !== "object" || typeof session.id !== "string") return undefined
  const time = session.time && typeof session.time === "object" ? session.time : {}
  return {
    id: session.id,
    title: typeof session.title === "string" && session.title ? session.title : `Session ${session.id.slice(0, 8)}`,
    directory: sessionDirectory(session, fallbackDirectory),
    time: {
      created: Number.isFinite(time.created) ? time.created : 0,
      updated: Number.isFinite(time.updated) ? time.updated : Number.isFinite(time.created) ? time.created : 0
    },
    ...(sessionModel(session.model) ? { model: sessionModel(session.model) } : {}),
    ...(typeof session.parentID === "string" ? { parentID: session.parentID } : {}),
    ...(typeof session.agent === "string" ? { agent: session.agent } : {}),
    ...(typeof session.cost === "number" ? { cost: session.cost } : {}),
    ...(session.tokens && typeof session.tokens === "object" ? { tokens: session.tokens } : {}),
    ...(session.revert && typeof session.revert === "object" ? { revert: session.revert } : {}),
    summary: { additions: 0, deletions: 0, files: 0 }
  }
}

function partID(messageID, index) {
  return `${messageID}-part-${index}`
}

function normalizeOpenCodeV2Part(part, messageID, index) {
  if (!part || typeof part !== "object") return undefined
  if (part.type === "text" || part.type === "reasoning") {
    return {
      id: typeof part.id === "string" ? part.id : partID(messageID, index),
      type: part.type,
      ...(typeof part.text === "string" ? { text: part.text } : {})
    }
  }
  if (part.type === "tool") {
    return {
      id: typeof part.id === "string" ? part.id : partID(messageID, index),
      type: "tool",
      tool: typeof part.name === "string" ? part.name : undefined,
      state: part.state && typeof part.state === "object" ? part.state : undefined
    }
  }
  return {
    id: typeof part.id === "string" ? part.id : partID(messageID, index),
    type: typeof part.type === "string" ? part.type : "unknown",
    ...(typeof part.text === "string" ? { text: part.text } : {})
  }
}

export function normalizeOpenCodeV2Message(message, sessionID) {
  if (!message || typeof message !== "object" || typeof message.id !== "string") return undefined
  if (message.type === "idle") return undefined
  const role = message.type === "user" ? "user" : message.type === "assistant" ? "assistant" : "system"
  const created = Number.isFinite(message.time?.created) ? message.time.created : 0
  const parts = message.type === "assistant"
    ? (Array.isArray(message.content) ? message.content : []).map((part, index) => normalizeOpenCodeV2Part(part, message.id, index)).filter(Boolean)
    : [{ id: partID(message.id, 0), type: "text", text: typeof message.text === "string" ? message.text : "" }]
  return {
    info: {
      id: message.id,
      role,
      sessionID,
      time: {
        created,
        ...(Number.isFinite(message.time?.completed) ? { completed: message.time.completed } : {})
      },
      ...(message.error && typeof message.error === "object" ? { error: message.error } : {})
    },
    parts
  }
}

function prefixedPath(pathname) {
  if (pathname === "/global/event" || pathname === "/v1/events") return "/event"
  if (pathname === "/config/providers") return "/provider"
  if (pathname === "/session/status") return "/session/active"
  return pathname
    .replace(/^(\/session\/[^/]+)\/prompt_async$/, "$1/prompt")
    .replace(/^(\/session\/[^/]+)\/abort$/, "$1/interrupt")
    .replace(/^(\/session\/[^/]+)\/stop$/, "$1/interrupt")
}

/** Map Harness Remote's stable OpenCode-shaped route to the current v2 API route. */
export function openCodeApiPath(host, pathname, search = "") {
  const base = host?.apiBasePath ?? ""
  if (base !== "/api") return `${pathname}${search}`
  return `${base}${prefixedPath(pathname)}${search}`
}

function modelSelection(value) {
  if (typeof value === "string") {
    const separator = value.indexOf("/")
    if (separator <= 0 || separator === value.length - 1) return undefined
    return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
  }
  if (!value || typeof value !== "object") return undefined
  const providerID = typeof value.providerID === "string" ? value.providerID : ""
  const modelID = typeof value.modelID === "string"
    ? value.modelID
    : typeof value.id === "string" ? value.id : ""
  if (!providerID || !modelID) return undefined
  return { providerID, modelID, ...(typeof value.variant === "string" && value.variant ? { variant: value.variant } : {}) }
}

/** Build the strict v2 body for the endpoint that changes a Session's subsequent model. */
export function openCodeApiModelBody(host, pathname, body) {
  if (host?.apiBasePath !== "/api" || !body || typeof body !== "object") return undefined
  if (!(pathname.endsWith("/prompt_async") || pathname.endsWith("/prompt") || pathname.endsWith("/message") || pathname.endsWith("/command"))) return undefined
  const selection = modelSelection(body.model)
  if (!selection) return undefined
  return {
    model: {
      providerID: selection.providerID,
      id: selection.modelID,
      ...(typeof body.variant === "string" && body.variant ? { variant: body.variant } : selection.variant ? { variant: selection.variant } : {})
    }
  }
}

function dataURLParts(url) {
  const match = typeof url === "string" ? /^data:([^;,]+);base64,(.+)$/s.exec(url) : null
  return match ? { mime: match[1], data: match[2] } : undefined
}

/** Translate the old bridge body to the strict OpenCode v2 prompt/command schema. */
export function openCodeApiBody(host, pathname, body, directory = "") {
  if (host?.apiBasePath !== "/api" || !body || typeof body !== "object") return body
  if (pathname === "/session") {
    const result = {}
    for (const key of ["id", "title", "agent", "metadata", "permissions"]) {
      if (body[key] !== undefined) result[key] = body[key]
    }
    const model = modelSelection(body.model)
    if (model) {
      result.model = {
        providerID: model.providerID,
        id: model.modelID,
        ...(model.variant ? { variant: model.variant } : {})
      }
    } else if (body.model === null) {
      result.model = null
    }
    if (directory) result.location = { directory }
    return result
  }
  if (pathname.endsWith("/prompt_async") || pathname.endsWith("/prompt")) {
    const parts = Array.isArray(body.parts)
      ? body.parts
      : [
        { type: "text", text: body.text || "" },
        ...(Array.isArray(body.attachments) ? body.attachments.map((attachment) => ({ type: "file", ...attachment })) : [])
      ]
    return {
      text: parts.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n"),
      files: parts.flatMap((part) => {
        const value = dataURLParts(part?.url)
        return value ? [{ data: value.data, mime: value.mime, source: { type: "inline" }, name: part.filename || "attachment" }] : []
      })
    }
  }
  if (pathname.endsWith("/command")) {
    return { name: body.command || "", text: body.arguments || "" }
  }
  if (pathname.endsWith("/stop")) return {}
  return body
}

function normalizeStatus(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {}
  return Object.fromEntries(Object.entries(data).map(([sessionID, state]) => [
    sessionID,
    { type: state?.type === "running" ? "busy" : "idle" }
  ]))
}

function messagePage(payload, sessionID) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return {
    messages: data.map((message) => normalizeOpenCodeV2Message(message, sessionID)).filter(Boolean),
    nextCursor: typeof payload?.cursor?.next === "string" ? payload.cursor.next : undefined
  }
}

/** Normalize a v2 JSON envelope into the stable response consumed by the web client. */
export function normalizeOpenCodeV2Response({ pathname, payload, statusCode, directory = "", sessionID }) {
  if (statusCode === 204) return { payload: true }
  if (pathname === "/session/status") return { payload: normalizeStatus(payload) }
  if (pathname === "/config/providers") {
    return { payload: { providers: Array.isArray(payload?.data) ? payload.data : [], default: payload?.default ?? {} } }
  }
  if (pathname === "/command") return { payload: Array.isArray(payload?.data) ? payload.data : [] }
  if (pathname === "/session" && Array.isArray(payload?.data)) {
    return { payload: payload.data.map((session) => normalizeOpenCodeV2Session(session, directory)).filter(Boolean) }
  }
  if (pathname === "/session" && payload?.data && typeof payload.data === "object") {
    return { payload: normalizeOpenCodeV2Session(payload.data, directory) }
  }
  if (pathname.endsWith("/message") && payload && typeof payload === "object") {
    const page = messagePage(payload, sessionID)
    return { payload: page.messages, nextCursor: page.nextCursor }
  }
  if (pathname.endsWith("/diff") && Array.isArray(payload?.data)) return { payload: payload.data }
  if (pathname.endsWith("/prompt_async") || pathname.endsWith("/prompt") || pathname.endsWith("/abort") || pathname.endsWith("/stop") || pathname.endsWith("/model")) return { payload: true }
  if (pathname.endsWith("/todo") || pathname.endsWith("/action")) return { payload: [] }
  if (pathname === "/permission" && Array.isArray(payload?.data)) return { payload: payload.data }
  return { payload }
}
