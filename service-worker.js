/* Catalyst – Service Worker (App-Hülle offline, Daten immer frisch) */
const CACHE_PREFIX = "catalyst-";
const CACHE = "catalyst-v21";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=21",
  "./app.js?v=21",
  "./vendor/supabase-2.110.3.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-v2-192.png",
  "./icons/icon-v2-512.png",
  "./icons/apple-touch-icon-v2.png",
];
const STATIC_URLS = new Set(ASSETS.map((asset) => new URL(asset, self.location).href));

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }
  // Nur bekannte App-Dateien vom eigenen Ursprung cachen. Depot-Daten aus
  // Supabase landen NIE im Cache des Geräts.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !STATIC_URLS.has(url.href)) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});

// --- Push-Mitteilungen ------------------------------------------------------ //
// Der Catalyst schickt kurze Texte (neue Meldung, neue KI-Einordnung). Ein Tipp
// darauf öffnet die App direkt im passenden Reiter.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { text: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titel || "Catalyst", {
    body: d.text || "",
    tag: d.tag || undefined,
    icon: "icons/icon-v2-192.png",
    badge: "icons/icon-v2-192.png",
    data: { ansicht: d.ansicht || "meldungen" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const ansicht = e.notification.data?.ansicht || "meldungen";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ("focus" in c) { c.postMessage({ ansicht }); return c.focus(); }
    }
    return self.clients.openWindow(new URL(`./?ansicht=${ansicht}`, self.location).href);
  }));
});
