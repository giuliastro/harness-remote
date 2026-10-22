# Codex discovery and machine layout: regression checks

Base: `main`, `e787fb9d`. Tests run on Giulio's Linux machine on 17 October 2026.

## Changes

- Discover Codex inside the desktop application, preserving executable overrides and CLI discovery.
- Launch its ACP adapter with the discovered executable and reuse cached authentication rather than invoking interactive authentication at startup.
- Read journal history from the same `CODEX_HOME` as the native process.
- Display the agent as **Codex**, keeping backend IDs, commands and model IDs unchanged.
- Place mobile machine actions above full-width machine details and project folders.
- During regression testing, reproduce an existing OpenCode 2 continuation failure: native effort `default` was restored as an explicit model variant that the catalog did not advertise. Add provider metadata treating that sentinel as no explicit variant in both ACP config restoration and native export paging; preserve actual effort values and strict catalog validation.

## Interactive checks

The agent exercised the shared web renderer against real local harness processes with sandbox projects. These are UI flow tests, not just HTTP probes. Native Electron startup/IPC checks are listed separately. Existing user conversations were not prompted or modified.

| Harness | Authorized model | Result |
| --- | --- | --- |
| Codex | `gpt-6-luna` | Earlier UI tests covered a response, stop, continuation and history reopening. Giulio subsequently confirmed native session discovery and a real prompt in Electron after the authentication correction. |
| OMP | `openrouter/free`, `auto` | Create, model/variant selection, response, stop, continuation response and reopened history passed. `off` was rejected by the provider because reasoning is mandatory; selecting `auto` recovered the same session. A fresh session also responded after the OpenCode sentinel change. |
| MiMo | `openai/gpt-6-luna`, `low` | Create, model/variant selection, response, stop, continuation response and reopened history passed. A fresh session also responded after the OpenCode sentinel change. |
| OpenCode 2 | `opencode/nemotron-3.5-lightning-free` (authorized free alternative) | Creation and first response passed. Reopening exposed a second path carrying `variant:default` from native export paging; after normalizing this path, the same session reopened and replied `VERIFY_OC2_AFTER_REOPEN` without reselecting the model. Stop returned control and native history marked the interrupted turn. Post-stop continuation replied `VERIFY_OC2_RESUMED_FINAL`. The free model was slow to start on subsequent turns (roughly one minute); a second stop during reasoning also returned control and the next prompt succeeded. No permanent post-stop hang was observed. A final app reload and history reopening preserved the successful answer; native export labels the stopped turns `Step interrupted`. |
| PI | `openrouter/free`, `low` (Free Models Router) | Authorized replacement after the old Qwen model returned 404. Create, model/variant selection, response, stop, continuation response, app reload and transcript reopening passed. |
| Copilot | `copilot/auto` | Create, Auto selection, response, stop, continuation response, app reload and transcript reopening passed. |
| Claude Code | Excluded | No Claude prompts or sessions created. |

Mobile machine cards were checked at 375px, 390px and landscape width, including an unreachable machine and Retry. Incorrect credentials produced HTTP 401 in the connection editor. The pairing dialog correctly reported that the loopback-only test daemon cannot accept a phone connection.

## Automatic checks

- Full bridge suite passed before PR creation: 729 tests, zero failures.
- 180 focused bridge tests also passed on the final bridge sources, covering ACP clients, provider metadata/runtime, model restoration, exact catalog validation, server behavior, Codex discovery/history and launch selection.
- 110 product UI regression tests passed. Before PR creation, the complete required web suite (`npm run test:ci:full`), production web build and Electron TypeScript build also passed.
- Frontend model selection and native model recovery tests passed.
- Label-specific machine registry, server profiles, continuation and model lifecycle checks passed.
- Desktop build and Electron `--check` passed again on the final sources: renderer loaded, embedded daemon announced all seven detected agents, project IPC succeeded, folder configuration had no environment override, and Codex returned 25 native sessions in the first page.

## Scope of native Electron verification

Full interactive Electron regression of the other harnesses has not been performed by the agent. The shared-renderer harness flows above and automated Electron checks are distinct from Giulio's native Codex confirmation. Claude remains excluded by instruction.

Run the native application with:

```bash
/home/giulio/Software/harness-remote/bridge/scripts/codex-mobile-electron-run-test.sh
```

It uses a temporary Electron/bridge profile with editable project folders and reuses the PC's native Codex login/history. The standalone web regression launcher instead isolates Codex and MiMo history. Neither launcher stops unrelated services.
