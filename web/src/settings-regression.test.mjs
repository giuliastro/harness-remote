import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const serverProfiles = readFileSync(new URL('./serverProfiles.ts', import.meta.url), 'utf8')
const i18n = readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./components/shell.tsx', import.meta.url), 'utf8')
const panels = readFileSync(new URL('./components/panels.tsx', import.meta.url), 'utf8')

const testConnection = app.match(/async function testConnection[\s\S]*?async function refreshSessions/)
assert.ok(testConnection, 'testConnection function should be present')
assert.equal(testConnection[0].includes('setView("sessions")'), false, 'Test Connection must not navigate away from settings')
assert.equal(testConnection[0].includes('setConfig(configToTest)'), false, 'Test Connection must not overwrite the current configuration')

const applyConfig = app.match(/function applyConfig[\s\S]*?async function testConnection/)
assert.ok(applyConfig, 'applyConfig function should persist the active configuration')
assert.equal(applyConfig[0].includes('setView("sessions")'), false, 'Automatic saves must leave the user on settings')
assert.ok(app.includes('setTimeout(() => applyConfig(draftConfig), 500)'), 'Configuration edits should be persisted after a short debounce')
assert.equal(app.includes('onClick={saveConfig}'), false, 'Settings should not require a separate Save action')
assert.ok(app.includes("t('settings.draftHint')"), 'Settings should explain automatic saving')
assert.ok(i18n.includes("'settings.saved': 'Changes saved automatically.'"), 'Automatic save feedback should be translated')
assert.match(app, /id="port"[\s\S]*?type="text"[\s\S]*?value=\{draftConfig\.port \|\| ""\}/, 'the port field should be clearable instead of forcing a zero')
assert.match(app, /pattern="\[0-9\]\*"/, 'the port field should still accept only digits')
assert.ok(i18n.includes("'settings.testedNotSaved'"), 'Test success should remain distinct from connectivity state')
assert.ok(app.includes('function canTestConfig'), 'Settings should have a central testability check for required connection fields')
assert.ok(app.includes('disabled={testingConnection || !canTestDraft || testAlreadyPassedForDraft}'), 'Test button should be disabled when fields are missing, testing is active, or the unchanged configuration already passed')
assert.ok(app.includes('connection-help'), 'Settings should explain whether the current configuration can be tested')
assert.ok(app.includes('Full, versioned backend guides live in the Harness Remote repository'), 'Help should link out instead of duplicating every backend guide')
assert.ok(app.includes('"oh-my-pi-bridge-setup"') && app.includes('"pi-bridge-setup"') && app.includes('"opencode-server-setup"') && app.includes('"codex-bridge-setup"'), 'Help should select the repository guide for the active backend')
assert.ok(app.includes('<option value="pi">PI (ACP bridge)</option>'), 'Settings should expose the PI backend')
assert.ok(app.includes('<option value="codex">Codex CLI (ACP bridge)</option>'), 'Settings should expose the Codex backend')
assert.ok(app.includes('health.backend && health.backend !== configToTest.backend'), 'Connection tests should reject a bridge for the wrong backend')
assert.ok(app.includes('https://github.com/giuliastro/harness-remote#'), 'Help should link to the canonical repository')
assert.equal(app.includes('https://github.com/gervaso-assistant/opencode-remote-android#'), false, 'Help must not link to the obsolete repository owner')

