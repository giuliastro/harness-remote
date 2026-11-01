import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { findPiExecutable } from "../src/executable-discovery.js"
import { detectBackends } from "../src/launcher.js"

test("PI discovery prefers PATH and accepts an explicit executable", () => {
  const onPath = path.join("/tools", "pi")
  const explicit = path.join("/custom", "pi")
  const exists = (value) => value === explicit || value === onPath
  assert.equal(findPiExecutable({ pathValue: "/tools", exists, access() {} }), onPath)
  assert.equal(findPiExecutable({ piPath: explicit, pathValue: "/tools", exists, access() {} }), explicit)
  assert.equal(findPiExecutable({ pathValue: "", piAgentDirectory: "/missing", exists: () => false }), null)
})

test("PI discovery falls back to the installer's user-agent directory", () => {
  const home = path.join("/home", "person")
  const expected = path.join(home, ".pi", "agent", "bin", "pi")
  const options = {
    platform: "linux",
    pathValue: "",
    homeDirectory: home,
    exists: (value) => value === expected,
    access() {}
  }
  assert.equal(findPiExecutable(options), expected)
  assert.deepEqual(detectBackends(options), ["pi"], "an installed PI must remain visible when the shell PATH predates its installer")
})

test("PI discovery uses the Windows launcher in the same fallback directory", () => {
  const home = path.join("C:\\Users", "person")
  const expected = path.join(home, ".pi", "agent", "bin", "pi.cmd")
  const options = {
    platform: "win32",
    pathValue: "",
    homeDirectory: home,
    exists: (value) => value === expected,
    access() {}
  }
  assert.equal(findPiExecutable(options), expected)
  assert.deepEqual(detectBackends(options), ["pi"])
})
