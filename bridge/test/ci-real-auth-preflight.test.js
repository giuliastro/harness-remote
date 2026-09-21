import assert from "node:assert/strict"
import {
  assertRealAuthEnvironment,
  realAuthCredentialPlan,
  validateMimoInlineConfig
} from "../scripts/ci-real-auth-preflight.mjs"

const safeMimoConfig = JSON.stringify({
  model: "mimo/mimo-v2.5-pro",
  provider: {
    mimo: {
      options: {
        apiKey: "{env:MIMO_API_KEY}"
      }
    }
  }
})

const complete = {
  OPENAI_API_KEY: "openai-test-secret",
  ANTHROPIC_API_KEY: "anthropic-test-secret",
  MIMO_API_KEY: "mimo-test-secret",
  GITHUB_TOKEN: "github-test-token",
  HARNESS_REMOTE_MIMO_CONFIG_CONTENT: safeMimoConfig
}

const plan = realAuthCredentialPlan(complete)
assert.deepEqual(plan.missing, [])
assert.equal(plan.copilot.configured, true)
assert.equal(plan.copilot.source, "GITHUB_TOKEN")

const explicitCopilot = realAuthCredentialPlan({
  ...complete,
  COPILOT_GITHUB_TOKEN: "copilot-fine-grained-token"
})
assert.equal(explicitCopilot.copilot.source, "COPILOT_GITHUB_TOKEN")

assert.deepEqual(
  realAuthCredentialPlan({}).missing.map(({ name }) => name),
  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MIMO_API_KEY"]
)

assert.deepEqual(validateMimoInlineConfig(complete), {
  configured: true,
  safeEnvReference: true
})

assert.throws(
  () => validateMimoInlineConfig({
    ...complete,
    HARNESS_REMOTE_MIMO_CONFIG_CONTENT: JSON.stringify({
      provider: { mimo: { options: { apiKey: complete.MIMO_API_KEY } } }
    })
  }),
  /literal MiMo key/
)

assert.throws(
  () => assertRealAuthEnvironment({
    OPENAI_API_KEY: "configured",
    GITHUB_TOKEN: "configured"
  }),
  /ANTHROPIC_API_KEY.*MIMO_API_KEY/s
)

const validated = assertRealAuthEnvironment(complete)
assert.equal(validated.mimo.safeEnvReference, true)

console.log("real authenticated CI preflight tests passed")
