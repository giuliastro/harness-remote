import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')

assert.ok(source.includes('const DEFAULT_MACHINE_DAEMON_PORT = 4097'), 'OpenCode task discovery should know the standard machine-daemon port')
assert.ok(source.includes('["/v1/machine", "/global/machine"]'), 'daemon discovery should try both published machine snapshot routes')
assert.ok(source.includes('hasDaemonProjectsRoute(config)'), 'daemon discovery may validate the machine-level projects route as a fallback')
assert.ok(source.includes('config.port === DEFAULT_MACHINE_DAEMON_PORT'), 'a profile already pointing at the daemon must not get redirected')
assert.ok(source.includes('port: DEFAULT_MACHINE_DAEMON_PORT'), 'a direct OpenCode profile should also probe the machine daemon')
assert.ok(source.includes('export async function discoverMachineConnection'), 'task launch needs both the machine snapshot and the endpoint that supplied it')
assert.ok(source.includes('if (machine) return { machine, config: candidate }'), 'the resolved daemon config must travel with the discovered machine')
assert.equal(source.includes('ultimately return a synthetic'), false, 'OpenCode connectivity alone must never masquerade as daemon discovery')
