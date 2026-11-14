import type { ServerConfig } from "./types"

/**
 * A machine snapshot is only valid for the exact connection that produced it.
 * This deliberately includes credentials and the optional harness selection: saving a corrected
 * password or switching harness must never keep a successful result from the prior configuration.
 */
export function sameMachineConnection(left: ServerConfig, right: ServerConfig): boolean {
  return left.host.trim().toLowerCase() === right.host.trim().toLowerCase()
    && left.port === right.port
    && left.username === right.username
    && left.password === right.password
    && (left.agentId?.trim() || "") === (right.agentId?.trim() || "")
    && (left.remote?.machineID || "") === (right.remote?.machineID || "")
    && (left.remote?.dnsName || "") === (right.remote?.dnsName || "")
    && (left.remote?.pin || "") === (right.remote?.pin || "")
}
