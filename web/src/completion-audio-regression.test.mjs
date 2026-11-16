import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./completion-audio.ts", import.meta.url)), "utf8")
const main = readFileSync(fileURLToPath(new URL("./main.tsx", import.meta.url)), "utf8")

assert.match(main, /installCompletionAudioGuard\(\)/, "completion guard must be installed before the app renders")
assert.match(source, /prompt_async\|command/, "prompt and command submissions must arm completion tracking")
assert.match(source, /\/abort/, "abort must cancel an armed completion")
assert.match(source, /\/session\/status/, "session status is the authoritative completion source")
// A Session listening for background work it started has not finished: no completion sound yet.
assert.match(source, /WORKING_STATES = new Set\(\["busy", "retry", "waiting", "listening"\]\)/)
assert.match(source, /if \(!entry\.sawWorking && !entry\.sawAssistantActivity\) continue/, "idle before work starts must not play")
assert.match(source, /noteAssistantActivity\(\)/, "the old first-fragment sound request must be suppressed")
assert.match(source, /primePlayback\(\)/, "playback must be primed at user submission time for native WebView")
assert.match(source, /CapacitorHttp\.request = async/, "native HTTP status polling must drive the same completion tracker")

console.log("completion audio regression checks passed")
