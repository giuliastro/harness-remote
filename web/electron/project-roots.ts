import { mkdir, open, readFile, rename, realpath, rm, stat } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"

export class ProjectRootsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProjectRootsError"
  }
}

export async function validateProjectRoots(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length > 64) throw new ProjectRootsError("machine.foldersInvalid")
  const roots: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate || candidate.length > 4_096 || !isAbsolute(candidate)) {
      throw new ProjectRootsError("machine.folderPathInvalid")
    }
    let canonical: string
    try {
      canonical = await realpath(candidate)
      if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory")
    } catch {
      throw new ProjectRootsError("machine.folderMissing")
    }
    if (!roots.includes(canonical)) roots.push(canonical)
  }
  return roots
}

export function effectiveProjectRoots(configured: readonly string[], environmentRoot: string | undefined, homeDirectory: string): string[] {
  if (environmentRoot) return [environmentRoot]
  return configured.length ? [...configured] : [homeDirectory]
}

export class ProjectRootsStore {
  private roots: string[] = []
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  get(): string[] {
    return [...this.roots]
  }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"))
      this.roots = await validateProjectRoots(parsed)
    } catch {
      this.roots = []
    }
  }

  async replace(value: unknown): Promise<string[]> {
    const roots = await validateProjectRoots(value)
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`
      const handle = await open(temporaryPath, "w", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(roots)}\n`, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporaryPath, this.filePath)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
      this.roots = roots
      return [...roots]
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
