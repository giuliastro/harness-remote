import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("TaskDesk Continue consumes durable Task Context instead of synthesizing transcript context", () => {
  const client = readFileSync(new URL("./taskClient.ts", import.meta.url), "utf8")
  const modal = readFileSync(new URL("./components/taskdesk-intelligent-continue.tsx", import.meta.url), "utf8")

  assert.match(client, /loadContext\(config: ServerConfig, taskId: string\)/)
  assert.match(client, /\/v1\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/context/)
  assert.match(client, /continueTask\(config: ServerConfig, taskId: string, input: string \| ContinueTaskInput\)/)
  assert.match(client, /const body = typeof input === "string" \? \{ prompt: input \} : input/)
  assert.match(modal, /taskClient\.loadContext\(record\.runtime\.machine\.config, record\.task\.id\)/)
  assert.doesNotMatch(modal, /api\.loadMessages|loadMessagePage/, "Continue must use daemon Task Context, not rebuild handoff context from a transcript")
})

test("TaskDesk Continue selects harness, live model, role and native Session strategy", () => {
  const modal = readFileSync(new URL("./components/taskdesk-intelligent-continue.tsx", import.meta.url), "utf8")

  assert.match(modal, /taskClient\.listAgentModels\(record\.runtime\.machine\.config, agentID\)/)
  assert.match(modal, /latestReusableRun\(record\.task, agentID\)/)
  assert.match(modal, /latestModelForAgent\(record\.task, agentID\)/)
  assert.match(modal, /setMode\(reusableRun \? "resume" : "fresh"\)/)
  assert.match(modal, /ROLE_OPTIONS = \["continue", "review", "test", "debug", "refactor", "investigate", "custom"\]/)
  assert.match(modal, /agentId: agentID/)
  assert.match(modal, /role: roleValue/)
  assert.match(modal, /mode,/)
  assert.match(modal, /providerID: model\.providerID, modelID: model\.modelID, variant: model\.variant/)
})

test("TaskDesk Continue previews bounded context and keeps an older-daemon compatibility path", () => {
  const shell = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const modal = readFileSync(new URL("./components/taskdesk-intelligent-continue.tsx", import.meta.url), "utf8")
  const copy = readFileSync(new URL("./taskdesk-continue-i18n.ts", import.meta.url), "utf8")

  assert.match(shell, /<IntelligentContinueTaskModal/)
  assert.match(shell, /legacyFallback=\{ContinueTaskModal\}/)
  assert.match(shell, /language=\{language\}/)
  assert.match(modal, /className="td3-continue-context" open/)
  assert.match(modal, /context\.objective/)
  assert.match(modal, /context\.currentState/)
  assert.match(modal, /context\.latestOutcome/)
  assert.match(modal, /context\.changedFiles\.slice\(0, 12\)/)
  assert.match(modal, /context\.runSummaries\.slice\(-6\)\.reverse\(\)/)
  assert.match(modal, /HTTP 404\|incompatible response/)
  assert.match(copy, /It is not native conversational memory from another harness/)
  for (const language of ["en", "it", "zh-TW", "zh-CN"]) {
    assert.match(copy, new RegExp(`(?:^|\\n)  ${JSON.stringify(language).replace(/["']/g, "\\\"")}|(?:^|\\n)  ${language === "en" || language === "it" ? language : `"${language}"`}:`), `localized Continue copy should include ${language}`)
  }
})