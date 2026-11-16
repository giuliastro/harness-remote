import assert from "node:assert/strict"
import { createServer as createTlsServer, connect as connectTls } from "node:tls"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { X509Certificate, createPrivateKey, createPublicKey, createHash } from "node:crypto"
import { loadTlsMachineIdentity, machineTlsDnsName } from "./tls-machine-identity.js"

function certificateSignatureAlgorithmOid(certificate) {
  const der = certificate.raw
  const element = (offset) => {
    const tag = der[offset]
    let length = der[offset + 1]
    let contentOffset = offset + 2
    if (length & 0x80) {
      const lengthBytes = length & 0x7f
      length = 0
      for (let i = 0; i < lengthBytes; i += 1) length = length * 256 + der[contentOffset + i]
      contentOffset += lengthBytes
    }
    return { tag, contentOffset, end: contentOffset + length }
  }
  const outer = element(0)
  const tbs = element(outer.contentOffset)
  const algorithm = element(tbs.end)
  const oid = element(algorithm.contentOffset)
  return der.subarray(oid.contentOffset, oid.end).toString("hex")
}

async function withStateDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-tls-identity-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("TLS machine identity persists, validates its key and certificate, and pins SPKI", async () => {
  await withStateDirectory(async (directory) => {
    const first = await loadTlsMachineIdentity(directory, "machine_test-id")
    const again = await loadTlsMachineIdentity(directory, "machine_test-id")
    const x509 = new X509Certificate(first.certificate)
    const key = createPrivateKey(first.privateKey)
    const keyPublic = createPublicKey(key).export({ type: "spki", format: "der" })
    const certPublic = x509.publicKey.export({ type: "spki", format: "der" })
    const expectedPin = createHash("sha256").update(certPublic).digest("hex")
    const metadata = await stat(path.join(directory, "tls-identity.json"))

    assert.equal(again.spkiSha256, first.spkiSha256)
    assert.equal(again.certificate, first.certificate)
    assert.equal(again.privateKey, first.privateKey)
    assert.equal(first.dnsName, machineTlsDnsName("machine_test-id"))
    assert.equal(x509.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1")
    assert.equal(certificateSignatureAlgorithmOid(x509), "2a8648ce3d040302")
    assert.equal(x509.subjectAltName, `DNS:${first.dnsName}`)
    assert.equal(keyPublic.compare(certPublic), 0)
    assert.match(first.spkiSha256, /^[0-9a-f]{64}$/)
    assert.equal(first.spkiSha256, expectedPin)
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600)
  })
})

test("TLS identity performs a trusted localhost handshake using its stable DNS SAN", async () => {
  await withStateDirectory(async (directory) => {
    const identity = await loadTlsMachineIdentity(directory, "machine_tls-handshake")
    const server = createTlsServer({ key: identity.privateKey, cert: identity.certificate }, (socket) => {
      socket.end("handshake-ok")
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const port = server.address().port
      const response = await new Promise((resolve, reject) => {
        const socket = connectTls({
          host: "127.0.0.1",
          port,
          ca: identity.certificate,
          servername: identity.dnsName
        }, () => {
          let data = ""
          socket.setEncoding("utf8")
          socket.on("data", (chunk) => { data += chunk })
          socket.on("end", () => resolve(data))
        })
        socket.once("error", reject)
      })
      assert.equal(response, "handshake-ok")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test("corrupt TLS identity fails closed and is not regenerated", async () => {
  await withStateDirectory(async (directory) => {
    const file = path.join(directory, "tls-identity.json")
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "{broken", { mode: 0o600 }))
    await assert.rejects(loadTlsMachineIdentity(directory, "machine_corrupt"), /corrupt JSON/)
    assert.equal(await readFile(file, "utf8"), "{broken")
  })
})
