# Harness Remote quick start

The shortest setup path uses the existing bridge through the new `harness-remote` launcher.

## Testing this PR before merge

While PR #148 is still open, the root `package.json` only exists on the feature branch, so the `npx` command must include that branch explicitly:

```bash
npx github:giuliastro/harness-remote#agent/one-command-startup
```

For OpenCode on the PR branch:

```bash
npx github:giuliastro/harness-remote#agent/one-command-startup --backend opencode
```

After #148 is merged to `main`, the shorter command becomes valid:

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

The launcher is intentionally thin: it does **not** implement the future Universal Daemon. For ACP-backed agents it starts the existing bridge; for OpenCode it detects the direct-HTTP path and prints the correct startup command.

## What it does

- finds executable `omp`, `pi`, `claude`, `codex`, and `opencode` entries on `PATH` without running them;
- auto-selects the backend when exactly one supported CLI is found;
- otherwise requires an explicit choice with `--backend`;
- binds to the LAN by default (`0.0.0.0`) and automatically generates HTTP Basic Auth credentials;
- generates credentials for loopback quick start too, so local applications/users do not get an unauthenticated bridge by default;
- keeps generated credentials out of the bridge child-process argv and passes them through environment variables instead;
- starts ACP-backed agents at port `4097` and OpenCode guidance at port `4096`, choosing the next available port when the default is busy;
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

OpenCode remains different in the current architecture: the client connects directly to the OpenCode HTTP server rather than through the ACP bridge.

If OpenCode is the only supported CLI found on `PATH`, the launcher now recognizes it and prints a ready-to-run authenticated `opencode serve` command plus the address and credentials to use in Harness Remote instead of suggesting an unrelated ACP backend.

You can request the same guidance explicitly with:

```bash
harness-remote --backend opencode
```

## Advanced/manual setup

The existing backend-specific bridge commands remain supported. Use them when you need custom adapter commands, unusual networking, browser CORS configuration, or other advanced settings documented in the main README.
