# Harness Remote quick start

The shortest setup path is the repository-level `harness-remote` launcher.

Run directly from GitHub:

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

The root package intentionally remains private for now: this documents a real GitHub/repository launch path without claiming that an npm registry package has already been published.

## What it does

- finds executable `omp`, `pi`, `claude`, `codex`, and `opencode` entries on `PATH` without running them;
- auto-selects the backend when exactly one supported CLI is found;
- otherwise requires an explicit choice with `--backend`;
- binds to the LAN by default (`0.0.0.0`) and automatically generates HTTP Basic Auth credentials;
- generates credentials for loopback quick start too, so local applications/users do not get an unauthenticated server by default;
- keeps generated credentials out of child-process argv and passes them through environment variables instead;
- starts ACP-backed agents through the existing bridge from port `4097`;
- starts and supervises OpenCode directly from port `4096`;
- chooses the next available port when the default is busy;
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

OpenCode remains a direct-HTTP backend: the Harness Remote client talks to the OpenCode server rather than translating it through ACP.

The launcher now manages that server for you. Running:

```bash
npx github:giuliastro/harness-remote --backend opencode
```

will:

1. generate or accept Basic Auth credentials;
2. select an available port starting at `4096`;
3. start `opencode serve` itself;
4. pass credentials through `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`, never through argv;
5. wait until the server is actually accepting connections before reporting it ready;
6. keep the OpenCode child process supervised until the launcher is stopped.

There is no second command to copy and paste. Keep the launcher process running and configure the Harness Remote client with the printed address and credentials.

This managed-host primitive is also intended to be reused by the Universal Daemon work in #143, where OpenCode and ACP-backed agents will coexist under one machine-level process manager.

## Advanced/manual setup

The existing backend-specific bridge commands and direct `opencode serve` setup remain supported. Use them when you need unusual networking or other advanced settings documented in the main README.
