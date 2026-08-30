// Bumped with the app icon artwork: the precached icon-192/icon-512 entries are served cache-first,
// so an already-installed PWA keeps painting the previous icon until the cache name changes and
// `activate` drops the old one.
const CACHE_NAME = "harness-remote-v3"

self.addEventListener("install", (event) => {
  const scope = self.registration.scope
  const appShell = [scope, `${scope}manifest.webmanifest`, `${scope}icon-192.png`, `${scope}icon-512.png`]
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(appShell))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

/**
 * A worker may be killed as soon as it has answered, so a cache write started inside the
 * response chain is not guaranteed to finish: it has to be kept alive by the event itself.
 */
function storeInCache(event, key, response) {
  const copy = response.clone()
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(key, copy)))
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === "navigate") {
    const scope = self.registration.scope
    const scopeUrl = new URL(scope)
    const landingPath = `${scopeUrl.pathname}v3/`

    // The HR3 marketing landing lives alongside the app on GitHub Pages. Let the browser
    // fetch it directly so app-shell caching never replaces the PWA root with landing HTML.
    if (url.pathname.startsWith(landingPath)) return
    event.respondWith(
      fetch(request)
        .then((response) => {
          storeInCache(event, scope, response)
          return response
        })
        .catch(() => caches.match(scope))
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) storeInCache(event, request, response)
          return response
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
