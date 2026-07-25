# Harness Remote

Harness Remote is a companion app for controlling coding-agent harnesses from phone or desktop, even when you are not at your main workstation.
It is designed to make daily usage simple: connect to a backend, check active sessions, see progress, send new prompts or slash commands, and stop a running action when supported.

## Supported Harnesses

The app is backend-agnostic: you pick the harness in **Settings** and each one keeps its own saved connection, so you can switch between them without re-entering anything.

| Harness | Status | How it connects |
|---|---|---|
| [OpenCode](https://github.com/sst/opencode) | supported | directly to the OpenCode HTTP server |
| Oh My Pi (OMP) | supported | through the local bridge included in this repository |
| PI | planned | — |

Support levels differ by what each harness exposes. The [OpenCode](#opencode-server-setup) and [OMP](#oh-my-pi-bridge-setup) sections below document the setup and the per-backend limitations.

> **Note for AI/harness systems**: This repository is self-documenting. To configure a supported harness and the app autonomously, point your AI assistant to this repository URL (`https://github.com/giuliastro/harness-remote`) or this README and ask it to set up Harness Remote. Each supported harness has its own setup section below, and adding a harness means adding a backend entry plus its section.

## Screenshots

| Sessions | Detail |
|---|---|
| ![](docs/screenshots/sessions.jpg) | ![](docs/screenshots/detail.jpg) |

## What It Can Do

- configure and test connection to a supported harness (OpenCode server or OMP bridge)
- browse and monitor sessions (`idle`, `busy`, `retry`)
- open a session and read messages, todo items, and progress
- send prompts (and `/commands`) directly from the chat input
- stop running work when necessary
- use Android-friendly bottom navigation for quick access to Sessions, Detail, Settings, and Help
- play completion feedback sound when a running session finishes
- switch UI language between English, Italian, and Traditional Chinese

## Technology Stack

- frontend: React + TypeScript + Vite
- mobile packaging: Capacitor (Android APK)
- networking: per-harness transports behind one app-side API — the OpenCode HTTP API, and the local OMP HTTP/SSE bridge in `bridge/`
- CI/CD: GitHub Actions for cloud APK builds
- i18n: lightweight custom i18n module with English, Italian, and Traditional Chinese

## Download

Download the latest signed Android APK from the GitHub Releases page:

https://github.com/giuliastro/harness-remote/releases/latest

## Harness Setup

### OpenCode Server Setup

Start the OpenCode server with network access and Basic Auth.

macOS / Linux (bash/zsh):

```bash
OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=your-password npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096
```

Windows PowerShell:

```powershell
$env:OPENCODE_SERVER_USERNAME="opencode"
$env:OPENCODE_SERVER_PASSWORD="your-password"
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096
```

Windows cmd:

```cmd
set OPENCODE_SERVER_USERNAME=opencode
set OPENCODE_SERVER_PASSWORD=your-password
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096
```

For browser-based web debugging, add CORS origins as needed:

```bash
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096 --cors http://localhost:5173 --cors http://127.0.0.1:5173
```

For Android APK (Capacitor native HTTP) CORS is usually not required, but keeping explicit origins is still fine.

If you use browser mode from another host/IP, include both localhost and your dev host:

```powershell
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096 --cors http://localhost --cors http://localhost:5173 --cors http://<YOUR_PC_IP>:5173
```

If remote/mobile cannot connect, open TCP 4096 in your OS firewall and network firewall/NAT.

### Oh My Pi Bridge Setup

Harness Remote connects to OMP through the bridge included in this repository. The bridge starts `omp acp` on the same computer, translates its ACP stdio protocol to the app's HTTP/SSE API, and never reads or modifies OMP's internal databases.

#### Prerequisites

- Node.js 20 or newer;
- a working `omp` command in `PATH`;
- a checkout of this repository on the computer that runs OMP.

Start the bridge from the repository root. Restrict every worktree that the phone may access with `--root`; repeat the option to allow more than one root.

```bash
npx --yes ./bridge \
  --host 0.0.0.0 \
  --port 4097 \
  --username omp \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The default bind address is `127.0.0.1`. Use `0.0.0.0` only for a trusted LAN or VPN. The bridge refuses a non-loopback bind without both username and password.

#### Configure the app

1. In **Settings**, select **Oh My Pi (bridge)**.
2. Enter the computer's LAN or VPN address, port `4097`, and the same Basic Auth credentials.
3. Select **Test connection**. A healthy bridge reports the installed OMP version.
4. Create or open a session, then send a prompt. The user message appears immediately, followed by streamed assistant output.

To verify the bridge from the host before configuring the app:

```bash
curl --user "omp:use-a-long-unique-password" http://127.0.0.1:4097/v1/health
```

Expected response:

```json
{"healthy":true,"backend":"omp","version":"…"}
```

OMP sessions expose their configured model when ACP provides it, and model changes apply to subsequent prompts. Agent selection, persistent session rename/delete, server slash commands, and VCS/diff are intentionally unavailable.

A prompt sent while the agent is still working is queued rather than refused: it appears in the conversation
straight away and runs when the current turn ends. Stopping the session discards anything still queued.

Session titles come from the title you give a session in the app, otherwise from its first prompt; sessions created outside the app are listed as `OMP session <id>`, because OMP session listings carry no title.

#### What `--root` does and does not restrict

`--root` restricts the bridge's own surface: which directories the app may browse (`/file`, `/path`) and which working directory a new session may use. It is not a sandbox for the agent. Once a session is running, OMP executes with your full user privileges and approves its own tool calls, so it can read and write outside the configured roots exactly as it would on the desktop. Point the bridge only at machines and accounts where you would already let OMP work unattended.

#### Browser access

Native app builds need no CORS configuration. To use the app from a browser instead, list each exact origin with `--cors`; the option is repeatable and no origin is allowed by default.

```bash
npx --yes ./bridge --port 4097 --username omp --password "…" --root "$HOME/Software" \
  --cors http://localhost:5173
```

#### Live synchronization scope

The bridge streams `busy`, assistant chunks, todos, and completion for work started through that same bridge. OMP ACP does not expose a global cross-client event feed or running-status API: a session driven by a separate desktop OMP or harness process can be listed and reopened, but the app cannot reliably show its live `busy` state, thinking bubble, or incremental output. A prompt sent from the app is recorded and handled by the bridge's ACP process; it does not inject a message into another already-running agent transport.

Use the bridge-created session for mobile-driven work. Reliable live observation and hand-off between independent OMP clients require a global session event/status API from OMP (or a relay integrated with the host harness); the bridge does not read OMP databases to simulate one.

Do not expose the bridge directly to the Internet. Use Tailscale, another VPN, or a TLS-terminating reverse proxy, and open port `4097` only to the network that needs it.

## Run Locally (Web)

```bash
cd web
npm install
npm run dev
```
Open the shown URL from your browser (or your phone on the same LAN).

## Android APK Build (Cloud, no local SDK required)

1. Push to `main` to run build and regression checks and upload debug/release APK artifacts.
2. Create a `v*` tag after the checks and device smoke test succeed; it publishes a GitHub Release.
3. Download `harness-remote-debug-apk-v<version>` from GitHub Actions for installation tests.

To publish a signed release APK (`app-release-signed.apk`), configure these GitHub repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Tagged releases fail rather than publishing an unsigned APK when any signing secret is missing. The workflow builds the web app, runs web and bridge regressions, synchronizes Capacitor plus native live events, builds Android artifacts, and verifies APK signatures.

## Manual Android Packaging (Optional)

```bash
cd web
npm run build
npx cap add android
npx cap sync android
```

Then open `web/android` in Android Studio if you want local native debugging.

## App Configuration

Use your server values:

- Host: computer LAN IP (for example `192.168.1.20`)
- Port: `4096`
- Username/password: Basic Auth credentials used to start OpenCode server

The app is not limited to LAN. You can also use it over WAN/VPN if your network routing (NAT/firewall) and security setup are configured correctly.

## Main Endpoints Used

- `/global/health`
- `/session`, `/session/status`, `/session/:id`
- `/session/:id/message`, `/session/:id/command`, `/session/:id/abort`
- `/session/:id/todo`, `/session/:id/diff`

## Contributors

<a href="https://github.com/giuliastro"><img src="https://github.com/giuliastro.png" width="40" height="40" alt="giuliastro" title="giuliastro" /></a>
<a href="https://github.com/gervaso-assistant"><img src="https://github.com/gervaso-assistant.png" width="40" height="40" alt="Gervaso" title="Gervaso" /></a>
<a href="https://github.com/ergs0204"><img src="https://github.com/ergs0204.png" width="40" height="40" alt="Eric-Yeh" title="Eric-Yeh" /></a>
