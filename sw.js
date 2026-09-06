// HotDrop's service worker is intentionally a no-op beyond existing.
//
// Chrome (Android) only generates a real installed PWA (a WebAPK) — the thing
// that's required for share_target to register in the OS share sheet — when a
// service worker with a fetch handler is present. A plain "Add to Home Screen"
// without one just creates a bookmark shortcut, which never shows up as a share
// target no matter what the manifest says.
//
// HotDrop is a live-sync tool (polling, uploads, downloads), so caching anything
// here would actively cause bugs — stale room state, stale files. This worker
// exists solely to satisfy the installability check and otherwise gets out of
// the way completely: no caches, no interception, requests just hit the network
// exactly as if no service worker were installed at all.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Deliberately empty — no respondWith() call means the browser handles the
  // request normally. This is required to exist for installability, but must
  // not change behavior.
});
