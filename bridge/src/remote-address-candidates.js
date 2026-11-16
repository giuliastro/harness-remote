import net from "node:net"

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

function ipv4Octets(value) {
  if (!net.isIPv4(value)) return null
  return value.split(".").map(Number)
}

function isLanIpv4(value) {
  const octets = ipv4Octets(value)
  if (!octets) return false
  const [a, b] = octets
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
}

function ipv6Value(value) {
  const withoutZone = value.split("%", 1)[0]
  if (!net.isIPv6(withoutZone)) return null

  const halves = withoutZone.toLowerCase().split("::")
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left
  if (groups.length !== 8) return null
  try {
    return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n)
  } catch {
    // IPv4-embedded notation and malformed interface records are not advertised.
    return null
  }
}

function isGlobalIpv6(value) {
  const address = ipv6Value(value)
  if (address === null) return false

  // Global unicast allocations are within 2000::/3. Exclude ranges reserved
  // for documentation, transition mechanisms, benchmarking, or special use.
  if ((address >> 125n) !== 1n) return false
  if ((address >> 96n) === 0x20010db8n) return false // 2001:db8::/32 documentation
  if ((address >> 105n) === 0x100080n) return false // 2001::/23 IANA special-purpose space
  if ((address >> 112n) === 0x2002n) return false // 2002::/16 6to4
  if ((address >> 108n) === 0x3fff0n) return false // 3fff::/20 documentation
  return true
}

function addressList(interfaces) {
  if (!interfaces || typeof interfaces !== "object" || Array.isArray(interfaces)) return []
  const entries = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!Array.isArray(addresses)) continue
    for (const address of addresses) {
      if (!address || typeof address.address !== "string" || address.internal === true) continue
      const family = address.family
      if ((family === "IPv4" || family === 4) && isLanIpv4(address.address)) {
        entries.push({ family: 4, name, address: address.address })
      } else if ((family === "IPv6" || family === 6) && isGlobalIpv6(address.address)) {
        // Strip a scope suffix: globally routable IPv6 candidates do not need one.
        entries.push({ family: 6, name, address: address.address.split("%", 1)[0].toLowerCase() })
      }
    }
  }
  return entries
}

function verifiedMappedAddress(lease, now) {
  if (!Number.isFinite(now) || !lease || lease.state !== "active" || lease.transport !== "tcp" ||
      !validPort(lease.externalPort) || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now ||
      !ipv4Octets(lease.externalAddress)) return null
  const [a, b, c] = ipv4Octets(lease.externalAddress)
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 192 && b === 88 && c === 99) ||
      (a === 203 && b === 0 && c === 113)) return null
  return lease
}

/**
 * Build HTTPS endpoint candidates from an already-read networkInterfaces()
 * value. A mapping lease is included only while its active TCP lease is valid.
 * This function performs no discovery, probing, mapping, or publication.
 */
export function remoteAddressCandidates({ interfaces, port, mappingLease, now, loopbackOnly = false } = {}) {
  if (!validPort(port)) throw new TypeError("port must be an integer from 1 to 65535")

  // The E1 preview listener is deliberately bound to 127.0.0.1. Its only useful
  // remote candidate is the adb-reversed loopback endpoint; interface addresses
  // and router mappings would claim reachability the listener does not have.
  if (loopbackOnly) return [`https://127.0.0.1:${port}`]

  const candidates = new Set()
  const localAddresses = addressList(interfaces)
  for (const family of [4, 6]) {
    const ordered = localAddresses.filter((entry) => entry.family === family)
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 :
        left.address < right.address ? -1 : left.address > right.address ? 1 : 0)
    for (const entry of ordered) {
      const host = family === 6 ? `[${entry.address}]` : entry.address
      candidates.add(`https://${host}:${port}`)
    }
  }

  const lease = verifiedMappedAddress(mappingLease, now)
  if (lease) candidates.add(`https://${lease.externalAddress}:${lease.externalPort}`)
  return [...candidates]
}