// First-run configuration is a guided flow, not the editable Settings panel. A blank fallback
// profile must never mount App first, because App's Settings screen auto-persists valid drafts.
assert.ok(main.includes('const needsInitialSetup = !isValidServerConfig(activeProfile.config)'), 'first-run setup must be derived from the active profile validity')
assert.match(main, /if \(needsInitialSetup\) \{[\s\S]*?<ConnectServerWizard/, 'an unconfigured install must render the connection wizard directly')
assert.match(main, /onCancel=\{\(\) => undefined\}/, 'the required first-run wizard must not dismiss into the raw Settings form')

// Settings may still auto-save edits, but changing the current profile identity must not remount the
// whole React tree. That remount closed the editor after a couple of typed characters and started a
// connection with a half-entered address.
assert.ok(serverProfiles.includes('if (profileChanged) {'), 'only an actual saved-profile switch should emit the remount event')
assert.doesNotMatch(serverProfiles, /if \(profileChanged \|\| connectionChanged\) \{\s*window\.dispatchEvent/, 'editing host, port or credentials must not remount App')

// A daemon-backed connection discovers the machine before falling back to the backend-specific
// health check. Legacy servers return null from discovery and therefore keep the existing save flow.
assert.ok(panels.includes('await import("../machineClient")'), 'the connection wizard should discover a machine without requiring App-level wiring')
assert.ok(panels.includes('discoverMachine(candidate)'), 'the wizard should call machine discovery when testing the connection')
assert.ok(panels.includes('agentId: agentId || undefined'), 'the selected machine agent should be persisted in the saved server config')
assert.ok(panels.includes("t('detail.agentTitle')"), 'the discovered-agent picker label should use translated UI copy')
assert.ok(panels.includes("t('detail.unavailable')"), 'unavailable machine hosts should use translated UI copy')
assert.equal(panels.includes('Agent on '), false, 'the machine picker must not introduce hardcoded English labels')
assert.equal(panels.includes('agents discovered'), false, 'machine discovery feedback must not introduce hardcoded English copy')
assert.equal(panels.includes('{agent.label} · {agent.state}'), false, 'protocol host states must not be rendered verbatim')
assert.ok(panels.includes('agent.state !== "available" && agent.state !== "configured"'), 'unavailable machine agents must not be selectable')

// A valid profile without an agentId is not safe to use against a multi-harness daemon. OpenCode is
// intentionally not a bridge backend, so the old App-only repair skipped it and its first session
// request fell through to the daemon primary, commonly Codex. Resolve every unscoped profile before
// App mounts and repeat the same resolution on first-run Save in case the user skipped Test.
assert.ok(main.includes('const needsRoutingDiscovery = !needsInitialSetup && !activeProfile.config.agentId'), 'unscoped saved profiles must be resolved before App starts loading sessions')
assert.ok(main.includes('matchingMachineAgent(machine, activeProfile.config.backend)'), 'routing discovery must match the selected backend, including OpenCode')
assert.match(main, /if \(needsRoutingDiscovery\) \{[\s\S]*?connection\.connecting/, 'the app must not mount its session UI while daemon routing is unresolved')
assert.match(main, /onSave=\{\(name, config\) => \{[\s\S]*?if \(!config\.agentId\)[\s\S]*?discoverMachine\(config\)/, 'saving the first server must resolve its daemon agent even when Test was skipped')

// Automatic server names are suggestions. Once the user types a name, later discovery or agent
// selection must not silently replace it with a generated machine/harness label.
assert.ok(panels.includes('const [nameEdited, setNameEdited] = useState(false)'), 'the wizard should remember when the server name was edited manually')
assert.ok(panels.includes('if (!nameEdited) setName(`${backendDisplayName(next)} server`)'), 'backend defaults should only replace an untouched automatic name')
assert.ok(panels.includes('if (preferred && !nameEdited) setName(`${discovered.machine.name} · ${preferred.label}`)'), 'machine discovery should preserve a manually entered server name')
assert.ok(panels.includes('if (next && !nameEdited) setName(`${machine.machine.name} · ${next.label}`)'), 'agent selection should preserve a manually entered server name')
assert.match(panels, /setName\(event\.target\.value\)[\s\S]*?setNameEdited\(true\)/, 'typing in the server-name field should lock in the user value')

// Agent-scoped URLs are the primary routing contract. The backend header is a compatibility guard
// for profiles saved by older builds with no agentId, or with an agentId that points at the old primary.
// A raw OpenCode server must not receive the custom header because its CORS policy does not know it.
assert.ok(api.includes('function routingHeaders(config: ServerConfig)'), 'API requests should centralize the compatibility routing hint')
assert.ok(api.includes('return { "X-Harness-Backend": config.backend }'), 'daemon requests should identify the selected harness backend')
assert.ok(api.includes('if (config.backend === "opencode" && !config.agentId) return {}'), 'direct legacy OpenCode servers must not receive the daemon routing header')
assert.ok(api.includes('...routingHeaders(config)'), 'ordinary API requests should carry the selected harness routing hint')
assert.match(api, /eventStream\(config: ServerConfig\)[\s\S]*?routingHeaders\(config\)/, 'browser SSE should preserve the selected harness routing hint too')

// The server picker used to caption itself with a visually-hidden span, but no rule ever hid it: the
// caption rendered as stray text above the header. Every class the picker and its actions rely on has
// to exist in the stylesheet, or the layout falls back to whatever the bare markup does.
for (const className of ['server-profile-actions', 'section-heading-text']) {
  assert.ok(app.includes(`className="${className}"`), `${className} should be used by the saved-server UI`)
  assert.ok(styles.includes(`.${className}`), `${className} should be styled instead of relying on default rendering`)
}
assert.ok(shell.includes('className="server-switcher"'), 'the saved-server UI should use the richer server switcher')
assert.ok(styles.includes('.server-switcher'), 'the server switcher should be styled instead of relying on default rendering')
assert.equal(/className="sr-only"/.test(app), false, 'a caption the stylesheet cannot hide must not be rendered at all')
assert.ok(panels.includes('aria-pressed={backend === kind}'), 'harness choices should expose their selected state without relying on color alone')
assert.match(styles, /\.choice-card\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/, 'harness choice text should share one full-width alignment column')
assert.match(styles, /--harness-pi:\s*#0e7490/, 'PI should use a distinct cyan hue instead of OpenCode blue')

// Sized to their labels the two actions came out visibly different widths, and a full row of their own
// pushed a form that already fills the height cap into scrolling for a few pixels.
assert.match(styles, /\.server-profile-actions\s*\{[^}]*display:\s*flex/, 'the saved-server actions must stay aligned as one action group')
assert.match(styles, /\.desktop-panel-modal\s*\{[^}]*max-height:\s*calc\(100dvh - 2 \* var\(--modal-margin\) - 2px\)/, 'a panel modal must claim every pixel the backdrop margin leaves so a form that fits does not scroll')
assert.match(styles, /\.desktop-panel-modal > \.panel\s*\{[^}]*border:\s*0/, 'the panel inside a modal must not draw a second frame inside the card')

// Deleting a saved server discards a host, a username and a password with no way back.
assert.ok(app.includes('setProfileToDelete(profiles.find((profile) => profile.id === activeProfileID) ?? null)'), 'deleting a saved server must ask first')
assert.ok(app.includes('aria-labelledby="delete-server-title"'), 'the saved-server deletion must be confirmed in a dialog')
assert.ok(i18n.includes("'settings.deleteServerTitle'"), 'the deletion dialog needs a translated title')

console.log('settings regression tests passed')
