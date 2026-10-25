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
    "timeoutMs": 60000
  }
}
```

- `runtime.kind` is `node` or `python`.
- `runtime.entry` is relative to the plugin directory and may not escape it.
- `surfaces` says where the plugin contributes. `backend` means it runs on the daemon; `frontend`
  means it returns one or more of the declarative view shapes below.
- `autoEnableWhenReady` enables the integration the first time its `status` method reports `ready`.
  A user can always disable it afterwards.

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

`status` runs with `enabled: false` when the plugin is disabled. Keep that path cheap: detect the
external application and return its version, but do not load dashboards or settings.

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
    "uninstall": { "available": false, "reason": "Installed outside Harness Remote." }
  },
  "contributions": {},
  "settings": { "sections": [] },
  "diagnostics": []
}
```

`dependency.state` is `missing`, `external` or `managed`. This is what makes an application that was
already installed outside Harness Remote visible in the plugin catalogue.

## Declarative contributions

A plugin may publish any combination of three slots.

### Top bar

```json
{
  "label": "Allowance",
  "value": "41%",
  "detail": "Claude Code 82% · Codex 41% left",
  "tone": "warn"
}
```

`tone` is `good`, `warn`, `danger` or `muted`. Clicking the chip opens the quick view with the plugin's
dashboard and settings.

### Session rail

```json
{
  "title": "Token Harness",
  "value": "41% left",
  "detail": "Worst remaining window",
  "tone": "warn",
  "items": [
    { "id": "claude", "label": "Claude Code", "value": "82%", "remainingPercent": 82, "tone": "good" },
    { "id": "codex", "label": "Codex", "value": "41%", "remainingPercent": 41, "tone": "warn" }
  ]
}
```

The rail card is the phone's persistent view of the same data.

### Home dashboard

```json
{
  "title": "Token Harness",
  "subtitle": "Last 7 days · stored local evidence",
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

The home dashboard is shown in the empty state when no Session is selected. It also appears in the
plugin detail. Meters, stats and chart points are rendered by the shell; values are escaped and
bounded before they reach the renderer.

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

- `token-harness observe --json --since <7d|30d|all>` for the read-only dashboard (0.1.32+).
- `token-harness budget --json` and `token-harness savings --json` as the fallback for older copies.
- `token-harness plan --harness <claude|codex> --provider none --agent-routing|--disable-agent-routing --json`
  followed by `apply --plan <id> --yes --json` for the routing switches.
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
