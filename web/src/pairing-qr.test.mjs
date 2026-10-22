import assert from "node:assert/strict"
import test from "node:test"
import jsQR from "jsqr"
import { pairingQRCode, pairingQRPath } from "./pairing-qr.ts"

const SCALE = 8

function pairingURI(endpoint = "http://192.168.1.44:4097", token = "a".repeat(43)) {
  return `harnessremote://pair?endpoint=${encodeURIComponent(endpoint)}&token=${token}&expires=1790000000000`
}

/** Rasterize the module matrix into the RGBA buffer shape a real QR reader consumes. */
function rasterize(code, scale = SCALE) {
  const side = code.size * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if (!code.modules[y][x]) continue
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const offset = ((y * scale + dy) * side + (x * scale + dx)) * 4
          data[offset] = 0
          data[offset + 1] = 0
          data[offset + 2] = 0
        }
      }
    }
  }
  return { data, side }
}

test("the pairing QR decodes back to the exact URI the phone must scan", () => {
  const uri = pairingURI()
  const code = pairingQRCode(uri)
  assert.ok(code, "a pairing URI always renders")
  const { data, side } = rasterize(code)
  const decoded = jsQR(data, side, side)
  assert.ok(decoded, "the rendered code is readable by a QR reader")
  assert.equal(decoded.data, uri)
})

test("a longer LAN endpoint stays readable, so address picking cannot silently break the code", () => {
  const uri = pairingURI("http://192.168.100.240:65535", "Z".repeat(43))
  const code = pairingQRCode(uri)
  assert.ok(code)
  const { data, side } = rasterize(code)
  assert.equal(jsQR(data, side, side)?.data, uri)
})

test("rendering is deterministic and different URIs produce different codes", () => {
  const first = pairingQRCode(pairingURI())
  const repeat = pairingQRCode(pairingURI())
  const other = pairingQRCode(pairingURI("http://192.168.1.45:4097"))
  assert.deepEqual(first, repeat)
  assert.notEqual(first.path, other.path)
})

test("the quiet zone is preserved so camera readers can find the code", () => {
  const code = pairingQRCode(pairingURI())
  assert.ok(code)
  for (let index = 0; index < code.size; index += 1) {
    assert.equal(code.modules[0][index], false, "top border row is white")
    assert.equal(code.modules[code.size - 1][index], false, "bottom border row is white")
    assert.equal(code.modules[index][0], false, "left border column is white")
    assert.equal(code.modules[index][code.size - 1], false, "right border column is white")
  }
})

test("unusable input is rejected instead of drawing a broken code", () => {
  assert.equal(pairingQRCode(""), null)
  assert.equal(pairingQRCode(undefined), null)
  assert.equal(pairingQRCode(null), null)
  assert.equal(pairingQRPath([]), "")
  assert.equal(pairingQRPath([[false, false]]), "")
  assert.equal(pairingQRPath([[true]]), "M0 0h1v1h-1Z")
})
