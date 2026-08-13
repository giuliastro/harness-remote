# Harness Remote quick start

The shortest setup path uses the `harness-remote` launcher.

```bash
npx github:giuliastro/harness-remote
```

If more than one supported agent CLI is installed, select one explicitly:

```bash
npx github:giuliastro/harness-remote --backend codex
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

The launcher remains intentionally thin while #143 evolves toward the Universal Daemon. ACP-backed agents still use the existing bridge. OpenCode is now started and supervised directly by Harness Remote rather than requiring a second command.

## What it does

- finds executable `omp`, `pi`, `claude`, `codex`, and `opencode` entries on `PATH` without running them;
- auto-selects the backend when exactly one supported CLI is found;
- otherwise requires an explicit choice with `--backend`;
- binds to the LAN by default (`0.0.0.0`) and automatically generates HTTP Basic Auth credentials;
- generates credentials for loopback quick start too;
- keeps generated credentials out of child-process argv and passes them through environment variables;
- starts ACP-backed agents from port `4097` and OpenCode from port `4096`, choosing the next available port when the default is busy;
- for OpenCode, reports readiness only after an authenticated `/global/health` request succeeds with the generated credentials;
- supervises the OpenCode process and escalates a repeated shutdown signal from graceful `SIGTERM` to `SIGKILL`;
- prints one or more plausible LAN addresses while preferring non-virtual interfaces;
- forwards advanced bridge options such as `--root`, `--cors`, `--state-dir`, and `--log-requests` for ACP-backed agents.

Example with an installed binary when several agent CLIs are present:

```bash
harness-remote --backend codex --root ~/dev
```

For loopback-only use:

```bash
harness-remote --backend omp --host 127.0.0.1
```

The launcher still generates credentials and prints them for this loopback path.

For a fixed LAN port and your own credentials:

```bash
harness-remote \
  --backend claude \
  --port 4900 \
  --username harness \
  --password 'choose-a-strong-password'
```

## OpenCode

OpenCode remains different at the protocol layer: the Harness Remote client connects directly to the OpenCode HTTP server rather than through the ACP bridge.

The launcher now owns the process lifecycle, though. Running:

```bash
harness-remote --backend opencode
```

will start `opencode serve` itself, pass the generated credentials through `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`, verify the authenticated health endpoint, print the connection details, and keep supervising the child process until shutdown.

This means there is no second OpenCode command to copy and run manually.

## Experimental multi-host daemon

#143 now also has a real multi-host runtime entrypoint. It is intentionally separate from the default launcher while the client routing contract is still being migrated.

From a checkout:

```bash
npm run daemon -- --backend codex --host 127.0.0.1
```

or, when the repository package is installed:

```bash
harness-remote-daemon --backend codex --host 127.0.0.1
```

The daemon owns one primary ACP host plus a managed OpenCode host by default:

```text
Harness daemon :4097
  ├── Codex / Claude / OMP / PI via ACP
  └── OpenCode 127.0.0.1:4096 via managed HTTP
```

`GET /v1/machine` and `GET /global/machine` expose both hosts through the same machine registry and stable machine identity. Host lifecycle is isolated: OpenCode can become unavailable without making the ACP host disappear, and vice versa. The daemon HTTP API starts listening before eager managed hosts finish their health checks, so clients can observe `configured` and `unavailable` transitions instead of seeing the whole machine endpoint disappear during a slow host startup.

Managed OpenCode binds to `127.0.0.1` by default even if the Harness daemon itself binds to `0.0.0.0`. This avoids silently opening a second LAN service while OpenCode still uses its direct HTTP transport. If you deliberately need the managed OpenCode listener reachable beyond loopback during this migration phase, opt in explicitly:

```bash
harness-remote-daemon --backend codex --opencode-host 0.0.0.0
```

The daemon checks the managed OpenCode port before spawning it and fails with an actionable error if another service is already using that port. Multiple eager managed hosts are started concurrently so one slow host does not serialize daemon startup.

The existing session/run endpoints are still routed through the selected primary ACP backend in this slice. Agent-scoped routing over the shared machine connection is the next #143 step.

Useful migration options:

```bash
harness-remote-daemon --backend claude --opencode-port 4901
harness-remote-daemon --backend codex --opencode-command /custom/opencode
harness-remote-daemon --backend codex --opencode-host 127.0.0.2
harness-remote-daemon --backend omp --no-opencode
```

For non-loopback daemon binding, the existing bridge security rule still applies: username and password are required. The managed OpenCode listener remains loopback-only unless `--opencode-host` is supplied explicitly.

## Advanced/manual setup

The existing backend-specific bridge commands remain supported. Use them when you need custom adapter commands, unusual networking, browser CORS configuration, or other advanced settings documented in the main README.
