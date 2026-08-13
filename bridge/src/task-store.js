import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

function machineFileName(machineID) {
  const digest = createHash("sha256").update(machineID).digest("hex").slice(0, 16)
  return `tasks-${digest}.json`
}

export class TaskStore {
  constructor({ machineID, stateDirectory, idFactory = randomUUID, clock = () => new Date().toISOString(), warn = (message) => process.stderr.write(`${message}\n`) }) {
    this.machineID = machineID
    this.stateDirectory = stateDirectory
    this.file = path.join(stateDirectory, machineFileName(machineID))
    this.idFactory = idFactory
    this.clock = clock
    this.warn = warn
    this.loaded = false
    this.tasks = []
  }

  async load() {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"))
      this.tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.tasks = []
      } else if (error instanceof SyntaxError) {
        const backup = `${this.file}.corrupt-${Date.now()}`
        await rename(this.file, backup)
        this.tasks = []
        this.warn(`Task state was malformed and has been preserved at ${backup}`)
      } else {
        throw error
      }
    }
    this.loaded = true
  }

  async persist() {
    if (!this.loaded) throw new Error("Task store must load successfully before it can persist")
    await mkdir(this.stateDirectory, { recursive: true })
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, machineId: this.machineID, tasks: this.tasks }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }

  async list() {
    await this.load()
    return this.tasks.map((task) => structuredClone(task))
  }

  async create({ project, agentId, prompt }) {
    await this.load()
    const text = typeof prompt === "string" ? prompt.trim() : ""
    if (!text) throw new Error("A task prompt is required")
    const timestamp = this.clock()
    const task = {
      id: this.idFactory(),
      machineId: this.machineID,
      projectId: project.id,
      project: { name: project.name, path: project.path, kind: project.kind },
      agentId,
      prompt: text,
      status: "draft",
      workspace: { mode: "project", path: project.path },
      run: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.tasks.push(task)
    await this.persist()
    return structuredClone(task)
  }
}
