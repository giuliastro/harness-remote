import React, { useEffect, useMemo, useState } from "react"
import ReactDOM from "react-dom/client"
import { Capacitor } from "@capacitor/core"
import App from "./App"
import { api, isValidServerConfig } from "./api"
import { backendDisplayName } from "./backendSetup"
import { installCompletionAudioGuard } from "./completion-audio"
import { ConnectServerWizard } from "./components/panels"
import { ErrorBoundary } from "./ErrorBoundary"
import { createTranslator, normalizeLanguage } from "./i18n"
import { discoverMachine } from "./machineClient"
import {
  ACTIVE_PROFILE_CHANGED_EVENT,
  loadActiveServerProfile,
  loadServerProfiles,
  persistServerProfiles
} from "./serverProfiles"
import { SERVER_STORAGE_KEYS } from "./storageKeys"
import type { MachineSnapshot, ServerConfig } from "./types"
import "./styles.css"

installCompletionAudioGuard()

const LANGUAGE_STORAGE_KEY = "opencode.remote.language"
const taskDeskTestMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("taskdesk-test") === "1"

function matchingMachineAgent(machine: MachineSnapshot | null, backend: ServerConfig["backend"]) {
  return machine?.agents.find((agent) =>
    agent.backend === backend && (agent.state === "available" || agent.state === "configured")
  )
}

function profileRoutingKey(profileID: string, config: ServerConfig): string {
  return JSON.stringify({
    profileID,
    backend: config.backend,
    host: config.host.trim().toLowerCase(),
    port: config.port,
    username: config.username,
    password: config.password
  })
}

function AppProfileBoundary() {
  const [revision, setRevision] = useState(0)
  const [checkedRoutingKey, setCheckedRoutingKey] = useState<string | null>(null)
  const profiles = useMemo(loadServerProfiles, [revision])
  const activeProfile = useMemo(() => loadActiveServerProfile(profiles), [profiles])
  const t = useMemo(
    () => createTranslator(normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) || navigator.language)),
    [revision]
  )
  const needsInitialSetup = !isValidServerConfig(activeProfile.config)
  const routingKey = profileRoutingKey(activeProfile.id, activeProfile.config)
  const needsRoutingDiscovery = !needsInitialSetup && !activeProfile.config.agentId && checkedRoutingKey !== routingKey

  useEffect(() => {
    const onProfileChanged = () => {
      setCheckedRoutingKey(null)
      setRevision((value) => value + 1)
    }
    window.addEventListener(ACTIVE_PROFILE_CHANGED_EVENT, onProfileChanged)
    return () => window.removeEventListener(ACTIVE_PROFILE_CHANGED_EVENT, onProfileChanged)
  }, [])

  useEffect(() => {
    if (!needsRoutingDiscovery) return
    let cancelled = false
    void discoverMachine(activeProfile.config).then((machine) => {
      if (cancelled) return
      const agent = matchingMachineAgent(machine, activeProfile.config.backend)
      if (agent) {
        const nextProfiles = profiles.map((profile) =>
          profile.id === activeProfile.id
            ? { ...profile, config: { ...profile.config, agentId: agent.id } }
            : profile
        )
        persistServerProfiles(nextProfiles, activeProfile.id)
        setCheckedRoutingKey(null)
        setRevision((value) => value + 1)
        return
      }
      setCheckedRoutingKey(routingKey)
    }).catch(() => {
      if (!cancelled) setCheckedRoutingKey(routingKey)
    })
    return () => {
      cancelled = true
    }
  }, [activeProfile, needsRoutingDiscovery, profiles, routingKey])

  if (needsInitialSetup) {
    return (
      <ConnectServerWizard
        t={t}
        initialName={activeProfile.name}
        onCancel={() => undefined}
        onDiscover={discoverMachine}
        onTest={async (config: ServerConfig) => {
          try {
            const health = await api.health(config)
            if (health.backend && health.backend !== config.backend) {
              throw new Error(`Expected ${backendDisplayName(config.backend)} but reached ${backendDisplayName(health.backend)}`)
            }
            return { ok: true, message: t('settings.connectedTo', { version: health.version }) }
          } catch (error) {
            return { ok: false, message: t('settings.connectionFailed', { message: (error as Error).message }) }
          }
        }}
        onSave={(name, config) => {
          void (async () => {
            let routedConfig = config
            if (!config.agentId) {
              const machine = await discoverMachine(config).catch(() => null)
              const agent = matchingMachineAgent(machine, config.backend)
              if (agent) routedConfig = { ...config, agentId: agent.id }
            }
            const nextProfiles = profiles.map((profile) =>
              profile.id === activeProfile.id
                ? { ...profile, name: name.trim() || profile.name, config: routedConfig }
                : profile
            )
            persistServerProfiles(nextProfiles, activeProfile.id)
            setCheckedRoutingKey(null)
            setRevision((value) => value + 1)
          })()
        }}
      />
    )
  }

  if (needsRoutingDiscovery) {
    return (
      <div className="app-shell">
        <div className="empty-state compact" role="status" aria-live="polite">
          <p>{t('connection.connecting')}</p>
        </div>
      </div>
    )
  }

  return <App key={revision} />
}

async function renderApp() {
  let content: React.ReactNode = <AppProfileBoundary />
  if (taskDeskTestMode) {
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

if (import.meta.env.PROD && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {})
  })
}
