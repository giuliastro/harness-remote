import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const bridgeRoot = path.resolve(here, "..")
const repoRoot = path.resolve(bridgeRoot, "..")

function packageJson(directory) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))
}

test("root and bridge packages expose the daemon through the executable wrapper", () => {
  assert.equal(packageJson(repoRoot).bin["harness-remote-daemon"], "bridge/src/daemon-bin.js")
  assert.equal(packageJson(bridgeRoot).bin["harness-remote-daemon"], "./src/daemon-bin.js")
})

test("daemon npm bin wrapper actually executes daemon-cli", () => {
  const wrapper = path.join(bridgeRoot, "src", "daemon-bin.js")
  const result = spawnSync(process.execPath, [wrapper, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_REMOTE_BACKEND: "codex"
    }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Multi-host daemon options:/)
  assert.match(result.stdout, /--opencode-port/)
})
