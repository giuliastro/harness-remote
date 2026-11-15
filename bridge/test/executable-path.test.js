import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { ensureRuntimeExecutablePath, mergeExecutablePath, userExecutableDirectories } from "../src/executable-path.js"

test("user installer directories are appended only when they exist", () => {
  const home = path.join("/home", "person")
  const existing = new Set([
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin")
  ])
  const directories = userExecutableDirectories({
    platform: "linux",
    homeDirectory: home,
    environment: {},
    exists: (candidate) => existing.has(candidate)
  })
  assert.deepEqual(directories, [
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin")
  ])
})

test("runtime PATH keeps the inherited order and gains missing user bins once", () => {
  const home = path.join("/home", "person")
  const localBin = path.join(home, ".local", "bin")
  const environment = { PATH: `/usr/local/bin:/usr/bin:${localBin}`, HOME: home }
  ensureRuntimeExecutablePath({
    environment,
    platform: "linux",
    delimiter: ":",
    exists: (candidate) => candidate === localBin || candidate === path.join(home, ".opencode", "bin")
  })
  assert.equal(
    environment.PATH,
    `/usr/local/bin:/usr/bin:${localBin}:${path.join(home, ".opencode", "bin")}`,
    "a directory already on PATH must not be duplicated"
  )
})

test("Windows npm installs are discoverable from APPDATA and LOCALAPPDATA", () => {
  const appData = path.join("C:\\Users", "person", "AppData", "Roaming")
  const localAppData = path.join("C:\\Users", "person", "AppData", "Local")
  const npm = path.join(appData, "npm")
  const node = path.join(localAppData, "Programs", "nodejs")
  const environment = { Path: "C:\\Windows\\System32", APPDATA: appData, LOCALAPPDATA: localAppData }
  ensureRuntimeExecutablePath({
    environment,
    platform: "win32",
    delimiter: ";",
    homeDirectory: path.join("C:\\Users", "person"),
    exists: (candidate) => candidate === npm || candidate === node
  })
  assert.equal(environment.PATH, undefined)
  assert.equal(environment.Path, `C:\\Windows\\System32;${npm};${node}`)
})

test("PATH merging tolerates empty values and duplicate separators", () => {
  assert.equal(mergeExecutablePath("/bin", ["/tools", "/bin"], ":"), "/bin:/tools")
  assert.equal(mergeExecutablePath("", ["/bin", "/bin"], ":"), "/bin")
  assert.equal(mergeExecutablePath(undefined, [], ":"), "")
})
