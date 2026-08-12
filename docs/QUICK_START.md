# Harness Remote quick start

The shortest setup path uses the existing bridge through the new `harness-remote` launcher.

Run the repository directly with `npx`:

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

The launcher is intentionally thin: it does **not** implement the future Universal Daemon. It starts one current ACP-backed Harness backend using the existing bridge.

## What it does

- detects `omp`, `pi`, `claude`, and `codex` executables on `PATH` without running them;
- auto-selects the backend when exactly one supported CLI is detected;
- otherwise requires an explicit choice with `--backend`;
- binds to the LAN by default (`0.0.0.0`) and automatically generates HTTP Basic Auth credentials;
- starts at port `4097` and chooses the next available port when the default is busy;
- prints the address and credentials to enter in the Harness Remote client;
- forwards advanced bridge options such as `--root`, `--cors`, `--state-dir`, and `--log-requests`.

Example with an installed binary when several agent CLIs are present:

```bash
harness-remote --backend codex --root ~/dev
```

For loopback-only use:

```bash
harness-remote --backend omp --host 127.0.0.1
```

For a fixed LAN port and your own credentials:

```bash
harness-remote \
  --backend claude \
  --port 4900 \
  --username harness \
  --password 'choose-a-strong-password'
```

## OpenCode

OpenCode remains different in the current architecture: the client connects directly to the OpenCode HTTP server, so the bridge launcher does not wrap or replace OpenCode startup yet.

## Advanced/manual setup

The existing backend-specific bridge commands remain supported. Use them when you need custom adapter commands, unusual networking, browser CORS configuration, or other advanced settings documented in the main README.
