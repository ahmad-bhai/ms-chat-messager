'use strict';
const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_TOKEN;
const SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update('ms-chat|' + (REDIS_TOKEN || 'dev')).digest('hex');
const ONLINE_MS = 35000;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const E = (c, m) => new HttpError(c, m);

async function pipe(cmds) {
  if (!REDIS_URL || !REDIS_TOKEN) throw E(500, 'Database not configured.');
  if (!cmds.length) return [];
  const r = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map(c => c.map(x => String(x))))
  });
  let data;
  try { data = await r.json(); } catch (e) { throw new Error('Bad Redis response'); }
  if (!r.ok || !Array.isArray(data)) throw new Error('Redis error');
  return data.map(x => { if (x.error) throw new Error('Redis: ' + x.error); return x.result; });
}
const cmd = async (...c) => (await pipe([c]))[0];
const pj = s => { if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } };
const mget = async keys => keys.length ? (await cmd('MGET', ...keys)).map(pj) : [];

const uid = () => crypto.randomBytes(8).toString('hex');
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_RE = /^[a-z0-9_]{3,20}$/i;
const ID_RE = /^[a-f0-9]{1,32}$/;
const validPhoto = p => {
  if (!p) return true;
  if (typeof p !== 'string') return false;
  if (p.startsWith('data:image/')) return p.length < 80000;
  return /^https?:\/\//i.test(p) && p.length < 500;
};
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => e ? no(e) : ok(k.toString('hex'))));
async function hashSecret(s) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: await scrypt(String(s), salt) }; }
async function checkSecret(s, rec) {
  if (!rec) return false;
  const h = Buffer.from(await scrypt(String(s || ''), rec.salt), 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return h.length === b.length && crypto.timingSafeEqual(h, b);
}

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + 60 * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(t) {
  if (!t || typeof t !== 'string') return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  const a = Buffer.from(s), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.e > Date.now() ? d.u : null; } catch (e) { return null; }
}
function authId(req) {
  const h = req.headers.authorization || '';
  const id = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!id) throw E(401, 'Not signed in');
  return id;
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function body(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) req = { body: req.body.toString() };
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { if (!req.body.trim()) return {}; try { return JSON.parse(req.body); } catch (e) { throw E(400, 'Bad JSON'); } }
  }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 2000000) throw E(413, 'Payload too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { throw E(400, 'Bad JSON'); }
}
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';

const selfUser = u => ({ id: u.id, email: u.email, firstName: u.firstName, username: u.username, bio: u.bio || '', profilePhoto: u.profilePhoto || '', twoStepEnabled: !!u.twoStepEnabled });
const pubUser = (u, seen) => u ? ({
  id: u.id, firstName: u.firstName, username: u.username, bio: u.bio || '', profilePhoto: u.profilePhoto || '',
  online: !!seen && Date.now() - seen < ONLINE_MS, lastSeen: seen || 0
}) : { id: '', firstName: 'Deleted', username: '', bio: '', profilePhoto: '', online: false, lastSeen: 0 };
const msgView = (m, reply) => ({ id: m.id, chatId: m.chatId, senderId: m.senderId, text: m.text, time: m.time, edited: !!m.edited, read: (m.readBy||[]).length > 0, replyTo: reply || null, type: m.type || 'text', mediaUrl: m.mediaUrl || '', fileName: m.fileName || '', reactions: m.reactions || {}, pinned: !!m.pinned });
const replyView = r => r ? { id: r.id, senderId: r.senderId, text: r.text.slice(0, 120) } : null;

