import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')

assert.ok(source.includes('["/v1/machine", "/global/machine"]'), 'daemon discovery should try both published machine snapshot routes')
assert.ok(source.includes('hasDaemonProjectsRoute(config)'), 'OpenCode daemon discovery should fall back to a machine-level projects probe')
assert.ok(source.includes('if (config.backend === "opencode")'), 'the projects-route fallback must stay scoped to OpenCode')
assert.ok(source.includes('return fallbackOpenCodeSnapshot(config)'), 'a confirmed OpenCode machine daemon should produce a usable task agent snapshot')
assert.ok(source.includes('Array.isArray(value?.projects)'), 'the fallback must validate the projects payload rather than accepting any HTTP 200')
