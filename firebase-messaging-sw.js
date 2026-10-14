importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyD7Nt1wwgGy5GxKFrc1NQvv8ulA3fDSJQE",
  authDomain: "ms-chat-517b8.firebaseapp.com",
  projectId: "ms-chat-517b8",
  storageBucket: "ms-chat-517b8.firebasestorage.app",
  messagingSenderId: "34240289213",
  appId: "1:34240289213:web:d9f18bcfa824bbac5e1ad4"
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || 'MS Chat', {
    body: n.body || '',
    icon: 'https://ms-chat-messager.vercel.app/icon-512.png',
    badge: 'https://ms-chat-messager.vercel.app/icon-512.png',
    data: payload.data || {},
    tag: (payload.data && payload.data.chatId) || 'ms-chat'
  });
});
