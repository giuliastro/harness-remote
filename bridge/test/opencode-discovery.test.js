import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { discoverOpenCodeExecutables, openCodeGeneration, readOpenCodeVersion, assertLegacyOpenCode } from "../src/opencode-discovery.js"
import { detectBackends, resolveLaunchPlan, findExecutable } from "../src/launcher.js"
import { harnessProfile, resolveAcpLaunch } from "../src/harness-profiles.js"
import { resolveManagedOpenCodeOptions } from "../src/daemon-cli.js"

function discovery(versions) {
  return {
    platform: "linux", pathValue: "/tools", access: () => {},
    exists: (command) => Object.hasOwn(versions, command.slice("/tools/".length)),
    find: (name) => Object.hasOwn(versions, name) ? `/tools/${name}` : null,
    readVersion: (command) => versions[command.slice("/tools/".length)]
  }
}

test("the shared opencode executable chooses the installed generation's transport", () => {
  const v2 = detectBackends(discovery({ opencode: "opencode v2.0.28" }))
  assert.deepEqual(v2, ["opencode2"])
  assert.equal(resolveLaunchPlan([], v2).backend, "opencode2")
  assert.deepEqual(detectBackends(discovery({ opencode: "1.19.0" })), ["opencode"])
  assert.deepEqual(detectBackends(discovery({ opencode: "unidentified CLI" })), [])
  assert.deepEqual(detectBackends(discovery({ opencode: "3.0.0" })), [])
})

test("separately named v1 and v2 executables coexist without claiming v2 twice", () => {
  const options = discovery({ opencode: "2.0.28", opencode2: "2.0.28", "opencode-legacy": "1.19.0" })
  assert.deepEqual(detectBackends(options), ["opencode2", "opencode"])
  assert.deepEqual(resolveLaunchPlan([], detectBackends(options)), {
    mode: "daemon", backend: "opencode2", detected: ["opencode2", "opencode"], openCode: true
  })
})

test("ACP prefers a verified v2 alias, supports a bare v2 opencode, and never launches v1 as v2", () => {
  const profile = harnessProfile("opencode2")
  for (const name of ["opencode2", "opencode"]) {
    assert.deepEqual(resolveAcpLaunch(profile, discovery({ [name]: "opencode v2.0.28" })), {
      command: `/tools/${name}`, args: ["acp"], source: "path"
    })
  }
  assert.equal(resolveAcpLaunch(profile, discovery({ opencode2: "1.19.0", opencode: "1.19.0" })).source, "npx")
  assert.deepEqual(resolveAcpLaunch(profile, discovery({})).args,
    ["--yes", "--package=@opencode/cli@2.0.28", "opencode2", "acp"])
})

test("an alias's name cannot override its actual generation", () => {
  assert.deepEqual(detectBackends(discovery({ opencode2: "1.19.0" })), ["opencode"])
  assert.deepEqual(discoverOpenCodeExecutables(discovery({ opencode: "broken" })), [
    { name: "opencode", command: "/tools/opencode", version: "broken", generation: null }
  ])
})

test("legacy launch rejects v2 and unknown versions with an actionable message", () => {
  assert.doesNotThrow(() => assertLegacyOpenCode("/tools/opencode1", { readVersion: () => "1.19.0" }))
  for (const version of ["opencode v2.0.28", ""]) {
    assert.throws(() => assertLegacyOpenCode("/tools/opencode", { readVersion: () => version }), /Legacy requires a v1 executable.*--backend opencode2/)
  }
})

test("version probes are bounded, ignore failures, and handle Windows npm shims", () => {
  assert.equal(openCodeGeneration("opencode v2.0.28\n"), 2)
  assert.equal(openCodeGeneration("warning: 2.0.28"), null)
  let call
  const version = readOpenCodeVersion("C:\\Tools\\opencode.cmd", { platform: "win32", environment: { ComSpec: "cmd.exe" }, run: (...args) => {
    call = args
    return { status: 0, stdout: "opencode v2.0.28\n" }
  } })
  assert.equal(version, "opencode v2.0.28")
  assert.deepEqual(call.slice(0, 2), ["cmd.exe", ["/d", "/s", "/c", "C:\\Tools\\opencode.cmd", "--version"]])
  assert.equal(call[2].timeout, 3000)
  assert.equal(readOpenCodeVersion("opencode", { run: () => ({ status: 1, stdout: "2.0.28" }) }), "")
  assert.equal(readOpenCodeVersion("opencode", { run: () => ({ error: new Error("timeout"), stdout: "2.0.28" }) }), "")
})

test("Windows discovery and ACP launch prefer the npm cmd shim over the adjacent POSIX shim", () => {
  const bare = path.join("/npm tools", "opencode")
  const shim = `${bare}.cmd`
  const options = {
    platform: "win32", pathValue: "/npm tools",
    exists: (command) => command === bare || command === shim,
    readVersion: (command) => {
      assert.equal(command, shim)
      return "opencode v2.0.28"
    }
  }
  assert.deepEqual(detectBackends(options), ["opencode2"])
  const launch = resolveAcpLaunch(harnessProfile("opencode2"), {
    ...options,
    find: (name) => findExecutable(name, options)
  })
  assert.deepEqual(launch, { command: shim, args: ["acp"], source: "path" })
})

test("a daemon with v2 only does not register a legacy HTTP host", () => {
  const parsed = { openCode: true, openCodeCommand: "opencode" }
  assert.equal(resolveManagedOpenCodeOptions(parsed, { detected: ["codex", "opencode2"] }).openCode, false)
  assert.equal(resolveManagedOpenCodeOptions(parsed, { detected: ["opencode", "opencode2"] }, { resolve: () => "/tools/opencode1" }).openCodeCommand, "/tools/opencode1")
  assert.equal(resolveManagedOpenCodeOptions({ ...parsed, openCode: false }, { detected: ["opencode"] }).openCode, false)
  assert.equal(resolveManagedOpenCodeOptions(parsed, { detected: ["opencode2"] }, { explicitCommand: true }).openCode, true)
})
