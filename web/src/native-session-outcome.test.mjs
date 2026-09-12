import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")
const panel = readFileSync(new URL("./components/native-session-outcome-panel.tsx", import.meta.url), "utf8")
const client = readFileSync(new URL("./project-outcome-client.ts", import.meta.url), "utf8")
const reviewEvidence = readFileSync(new URL("./native-session-review-evidence.ts", import.meta.url), "utf8")
const desktopTransport = readFileSync(new URL("../electron/request-transport.ts", import.meta.url), "utf8")

assert.ok(observer.includes("<NativeSessionOutcomePanel"), "native Sessions must expose the Project outcome review surface")
assert.ok(observer.includes("conversation={conversation}"), "outcome review must receive the structured native runtime lifecycle")
assert.ok(observer.includes("working={nativeSessionIsWorking(conversation.status)}"), "outcome refresh must follow the native turn lifecycle rather than token events")
assert.ok(observer.indexOf("<NativeSessionOutcomePanel") < observer.indexOf("<WorkThreadConversation"), "outcome review must remain outside the mature composer")
assert.equal(panel.includes("WorkThreadConversation"), false, "Project outcome must not become another conversation controller")
assert.ok(panel.includes("if (!interactionEnabled || working) return"), "Project outcome must pause while a turn is working or the machine is reconnecting")
assert.ok(panel.includes("listMachineProjects(target.config)"), "outcome must resolve through the daemon canonical Project catalog")
assert.ok(panel.includes("resolveSourceSessionProject(target, projects)"), "outcome must derive the local Project from the current Session only")
assert.ok(panel.includes("loadMachineProjectOutcome(target.config, projectRoute.id)"), "outcome reads must use the sanitized catalog Project id, never a caller path")
assert.ok(panel.includes("api.loadQuestions(target.config, target.directory)"), "review evidence must come from the native structured question endpoint")
assert.ok(panel.includes("api.loadPermissions(target.config, target.directory)"), "review evidence must come from the native structured permission endpoint")
assert.ok(panel.includes("request.sessionID === target.sessionID"), "attention evidence must stay scoped to the exact native Session")
assert.ok(panel.includes("Promise.allSettled"), "Project and attention enrichment must fail independently instead of blocking Session review")
assert.equal(panel.includes("loadDiff"), false, "generic outcome review must not depend on a harness-specific diff endpoint")
assert.equal(panel.toLowerCase().includes("test passed"), false, "checks must not be inferred from transcript/UI prose")
assert.ok(panel.includes("MAX_VISIBLE_FILES = 12"), "outcome UI must stay bounded even when the daemon returns a larger safe snapshot")
assert.ok(panel.includes("omitted by safety or display bounds"), "hidden/bounded file names must remain visible as an explicit incomplete-evidence signal")

assert.ok(reviewEvidence.includes("attention.complete && attention.permissions > 0"), "pending target permission must outrank a completed lifecycle")
assert.ok(reviewEvidence.includes("attention.complete && attention.questions > 0"), "structured questions must remain visible as required input")
assert.ok(reviewEvidence.includes('conversation.status === "failed"'), "structured runtime failure must be review evidence")
assert.ok(reviewEvidence.includes('conversation.status === "cancelled"'), "structured cancellation must remain visible")
assert.ok(reviewEvidence.includes("!attention.complete || !hasRealTurn(conversation)"), "completion must be withheld until attention is verified and a real turn exists")
assert.equal(reviewEvidence.includes("messageText"), false, "review evidence must never parse assistant transcript text")
assert.equal(reviewEvidence.includes("MessageEnvelope"), false, "review evidence must not inspect transcript envelopes")

assert.ok(client.includes("404 || status === 405 || status === 501"), "older daemons must degrade optional outcome metadata without blocking Session open")
assert.ok(client.includes("normalized.split(\"/\").some((part) => part === \"..\")"), "client must defense-in-depth reject escaping paths")
assert.ok(client.includes("payload.projectId !== projectId"), "outcome response must stay bound to the exact requested Project")
assert.equal(client.includes("diff"), false, "outcome client must not request diff contents")

assert.ok(desktopTransport.includes("v1\\/project-(?:identity|outcome)"), "desktop Project metadata must stay on the machine daemon instead of being agent scoped")

console.log("native Session Project outcome tests passed")
