# Contributing to Harness Remote

Thanks for wanting to work on this. Harness Remote is a companion app for driving coding-agent
harnesses from a phone or a desktop browser. It is deliberately harness-agnostic: OpenCode, Oh My Pi
(OMP), PI, Claude Code and Codex CLI are supported today. Adding a harness should mean adding a
profile entry and its setup section, never a special case threaded through the app.

This document is long on purpose. Read the section that matches what you are touching, or all of it
if you are having an agent do the work.

## Repository layout

| Path | What it is |
|---|---|
| `web/` | React + TypeScript + Vite app, packaged for Android with Capacitor or for desktop with Electron |
| `web/src/` | Application source. `App.tsx` holds most UI, `api.ts` client, `desktopBridge.ts` renderer adapter |
| `web/electron/` | Main/preload shell, IPC contract, profile registry, HTTP and SSE transports |
| `web/native-android/` | Java sources copied into generated Android project — see [Android packaging](#android-packaging) |
| `bridge/` | Local HTTP/SSE server translating app API to ACP over stdio, for OMP, PI, Claude Code and Codex CLI |
| `.github/workflows/` | Cloud APK/AAB and Windows/macOS/Linux Electron builds |

## Prerequisites

- **Node.js 22 or newer.** `web/` needs `npm install`; `bridge/` has no dependencies at all and
  runs on the standard library, so do not look for a lockfile there.
- **A harness to talk to.** An OpenCode server or a working bridge-backed harness: OMP, PI,
  Claude Code or Codex CLI. You can develop UI-only changes without one, but see
  [Test against a real agent](#test-against-a-real-agent)
- **Desktop packaging:** electron-builder does not cross-compile, so each artifact is built and
  smoke-tested on its own OS. CI covers all three; locally you can only check the one you are on.
- **No Android SDK required.** CI builds the APK. You only need one for local native debugging.

## Getting it running

```bash
cd web
npm install
npm run dev
```

Open printed URL. Configure connection in **Settings**; each backend keeps its own saved connection,
so switching between them does not lose anything.

### Against the desktop app

Build and launch packaged desktop app:

```bash
cd web
npm run electron:dev
```

For request/SSE transport tests without live server, use `npm run test:desktop`. Electron owns
network targets from saved profile IDs; renderer code must never add arbitrary URL or header inputs.

### Against OpenCode

Start the server with Basic Auth and, for browser development, CORS origins. The README's
[OpenCode Server Setup](README.md#opencode-server-setup) has the exact commands.

### Against OMP

OMP speaks ACP over stdio rather than HTTP, so the app talks to it through the bridge:

```bash
cd bridge
node src/cli.js --port 4097 --root "$HOME/your-project" --cors http://localhost:5173
```

`--cors` matters for browser/PWA development and is easy to forget: without it browser blocks every
request. Installed Electron and Android builds do not need it. Bridge binds to `127.0.0.1` by
default and refuses non-loopback bind without `--username` and `--password`.

## The checks you must run

CI runs all of these before it packages anything, so a PR that skips them will fail there instead:

```bash
cd web
npm run build
npm run build:electron
npm run test:i18n
npm run test:config
npm run test:ui
npm run test:settings
npm run test:model
npm run test:events
npm run test:profiles
npm run test:desktop

cd ../bridge
npm test
```

`npm run build` is `tsc -b && vite build`, so it type-checks as well as bundles.

## The rule that matters most: every change lives on two backends

This is the way the app has actually been broken, twice. A feature written against one harness will
reach for an endpoint the other does not have, and the failure shows up as a red error in the user's
face rather than a missing feature.

The bridge implements a deliberate subset of the app's API:

**Implemented:** `/v1/health`, `/global/health`, `/v1/capabilities`, `/v1/events`, `/global/event`,
`/session` (list and create), `/v1/sessions`, `/experimental/session`, `/session/status`, `/path`,
`/file`, `/command` (the harness catalog from `available_commands_update`), `/agent` (empty),
`/config/providers`, and on a session:
`message`, `todo`, `diff` (empty), `prompt_async`, `command`, `abort`, rename, delete, plus generic
action discovery and invocation at `action` and `action/{name}`. OMP currently maps the optional
`omp-undo-redo` extension onto the generic action API only after ACP advertises both commands.

**Not implemented — anything else 404s**, including `/question` and its replies, `/project/current`,
`/vcs`, and `/file/status`.

When you add a call, pick one of two patterns already used in the codebase:

**Gate it** when the feature is meaningless without the endpoint. There are already fifteen such
gates in `App.tsx`, covering agent selection, session rename and delete, diffs and interactive
questions:

```ts
config.backend === "omp" ? Promise.resolve([]) : api.loadQuestions(config, directory).catch(() => [])
```

**Let it fail soft** when the feature is decoration that can simply be absent. The project dashboard
does this — `/project/current`, `/vcs` and `/file/status` all 404 against the bridge and the panel
just renders without them:

```ts
api.loadProjectCurrent(config, directory).catch(() => null)
```

Do not add a third pattern where an unimplemented endpoint surfaces an error to the user.

When a feature is genuinely unavailable on a backend, say so in the README's harness section rather
than leaving the user to discover a dead button.

## The other rule: every UI change lives in two layouts

Below 781px the app is a single view with bottom navigation; above it, a permanent sidebar sits next
to the chat. `App.tsx` keeps an `isDesktop` flag from a `matchMedia` query on that exact breakpoint,
so the JS layout and the stylesheet's `@media (max-width: 780px)` block never disagree. Change one
and you have to change the other.

Two things make this easy to get wrong:

- **The scroller moves.** On mobile the page scrolls and `.messages` is a plain block; on desktop the
  chat pane is height-bounded and `.messages` is the scroller. Anything reading or setting scroll
  position has to ask which one is live rather than assuming — `scrollsItself()` and
  `messagesScrollMetrics()` exist for that.
- **The session list is rendered twice.** `renderSessionCard` is shared by the mobile panel and the
  desktop sidebar, with the sidebar's compact row shape coming from CSS overrides under
  `.sidebar-sessions`. Add a field to the card and check it in both, rather than forking the markup.

Resize the browser window across 781px before opening a PR that touches layout. It is the cheapest
check in this document and it catches most of these.

## How the tests work here, and how to change one

The suites under `web/src/*-regression.test.mjs` are unusual: they assert against the **source text**
of `App.tsx` and its siblings rather than rendering anything. There is no DOM test runner in this
project. These are cheap guards that pin specific regressions we have already paid for once.

This will surprise you the first time a code change fails a test whose message talks about a string.
That is working as intended. What matters is how you fix it.

**Assert the invariant, not the shape of the code.** A test that forbids an identifier will block a
legitimate refactor; a test that checks the behavioural guarantee survives it. A real example from
this repo: an assertion once required that `messageScrollSignature` did not exist, as a proxy for
"background refreshes must not force the conversation to scroll". Streamed rendering needed that
value back, and the right fix was not to delete the test but to assert the actual guarantee — that
content-driven scrolling is gated on the user already being pinned to the bottom:

```js
assert.ok(
  /if \(!stickToBottomRef\.current\) return[\s\S]*?scrollMessagesToBottom\("auto"\)/.test(app),
  'content-driven auto-scroll must be gated on the user already being pinned to the bottom'
)
```

If you cannot express the invariant, that is a signal the guard belongs somewhere else — a unit test
against an extracted function, as `web/src/serverConfig.ts` and `test:config` do.

**Never weaken these two.** `test:config` protects against a saved configuration that cannot be
loaded: a half-typed host such as `http://` used to throw while rendering, which unmounted the app
and, because the value had already been persisted, reproduced a blank screen on every launch. The
guard in the autosave effect, and every `isValidServerConfig` check that gates a connection, are what
prevent that.
The `ErrorBoundary` in `main.tsx` is the backstop that keeps any future crash recoverable from
inside the app.

## Test against a real agent

Every bug that reached a user came from a real agent behaving unlike the spec, not from a logic error
the fakes could have caught. Observed with OMP 17.1.3:

- it never echoes the prompt you submitted, so a deduplication scheme that assumes an echo silently
  ate the user's message;
- its session listings carry no title, so every session rendered with the same placeholder;
- it does not emit ACP `agent_plan`, so the plan panel stays empty;
- it approves its own tool calls and sends no permission requests.

Every quirk found this way is recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md), together with
what breaks if it changes. Read it before touching a harness integration, and update it in the same
commit when you learn something new.

The fakes in `bridge/test/` exist to keep fixed behaviour fixed. They are not evidence about how an
agent behaves. When you add support for something, drive it with the real thing at least once, then
encode what you observed in a fake.

## Internationalisation

The UI ships in English, Italian, Traditional Chinese and Simplified Chinese, in one small module with no framework.
`test:i18n` enforces key parity, so a string added to one language and not the others fails the
suite. Add all four.

## Android packaging

You do not need an Android SDK: pushing to `main` builds debug and release APK artifacts, and a `v*`
tag publishes a release. Tagged builds fail rather than publishing unsigned when a signing secret is
missing.

One trap worth knowing. If you touch anything in `web/native-android/`, sync with:

```bash
npm run cap:sync:android
```

A plain `npx cap sync android` does **not** copy those Java sources into the generated project, so
your change is silently dropped and the app runs the previous version of the native plugin.

## Cutting a release

Bump `version` in `web/package.json`, commit it as `chore: release vX.Y.Z`, then tag that commit and
push both. Everything else — the version code, the Android metadata, the signed APK, the GitHub
release — is derived from that one field by CI.

```bash
git tag -a v2.4.0 --cleanup=verbatim -F release-notes.txt
git push origin main && git push origin v2.4.0
```

**`--cleanup=verbatim` is not optional.** Git's default cleanup strips every line that starts with
`#` as a comment, which silently deletes both `##` headings out of the message below — the tag looks
fine, and the release renders two bullet lists with nothing naming them. Check before pushing:

```bash
git tag -l --format='%(contents:body)' v2.4.0
```

**The tag annotation is the release notes.** CI publishes its body verbatim between its own
`## Release` heading and the build notes, so write those two sections as bullets and nothing else:

```
Harness Remote v2.4.0

## What's Changed

* One line per user-visible change, most interesting first
* No "by @someone", no pull request numbers

## Contributors

* **Special thanks to [@handle](https://github.com/handle)** (Real Name) — what they built, and why it stands out
* [@handle](https://github.com/handle) (Real Name) — what they contributed
```

The first line is the subject and is dropped from the body, so it can repeat the version.

**Credit contributors, not the merge.** GitHub's generated notes are switched off deliberately. They
list one bullet per pull request ending in `by @<whoever pressed merge>`, which on this repo means
the maintainer collects credit for work other people did — v2.3.0 read as though the maintainer had
written the desktop layout. Keep the bullets; they are the right format. Just describe the change and
stop there. Then name the people whose work is in the release, say what each contributed, and give
the largest contribution a `Special thanks`. Anyone who wants it attributed commit by commit has the
full changelog link that CI appends.

## The bridge is a network service

Treat these three areas as security-sensitive and explain your reasoning in the PR when you change
them:

- **Authentication.** Basic Auth compared in constant time. The bridge refuses to bind beyond
  loopback without credentials.
- **The `--root` boundary.** It restricts what the bridge exposes: which directories the app may
  browse and where a session may run. It is **not** a sandbox for the agent, which runs with full
  user privileges — do not describe it as one.
- **CORS.** Off by default; each origin must be listed explicitly, because credentialed CORS cannot
  use a wildcard.

## Commits and pull requests

Commit subjects use a conventional prefix. The ones actually in use here are `fix:`, `feat:`,
`docs:`, `chore:`, `perf:` and `ci:`, with an optional scope such as `fix(bridge):`.

Write the body to explain **why**, not what — the diff already says what. If a change fixes
something subtle, say what the failure looked like and how you confirmed it is gone. A commit that
records the reasoning is worth more than one that records the edit.

Group commits by intent rather than by the order you happened to write them, and keep each one
building and passing on its own so a bisect lands somewhere useful.

In the PR, say how you verified the change, and whether you tested against a real harness or only
against the fakes. Both are acceptable; which one it was is not obvious from the diff.

**Your commits stay yours.** We merge contributions rather than re-implementing them, and anything
that needs changing afterwards goes in separate commits on top. Squashing is up to you.

## Where to start

- [Open issues](https://github.com/giuliastro/harness-remote/issues), especially any labelled
  [`help wanted`](https://github.com/giuliastro/harness-remote/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
  A new harness is the obvious next step: the profile mechanism in `bridge/src/harness-profiles.js`
  is what PI, Claude Code and Codex CLI were added through, so it is a well-worn path rather than
  new ground.
- Bug reports from real use are genuinely valuable here, for the reason in
  [Test against a real agent](#test-against-a-real-agent).
- Translations, if the UI does not speak your language.

Questions are welcome in an issue before you write anything, especially for a large change — it is
cheaper for both of us than a rebase.
