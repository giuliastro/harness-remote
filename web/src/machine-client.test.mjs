import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')

assert.match(source, /status === 404 \|\| status === 503/, '404 and registry-less 503 must both fall back to legacy mode')
assert.match(source, /result\.error\.code === "http" && noMachineStatus\(result\.error\.status\)/, 'desktop discovery must use structured HTTP status')
assert.equal(/404\|not found/i.test(source), false, 'desktop discovery must not classify transport errors by matching prose')

console.log('machine client regression tests passed')
