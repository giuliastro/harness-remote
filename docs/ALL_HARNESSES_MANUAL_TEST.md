# All-harness manual test — OpenCode 2 development branch

Prepared command for Giulio:

```bash
bash /home/giulio/Software/harness-remote-all-harnesses-run-test.sh
```

This launches the `codex/opencode2-official` checkout, prepares the web build and
test-only Codex/PI ACP adapters, starts backend and frontend on free loopback
ports, and opens the browser. Leave its terminal open; Ctrl+C stops its own
process groups. `--check` validates startup and tears the servers down.

The daemon runs from `/home/giulio/Software` and exposes that directory plus its
immediate Git projects, including `harness-remote`, `token-harness`, `HarnessTrim`
and the existing PR549 sandbox. The project picker also contains **Software**
itself, useful for Sessions originally created from that directory. Nested Git
repositories need an additional configured root if they are not listed.

Harness Remote state and logs live separately under
`~/.cache/harness-remote/issue552-all-harnesses`. Native harness configuration,
credentials and Session stores are the usual ones. Opening an existing Session
reads its real history; continuing it writes to that same native Session. Use an
existing disposable Session or create a test Session in
`/home/giulio/Software/harness-remote-pr549-sandbox` when testing Send/Stop.

Unlike the v2-only sandbox launcher, this launcher inherits the installed
OpenCode CLI and its normal data directory. On this machine that CLI is currently
v2.0.11; the separate v2-only launcher uses v2.0.28 with isolated native data.
No global CLI upgrade or credential change is performed here.

## Add the machine

Use **Machines → Add machine** and the actual values printed by the script:

- Name: `Harness Remote all harnesses`
- Host: `127.0.0.1`
- Port: normally `4910`, otherwise the free machine port printed by the script
- Username: `hr552`
- Password: `hr552`

The browser normally opens at `http://127.0.0.1:4911`; an occupied port causes the
script to print and open another free port. Use **Test connection**, **Save
machine**, then **Go to sessions**.

## Models and scope

| Harness | Model approved for real prompts |
| --- | --- |
| Codex | Luna — `gpt-6-luna` |
| OMP / Oh My Pi | OpenRouter Free — `openrouter/free` |
| PI | `qwen/qwen3.8-27b:free` through OpenRouter |
| OpenCode 2 | LongCat 2.5 Preview Free — `opencode/longcat-2.5-preview-free` |

Claude remains excluded from real prompt tests until Giulio explicitly
reauthorizes it. Copilot and MiMo may appear if installed; choose a model
explicitly before including either in real prompt tests. The launcher sends no
prompts and changes no native model defaults. If an approved model is missing,
report it rather than automatically substituting one.

The test uses Codex ACP 1.13.1 and PI ACP 0.5.0 installed under the test directory.
These adapters are preferred only in the launched daemon's PATH; the branch's
package fallback pins and the normal desktop environment remain unchanged.

## Checklist for each approved harness

1. **Discovery:** open Sessions, filter by the harness, and expand Software or an
   existing project. Expect its native Sessions with the correct harness label.
2. **History:** open an existing Session without sending anything. Expect its
   transcript and the native model where the harness advertises it.
3. **Creation:** create a test Session in `harness-remote-pr549-sandbox`; select
   the approved model. Inspect and choose a reasoning variant only if advertised.
4. **Response:** send `Reply with exactly HR-552-OK. Do not use tools.` Expect
   one visible assistant response and a terminal Ready state.
5. **Stop/continue:** ask for a long numbered list without tools, press Stop,
   then send another short prompt. Expect Stop to settle and the same Session to
   accept the next prompt without a stuck spinner or duplicate response.
6. **Reopen:** switch to another Session, return, then reload the browser and
   reopen the test Session. Expect retained transcript/model and no duplication.
7. **Restart:** stop the launcher with Ctrl+C, relaunch, and reconnect. Expect
   native Sessions to remain discoverable. Restore the printed machine port if
   it changed. Do not resume a Session being actively written by another client.

OpenCode Legacy remains a separate Windows regression using v1 on the unchanged
Windows machine. It should be labeled **OpenCode Legacy**, preserving old profiles.

## Verification record

Agent startup verification on 13 October 2026 passed: both listeners became
reachable, authenticated machine metadata listed 7 harnesses (Codex, OMP, PI,
Claude, Copilot, OpenCode 2 and MiMo), and the project endpoint listed 13 projects.
The daemon was launched with `/home/giulio/Software` as its working directory.
`--check` stopped both owned process groups afterwards. No prompts or model calls
were made for this startup check.

Giulio confirmed that the all-harness test environment works on 13 October 2026
and approved merging the integration. This manual confirmation is separate from
the agent's startup checks. A separate Windows OpenCode Legacy run has not been
recorded; Claude Code real prompt tests remain disabled.
