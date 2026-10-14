const CACHE = 'ms-chat-v3';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/firebase-cloud-messaging-push-scope')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
      return res;
    }).catch(() => caches.match('/')))
  );
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chatId = e.notification.data && e.notification.data.chatId;
  e.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    for (const c of list) { c.postMessage({chatId}); c.focus(); return; }
    clients.openWindow('/');
  }));
});
/* Firebase Cloud Messaging background handler */
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyD7Nt1wwgGy5GxKFrc1NQvv8ulA3fDSJQE",
    authDomain: "ms-chat-517b8.firebaseapp.com",
    projectId: "ms-chat-517b8",
    storageBucket: "ms-chat-517b8.firebasestorage.app",
    messagingSenderId: "34240289213",
    appId: "1:34240289213:web:d9f18bcfa824bbac5e1ad4",
  });
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const n = payload.notification || {};
    self.registration.showNotification(n.title || 'MS Chat', {
      body: n.body || '',
      icon: 'https://ms-chat-messager.vercel.app/icon-512.png',
      badge: 'https://ms-chat-messager.vercel.app/icon-512.png',
      data: payload.data || {},
      tag: (payload.data && payload.data.chatId) || 'ms-chat',
    });
  });
} catch(e) { /* FCM optional */ }
