import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const { effectiveProjectRoots, ProjectRootsError, ProjectRootsStore, validateProjectRoots } = await import("../dist-electron/electron/project-roots.js")

test("project folders persist, reload, canonicalize, and reject paths outside the native directory picker contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-project-roots-"))
  const foldersFile = join(root, "user-data", "desktop-project-roots.json")
  const folderA = join(root, "projects-a")
  const folderB = join(root, "projects-b")
  await mkdir(folderA)
  await mkdir(folderB)
  const canonicalRoots = await Promise.all([realpath(folderA), realpath(folderB)])
  try {
    const store = new ProjectRootsStore(foldersFile)
    await store.load()
    assert.deepEqual(store.get(), [])
    assert.deepEqual(await store.replace([folderA, folderB, folderA]), canonicalRoots)
    assert.deepEqual(JSON.parse(await readFile(foldersFile, "utf8")), canonicalRoots)

    const reloaded = new ProjectRootsStore(foldersFile)
    await reloaded.load()
    assert.deepEqual(reloaded.get(), canonicalRoots)
    await assert.rejects(validateProjectRoots([join(root, "missing")]), ProjectRootsError)
    await assert.rejects(validateProjectRoots(["relative/path"]), ProjectRootsError)
    const regularFile = join(root, "not-a-folder")
    await writeFile(regularFile, "test")
    await assert.rejects(validateProjectRoots([regularFile]), ProjectRootsError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("environment root takes precedence and an empty setting falls back to home", () => {
  assert.deepEqual(effectiveProjectRoots(["/configured"], "/environment", "/home/user"), ["/environment"])
  assert.deepEqual(effectiveProjectRoots([], undefined, "/home/user"), ["/home/user"])
  assert.deepEqual(effectiveProjectRoots(["/configured"], undefined, "/home/user"), ["/configured"])
  assert.deepEqual(effectiveProjectRoots(["/configured"], "/folder with space ", "/home/user"), ["/folder with space "])
})

test("project folder IPC is wired through a trusted main-process handler and native directory chooser", async () => {
  const { IPC_CHANNELS } = await import("../dist-electron/electron/ipc-contract.js")
  const mainSource = await readFile(new URL("./main.ts", import.meta.url), "utf8")
  assert.equal(IPC_CHANNELS.getProjectRoots, "desktop:project-roots:get")
  assert.equal(IPC_CHANNELS.chooseProjectFolder, "desktop:project-roots:choose")
  assert.equal(IPC_CHANNELS.setProjectRoots, "desktop:project-roots:set")
  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.getProjectRoots/)
  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.chooseProjectFolder/)
  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.setProjectRoots/)
  assert.match(mainSource, /ensureTrustedSender\(event\)/)
  assert.match(mainSource, /dialog\.showOpenDialog\(mainWindow/)
  assert.match(mainSource, /dialog\.showMessageBox\(mainWindow/)
})
