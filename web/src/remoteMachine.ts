import { Capacitor, registerPlugin } from "@capacitor/core"
import { machineBaseUrl } from "./serverConfig.ts"
import { normalizeNativeResponseData } from "./nativeResponse.ts"
import type { ServerConfig } from "./types.ts"

type NativeResponse = {
  status: number
  data: unknown
  headers: Record<string, string>
}

type NativeRemoteMachine = {
  request(options: {
    endpoint: string
    machineID: string
    dnsName: string
    pin: string
    method: string
    target: string
    body?: string
    backend: string
    readTimeout?: number
  }): Promise<NativeResponse>
  pair(options: {
    endpoint: string
    dnsName: string
    pin: string
    token: string
    name: string
  }): Promise<NativeResponse>
}

const RemoteMachine = registerPlugin<NativeRemoteMachine>("RemoteMachine")

function requireAndroidRemote(config: ServerConfig) {
  if (!config.remote) throw new Error("Remote machine identity is missing")
  if (Capacitor.getPlatform() !== "android") throw new Error("Remote machine access requires the Android app")
  return config.remote
}

/** No CapacitorHttp/fetch fallback: a remote profile always uses its own pinned native channel. */
export async function remoteMachineRequest(
  config: ServerConfig,
  target: string,
  options: { method?: string; body?: unknown; readTimeout?: number } = {}
): Promise<NativeResponse> {
  const identity = requireAndroidRemote(config)
  if (!target.startsWith("/") || target.startsWith("//")) throw new Error("Invalid remote request target")
  const response = await RemoteMachine.request({
    endpoint: machineBaseUrl(config),
    ...identity,
    method: options.method ?? "GET",
    target,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    backend: config.backend,
    readTimeout: options.readTimeout
  })
  return { ...response, data: normalizeNativeResponseData(response.data) }
}

export function remoteMachineRequestUrl(
  config: ServerConfig,
  target: string,
  options: { method?: string; body?: unknown; readTimeout?: number } = {}
): Promise<NativeResponse> {
  const endpoint = machineBaseUrl(config)
  const parsed = new URL(target)
  if (parsed.origin !== new URL(endpoint).origin || parsed.hash) throw new Error("Invalid remote machine URL")
  return remoteMachineRequest(config, `${parsed.pathname}${parsed.search}`, options)
}

export async function remoteMachinePair(
  endpoint: string,
  identity: { dnsName: string; pin: string },
  token: string,
  name: string
): Promise<NativeResponse> {
  if (Capacitor.getPlatform() !== "android") throw new Error("Remote machine pairing requires the Android app")
  const response = await RemoteMachine.pair({ endpoint, ...identity, token, name })
  return { ...response, data: normalizeNativeResponseData(response.data) }
}
