import assert from "node:assert/strict"
import test from "node:test"
import {
  requireTargetRouteProject,
  resolveSourceSessionProject,
  targetRouteProjects
} from "./cross-machine-route-projects.ts"

function project(id, machineId, name, path, overrides = {}) {
  return { id, machineId, name, path, kind: "git", configured: true, ...overrides }
}

test("source Project resolution stays machine-local and picks the deepest containing root", () => {
  const projects = [
    project("wrong-machine", "machine-b", "Wrong", "/work/repo"),
    project("parent", "machine-a", "Parent", "/work"),
    project("repo", "machine-a", "Repo", "/work/repo")
  ]
  const resolved = resolveSourceSessionProject({ machineID: "machine-a", directory: "/work/repo/packages/web" }, projects)
  assert.equal(resolved?.id, "repo")
  assert.equal(resolved?.machineID, "machine-a")
  assert.equal("path" in resolved, false, "route metadata must not expose filesystem paths")
})

test("Windows source paths use drive-local case-insensitive containment", () => {
  const resolved = resolveSourceSessionProject(
    { machineID: "machine-a", directory: "C:\\Work\\Repo\\packages\\web\\" },
    [project("repo", "machine-a", "Repo", "c:/work/repo")]
  )
  assert.equal(resolved?.id, "repo")
})

test("POSIX source paths remain case-sensitive and boundary-aware", () => {
  const projects = [project("repo", "machine-a", "Repo", "/work/repo")]
  assert.equal(resolveSourceSessionProject({ machineID: "machine-a", directory: "/Work/Repo" }, projects), null)
  assert.equal(resolveSourceSessionProject({ machineID: "machine-a", directory: "/work/repository" }, projects), null)
})

test("target catalog exposes only identities owned by the selected target machine", () => {
  const routed = targetRouteProjects("machine-b", [
    project("z", "machine-b", "Zulu", "/secret/z"),
    project("a", "machine-a", "Alpha source", "/secret/a"),
    project("b", "machine-b", "Beta", "/secret/b")
  ])
  assert.deepEqual(routed.map((entry) => entry.id), ["b", "z"])
  assert.ok(routed.every((entry) => entry.machineID === "machine-b"))
  assert.ok(routed.every((entry) => !("path" in entry)), "cross-machine route choices must not carry target paths")
})

test("target Project validation fails closed if the catalog changed", () => {
  const projects = targetRouteProjects("machine-b", [project("repo", "machine-b", "Repo", "/repo")])
  assert.equal(requireTargetRouteProject("machine-b", "repo", projects).id, "repo")
  assert.throws(
    () => requireTargetRouteProject("machine-b", "missing", projects),
    /no longer available/
  )
  assert.throws(
    () => requireTargetRouteProject("machine-a", "repo", projects),
    /no longer available/
  )
})
