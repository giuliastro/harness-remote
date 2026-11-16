import { machinePairingLinks } from "./pairing-server.js"

/** A secure QR binds the one-time grant to the machine certificate before the phone sends it. */
export function remotePairingURI({ endpoint, grant, machineID, dnsName, pin, name }) {
  const url = new URL(endpoint)
  if (url.protocol !== "https:" || !url.hostname || !url.port || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash
    || !/^[A-Za-z0-9_-]{1,128}$/.test(machineID)
    || !/^m-[a-f0-9]{32}\.[a-f0-9]{32}\.machine\.harness-remote\.invalid$/.test(dnsName)
    || !/^[a-f0-9]{64}$/.test(pin)
    || typeof name !== "string" || !name.trim() || name.length > 80
    || typeof grant?.token !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(grant.token)
    || !Number.isFinite(grant.expiresAt)) throw new Error("Invalid remote pairing link")
  const params = new URLSearchParams({
    endpoint: url.origin,
    token: grant.token,
    expires: String(grant.expiresAt),
    machine: machineID,
    dns: dnsName,
    pin,
    name
  })
  return `harnessremote://remote-pair?${params}`
}

export function remotePairingLinks({ host, port, grant, machineID, dnsName, pin, name, interfaces }) {
  return machinePairingLinks({ host, port }, grant, interfaces).map(({ endpoint }) => {
    const secureEndpoint = endpoint.replace(/^http:/, "https:")
    return {
      endpoint: secureEndpoint,
      uri: remotePairingURI({ endpoint: secureEndpoint, grant, machineID, dnsName, pin, name })
    }
  })
}
