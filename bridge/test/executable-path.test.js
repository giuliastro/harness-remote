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

test("Windows lists MiMo's native bin before the npm shim directory", () => {
  const home = path.join("C:\\Users", "person")
  const appData = path.join(home, "AppData", "Roaming")
  const mimo = path.join(home, ".mimocode", "bin")
  const npm = path.join(appData, "npm")
  const directories = userExecutableDirectories({
    platform: "win32",
    homeDirectory: home,
    environment: { APPDATA: appData },
    exists: (candidate) => candidate === mimo || candidate === npm
  })
  // npm leaves only `mimo.cmd`; the installer's `mimo.exe` must win when neither is on PATH.
  assert.deepEqual(directories, [mimo, npm])
})

test("Windows recovers the native OMP, Claude Code and Antigravity install directories", () => {
  const home = path.join("C:\\Users", "person")
  const localAppData = path.join(home, "AppData", "Local")
  const claude = path.join(home, ".local", "bin")
  const omp = path.join(localAppData, "omp")
  const agy = path.join(localAppData, "agy", "bin")
  const directories = userExecutableDirectories({
    platform: "win32",
    homeDirectory: home,
    environment: { LOCALAPPDATA: localAppData },
    exists: (candidate) => candidate === claude || candidate === omp || candidate === agy
  })
  // A service or GUI launch without these on PATH reported the harnesses as not installed.
  assert.deepEqual(directories, [claude, omp, agy])
})

test("PATH merging tolerates empty values and duplicate separators", () => {
  assert.equal(mergeExecutablePath("/bin", ["/tools", "/bin"], ":"), "/bin:/tools")
  assert.equal(mergeExecutablePath("", ["/bin", "/bin"], ":"), "/bin")
  assert.equal(mergeExecutablePath(undefined, [], ":"), "")
})
