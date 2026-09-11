# Harness Remote quick start

Harness Remote has two parts: a launcher on the machine where your repositories and coding agents
live, and a client you open from web, desktop or Android. The launcher runs the work; the client
lets you see and continue the native Sessions it exposes.

## Upgrading from Harness Remote 2.x

Harness Remote 3 changes the normal startup contract. HR2 commonly connected the client directly to one OpenCode server or one standalone ACP bridge per harness. HR3 is machine-first: the client expects a Harness **Machine** endpoint and discovers Projects, harnesses and native Sessions through it.

- Existing standalone ACP bridge commands such as `npx --yes ./bridge --backend omp|pi|claude|codex ...` are still supported as compatibility paths. They can expose native Sessions, but they do not provide the complete HR3 Project catalog/new-Session workflow.
- A direct `opencode serve` process from an HR2 setup is not a Harness Machine endpoint and cannot be added under **Machines** in HR3.
- HR2 saved server profiles are kept in storage for legacy code paths, but they are not automatically converted into HR3 `workspaceMachines`. After upgrading, add the machine again in **Machines → Add machine**.
- For the full HR3 experience, stop the old per-harness public endpoints and use the launcher or machine daemon described below. Legacy single-backend startup is intended for compatibility, not as the preferred HR3 onboarding path.

## Start a machine and open the client

Install Node.js 20+ and at least one supported coding-agent CLI on the machine with your code, then
start Harness Remote:

```bash
npx github:giuliastro/harness-remote \
  --host 0.0.0.0 \
  --port 4097 \
  --username harness \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software" \
  --cors http://localhost:5173
```

`--root` is the directory boundary used when choosing Projects. The launcher prints the machine
address and credentials you will enter in the client, the harnesses that will be available through
that machine, and the next step to add it under **Machines → Add machine**.

To use the web/PWA frontend from a checkout:

```bash
cd harness-remote/web
npm ci
npm run dev
```

Open the URL Vite prints, normally `http://localhost:5173`, then choose **Machines** > **Add
machine** and enter the address, port, username and password from the launcher. The `--cors` value
above permits that browser origin; use the exact origin if you host the frontend elsewhere.

Desktop and Android clients use the same machine address and credentials. Open the installed client
and add the machine there; they do not need browser CORS configuration.

From a local repository checkout, the equivalent launcher command is:

```bash
npm start -- \
  --host 0.0.0.0 \
  --port 4097 \
  --username harness \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software" \
  --cors http://localhost:5173
```

When installed as a repository/package binary, the command is `harness-remote`. The root package
remains private: the GitHub/repository launch path is intentional and does not imply that an npm
package has been published.

## What the one command does

The launcher inspects `PATH` without executing discovered agent binaries and chooses the least-friction compatible runtime:

- with exactly one supported CLI, it preserves the existing single-backend startup path;
- with multiple supported CLIs and at least one ACP-backed agent, it starts the machine daemon automatically;
- the daemon exposes every detected ACP-backed agent through the same machine endpoint and selects one of them as the primary for legacy/unprefixed routing;
- managed OpenCode is included when OpenCode is installed and starts lazily on first use;
- `--backend <name>` selects the ACP primary on a multi-agent machine;
- `--single --backend <name>` explicitly opts out of the daemon and forces the legacy single-backend path;
- if managed OpenCode is included, the launcher chooses a free loopback port automatically instead of assuming 4096 is unused;
- credentials are generated automatically and kept out of child-process argv;
- the LAN address, credentials, available harnesses and next client action are printed before startup continues.

The supported CLI names are `omp`, `pi`, `claude`, `codex`, and `opencode`.

For example, on a workstation with Codex, Claude Code and OpenCode installed, the plain command:

```bash
harness-remote
```

starts one machine daemon instead of failing and asking you to choose a backend. The launcher reports the CLIs it detected, selects an ACP primary, finds a free loopback port for managed OpenCode, and exposes the machine through one authenticated daemon connection.

The current automatic multi-host shape is:

```text
Harness daemon :4097
  ├── Codex / Claude / OMP / PI — every detected ACP harness
  │   └── one selected as primary for legacy/unprefixed routing
  └── OpenCode, when installed — managed loopback host, started on first use
```

The daemon registers the detected ACP harnesses independently, so choosing one primary does not hide the others from agent-scoped machine APIs. Harness processes may still be started lazily by their adapters; “available” describes what the machine endpoint exposes, not a promise that every CLI process is already resident before first use.

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
