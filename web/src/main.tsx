import React, { useMemo, useState } from "react"
import ReactDOM from "react-dom/client"
import { Capacitor } from "@capacitor/core"
import App from "./App"
import { installCompletionAudioGuard } from "./completion-audio"
import { StandaloneUniversalWorkspace } from "./components/standalone-universal-workspace"
import { ErrorBoundary } from "./ErrorBoundary"
import { SERVER_STORAGE_KEYS } from "./storageKeys"
import {
  WORKSPACE_MACHINES_STORAGE_KEY,
  loadWorkspaceMachines,
  persistWorkspaceMachines,
  type WorkspaceMachine
} from "./workspaceMachines"
import "./styles.css"
import "./v3-polish.css"
import "./universal-workspace.css"

installCompletionAudioGuard()

document.addEventListener("click", (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.classList.contains("modal-backdrop")) return
  if (!target.querySelector("#new-session-title")) return
  event.preventDefault()
  event.stopImmediatePropagation()
}, true)

const taskDeskTestMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("taskdesk-test") === "1"

function TaskDeskBoundary() {
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
      legacyView={<App />}
    />
  )
}

async function renderApp() {
  let content: React.ReactNode = <TaskDeskBoundary />
  if (taskDeskTestMode) {
    const { TaskDeskTestPage } = await import("./TaskDeskTestPage")
    content = <TaskDeskTestPage />
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary resetKeys={[...SERVER_STORAGE_KEYS, WORKSPACE_MACHINES_STORAGE_KEY]}>
        {content}
      </ErrorBoundary>
    </React.StrictMode>
  )
}

void renderApp()

if (import.meta.env.PROD && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {})
  })
}
