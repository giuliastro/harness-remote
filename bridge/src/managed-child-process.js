const ownedChildren = new Set()
const closePromises = new WeakMap()
const finishedChildren = new WeakSet()
const failedSpawns = new WeakSet()
let exitHookInstalled = false

function exited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined
    || finishedChildren.has(child)
    || failedSpawns.has(child)
}

function drop(child) {
  ownedChildren.delete(child)
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => {
    for (const child of ownedChildren) {
      if (exited(child)) continue
      try {
        child.kill("SIGKILL")
      } catch {
        // Process exit is the last-resort cleanup path; there is no recovery work to do here.
      }
    }
  })
}

/** Track a child started by this process so shutdown can reap it even if its owner is abandoned. */
export function ownChildProcess(child) {
  if (!child || typeof child.kill !== "function") throw new TypeError("A child process is required")
  if (exited(child)) return child
  installExitHook()
  ownedChildren.add(child)
  child.once("exit", () => {
    finishedChildren.add(child)
    drop(child)
  })
  // A failed spawn emits `error` and then `close`, without a child PID or `exit` event.
  child.once("error", () => {
    if (child.pid === undefined) {
      failedSpawns.add(child)
      drop(child)
    }
  })
  child.once("close", () => {
    finishedChildren.add(child)
    drop(child)
  })
  return child
}

/** Terminate an owned child and wait until Node observes its exit. Concurrent closes share a promise. */
export function closeOwnedChildProcess(child, { graceMs = 1_000 } = {}) {
  if (!child) return Promise.resolve()
  const existing = closePromises.get(child)
  if (existing) return existing
  if (exited(child)) {
    drop(child)
    return Promise.resolve()
  }

  const closing = new Promise((resolve) => {
    let settled = false
    let killTimer
    const finish = () => {
      if (settled) return
      settled = true
      finishedChildren.add(child)
      if (killTimer) clearTimeout(killTimer)
      child.removeListener("exit", finish)
      child.removeListener("close", finish)
      child.removeListener("error", onError)
      drop(child)
      resolve()
    }
    const onError = () => {
      // Spawn failures have no process to wait for. For a real child, the `close` event still
      // follows an `exit` event and is the point at which stdio resources are fully released.
      if (child.pid === undefined) {
        failedSpawns.add(child)
        finish()
      }
    }

    child.once("exit", finish)
    child.once("close", finish)
    child.once("error", onError)
    try {
      child.kill("SIGTERM")
    } catch {
      // A failed signal can happen in the narrow race with natural exit; the timer still forces
      // the last-resort signal if Node has not reported that exit yet.
    }
    if (!settled) {
      killTimer = setTimeout(() => {
        if (settled) return
        try {
          child.kill("SIGKILL")
        } catch {
          // Keep waiting for the exit event; callers need the observed lifecycle boundary.
        }
      }, Math.max(0, graceMs))
      killTimer.unref?.()
    }
  })
  closePromises.set(child, closing)
  return closing
}
