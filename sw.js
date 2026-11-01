/* MS Chat - sw.js
   Cache + notification display + notification actions (Reply / Mark as read / Mute) + deep link open.
   NOTE: The page registers /firebase-messaging-sw.js, which importScripts() this file,
   so both live in ONE service worker (no scope conflict). */
const CACHE = 'ms-chat-v2';
const ORIGIN = 'https://ms-chat-messager.vercel.app';
const ICON = ORIGIN + '/icon-512.png';
const BADGE = ORIGIN + '/icon-192.png';
const SHELL = ['/', '/index.html', '/manifest.json', '/notification.js', '/icon-192.png', '/icon-512.png'];
const EMOJI_HOST = 'magic-scripts-emojis.vercel.app';

/* ---------- tiny IndexedDB key-value (stores auth token for notification actions) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ms-chat-sw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvSet(k, v) {
  const db = await idb();
  return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; });
}
async function kvGet(k) {
  const db = await idb();
  return new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
}

/* ---------- lifecycle ---------- */
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Emoji images: cache-first (they never change)
  if (url.hostname === EMOJI_HOST) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }
      catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (/\.(mp4|webm|mp3|ogg|m4a|wav)$/i.test(url.pathname) && url.pathname !== '/notification.mp3') return;

  // Pages: network-first, fallback to cached shell
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const cl = res.clone(); caches.open(CACHE).then(c => c.put('/index.html', cl)); return res;
    }).catch(() => caches.match('/index.html').then(r => r || caches.match('/'))));
    return;
  }
  // Static assets: stale-while-revalidate
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res.ok) { const cl = res.clone(); caches.open(CACHE).then(c => c.put(req, cl)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});

/* ---------- messages from page ---------- */
self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'SET_AUTH') e.waitUntil(kvSet('token', m.token || null));
  if (m.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------- show notification (called by firebase-messaging-sw.js) ---------- */
self.showMsgNotification = function (d) {
  d = d || {};
  const chatId = d.chatId || 'ms-chat';
  const title = d.title || d.senderName || 'MS Chat';
  const opts = {
    body: d.body || '',
    icon: d.icon || ICON,
    badge: BADGE,
    image: d.image || undefined,
    tag: 'chat-' + chatId,
    renotify: true,
    silent: d.silent === '1',
    vibrate: [120, 60, 120],
    timestamp: Number(d.ts) || Date.now(),
    data: { chatId: d.chatId, msgId: d.msgId, url: d.url },
    actions: [
      { action: 'reply', title: 'Reply', type: 'text', placeholder: 'Write a message...' },
      { action: 'read', title: 'Mark as read' },
      { action: 'mute', title: 'Mute' }
    ]
  };
  return self.registration.showNotification(title, opts);
};

/* ---------- notification click / actions ---------- */
async function callAction(body) {
  const token = await kvGet('token');
  if (!token) return null;
  try {
    const r = await fetch('/api/notif/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) { return null; }
}

async function openChat(chatId, msgId) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target = list.find(c => c.url.startsWith(self.location.origin));
  if (target) {
    await target.focus();
    target.postMessage({ type: 'OPEN_CHAT', chatId, msgId });
    return;
  }
  const q = new URLSearchParams();
  if (chatId) q.set('chat', chatId);
  if (msgId) q.set('msg', msgId);
  await self.clients.openWindow('/?' + q.toString());
}

self.addEventListener('notificationclick', e => {
  const n = e.notification;
  const data = n.data || {};
  const action = e.action;
  n.close();

  if (action === 'reply') {
    const text = (e.reply || '').trim();
    if (!text) { e.waitUntil(openChat(data.chatId, data.msgId)); return; }
    e.waitUntil(callAction({ action: 'reply', chatId: data.chatId, text }).then(res => {
      if (!res || !res.ok) return openChat(data.chatId, data.msgId); // not logged in / failed -> open app
    }));
    return;
  }
  if (action === 'read') {
    e.waitUntil(callAction({ action: 'read', chatId: data.chatId, msgId: data.msgId })
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(cs => cs.forEach(c => c.postMessage({ type: 'NOTIF_ACTION', action: 'read', chatId: data.chatId }))));
    return;
  }
  if (action === 'mute') {
    const until = Date.now() + 60 * 60 * 1000; // 1 hour
    e.waitUntil(callAction({ action: 'mute', chatId: data.chatId, until })
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(cs => cs.forEach(c => c.postMessage({ type: 'NOTIF_ACTION', action: 'mute', chatId: data.chatId, until }))));
    return;
  }
  // Plain tap: open that exact chat/message
  e.waitUntil(openChat(data.chatId, data.msgId));
});
