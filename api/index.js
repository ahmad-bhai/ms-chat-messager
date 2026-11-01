/* MS Chat - api/index.js (single Vercel serverless function, CommonJS)
   Env: KV_REST_API_URL/TOKEN (Upstash), BLOB_READ_WRITE_TOKEN, FIREBASE_SERVICE_ACCOUNT,
        AUTH_SECRET, RESEND_API_KEY (+MAIL_FROM) for email codes, OTP_DEBUG=1 (dev only) */
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const r = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});
const SECRET = process.env.AUTH_SECRET || 'ms-chat-secret';
const now = () => Date.now();
const rid = () => crypto.randomBytes(24).toString('hex');
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex');
const hs = (v, uid) => crypto.createHash('sha256').update(SECRET + uid + v).digest('hex');
const ver = () => r.incr('ver');
const parts = c => (c[0] === 's' ? [c.slice(2)] : c.slice(2).split(':'));
const can = (u, c) => typeof c === 'string' && /^[ps]:/.test(c) && parts(c).includes(u);
const peerOf = (c, u) => (c[0] === 's' ? u : parts(c).find(x => x !== u));
const pairId = (a, b) => (a === b ? 's:' + a : 'p:' + [a, b].sort().join(':'));
const getM = (u, c) => r.get(`cm:${u}:${c}`).then(x => x || {});
const setM = (u, c, o) => r.set(`cm:${u}:${c}`, o);
const vis = (m, u, clr) => m && !m.dead && !(m.del || []).includes(u) && m.ts > (clr || 0);
const muted = m => m.mute === -1 || m.mute > now();
const isBlk = async (a, b) => a !== b && !!((await r.sismember('bl:' + a, b)) || (await r.sismember('bl:' + b, a)));

async function mail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) return false;
  const x = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'MS Chat <onboarding@resend.dev>', to, subject, text })
  });
  return x.ok;
}

