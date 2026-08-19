/* Offline shell for the OBI tool. Bump CACHE when any asset below changes,
 * otherwise returning users keep the old build until they hard-reload. */
const CACHE = "powerdiag-obi-v58";

const ASSETS = [
  "./",
  "./index.html",
  "./vendor/powerdiag.css",
  "./styles.css",
  "./icon.svg",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/transport.js",
  "./js/lxt.js",
  "./js/i18n.js",
  "./js/version.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

/* Network first so a redeploy is picked up straight away, cache as the
 * fallback when the workshop has no connection. */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("./index.html")))
  );
});
