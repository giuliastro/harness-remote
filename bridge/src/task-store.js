import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export class TaskStore {
  constructor({ machineID, stateDirectory, idFactory = randomUUID, clock = () => new Date().toISOString() }) {
    this.machineID = machineID
    this.stateDirectory = stateDirectory
    this.file = path.join(stateDirectory, "tasks.json")
    this.idFactory = idFactory
    this.clock = clock
    this.loaded = false
    this.tasks = []
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"))
      this.tasks = Array.isArray(parsed?.tasks) ? parsed.tasks.filter((task) => task?.machineId === this.machineID) : []
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      this.tasks = []
    }
  }

  async persist() {
    await mkdir(this.stateDirectory, { recursive: true })
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, tasks: this.tasks }, null, 2)}\n`, { mode: 0o600 })
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
