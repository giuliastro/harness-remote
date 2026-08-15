# Direct per-harness ACP bridge quick start

The one-command launcher is optional. If auto-detection or the machine daemon does not work in your environment, run the original per-harness bridge directly and configure that backend in the app exactly as before.

Run these commands from a checkout of this repository. Replace the password and root path.

## Oh My Pi (OMP)

```bash
npx --yes ./bridge \
  --backend omp \
  --host 0.0.0.0 \
  --port 4097 \
  --username omp \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The default ACP launch is `omp acp`.

## PI

```bash
npx --yes ./bridge \
  --backend pi \
  --host 0.0.0.0 \
  --port 4097 \
  --username pi \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

## Claude Code

```bash
npx --yes ./bridge \
  --backend claude \
  --host 0.0.0.0 \
  --port 4097 \
  --username claude \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

## Codex CLI

```bash
npx --yes ./bridge \
  --backend codex \
  --host 0.0.0.0 \
  --port 4097 \
  --username codex \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

## Explicit ACP command

You can also bypass the backend's default adapter launch and provide the ACP process explicitly:

```bash
npx --yes ./bridge \
  --backend pi \
  --acp-command npx \
  --acp-arg -y \
  --acp-arg @automatalabs/pi-acp@0.2.5 \
  --host 0.0.0.0 \
  --port 4097 \
  --username pi \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

For the full backend-specific notes, security caveats and troubleshooting, see [`REFERENCE.md`](../REFERENCE.md).
