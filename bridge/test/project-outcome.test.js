import assert from "node:assert/strict"
import test from "node:test"
import {
  inspectGitProjectOutcome,
  MAX_PROJECT_OUTCOME_FILES,
  parseGitNumstatZ,
  parseGitPorcelainV1Z
} from "../src/project-outcome.js"

function gitFixture(statusOutput, diffOutput = "") {
  return async (args) => {
    const command = args.slice(2).join(" ")
    if (command === "rev-parse --show-toplevel") return { stdout: "/repo\n" }
    if (command === "rev-parse HEAD") return { stdout: "deadbeef\n" }
    if (command === "branch --show-current") return { stdout: "feature/outcome\n" }
    if (command === "status --porcelain=v1 -z --untracked-files=all") return { stdout: statusOutput }
    if (command === "diff --numstat -z --no-renames HEAD --") return { stdout: diffOutput }
    throw new Error(`Unexpected git command: ${command}`)
  }
}

test("porcelain -z parses modified, untracked and rename entries without shell quoting", () => {
  const parsed = parseGitPorcelainV1Z(
    " M src/app.js\0?? docs/new notes.md\0R  src/new-name.js\0src/old-name.js\0"
  )

  assert.deepEqual(parsed, {
    files: [
      { path: "src/app.js", indexStatus: " ", worktreeStatus: "M" },
      { path: "docs/new notes.md", indexStatus: "?", worktreeStatus: "?" },
      { path: "src/new-name.js", indexStatus: "R", worktreeStatus: " ", originalPath: "src/old-name.js" }
    ],
    totalFiles: 3,
    truncated: false
  })
})

test("numstat summary counts tracked text and binary changes without retaining paths or hunks", () => {
  const parsed = parseGitNumstatZ(
    "12\t4\tsrc/app.js\0-\t-\tassets/logo.png\00\t7\tdeleted.txt\0"
  )

  assert.deepEqual(parsed, {
    trackedFiles: 3,
    insertions: 12,
    deletions: 11,
    binaryFiles: 1
  })
  const serialized = JSON.stringify(parsed)
  assert.equal(serialized.includes("src/app.js"), false)
  assert.equal(serialized.includes("assets/logo.png"), false)
})

test("malformed numstat records are ignored instead of fabricating diff evidence", () => {
  assert.deepEqual(parseGitNumstatZ("oops\01\tx\tfile\0-\t2\todd\0"), {
    trackedFiles: 0,
    insertions: 0,
    deletions: 0,
    binaryFiles: 0
  })
})

test("outcome is bounded while preserving the total changed-file count", async () => {
  const status = Array.from({ length: MAX_PROJECT_OUTCOME_FILES + 7 }, (_, index) => ` M src/file-${index}.js\0`).join("")
  const outcome = await inspectGitProjectOutcome("/repo", { runGit: gitFixture(status) })

  assert.equal(outcome.dirty, true)
  assert.equal(outcome.files.length, MAX_PROJECT_OUTCOME_FILES)
  assert.equal(outcome.totalChangedFiles, MAX_PROJECT_OUTCOME_FILES + 7)
  assert.equal(outcome.filesTruncated, true)
})

test("snapshot returns only bounded metadata and aggregate diff statistics", async () => {
  const outcome = await inspectGitProjectOutcome("/repo", {
    runGit: gitFixture(
      "M  src/index.js\0?? test/new.test.js\0",
      "18\t5\tsrc/index.js\0"
    )
  })

  assert.deepEqual(outcome, {
    version: 1,
    vcs: "git",
    head: "deadbeef",
    branch: "feature/outcome",
    dirty: true,
    files: [
      { path: "src/index.js", indexStatus: "M", worktreeStatus: " " },
      { path: "test/new.test.js", indexStatus: "?", worktreeStatus: "?" }
    ],
    totalChangedFiles: 2,
    filesTruncated: false,
    diffSummary: {
      trackedFiles: 1,
      insertions: 18,
      deletions: 5,
      binaryFiles: 0
    }
  })
  const wire = JSON.stringify(outcome)
  assert.equal(wire.includes("/repo"), false)
  assert.equal(wire.includes("@@"), false, "diff hunks must never cross the outcome boundary")
  assert.equal(wire.includes("18\t5"), false, "raw git output must never cross the outcome boundary")
})

test("escaping, absolute and oversized paths are never exposed but still keep the worktree dirty", async () => {
  const huge = "x".repeat(1100)
  const status = ` M ../outside.js\0 M /etc/passwd\0 M C:\\secret.txt\0 M ${huge}\0 M safe/file.js\0`
  const parsed = parseGitPorcelainV1Z(status)

  assert.deepEqual(parsed, {
    files: [{ path: "safe/file.js", indexStatus: " ", worktreeStatus: "M" }],
    totalFiles: 5,
    truncated: true
  })

  const hiddenOnly = await inspectGitProjectOutcome("/repo", { runGit: gitFixture(" M ../outside.js\0") })
  assert.equal(hiddenOnly.dirty, true, "a hidden changed path must never make a dirty worktree look clean")
  assert.equal(hiddenOnly.totalChangedFiles, 1)
  assert.deepEqual(hiddenOnly.files, [])
  assert.equal(hiddenOnly.filesTruncated, true)
})

test("missing status or diff evidence stays unverified instead of being invented", async () => {
  const outcome = await inspectGitProjectOutcome("/repo", {
    runGit: async (args) => {
      const command = args.slice(2).join(" ")
      if (command === "rev-parse --show-toplevel") return { stdout: "/repo\n" }
      if (command === "rev-parse HEAD") return { stdout: "abc123\n" }
      if (command === "branch --show-current") return { stdout: "main\n" }
      throw new Error("status unavailable")
    }
  })

  assert.deepEqual(outcome, { version: 1, vcs: "git", head: "abc123", branch: "main" })
})

test("a path that is no longer a Git worktree has no outcome", async () => {
  const outcome = await inspectGitProjectOutcome("/gone", {
    runGit: async () => { throw new Error("not a git repository") }
  })
  assert.equal(outcome, null)
})
