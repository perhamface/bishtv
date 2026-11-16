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

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

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