let adm;
function fb() {
  if (adm !== undefined) return adm;
  try {
    const a = require('firebase-admin');
    if (!a.apps.length) a.initializeApp({ credential: a.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    adm = a;
  } catch (e) { adm = null; }
  return adm;
}

function status(u, seen, blocked, vid) {
  if (u.id === vid) return 'online';
  if (blocked || !seen) return 'last seen long time ago';
  const a = now() - seen, d = 864e5;
  if (a < 25000) return 'online';
  if (!u.hideSeen) return 'ts:' + seen;
  return 'last seen ' + (a < 7 * d ? 'recently' : a < 30 * d ? 'within a week' : a < 365 * d ? 'within a month' : a < 730 * d ? 'within a year' : 'a long time ago');
}
async function pub(u, vid) {
  if (!u) return null;
  const blocked = await isBlk(u.id, vid);
  const seen = (await r.get('seen:' + u.id)) || 0;
  return { id: u.id, name: u.name, username: u.username, bio: u.bio || '', dob: u.dob || '', avatar: blocked ? '' : u.avatar || '', status: status(u, seen, blocked, vid) };
}
const own = u => ({ id: u.id, email: u.email, name: u.name, username: u.username, bio: u.bio || '', dob: u.dob || '', avatar: u.avatar || '', hideSeen: !!u.hideSeen, two: !!(u.sec && u.sec.two), pass: !!(u.sec && u.sec.pass) });

async function newSession(uid, req) {
  const sid = rid();
  await r.set('sess:' + sid, { uid, ua: (req.headers['user-agent'] || '').slice(0, 120), ts: now() });
  await r.sadd('us:' + uid, sid);
  return sid;
}
async function auth(req) {
  const t = (req.headers.authorization || '').slice(7);
  if (!t) return null;
  const s = await r.get('sess:' + t);
  if (!s) return null;
  await r.set('seen:' + s.uid, now());
  return { sid: t, uid: s.uid };
}

async function bump(chat, m) {
  const v = await ver();
  m.v = v;
  await r.hset('mh:' + chat, { [m.id]: m });
  for (const u of parts(chat)) await r.zadd('uf:' + u, { score: v, member: chat + '|' + m.id });
}
async function touch(u, chat) {
  await r.zadd('uf:' + u, { score: await ver(), member: chat + '|0' });
}

async function notify(peer, from, m, chat) {
  try {
    const meta = await getM(peer, chat);
    if (muted(meta)) return;
    const toks = await r.smembers('fcm:' + peer);
    const a = fb();
    if (!toks.length || !a) return;
    const cn = await r.hget('ct:' + peer, from.id);
    const body = m.media ? '[' + m.media.type + '] ' + (m.text || '') : m.text;
    const out = await a.messaging().sendEachForMulticast({
      tokens: toks,
      data: { title: cn || from.name, body: String(body).slice(0, 140), chatId: chat, msgId: String(m.id), ts: String(m.ts), silent: meta.mute === -2 ? '1' : '' },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    });
    out.responses.forEach((x, i) => { if (!x.success && /not-registered|invalid/.test((x.error && x.error.code) || '')) r.srem('fcm:' + peer, toks[i]); });
  } catch (e) { /* push is best effort */ }
}

async function send(uid, b) {
  const chat = b.chat;
  if (!can(uid, chat)) return { err: 'forbidden' };
  const peer = peerOf(chat, uid);
  if (peer !== uid && (await isBlk(uid, peer))) return { err: 'You cannot message this user' };
  const text = String(b.text || '').slice(0, 4000);
  if (!text && !b.media) return { err: 'empty' };
  if (chat[0] === 's' && b.media) {
    const used = (await r.get('sv:' + uid)) || 0;
    if (used + (b.media.size || 0) > 70 * 1048576) return { err: 'Saved Messages full (70 MB limit)' };
    await r.incrby('sv:' + uid, b.media.size || 0);
  }
  const id = await r.incr('mid');
  const m = { id, chat, from: uid, text, ts: now(), media: b.media || null, reply: b.reply || null, fwd: b.fwd || null, react: {}, del: [], pin: [] };
  await bump(chat, m);
  await r.set('lm:' + chat, id);
  for (const u of new Set([uid, peer])) await r.zadd('ul:' + u, { score: m.ts, member: chat });
  if (peer !== uid) {
    await r.incr(`un:${peer}:${chat}`);
    await notify(peer, await r.get('user:' + uid), m, chat);
  }
  return { ok: true, msg: m };
}

async function markRead(uid, chat) {
  if (!can(uid, chat)) return { err: 'forbidden' };
  await r.set(`un:${uid}:${chat}`, 0);
  await r.set(`rd:${chat}:${uid}`, (await r.get('lm:' + chat)) || 0);
  const p = peerOf(chat, uid);
  if (p !== uid) await touch(p, chat);
  return { ok: true };
}
const allMsgs = async chat => (await r.hgetall('mh:' + chat)) || {};
const getMsg = async (c, b) => (can(c.uid, b.chat) ? r.hget('mh:' + b.chat, b.id) : null);

const A = {};
const open = {
  async '/auth/register'(req, b) {
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return { err: 'Invalid email' };
    if (String(b.password || '').length < 6) return { err: 'Password must be at least 6 characters' };
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) return { err: 'Name required' };
    if (await r.get('email:' + email)) return { err: 'Email already registered' };
    const id = String(7000000000 + (await r.incr('uid')));
    const username = String(b.username || '').replace(/^@/, '').trim() || 'user' + id.slice(-7);
    if (!/^[a-zA-Z]\w{2,31}$/.test(username)) return { err: 'Username: 3-32 chars, letters/numbers/_' };
    if (await r.get('uname:' + username.toLowerCase())) return { err: 'Username taken' };
    const salt = rid();
    const u = { id, email, name, username, bio: '', dob: '', avatar: '', salt, pw: hp(b.password, salt), sec: {}, created: now() };
    await r.set('user:' + id, u);
    await r.set('email:' + email, id);
    await r.set('uname:' + username.toLowerCase(), id);
    return { token: await newSession(id, req), me: own(u) };
  },
  async '/auth/login'(req, b) {
    const id = await r.get('email:' + String(b.email || '').trim().toLowerCase());
    const u = id && (await r.get('user:' + id));
    if (!u || hp(b.password || '', u.salt) !== u.pw) return { err: 'Wrong email or password' };
    if (u.sec && u.sec.two && (!b.two || hs(b.two, id) !== u.sec.two)) return { need2fa: true, err: b.two ? 'Wrong two-step password' : undefined };
    return { token: await newSession(id, req), me: own(u) };
  }
};

A['/me'] = async c => ({ me: own(await r.get('user:' + c.uid)) });
A['/me/update'] = async (c, b) => {
  const u = await r.get('user:' + c.uid);
  if (b.name !== undefined) { u.name = String(b.name).trim().slice(0, 40); if (!u.name) return { err: 'Name required' }; }
  if (b.bio !== undefined) u.bio = String(b.bio).slice(0, 120);
  if (b.dob !== undefined) u.dob = String(b.dob).slice(0, 10);
  if (b.avatar !== undefined) u.avatar = String(b.avatar);
  if (b.hideSeen !== undefined) u.hideSeen = !!b.hideSeen;
  if (b.username !== undefined && b.username !== u.username) {
    const nu = String(b.username).replace(/^@/, '').trim();
    if (!/^[a-zA-Z]\w{2,31}$/.test(nu)) return { err: 'Invalid username' };
    const ex = await r.get('uname:' + nu.toLowerCase());
    if (ex && ex !== c.uid) return { err: 'Username taken' };
    await r.del('uname:' + u.username.toLowerCase());
    await r.set('uname:' + nu.toLowerCase(), c.uid);
    u.username = nu;
  }
  if (b.email !== undefined && b.email !== u.email) {
    const ne = String(b.email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(ne)) return { err: 'Invalid email' };
    if (hp(b.password || '', u.salt) !== u.pw) return { err: 'Password required to change email' };
    if (await r.get('email:' + ne)) return { err: 'Email already used' };
    await r.del('email:' + u.email);
    await r.set('email:' + ne, c.uid);
    u.email = ne;
  }
  await r.set('user:' + c.uid, u);
  return { me: own(u) };
};
A['/user'] = async (c, b, q) => {
  const k = String(q.u || '').replace(/^@/, '');
  const id = /^\d{10}$/.test(k) ? k : await r.get('uname:' + k.toLowerCase());
  const u = id && (await r.get('user:' + id));
  if (!u) return { err: 'User not found' };
  return {
    user: await pub(u, c.uid), chat: pairId(c.uid, id), self: id === c.uid,
    cn: (await r.hget('ct:' + c.uid, id)) || '', blocked: !!(await r.sismember('bl:' + c.uid, id))
  };
};

A['/chats'] = async c => {
  const ids = (await r.zrange('ul:' + c.uid, 0, -1, { rev: true })).map(String);
  const sv = 's:' + c.uid;
  if (!ids.includes(sv)) ids.unshift(sv);
  const out = await Promise.all(ids.map(async chat => {
    const [meta, lm, un] = await Promise.all([getM(c.uid, chat), r.get('lm:' + chat), r.get(`un:${c.uid}:${chat}`)]);
    const m = lm ? await r.hget('mh:' + chat, lm) : null;
    const pid = peerOf(chat, c.uid);
    const [pu, cn] = await Promise.all([r.get('user:' + pid), r.hget('ct:' + c.uid, pid)]);
    if (!pu) return null;
    return { chat, saved: chat === sv, peer: await pub(pu, c.uid), cn: cn || '', last: vis(m, c.uid, meta.clr) ? m : null, unread: +un || 0, mute: muted(meta) || meta.mute === -2 ? meta.mute : 0, blocked: !!(await r.sismember('bl:' + c.uid, pid)) };
  }));
  return { chats: out.filter(Boolean), v: +(await r.get('ver')) || 0 };
};
A['/msgs'] = async (c, b, q) => {
  const chat = q.chat;
  if (!can(c.uid, chat)) return { err: 'forbidden' };
  const meta = await getM(c.uid, chat);
  const list = Object.values(await allMsgs(chat)).filter(m => vis(m, c.uid, meta.clr)).sort((a, b) => a.id - b.id);
  let from = Math.max(0, list.length - 120);
  if (q.mode === 'first') from = 0;
  if (q.around) from = Math.max(0, list.findIndex(m => m.id === +q.around) - 40);
  const pins = list.filter(m => (m.pin || []).includes(c.uid));
  return { msgs: list.slice(from, from + 120), pin: pins.length ? pins[pins.length - 1] : null, rd: +(await r.get(`rd:${chat}:${peerOf(chat, c.uid)}`)) || 0 };
};
A['/updates'] = async (c, b, q) => {
  const after = +q.after || 0;
  const v = +(await r.get('ver')) || 0;
  const mem = after < v ? await r.zrange('uf:' + c.uid, after + 1, '+inf', { byScore: true }) : [];
  const items = [], seen = new Set(), metas = {};
  for (const x of mem) {
    const [chat, id] = String(x).split('|');
    if (seen.has(String(x)) || !can(c.uid, chat)) continue;
    seen.add(String(x));
    const rd = +(await r.get(`rd:${chat}:${peerOf(chat, c.uid)}`)) || 0;
    if (id === '0') { items.push({ chat, rd }); continue; }
    metas[chat] = metas[chat] || (await getM(c.uid, chat));
    const m = await r.hget('mh:' + chat, id);
    items.push({ chat, rd, msg: vis(m, c.uid, metas[chat].clr) ? m : { id: +id, gone: true } });
  }
  return { v, items };
};
A['/open'] = async (c, b) => ({ chat: pairId(c.uid, String(b.peerId)) });
A['/send'] = (c, b) => send(c.uid, b);
A['/read'] = (c, b) => markRead(c.uid, b.chat);
A['/edit'] = async (c, b) => {
  const m = await getMsg(c, b);
  if (!m || m.from !== c.uid || m.dead) return { err: 'cannot edit' };
  m.text = String(b.text || '').slice(0, 4000); m.edited = true;
  await bump(b.chat, m);
  return { ok: true, msg: m };
};
A['/delete'] = async (c, b) => {
  const m = await getMsg(c, b);
  if (!m) return { err: 'not found' };
  if (b.both) m.dead = true; else m.del = [...new Set([...(m.del || []), c.uid])];
  await bump(b.chat, m);
  return { ok: true };
};
A['/pin'] = async (c, b) => {
  const m = await getMsg(c, b);
  if (!m) return { err: 'not found' };
  const us = b.both ? parts(b.chat) : [c.uid];
  m.pin = b.un ? (m.pin || []).filter(x => !us.includes(x)) : [...new Set([...(m.pin || []), ...us])];
  await bump(b.chat, m);
  return { ok: true };
};
A['/react'] = async (c, b) => {
  const m = await getMsg(c, b);
  if (!m) return { err: 'not found' };
  m.react = m.react || {};
  if (m.react[c.uid] === b.emoji) delete m.react[c.uid]; else m.react[c.uid] = String(b.emoji).slice(0, 16);
  await bump(b.chat, m);
  return { ok: true, msg: m };
};
A['/chat/mute'] = async (c, b) => {
  if (!can(c.uid, b.chat)) return { err: 'forbidden' };
  const m = await getM(c.uid, b.chat); m.mute = +b.until || 0;
  await setM(c.uid, b.chat, m);
  return { ok: true };
};
A['/chat/clear'] = async (c, b) => {
  if (!can(c.uid, b.chat)) return { err: 'forbidden' };
  for (const u of b.both ? parts(b.chat) : [c.uid]) { const m = await getM(u, b.chat); m.clr = now(); await setM(u, b.chat, m); if (u !== c.uid) await touch(u, b.chat); }
  return { ok: true };
};
A['/chat/delete'] = async (c, b) => {
  if (!can(c.uid, b.chat)) return { err: 'forbidden' };
  for (const u of b.both ? parts(b.chat) : [c.uid]) {
    const m = await getM(u, b.chat); m.clr = now(); await setM(u, b.chat, m);
    if (b.chat[0] !== 's') await r.zrem('ul:' + u, b.chat);
    if (u !== c.uid) await touch(u, b.chat);
  }
  return { ok: true };
};
A['/search'] = async (c, b, q) => {
  const s = String(q.q || '').trim().toLowerCase();
  if (!s) return { msgs: [], users: [], chats: [] };
  const scan = async chat => {
    const meta = await getM(c.uid, chat);
    return Object.values(await allMsgs(chat)).filter(m => vis(m, c.uid, meta.clr) && (m.text || '').toLowerCase().includes(s)).sort((a, b) => b.id - a.id);
  };
  if (q.chat) return can(c.uid, q.chat) ? { msgs: (await scan(q.chat)).slice(0, 50) } : { err: 'forbidden' };
  const users = [];
  const uid2 = await r.get('uname:' + s.replace(/^@/, ''));
  if (uid2) users.push(await pub(await r.get('user:' + uid2), c.uid));
  const ids = (await r.zrange('ul:' + c.uid, 0, -1, { rev: true })).map(String).slice(0, 40);
  const chats = [];
  for (const chat of ids) { const f = await scan(chat); if (f.length) chats.push({ chat, n: f.length, snippet: f[0].text }); }
  return { users: users.filter(Boolean), chats };
};

A['/block'] = async (c, b) => { await (b.block ? r.sadd('bl:' + c.uid, String(b.peer)) : r.srem('bl:' + c.uid, String(b.peer))); return { ok: true }; };
A['/blocked'] = async c => {
  const ids = await r.smembers('bl:' + c.uid);
  return { users: (await Promise.all(ids.map(async i => pub(await r.get('user:' + i), c.uid)))).filter(Boolean) };
};
A['/contact'] = async (c, b) => {
  if (b.del) await r.hdel('ct:' + c.uid, String(b.peer));
  else await r.hset('ct:' + c.uid, { [String(b.peer)]: String(b.name || '').slice(0, 40) });
  return { ok: true };
};

const kind = b => (b.kind === 'pass' ? 'pass' : 'two');
A['/sec/set'] = async (c, b) => {
  const u = await r.get('user:' + c.uid), k = kind(b);
  if (u.sec && u.sec[k] && hs(b.current || '', c.uid) !== u.sec[k]) return { err: 'Current value is wrong' };
  if (String(b.value || '').length < 4) return { err: 'Minimum 4 characters' };
  u.sec = u.sec || {}; u.sec[k] = hs(b.value, c.uid);
  await r.set('user:' + c.uid, u);
  return { ok: true };
};
A['/sec/remove'] = async (c, b) => {
  const u = await r.get('user:' + c.uid), k = kind(b);
  if (!u.sec || !u.sec[k] || hs(b.value || '', c.uid) !== u.sec[k]) return { err: 'Wrong value' };
  delete u.sec[k]; await r.set('user:' + c.uid, u);
  return { ok: true };
};
A['/sec/verify'] = async (c, b) => {
  const u = await r.get('user:' + c.uid), k = kind(b);
  return { ok: !!(u.sec && u.sec[k] && hs(b.value || '', c.uid) === u.sec[k]) };
};
A['/devices'] = async c => {
  const out = [];
  for (const sid of await r.smembers('us:' + c.uid)) {
    const s = await r.get('sess:' + sid);
    if (s) out.push({ id: sid, ua: s.ua, ts: s.ts, current: sid === c.sid }); else await r.srem('us:' + c.uid, sid);
  }
  return { devices: out };
};
A['/devices/logout'] = async (c, b) => {
  if (!(await r.sismember('us:' + c.uid, b.id))) return { err: 'not found' };
  await r.del('sess:' + b.id); await r.srem('us:' + c.uid, b.id);
  return { ok: true };
};
A['/auth/logout'] = async c => { await r.del('sess:' + c.sid); await r.srem('us:' + c.uid, c.sid); return { ok: true }; };
A['/account/delete-start'] = async c => {
  const u = await r.get('user:' + c.uid);
  if (!(u.sec && (u.sec.two || u.sec.pass))) return { err: 'setup2fa' };
  const code = String(crypto.randomInt(100000, 999999));
  await r.set('otp:' + c.uid, { code: hs(code, c.uid), exp: now() + 600000 }, { ex: 600 });
  const sent = await mail(u.email, 'MS Chat account deletion code', 'Your code: ' + code + ' (valid 10 minutes). If this was not you, ignore this email.');
  if (!sent && process.env.OTP_DEBUG !== '1') return { err: 'Email service not configured (set RESEND_API_KEY)' };
  return { ok: true, need: { two: !!u.sec.two, pass: !!u.sec.pass }, debug: !sent ? code : undefined };
};
A['/account/delete-confirm'] = async (c, b) => {
  const u = await r.get('user:' + c.uid), o = await r.get('otp:' + c.uid);
  if (!o || o.exp < now() || hs(String(b.code || ''), c.uid) !== o.code) return { err: 'Wrong or expired email code' };
  if (u.sec.two && hs(b.two || '', c.uid) !== u.sec.two) return { err: 'Wrong two-step password' };
  if (u.sec.pass && hs(b.pass || '', c.uid) !== u.sec.pass) return { err: 'Wrong passcode' };
  for (const sid of await r.smembers('us:' + c.uid)) await r.del('sess:' + sid);
  await r.del('user:' + c.uid, 'uname:' + u.username.toLowerCase(), 'email:' + u.email, 'us:' + c.uid, 'fcm:' + c.uid, 'ct:' + c.uid, 'bl:' + c.uid, 'ul:' + c.uid, 'uf:' + c.uid, 'otp:' + c.uid);
  return { ok: true };
};

A['/push/register'] = async (c, b) => { if (b.fcmToken) await r.sadd('fcm:' + c.uid, b.fcmToken); return { ok: true }; };
A['/push/unregister'] = async (c, b) => { if (b.fcmToken) await r.srem('fcm:' + c.uid, b.fcmToken); return { ok: true }; };
A['/notif/action'] = async (c, b) => {
  if (b.action === 'reply' && b.text) return send(c.uid, { chat: b.chat, text: b.text });
  if (b.action === 'read') return markRead(c.uid, b.chat);
  if (b.action === 'mute' && can(c.uid, b.chat)) { const m = await getM(c.uid, b.chat); m.mute = +b.until || now() + 3600000; await setM(c.uid, b.chat, m); return { ok: true }; }
  return { err: 'bad action' };
};

/* Uploads go browser -> Vercel Blob directly (up to 70 MB) */
async function upload(req, res, body) {
  const { handleUpload } = require('@vercel/blob/client');
  try {
    const j = await handleUpload({
      body, request: req,
      onBeforeGenerateToken: async (pathname, payload) => {
        if (!payload || !(await r.get('sess:' + payload))) throw new Error('unauthorized');
        return { maximumSizeInBytes: 70 * 1048576, addRandomSuffix: true };
      },
      onUploadCompleted: async () => {}
    });
    return res.status(200).json(j);
  } catch (e) { return res.status(400).json({ error: e.message }); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const p = req.url.split('?')[0].replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const q = req.query || {};
  const b = (req.body && typeof req.body === 'object' && req.body) || {};
  try {
    if (p === '/health') return res.json({ ok: true, db: !!(await r.ping().catch(() => 0)) });
    if (p === '/upload') return upload(req, res, b);
    if (open[p]) return res.json(await open[p](req, b));
    const c = await auth(req);
    if (!c) return res.status(401).json({ err: 'unauthorized' });
    if (!A[p]) return res.status(404).json({ err: 'not found' });
    return res.json(await A[p](c, b, q, req));
  } catch (e) {
    console.error(p, e);
    return res.status(500).json({ err: 'Server error' });
  }
};
