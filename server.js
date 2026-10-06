/**
 * Uncodemy — FREE Playwright recorded course · BACKEND (API only)
 * Saves enrollments to MongoDB and serves them to admin.html.
 * index.html + thankyou.html are hosted on the website; admin.html is served here at /admin.
 *
 * Run:  npm install  →  copy .env.example to .env and fill it  →  npm start
 */
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const {
  MONGODB_URI,
  MONGODB_DB = 'uncodemy',
  ADMIN_KEY,
  PORT = 3000,
  ALLOWED_ORIGINS = '',
} = process.env;

if (!MONGODB_URI) { console.error('✗ MONGODB_URI missing in .env'); process.exit(1); }
if (!ADMIN_KEY || ADMIN_KEY.length < 12) { console.error('✗ ADMIN_KEY missing or shorter than 12 characters in .env'); process.exit(1); }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

/* CORS — the pages live on a different domain, so allow only those domains */
const origins = ALLOWED_ORIGINS.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
if (!origins.length) console.warn('⚠ ALLOWED_ORIGINS is empty — allowing every domain. Set it to your website domain in production.');
app.use('/api', cors({
  origin: origins.length ? origins : true,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key'],
  maxAge: 86400,
}));

/* ---------- MongoDB ---------- */
let leads;
async function connectDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  leads = client.db(MONGODB_DB).collection('leads');
  await leads.createIndex({ email: 1, course: 1 }, { unique: true });
  await leads.createIndex({ createdAt: -1 });
  console.log('✓ MongoDB connected →', MONGODB_DB + '.leads');
}

/* ---------- tiny in-memory rate limit (per IP) ---------- */
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now(), key = req.ip + req.path;
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ ok: false, error: 'Too many requests, try again later.' });
    arr.push(now); hits.set(key, arr); next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

/* ---------- helpers ---------- */
const clean = (v, max = 120) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[6-9]\d{9}$/;

