import React, { useMemo, useState } from "react"
import ReactDOM from "react-dom/client"
import { Capacitor } from "@capacitor/core"
import { installAppPreferences } from "./appPreferences"
import { installCompletionAudioGuard } from "./completion-audio"
import { StandaloneUniversalWorkspace } from "./components/standalone-universal-workspace"
import { ErrorBoundary } from "./ErrorBoundary"
import { SERVER_STORAGE_KEYS } from "./storageKeys"
import {
  loadWorkspaceMachines,
  persistWorkspaceMachines,
  type WorkspaceMachine
} from "./workspaceMachines"
import "./styles.css"
import "./taskdesk-theme.css"
import "./universal-workspace.css"
import "./universal-workspace-readable.css"
import "./universal-workspace-readable-fixes.css"
import "./taskdesk-v3.css"
import "./taskdesk-v3-unified.css"
import "./taskdesk-run-review.css"
import "./v3-polish.css"
import "./conversation-control-plane-overrides.css"
import "./conversation-control-plane-mobile-polish.css"

installAppPreferences()
installCompletionAudioGuard()

const conversationTestMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("taskdesk-test") === "1"

function HarnessRemoteBoundary() {
  const [revision, setRevision] = useState(0)
  const machines = useMemo(loadWorkspaceMachines, [revision])

  const persistMachines = (nextMachines: WorkspaceMachine[]) => {
    persistWorkspaceMachines(nextMachines)
    setRevision((value) => value + 1)
  }

  return (
    <StandaloneUniversalWorkspace
      machines={machines}
      onPersistMachines={persistMachines}
    />
  )
}

async function renderApp() {
  let content: React.ReactNode = <HarnessRemoteBoundary />
  if (conversationTestMode) {
    const { TaskDeskTestPage } = await import("./TaskDeskTestPage")
    content = <TaskDeskTestPage />
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary resetKeys={SERVER_STORAGE_KEYS}>
        {content}
      </ErrorBoundary>
    </React.StrictMode>
  )
}

void renderApp()

if (import.meta.env.DEV && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop) {
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister()))
    )
  }
  if ("caches" in window) {
    void caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("harness-remote-")).map((key) => caches.delete(key)))
    )
  }
}

if (import.meta.env.PROD && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {})
  })
}
