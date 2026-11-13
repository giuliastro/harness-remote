import { randomBytes } from "node:crypto"
import dgram from "node:dgram"
import http from "node:http"
import net from "node:net"
import { URL } from "node:url"

const SUPPORTED_PROTOCOLS = new Set(["upnp-igd", "nat-pmp", "pcp"])
const TRANSPORTS = new Set(["tcp", "udp"])
const SSDP_ADDRESS = "239.255.255.250"
const SSDP_PORT = 1900
const NAT_PMP_MAX_LEASE_SECONDS = 300
const NAT_PMP_LIMITATION = "NAT-PMP has no per-mapping ownership token; shutdown skips destructive delete and lets the mapping expire within five minutes of its last accepted lease."

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

function ipv4Octets(value) {
  if (!net.isIPv4(value)) return null
  return value.split(".").map(Number)
}

function isLanIpv4(value) {
  const ip = ipv4Octets(value)
  if (!ip) return false
  return ip[0] === 10 ||
    (ip[0] === 169 && ip[1] === 254) ||
    (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
    (ip[0] === 192 && ip[1] === 168)
}

function isGlobalIpv4(value) {
  const ip = ipv4Octets(value)
  if (!ip) return false
  const [a, b, c] = ip
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 192 && b === 88 && c === 99) || (a === 203 && b === 0 && c === 113)) return false
  return true
}

function xmlValue(xml, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = xml.match(new RegExp(`<(?:(?:[\\w.-]+):)?${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${escapedTag}\\s*>`, "i"))
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() ?? null
}

function soapEnvelope(serviceType, action, args) {
  const fields = Object.entries(args).map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join("")
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${xmlEscape(serviceType)}">${fields}</u:${action}></s:Body></s:Envelope>`
}

function defaultHttpRequest(url, { method = "GET", headers = {}, body = "", timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === "http:" ? http : null
    if (!transport) return reject(codedError("UPNP_INVALID_URL", "Unsupported UPnP URL scheme"))
    const request = transport.request(parsed, { method, headers, timeout: timeoutMs }, (response) => {
      let data = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        data += chunk
        if (Buffer.byteLength(data, "utf8") > 256_000) response.destroy(codedError("UPNP_RESPONSE_TOO_LARGE", "UPnP response exceeds 256 KB"))
      })
      response.on("error", reject)
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: data }))
    })
    request.on("timeout", () => request.destroy(codedError("UPNP_TIMEOUT", "UPnP HTTP request timed out")))
    request.on("error", reject)
    if (body) request.write(body)
    request.end()
  })
}

