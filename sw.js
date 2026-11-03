/* Inner Circle service worker: keeps the app opening fast, and shows push notifications. */
const CACHE = "inner-circle-v63";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.json", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* network first, so a new upload always wins; the saved copy is only a fallback when offline */
self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const lib = url.hostname === "esm.sh";
  if (!sameOrigin && !lib) return;   // database, storage and video calls are never touched
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === "navigate" ? caches.match("index.html") : undefined) || Response.error();
      });
    })
  );
});

self.addEventListener("push", function (e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Inner Circle", body: e.data ? e.data.text() : "" }; }
  const tag = d.tag || "inner-circle";
  const ring = /^call-/.test(tag);
  e.waitUntil(self.registration.showNotification(d.title || "Inner Circle", {
    body: d.body || "",
    tag: tag,
    icon: "icon-192.png",
    badge: "icon-192.png",
    renotify: true,
    requireInteraction: ring,
    data: { url: d.url || "./" }
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  const hasLink = /[?#]/.test(target);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if (c.url.indexOf(self.registration.scope) === 0) {
          /* open links (a call, a chat) need a fresh load; a plain tap just brings the app forward */
          if (hasLink && c.navigate) return c.navigate(target).then(function (w) { return (w || c).focus(); }).catch(function () { return c.focus(); });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
