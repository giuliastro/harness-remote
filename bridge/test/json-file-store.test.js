import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { JsonFileStore } from "../src/json-file-store.js"

test("JsonFileStore writes atomically and reads JSON round-trip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "json-file-store-"))
  try {
    const file = path.join(dir, "data.json")
    const store = new JsonFileStore({ filePath: file })
    assert.equal(await store.read(), null)

    const payload = { hello: "world", count: 42 }
    await store.write(payload, { pretty: true })

    const read = await store.read()
    assert.deepEqual(read, payload)

    const raw = await readFile(file, "utf8")
    assert.equal(raw, `${JSON.stringify(payload, null, 2)}\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("JsonFileStore preserves corrupt file as backup and warns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "json-file-store-corrupt-"))
  try {
    const file = path.join(dir, "corrupt.json")
    await writeFile(file, "{not valid json", "utf8")

    const warnings = []
    const store = new JsonFileStore({ filePath: file, warn: (msg) => warnings.push(msg) })

    const read = await store.read()
    assert.equal(read, null)
    assert.equal(warnings.length, 1)

    const files = await readdir(dir)
    assert.ok(files.some((name) => name.startsWith("corrupt.json.corrupt-")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("JsonFileStore serializes concurrent operations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "json-file-store-serial-"))
  try {
    const file = path.join(dir, "data.json")
    const store = new JsonFileStore({ filePath: file })

    const order = []
    const op1 = store.serial(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(1)
      return "first"
    })
    const op2 = store.serial(async () => {
      order.push(2)
      return "second"
    })

    const [r1, r2] = await Promise.all([op1, op2])
    assert.equal(r1, "first")
    assert.equal(r2, "second")
    assert.deepEqual(order, [1, 2])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
