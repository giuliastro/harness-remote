function output(result) {
  return String(result?.stdout ?? "").trim()
}

export async function inspectTaskWork(workspace, worktreeManager) {
  const status = await worktreeManager.inspect(workspace)
  const sourceHead = output(await worktreeManager.runGit(["-C", workspace.source, "rev-parse", "HEAD"]))
  let branchHead
  let branchMissing = false
  try {
    branchHead = output(await worktreeManager.runGit(["-C", workspace.source, "rev-parse", workspace.branch]))
  } catch {
    branchMissing = true
    branchHead = output(await worktreeManager.runGit(["-C", workspace.path, "rev-parse", "HEAD"]))
  }
  const counts = output(await worktreeManager.runGit([
    "-C", workspace.source, "rev-list", "--left-right", "--count", `${sourceHead}...${branchHead}`
  ])).split(/\s+/).map((value) => Number.parseInt(value, 10))
  const commitsBehind = Number.isFinite(counts[0]) ? counts[0] : 0
  const commitsAhead = Number.isFinite(counts[1]) ? counts[1] : 0

  return {
    ...status,
    branch: workspace.branch,
    branchMissing,
    source: workspace.source,
    sourceHead,
    branchHead,
    commitsAhead,
    commitsBehind,
    mergedIntoSource: commitsAhead === 0
  }
}
