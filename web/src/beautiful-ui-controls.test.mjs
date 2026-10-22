import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import test from "node:test"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(path.join(here, name), "utf8").replace(/\r\n/g, "\n")

const css = read("beautiful-ui-controls.css")
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "")
const timeline = read("components/activity-timeline.tsx")
const model = read("activity-model.ts")
const activityCss = read("activity-timeline.css")
const attention = read("components/work-thread-attention.tsx")
const main = read("main.tsx")

test("the ported controls resolve every colour through a theme token", () => {
  // This is the whole reason the port went to plain CSS instead of Tailwind: a literal colour here
  // is a surface that stays dark on the Light theme, which is the defect taskdesk-theme.css exists
  // to prevent. `currentcolor` and `transparent` are theme-independent by definition.
  const literals = [
    ...cssRules.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
    ...cssRules.matchAll(/\b(?:rgb|rgba|hsl|hsla)\(/g)
  ].map((match) => match[0])
  assert.deepEqual(literals, [], "use a --td3-* token instead of a literal colour")
})

test("the stylesheet loads last so the port never needs !important", () => {
  assert.match(main, /import "\.\/beautiful-ui-controls\.css"/)
  assert.ok(
    main.indexOf('beautiful-ui-controls.css') > main.indexOf('session-first-workbench.css'),
    "the ported controls must load after the sheets they refine"
  )
  assert.doesNotMatch(cssRules, /!important/, "load order, not !important, settles these ties")
})

test("every animation is unwound for prefers-reduced-motion", () => {
  const guard = cssRules.slice(cssRules.indexOf("@media (prefers-reduced-motion: reduce)"))
  assert.ok(guard, "the stylesheet must carry a reduced-motion guard")
  for (const match of cssRules.matchAll(/animation: (bui-[a-z-]+)/g)) {
    assert.ok(guard.includes(match[1]) || guard.includes("animation: none"), `${match[1]} is not unwound`)
  }
})

test("a tool call reports its kind, its cost and a readable outcome", () => {
  assert.match(model, /export function toolKind\(part: MessagePart\): ToolKind/)
  assert.match(timeline, /kind-\$\{description\.kind\}/)
  assert.match(timeline, /const duration = formatSpan\(spanMs\(\[part\]\)\)/)
  // The protocol words used to reach the screen unchanged: "completed", "error", "running".
  assert.match(timeline, /t\("act\.status\.failed"\)/)
  assert.match(timeline, /t\("act\.status\.incomplete"\)/)
  assert.doesNotMatch(timeline, /"no result" : status/)

  // Every kind the component can produce needs a glyph, and the two that mutate state are the only
  // ones the stylesheet accents - colour stays reserved for status.
  const kinds = ["read", "edit", "run", "search", "web", "task", "todo", "tool"]
  // Real SVG components, not unicode characters: a borrowed glyph inherits text metrics and renders
  // as a different shape per platform - on Android, as a box.
  for (const kind of kinds) assert.match(timeline, new RegExp(`${kind}: [A-Z][A-Za-z]*Icon`), `${kind} has no icon`)
  assert.match(timeline, /function StatusGlyph\(\{ status \}: \{ status: string \}\)/)
  assert.doesNotMatch(timeline, /TOOL_KIND_GLYPH/)
  assert.match(activityCss, /\.hr-act-tool\.kind-edit \.hr-act-kind,\n\.hr-act-tool\.kind-run \.hr-act-kind/)
})

test("a sub-second call and a missing timestamp show no clock at all", () => {
  // A "0.4s" on every row is noise, and a harness that reports seconds where the type says
  // milliseconds would otherwise render a duration measured in decades.
  assert.match(model, /if \(ms === undefined \|\| !Number\.isFinite\(ms\) \|\| ms < 1_000\) return ""/)
  assert.match(model, /return ms >= 0 && ms <= 86_400_000 \? ms : undefined/)
  assert.match(timeline, /return ms > 86_400_000 \? "" : formatSpan\(Math\.max\(0, ms\) < 2_000 \? undefined : ms\)/)
  // The clock is fed by the harness's own part timestamps, not by when this component mounted.
  assert.match(model, /export function startedAt\(parts: MessagePart\[\]\)/)
  assert.match(model, /part\.type === "tool" \? part\.state\?\.time \?\? \{\} : part\.time \?\? \{\}/)
})

test("the approval card stays actionable with a thumb", () => {
  // The one card the user cannot scroll past: the agent is stopped until it is answered.
  assert.match(attention, /className="tdw-attention bui-approval"/)
  assert.match(attention, /className="bui-approval-scopes"/)
  assert.doesNotMatch(attention, /request\.patterns\.join/, "one chip per scope, not one run-on line")
  assert.match(attention, /className="tdw-button secondary bui-approval-deny"/)

  // A tap that had registered looked like a tap that had not: the selected state was a background
  // tint alone, which is the same feedback hover already gives.
  assert.match(attention, /className="bui-approval-check"/)
  assert.match(cssRules, /\.bui-approval \.tdw-attention-options button\.selected \{/)

  // The global `button` rule in styles.css makes every button a flex box centred on both axes with
  // `white-space: nowrap`, so the `display: block` on the label was describing a flex item: label and
  // description rendered side by side, centred, and a long option could not wrap.
  const option = cssRules.match(/\.bui-approval \.tdw-attention-options button \{[\s\S]*?\n\}/)[0]
  assert.match(option, /flex-direction: column/)
  assert.match(option, /align-items: flex-start/)
  assert.match(option, /color: var\(--td3-text\)/)
  assert.match(option, /white-space: normal/, "a long option label has to be able to wrap")

  for (const selector of [
    /\.bui-approval \.tdw-attention-options button \{\n\s*min-height: 44px;/,
    /\.bui-approval \.tdw-attention-actions \.tdw-button \{\n\s*min-height: 44px;/
  ]) assert.match(cssRules, selector, "decision controls must clear the 44px touch target")
})

test("aria semantics survive the restyle", () => {
  // Everything added is decoration on state that is already spelled out in text.
  assert.match(attention, /aria-live="polite"/)
  assert.match(attention, /aria-pressed=\{selected\.includes\(option\.label\)\}/)
  assert.match(attention, /<i className="bui-approval-dot" aria-hidden="true" \/>/)
  assert.match(timeline, /<span className="hr-act-kind" aria-hidden="true">/)
})

test("the dev preview loads exactly the stylesheets the app loads", () => {
  // The preview exists so these controls can be reviewed without waiting for a harness to emit a
  // tool part or a permission request. That only works if it is styled by the same sheets: a rule
  // the app has and the preview does not makes the preview a lie, and the reverse hides a bug.
  const app = new Set()
  for (const file of ["main.tsx", ...readdirSync(path.join(here, "components")).map((f) => `components/${f}`)]) {
    if (!/\.tsx?$/.test(file)) continue
    for (const match of read(file).matchAll(/import "\.[./]*([a-z0-9-]+\.css)"/g)) app.add(match[1])
  }
  const preview = new Set([...read("controls-preview.ts").matchAll(/import "\.\/([a-z0-9-]+\.css)"/g)].map((m) => m[1]))
  assert.deepEqual([...app].filter((s) => !preview.has(s)), [], "the preview is missing a stylesheet the app loads")
  assert.deepEqual([...preview].filter((s) => !app.has(s)), [], "the preview loads a stylesheet the app does not")
})

test("the preview never reaches a production bundle", () => {
  // Vite's default build input is index.html alone, so a second root HTML is served in dev and left
  // out of the bundle, the APK and the desktop app. An added `rollupOptions.input` would change that.
  assert.doesNotMatch(read("../vite.config.ts"), /rollupOptions|input:/)
  assert.match(read("../controls-preview.html"), /src="\/src\/controls-preview\.ts"/)
})