async function getChat(id, me) {
  id = String(id || '');
  if (!ID_RE.test(id)) throw E(404, 'Chat not found');
  const c = pj(await cmd('GET', 'chat:' + id));
  if (!c || !c.members.includes(me)) throw E(404, 'Chat not found');
  return c;
}
async function loadUser(id) { const u = pj(await cmd('GET', 'u:' + id)); if (!u) throw E(401, 'Not signed in'); return u; }

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  if (p === '' || p === 'index') p = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
  const m = req.method;
  let mt;

  if (m === 'GET' && p === 'health') return send(res, 200, { ok: true, db: !!(REDIS_URL && REDIS_TOKEN) });

  if (m === 'POST' && p === 'auth/check-email') {
    const b = await body(req);
    const email = clean(b.email, 120).toLowerCase();
    if (!EMAIL_RE.test(email)) throw E(400, 'Enter a valid email');
    return send(res, 200, { success: true, exists: !!(await cmd('GET', 'e:' + email)) });
  }

  if (m === 'POST' && p === 'auth/register') {
    const b = await body(req);
    const email = clean(b.email, 120).toLowerCase();
    const password = String(b.password || '');
    const firstName = clean(b.firstName, 40);
    const username = clean(b.username, 21).replace(/^@/, '');
    if (!EMAIL_RE.test(email)) throw E(400, 'Enter a valid email');
    if (password.length < 6) throw E(400, 'Password must be at least 6 characters');
    if (!firstName) throw E(400, 'First name is required');
    if (!USER_RE.test(username)) throw E(400, 'Username: 3-20 letters, numbers or underscore');
    const id = uid();
    if (!(await cmd('SET', 'e:' + email, id, 'NX'))) throw E(409, 'Email already registered');
    if (!(await cmd('SET', 'n:' + username.toLowerCase(), id, 'NX'))) { await cmd('DEL', 'e:' + email); throw E(409, 'Username is taken'); }
    const user = { id, email, firstName, username, bio: '', profilePhoto: '', pass: await hashSecret(password), twoStepEnabled: false, pin: null, createdAt: Date.now() };
    await pipe([
      ['SET', 'u:' + id, JSON.stringify(user)], ['SET', 'seen:' + id, Date.now()],
      ['ZADD', 'idx', 0, username.toLowerCase() + '|' + id], ['ZADD', 'idx', 0, firstName.toLowerCase() + '|' + id]
    ]);
    return send(res, 200, { success: true, token: signToken(id), user: selfUser(user) });
  }

  if (m === 'POST' && p === 'auth/login') {
    const b = await body(req);
    const email = clean(b.email, 120).toLowerCase();
    const rl = 'rl:' + clientIp(req) + '|' + email;
    if (+(await cmd('GET', rl)) >= 10) throw E(429, 'Too many attempts.');
    const bad = async msg => { await pipe([['INCR', rl], ['EXPIRE', rl, 600]]); throw E(401, msg); };
    const id = await cmd('GET', 'e:' + email);
    const user = id ? pj(await cmd('GET', 'u:' + id)) : null;
    if (!user || !(await checkSecret(b.password, user.pass))) return bad('Wrong email or password');
    if (user.twoStepEnabled) {
      if (!b.twoStepPin) return send(res, 200, { success: false, requiresTwoStep: true });
      if (!(await checkSecret(b.twoStepPin, user.pin))) return bad('Wrong two-step PIN');
    }
    await cmd('DEL', rl);
    return send(res, 200, { success: true, token: signToken(user.id), user: selfUser(user) });
  }

  const me = authId(req);

  if (m === 'GET' && p === 'sync') {
    const chat = url.searchParams.get('chat') || '', peer = url.searchParams.get('peer') || '';
    const cmds = [['GET', 'ver:' + me]];
    const wantTyping = ID_RE.test(chat) && ID_RE.test(peer);
    if (wantTyping) cmds.push(['GET', 'typing:' + chat + ':' + peer]);
    if (url.searchParams.get('hb')) cmds.push(['SET', 'seen:' + me, Date.now()]);
    const r = await pipe(cmds);
    return send(res, 200, { success: true, ver: +r[0] || 0, typing: wantTyping && !!r[1] });
  }

  if (m === 'GET' && p === 'me') return send(res, 200, { success: true, user: selfUser(await loadUser(me)) });
  if (m === 'POST' && p === 'auth/logout') return send(res, 200, { success: true });

  if (m === 'POST' && p === 'user/update') {
    const b = await body(req);
    const user = await loadUser(me);
    const firstName = clean(b.firstName, 40);
    const username = clean(b.username, 21).replace(/^@/, '');
    if (!firstName) throw E(400, 'First name is required');
    if (!USER_RE.test(username)) throw E(400, 'Username: 3-20 letters, numbers or underscore');
    if (!validPhoto(b.profilePhoto)) throw E(400, 'Invalid profile photo');
    let pin = user.pin, twoStep = false;
    if (b.twoStepEnabled) {
      const raw = String(b.twoStepPassword || '');
      if (raw) { if (raw.length < 4) throw E(400, 'PIN must be at least 4 characters'); pin = await hashSecret(raw); }
      else if (!user.pin) throw E(400, 'Set a PIN to enable two-step verification');
      twoStep = true;
    } else pin = null;
    const oldName = user.username.toLowerCase(), newName = username.toLowerCase();
    if (oldName !== newName) {
      if (!(await cmd('SET', 'n:' + newName, me, 'NX'))) throw E(409, 'Username is taken');
    }
    const oldFirst = user.firstName.toLowerCase();
    Object.assign(user, { firstName, username, bio: clean(b.bio, 120), profilePhoto: b.profilePhoto || '', twoStepEnabled: twoStep, pin });
    const cmds = [
      ['SET', 'u:' + me, JSON.stringify(user)],
      ['ZREM', 'idx', oldName + '|' + me, oldFirst + '|' + me],
      ['ZADD', 'idx', 0, newName + '|' + me], ['ZADD', 'idx', 0, firstName.toLowerCase() + '|' + me]
    ];
    if (oldName !== newName) cmds.push(['DEL', 'n:' + oldName]);
    await pipe(cmds);
    return send(res, 200, { success: true, user: selfUser(user) });
  }

  if (m === 'GET' && p === 'users/search') {
    const q = clean(url.searchParams.get('q'), 40).replace(/^@/, '').toLowerCase();
    if (!q) return send(res, 200, []);
    const members = await cmd('ZRANGEBYLEX', 'idx', '[' + q, '[' + q + 'ÿ', 'LIMIT', '0', '40');
    const ids = [...new Set(members.map(s => s.slice(s.lastIndexOf('|') + 1)))].filter(i => i !== me).slice(0, 20);
    if (!ids.length) return send(res, 200, []);
    const r = await pipe([...ids.map(i => ['GET', 'u:' + i]), ...ids.map(i => ['GET', 'seen:' + i])]);
    return send(res, 200, ids.map((_, i) => pj(r[i]) && pubUser(pj(r[i]), +r[ids.length + i] || 0)).filter(Boolean));
  }

  if (m === 'GET' && p === 'chats') {
    const ids = await cmd('SMEMBERS', 'uchats:' + me);
    if (!ids.length) return send(res, 200, []);
    const r = await pipe(ids.flatMap(id => [['GET', 'chat:' + id], ['GET', 'last:' + id], ['GET', 'unread:' + me + ':' + id]]));
    const items = ids.map((_, i) => ({ chat: pj(r[i * 3]), last: pj(r[i * 3 + 1]), unread: Math.max(0, +r[i * 3 + 2] || 0) }))
      .filter(x => x.chat && (x.last || x.chat.createdBy === me));
    const others = items.map(x => x.chat.members.find(i => i !== me) || me);
    const r2 = items.length ? await pipe([...others.map(o => ['GET', 'u:' + o]), ...others.map(o => ['GET', 'seen:' + o])]) : [];
    const out = items.map((x, i) => ({
      id: x.chat.id, user: pubUser(pj(r2[i]), +r2[items.length + i] || 0),
      last: x.last ? { id: x.last.id, chatId: x.chat.id, senderId: x.last.senderId, text: x.last.text, time: x.last.time } : null,
      unread: x.unread, updated: x.last ? x.last.time : x.chat.createdAt
    })).sort((a, b) => b.updated - a.updated);
    return send(res, 200, out);
  }

  if (m === 'POST' && p === 'chats/create') {
    const b = await body(req);
    const tid = String(b.targetUserId || '');
    const target = ID_RE.test(tid) ? pj(await cmd('GET', 'u:' + tid)) : null;
    if (!target) throw E(400, 'Invalid user');
    if (target.id === me) {
      // Saved messages chat with self
      const pk = 'self:' + me;
      let chat = null;
      const existing = await cmd('GET', pk);
      if (existing) chat = pj(await cmd('GET', 'chat:' + existing));
      if (!chat) {
        chat = { id: uid(), members: [me], createdBy: me, createdAt: Date.now(), self: true };
        await cmd('SET', 'chat:' + chat.id, JSON.stringify(chat));
        await cmd('SET', pk, chat.id);
      }
      await cmd('SADD', 'uchats:' + me, chat.id);
      return send(res, 200, { success: true, chat: { id: chat.id, user: { ...selfUser(target), online: true, lastSeen: Date.now() }, last: null, unread: 0, updated: chat.createdAt } });
    }
    const pk = 'pair:' + [me, target.id].sort().join(':');
    let chat = null;
    const existing = await cmd('GET', pk);
    if (existing) chat = pj(await cmd('GET', 'chat:' + existing));
    if (!chat) {
      chat = { id: uid(), members: [me, target.id], createdBy: me, createdAt: Date.now() };
      await cmd('SET', 'chat:' + chat.id, JSON.stringify(chat));
      if (!(await cmd('SET', pk, chat.id, 'NX'))) chat = pj(await cmd('GET', 'chat:' + (await cmd('GET', pk))));
    }
    const r = await pipe([['SADD', 'uchats:' + me, chat.id], ['GET', 'last:' + chat.id], ['GET', 'seen:' + target.id]]);
    const last = pj(r[1]);
    return send(res, 200, { success: true, chat: {
      id: chat.id, user: pubUser(target, +r[2] || 0), last: last ? { ...last, chatId: chat.id } : null, unread: 0, updated: last ? last.time : chat.createdAt
    } });
  }

  if ((mt = p.match(/^chats\/clear\/([a-f0-9]+)$/)) && m === 'DELETE') {
    const chat = await getChat(mt[1], me);
    const other = chat.members.find(i => i !== me) || me;
    const ids = await cmd('ZRANGE', 'cm:' + chat.id, 0, -1);
    await pipe([
      ...(ids.length ? [['DEL', ...ids.map(i => 'm:' + i)]] : []),
      ['DEL', 'cm:' + chat.id, 'last:' + chat.id, 'unread:' + me + ':' + chat.id, 'unread:' + other + ':' + chat.id],
      ['INCR', 'ver:' + other]
    ]);
    return send(res, 200, { success: true });
  }

  if ((mt = p.match(/^chats\/([a-f0-9]+)\/read$/)) && m === 'POST') {
    const chat = await getChat(mt[1], me);
    const other = chat.members.find(i => i !== me) || me;
    const ids = await cmd('ZRANGE', 'cm:' + chat.id, -200, -1);
    const ms = (await mget(ids.map(i => 'm:' + i))).filter(Boolean);
    const upd = ms.filter(x => x.senderId !== me && !(x.readBy||[]).includes(me));
    const cmds = upd.map(x => { x.readBy = x.readBy || []; x.readBy.push(me); return ['SET', 'm:' + x.id, JSON.stringify(x)]; });
    cmds.push(['DEL', 'unread:' + me + ':' + chat.id]);
    if (upd.length) cmds.push(['INCR', 'ver:' + other]);
    await pipe(cmds);
    return send(res, 200, { success: true });
  }

  if (m === 'POST' && p === 'typing') {
    const b = await body(req);
    const chat = await getChat(b.chatId, me);
    await cmd('SET', 'typing:' + chat.id + ':' + me, 1, 'EX', 5);
    return send(res, 200, { success: true });
  }

  if ((mt = p.match(/^messages\/([a-f0-9]+)$/)) && m === 'GET') {
    const chat = await getChat(mt[1], me);
    const ids = await cmd('ZRANGE', 'cm:' + chat.id, -300, -1);
    const ms = (await mget(ids.map(i => 'm:' + i))).filter(Boolean);
    const byId = new Map(ms.map(x => [x.id, x]));
    const need = [...new Set(ms.map(x => x.replyTo).filter(r => r && !byId.has(r)))];
    (await mget(need.map(i => 'm:' + i))).filter(Boolean).forEach(x => byId.set(x.id, x));
    return send(res, 200, ms.map(x => msgView(x, x.replyTo ? (byId.has(x.replyTo) ? replyView(byId.get(x.replyTo)) : { id: x.replyTo, deleted: true }) : null)));
  }

  if (m === 'POST' && p === 'messages') {
    const b = await body(req);
    const chat = await getChat(b.chatId, me);
    const text = String(b.text == null ? '' : b.text).trim().slice(0, 4000);
    const type = ['text','image','video','audio','file'].includes(b.type) ? b.type : 'text';
    const mediaUrl = typeof b.mediaUrl === 'string' && b.mediaUrl.length < 800000 ? b.mediaUrl : '';
    if (!text && !mediaUrl) throw E(400, 'Empty message');
    let replyTo = null, replyMsg = null;
    if (b.replyTo && ID_RE.test(String(b.replyTo))) {
      const r = pj(await cmd('GET', 'm:' + b.replyTo));
      if (r && r.chatId === chat.id) { replyTo = r.id; replyMsg = r; }
    }
    const other = chat.members.find(i => i !== me) || me;
    const msg = { id: uid(), chatId: chat.id, senderId: me, text, time: Date.now(), edited: false, replyTo, readBy: [], type, mediaUrl, fileName: clean(b.fileName, 100), reactions: {}, pinned: false };
    const lastText = type === 'text' ? text.slice(0, 200) : (type === 'image' ? '📷 Photo' : type === 'video' ? '🎬 Video' : type === 'audio' ? '🎤 Audio' : '📎 File');
    const last = { id: msg.id, chatId: chat.id, senderId: me, text: lastText, time: msg.time };
    const cmds = [
      ['SET', 'm:' + msg.id, JSON.stringify(msg)], ['ZADD', 'cm:' + chat.id, msg.time, msg.id],
      ['SET', 'last:' + chat.id, JSON.stringify(last)],
      ['SADD', 'uchats:' + me, chat.id],
      ['DEL', 'typing:' + chat.id + ':' + me]
    ];
    if (other !== me) {
      cmds.push(['INCR', 'unread:' + other + ':' + chat.id]);
      cmds.push(['SADD', 'uchats:' + other, chat.id]);
      cmds.push(['INCR', 'ver:' + other]);
    }
    await pipe(cmds);
    return send(res, 200, { success: true, message: msgView(msg, replyView(replyMsg)) });
  }

  if ((mt = p.match(/^messages\/([a-f0-9]+)$/)) && (m === 'PUT' || m === 'DELETE')) {
    const msg = pj(await cmd('GET', 'm:' + mt[1]));
    if (!msg) throw E(404, 'Message not found');
    const chat = await getChat(msg.chatId, me);
    const other = chat.members.find(i => i !== me) || me;
    // For delete, allow anyone in chat (both directions) - per user request
    if (m === 'DELETE' && msg.senderId !== me && !chat.members.includes(me)) throw E(403, 'Not allowed');
    if (m === 'PUT' && msg.senderId !== me) throw E(403, 'Not allowed');
    if (m === 'PUT') {
      const b = await body(req);
      const text = String(b.text == null ? '' : b.text).trim().slice(0, 4000);
      if (!text) throw E(400, 'Empty message');
      msg.text = text; msg.edited = true;
      const cmds = [['SET', 'm:' + msg.id, JSON.stringify(msg)]];
      if (other !== me) cmds.push(['INCR', 'ver:' + other]);
      const last = pj(await cmd('GET', 'last:' + chat.id));
      if (last && last.id === msg.id) cmds.push(['SET', 'last:' + chat.id, JSON.stringify({ ...last, text: text.slice(0, 200) })]);
      await pipe(cmds);
      const rm = msg.replyTo ? pj(await cmd('GET', 'm:' + msg.replyTo)) : null;
      return send(res, 200, { success: true, message: msgView(msg, msg.replyTo ? (rm ? replyView(rm) : { id: msg.replyTo, deleted: true }) : null) });
    }
    const cmds = [['ZREM', 'cm:' + chat.id, msg.id], ['DEL', 'm:' + msg.id]];
    if (!(msg.readBy||[]).length && other !== me) {
      const key = 'unread:' + other + ':' + chat.id;
      if (+(await cmd('GET', key)) > 0) cmds.push(['DECR', key]);
    }
    await pipe(cmds);
    const lastIds = await cmd('ZRANGE', 'cm:' + chat.id, -1, -1);
    const lm = lastIds.length ? pj(await cmd('GET', 'm:' + lastIds[0])) : null;
    const cmds2 = [
      lm ? ['SET', 'last:' + chat.id, JSON.stringify({ id: lm.id, chatId: chat.id, senderId: lm.senderId, text: (lm.text||'').slice(0,200), time: lm.time })] : ['DEL', 'last:' + chat.id]
    ];
    if (other !== me) cmds2.push(['INCR', 'ver:' + other]);
    await pipe(cmds2);
    return send(res, 200, { success: true });
  }

  // Pin/unpin
  if ((mt = p.match(/^messages\/([a-f0-9]+)\/pin$/)) && m === 'POST') {
    const b = await body(req);
    const msg = pj(await cmd('GET', 'm:' + mt[1]));
    if (!msg) throw E(404, 'Message not found');
    const chat = await getChat(msg.chatId, me);
    msg.pinned = !!b.pinned;
    await cmd('SET', 'm:' + msg.id, JSON.stringify(msg));
    return send(res, 200, { success: true, pinned: msg.pinned });
  }

  // Reactions
  if ((mt = p.match(/^messages\/([a-f0-9]+)\/react$/)) && m === 'POST') {
    const b = await body(req);
    const msg = pj(await cmd('GET', 'm:' + mt[1]));
    if (!msg) throw E(404, 'Message not found');
    const chat = await getChat(msg.chatId, me);
    const emoji = String(b.emoji || '').slice(0, 8);
    if (!emoji) throw E(400, 'No emoji');
    msg.reactions = msg.reactions || {};
    const arr = msg.reactions[emoji] = msg.reactions[emoji] || [];
    const i = arr.indexOf(me);
    if (i > -1) arr.splice(i, 1); else arr.push(me);
    if (!arr.length) delete msg.reactions[emoji];
    await cmd('SET', 'm:' + msg.id, JSON.stringify(msg));
    const other = chat.members.find(i => i !== me) || me;
    if (other !== me) await cmd('INCR', 'ver:' + other);
    return send(res, 200, { success: true, reactions: msg.reactions });
  }

  throw E(404, 'Not found');
}

module.exports = async function handler(req, res) {
  try { await route(req, res); }
  catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { success: false, message: e.message });
    console.error(e);
    send(res, 500, { success: false, message: 'Server error' });
  }
};
