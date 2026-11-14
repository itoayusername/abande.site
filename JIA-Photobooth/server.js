// Giga Click Photobooth server: kiosk + admin + PayMongo QR Ph, fully online.
// Run: ADMIN_PASSWORD=... PUBLIC_URL=https://yourdomain npm start
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const PHOTOS = path.join(DATA, 'photos');
const MEDIA = path.join(DATA, 'media');
[DATA, PHOTOS, MEDIA].forEach(d => fs.mkdirSync(d, { recursive: true }));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('Set ADMIN_PASSWORD (8+ characters) before starting.');
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PROD = process.env.NODE_ENV === 'production';

// ---------- tiny JSON store ----------
const file = n => path.join(DATA, n);
const load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const save = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v, null, 2));

const DEFAULTS = {
  name: 'Giga Click', tagline: 'Step in. Smile. Take it home.', details: 'Printed strip + digital copy',
  footer: 'Thank you!', logo: '', background: '', bgColor: '#0b0f19', accent: '#fbbf24',
  price: 100, shots: 3, countdown: 3, autoPrint: true, banner: '', bannerActive: false,
  maintenance: false, freePlay: false, retentionDays: 30
};
let config = { ...DEFAULTS, ...load('config.json', {}) };
let txs = load('transactions.json', []);
let secrets = load('secrets.json', {});
const paymongoKey = () => process.env.PAYMONGO_SECRET_KEY || secrets.paymongo || '';

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(self), microphone=()'); next(); });

// ---------- admin auth (signed httpOnly cookie) ----------
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
function adminOk(req) {
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return Number(exp) > Date.now() && sig && safeEq(sign(exp), sig);
}
const requireAdmin = (req, res, next) => adminOk(req) ? next() : res.status(401).json({ error: 'Login required' });

const json = express.json({ limit: '100kb' });
const bigJson = express.json({ limit: '12mb' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120 });
app.use('/api', apiLimiter);

