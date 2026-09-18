/* =====================================================================
   CROSS-ORIGIN ISOLATION SERVICE WORKER
   SharedArrayBuffer (needed so the Python compiler can pause on input()
   without freezing the page) only works when the page is "cross-origin
   isolated" — normally that means the server must send two response
   headers (Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy).
   vercel.json adds those for the live deployment, but a plain local dev
   server (Live Server, `python -m http.server`, etc.) has no way to add
   them. This file works around that: it installs itself as a Service
   Worker that injects those two headers into the page's own response,
   then reloads the page once so the browser picks them up.

   This same file plays two roles depending on where it runs:
   - Loaded as a normal <script> on the page, it registers itself as a
     Service Worker (below, the "not inServiceWorker" branch).
   - Running AS that Service Worker (no `window`), it intercepts fetches
     and adds the headers (the "inServiceWorker" branch).

   No-ops completely if the page is already isolated (e.g. the real
   Vercel headers are present), or if Service Workers aren't available —
   which is always true for a page opened directly via file://, since
   Service Workers require a secure context (http://localhost or https).
   In that case the compiler falls back to a popup for input() instead.
   ===================================================================== */
(function () {
  const inServiceWorker = typeof window === 'undefined';

  if (inServiceWorker) {
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener('fetch', (event) => {
      const request = event.request;

      // Only same-origin, navigable/basic requests can have their headers
      // rewritten here; opaque cross-origin responses are left untouched
      // and are still allowed to load under COEP: credentialless.
      if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

      event.respondWith(
        fetch(request).then((response) => {
          if (response.status === 0) return response; // opaque response — can't touch headers, don't need to
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
          });
        }).catch((err) => new Response('coi-serviceworker fetch failed: ' + err, { status: 500 }))
      );
    });

    return;
  }

  // --- Main-thread registration logic ---
  if (window.crossOriginIsolated) return; // already isolated, e.g. real server headers
  if (!window.isSecureContext) return; // Service Workers require https or localhost
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register(document.currentScript.src, { scope: './' }).then((registration) => {
    // A newly-installed worker needs one reload to actually start
    // controlling this page (it can't intercept the request that's
    // already in flight for the current document).
    registration.addEventListener('updatefound', () => {
      window.location.reload();
    });
    if (registration.active && !navigator.serviceWorker.controller) {
      window.location.reload();
    }
  }).catch((err) => {
    console.warn('[compiler] Cross-origin isolation Service Worker could not be registered; input() will fall back to a popup. Reason:', err);
  });
})();
