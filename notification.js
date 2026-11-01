/* MS Chat - notification.js
   Client side: service worker register, FCM token, foreground sound/badge,
   permissions (notifications / camera / mic / storage), open-chat deep links.
   Usage (index.html):
     <script src="/notification.js"></script>
     MSNotify.init({ token: authToken, onOpenChat:(chatId,msgId)=>{...}, onForeground:(data)=>{...} });
*/
(function () {
  'use strict';

  const FB_CONFIG = {
    apiKey: 'AIzaSyD7Nt1wwgGy5GxKFrc1NQvv8ulA3fDSJQE',
    authDomain: 'ms-chat-517b8.firebaseapp.com',
    projectId: 'ms-chat-517b8',
    storageBucket: 'ms-chat-517b8.firebasestorage.app',
    messagingSenderId: '34240289213',
    appId: '1:34240289213:web:d9f18bcfa824bbac5e1ad4'
  };
  // Firebase Console -> Project settings -> Cloud Messaging -> Web Push certificates -> Key pair
  const VAPID_KEY = 'BD4RUDm98_pv7afX56-5V0HTjWSZri3uke2iHTlsAbnyJglvIollL4cdfYd20E8Q2_Suh3Q3kSoKNJ_cwL_qY-U';
  const FB_VER = '10.12.0';
  const SOUND_URL = 'https://ms-chat-messager.vercel.app/notification.mp3';

  const state = { reg: null, messaging: null, token: null, opts: {}, activeChat: null, fcmToken: null };
  const sound = new Audio(SOUND_URL);
  sound.preload = 'auto';

  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });

  const mutes = () => { try { return JSON.parse(localStorage.getItem('ms_mutes') || '{}'); } catch (e) { return {}; } };
  function isMuted(chatId) {
    const m = mutes()[chatId];
    return !!m && (m === -1 || m > Date.now());
  }
  function setMute(chatId, untilMs) {
    const m = mutes();
    if (untilMs === 0) delete m[chatId]; else m[chatId] = untilMs; // -1 = forever
    try { localStorage.setItem('ms_mutes', JSON.stringify(m)); } catch (e) {}
  }

  async function api(path, body) {
    const r = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (state.token || '') },
      body: JSON.stringify(body || {})
    });
    return r.json().catch(() => ({}));
  }

  function sendToSW(msg) {
    const sw = (state.reg && (state.reg.active || state.reg.waiting)) || navigator.serviceWorker.controller;
    if (sw) sw.postMessage(msg);
  }

  function setAuth(token) {
    state.token = token || null;
    sendToSW({ type: 'SET_AUTH', token: state.token });
  }

  function setBadge(n) {
    try {
      if (navigator.setAppBadge) { n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); }
    } catch (e) {}
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = n > 0 ? '(' + n + ') ' + base : base;
  }

  function playSound() { try { sound.currentTime = 0; sound.play().catch(() => {}); } catch (e) {} }

  async function permission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'default') return Notification.requestPermission();
    return Notification.permission;
  }

  async function getFcmToken() {
    if (!state.reg || VAPID_KEY.startsWith('PASTE')) return null;
    if ((await permission()) !== 'granted') return null;
    try {
      if (!window.firebase) {
        await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-app-compat.js');
        await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-messaging-compat.js');
      }
      if (!firebase.apps.length) firebase.initializeApp(FB_CONFIG);
      state.messaging = firebase.messaging();
      const t = await state.messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: state.reg });
      state.fcmToken = t;
      state.messaging.onMessage(payload => {
        const d = payload.data || {};
        if (isMuted(d.chatId)) return;
        const viewing = document.visibilityState === 'visible' && state.activeChat === d.chatId;
        if (!viewing) playSound();
        if (state.opts.onForeground) state.opts.onForeground(d, viewing);
      });
      return t;
    } catch (e) { console.warn('FCM token failed', e); return null; }
  }

  async function registerDevice() {
    const t = await getFcmToken();
    if (t && state.token) {
      await api('/push/register', { fcmToken: t, ua: navigator.userAgent, platform: navigator.platform });
    }
    return t;
  }

  async function unregisterDevice() {
    if (state.fcmToken && state.token) await api('/push/unregister', { fcmToken: state.fcmToken });
    try { if (state.messaging) await state.messaging.deleteToken(); } catch (e) {}
    state.fcmToken = null;
  }

  function handleUrlOpen() {
    const p = new URLSearchParams(location.search);
    const chat = p.get('chat');
    if (chat && state.opts.onOpenChat) {
      state.opts.onOpenChat(chat, p.get('msg'));
      history.replaceState(null, '', location.pathname);
    }
  }

  async function init(opts) {
    state.opts = opts || {};
    state.token = state.opts.token || null;
    if (!('serviceWorker' in navigator)) return false;
    state.reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    navigator.serviceWorker.addEventListener('message', e => {
      const m = e.data || {};
      if (m.type === 'OPEN_CHAT' && state.opts.onOpenChat) state.opts.onOpenChat(m.chatId, m.msgId);
      if (m.type === 'NOTIF_ACTION' && state.opts.onAction) state.opts.onAction(m);
    });
    setAuth(state.token);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setBadge(0); });
    handleUrlOpen();
    return true;
  }

  /* Permissions like a native app */
  async function askMedia(kind) { // 'camera' | 'mic' | 'both'
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: kind === 'camera' || kind === 'both',
        audio: kind === 'mic' || kind === 'both'
      });
      s.getTracks().forEach(t => t.stop());
      return true;
    } catch (e) { return false; }
  }
  async function askStorage() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }
    catch (e) { return false; }
  }

  window.MSNotify = {
    init, setAuth, permission, registerDevice, unregisterDevice,
    setBadge, playSound, isMuted, setMute, askMedia, askStorage,
    setActiveChat: id => { state.activeChat = id; },
    get fcmToken() { return state.fcmToken; }
  };
})();
