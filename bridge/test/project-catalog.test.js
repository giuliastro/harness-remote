import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { discoverProjects } from "../src/project-catalog.js"

test("discovers configured roots and immediate Git projects without recursive scanning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-projects-"))
  try {
    const gitProject = path.join(root, "alpha")
    const plainDirectory = path.join(root, "notes")
    const nestedGit = path.join(plainDirectory, "nested")
    await mkdir(path.join(gitProject, ".git"), { recursive: true })
    await mkdir(path.join(nestedGit, ".git"), { recursive: true })
    await writeFile(path.join(root, "README.txt"), "root")

    const projects = await discoverProjects({ machineID: "machine-1", roots: [root] })
    assert.deepEqual(projects.map((project) => ({ name: project.name, kind: project.kind, configured: project.configured })), [
      { name: "alpha", kind: "git", configured: false },
      { name: path.basename(root), kind: "directory", configured: true }
    ])
    assert.ok(projects.every((project) => project.machineId === "machine-1"))
    assert.ok(projects.every((project) => project.id.startsWith("machine-1:")))
    assert.equal(projects.some((project) => project.path === nestedGit), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("project ids remain stable for the same machine and canonical path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-id-"))
  try {
    const first = await discoverProjects({ machineID: "machine-1", roots: [root] })
    const second = await discoverProjects({ machineID: "machine-1", roots: [root] })
    const otherMachine = await discoverProjects({ machineID: "machine-2", roots: [root] })
    assert.equal(first[0].id, second[0].id)
    assert.notEqual(first[0].id, otherMachine[0].id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an unreadable or missing configured root does not hide valid roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-roots-"))
  try {
    const projects = await discoverProjects({ machineID: "machine-1", roots: [path.join(root, "missing"), root] })
    assert.equal(projects.length, 1)
    assert.equal(projects[0].path, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("symlinked children cannot escape the configured root boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-boundary-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "harness-project-outside-"))
  try {
    await mkdir(path.join(outside, ".git"), { recursive: true })
    await symlink(outside, path.join(root, "external"), "dir")
    const projects = await discoverProjects({ machineID: "machine-1", roots: [root] })
    assert.equal(projects.some((project) => project.path === outside), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
