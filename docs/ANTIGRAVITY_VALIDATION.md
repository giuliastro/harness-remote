# Google Antigravity CLI integration validation

Issue [#681](https://github.com/giuliastro/harness-remote/issues/681) adds the official `agy acp` server as a native Harness Remote backend. Google documents ACP session listing, loading, resuming and closing, model and Thinking pickers, prompts, streaming tool activity, permissions, steering and cancel in its [ACP guide](https://antigravity.google/docs/ide/extensions/acp/).

## Prerequisites

1. Install Antigravity CLI using [Google's instructions](https://antigravity.google/docs/getting-started?tab=cli) and confirm `agy acp --help` works.
2. Run `scripts/harness-remote-issue-681-run-test.sh --login` to sign in inside the isolated test state. The launcher does not copy your daily Antigravity sessions or credentials.
3. Choose a model explicitly for real testing. The project has no previously approved Antigravity test model.

## Volunteer test from the pull request

This path is for contributors testing with their own Antigravity account and model. The isolated `scripts/harness-remote-issue-681-run-test.sh` launcher below is Linux-specific and is intended for the maintainer's environment. The desktop development path is expected to work on supported desktop operating systems, but this PR has so far only been launched on Linux.

1. Install Antigravity CLI using [Google's guide](https://antigravity.google/docs/getting-started?tab=cli). Run `agy acp --help`, then sign in with `agy` or `agy acp --login`.
2. Install Node.js 20.19+ or 22.12+ and check out the PR branch in a separate directory:

   ```bash
   git clone --branch feat/issue-681-antigravity-acp --single-branch https://github.com/giuliastro/harness-remote.git harness-remote-antigravity
   cd harness-remote-antigravity
   npm ci --prefix web
   npm --prefix web run electron:dev
   ```

3. In the desktop app, open the local machine and choose a disposable Project directory. Confirm **Google Antigravity** appears among the detected harnesses. Select a model available to your own account and create a fresh Session. The maintainer's approved-model policy applies to maintainer-run tests, not to a volunteer's account.
4. Send a small prompt, confirm the reply, reopen the Session, send a follow-up, test Stop during a longer turn, and check that a later prompt continues. Please use only a disposable Project; permission requests that Antigravity has not preapproved are currently denied by the bridge.
5. Comment on [PR #682](https://github.com/giuliastro/harness-remote/pull/682) with your OS, `agy --version`, the model selected, which steps passed or failed, and any error text or a redacted screenshot. Do not share credentials or private project content.

If the CLI is not detected or the desktop app fails to start, report that result too. It is useful validation of the discovery and setup path.

## Real UI test

For maintainer testing on Linux, run `scripts/harness-remote-issue-681-run-test.sh --check` to verify the isolated Electron environment, then run it without arguments to open the app. Connect to its isolated machine and select **Google Antigravity CLI**. Verify each step in the UI:

1. The machine detects Antigravity and lists the account's available models. Select the approved model and create a Session in the sandbox Project.
2. Send a prompt and confirm a streamed assistant reply and any tool activity. Test a permission request and confirm it is handled as shown by the app; the bridge currently denies requests that are not preapproved in Antigravity settings.
3. Switch away and back, reload the Session, then send a second prompt. Confirm native history and context are preserved without duplicate messages.
4. Start a longer turn, send a second prompt while it runs, then Stop. Confirm the turn stops and a later prompt continues the Session.
5. Restart the gateway and confirm Session discovery, model selection and continuation still work. Check authentication and unavailable-model errors are visible.
6. Run regression flows for Codex, OpenCode, OMP, PI and MiMo using their approved models. Claude Code real tests remain disabled by the project policy. Verify the other installed harnesses if available.

Automated tests alone do not establish real-harness readiness. Record the exact `agy` version, model, OS, and UI results in the PR before promoting this integration.
