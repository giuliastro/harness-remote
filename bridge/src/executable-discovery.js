import fs from "node:fs"
import path from "node:path"

function executableNames(name, platform = process.platform) {
  if (platform !== "win32") return [name]
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  return [name, ...extensions.map((extension) => `${name}${extension}`)]
}

function executable(candidate, { platform = process.platform, exists = fs.existsSync, access = fs.accessSync } = {}) {
  if (!exists(candidate)) return false
  if (platform === "win32") return true
  try {
    access(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findExecutable(name, { pathValue = process.env.PATH ?? "", platform = process.platform, exists = fs.existsSync, access = fs.accessSync } = {}) {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of executableNames(name, platform)) {
      const fullPath = path.join(directory, candidate)
      if (executable(fullPath, { platform, exists, access })) return fullPath
    }
  }
  return null
}
