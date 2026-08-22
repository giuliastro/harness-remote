import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('./components/conversation-workspace.tsx', import.meta.url), 'utf8')
const standalone = readFileSync(new URL('./components/standalone-universal-workspace.tsx', import.meta.url), 'utf8')
const machineClient = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')
const preferences = readFileSync(new URL('./appPreferences.ts', import.meta.url), 'utf8')
const serverConfig = readFileSync(new URL('./serverConfig.ts', import.meta.url), 'utf8')
const desktopRequestTransport = readFileSync(new URL('../electron/request-transport.ts', import.meta.url), 'utf8')
const desktopEventTransport = readFileSync(new URL('../electron/event-transport.ts', import.meta.url), 'utf8')

// 3.0 starts from machine-level configuration. There is no first-run Classic profile wizard in the
// primary product shell: an empty machine list opens the machine manager immediately.
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /persistWorkspaceMachines/)
assert.doesNotMatch(main, /ConnectServerWizard/)
assert.doesNotMatch(main, /needsInitialSetup/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.match(standalone, /useState\(machines\.length === 0\)/, 'an empty install must open Machines immediately')
assert.match(standalone, /createWorkspaceMachine\(\)/, 'the manager must provide a new machine draft')
assert.match(standalone, /discoverMachine\(nextMachine\(\)\.config\)/, 'Test connection must discover the daemon before save')
assert.match(standalone, /Connected to \$\{snapshot\.machine\.name\}/, 'successful discovery must identify the connected machine')
assert.match(standalone, /onPersist\(\[\.\.\.machines, machine\]\)/, 'adding a machine must persist it in the machine collection')
assert.match(standalone, /onPersist\(machines\.map/, 'editing a machine must replace that machine without rebuilding profiles')
assert.match(standalone, /Remove \"\$\{machine\.name\}\" from Harness Remote\?/, 'machine removal must ask for confirmation')

// Machine configuration keeps the existing connection fields and a bounded numeric port.
assert.match(standalone, /placeholder="192\.168\.1\.20 or localhost"/)
assert.match(standalone, /Number\(port\) >= 1 && Number\(port\) <= 65_535/)
assert.match(standalone, /autoComplete="username"/)
assert.match(standalone, /autoComplete="current-password"/)
assert.match(standalone, /disabled=\{!valid \|\| testing\}/, 'Test connection must not run with an invalid endpoint')
assert.match(standalone, /disabled=\{!valid\}/, 'Save must not accept an invalid machine endpoint')

// The control plane retains appearance and language settings even though Classic is no longer a mode.
assert.match(workspace, /function ConversationSettingsModal/)
assert.match(workspace, /loadThemePreference/)
assert.match(workspace, /persistThemePreference\(value\)/)
assert.match(workspace, /loadLanguage/)
assert.match(workspace, /persistLanguage\(next\)/)
assert.match(workspace, /<option value="system">/)
assert.match(workspace, /<option value="light">/)
assert.match(workspace, /<option value="dark">/)
assert.match(preferences, /export function installAppPreferences/)
assert.match(main, /installAppPreferences\(\)/, 'preferences must be installed before the product shell renders')

// One machine connection discovers the available coding agents instead of asking for one profile per harness.
assert.match(workspace, /selectableMachineAgents\(snapshot\)/)
assert.match(workspace, /taskClient\.listAgentModels\(runtime\.machine\.config, agentID\)/)
assert.match(workspace, /<span className="tdw-workspace-label">Coding agents<\/span>/)
assert.match(machineClient, /export async function discoverMachine/)

// Routing remains agent-scoped below the machine endpoint. Browser and desktop transports share the
// same validated routing hint and desktop SSE authorization still comes from the approved config.
assert.match(serverConfig, /export function routingHeaders\(/)
assert.ok(serverConfig.includes('return { "X-Harness-Backend": config.backend }'))
assert.ok(serverConfig.includes('if (preflight && config.backend === "opencode" && !config.agentId?.trim()) return {}'))
assert.ok(desktopRequestTransport.includes('...routingHeaders(profile, { preflight: false })'))
assert.ok(desktopEventTransport.includes('...routingHeaders(targetProfile, { preflight: false })'))
assert.ok(desktopEventTransport.includes('const authorization = authHeader(profile)'))

console.log('settings regression tests passed')