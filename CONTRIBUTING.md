# Contributing to Harness Remote

Thanks for wanting to work on this. Harness Remote is a companion app for driving coding-agent
harnesses from a phone. OpenCode, Oh My Pi (OMP), and PI are supported. Adding a harness means
adding a backend entry, its setup section, and its capability profile; never thread a harness-specific
condition through the app.

This document is long on purpose. Read the section that matches what you are touching, or all of it
if you are having an agent do the work.

## Repository layout

| Path | What it is |
|---|---|
| `web/` | The app: React + TypeScript + Vite, packaged for Android with Capacitor |
| `web/src/` | Application source. `App.tsx` holds most of the UI, `api.ts` the HTTP client, `i18n.ts` the translations |
| `web/native-android/` | Java sources copied into the generated Android project — see [Android packaging](#android-packaging) |
| `bridge/` | A local HTTP/SSE server backed by a harness driver; OMP and PI use its ACP transport |
| `.github/workflows/` | Cloud APK and AAB builds |
| `OMP-INTEGRATION-PLAN.md` | Design notes and findings from the OMP integration, in Italian |

## Prerequisites

- **Node.js 20 or newer.** `web/` needs `npm install`; `bridge/` has no dependencies at all and
  runs on the standard library, so do not look for a lockfile there.
- **A harness to talk to.** Use an OpenCode server, a working `omp` command, or PI plus `pi-acp`.
  You can develop UI-only changes without one, but see [Test against a real agent](#test-against-a-real-agent)
  before assuming that is enough.
- **No Android SDK required.** CI builds the APK. You only need one for local native debugging.

## Getting it running

```bash
cd web
npm install
npm run dev
```

Open the printed URL. Configure the connection in **Settings**; each backend keeps its own saved
connection, so switching between them does not lose anything.

### Against OpenCode

Start the server with Basic Auth and, for browser development, CORS origins. The README's
[OpenCode Server Setup](README.md#opencode-server-setup) has the exact commands.

### Against OMP or PI

OMP and PI speak ACP over stdio rather than the app's HTTP API, so the app talks to them through the
bridge. OMP is the default profile; add `--harness pi --pi-bin "$(command -v pi)"` for PI:

```bash
cd bridge
node src/cli.js --port 4097 --root "$HOME/your-project" --cors http://localhost:5173
```

`--cors` matters for browser development and is easy to forget: without it the browser blocks every
request and the app just looks broken. Native builds do not need it. The bridge binds to
`127.0.0.1` by default and refuses any non-loopback bind without `--username` and `--password`.

## The checks you must run

CI runs all of these before it packages anything, so a PR that skips them will fail there instead:

```bash
cd web
npm run build
npm run test:i18n
npm run test:config
npm run test:ui
npm run test:settings
npm run test:model
npm run test:events

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
`/file`, `/command` (empty), `/agent` (empty), `/config/providers`, and on a session:
`message`, `todo`, `diff` (empty), `prompt_async`, `abort`.

**Not implemented — anything else 404s**, including `/question` and its replies, `/project/current`,
`/vcs`, `/file/status`, `/session/{id}/command`, and renaming or deleting a session.

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

The fakes in `bridge/test/` exist to keep fixed behaviour fixed. They are not evidence about how an
agent behaves. When you add support for something, drive it with the real thing at least once, then
encode what you observed in a fake.

## Internationalisation

The UI ships in English, Italian and Traditional Chinese, in one small module with no framework.
`test:i18n` enforces key parity, so a string added to one language and not the others fails the
suite. Add all three.

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

- [#36](https://github.com/giuliastro/harness-remote/issues/36) — **PI support**, the next planned
  harness, with the groundwork mapped out including the two hard-coded assumptions in the bridge
  that need generalising.
- Issues labelled [`help wanted`](https://github.com/giuliastro/harness-remote/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
- Bug reports from real use are genuinely valuable here, for the reason in
  [Test against a real agent](#test-against-a-real-agent).
- Translations, if the UI does not speak your language.

Questions are welcome in an issue before you write anything, especially for a large change — it is
cheaper for both of us than a rebase.
