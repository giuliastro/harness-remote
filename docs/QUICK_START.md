# Harness Remote quick start

The shortest setup path uses the `harness-remote` launcher.

```bash
npx github:giuliastro/harness-remote
```

From a local checkout the equivalent path is:

```bash
npm install
npm start
```

When installed as a repository/package binary, the command is:

```bash
harness-remote
```

The root package intentionally remains private for now: this documents a real GitHub/repository launch path without claiming that an npm package has already been published.

## What the one command does

The launcher inspects `PATH` without executing discovered agent binaries and chooses the least-friction compatible runtime:

- with exactly one supported CLI, it preserves the existing single-backend startup path;
- with multiple supported CLIs and at least one ACP-backed agent, it starts the machine daemon automatically;
- the daemon selects one detected ACP backend as its primary host and includes managed OpenCode when OpenCode is installed;
- `--backend <name>` selects the ACP primary on a multi-agent machine;
- `--single --backend <name>` explicitly opts out of the daemon and forces the legacy single-backend path;
- if managed OpenCode is included, the launcher chooses a free loopback port automatically instead of assuming 4096 is unused;
- credentials are generated automatically and kept out of child-process argv;
- the LAN address and credentials to enter in the client are printed before startup continues.

The supported CLI names are `omp`, `pi`, `claude`, `codex`, and `opencode`.

For example, on a workstation with Codex, Claude Code and OpenCode installed, the plain command:

```bash
harness-remote
```

starts one machine daemon instead of failing and asking you to choose a backend. The launcher reports the CLIs it detected, selects an ACP primary, finds a free loopback port for managed OpenCode, and exposes the machine through one authenticated daemon connection.

The current automatic multi-host shape is deliberately precise:

```text
Harness daemon :4097
  ├── one detected ACP primary (Codex / Claude / OMP / PI)
  └── OpenCode, when installed, as a managed loopback HTTP host
```

Other detected ACP CLIs are reported by discovery but are not all instantiated concurrently by this startup slice yet. The daemon API and client are already agent-scoped, so adding more ACP host instances does not require another client transport change.

## Choose the daemon primary or force one backend

On a multi-agent machine, choose the daemon's ACP primary with:

```bash
harness-remote --backend codex --root ~/dev
```

To deliberately use the old single-agent runtime instead:

```bash
harness-remote --single --backend codex --root ~/dev
```

For loopback-only single-agent use:

```bash
harness-remote --single --backend omp --host 127.0.0.1
```

For a fixed LAN port and your own credentials:

```bash
harness-remote \
  --backend claude \
  --port 4900 \
  --username harness \
  --password 'choose-a-strong-password'
```

If OpenCode is present on a multi-agent machine, an existing process already using `127.0.0.1:4096` does not break startup: Harness scans forward for a free managed OpenCode port and passes it to the daemon. You can still choose one explicitly with `--opencode-port`.

## OpenCode

When OpenCode is the only selected backend, Harness Remote starts `opencode serve` itself, passes credentials through `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`, verifies the authenticated health endpoint, prints connection details, and supervises the child process until shutdown.

```bash
harness-remote --backend opencode
```

When the automatic machine daemon path is selected, OpenCode instead stays on its managed loopback listener and the client reaches it through the daemon's agent-scoped proxy. The phone/web/desktop client therefore does not need direct access to the internal OpenCode port.

## Machine daemon

The daemon can still be started explicitly when you want advanced options:

```bash
npm run daemon -- --backend codex --host 127.0.0.1
```

or:

```bash
harness-remote-daemon --backend codex --host 127.0.0.1
```

`GET /v1/machine` and `GET /global/machine` expose the shared machine registry and stable machine identity. Host lifecycle is isolated: an unavailable managed host does not make the machine disappear.

Agent-scoped requests share the daemon connection:

```text
/v1/agents/codex/session
/v1/agents/codex/global/event
/v1/agents/opencode/session
/v1/agents/opencode/global/event
```

The selected primary ACP agent is routed through the normalized bridge API. Managed OpenCode requests are streamed through the daemon to the loopback process; external credentials are authenticated at the daemon boundary and replaced with the managed host credentials for the internal request. Legacy unprefixed routes remain available during migration.

Managed OpenCode binds to `127.0.0.1` by default even when the daemon binds to `0.0.0.0`. Wider exposure is explicit:

```bash
harness-remote-daemon --backend codex --opencode-host 0.0.0.0
```

Useful daemon options:

```bash
harness-remote-daemon --backend claude --opencode-port 4901
harness-remote-daemon --backend codex --opencode-command /custom/opencode
harness-remote-daemon --backend codex --opencode-host 127.0.0.2
harness-remote-daemon --backend omp --no-opencode
```

For non-loopback daemon binding, the existing security rule still applies: username and password are required. The managed OpenCode listener remains loopback-only unless `--opencode-host` is supplied explicitly.

## Advanced/manual setup

The existing backend-specific bridge commands remain supported. Use them when you need custom adapter commands, unusual networking, browser CORS configuration, or other advanced settings documented in `REFERENCE.md`.
