# MS Chat v2 (Vercel + Upstash Redis + Firebase Push + Vercel Blob)

Telegram-style installable PWA.
Domain: https://ms-chat-messager.vercel.app

## Files (all in repo root, except api/)
| File | Kaam |
|---|---|
| `index.html` | Poori app UI (badges design, chat, settings) |
| `api/index.js` | Backend (ek serverless function) |
| `notification.js` | Client: permission, FCM token, sound, badge, deep link |
| `sw.js` | Cache + notification buttons (Reply / Mark as read / Mute) |
| `firebase-messaging-sw.js` | Asli service worker (sw.js ko import karta hai) + FCM background push |
| `vercel.json` | Rewrites (`/api/*`, `/{username}`) + headers |
| `package.json` | Dependencies |

Public assets (already hain): `icon-192.png`, `icon-512.png`, `maskable-512.png`, `notification.mp3`, `manifest.json`

## Deploy
1. Sab files GitHub repo mein daalo. `api/index.js` folder ke andar hi rahe.
2. Vercel -> Add New Project -> repo import -> Framework: **Other**, build command khali.
3. Vercel -> Storage:
   - **Upstash Redis** connect karo (KV_REST_API_URL / KV_REST_API_TOKEN auto aa jate hain).
   - **Blob** store connect karo (`BLOB_READ_WRITE_TOKEN` auto aata hai) - photo/video/audio/files ke liye.
4. Firebase Console (project `ms-chat-517b8`):
   - Project settings -> **Cloud Messaging** -> *Web Push certificates* -> Generate key pair -> public key copy karo
     -> `notification.js` mein `VAPID_KEY` ki jagah paste karo.
   - Project settings -> **Service accounts** -> *Generate new private key* -> JSON file download.
     Poora JSON Vercel Environment Variable `FIREBASE_SERVICE_ACCOUNT` mein paste karo. **Ye JSON kabhi GitHub mein mat daalna.**
5. Optional env: `AUTH_SECRET` (lambi random text), `SMTP_*` ya `RESEND_API_KEY` (email OTP ke liye).
6. Redeploy -> `https://ms-chat-messager.vercel.app/api/health` -> `{"ok":true,"db":true}` aana chahiye.
7. Chrome Android -> menu -> **Install app**.

## Notifications kaise kaam karte hain
- Server **data-only** FCM message bhejta hai: `title, body, chatId, msgId, icon, ts`.
- `firebase-messaging-sw.js` unhe icon `icon-512.png` + badge ke saath dikhata hai, 3 buttons: **Reply**, **Mark as read**, **Mute (1h)**.
- Notification tap karo -> seedha usi chat / message par khulta hai (`/?chat=ID&msg=ID`).
- Buttons `/api/notif/action` ko call karte hain (login token IndexedDB mein SW ke paas save hota hai).

## Honest limits
- Notification sound: browser push mein custom mp3 background mein play nahi hota (OS ki default awaaz aati hai). `notification.mp3` tab bajta hai jab app khuli ho.
- Inline **Reply** box Android Chrome par chalta hai. iPhone par push ke liye app Home Screen par install honi chahiye (iOS 16.4+), aur buttons limited hote hain.
- Vercel function body limit ~4.5 MB hai, isliye bade files (video, 70 MB Saved Messages) browser se **seedha Blob par upload** hongi (client upload token), function se nahi.
