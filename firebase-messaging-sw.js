/* MS Chat - firebase-messaging-sw.js
   This is the ONE service worker the page registers. It loads sw.js (cache + notification actions)
   and Firebase Messaging for background push. Server must send DATA-ONLY messages
   (no "notification" key) so we can show buttons ourselves. */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
importScripts('/sw.js');

firebase.initializeApp({
  apiKey: 'AIzaSyD7Nt1wwgGy5GxKFrc1NQvv8ulA3fDSJQE',
  authDomain: 'ms-chat-517b8.firebaseapp.com',
  projectId: 'ms-chat-517b8',
  storageBucket: 'ms-chat-517b8.firebasestorage.app',
  messagingSenderId: '34240289213',
  appId: '1:34240289213:web:d9f18bcfa824bbac5e1ad4'
});

try {
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const d = payload.data || {};
    // If an old-style "notification" payload arrives, FCM already shows it; avoid duplicates.
    if (payload.notification && !d.title) return;
    return self.showMsgNotification(d);
  });
} catch (e) { /* FCM optional */ }
