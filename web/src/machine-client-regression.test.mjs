import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')

assert.ok(source.includes('["/v1/machine", "/global/machine"]'), 'daemon discovery should try both published machine snapshot routes')
assert.ok(source.includes('hasDaemonProjectsRoute(config)'), 'OpenCode daemon discovery should still probe the machine-level projects route')
assert.ok(source.includes('if (config.backend === "opencode")'), 'the OpenCode fallback must stay scoped to OpenCode')
assert.ok(source.includes('return fallbackOpenCodeSnapshot(config)'), 'OpenCode discovery must produce a usable task agent snapshot')
assert.ok(source.includes('Array.isArray(value?.projects)'), 'the projects probe must validate its payload rather than accepting any HTTP 200')
assert.match(
  source,
  /if \(config\.backend === "opencode"\)[\s\S]*?if \(await hasDaemonProjectsRoute\(config\)\) return fallbackOpenCodeSnapshot\(config\)[\s\S]*?return fallbackOpenCodeSnapshot\(config\)/,
  'a connected OpenCode profile must not leave New Task disabled solely because daemon discovery failed'
)
