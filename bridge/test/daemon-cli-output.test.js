import assert from "node:assert/strict"
import test from "node:test"

const { readFile } = await import("node:fs/promises")
const daemonSource = await readFile(new URL("../src/daemon-cli.js", import.meta.url), "utf8")
const bridgeSource = await readFile(new URL("../src/cli.js", import.meta.url), "utf8")

test("launcher-owned daemon emits one concise ready line instead of repeating machine and agent details", () => {
  assert.match(daemonSource, /HARNESS_REMOTE_LAUNCHED_BY_LAUNCHER === "1"/)
  assert.match(daemonSource, /Harness Remote is ready\. Keep this terminal open while you use it\./)
  assert.match(daemonSource, /else \{[\s\S]*Harness daemon ready at http:\/\/\$\{config\.host\}:\$\{config\.port\}[\s\S]*Active agents:/)
})

test("launcher-owned standalone ACP bridge suppresses its duplicate listening URL and machine id", () => {
  assert.match(bridgeSource, /HARNESS_REMOTE_LAUNCHED_BY_LAUNCHER === "1"/)
  assert.match(bridgeSource, /Harness Remote is ready\. Keep this terminal open while you use it\./)
  assert.match(bridgeSource, /else|return/)
  assert.match(bridgeSource, /bridge listening on http:\/\/\$\{config\.host\}:\$\{config\.port\}/)
})

test("direct daemon diagnostics do not expose the internal managed OpenCode endpoint", () => {
  assert.doesNotMatch(daemonSource, /managed HTTP on 127\.0\.0\.1/)
  assert.doesNotMatch(daemonSource, /const location = host\.id === "opencode"/)
  assert.match(daemonSource, /managed \$\{host\.transport\.toUpperCase\(\)\}, \$\{host\.state\}/)
})

test("daemon registers managed OpenCode for first-use startup instead of boot startup", () => {
  const registration = daemonSource.match(/daemon\.registerManagedHttpHost\(\{[\s\S]*?\n\s*\}\)/)
  assert.ok(registration, "OpenCode managed host registration should remain explicit")
  assert.match(registration[0], /id: "opencode"/)
  assert.match(registration[0], /eager: false/)
})

test("managed OpenCode stderr is visibly attributed by the daemon", () => {
  assert.match(daemonSource, /managedOpenCode\.on\("stderr", \(line\) => writeHarnessLog\("opencode", line\)\)/)
})

test("harness stderr goes through the verbose-aware writer", () => {
  assert.match(daemonSource, /createHarnessLogWriter\(\{ verbose: config\.verbose \}\)/)
  assert.match(daemonSource, /acp\.on\("stderr", \(line\) => writeHarnessLog\(provider\.id, line\)\)/)
  assert.match(bridgeSource, /createHarnessLogWriter\(\{ verbose: config\.verbose \}\)/)
  assert.match(bridgeSource, /if \(config\.verbose\) \{[\s\S]*granted tool permission[\s\S]*handled agent request/)
})
