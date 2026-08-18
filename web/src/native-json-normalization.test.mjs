import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

assert.match(api, /if \(typeof data !== "string"\) return data/, 'already parsed native objects and arrays must remain unchanged')
assert.match(api, /trimmed\[0\] !== "\{" && trimmed\[0\] !== "\["/, 'plain text must not be parsed as JSON')
assert.match(api, /return JSON\.parse\(trimmed\)/, 'JSON-looking native strings must be parsed')
assert.match(api, /catch \{\s*return data\s*\}/, 'malformed JSON-looking text must remain plain text')
assert.match(api, /normalizeNativeResponseData\(response\.data\) as T/, 'CapacitorHttp responses must pass through the normalizer')

console.log('native JSON normalization regression tests passed')
