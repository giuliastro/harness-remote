import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from "node:crypto"
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import selfsigned from "selfsigned"

const IDENTITY_FILE = "tls-identity.json"
const DNS_SUFFIX = ".machine.harness-remote.invalid"

export function machineTlsDnsName(machineId) {
  if (typeof machineId !== "string" || !machineId.trim()) {
    throw new TypeError("A non-empty machine ID is required")
  }
  const digest = createHash("sha256").update(machineId, "utf8").digest("hex")
  // Keep every DNS label within the 63-octet limit while retaining the full 256-bit ID.
  return `m-${digest.slice(0, 32)}.${digest.slice(32)}${DNS_SUFFIX}`
}

function identityPin(certificate) {
  return createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
}

function derElement(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error("Malformed certificate DER")
  const tag = buffer[offset]
  let length = buffer[offset + 1]
  let contentOffset = offset + 2
  if (length & 0x80) {
    const lengthBytes = length & 0x7f
    if (lengthBytes === 0 || lengthBytes > 4 || contentOffset + lengthBytes > buffer.length) {
      throw new Error("Malformed certificate DER length")
    }
    length = 0
    for (let i = 0; i < lengthBytes; i += 1) length = length * 256 + buffer[contentOffset + i]
    contentOffset += lengthBytes
  }
  const end = contentOffset + length
  if (end > buffer.length) throw new Error("Malformed certificate DER element")
  return { tag, offset, contentOffset, end }
}

function certificateSignatureAlgorithmOid(certificate) {
  const der = certificate.raw
  const certificateSequence = derElement(der, 0)
  if (certificateSequence.tag !== 0x30) throw new Error("Malformed certificate DER sequence")
  const tbs = derElement(der, certificateSequence.contentOffset)
  const algorithm = derElement(der, tbs.end)
  if (tbs.tag !== 0x30 || algorithm.tag !== 0x30) throw new Error("Malformed certificate signature algorithm")
  const oid = derElement(der, algorithm.contentOffset)
  if (oid.tag !== 0x06) throw new Error("Malformed certificate signature OID")
  return der.subarray(oid.contentOffset, oid.end).toString("hex")
}

function validateIdentity(value, machineId) {
  if (!value || value.version !== 1 || value.machineId !== machineId ||
      typeof value.privateKey !== "string" || typeof value.certificate !== "string" ||
      typeof value.dnsName !== "string" || typeof value.spkiSha256 !== "string") {
    throw new Error("Stored TLS machine identity is invalid")
  }

  let privateKey
  let certificate
  try {
    privateKey = createPrivateKey(value.privateKey)
    certificate = new X509Certificate(value.certificate)
  } catch (error) {
    throw new Error("Stored TLS machine identity is corrupt", { cause: error })
  }

  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      certificate.publicKey.asymmetricKeyType !== "ec" ||
      certificate.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Stored TLS machine identity does not use P-256")
  }
  if (!certificate.verify(certificate.publicKey) ||
      createPublicKey(privateKey).export({ type: "spki", format: "der" }).compare(
        certificate.publicKey.export({ type: "spki", format: "der" })
      ) !== 0) {
    throw new Error("Stored TLS certificate does not match its private key")
  }
  const validFrom = Date.parse(certificate.validFrom)
  const validTo = Date.parse(certificate.validTo)
  const now = Date.now()
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
    throw new Error("Stored TLS certificate is outside its validity period")
  }
  // ecdsa-with-SHA256 has OID 1.2.840.10045.4.3.2. Parse DER directly because
  // X509Certificate.signatureAlgorithm is only available starting in Node 22.10.
  if (certificateSignatureAlgorithmOid(certificate) !== "2a8648ce3d040302") {
    throw new Error("Stored TLS certificate is not signed with SHA-256")
  }

  const expectedDnsName = machineTlsDnsName(machineId)
  if (value.dnsName !== expectedDnsName || !certificate.subjectAltName?.split(/,\s*/).includes(`DNS:${expectedDnsName}`)) {
    throw new Error("Stored TLS certificate has an invalid machine DNS SAN")
  }
  const pin = identityPin(certificate)
  if (!/^[0-9a-f]{64}$/.test(value.spkiSha256) || value.spkiSha256 !== pin) {
    throw new Error("Stored TLS machine identity has an invalid SPKI pin")
  }

  return Object.freeze({
    machineId,
    dnsName: expectedDnsName,
    spkiSha256: pin,
    privateKey: value.privateKey,
    certificate: value.certificate
  })
}

async function generateIdentity(machineId) {
  const dnsName = machineTlsDnsName(machineId)
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: dnsName }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      days: 3650,
      notBeforeDate: new Date(Date.now() - 60_000),
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: dnsName }] }
      ]
    }
  )
  const certificate = new X509Certificate(pems.cert)
  return validateIdentity({
    version: 1,
    machineId,
    dnsName,
    spkiSha256: identityPin(certificate),
    privateKey: pems.private,
    certificate: pems.cert
  }, machineId)
}

/**
 * Load or create the persistent TLS identity for a machine. Existing malformed state is
 * rejected in place; it is never silently replaced with a new identity.
 */
export async function loadTlsMachineIdentity(stateDirectory, machineId) {
  const file = path.join(stateDirectory, IDENTITY_FILE)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })

  try {
    const stat = await lstat(file)
    if (!stat.isFile()) throw new Error("Stored TLS machine identity is not a regular file")
    const text = await readFile(file, "utf8")
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error("Stored TLS machine identity is corrupt JSON", { cause: error })
    }
    await chmod(file, 0o600)
    return validateIdentity(parsed, machineId)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  const generated = await generateIdentity(machineId)
  const record = {
    version: 1,
    machineId,
    dnsName: generated.dnsName,
    spkiSha256: generated.spkiSha256,
    privateKey: generated.privateKey,
    certificate: generated.certificate
  }
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  try {
    await link(temporary, file)
    await chmod(file, 0o600)
    return generated
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    let parsed
    try {
      parsed = JSON.parse(await readFile(file, "utf8"))
    } catch (readError) {
      throw new Error("Concurrent TLS identity creation left invalid state", { cause: readError })
    }
    await chmod(file, 0o600)
    return validateIdentity(parsed, machineId)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
