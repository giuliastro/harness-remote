import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_MACHINE_DAEMON_PORT,
  isProjectListing,
  machineCandidates,
  parseMachineSnapshot,
  selectableMachineAgents,
  unwrapPayload
} from './machinePayload.ts'

// Android does not answer like the browser does. CapacitorHttp hands back a JSON string rather than
// a parsed object, sometimes inside its own `{ data }` envelope, and a server may prefix a BOM.
// Every one of these produced `invalid JSON` on the phone while working on desktop.
assert.deepEqual(unwrapPayload({ projects: [] }), { projects: [] }, 'an already parsed body must pass through')
assert.deepEqual(unwrapPayload('{"projects":[]}'), { projects: [] }, 'a JSON string body must be parsed')
assert.deepEqual(unwrapPayload('\uFEFF{"projects":[]}'), { projects: [] }, 'a BOM must not defeat parsing')
assert.deepEqual(unwrapPayload({ data: '{"projects":[]}' }), { projects: [] }, 'a wrapped JSON string must be unwrapped and parsed')
assert.deepEqual(unwrapPayload({ data: { data: { projects: [] } } }), { projects: [] }, 'nested envelopes must be unwrapped')
assert.equal(unwrapPayload('<html>not json</html>'), '<html>not json</html>', 'a non-JSON body must be returned as it arrived')
assert.equal(unwrapPayload(''), '', 'an empty body must not be reported as parsed data')

// A 200 carrying something else means "this endpoint is not a machine daemon". That has to be
// distinguishable from a failure: reporting it as an error is what made a rejected password and a
// legacy server look the same.
const snapshot = { machine: { id: 'machine-1', name: 'workstation' }, agents: [] }
assert.deepEqual(parseMachineSnapshot(snapshot), snapshot, 'a valid snapshot must be accepted')
assert.deepEqual(parseMachineSnapshot(JSON.stringify(snapshot)), snapshot, 'a stringified snapshot must be accepted')
assert.equal(parseMachineSnapshot({ sessions: [] }), null, 'an unrelated payload is not a machine daemon')
assert.equal(parseMachineSnapshot({ machine: { name: 'no id' }, agents: [] }), null, 'a snapshot without a machine id must be refused')
assert.equal(parseMachineSnapshot({ machine: { id: 'machine-1' } }), null, 'a snapshot without an agent list must be refused')
assert.equal(parseMachineSnapshot('not json at all'), null, 'an unparseable body is not a machine daemon')

assert.equal(isProjectListing({ projects: [] }), true, 'an empty project list is still a project list')
assert.equal(isProjectListing('{"projects":[{"id":"a"}]}'), true, 'a stringified project list must be recognised')
assert.equal(isProjectListing({ sessions: [] }), false, 'an unrelated payload is not a project list')

// The daemon defaults to 4097 while a saved OpenCode profile usually points at 4096, so the task
// APIs commonly live one port away from the sessions the profile was saved for. The extra probe
// stays on the same host the profile already authenticates against.
const opencode = { backend: 'opencode', host: '192.168.1.64', port: 4096, username: 'harness', password: 'secret' }
const candidates = machineCandidates(opencode)
assert.equal(candidates.length, 2, 'a direct OpenCode profile must also consider the daemon port')
assert.equal(candidates[0].port, 4096, 'the configured endpoint must be tried first')
assert.equal(candidates[1].port, DEFAULT_MACHINE_DAEMON_PORT, 'the daemon port is the only alternative considered')
assert.ok(
  candidates.every((candidate) => candidate.host === opencode.host),
  'credentials must never be offered to a host the profile does not already use'
)
assert.equal(machineCandidates({ ...opencode, port: 4097 }).length, 1, 'a profile already on the daemon port must not be redirected')
assert.equal(machineCandidates({ ...opencode, backend: 'codex' }).length, 1, 'an ACP profile already points at its daemon')
assert.notEqual(machineCandidates(opencode)[0], opencode, 'candidates must be copies, so probing cannot mutate the saved profile')

const agents = [
  { id: 'a', state: 'available' },
  { id: 'b', state: 'configured' },
  { id: 'c', state: 'failed' },
  { id: 'd', state: 'unknown' }
]
assert.deepEqual(
  selectableMachineAgents({ machine: { id: 'm', name: 'm' }, agents }).map((agent) => agent.id),
  ['a', 'b'],
  'only agents a task could actually run on may be offered'
)
assert.deepEqual(selectableMachineAgents({ machine: { id: 'm', name: 'm' }, agents: undefined }), [], 'a malformed agent list must not throw')

// Discovery must never invent a machine. A fabricated snapshot gives the fleet layer an identity
// derived from how the daemon happens to be addressed rather than from the daemon itself, so the
// same machine reached by hostname and by IP becomes two machines that can never be reconciled.
const client = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')
assert.equal(/fallback\w*Snapshot|synthetic/i.test(client), false, 'connectivity alone must never be turned into a machine snapshot')
assert.ok(client.includes('if (failure !== undefined) throw failure'), 'a real failure must not be reported as a missing daemon')
assert.ok(client.includes('response.status === 401'), 'a rejected password must be named, not swallowed')

console.log('machine payload tests passed')
