/**
 * Dev-only preview of the ported controls.
 *
 * The controls this port touches are all conditional in the running app: a tool card needs a harness
 * that emits `tool` parts, the Activity clock and its sweep need a turn that is actually working, and
 * the approval card needs a live permission or question. So "run the app and look" is not a way to
 * review them - you have to be lucky. This page renders every one of them, in every state, off the
 * real stylesheets, with no daemon and no Session.
 *
 * Served by `npm run dev` at /controls-preview.html. Vite's build input is `index.html` alone, so
 * this never enters a production bundle, an APK or a desktop app.
 */
/* Imported by components rather than by `main.tsx`. Module imports are hoisted, so in the app
 * these land before main.tsx's own list - the order below matches that. Two more ride along as
 * CSS `@import`s: work-thread-detail.css from taskdesk-conversation.css, and
 * taskdesk-workspace-navigation.css from taskdesk-mobile-navigation.css. */
import "./native-session-home.css"
import "./native-session-home-ux.css"
import "./native-session-attention-inbox.css"
import "./model-picker.css"
import "./taskdesk-conversation.css"
import "./taskdesk-conversation-fixes.css"
import "./taskdesk-history-loader.css"
import "./native-session-observer.css"
import "./taskdesk-workthreads.css"
import "./taskdesk-mobile-navigation.css"
import "./taskdesk-focus-layout.css"
import "./conversation-control-plane.css"
import "./machine-manager-health.css"

/* Then main.tsx's list, in main.tsx's order, ending on the ported controls. */
import "./styles.css"
import "./taskdesk-theme.css"
import "./universal-workspace-readable-fixes.css"
import "./taskdesk-v3-unified.css"
import "./conversation-control-plane-overrides.css"
import "./conversation-control-plane-mobile-polish.css"
import "./v3-mobile-regression-fixes.css"
import "./v3-mobile-landscape-grid-fix.css"
import "./v3-mobile-workspace-switcher-polish.css"
import "./v3-mobile-a11y-fix.css"
import "./v3-mobile-product-parity.css"
import "./session-first-navigation.css"
import "./session-first-workbench.css"
import "./conversation-base.css"
import "./session-first-centering-fix.css"
import "./session-handoff-routing.css"
import "./machine-pairing.css"
import "./beautiful-ui-controls.css"

/** Same list, same order as `main.tsx` - `beautiful-ui-controls.test.mjs` asserts the two match, so
 *  a sheet added to the app cannot silently go missing from its own preview. */

const root = document.documentElement

function applyPreviewTheme(theme: "dark" | "light"): void {
  root.dataset.theme = theme
  root.style.colorScheme = theme
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme))
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
  button.addEventListener("click", () => applyPreviewTheme(button.dataset.themeChoice as "dark" | "light"))
}

applyPreviewTheme("dark")

/**
 * The clocks tick. A duration frozen in markup is the one part of this that would read as finished
 * work when the point is to show a live turn, and the sweep beside it is already moving.
 */
const started = Date.now()
const tick = () => {
  const seconds = Math.floor((Date.now() - started) / 1000)
  const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  for (const node of document.querySelectorAll("[data-live-clock]")) node.textContent = label
}
tick()
window.setInterval(tick, 1_000)

// Selecting an option is the feedback that was indistinguishable from hover, so it has to be real
// here rather than a class baked into the markup.
for (const group of document.querySelectorAll(".tdw-attention-options")) {
  for (const button of group.querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      for (const sibling of group.querySelectorAll<HTMLButtonElement>("button")) {
        const chosen = sibling === button
        sibling.classList.toggle("selected", chosen)
        sibling.setAttribute("aria-pressed", String(chosen))
        const mark = sibling.querySelector(".bui-approval-check")
        if (mark) mark.textContent = chosen ? "\u2713" : ""
      }
    })
  }
}
