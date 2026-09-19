import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const rootURL = new URL("../../package.json", import.meta.url)
const webURL = new URL("../../web/package.json", import.meta.url)

async function readJSON(url) {
  return JSON.parse(await readFile(url, "utf8"))
}

test("root npm package stays publishable and version-aligned", async () => {
  const [root, web] = await Promise.all([readJSON(rootURL), readJSON(webURL)])

  assert.equal(root.name, "harness-remote")
  assert.equal(root.version, web.version, "npm CLI version must match the shipped app version")
  assert.notEqual(root.private, true, "root CLI package must remain publishable")
  assert.equal(root.type, "module")
  assert.equal(root.bin?.["harness-remote"], "bridge/src/launcher.js")
  assert.equal(root.bin?.["harness-remote-daemon"], "bridge/src/daemon-bin.js")
  assert.equal(root.publishConfig?.access, "public")
  assert.ok(root.files?.includes("bridge/src"), "published package must include the runtime")
  assert.equal(root.dependencies?.["qrcode-terminal"], "0.12.0")
})
