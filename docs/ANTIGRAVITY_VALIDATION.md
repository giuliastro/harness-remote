# Google Antigravity CLI integration validation

Issue [#681](https://github.com/giuliastro/harness-remote/issues/681) adds the official `agy acp` server as a native Harness Remote backend. Google documents ACP session listing, loading, resuming and closing, model and Thinking pickers, prompts, streaming tool activity, permissions, steering and cancel in its [ACP guide](https://antigravity.google/docs/ide/extensions/acp/).

## Prerequisites

1. Install Antigravity CLI using [Google's instructions](https://antigravity.google/docs/getting-started?tab=cli) and confirm `agy acp --help` works.
2. Sign in through an interactive `agy` session or `agy acp --login` on the machine running the gateway. Harness Remote does not store Antigravity credentials.
3. Choose a model explicitly for real testing. The project has no previously approved Antigravity test model.

## Real UI test

Run the desktop Electron test environment, connect to its isolated machine, and select **Google Antigravity CLI**. Verify each step in the UI:

1. The machine detects Antigravity and lists the account's available models. Select the approved model and create a Session in the sandbox Project.
2. Send a prompt and confirm a streamed assistant reply and any tool activity. Test a permission request and confirm it is handled as shown by the app; the bridge currently denies requests that are not preapproved in Antigravity settings.
3. Switch away and back, reload the Session, then send a second prompt. Confirm native history and context are preserved without duplicate messages.
4. Start a longer turn, send a second prompt while it runs, then Stop. Confirm the turn stops and a later prompt continues the Session.
5. Restart the gateway and confirm Session discovery, model selection and continuation still work. Check authentication and unavailable-model errors are visible.
6. Run regression flows for Codex, OpenCode, OMP, PI and MiMo using their approved models. Claude Code real tests remain disabled by the project policy. Verify the other installed harnesses if available.

Automated tests alone do not establish real-harness readiness. Record the exact `agy` version, model, OS, and UI results in the PR before promoting this integration.