export function defaultSsdpSearch({ timeoutMs = 1200, socketFactory = dgram.createSocket } = {}) {
  return new Promise((resolve, reject) => {
    const socket = socketFactory("udp4")
    const found = new Map()
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* Socket may already be closed. */ }
      if (error) reject(error)
      else resolve([...found.values()])
    }
    const timer = setTimeout(() => finish(), timeoutMs)
    socket.on("error", (error) => finish(error))
    socket.on("message", (message, rinfo) => {
      const location = message.toString("utf8").match(/^location\s*:\s*(.+)$/im)?.[1]?.trim()
      if (location) found.set(location, { location, sourceAddress: rinfo.address })
    })
    socket.bind(0, () => {
      const request = Buffer.from([
        "M-SEARCH * HTTP/1.1", `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"', "MX: 1", "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1", "", ""
      ].join("\r\n"))
      socket.send(request, SSDP_PORT, SSDP_ADDRESS, (error) => { if (error) finish(error) })
    })
  })
}

function defaultUdpExchange({ gatewayAddress, request, timeoutMs = 1200, socketFactory = dgram.createSocket }) {
  return new Promise((resolve, reject) => {
    const socket = socketFactory("udp4")
    let settled = false
    const finish = (error, response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* Socket may already be closed. */ }
      if (error) reject(error)
      else resolve(response)
    }
    const timer = setTimeout(() => finish(codedError("PORT_MAPPING_TIMEOUT", "Router mapping request timed out")), timeoutMs)
    timer.unref?.()
    socket.on("error", (error) => finish(error))
    socket.on("message", (response, rinfo) => {
      if (rinfo.address === gatewayAddress) finish(null, Buffer.from(response))
    })
    socket.send(request, 5351, gatewayAddress, (error) => { if (error) finish(error) })
  })
}

function checkLanEndpoints(gatewayAddress, localAddress) {
  if (!isLanIpv4(gatewayAddress)) throw codedError("PORT_MAPPING_ROUTER_REQUIRED", "A private or link-local IPv4 router address is required")
  if (!isLanIpv4(localAddress)) throw codedError("PORT_MAPPING_LOCAL_ADDRESS_REQUIRED", "A private or link-local gateway IPv4 address is required")
}

function ipv4MappedAddress(address) {
  const octets = ipv4Octets(address)
  if (!octets) throw codedError("INVALID_IPV4_ADDRESS", "An IPv4 address is required")
  const bytes = Buffer.alloc(16)
  bytes[10] = 0xff
  bytes[11] = 0xff
  bytes.set(octets, 12)
  return bytes
}

function decodeMappedIpv4(bytes) {
  if (bytes.length !== 16 || !bytes.subarray(0, 10).equals(Buffer.alloc(10)) || bytes[10] !== 0xff || bytes[11] !== 0xff) return null
  return [...bytes.subarray(12, 16)].join(".")
}

function natPmpPublicAddress(response) {
  if (!Buffer.isBuffer(response) || response.length < 12 || response[0] !== 0 || response[1] !== 128) {
    throw codedError("NAT_PMP_INVALID_RESPONSE", "Router returned an invalid NAT-PMP address response")
  }
  const resultCode = response.readUInt16BE(2)
  if (resultCode !== 0) throw codedError(`NAT_PMP_RESULT_${resultCode}`, `Router rejected NAT-PMP request (${resultCode})`)
  const address = [...response.subarray(8, 12)].join(".")
  if (!isGlobalIpv4(address)) throw codedError("NAT_PMP_EXTERNAL_ADDRESS_NOT_GLOBAL", "NAT-PMP router did not report a globally routable IPv4 address")
  return address
}

function natPmpMappingResponse(response, opcode, internalPort) {
  if (!Buffer.isBuffer(response) || response.length < 16 || response[0] !== 0 || response[1] !== opcode + 128) {
    throw codedError("NAT_PMP_INVALID_RESPONSE", "Router returned an invalid NAT-PMP mapping response")
  }
  const resultCode = response.readUInt16BE(2)
  if (resultCode !== 0) throw codedError(`NAT_PMP_RESULT_${resultCode}`, `Router rejected NAT-PMP request (${resultCode})`)
  const actualInternalPort = response.readUInt16BE(8)
  const externalPort = response.readUInt16BE(10)
  const lifetimeSeconds = response.readUInt32BE(12)
  if (actualInternalPort !== internalPort || externalPort < 1) {
    throw codedError("NAT_PMP_MAPPING_MISMATCH", "NAT-PMP response did not match the requested internal port")
  }
  return { externalPort, lifetimeSeconds }
}

function makeNatPmpMappingRequest({ opcode, internalPort, externalPort, lifetimeSeconds }) {
  const request = Buffer.alloc(12)
  request[0] = 0
  request[1] = opcode
  request.writeUInt16BE(internalPort, 4)
  request.writeUInt16BE(externalPort, 6)
  request.writeUInt32BE(lifetimeSeconds, 8)
  return request
}

/** NAT-PMP has no mapping query or per-mapping nonce. It requests a router-
 * allocated port and renews it, but intentionally does not send a destructive
 * delete on shutdown; the short lease is allowed to expire instead. */
export function createNatPmpAdapter({
  gatewayAddress,
  localAddress,
  timeoutMs = 1200,
  exchange = (args) => defaultUdpExchange({ ...args, timeoutMs })
} = {}) {
  const ownedMappings = new Map()
  const opcodeFor = (transport) => transport === "tcp" ? 2 : 1
  const request = (router, bytes) => exchange({ gatewayAddress: router.gatewayAddress, request: bytes, timeoutMs })
  const publicAddress = async (router) => natPmpPublicAddress(await request(router, Buffer.from([0, 0])))

  return {
    protocol: "nat-pmp",
    cleanupMode: "lease-expiry",
    limitations: [NAT_PMP_LIMITATION],
    async discover() {
      if (!isLanIpv4(gatewayAddress) || !isLanIpv4(localAddress)) return null
      return { gatewayAddress, localAddress }
    },
    async add({ router, internalPort, transport, lifetimeSeconds, ownerToken }) {
      checkLanEndpoints(router.gatewayAddress, router.localAddress)
      const address = await publicAddress(router)
      const opcode = opcodeFor(transport)
      const boundedLifetime = Math.min(lifetimeSeconds, NAT_PMP_MAX_LEASE_SECONDS)
      const mapping = natPmpMappingResponse(await request(router, makeNatPmpMappingRequest({
        opcode, internalPort, externalPort: 0, lifetimeSeconds: boundedLifetime
      })), opcode, internalPort)
      if (mapping.lifetimeSeconds < 1) throw codedError("NAT_PMP_MAPPING_NOT_ACTIVE", "Router did not create a live NAT-PMP mapping")
      const lease = {
        protocol: "nat-pmp", externalAddress: address, externalPort: mapping.externalPort,
        ownerToken, expiresAt: Date.now() + mapping.lifetimeSeconds * 1000
      }
      ownedMappings.set(ownerToken, { router, internalPort, transport, lease })
      return lease
    },
    async renew({ router, lease, internalPort, transport, lifetimeSeconds, ownerToken }) {
      const owned = ownedMappings.get(ownerToken)
      if (!owned || owned.lease.externalPort !== lease.externalPort || owned.internalPort !== internalPort || owned.transport !== transport) {
        throw codedError("NAT_PMP_OWNERSHIP_LOST", "NAT-PMP mapping tuple is not owned by this manager")
      }
      const address = await publicAddress(router)
      if (address !== lease.externalAddress) throw codedError("NAT_PMP_EXTERNAL_ADDRESS_CHANGED", "NAT-PMP external address changed; reacquire the mapping")
      const opcode = opcodeFor(transport)
      const boundedLifetime = Math.min(lifetimeSeconds, NAT_PMP_MAX_LEASE_SECONDS)
      const mapping = natPmpMappingResponse(await request(router, makeNatPmpMappingRequest({
        opcode, internalPort, externalPort: lease.externalPort, lifetimeSeconds: boundedLifetime
      })), opcode, internalPort)
      if (mapping.externalPort !== lease.externalPort || mapping.lifetimeSeconds < 1) {
        throw codedError("NAT_PMP_MAPPING_CHANGED", "NAT-PMP renewal did not preserve the existing mapping")
      }
      const renewed = { ...lease, expiresAt: Date.now() + mapping.lifetimeSeconds * 1000 }
      owned.lease = renewed
      return renewed
    },
    async remove({ router, lease, ownerToken }) {
      const owned = ownedMappings.get(ownerToken)
      if (!owned || owned.lease.externalPort !== lease.externalPort) return false
      // A zero-lifetime request could delete another actor's replacement.
      // Skip the router operation and let this bounded lease expire.
      ownedMappings.delete(ownerToken)
      return false
    }
  }
}

function makePcpMapRequest({ clientAddress, nonce, protocol, internalPort, externalPort, lifetimeSeconds }) {
  const request = Buffer.alloc(60)
  request[0] = 2
  request[1] = 1
  request.writeUInt32BE(lifetimeSeconds, 4)
  ipv4MappedAddress(clientAddress).copy(request, 8)
  nonce.copy(request, 24)
  request[36] = protocol === "tcp" ? 6 : 17
  request.writeUInt16BE(internalPort, 40)
  request.writeUInt16BE(externalPort, 42)
  return request
}

function parsePcpMapResponse(response, { nonce, protocol, internalPort }) {
  if (!Buffer.isBuffer(response) || response.length < 60 || response[0] !== 2 || response[1] !== 0x81) {
    throw codedError("PCP_INVALID_RESPONSE", "Router returned an invalid PCP MAP response")
  }
  const resultCode = response[3]
  if (resultCode !== 0) throw codedError(`PCP_RESULT_${resultCode}`, `Router rejected PCP request (${resultCode})`)
  if (!response.subarray(24, 36).equals(nonce) || response[36] !== (protocol === "tcp" ? 6 : 17) || response.readUInt16BE(40) !== internalPort) {
    throw codedError("PCP_IDENTITY_MISMATCH", "PCP response did not match the mapping nonce and tuple")
  }
  const externalAddress = decodeMappedIpv4(response.subarray(44, 60))
  if (!isGlobalIpv4(externalAddress)) throw codedError("PCP_EXTERNAL_ADDRESS_NOT_GLOBAL", "PCP router did not report a globally routable IPv4 address")
  return { externalAddress, externalPort: response.readUInt16BE(42), lifetimeSeconds: response.readUInt32BE(4) }
}

/** PCP's random 96-bit nonce binds renewal and deletion to this mapping. */
export function createPcpAdapter({
  gatewayAddress,
  localAddress,
  timeoutMs = 1200,
  exchange = (args) => defaultUdpExchange({ ...args, timeoutMs }),
  nonceFactory = () => randomBytes(12)
} = {}) {
  const ownedMappings = new Map()
  const request = (router, bytes) => exchange({ gatewayAddress: router.gatewayAddress, request: bytes, timeoutMs })
  return {
    protocol: "pcp",
    async discover() {
      if (!isLanIpv4(gatewayAddress) || !isLanIpv4(localAddress)) return null
      return { gatewayAddress, localAddress }
    },
    async add({ router, internalPort, externalPort, transport, lifetimeSeconds, ownerToken }) {
      checkLanEndpoints(router.gatewayAddress, router.localAddress)
      const nonce = nonceFactory()
      if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw codedError("PCP_INVALID_NONCE", "PCP nonce must contain 12 bytes")
      const response = parsePcpMapResponse(await request(router, makePcpMapRequest({
        clientAddress: router.localAddress, nonce, protocol: transport, internalPort, externalPort, lifetimeSeconds
      })), { nonce, protocol: transport, internalPort })
      if (response.externalPort < 1 || response.lifetimeSeconds < 1) throw codedError("PCP_MAPPING_NOT_ACTIVE", "Router did not create a live PCP mapping")
      const lease = {
        protocol: "pcp", externalAddress: response.externalAddress, externalPort: response.externalPort,
        ownerToken, expiresAt: Date.now() + response.lifetimeSeconds * 1000
      }
      ownedMappings.set(ownerToken, { router, internalPort, transport, nonce: Buffer.from(nonce), lease })
      return lease
    },
    async renew({ router, lease, internalPort, transport, lifetimeSeconds, ownerToken }) {
      const owned = ownedMappings.get(ownerToken)
      if (!owned || owned.lease.externalPort !== lease.externalPort || owned.internalPort !== internalPort || owned.transport !== transport) {
        throw codedError("PCP_OWNERSHIP_LOST", "PCP nonce and mapping tuple are not owned by this manager")
      }
      const response = parsePcpMapResponse(await request(router, makePcpMapRequest({
        clientAddress: router.localAddress, nonce: owned.nonce, protocol: transport,
        internalPort, externalPort: lease.externalPort, lifetimeSeconds
      })), { nonce: owned.nonce, protocol: transport, internalPort })
      if (response.externalPort !== lease.externalPort || response.externalAddress !== lease.externalAddress || response.lifetimeSeconds < 1) {
        throw codedError("PCP_MAPPING_CHANGED", "PCP renewal did not preserve the existing mapping")
      }
      const renewed = { ...lease, expiresAt: Date.now() + response.lifetimeSeconds * 1000 }
      owned.lease = renewed
      return renewed
    },
    async remove({ router, lease, ownerToken }) {
      const owned = ownedMappings.get(ownerToken)
      if (!owned || owned.lease.externalPort !== lease.externalPort) return false
      const response = parsePcpMapResponse(await request(router, makePcpMapRequest({
        clientAddress: router.localAddress, nonce: owned.nonce, protocol: owned.transport,
        internalPort: owned.internalPort, externalPort: owned.lease.externalPort, lifetimeSeconds: 0
      })), { nonce: owned.nonce, protocol: owned.transport, internalPort: owned.internalPort })
      if (response.externalPort !== owned.lease.externalPort || response.externalAddress !== owned.lease.externalAddress) {
        throw codedError("PCP_MAPPING_CHANGED", "PCP deletion response did not match the owned mapping")
      }
      ownedMappings.delete(ownerToken)
      return true
    }
  }
}

function getControlService(xml, descriptionUrl) {
  const services = [...xml.matchAll(/<service\b[^>]*>([\s\S]*?)<\/service>/gi)].map((match) => match[1])
  for (const service of services) {
    const serviceType = xmlValue(service, "serviceType")
    if (!serviceType || !/^urn:schemas-upnp-org:service:(?:WANIPConnection|WANPPPConnection):\d+$/i.test(serviceType)) continue
    const controlURL = xmlValue(service, "controlURL")
    if (!controlURL) continue
    const description = new URL(descriptionUrl)
    const control = new URL(controlURL, description)
    if (description.protocol !== "http:" || control.protocol !== "http:" || control.origin !== description.origin ||
        control.username || control.password) continue
    return { serviceType, controlUrl: control.toString() }
  }
  return null
}

/** Create a built-in UPnP-IGD adapter. The caller supplies the LAN address
 * advertised by the gateway's listening socket; discovery and SOAP use Node
 * built-ins only. Mapping descriptions carry a private marker so cleanup can
 * verify that the entry still belongs to this manager before deleting it. */
export function createUpnpIgdAdapter({
  localAddress,
  timeoutMs = 1200,
  socketFactory = dgram.createSocket,
  ssdpSearch = defaultSsdpSearch,
  httpRequest = defaultHttpRequest,
  chooseExternalPort = () => 40000 + randomBytes(2).readUInt16BE(0) % 20000
} = {}) {
  const mappings = new Map()

  async function soap(router, action, args) {
    const description = new URL(router.descriptionUrl)
    const endpoint = new URL(router.controlUrl)
    if (!isLanIpv4(router.sourceAddress) || description.protocol !== "http:" || endpoint.protocol !== "http:" ||
        description.hostname !== router.sourceAddress || endpoint.origin !== description.origin ||
        description.username || description.password || endpoint.username || endpoint.password) {
      throw codedError("UPNP_UNSAFE_ORIGIN", "Refusing a UPnP SOAP request outside the SSDP responder origin")
    }
    const response = await httpRequest(router.controlUrl, {
      method: "POST",
      timeoutMs,
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPAction: `"${router.serviceType}#${action}"`,
        "Content-Length": Buffer.byteLength(soapEnvelope(router.serviceType, action, args))
      },
      body: soapEnvelope(router.serviceType, action, args)
    })
    const faultCode = xmlValue(response.body, "errorCode")
    if ((response.statusCode < 200 || response.statusCode >= 300) && faultCode !== "714") {
      throw codedError(faultCode ? `UPNP_SOAP_${faultCode}` : "UPNP_SOAP_FAILED", `UPnP ${action} failed (${response.statusCode})`)
    }
    return { ...response, faultCode }
  }

  async function isUnused(router, externalPort, transport) {
    const response = await soap(router, "GetSpecificPortMappingEntry", {
      NewRemoteHost: "", NewExternalPort: externalPort, NewProtocol: transport.toUpperCase()
    })
    return response.faultCode === "714"
  }

  return {
    protocol: "upnp-igd",
    async discover() {
      const locations = await ssdpSearch({ timeoutMs, socketFactory })
      for (const item of locations) {
        try {
          if (!item || typeof item.location !== "string" || !isLanIpv4(item.sourceAddress)) continue
          const location = new URL(item.location)
          if (location.protocol !== "http:" || location.hostname !== item.sourceAddress ||
              location.username || location.password) continue
          const response = await httpRequest(location.toString(), { timeoutMs })
          if (response.statusCode < 200 || response.statusCode >= 300) continue
          const service = getControlService(response.body, location.toString())
          if (service) return { ...service, descriptionUrl: location.toString(), sourceAddress: item.sourceAddress }
        } catch { /* Try the next advertised IGD. */ }
      }
      return null
    },
    async add({ router, internalPort, externalPort, transport, lifetimeSeconds, ownerToken }) {
      if (!isLanIpv4(localAddress)) throw codedError("UPNP_LOCAL_ADDRESS_REQUIRED", "UPnP mapping requires the gateway's LAN IPv4 address")
      let selectedPort = externalPort
      if (selectedPort === 0) {
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = chooseExternalPort()
          validatePort(candidate, "selected external port")
          if (await isUnused(router, candidate, transport)) { selectedPort = candidate; break }
        }
        if (selectedPort === 0) throw codedError("UPNP_NO_FREE_PORT", "Could not find an unused external port")
      } else if (!await isUnused(router, selectedPort, transport)) {
        throw codedError("UPNP_PORT_IN_USE", "Requested external port is already mapped")
      }
      const description = `HarnessRemote:${ownerToken}`
      await soap(router, "AddPortMapping", {
        NewRemoteHost: "", NewExternalPort: selectedPort, NewProtocol: transport.toUpperCase(),
        NewInternalPort: internalPort, NewInternalClient: localAddress, NewEnabled: 1,
        NewPortMappingDescription: description, NewLeaseDuration: lifetimeSeconds
      })
      const provisionalLease = { protocol: "upnp-igd", externalAddress: "pending", externalPort: selectedPort, ownerToken }
      const owned = { router, lease: provisionalLease, description, internalPort, transport }
      mappings.set(ownerToken, owned)
      let externalAddress
      try {
        externalAddress = xmlValue((await soap(router, "GetExternalIPAddress", {})).body, "NewExternalIPAddress")
        if (!isGlobalIpv4(externalAddress)) {
          throw codedError("UPNP_EXTERNAL_ADDRESS_NOT_GLOBAL", "Router did not return a globally routable IPv4 address")
        }
      } catch (error) {
        // The mapping was already created. Roll it back only if its marker and
        // target still match, so a concurrent replacement is left alone.
        try {
          const entry = await soap(router, "GetSpecificPortMappingEntry", {
            NewRemoteHost: "", NewExternalPort: selectedPort, NewProtocol: transport.toUpperCase()
          })
          if (xmlValue(entry.body, "NewPortMappingDescription") === description &&
              xmlValue(entry.body, "NewInternalClient") === localAddress &&
              Number(xmlValue(entry.body, "NewInternalPort")) === internalPort) {
            await soap(router, "DeletePortMapping", {
              NewRemoteHost: "", NewExternalPort: selectedPort, NewProtocol: transport.toUpperCase()
            })
          }
        } catch { /* Preserve the primary error; expiry is the final cleanup. */ }
        mappings.delete(ownerToken)
        throw error
      }
      const lease = { ...provisionalLease, externalAddress, expiresAt: Date.now() + lifetimeSeconds * 1000 }
      owned.lease = lease
      return lease
    },
    async renew({ router, lease, internalPort, transport, lifetimeSeconds, ownerToken }) {
      const owned = mappings.get(ownerToken)
      if (!owned || owned.lease.externalPort !== lease.externalPort) throw codedError("UPNP_OWNERSHIP_LOST", "UPnP mapping ownership could not be verified")
      const entry = await soap(router, "GetSpecificPortMappingEntry", {
        NewRemoteHost: "", NewExternalPort: lease.externalPort, NewProtocol: transport.toUpperCase()
      })
      if (entry.faultCode === "714" || xmlValue(entry.body, "NewPortMappingDescription") !== owned.description ||
          xmlValue(entry.body, "NewInternalClient") !== localAddress || Number(xmlValue(entry.body, "NewInternalPort")) !== internalPort) {
        throw codedError("UPNP_OWNERSHIP_LOST", "UPnP mapping no longer matches this manager's lease")
      }
      await soap(router, "AddPortMapping", {
        NewRemoteHost: "", NewExternalPort: lease.externalPort, NewProtocol: transport.toUpperCase(),
        NewInternalPort: internalPort, NewInternalClient: localAddress, NewEnabled: 1,
        NewPortMappingDescription: owned.description, NewLeaseDuration: lifetimeSeconds
      })
      return { ...lease, expiresAt: Date.now() + lifetimeSeconds * 1000 }
    },
    async remove({ router, lease, ownerToken }) {
      const owned = mappings.get(ownerToken)
      if (!owned || owned.lease.externalPort !== lease.externalPort) return false
      const entry = await soap(router, "GetSpecificPortMappingEntry", {
        NewRemoteHost: "", NewExternalPort: lease.externalPort, NewProtocol: owned.transport.toUpperCase()
      })
      if (entry.faultCode === "714") { mappings.delete(ownerToken); return false }
      const stillOwned = xmlValue(entry.body, "NewPortMappingDescription") === owned.description &&
        xmlValue(entry.body, "NewInternalClient") === localAddress &&
        Number(xmlValue(entry.body, "NewInternalPort")) === owned.internalPort
      if (!stillOwned) throw codedError("UPNP_OWNERSHIP_LOST", "Refusing to remove a mapping that no longer matches this manager")
      await soap(router, "DeletePortMapping", {
        NewRemoteHost: "", NewExternalPort: lease.externalPort, NewProtocol: owned.transport.toUpperCase()
      })
      mappings.delete(ownerToken)
      return true
    }
  }
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function validatePort(port, name) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw codedError("INVALID_PORT", `${name} must be an integer from 1 to 65535`)
  }
}

function validateLease(lease, protocol, ownerToken) {
  if (!lease || typeof lease !== "object" || lease.protocol !== protocol ||
      typeof lease.externalAddress !== "string" || !lease.externalAddress ||
      !Number.isInteger(lease.externalPort) || lease.externalPort < 1 || lease.externalPort > 65535 ||
      lease.ownerToken !== ownerToken) {
    throw codedError("INVALID_MAPPING_LEASE", `${protocol} returned a mapping without verifiable ownership`)
  }
  return Object.freeze({ ...lease })
}

/**
 * Owns a single router mapping through one of the protocol adapters supplied by
 * the host. Adapters must implement discover(), add(), renew() and remove().
 * Every operation is scoped by an opaque ownerToken; adapters must verify it
 * against protocol metadata before renewing or deleting a mapping.
 *
 * The module is intentionally not wired into the gateway. A caller must also
 * explicitly assert that the internet-facing service has secure transport.
 */
export function createPortMappingManager({
  adapters = [],
  secureTransportReady = false,
  logger = () => {},
  ownerToken = randomBytes(16).toString("hex")
} = {}) {
  const orderedAdapters = [...adapters]
  const diagnostics = {
    state: "idle",
    protocol: null,
    externalAddress: null,
    externalPort: null,
    internalPort: null,
    transport: null,
    expiresAt: null,
    cleanupMode: null,
    limitations: [],
    lastError: null,
    attempts: []
  }
  let active = null

  function emit(event, fields = {}) {
    const detail = Object.freeze({ component: "port-mapping", event, ...fields })
    try { logger(detail) } catch { /* Diagnostics must not break network cleanup. */ }
  }

  function requireSecureTransport() {
    if (secureTransportReady !== true) {
      throw codedError("SECURE_TRANSPORT_REQUIRED", "Port mapping is disabled until secure transport is ready")
    }
  }

  function getDiagnostics() {
    return Object.freeze({ ...diagnostics, attempts: diagnostics.attempts.map((item) => ({ ...item })) })
  }

  async function acquire({ internalPort, externalPort = 0, transport = "tcp", lifetimeSeconds = 3600 } = {}) {
    requireSecureTransport()
    validatePort(internalPort, "internalPort")
    if (externalPort !== 0) validatePort(externalPort, "externalPort")
    if (!TRANSPORTS.has(transport)) throw codedError("INVALID_TRANSPORT", "transport must be tcp or udp")
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 86400) {
      throw codedError("INVALID_LIFETIME", "lifetimeSeconds must be from 60 to 86400")
    }
    if (active) throw codedError("MAPPING_ALREADY_ACTIVE", "This manager already owns a mapping")

    diagnostics.state = "discovering"
    diagnostics.internalPort = internalPort
    diagnostics.transport = transport
    diagnostics.attempts = []
    diagnostics.lastError = null
    for (const adapter of orderedAdapters) {
      const protocol = adapter?.protocol
      if (!SUPPORTED_PROTOCOLS.has(protocol) ||
          typeof adapter.discover !== "function" || typeof adapter.add !== "function" ||
          typeof adapter.renew !== "function" || typeof adapter.remove !== "function") {
        diagnostics.attempts.push({ protocol: protocol ?? "unknown", result: "invalid-adapter" })
        continue
      }
      try {
        const router = await adapter.discover()
        if (!router) {
          diagnostics.attempts.push({ protocol, result: "not-found" })
          continue
        }
        diagnostics.state = "requesting"
        const lease = validateLease(await adapter.add({
          router,
          internalPort,
          externalPort,
          transport,
          lifetimeSeconds,
          ownerToken
        }), protocol, ownerToken)
        active = { adapter, router, lease, internalPort, transport, lifetimeSeconds }
        diagnostics.state = "active"
        diagnostics.protocol = protocol
        diagnostics.externalAddress = lease.externalAddress
        diagnostics.externalPort = lease.externalPort
        diagnostics.expiresAt = Number.isFinite(lease.expiresAt) ? lease.expiresAt : null
        diagnostics.cleanupMode = adapter.cleanupMode ?? "protocol-delete"
        diagnostics.limitations = Array.isArray(adapter.limitations) ? [...adapter.limitations] : []
        diagnostics.attempts.push({ protocol, result: "mapped" })
        emit("mapping-created", {
          protocol,
          externalAddress: lease.externalAddress,
          externalPort: lease.externalPort,
          internalPort,
          transport
        })
        return getDiagnostics()
      } catch (error) {
        const code = error?.code ?? "MAPPING_FAILED"
        diagnostics.attempts.push({ protocol, result: "failed", code })
        diagnostics.lastError = code
        emit("protocol-failed", { protocol, code })
      }
    }
    diagnostics.state = "unavailable"
    diagnostics.protocol = null
    diagnostics.externalAddress = null
    diagnostics.externalPort = null
    diagnostics.expiresAt = null
    diagnostics.cleanupMode = null
    diagnostics.limitations = []
    emit("mapping-unavailable", { attempts: diagnostics.attempts.length })
    return getDiagnostics()
  }

  async function renew({ lifetimeSeconds = active?.lifetimeSeconds ?? 3600 } = {}) {
    requireSecureTransport()
    if (!active) throw codedError("NO_ACTIVE_MAPPING", "There is no active mapping to renew")
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 86400) {
      throw codedError("INVALID_LIFETIME", "lifetimeSeconds must be from 60 to 86400")
    }
    diagnostics.state = "renewing"
    try {
      const renewed = validateLease(await active.adapter.renew({
        router: active.router,
        lease: active.lease,
        internalPort: active.internalPort,
        transport: active.transport,
        lifetimeSeconds,
        ownerToken
      }), active.adapter.protocol, ownerToken)
      // Refuse a replacement mapping on renewal: that can indicate the router
      // lost our lease or the protocol adapter could not prove continuity.
      if (renewed.externalPort !== active.lease.externalPort ||
          renewed.externalAddress !== active.lease.externalAddress) {
        throw codedError("MAPPING_IDENTITY_CHANGED", "Renewal returned a different external mapping")
      }
      active.lease = renewed
      active.lifetimeSeconds = lifetimeSeconds
      diagnostics.state = "active"
      diagnostics.expiresAt = Number.isFinite(renewed.expiresAt) ? renewed.expiresAt : null
      diagnostics.lastError = null
      emit("mapping-renewed", { protocol: active.adapter.protocol, externalPort: renewed.externalPort })
      return getDiagnostics()
    } catch (error) {
      diagnostics.state = "renewal-failed"
      diagnostics.lastError = error?.code ?? "RENEWAL_FAILED"
      emit("renewal-failed", { protocol: active.adapter.protocol, code: diagnostics.lastError })
      throw error
    }
  }

  async function remove() {
    if (!active) return getDiagnostics()
    const owned = active
    diagnostics.state = "removing"
    try {
      await owned.adapter.remove({ router: owned.router, lease: owned.lease, ownerToken })
      active = null
      diagnostics.lastError = null
      if (owned.adapter.cleanupMode === "lease-expiry") {
        diagnostics.state = "lease-expiring"
        emit("mapping-expiry-pending", {
          protocol: owned.adapter.protocol,
          externalPort: owned.lease.externalPort,
          expiresAt: diagnostics.expiresAt,
          cleanupMode: "lease-expiry"
        })
      } else {
        diagnostics.state = "removed"
        diagnostics.protocol = null
        diagnostics.externalAddress = null
        diagnostics.externalPort = null
        diagnostics.expiresAt = null
        diagnostics.cleanupMode = null
        diagnostics.limitations = []
        emit("mapping-removed", { protocol: owned.adapter.protocol, externalPort: owned.lease.externalPort })
      }
      return getDiagnostics()
    } catch (error) {
      diagnostics.state = "remove-failed"
      diagnostics.lastError = error?.code ?? "REMOVE_FAILED"
      emit("remove-failed", { protocol: owned.adapter.protocol, code: diagnostics.lastError })
      throw error
    }
  }

  return Object.freeze({ acquire, renew, remove, diagnostics: getDiagnostics })
}

export const portMappingProtocols = Object.freeze([...SUPPORTED_PROTOCOLS])
