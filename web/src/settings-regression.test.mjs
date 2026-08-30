import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const main = read('./main.tsx')
const standalone = read('./components/standalone-universal-workspace.tsx')
const home = read('./components/native-session-home.tsx')
const observer = read('./components/native-session-observer.tsx')
const machineClient = read('./machineClient.ts')
const preferences = read('./appPreferences.ts')
const serverConfig = read('./serverConfig.ts')
const desktopRequestTransport = read('../electron/request-transport.ts')
const desktopEventTransport = read('../electron/event-transport.ts')

// 3.0 starts from machine-level configuration and the Session-first product shell.
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /persistWorkspaceMachines/)
assert.doesNotMatch(main, /ConnectServerWizard/)
assert.doesNotMatch(main, /needsInitialSetup/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.equal(existsSync(new URL('./components/conversation-workspace.tsx', import.meta.url)), false)
assert.equal(existsSync(new URL('./components/conversation-detail.tsx', import.meta.url)), false)
assert.match(standalone, /useState\(machines\.length === 0\)/, 'an empty install must open Machines immediately')
assert.match(standalone, /createWorkspaceMachine\(\)/, 'the manager must provide a new machine draft')
assert.match(standalone, /discoverMachine\(nextMachine\(\)\.config\)/, 'Test connection must discover the daemon before save')
assert.match(standalone, /t\("sf\.connectedTo", \{ name: snapshot\.machine\.name, count \}\)/, 'successful discovery must identify the connected machine')
assert.match(standalone, /onPersist\(\[\.\.\.machines, machine\]\)/, 'adding a machine must persist it in the machine collection')
assert.match(standalone, /onPersist\(machines\.map/, 'editing a machine must replace that machine without rebuilding profiles')
assert.match(standalone, /confirmRemoveID === machine\.id/, 'machine removal must ask for confirmation')
assert.match(standalone, /t\("sf\.removeQuestion", \{ name: machine\.name \}\)/, 'the confirmation must name the machine being removed')
assert.match(standalone, /onClick=\{\(\) => setConfirmRemoveID\(machine\.id\)\}/, 'the first Remove click must only arm the confirmation')

// Machine configuration keeps the connection fields and a bounded numeric port.
assert.match(standalone, /placeholder="192\.168\.1\.20 or localhost"/)
assert.match(standalone, /Number\(port\) >= 1 && Number\(port\) <= 65_535/)
assert.match(standalone, /autoComplete="username"/)
assert.match(standalone, /autoComplete="current-password"/)
assert.match(standalone, /disabled=\{!valid \|\| testing\}/, 'Test connection must not run with an invalid endpoint')
assert.match(standalone, /disabled=\{!valid\}/, 'Save must not accept an invalid machine endpoint')

// Appearance and language settings belong to the Session-first shell.
assert.match(standalone, /function MobileSettingsPage/)
assert.match(standalone, /loadThemePreference/)
assert.match(standalone, /persistThemePreference\(value\)/)
assert.match(standalone, /loadLanguage/)
assert.match(standalone, /persistLanguage\(next\)/)
assert.match(standalone, /<option value="system">\{t\("settings\.themeSystem"\)\}<\/option>/)
assert.match(standalone, /<option value="light">\{t\("settings\.themeLight"\)\}<\/option>/)
assert.match(standalone, /<option value="dark">\{t\("settings\.themeDark"\)\}<\/option>/)
assert.match(preferences, /export function installAppPreferences/)
assert.match(main, /installAppPreferences\(\)/, 'preferences must be installed before the product shell renders')

// One machine discovers coding agents and native Sessions. New work is created as a real native Session.
assert.match(machineClient, /export async function discoverMachine/)
assert.match(home, /snapshot\.agents\.filter\(canCreateNativeSession\)/)
assert.match(home, /createNativeSessionTarget/)
assert.doesNotMatch(home, /taskClient\.createTask/)
assert.match(observer, /const NATIVE_SESSION_MODEL_SCOPE: AgentModelScope = \{\}/)
assert.match(observer, /deferModelFallback/)

// Routing remains agent-scoped below the machine endpoint. Browser and desktop transports share the
// same validated routing hint and desktop SSE authorization still comes from the approved config.
assert.match(serverConfig, /export function routingHeaders\(/)
assert.ok(serverConfig.includes('return { "X-Harness-Backend": config.backend }'))
assert.ok(serverConfig.includes('if (preflight && config.backend === "opencode" && !config.agentId?.trim()) return {}'))
assert.ok(desktopRequestTransport.includes('isExplicitMachineScopedRequest(request.path)'))
assert.ok(desktopRequestTransport.includes('routingHeaders(targetProfile, { preflight: false })'))
assert.ok(desktopEventTransport.includes('...routingHeaders(targetProfile, { preflight: false })'))
assert.ok(desktopEventTransport.includes('const authorization = authHeader(profile)'))

console.log('Session-first settings regression tests passed')