function requireAdmin(req, res, next) {
  const given = Buffer.from(String(req.get('x-admin-key') || ''));
  const real = Buffer.from(ADMIN_KEY);
  if (given.length === real.length && crypto.timingSafeEqual(given, real)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

/* ---------- save one enrollment (used by both routes below) ---------- */
async function saveLead(b, req) {
  // Never drop a lead silently. Very fast submissions are only flagged as "suspect" for review in admin.
  const elapsed = Number(b.elapsed);
  const suspect = Number.isFinite(elapsed) && elapsed > 0 && elapsed < 1500;

  const name = clean(b.name, 80);
  const phone = clean(b.phone, 10).replace(/\D/g, '');
  const email = clean(b.email, 120).toLowerCase();
  const course = clean(b.course, 80) || 'playwright';

  if (name.length < 2) return { ok: false, error: 'Please enter your full name.' };
  if (!PHONE_RE.test(phone)) return { ok: false, error: 'Please enter a valid 10-digit mobile number.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Please enter a valid email address.' };

  const now = new Date();
  const r = await leads.updateOne(
    { email, course },
    {
      $set: {
        name, phone, lastSeenAt: now,
        page: clean(b.page, 200),
        userAgent: clean(req.get('user-agent'), 200),
        ip: req.ip,
        suspect,
      },
      $setOnInsert: {
        createdAt: now, status: 'new',
        // first-touch attribution: where the lead originally came from
        utm: { source: clean(b.utm_source, 60), medium: clean(b.utm_medium, 60), campaign: clean(b.utm_campaign, 80) },
      },
      $inc: { attempts: 1 },
    },
    { upsert: true }
  );
  return { ok: true, existing: !(r && r.upsertedCount) };
}

/* Only redirect back to our own website (prevents open-redirect abuse) */
function safeUrl(u) {
  try {
    const url = new URL(String(u || ''));
    if (!/^https?:$/.test(url.protocol)) return null;
    if (origins.length && !origins.includes(url.origin)) return null;
    return url;
  } catch (e) { return null; }
}

/* ---------- PUBLIC: free enrollment via JSON (works when page + API share http/https) ---------- */
app.post('/api/leads', rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  try {
    const out = await saveLead(req.body || {}, req);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    console.error('POST /api/leads', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- PUBLIC: free enrollment via redirect ----------
   The https page sends the browser here (http://IP:PORT/api/enroll?...), we save,
   then redirect back to thankyou.html. Works without nginx/SSL because a page
   navigation is allowed from https → http (a background fetch is not). */
app.get('/api/enroll', rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  const ty = safeUrl(req.query.ty);
  const back = safeUrl(req.query.back);
  const sendBack = (msg) => {
    if (!back) return res.status(400).type('text').send(msg + ' Please go back and try again.');
    back.searchParams.set('enroll_error', msg);
    back.hash = 'enroll';
    res.redirect(303, back.toString());
  };
  try {
    const out = await saveLead(req.query || {}, req);
    if (!out.ok) return sendBack(out.error);
    if (!ty) return res.type('html').send('<meta name="viewport" content="width=device-width"><p style="font:16px sans-serif;padding:24px">✅ Thank you! You are enrolled. Our team will call you and email the course details within 24 hours.</p>');
    res.redirect(303, ty.toString());
  } catch (err) {
    console.error('GET /api/enroll', err);
    sendBack('Something went wrong on our side.');
  }
});

/* ---------- ADMIN: list leads ---------- */
app.get('/api/admin/leads', rateLimit(120, 10 * 60 * 1000), requireAdmin, async (req, res) => {
  try {
    const q = {};
    const search = clean(req.query.search, 80);
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    }
    if (['new', 'access_sent', 'contacted', 'not_interested'].includes(req.query.status)) q.status = req.query.status;
    if (req.query.from || req.query.to) {
      q.createdAt = {};
      if (req.query.from) q.createdAt.$gte = new Date(req.query.from + 'T00:00:00+05:30');
      if (req.query.to) q.createdAt.$lte = new Date(req.query.to + 'T23:59:59+05:30');
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);

    const startToday = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
    const start7 = new Date(startToday.getTime() - 6 * 864e5);

    const [items, total, today, week, contacted, accessSent] = await Promise.all([
      leads.find(q).sort({ createdAt: -1 }).limit(limit).project({ ip: 0, userAgent: 0 }).toArray(),
      leads.countDocuments({}),
      leads.countDocuments({ createdAt: { $gte: startToday } }),
      leads.countDocuments({ createdAt: { $gte: start7 } }),
      leads.countDocuments({ status: 'contacted' }),
      leads.countDocuments({ status: 'access_sent' }),
    ]);
    res.json({ ok: true, items, stats: { total, today, week, contacted, accessSent } });
  } catch (err) {
    console.error('GET /api/admin/leads', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- ADMIN: update status / note ---------- */
app.patch('/api/admin/leads/:id', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, error: 'Bad id' });
    const set = { updatedAt: new Date() };
    if (['new', 'access_sent', 'contacted', 'not_interested'].includes(req.body.status)) set.status = req.body.status;
    if (typeof req.body.note === 'string') set.note = clean(req.body.note, 300);
    const r = await leads.updateOne({ _id: new ObjectId(req.params.id) }, { $set: set });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/admin/leads', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- admin page (open http://YOUR-IP:PORT/admin) ---------- */
app.get(['/admin', '/admin.html'], (req, res) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  const path = require('path'), fs = require('fs');
  const file = [path.join(__dirname, 'admin.html'), path.join(__dirname, 'public', 'admin.html')].find(f => fs.existsSync(f));
  if (!file) return res.status(404).type('text').send('admin.html not found — put it next to server.js');
  res.sendFile(file);
});

/* ---------- status ---------- */
app.get('/', (req, res) => res.json({ ok: true, service: 'uncodemy-enroll-api' }));
app.get('/health', (req, res) => res.json({ ok: true, db: !!leads }));
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

connectDb()
  .then(() => app.listen(PORT, () => console.log(`✓ API running on port ${PORT}`)))
  .catch(err => { console.error('✗ MongoDB connection failed:', err.message); process.exit(1); });
