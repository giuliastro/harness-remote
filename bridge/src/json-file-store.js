import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export class JsonFileStore {
  #filePath
  #stateDirectory
  #warn
  #serialPromise = Promise.resolve()

  constructor({ filePath, stateDirectory, warn } = {}) {
    if (!filePath) throw new Error("JsonFileStore requires filePath")
    this.#filePath = filePath
    this.#stateDirectory = stateDirectory ?? path.dirname(filePath)
    this.#warn = warn
  }

  get path() {
    return this.#filePath
  }

  get stateDirectory() {
    return this.#stateDirectory
  }

  serial(operation) {
    const next = this.#serialPromise.then(operation, operation)
    this.#serialPromise = next.catch(() => undefined)
    return next
  }

  async read({ onCorrupt = "backup", onError } = {}) {
    try {
      const text = await readFile(this.#filePath, "utf8")
      return JSON.parse(text)
    } catch (error) {
      if (error?.code === "ENOENT") return null
      if (error instanceof SyntaxError && onCorrupt === "backup") {
        const backup = `${this.#filePath}.corrupt-${Date.now()}`
        await rename(this.#filePath, backup)
        const name = path.basename(this.#filePath)
        this.#warn?.(`JSON file ${name} was malformed and has been preserved at ${backup}`, backup)
        return null
      }
      // onError handler should either throw or return a parsed fallback value.
      if (typeof onError === "function") return onError(error)
      throw error
    }
  }

  async write(data, { mode = 0o600, pretty = false } = {}) {
    await mkdir(this.#stateDirectory, { recursive: true })
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`
    const content = pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data)
    await writeFile(temporary, content, { mode })
    await rename(temporary, this.#filePath)
  }
}
