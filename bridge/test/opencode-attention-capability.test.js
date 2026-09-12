import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const daemonSource = fs.readFileSync(path.join(here, "../src/daemon-cli.js"), "utf8")

test("managed OpenCode advertises the native question and permission endpoints", () => {
  const registration = daemonSource.match(/daemon\.registerManagedHttpHost\(\{[\s\S]*?\n\s*\}\)/)
  assert.ok(registration, "managed OpenCode registration must remain explicit")
  assert.match(registration[0], /id: "opencode"/)
  assert.match(registration[0], /questions: true/)
  assert.match(registration[0], /permissions: true/)
})
