import assert from "node:assert/strict"
import test from "node:test"

const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/daemon-cli.js", import.meta.url), "utf8"))

test("managed agent summary does not expose the internal OpenCode endpoint", () => {
  assert.doesNotMatch(source, /managed HTTP on 127\.0\.0\.1/)
  assert.doesNotMatch(source, /const location = host\.id === "opencode"/)
  assert.match(source, /managed \$\{host\.transport\.toUpperCase\(\)\}, \$\{host\.state\}/)
})

test("daemon registers managed OpenCode for first-use startup instead of boot startup", () => {
  const registration = source.match(/daemon\.registerManagedHttpHost\(\{[\s\S]*?\n\s*\}\)/)
  assert.ok(registration, "OpenCode managed host registration should remain explicit")
  assert.match(registration[0], /id: "opencode"/)
  assert.match(registration[0], /eager: false/)
})

test("managed OpenCode stderr is visibly attributed by the daemon", () => {
  assert.match(source, /managedOpenCode\.on\("stderr", \(line\) => process\.stderr\.write\(`\[opencode\] \$\{line\}\\n`\)\)/)
})
