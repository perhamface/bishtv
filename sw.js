// bishTV service worker: shows reminder notifications when the push service wakes it.
// Reminders are stored on this device (IndexedDB "bishtv" > "kv" > "rem"); the server only sends a wake-up.
function db() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open("bishtv", 1);
    r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function getRem(d) {
  return new Promise(function (res) {
    var q = d.transaction("kv").objectStore("kv").get("rem");
    q.onsuccess = function () { res(Array.isArray(q.result) ? q.result : []); };
    q.onerror = function () { res([]); };
  });
}
function putRem(d, list) {
  return new Promise(function (res) {
    var t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(list, "rem");
    t.oncomplete = res; t.onerror = res;
  });
}
var fTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/* ---------- offline + instant open ----------
   The app's own files are answered from a saved copy straight away, then re-checked with the server in the
   background. If index.html has changed, the open app is told so it can offer a reload. Listings, programme
   images and the reminder service are never intercepted. */
var SHELL = "bishtv-shell-v1", FONTS = "bishtv-fonts-v1";
var CORE = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(CORE.map(function (u) {
      return fetch(u, { cache: "reload" }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
    }));
  }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("bishtv-") === 0 && k !== SHELL && k !== FONTS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // typeface: saved the first time it loads, then always served from the saved copy
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; });
      });
    }));
    return;
  }
  if (url.origin !== self.location.origin || /\/sw\.js$/.test(url.pathname) || url.pathname.indexOf("/worker/") >= 0) return;

  var isPage = req.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname);
  e.respondWith(caches.open(SHELL).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var old = isPage && hit ? hit.clone() : null; // copied now, before the saved response is handed to the page
      var fresh = fetch(req.url, { cache: "no-cache" }).then(function (r) {
        if (!r.ok) return;
        var copy = r.clone();
        var saved = old ? Promise.all([old.text(), r.clone().text()]).then(function (t) { return t[0] !== t[1]; }) : Promise.resolve(false);
        return saved.then(function (changed) {
          return c.put(req, copy).then(function () {
            // wait a moment so the page that is still loading exists and is listening
            if (changed) return new Promise(function (res) { setTimeout(res, 2500); }).then(function () {
              return self.clients.matchAll({ type: "window", includeUncontrolled: true });
            }).then(function (wins) {
              wins.forEach(function (w) { w.postMessage({ type: "bishtv-update" }); });
            });
          });
        });
      });
      e.waitUntil(fresh.catch(function () {}));
      return hit || fetch(req);
    });
  }));
});

self.addEventListener("push", function (e) {
  e.waitUntil(db().then(function (d) {
    return getRem(d).then(function (list) {
      var now = Date.now(), due = [], keep = [];
      list.forEach(function (r) {
        if (r.at <= now + 90000) { if (r.s + 30 * 60000 > now) due.push(r); } // due (skip any that are long past)
        else keep.push(r);
      });
      return putRem(d, keep).then(function () {
        if (!due.length) return self.registration.showNotification("bishTV", { body: "A programme you set a reminder for is starting soon.", icon: "icon-192.png", badge: "icon-192.png", tag: "bishtv-generic" });
        return Promise.all(due.map(function (r) {
          var mins = Math.round((r.s - now) / 60000);
          var when = mins > 0 ? "Starts at " + fTime.format(r.s) + " (in " + mins + " min)" : "Started at " + fTime.format(r.s);
          return self.registration.showNotification(r.n, { body: when + " on " + r.ch, icon: "icon-192.png", badge: "icon-192.png", tag: "bishtv-" + r.id, timestamp: r.s });
        }));
      });
    });
  }).catch(function () {
    return self.registration.showNotification("bishTV", { body: "A programme you set a reminder for is starting soon.", icon: "icon-192.png", tag: "bishtv-generic" });
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) if ("focus" in wins[i]) return wins[i].focus();
    return self.clients.openWindow("./");
  }));
});
