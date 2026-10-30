// Tiny service worker: lets Inner Circle open instantly and keeps the app shell available offline.
// Photos and family data are never cached here; they always come fresh from your private database.
const CACHE = "inner-circle-v38";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.json", "icon.svg",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === "https://esm.sh") {
    // The app's code libraries never change for a given address: keep a copy so the app opens fast and works offline.
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== self.location.origin) return; // never touch database or photo requests
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && !url.search) {   // never keep invite or event links in the cache
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});

// Push notifications: shows a short message when the family shares something.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Inner Circle", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Inner Circle", {
    body: d.body || "",
    tag: d.tag || "inner-circle",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const url = (e.notification.data && e.notification.data.url) || "./";
    for (const c of list) {
      if ("focus" in c) return c.focus().then((cl) => (cl && url !== "./" && "navigate" in cl ? cl.navigate(url) : cl));
    }
    return self.clients.openWindow(url);
  }));
});
