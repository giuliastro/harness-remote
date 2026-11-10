# Harness Remote 4 roadmap

> **Status (2026-11-10):** the Harness 3 gates P0–P3 (#368, #369, #371, #372) are complete and shipped between 3.1 and 3.8. This document is the plan for the next line. `HARNESS_3_ROADMAP.md` remains the reference for the product thesis, the architecture boundary and the reliability rules; where the two disagree, this document wins.

## 1. Where we stand

The market for controlling coding agents from other devices has split into four groups:

| Group | Examples | Strength | Weakness |
| --- | --- | --- | --- |
| Vendor remotes | Claude Remote Control / Dispatch, Codex in ChatGPT, Cursor mobile, Copilot Mission Control | account integration | one vendor each; Codex mobile hosts are macOS-only |
| Phone-first open-source controllers | Paseo, Happy | work away from home, push notifications | depend on a relay someone has to run; thin Session fidelity; Windows is second-class |
| Desktop orchestrators | Orca, Conductor, Claude Squad | worktrees, diff review, PRs | IDE-shaped; Conductor is Mac-only |
| Cloud / enterprise platforms | Warp Oz, GitHub Agent HQ | scale, policy | cloud-first, not a personal control plane |

Harness Remote has the strongest core (native Sessions discovered wherever they started, cross-agent and cross-machine continuation with lineage, nine harnesses, first-class Windows), but it loses new users at the first contact:

1. it works only on the LAN or a VPN the user sets up;
2. the phone gets no notification when the app is in the background;
3. what an agent changed cannot be reviewed and shipped from the phone.

**Direction:** become the most reliable way to supervise the agents you already run, from anywhere and on any OS — and the only one that lets work move between agents and machines. Do not chase Orca (an agent IDE) or Paseo (editor, terminal, browser, SDK) feature by feature.

## 2. Infrastructure rule: nothing central

Harness Remote is open source and must scale to any number of users at zero running cost for the project and with no account for the user. Therefore:

- **No project-run service and no third-party runtime service** in any path a user depends on: no hosted relay, no cloud push sender, no public rendezvous or relay network, no free tier that can throttle or start charging.
- **Everything runs on the user's own machines and network.** A user may add their own VPN or their own server; Harness Remote may document that, but never require it.
- **Setup stays at the level of today's QR pairing**: anything the operating system requires is requested by the app itself in a single dialog (notification permission, battery exemption, firewall rule), never by sending the user into settings menus they have to find.
- **Honest limits** are shown in the app when a network or device makes something impossible, instead of falling back to an external service.

This replaces the "hosted relay" discussion in `HARNESS_3_ROADMAP.md` §15. Other amendments:

- **Worktrees are allowed when they are explicit**: path, branch and lifecycle always visible, never created silently for normal work.
- **Automation moves up** from "last" to after outcome/review, because scheduled and chained runs are now expected.
- **Native clients carry remote access and notifications.** Browsers cannot hold a background connection, and an HTTPS-hosted page cannot talk to a plain-HTTP or self-signed gateway, so the web app stays a LAN/desktop convenience. The Android app and the desktop app are the remote clients.
- **iOS is a non-goal** until a maintainer has Apple hardware and an Apple Developer account. Reliable background delivery on iOS is only possible through Apple's push service, which needs a central sender — incompatible with the rule above.

The reliability rules (§9) and the native-Session boundary (§4) are unchanged and gate every epic below.

## 3. Epics

Order: **E2 → E1 → E3**, then **E4** and **E5** in parallel. E2 is useful immediately on the home network and its persistent connection is the channel E1 builds on.

### E1 — Reach your machines from anywhere, without third parties

Tracking: #647

Goal: the Android app on mobile data reaches a paired machine with no external service, no account and no router configuration by the user.

Security first — this is the gate for everything else in E1. Today the gateway must never be exposed to the internet; that warning can only be lifted after:

- **device-key pairing**: the QR exchanges public keys; every connection is mutually authenticated by device key, never by password alone;
- an encrypted transport bound to those keys (pinned self-signed TLS or a Noise channel), so no certificate authority or domain is needed;
- a minimal unauthenticated surface (nothing but the handshake), rate limiting and lock-out on the handshake;
- per-device revocation from any client, effective on the next frame;
- an independent security review of the internet-facing path.

Reachability, all automatic and done by the gateway:

- **IPv6**: when the machine has a global IPv6 address, open a firewall pinhole for the gateway port and advertise it. Most mobile networks and many home ISPs provide IPv6.
- **IPv4 port mapping**: request a mapping from the home router with UPnP-IGD, NAT-PMP or PCP, renew it, and remove it on shutdown.
- **Firewall**: extend today's Windows `--allow-firewall` flow to an in-app one-time prompt on every platform that needs it.
- **Address book**: the gateway sends its current candidate addresses (LAN, IPv6, mapped IPv4) to paired devices over every live connection; the app tries them in order and remembers the last one that worked.
- **Your own relay machine**: any of the user's own machines that is reachable (a home server, a VPS they already own) can be marked "relay for my other machines" and forward encrypted traffic for them. Built into the gateway, never required.
- **Always-on host**: `npx harness-remote service install|uninstall|status` registers the gateway as a user service (Windows Task Scheduler, launchd, systemd user unit) so it survives logout and reboot. Optional "keep awake while a turn runs".

Honest limits: behind carrier-grade NAT without IPv6, or a router with port mapping disabled, no direct path exists. The app then says exactly that and points to the user's own VPN or their own relay machine. #554 (iroh) is compatible only with a relay the user runs; iroh's public relays are excluded by §2.

Diagnostics: a "Reachable from outside" check run from the phone on mobile data, reporting which path worked or why none did. Measure the success rate across real users before promising more.

Exit criteria:

- with IPv6 or a UPnP/NAT-PMP router, pair at home, switch the phone to mobile data, and run a full turn, Stop and a permission reply;
- no connection is accepted without a paired device key (verified by a negative test suite);
- revocation, address change and gateway restart reconcile without duplicate prompts;
- the security review is closed before the README warning changes;
- the real-harness release gate runs once over the external path.

### E2 — Notifications that actually arrive, with no push service

Tracking: #648

Why the earlier attempt failed (#404, removed in #410): notifications were produced inside the app's WebView process from its live connection, with no foreground service and no battery exemption. Android suspends that process in the background, so delivery stopped.

Design — the pattern used by open-source apps that do not rely on Google push (ntfy, Conversations, Home Assistant's minimal app):

- **A native Android foreground service** of type `remoteMessaging`, independent of the WebView, keeps one lightweight connection per paired machine. It shows the required low-priority "Connected to N machines" notification.
- **Two one-time prompts**, both shown by the app itself during first pairing: notification permission (Android 13+) and "allow running in background" (battery optimization exemption). No settings to hunt for.
- **Efficient connection**: the gateway sends only Attention events and small heartbeats over that channel; heartbeat interval adapts to the network; reconnect with backoff on network change. Target: negligible battery use, measured.
- **Content and actions**: triggers reuse the existing Attention transition model (needs input, permission, failed, Ready). Tapping deep-links to the exact Session. Approve/deny buttons appear only where the harness advertises the permission capability, and replies use the existing exactly-once permission path.
- **Desktop**: keep the existing desktop notifications; add a tray/background mode so they arrive with the window closed.
- **Reach**: on the home network this works as soon as E2 ships. Away from home it works wherever E1 finds a path.

Known limits, stated in the UI and docs:

- a user who force-stops the app receives nothing until they open it again (Android rule);
- a few manufacturers (some Xiaomi, Huawei, OnePlus builds) kill background services despite the exemption; the app detects the manufacturer and shows the one extra switch needed, with a link to the device-specific instructions;
- no notifications while the phone has no path to the machine (see E1 limits).

Testing without extra devices:

- automated: Android emulator in CI with the app backgrounded, its activity destroyed, and the device in Doze (`adb shell dumpsys deviceidle force-idle`), asserting delivery, deep link and no duplicate;
- a soak test measuring wake-ups and battery over several hours;
- real-device checks on at least one Pixel/Samsung and one Xiaomi-class device per release.

Exit criteria: delivery within 30 seconds in all automated scenarios, no duplicate notification for one Attention transition, no notification for a transition already seen on another device, and battery use within a documented budget.

### E3 — Review and ship from the phone

Tracking: #649

Goal: answer "what changed and what is the next safe action?" without a laptop. Builds on the existing bounded Session outcome.

Scope:

- mobile-first diff viewer (per file, collapsible, syntax-highlighted, large-diff safe);
- line comments sent back to the owning native Session as a prompt;
- commit, push and open a PR as explicit control-plane actions, using the Git and forge CLIs (`gh`, `glab`, …) already authenticated on the machine — no tokens stored by Harness Remote;
- CI status for the branch, with "send failing checks to the agent";
- every action shows machine, Project, branch and worktree before it runs.

Non-goal: an editor or file manager.

### E4 — Parallel work and agent pipelines

Tracking: #650

Goal: turn cross-agent continuation into a workflow nobody else offers.

Scope:

- explicit worktrees: create, list, open and remove from any client, with path, branch and owning Sessions visible;
- fan-out: send one prompt to several harnesses/models, each in its own worktree, and compare the outcomes side by side;
- **pipelines**: chains such as "Codex implements → Claude reviews → back to Codex with the findings", built on continuation. Each hop is a real native Session, and the portable control state (decisions, rejected paths, human gates, required checks) travels with the chain;
- a pipeline pauses on any human gate and raises Attention (and a notification, via E2).

### E5 — One inbox, budgets and light automation

Tracking: #651

Scope:

- federated inbox and search across all machines, harnesses and Projects, metadata-only (no transcript import);
- Token Harness as a first-class surface: remaining 5-hour/7-day allowance per subscription, routing switches, and an Attention warning before an allowance runs out;
- light automation: schedule a prompt or a pipeline on a machine ("tonight, run the tests and ask Claude to fix failures"), run by the gateway's own scheduler, with the run appearing as a normal native Session.

## 4. Sequencing rules

When two pieces of work compete, prefer in order:

1. correctness, data integrity and security of anything reachable from outside;
2. notification reliability and reach (E2, E1);
3. outcome review (E3);
4. pipelines and parallel work (E4);
5. inbox, budgets and automation (E5);
6. new harness count.

## 5. Release distribution

How each release is packaged and made known is described in [RELEASE_DISTRIBUTION.md](RELEASE_DISTRIBUTION.md) (tracking: #652).
