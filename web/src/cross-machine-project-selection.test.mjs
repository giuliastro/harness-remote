import assert from "node:assert/strict"
import test from "node:test"
import { reconcileCrossMachineProjectSelection } from "./cross-machine-project-selection.ts"

const projects = [
  { id: "project-a", machineID: "machine-target", name: "Project A", kind: "git", configured: true },
  { id: "project-b", machineID: "machine-target", name: "Project B", kind: "git", configured: true }
]

test("same-machine Project catalog refresh preserves an explicit valid selection", () => {
  assert.equal(reconcileCrossMachineProjectSelection("project-b", projects, true), "project-b")
})

test("same-machine Project catalog refresh drops a selection that disappeared", () => {
  assert.equal(reconcileCrossMachineProjectSelection("missing", projects, true), "")
})

test("machine switch never carries a machine-local Project id to the new target", () => {
  assert.equal(reconcileCrossMachineProjectSelection("project-b", projects, false), "")
})

test("single-Project targets keep the existing automatic selection behavior", () => {
  assert.equal(reconcileCrossMachineProjectSelection("", [projects[0]], false), "project-a")
  assert.equal(reconcileCrossMachineProjectSelection("missing", [projects[0]], true), "project-a")
})
