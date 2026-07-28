/* GESTION — FKH Sécurité · Service Worker (Niveau 2 : notifications même appli fermée) */
var GEST_URL = '/fkh-securite-apps/gestion/';

self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e){
  var d = { title: 'GESTION — FKH Sécurité', body: '🔍 Du nouveau : une demande vient de passer « en recherche ». Ouvre l\'appli pour la traiter.', url: GEST_URL, tag: 'fkh-' + Date.now() };
  try {
    if (e.data) {
      var j = e.data.json();
      if (j.title) d.title = j.title;
      if (j.body != null) d.body = j.body;
      if (j.url) d.url = j.url;
      if (j.tag) d.tag = j.tag;
    }
  } catch (_) {
    try { if (e.data) d.body = e.data.text(); } catch (__) {}
  }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    tag: d.tag,
    renotify: true,
    icon: 'icon.svg',
    badge: 'icon.svg',
    vibrate: [120, 60, 120],
    data: { url: d.url }
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || GEST_URL;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cls){
      for (var i = 0; i < cls.length; i++) {
        if (cls[i].url.indexOf('/gestion/') >= 0) { return cls[i].focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
