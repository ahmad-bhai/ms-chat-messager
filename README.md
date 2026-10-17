# MS Chat

A Telegram-inspired messenger with Apple emojis, voice notes, file sharing up to 600 MB, reactions, and PWA support.

## Features

- ✅ Apple/Telegram emojis (via iamcal/emoji-data)
- ✅ Photo, video, voice, audio, file sharing (Vercel Blob — up to 600 MB)
- ✅ Message reactions (double-tap + long-press)
- ✅ Reply, edit, delete, pin, forward messages
- ✅ Chat pin, mute, clear, delete
- ✅ Profile view, block, mute, custom contact names
- ✅ Side panel with accounts (max 5), contacts, settings
- ✅ Two-step PIN, password change, email change, forgot password
- ✅ Wallpaper picker (preset + upload + URL)
- ✅ In-app link viewer (external links open in app)
- ✅ Direct link: `/username` opens chat
- ✅ Notifications (sound + FCM push optional)
- ✅ PWA installable

## Tech Stack

- **Frontend**: Vanilla JS + HTML + CSS (single file)
- **Backend**: Vercel Serverless Function (`api/index.js`)
- **Database**: Upstash Redis (REST API)
- **File Storage**: Vercel Blob
- **Push**: Firebase Cloud Messaging (optional)

## Setup

### 1. Clone Repo

```bash
git clone https://github.com/YOUR_USERNAME/ms-chat-messengersss.git
cd ms-chat-messengersss
