# Plugins

Harness Remote plugins are small, local integrations that add a capability to a machine and,
optionally, a declarative surface to the app. They are deliberately not arbitrary frontend code:
the daemon owns data and lifecycle, the renderer owns layout and accessibility.

The first shipped plugin is **Token Harness**. It detects an existing `token-harness` CLI, can install
a managed copy with npm, shows live harness allowance and local savings, and exposes the automatic
model-routing switches.

## Where plugins live

| Location | Purpose |
| --- | --- |
| `bridge/src/plugins/builtin/<id>/` | Plugins shipped with Harness Remote. |
| `<state-dir>/plugins/user/<id>/` | Plugins added by the user on that machine. |
| `<state-dir>/plugins/data/<id>/` | Private plugin data and managed runtimes. |
| `<state-dir>/plugins/state.json` | Enabled state and persisted settings. |

`<state-dir>` is `~/.harness-remote` for a CLI daemon and `app.getPath("userData")/embedded-daemon`
for the desktop app.

## Manifest

Each plugin directory contains `harness-plugin.json` and its backend entry file.

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "description": "A short line shown in the catalogue.",
  "vendor": "Example",
  "homepage": "https://example.invalid",
  "license": "MIT",
  "icon": "puzzle",
  "order": 100,
  "autoEnableWhenReady": true,
  "surfaces": ["backend", "frontend"],
  "capabilities": ["dashboard"],
  "permissions": ["run-local"],
  "runtime": {
    "kind": "node",
    "entry": "plugin.js",
    "deactivateOnDisable": false,
    "timeoutMs": 60000
  }
}
```

- `runtime.kind` is `node` or `python`.
- `runtime.entry` is relative to the plugin directory and may not escape it.
- `runtime.deactivateOnDisable` opts into a `deactivate` call after Disable. It is useful for a
  plugin that owns a long-lived helper process; failures are logged while the plugin remains disabled.
- `surfaces` says where the plugin contributes. `backend` means it runs on the daemon; `frontend`
  means it returns one or more of the declarative view shapes below.
- `autoEnableWhenReady` applies only to built-in plugins. A user plugin is listed without executing
  its code until the user explicitly enables it. Disabling a user plugin also stops status probes and
  custom actions; enabling it runs `status` to verify that its dependency is ready.
- `permissions` is descriptive metadata, not an operating-system sandbox. A Node or Python plugin
  runs with the account's local privileges after it is enabled. Install only code from a trusted
  source, and review updates before replacing a plugin directory.

## Process protocol

The daemon starts the entry for one method at a time and writes one JSON request to stdin. The plugin
writes exactly one JSON response to stdout. Diagnostics belong on stderr.

```json
{
  "schemaVersion": 1,
  "method": "status",
  "params": {
    "enabled": true,
    "config": { "window": "7d" },
    "context": {
      "pluginId": "example-plugin",
      "pluginDirectory": "/path/to/plugin",
      "pluginDataDirectory": "/path/to/plugins/data/example-plugin",
      "managedRuntimeDirectory": "/path/to/plugins/data/example-plugin/runtime",
      "stateDirectory": "/path/to/plugins",
      "home": "/home/user",
      "platform": "linux",
      "arch": "x64",
      "installedByHarnessRemote": false
    }
  }
}
```

Success:

```json
{ "ok": true, "result": { "ready": true } }
```

Failure:

```json
{ "ok": false, "error": "Human-readable reason" }
```

Methods:

| Method | When |
| --- | --- |
| `status` | Catalogue refresh, detail view and contribution polling. |
| `install` | The user chose Install. |
| `update` | The user chose Update. |
| `uninstall` | The user confirmed Uninstall. |
| `configure` | A settings field changed. Receives `values` plus the previous `config`. |
| `action` | A named action from `actions.custom`, for example opening the application's own dashboard. The result may include a `url`; the shell opens it automatically on the local desktop and shows the address for a remote machine. |
| `deactivate` | Optional cleanup after Disable when `runtime.deactivateOnDisable` is true. |

`status` runs with `enabled: false` when the plugin is disabled. Keep that path cheap: detect the
external application and return its version, but do not load dashboards or settings.
For user plugins, the host does not call `status` while disabled. This preserves the built-in
Token Harness detection flow without running newly discovered third-party code.

The host checks at most three plugin statuses concurrently. A status response is limited to 4 MiB
and each invocation has a timeout. Token Harness's dashboard log is capped at 1 MiB; the cap covers
that log only, not the plugin's managed npm runtime or files written by external applications.
Disabling or uninstalling Token Harness also asks its launched dashboard to stop.
The Plugin Center displays the size of each plugin's managed data directory and warns at 512 MiB.
The scan is cached for five minutes and stops after 10,000 entries; when incomplete, the displayed
size is marked as a lower bound. This is monitoring, not a filesystem quota: plugin processes may
write elsewhere with the user's privileges, so a hard limit requires an operating-system sandbox.

## Status result

```json
{
  "ready": true,
  "dependency": {
    "state": "external",
    "name": "example-cli",
    "version": "1.2.3",
    "path": "/home/user/.local/bin/example-cli",
    "manager": "npm",
    "compatible": true,
    "supportsObserve": true,
    "detail": "Detected on this machine · v1.2.3"
  },
  "actions": {
    "install": { "available": false },
    "update": { "available": false },
    "uninstall": { "available": false, "reason": "Installed outside Harness Remote." },
    "custom": [
      { "id": "open", "label": "Open Token Harness", "style": "secondary" }
    ]
  },
  "contributions": {},
  "settings": { "sections": [] },
  "diagnostics": []
}
```

`dependency.state` is `missing`, `external` or `managed`. This is what makes an application that was
already installed outside Harness Remote visible in the plugin catalogue.

## Declarative contributions

The current shell renders one contribution slot, `home`. It powers the small dashboard in the
empty state, the plugin detail and the quick view.

The allowance chip is intentionally not a generic summary: it is derived from `home.harnesses`
and the harness of the Session currently open. A Codex Session shows Codex's allowance, a Claude
Session shows Claude's, and an OpenCode/Pi/OMP Session shows no quota chip at all. The chip lives in
the top bar on desktop and in the Session header on a phone; both stay attached to the harness in
use.

### Home dashboard

```json
{
  "title": "Token Harness",
  "subtitle": "Last 7 days · stored local evidence",
  "harnesses": [
    { "harnessId": "claude", "label": "Claude Code", "state": "observed", "remainingPercent": 82 },
    { "harnessId": "codex", "label": "Codex", "state": "observed", "remainingPercent": 41 }
  ],
  "meters": [
    {
      "id": "codex:weekly",
      "harness": "codex",
      "harnessLabel": "Codex",
      "label": "Weekly",
      "scope": "weekly",
      "state": "observed",
      "remainingPercent": 41,
      "usedPercent": 59,
      "resetsAt": "2026-10-31T12:00:00.000Z",
      "source": "native-rpc",
      "confidence": "reported",
      "tone": "warn"
    }
  ],
  "stats": [
    {
      "id": "exact-saved",
      "label": "Exact local saved",
      "value": 123456,
      "unit": "tokens",
      "format": "number",
      "detail": "Last 7 days · 42 recorded operations"
    }
  ],
  "chart": {
    "title": "Exact local savings",
    "unit": "tokens",
    "points": [{ "label": "10-24", "value": 70000 }]
  },
  "footnote": "Local token reductions are not subscription quota."
}
```

`harnesses` is the compact per-harness summary used by the contextual top-bar chip. `meters` carries
the detailed windows shown in the dashboard and quick view. Values are escaped and bounded before
they reach the renderer.

## Settings

Settings fields are declarative too. Supported types: `toggle`, `select`, `text`.

```json
{
  "sections": [
    {
      "id": "routing",
      "title": "Automatic model routing",
      "description": "Explain the effect and the limits.",
      "fields": [
        {
          "id": "routing.claude",
          "type": "toggle",
          "label": "Claude Code",
          "description": "Add the native prompt hook.",
          "value": true,
          "stateLabel": "On",
          "help": "The hook is installed in ~/.claude/settings.json.",
          "disabled": false
        }
      ]
    }
  ]
}
```

Changing a field sends `{ "values": { "<field.id>": <new value> } }` to `configure`. Return the full
new config in `result.config`; the daemon persists it and passes it back to every later method.

## Token Harness integration

The built-in plugin uses only public CLI surfaces:

- `token-harness observe --json --since <7d|30d|all>` for the read-only dashboard (0.1.34+).
- `token-harness budget --json` and `token-harness savings --json` as the fallback for older copies.
  These commands still return current quota and locally recorded savings; lacking `observe` does not
  make the dashboard demo or stale.
- `token-harness plan --harness <claude|codex> --provider none --agent-routing|--disable-agent-routing --json`
  followed by `apply --plan <id> --yes --json` for the routing switches.
- `token-harness ui --no-open` for the **Open Token Harness** action: the plugin starts the guided
  dashboard on that machine, reads its ready URL and returns it to Harness Remote. The desktop app
  opens the URL locally; a remote machine shows the address. That dashboard remains the place for
  RTK, HarnessTrim and the other optimizer settings; Harness Remote surfaces routing directly and
  links the rest there.
- `--version` for external detection.

Detection checks the managed runtime first, then `PATH` and the common user install directories. An
external copy is never updated or removed by Harness Remote. Installing from the plugin panel puts a
copy under the plugin data directory; Update and Uninstall affect only that managed copy.

## Adding a plugin

1. Create `bridge/src/plugins/builtin/<id>/harness-plugin.json` and its entry.
2. Implement `status` first; return `ready: false` when the dependency is absent.
3. Add only the contributions the plugin can actually support.
4. Keep `enabled: false` cheap.
5. Add tests for detection, lifecycle and any settings mutation.
6. If the plugin is Python, set `"kind": "python"` and make the entry executable with `python3`.
