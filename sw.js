/* ============================================================
   Sijui Game - Progressive Web App Service Worker
   Offline caching, fast loading, and standalone app support.
   ============================================================ */

const CACHE_NAME = "sijui-pwa-v3";

const PRECACHE_ASSETS = [
  "/",
  "/Index.html",
  "/manifest.json",
  "/assets/fonts/ManlineSlabs-pgPVy.otf",
  "/assets/fonts/ManlineSlabs-xRWVj.ttf",
  "/assets/images/city-skyline.png",
  "/assets/images/logo.png",
  "/assets/images/logo-full.png",
  "/assets/images/favicon.ico",
  "/assets/images/favicon-16x16.png",
  "/assets/images/favicon-32x32.png",
  "/assets/images/favicon-192x192.png",
  "/assets/images/apple-touch-icon.png",
  "/assets/images/icon-192.png",
  "/assets/images/icon-maskable-192.png",
  "/assets/images/icon-512.png",
  "/assets/images/icon-maskable-512.png"
];

// Install: precache essential shell files
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Use map + Promise.allSettled to ensure individual failures don't block install
      await Promise.allSettled(
        PRECACHE_ASSETS.map(url =>
          fetch(url, { cache: "reload" })
            .then(res => {
              if (res.ok) return cache.put(url, res);
            })
            .catch(err => {
              console.warn("[SW] Failed to precache:", url, err);
            })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up outdated caches and claim clients immediately
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log("[SW] Removing old cache:", key);
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: smart caching strategies
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests from the same origin (or relative)
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // 1. Navigation requests (HTML pages): Network First, fallback to cached Index.html
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          return caches.match("/Index.html") || caches.match("/");
        })
    );
    return;
  }

  // 2. Read-only API endpoints for decks and sounds: Network First, fallback to cached
  if (url.pathname.startsWith("/api/published-decks") || url.pathname.startsWith("/api/sounds")) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          // If no cache for API, return an empty fallback response
          return new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" }
          });
        })
    );
    return;
  }

  // Other API calls (login, admin mutation, etc.): bypass service worker
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // 3. Static Assets (fonts, images, audio, css, scripts): Stale-While-Revalidate
  event.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// Support manual skipWaiting trigger from client
self.addEventListener("message", event => {
  if (event.data && event.data.action === "skipWaiting") {
    self.skipWaiting();
  }
});

