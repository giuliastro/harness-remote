import assert from "node:assert/strict"
import test from "node:test"

const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/daemon-cli.js", import.meta.url), "utf8"))

test("managed agent summary does not expose the internal OpenCode endpoint", () => {
  assert.doesNotMatch(source, /managed HTTP on 127\.0\.0\.1/)
  assert.doesNotMatch(source, /const location = host\.id === "opencode"/)
  assert.match(source, /managed \$\{host\.transport\.toUpperCase\(\)\}, \$\{host\.state\}/)
})
