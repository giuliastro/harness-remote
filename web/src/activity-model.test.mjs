import assert from "node:assert/strict"
import test from "node:test"
import {
  buildActivityTimeline, currentStep, describeTool, formatSpan, latestNote, summarizeActivity, toolKind
} from "./activity-model.ts"

const tool = (id, extra) => ({ id, type: "tool", ...extra })
const text = (id, value) => ({ id, type: "text", text: value })
const reasoning = (id, value, time = { start: 1, end: 2 }) => ({ id, type: "reasoning", text: value, time })

test("a turn regroups into notes, thinking stretches and runs of steps, in wire order", () => {
  const items = buildActivityTimeline([
    reasoning("r1", "Look at the tests."),
    reasoning("r2", "Then the build."),
    tool("t1", { tool: "bash", state: { status: "completed", input: { command: "npm test" } } }),
    tool("t2", { tool: "read", state: { status: "completed", input: { filePath: "src/a.ts" } } }),
    { id: "s", type: "step-finish" },
    text("n1", "Tests fail on Windows; checking the path handling."),
    tool("t3", { tool: "edit", state: { status: "running", input: { filePath: "src/a.ts" } } }),
    text("empty", "   ")
  ])
  assert.deepEqual(items.map((item) => item.kind), ["thought", "steps", "note", "steps"])
  assert.deepEqual(items[0].parts.map((part) => part.id), ["r1", "r2"])
  assert.deepEqual(items[1].parts.map((part) => part.id), ["t1", "t2"])
})

test("a closed reasoning chunk with no text is dropped, an open one is kept as the live thought", () => {
  assert.equal(buildActivityTimeline([reasoning("r", "", { start: 1, end: 2 })]).length, 0)
  assert.equal(buildActivityTimeline([reasoning("r", "", { start: 1 })]).length, 1)
})

test("the kind comes from ACP first, then a real tool name, then the input, and only last a title", () => {
  // Claude's shell call: the title is the command line, which mentions `cat` and `ls`.
  const shell = tool("a", { tool: "git diff | cat; ls", state: { status: "completed", title: "git diff | cat; ls", input: { command: "git diff | cat; ls" } } })
  assert.equal(toolKind(shell), "run")
  assert.equal(toolKind({ ...shell, kind: "read" }), "read")
  assert.equal(toolKind(tool("b", { tool: "Grep", state: { status: "completed" } })), "search")
  assert.equal(toolKind(tool("c", { tool: "TodoWrite", state: { status: "completed" } })), "todo")
  assert.equal(toolKind(tool("d", { tool: "mcp__fs__read_file", state: { status: "completed" } })), "read")
  assert.equal(toolKind(tool("e", { tool: "Task", kind: "think", state: { status: "completed" } })), "task")
  assert.equal(toolKind(tool("f", { tool: "Something", state: { status: "completed", title: "Something", input: { file_path: "x", old_string: "a", new_string: "b" } } })), "edit")
})

test("a call is described by what it acted on", () => {
  const run = describeTool(tool("a", { tool: "Bash", state: { status: "completed", input: { command: "npm test\nnpm run build" } } }))
  assert.equal(run.kind, "run")
  assert.equal(run.target, "npm test")
  assert.equal(run.command, "npm test\nnpm run build")

  const codex = describeTool(tool("b", { tool: "exec", state: { status: "completed", input: { command: ["git", "status"] } } }))
  assert.equal(codex.target, "git status")
  assert.equal(codex.command, "git status")

  const search = describeTool(tool("c", { tool: "grep", state: { status: "completed", input: { pattern: "TODO", path: "src" } } }))
  assert.equal(search.target, "TODO  ·  src")

  const edit = describeTool(tool("d", { tool: "Edit", state: { status: "completed", input: { file_path: "a.ts", old_string: "x", new_string: "y" } } }))
  assert.deepEqual(edit.edit, { before: "x", after: "y" })

  // No structured input: the ACP title is the description, unless it only repeats the tool name.
  assert.equal(describeTool(tool("e", { tool: "Read", state: { status: "completed", title: "Read `src/app.ts`" } })).target, "Read src/app.ts")
  assert.equal(describeTool(tool("f", { tool: "Read", state: { status: "completed", title: "Read" } })).target, "")
  // A harness with no tool name sends a sentence; it is shown as it is rather than behind a verb.
  assert.equal(describeTool(tool("g", { tool: "Run the linter", state: { status: "completed", title: "Run the linter" } })).titleOnly, true)
})

test("the summary counts steps by kind, failed ones included, and spans the turn's clock", () => {
  const summary = summarizeActivity([
    tool("a", { tool: "bash", state: { status: "completed", input: { command: "a" }, time: { start: 1_000, end: 2_000 } } }),
    tool("b", { tool: "bash", state: { status: "error", input: { command: "b" }, time: { start: 2_000, end: 9_000 } } }),
    tool("c", { tool: "read", state: { status: "completed", input: { filePath: "x" } } }),
    text("n", "note"),
    reasoning("r", "why", { start: 500, end: 900 })
  ])
  assert.deepEqual(summary.counts, { run: 2, read: 1 })
  assert.equal(summary.notes, 1)
  assert.equal(summary.durationMs, 8_500)
})

test("the live step and the latest note are read from the end of the turn", () => {
  const parts = [
    text("n1", "First."),
    tool("a", { tool: "bash", state: { status: "completed" } }),
    text("n2", "Now the build."),
    tool("b", { tool: "bash", state: { status: "running", input: { command: "npm run build" } } })
  ]
  assert.equal(currentStep(parts)?.kind, "tool")
  assert.equal(latestNote(parts)?.id, "n2")
  assert.equal(currentStep([...parts, reasoning("r", "hm", { start: 5 })])?.kind, "thinking")
  assert.equal(currentStep([tool("c", { tool: "bash", state: { status: "completed" } })]), null)
})

test("durations stay quiet below a second", () => {
  assert.equal(formatSpan(400), "")
  assert.equal(formatSpan(4_200), "4.2s")
  assert.equal(formatSpan(42_000), "42s")
  assert.equal(formatSpan(134_000), "2m 14s")
  assert.equal(formatSpan(120_000), "2m")
})
