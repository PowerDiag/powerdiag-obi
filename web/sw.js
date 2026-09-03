/* Offline shell for the OBI tool. Bump CACHE when any asset below changes,
 * otherwise returning users keep the old build until they hard-reload. */
const CACHE = "powerdiag-obi-v72";

const ASSETS = [
  "./",
  "./index.html",
  "./vendor/powerdiag.css",
  "./styles.css",
  "./icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./screenshots/dashboard.png",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/transport.js",
  "./js/lxt.js",
  "./js/i18n.js",
  "./js/version.js",
  "./js/stk500.js",
  /* Flashing has to work for someone who has just soldered a board and is
   * not near their own network, so the images are part of the shell. */
  "./firmware/index.json",
  "./firmware/powerdiag-obi.hex",
  "./firmware/arduino-obi-upstream.hex",
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

/* How long to wait for the network before falling back to what we already
 * have. A dead connection fails at once and costs nothing; a half-dead one --
 * weak workshop Wi-Fi, a phone with one bar -- can hang for half a minute,
 * which is slower than being offline outright. */
const NETWORK_TIMEOUT_MS = 2500;

function fromCache(request) {
  return caches.match(request).then((hit) => hit || caches.match("./index.html"));
}

/* Network first so a redeploy is picked up straight away, cache as the
 * fallback when the workshop has no connection -- or has one too poor to be
 * worth waiting for. The request is left running either way, so the answer
 * that arrives late still refreshes the cache for next time. */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const fresh = fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  });

  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(fromCache(event.request).then((hit) => hit || fresh)), NETWORK_TIMEOUT_MS);
  });

  event.respondWith(
    Promise.race([fresh.catch(() => fromCache(event.request)), timeout])
  );

  /* Keep the worker alive until the network settles, so a late response still
   * lands in the cache even though the page was served from it. */
  event.waitUntil(fresh.catch(() => {}));
});
