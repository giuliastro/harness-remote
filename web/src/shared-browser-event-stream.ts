export type SharedBrowserEventStreamOptions<Event, Status> = {
  url: string
  headers?: Record<string, string>
  onEvent: (event: Event) => void
  onStatus?: (status: Status) => void
}

type SharedBrowserEventStreamConnect<Event, Status> = (
  options: SharedBrowserEventStreamOptions<Event, Status>
) => { close(): void }

type Subscriber<Event, Status> = {
  options: SharedBrowserEventStreamOptions<Event, Status>
  closed: boolean
}

type SharedStream<Event, Status> = {
  subscribers: Set<Subscriber<Event, Status>>
  closeTransport: () => void
  hasStatus: boolean
  latestStatus?: Status
  closed: boolean
}

function headerIdentity(headers?: Record<string, string>): string {
  const normalized = Object.entries(headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => nameA.localeCompare(nameB) || valueA.localeCompare(valueB))
  return JSON.stringify(normalized)
}

/**
 * Shares one browser SSE transport among subscriptions with the same URL and
 * request headers. Events are live-only; a late subscriber only receives the
 * most recently observed status.
 */
export function createSharedBrowserEventSubscriptions<Event, Status>(
  connect: SharedBrowserEventStreamConnect<Event, Status>,
  options: { reportError?: (error: unknown) => void } = {}
): {
  subscribe(subscription: SharedBrowserEventStreamOptions<Event, Status>): { close(): void }
} {
  const registry = new Map<string, SharedStream<Event, Status>>()
  const reportError = options.reportError ?? (() => {
    // Do not include callback messages or stream identity in logs: either may
    // contain credentials or backend routing data.
    try {
      console.error("Shared browser event subscriber callback failed")
    } catch {
      // Reporting must never interfere with other listeners.
    }
  })

  const safelyCall = (callback: (() => void) | undefined) => {
    if (!callback) return
    try {
      callback()
    } catch (error) {
      try {
        reportError(error)
      } catch {
        // A broken reporter must not block delivery to sibling subscribers.
      }
    }
  }

  return {
    subscribe(subscription) {
      const key = JSON.stringify([subscription.url, headerIdentity(subscription.headers)])
      let stream = registry.get(key)
      const subscriber: Subscriber<Event, Status> = { options: subscription, closed: false }

      if (stream) {
        stream.subscribers.add(subscriber)
        if (stream.hasStatus) {
          safelyCall(() => subscription.onStatus?.(stream?.latestStatus as Status))
        }
      } else {
        stream = {
          subscribers: new Set([subscriber]),
          closeTransport: () => undefined,
          hasStatus: false,
          closed: false
        }
        registry.set(key, stream)
        const currentStream = stream
        try {
          const transport = connect({
            url: subscription.url,
            headers: subscription.headers,
            onEvent(event) {
              if (currentStream.closed) return
              for (const listener of [...currentStream.subscribers]) {
                if (!listener.closed) safelyCall(() => listener.options.onEvent(event))
              }
            },
            onStatus(status) {
              if (currentStream.closed) return
              currentStream.hasStatus = true
              currentStream.latestStatus = status
              for (const listener of [...currentStream.subscribers]) {
                if (!listener.closed) safelyCall(() => listener.options.onStatus?.(status))
              }
            }
          })
          currentStream.closeTransport = () => transport.close()
        } catch (error) {
          currentStream.closed = true
          currentStream.subscribers.clear()
          if (registry.get(key) === currentStream) registry.delete(key)
          throw error
        }
      }

      const ownedStream = stream
      return {
        close() {
          if (subscriber.closed) return
          subscriber.closed = true
          ownedStream.subscribers.delete(subscriber)
          if (ownedStream.subscribers.size !== 0 || ownedStream.closed) return
          ownedStream.closed = true
          if (registry.get(key) === ownedStream) registry.delete(key)
          ownedStream.closeTransport()
        }
      }
    }
  }
}
