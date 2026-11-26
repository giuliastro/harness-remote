import assert from "node:assert/strict"
import test from "node:test"
import { ConsoleOutputDecoder, oemDecoder } from "../src/console-output-decoder.js"

// What Italian cmd.exe writes for a missing command, in code page 850 (0x8A is "è").
const CP850_NOT_RECOGNIZED = Buffer.concat([
  Buffer.from("'mimo-missing' non ", "latin1"),
  Buffer.from([0x8a]),
  Buffer.from(" riconosciuto come comando interno o esterno,\r\n", "latin1")
])

test("cmd.exe output in the OEM code page is decoded with that code page", () => {
  const decoder = new ConsoleOutputDecoder({ codePage: 850 })
  assert.equal(
    decoder.write(CP850_NOT_RECOGNIZED),
    "'mimo-missing' non è riconosciuto come comando interno o esterno,\r\n"
  )
})

test("UTF-8 output from the adapter stays UTF-8, even split mid-character", () => {
  const decoder = new ConsoleOutputDecoder({ codePage: 850 })
  const bytes = Buffer.from("perché non è pronto — riprova\n", "utf8")
  const split = bytes.indexOf(0xa8) // inside the two bytes of "è"
  assert.equal(decoder.write(bytes.subarray(0, split)), "")
  assert.equal(decoder.write(bytes.subarray(split)), "perché non è pronto — riprova\n")
})

test("each line picks its own encoding when cmd.exe and the adapter share stderr", () => {
  const decoder = new ConsoleOutputDecoder({ codePage: 850 })
  const text = decoder.write(Buffer.concat([Buffer.from("città: ok\n", "utf8"), CP850_NOT_RECOGNIZED]))
  assert.equal(text, "città: ok\n'mimo-missing' non è riconosciuto come comando interno o esterno,\r\n")
})

test("an unterminated last line is decoded when the stream ends", () => {
  const decoder = new ConsoleOutputDecoder({ codePage: 850 })
  assert.equal(decoder.write(Buffer.from([0x8a])), "")
  assert.equal(decoder.end(), "è")
  assert.equal(decoder.end(), "")
})

test("the code page is looked up only once a line is not UTF-8", () => {
  let lookups = 0
  const decoder = new ConsoleOutputDecoder({ codePage: () => (lookups += 1, 850) })
  decoder.write(Buffer.from("plain ascii\n"))
  assert.equal(lookups, 0)
  decoder.write(CP850_NOT_RECOGNIZED)
  decoder.write(CP850_NOT_RECOGNIZED)
  assert.equal(lookups, 1)
})

test("an unknown code page keeps the old UTF-8 replacement behaviour", () => {
  const decoder = new ConsoleOutputDecoder({ codePage: () => null })
  assert.equal(decoder.write(Buffer.from([0x8a, 0x0a])), "�\n")
})

test("OEM tables cover all 128 upper-half bytes", () => {
  for (const codePage of [437, 850, 852, 858]) {
    const decode = oemDecoder(codePage)
    const text = decode(Buffer.from(Array.from({ length: 128 }, (_, index) => 0x80 + index)))
    assert.equal(text.length, 128, `code page ${codePage}`)
    assert.ok(!text.includes("undefined"), `code page ${codePage}`)
  }
  assert.equal(oemDecoder(858)(Buffer.from([0xd5])), "€")
  assert.equal(oemDecoder(850)(Buffer.from([0xd5])), "ı")
  assert.equal(oemDecoder(852)(Buffer.from([0xf1, 0xf2, 0xf3, 0xf4, 0xf5])), "˝˛ˇ˘§")
  assert.equal(oemDecoder(866)(Buffer.from([0x8f])), "П")
  assert.equal(oemDecoder(12345), undefined)
})