app.post('/api/admin/login', loginLimiter, json, (req, res) => {
  if (!safeEq(String(req.body.password || ''), ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  const exp = String(Date.now() + 12 * 3600 * 1000);
  res.setHeader('Set-Cookie', `adm=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.setHeader('Set-Cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: adminOk(req) }));

// ---------- config ----------
const publicConfig = () => ({ ...config, paymentReady: !!paymongoKey() });
app.get('/api/config', (req, res) => res.json(publicConfig()));

const SCHEMA = {
  name: ['s', 40], tagline: ['s', 90], details: ['s', 120], footer: ['s', 60], banner: ['s', 160],
  logo: ['u'], background: ['u'], bgColor: ['c'], accent: ['c'],
  price: ['n', 0, 100000], shots: ['n', 1, 6], countdown: ['n', 1, 10], retentionDays: ['n', 1, 365],
  autoPrint: ['b'], bannerActive: ['b'], maintenance: ['b'], freePlay: ['b']
};
function clean(body) {
  const out = {};
  for (const [k, [t, a, b]] of Object.entries(SCHEMA)) {
    const v = body[k]; if (v === undefined) continue;
    if (t === 's') out[k] = String(v).slice(0, a);
    else if (t === 'c' && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v;
    else if (t === 'u' && (v === '' || /^\/media\/[\w.-]+$/.test(v))) out[k] = v;
    else if (t === 'n' && Number.isFinite(+v)) out[k] = Math.min(b, Math.max(a, +v));
    else if (t === 'b') out[k] = !!v;
  }
  return out;
}
app.put('/api/admin/config', requireAdmin, json, (req, res) => {
  config = { ...config, ...clean(req.body) };
  save('config.json', config);
  io.emit('config', publicConfig());
  res.json(publicConfig());
});
app.put('/api/admin/paymongo', requireAdmin, json, (req, res) => {
  const k = String(req.body.secretKey || '').trim();
  if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(k)) return res.status(400).json({ error: 'Key must start with sk_test_ or sk_live_' });
  secrets.paymongo = k; save('secrets.json', secrets);
  fs.chmodSync(file('secrets.json'), 0o600);
  io.emit('config', publicConfig());
  res.json({ ok: true });
});
app.post('/api/admin/refresh', requireAdmin, (req, res) => { io.emit('refresh'); res.json({ ok: true }); });

// ---------- logo / background upload ----------
app.post('/api/admin/upload', requireAdmin, bigJson, (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body.image || '');
  if (!m) return res.status(400).json({ error: 'PNG, JPG or WEBP only' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8e6) return res.status(413).json({ error: 'Max 8 MB' });
  const name = crypto.randomBytes(8).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(MEDIA, name), buf);
  res.json({ url: '/media/' + name });
});
app.use('/media', express.static(MEDIA, { maxAge: '7d', index: false, dotfiles: 'deny' }));

// ---------- payments ----------
const sessions = new Map(); // token -> { exp, used }
const newToken = () => { const t = crypto.randomBytes(18).toString('hex'); sessions.set(t, { exp: Date.now() + 15 * 60 * 1000, used: false }); return t; };
const pm = async (p, method = 'GET', body) => {
  const r = await fetch('https://api.paymongo.com/v1' + p, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(paymongoKey() + ':').toString('base64') },
    body: body ? JSON.stringify({ data: { attributes: body } }) : undefined
  });
  const j = await r.json();
  if (!j.data) throw new Error(j.errors?.[0]?.detail || 'PayMongo error');
  return j.data;
};

app.post('/api/pay/create', async (req, res) => {
  if (config.maintenance) return res.status(503).json({ error: 'Booth under maintenance' });
  if (!paymongoKey()) return res.status(400).json({ error: 'Payments are not set up' });
  try {
    const amount = Math.round(config.price * 100);
    const intent = await pm('/payment_intents', 'POST', { amount, payment_method_allowed: ['qrph'], currency: 'PHP', capture_type: 'automatic' });
    const method = await pm('/payment_methods', 'POST', { type: 'qrph' });
    const att = await pm(`/payment_intents/${intent.id}/attach`, 'POST', { payment_method: method.id, client_key: intent.attributes.client_key });
    const na = att.attributes.next_action;
    const qr = na?.code?.image_url || '';
    if (!qr) throw new Error('No QR returned');
    txs.push({ id: intent.id, time: Date.now(), amount: config.price, status: 'pending' }); save('transactions.json', txs);
    res.json({ intentId: intent.id, qr, amount: config.price });
  } catch (e) { console.error('[pay]', e.message); res.status(502).json({ error: 'Could not create payment. Try again.' }); }
});

app.get('/api/pay/status/:id', async (req, res) => {
  const tx = txs.find(t => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Unknown payment' });
  if (tx.status === 'paid') return res.json({ paid: true, token: tx.token && sessions.get(tx.token)?.used === false ? tx.token : null });
  try {
    const d = await pm('/payment_intents/' + tx.id);
    if (d.attributes.status === 'succeeded') {
      tx.status = 'paid'; tx.token = newToken(); tx.paidAt = Date.now(); save('transactions.json', txs);
      io.emit('sale', { amount: tx.amount });
      return res.json({ paid: true, token: tx.token });
    }
    res.json({ paid: false });
  } catch { res.json({ paid: false }); }
});

app.post('/api/free', (req, res) => {
  if (!config.freePlay || config.maintenance) return res.status(403).json({ error: 'Free play is off' });
  res.json({ token: newToken() });
});

// ---------- photos ----------
app.post('/api/photo', bigJson, (req, res) => {
  const s = sessions.get(req.body.token);
  if (!s || s.used || s.exp < Date.now()) return res.status(403).json({ error: 'Session expired' });
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(req.body.image || '');
  const buf = m && Buffer.from(m[1], 'base64');
  if (!buf || buf.length > 9e6 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Invalid image' });
  s.used = true;
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(PHOTOS, id + '.jpg'), buf);
  const tx = txs.find(t => t.token === req.body.token); if (tx) { tx.photo = id; save('transactions.json', txs); }
  res.json({ id, url: `${process.env.PUBLIC_URL || ''}/p/${id}` });
});
app.get('/photo/:id.jpg', (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.sendStatus(404);
  res.sendFile(path.join(PHOTOS, req.params.id + '.jpg'), e => e && res.sendStatus(404));
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/p/:id', (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id) || !fs.existsSync(path.join(PHOTOS, req.params.id + '.jpg'))) return res.status(404).send('This photo has expired or does not exist.');
  res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(config.name)} photo</title>
<body style="margin:0;background:${esc(config.bgColor)};color:#fff;font-family:system-ui;text-align:center;padding:24px">
<h2 style="color:${esc(config.accent)}">${esc(config.name)}</h2>
<img src="/photo/${req.params.id}.jpg" style="max-width:100%;max-height:75vh;border-radius:8px;box-shadow:0 10px 40px #0008">
<p><a download="photo.jpg" href="/photo/${req.params.id}.jpg" style="display:inline-block;background:${esc(config.accent)};color:#111;padding:14px 28px;border-radius:999px;font-weight:700;text-decoration:none">Download photo</a></p>
<p style="opacity:.6;font-size:13px">Available for ${config.retentionDays} days.</p>`);
});

// ---------- admin stats ----------
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const paid = txs.filter(t => t.status === 'paid');
  res.json({ sessions: paid.length, income: paid.reduce((a, t) => a + t.amount, 0), recent: paid.slice(-50).reverse().map(t => ({ id: t.id, time: t.paidAt || t.time, amount: t.amount, photo: t.photo || null })), paymentReady: !!paymongoKey() });
});
app.delete('/api/admin/tx/:id', requireAdmin, (req, res) => { txs = txs.filter(t => t.id !== req.params.id); save('transactions.json', txs); res.json({ ok: true }); });

// ---------- cleanup ----------
setInterval(() => {
  const cutoff = Date.now() - config.retentionDays * 864e5;
  for (const f of fs.readdirSync(PHOTOS)) { const p = path.join(PHOTOS, f); if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); }
  for (const [t, s] of sessions) if (s.exp < Date.now()) sessions.delete(t);
}, 3600 * 1000);

// ---------- pages ----------
const pub = path.join(__dirname, 'public');
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use(express.static(pub, { index: 'kiosk.html', dotfiles: 'deny' }));
io.on('connection', s => s.emit('config', publicConfig()));
server.listen(PORT, () => console.log(`Photobooth running on :${PORT}`));
