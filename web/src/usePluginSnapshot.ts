import { useCallback, useEffect, useRef, useState } from "react"
import { listPlugins, PLUGINS_CHANGED_EVENT, pluginCacheKey } from "./pluginClient"
import type { PluginSnapshot } from "./plugins"
import type { WorkspaceMachine } from "./workspaceMachines"

const POLL_INTERVAL_MS = 120_000

/**
 * One plugin snapshot per machine, shared by every surface that needs it.
 *
 * The top bar, the rail card, the empty-state dashboard and the plugin centre are four views of the
 * same machine-local catalog. Keeping transport and polling in one hook means a plugin is asked for
 * its status once, not four times, and an explicit install/update/remove refreshes all of them
 * through the same invalidation event.
 */
export function usePluginSnapshot(machine: WorkspaceMachine | undefined) {
  const [snapshot, setSnapshot] = useState<PluginSnapshot | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const key = machine ? `${pluginCacheKey(machine.config)}\u0000${machine.id}` : null
  const keyRef = useRef(key)
  keyRef.current = key
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const machineRef = useRef(machine)
  machineRef.current = machine
  const cancelledRef = useRef(false)

  const load = useCallback(async (refresh: boolean) => {
    const target = machineRef.current
    if (!target) return
    const requestKey = keyRef.current
    const initial = snapshotRef.current === null
    if (initial) setLoading(true)
    else if (refresh) setRefreshing(true)
    try {
      const value = await listPlugins(target.config, { refresh })
      if (cancelledRef.current || requestKey !== keyRef.current) return
      setSnapshot(value)
      setError(null)
    } catch (reason) {
      if (cancelledRef.current || requestKey !== keyRef.current) return
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    } finally {
      if (!cancelledRef.current && requestKey === keyRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    setSnapshot(null)
    setError(null)
    setLoading(Boolean(machine))
    setRefreshing(false)
    if (!machine) {
      setLoading(false)
      return
    }
    void load(false)
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false)
    }, POLL_INTERVAL_MS)
    const onChanged = () => { void load(true) }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load(false)
    }
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChanged)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelledRef.current = true
      window.clearInterval(interval)
      window.removeEventListener(PLUGINS_CHANGED_EVENT, onChanged)
      document.removeEventListener("visibilitychange", onVisibility)
    }
    // The key is the machine identity, not the object identity: the workspace rebuilds machine
    // objects on every persist and re-subscribing would needlessly restart the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load])

  const refresh = useCallback(() => load(true), [load])

  return { snapshot, error, loading, refreshing, refresh, machineKey: key }
}
