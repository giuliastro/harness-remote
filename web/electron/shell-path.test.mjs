import assert from "node:assert/strict"
import test from "node:test"

const {
  mergeExecutablePath,
  parseLoginShellPathOutput,
  resolveDesktopRuntimeEnvironment
} = await import("../dist-electron/electron/shell-path.js")

test("extracts only the delimited PATH from noisy shell startup output", () => {
  const output = [
    "welcome from shell startup",
    "__HARNESS_REMOTE_PATH_START__/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin__HARNESS_REMOTE_PATH_END__",
    "trailing shell output"
  ].join("\n")
  assert.equal(
    parseLoginShellPathOutput(output),
    "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin"
  )
  assert.equal(parseLoginShellPathOutput("PATH=/untrusted/no-marker"), undefined)
  assert.equal(parseLoginShellPathOutput("__HARNESS_REMOTE_PATH_START__/bin\n/evil__HARNESS_REMOTE_PATH_END__"), undefined)
})

test("merges shell PATH first without losing inherited executable directories", () => {
  assert.equal(
    mergeExecutablePath("/opt/homebrew/bin:/usr/local/bin:/usr/bin", "/usr/bin:/bin", ":"),
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  )
  assert.equal(mergeExecutablePath(undefined, "/usr/bin:/bin", ":"), "/usr/bin:/bin")
  assert.equal(mergeExecutablePath("/opt/bin;;/usr/bin", "/usr/bin;;/bin", ";"), "/opt/bin;/usr/bin;/bin")
})

test("desktop runtime imports only the discovered PATH and preserves the inherited environment", async () => {
  const inherited = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/example",
    HARNESS_REMOTE_TEST_SECRET: "keep-me"
  }
  let readerEnvironment
  const resolved = await resolveDesktopRuntimeEnvironment(inherited, {
    platform: "darwin",
    delimiter: ":",
    readShellPath: async (environment) => {
      readerEnvironment = environment
      return "/opt/homebrew/bin:/usr/bin"
    }
  })

  assert.equal(readerEnvironment, inherited)
  assert.deepEqual(resolved, {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    HOME: "/Users/example",
    HARNESS_REMOTE_TEST_SECRET: "keep-me"
  })
})

test("shell discovery failure falls back to the inherited environment", async () => {
  const inherited = { PATH: "/usr/bin:/bin", HOME: "/home/example" }
  const resolved = await resolveDesktopRuntimeEnvironment(inherited, {
    platform: "linux",
    delimiter: ":",
    readShellPath: async () => { throw new Error("shell startup failed") }
  })
  assert.deepEqual(resolved, inherited)
  assert.notEqual(resolved, inherited, "the caller receives an isolated environment object")
})

test("Windows keeps its native process environment and never starts shell discovery", async () => {
  const inherited = { Path: "C:\\Windows\\System32", HOME: "C:\\Users\\example" }
  let called = false
  const resolved = await resolveDesktopRuntimeEnvironment(inherited, {
    platform: "win32",
    delimiter: ";",
    readShellPath: async () => {
      called = true
      return "C:\\tools"
    }
  })
  assert.equal(called, false)
  assert.deepEqual(resolved, inherited)
})
