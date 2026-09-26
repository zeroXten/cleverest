/* CLEVEREST service worker — offline-first app shell.

   Strategy: STALE-WHILE-REVALIDATE for same-origin GETs. Every request is
   answered from the cache immediately (instant launch, and immune to a weak
   signal that would otherwise hang a network-first fetch), while a fresh copy is
   fetched in the background and stored for next time. So the app always loads
   fast and works offline, and updates land quietly without interrupting a
   session — the new version is used on the next launch, or when the user taps
   "refresh" on the update prompt.

   Updates are user-controlled: a new worker installs and then WAITS (no
   skipWaiting on install). The page shows an "Update ready" pill and, only when
   the user acts, posts SKIP_WAITING so the new worker activates and the page
   reloads once. Bump the version in CACHE on every release so the byte-changed
   worker is detected and the prompt appears. */
var CACHE = "cleverest-1.16.0";
var ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-64.png"
];

/* Precache the shell, fetching fresh copies (bypassing the HTTP cache). Each
   asset is added individually so one failure can't abort the whole precache. */
async function precache() {
  var cache = await caches.open(CACHE);
  await Promise.all(ASSETS.map(function (u) {
    return cache.add(new Request(u, { cache: "reload" })).catch(function () {});
  }));
}

self.addEventListener("install", function (e) {
  // No skipWaiting: the new worker waits until the user chooses to update.
  e.waitUntil(precache());
});

self.addEventListener("activate", function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    await self.clients.claim();
  })());
});

/* The page asks the waiting worker to take over (after the user taps refresh). */
self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (fonts, analytics) pass through

  e.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var cached = await cache.match(req);

    var networkPromise = fetch(req).then(function (res) {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    }).catch(function () { return null; });

    if (cached) {
      try { e.waitUntil(networkPromise); } catch (_) {} // refresh in the background
      return cached;
    }

    var res = await networkPromise;
    if (res) return res;
    if (req.mode === "navigate") {            // offline, uncached route -> app shell
      var shell = await cache.match("index.html");
      if (shell) return shell;
    }
    return Response.error();
  })());
});
