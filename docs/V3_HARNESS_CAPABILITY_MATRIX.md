# Harness Remote 3.0 harness capability matrix

This document records the runtime contract Harness Remote 3.0 expects from each supported coding harness.

The model list is only one part of that contract. Harness Remote also needs to know how a harness communicates, how tool activity is represented, which model controls are actually advertised, which component owns Session truth, and which lifecycle guarantees can be relied on.

The machine snapshot exposes the same structured information as `agent.contract`. Boolean
capability flags remain for compatibility, while the structured contract is the current direction.

## Product rule

Harness Remote owns the **work-continuity** layer. The coding harness owns its **Native Session**.

Harness Remote must not flatten harness-specific capabilities into a fake universal Session protocol. If a harness does not advertise a control, Harness Remote does not invent it.

## Matrix

| Harness | Protocol / control | Live events | Tool representation | Model source | Catalog scope | Model controls | Session authority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode Legacy (v1) | HTTP JSON | daemon-owned SSE fanout | OpenCode message parts | runtime `/provider` or `/api/provider`; `/config/providers` compatibility fallback | machine | provider-advertised variants | OpenCode v1 |
| OpenCode 2 | ACP over stdio JSON-RPC | ACP Session updates | ACP Session updates | technical ACP Session `configOptions` | machine | `effort` only when advertised for the selected model | OpenCode 2 |
| OMP | ACP over stdio JSON-RPC | ACP Session updates | ACP Session updates | fresh prompt-less technical ACP Session `configOptions` | machine | `thinking` only when advertised | OMP |
| PI | ACP over stdio JSON-RPC | ACP Session updates | ACP Session updates | fresh prompt-less technical `pi-acp` Session `configOptions` | machine | `thinkingLevel`, compatible runtime aliases only when advertised | PI |
| Codex | ACP over stdio JSON-RPC | ACP Session updates | ACP Session updates | fresh prompt-less technical ACP Session `configOptions` | machine | `reasoning_effort` only when advertised | Codex |
| Claude | ACP over stdio JSON-RPC | ACP Session updates | ACP Session updates | fresh prompt-less technical ACP Session `configOptions` | machine | runtime-advertised controls only; no fabricated reasoning levels | Claude |

## Model discovery scope

ACP model discovery is deliberately **machine-scoped**:

```text
machine + harness
```

This is the ownership model exercised successfully on real machines. A project/cwd-scoped ACP
experiment caused PI, Codex and Claude to lose their model catalogs, including in newly created
native Sessions, during Windows testing. It was therefore rolled back rather than patched
speculatively.

The web/Android client may still include `projectId` or `workThreadId` hints in model requests.
They are compatibility metadata for a future project-aware implementation; they are **not
model-catalog authority**. The daemon does not accept a raw client cwd as model authority.

For ACP harnesses, one daemon-owned prompt-less technical Session per harness adapter lifetime supplies the current `configOptions` model catalog. Discovery remains single-flight and bounded. Historical technical Session ids remain hidden but are not reloaded as current membership authority after daemon restart.

OpenCode is also machine-scoped because its runtime provider inventory comes from the managed OpenCode host rather than an ACP Session.

Project-aware ACP discovery remains a follow-up. It must not return until PI, Codex, Claude and
OMP all pass real-harness tests on the exact implementation, including Windows where practical.

## Lifecycle contract

### Work continuity

Harness Remote owns:

- stable work identity and Project association;
- ordered Native Session references;
- current harness/model selection;
- explicit handoff context between Native Sessions;
- retry/reconciliation metadata needed above the harness layer.

### Native Session

The selected harness owns:

- native transcript and message semantics;
- reasoning/activity representation;
- tool execution and tool state;
- questions and permissions when supported;
- native context/memory/compaction;
- model behavior;
- abort/Stop behavior;
- native resume semantics.

### Create, resume and Stop

The structured runtime contract currently describes the intended routing semantics as:

- create: native harness Session;
- resume: native Session when the harness supports it;
- Stop: native abort/cancel path;
- reconnect: daemon transport reconciliation rather than blindly replaying a prompt.

Exact real-machine behavior remains part of the 3.0 release gate. This matrix documents the contract and implementation path; it does not replace validation against installed OpenCode, OMP, PI, Codex and Claude builds.

## Transport notes

### OpenCode

OpenCode uses HTTP for control. Harness Remote owns one upstream OpenCode global SSE connection and fans events out to downstream web, desktop and Android clients. Reconnecting clients must not create an unbounded number of OpenCode upstream subscriptions.

### ACP harnesses

OMP, PI, Codex and Claude are controlled through ACP adapters over stdio JSON-RPC. Session updates carry the harness-native activity through the ACP representation. Model discovery uses a separate prompt-less technical ACP connection from user-facing Session ownership so discovery cannot take over a native Session.

## Variant and reasoning metadata

Harness Remote preserves controls that the running harness actually advertises:

- OMP: `thinking` when advertised;
- PI: `thinkingLevel` or compatible runtime aliases when advertised;
- Codex: `reasoning_effort` when advertised;
- Claude: no fabricated low/medium/high levels;
- OpenCode: provider-advertised variants.

A base model remains usable if optional variant enrichment is slow or incomplete.

## Diagnostics

The 3.0 backend exposes diagnostics for model discovery and lifecycle investigation, including:

- catalog source and machine cache scope;
- cached model count and age;
- in-flight discovery state;
- ACP discovery phase;
- variant-probe completeness;
- active/queued Sessions;
- pending ACP requests;
- event stream and reconnect counters;
- OpenCode upstream/downstream fanout state.

Diagnostics must not expose prompt bodies, credentials or generated authentication material.

## Release validation

Validate the contract with real installed harnesses for every release on one traceable build:

1. discover/start each harness;
2. load its live model catalog;
3. create a native Session;
4. continue across multiple turns;
5. run a long reasoning/tool turn;
6. Stop a real turn;
7. switch harness and model;
8. switch away and back;
9. restart daemon and reconcile/resume;
10. background/foreground Android or interrupt the local network;
11. prove listener, request, cache and subscription counts plateau.

The release matrix must distinguish what was **implemented**, what was **advertised by the harness**, and what was **verified on a real machine**.
