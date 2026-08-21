import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const mobileCss = readFileSync(new URL("./taskdesk-mobile-ux.css", import.meta.url), "utf8")
const continueCss = readFileSync(new URL("./taskdesk-continue.css", import.meta.url), "utf8")
const continueSource = readFileSync(new URL("./components/taskdesk-intelligent-continue.tsx", import.meta.url), "utf8")
const machineSource = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")

test("mobile Session conversation prioritizes transcript and composer over desktop metadata", () => {
  assert.match(mainSource, /import "\.\/taskdesk-mobile-ux\.css"/)
  assert.match(mobileCss, /td3-mobile-session-detail \.uw-context-strip[\s\S]*display:\s*none/)
  assert.match(mobileCss, /\.uw-session-actions > \.uw-button:last-child/)
  assert.match(mobileCss, /:has\(\.uw-composer-shell textarea:focus\)[\s\S]*\.uw-session-header/)
  assert.match(mobileCss, /:has\(\.uw-composer-shell textarea:focus\)[\s\S]*\.uw-detail-tabs/)
  assert.match(mobileCss, /\.uw-composer-shell textarea[\s\S]*font-size:\s*16px/)
})

test("mobile Continue keeps Run options available without stacking four controls above Task Context", () => {
  assert.match(continueSource, /<details className="td3-continue-settings">/)
  assert.match(continueSource, /className="td3-continue-settings-body"/)
  assert.match(continueSource, /<details className="td3-continue-context" open>/)
  assert.match(continueSource, /className="td3-continue-wide td3-continue-prompt"/)
  assert.match(continueCss, /\.td3-continue-settings-body[\s\S]*display:\s*none\s*!important/)
  assert.match(continueCss, /\.td3-continue-settings\[open\] > \.td3-continue-settings-body[\s\S]*display:\s*grid\s*!important/)
})

test("machine editor separates connection testing from save and hides parent add action while editing", () => {
  assert.match(machineSource, /className="uw-machine-test-block"/)
  assert.match(machineSource, /className="uw-machine-editor-actions"[\s\S]*Cancel[\s\S]*Add machine/)
  assert.match(machineSource, /className=\{`uw-machine-manager\$\{draft \? " editing" : ""\}`\}/)
  assert.match(machineSource, /\{!draft \? \([\s\S]*uw-machine-manager-footer/)
  assert.match(machineSource, /uw-manager-done/)
  assert.match(mobileCss, /\.uw-machine-manager \.uw-manager-close[\s\S]*display:\s*none/)
})

test("mobile Task detail is a page with in-flow actions and no desktop metadata wall", () => {
  assert.match(mobileCss, /\.td3-task-detail-open \.td3-detail-meta[\s\S]*display:\s*none/)
  assert.match(mobileCss, /\.td3-task-detail-open \.td3-detail-close::before[\s\S]*content:\s*"←"/)
  assert.match(mobileCss, /\.td3-task-detail-open \.td3-detail-actions[\s\S]*position:\s*static/)
  assert.match(mobileCss, /\.td3-detail-actions-primary[\s\S]*grid-template-columns:\s*repeat\(2/)
  assert.match(mobileCss, /\.td3-detail-actions > \.td3-button\.danger/)
})

test("shared phone wizards use one full-screen dismissal hierarchy", () => {
  assert.match(mobileCss, /\.modal-card\.wizard[\s\S]*height:\s*100dvh/)
  assert.match(mobileCss, /\.wizard-header \.wizard-close[\s\S]*display:\s*none/)
  assert.match(mobileCss, /:has\(#new-session-title\) \.wizard-header \.btn-icon/)
  assert.match(mobileCss, /\.wizard-body[\s\S]*overflow-y:\s*auto/)
})
