import { createHash } from "node:crypto"
import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"

function projectID(machineID, projectPath) {
  const digest = createHash("sha256").update(`${machineID}\0${projectPath}`).digest("hex").slice(0, 16)
  return `${machineID}:${digest}`
}

async function isGitProject(directory) {
  try {
    await stat(path.join(directory, ".git"))
    return true
  } catch {
    return false
  }
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function discoverProjects({ machineID, roots }) {
  const projects = new Map()
  for (const configuredRoot of roots) {
    let root
    try {
      root = await realpath(configuredRoot)
    } catch {
      continue
    }

    const add = async (candidate, configured = false) => {
      const resolved = await realpath(candidate)
      if (!configured && !insideRoot(root, resolved)) return
      if (projects.has(resolved)) return
      const git = await isGitProject(resolved)
      if (!configured && !git) return
      projects.set(resolved, {
        id: projectID(machineID, resolved),
        machineId: machineID,
        name: path.basename(resolved) || resolved,
        path: resolved,
        kind: git ? "git" : "directory",
        configured
      })
    }

    await add(root, true)
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        await add(path.join(root, entry.name), false)
      } catch {
        // A disappearing or unreadable child should not make the catalog unavailable.
      }
    }
  }
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
}
