import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const main = read('./main.tsx')
const standalone = read('./components/standalone-universal-workspace.tsx')
const home = read('./components/native-session-home-base.tsx')
const observer = read('./components/native-session-observer.tsx')
const machineClient = read('./machineClient.ts')
const taskClient = read('./taskClient.ts')
const preferences = read('./appPreferences.ts')
const serverConfig = read('./serverConfig.ts')
const desktopRequestTransport = read('../electron/request-transport.ts')
const desktopEventTransport = read('../electron/event-transport.ts')
const workbench = read('./session-first-workbench.css')

// 3.0 starts from machine-level configuration and the Session-first product shell.
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /persistWorkspaceMachines/)
assert.doesNotMatch(main, /ConnectServerWizard/)
assert.doesNotMatch(main, /needsInitialSetup/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.equal(existsSync(new URL('./components/conversation-workspace.tsx', import.meta.url)), false)
assert.equal(existsSync(new URL('./components/conversation-detail.tsx', import.meta.url)), false)
assert.match(standalone, /useState\(machines\.length === 0\)/, 'an empty install must open Machines immediately')
assert.match(standalone, /const \[editingID, setEditingID\] = useState<string \| null>\(null\)/, 'opening Machines must not open the new-machine fields automatically')
assert.doesNotMatch(standalone, /machines\.length === 0 \? "new" : null/, 'async machine discovery must not leave an auto-created blank editor behind')
assert.match(standalone, /onClick=\{\(\) => \{ setCompletionMachineName\(null\); setEditingID\("new"\) \}\}/, 'new-machine fields must open only after the explicit Add machine action and leave completion mode')
assert.match(standalone, /machines\.length === 0 && editingID !== "new"[\s\S]*t\("sf\.scanMachineQR"\)[\s\S]*t\("sf\.addManually"\)/, 'first-run Machines must offer QR pairing first and manual setup separately')
assert.match(standalone, /createWorkspaceMachine\(\)/, 'the manager must provide a new machine draft')
assert.match(standalone, /discoverMachine\(nextMachine\(\)\.config, \{ configurationProbe: true \}\)/, 'Test connection must discover the daemon before save')
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
assert.match(standalone, /disabled=\{!valid \|\| testing \|\| busy\}/, 'Test connection must not run with an invalid endpoint')
assert.match(standalone, /disabled=\{!valid \|\| busy/, 'Save must not accept an invalid machine endpoint')

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

// Phone pairing (the embedded daemon's LAN exposure) is an app-level setting next to the other app
// settings. It renders only where a desktop bridge answers, applies through the main process with
// no save step, and the machine editor must not carry it.
assert.match(standalone, /function MobileSettingsPage[\s\S]*data-settings-network-pairing/)
assert.match(standalone, /if \(!cancelled && state\) setNetwork\(\{ lanPairing: state\.lanPairing \}\)/, 'a missing bridge hides the section instead of explaining it')
assert.match(standalone, /setDesktopNetworkSettings\(enabled\)[\s\S]{0,200}setNetwork\(\{ lanPairing: result\.lanPairing \}\)/, 'the toggle re-syncs from the answer the main process applied')
assert.match(workbench, /\.hr-mobile-settings-group label input\[type="checkbox"\] \{\r?\n\s*justify-self: end;/, 'the toggle must sit at the end of its settings row, not fill the column')

// One machine discovers coding agents and native Sessions. New work is created as a real native Session.
assert.match(machineClient, /export async function discoverMachine/)
assert.match(home, /snapshot\.agents\.filter\(canCreateNativeSession\)/)
assert.match(home, /createNativeSessionTarget/)
assert.doesNotMatch(home, /taskClient\.createTask/)
assert.match(observer, /const NATIVE_SESSION_MODEL_SCOPE: AgentModelScope = \{\}/)
assert.match(observer, /deferModelFallback/)
assert.match(taskClient, /export function modelCatalogConfig\(/)

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
