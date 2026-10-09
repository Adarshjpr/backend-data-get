/**
 * Uncodemy — Recorded courses · BACKEND (API + Razorpay payment + admin)  — MULTI-COURSE
 *
 * Ek hi backend se kitne bhi course chal sakte hain. Har course ka price / title / URL
 * neeche COURSE_LIST me hai. Naya course = COURSE_LIST me ek entry + uska course page.
 *
 * Flow (paid course):
 *   course page form  →  GET /api/enroll?course=<id>&name&phone&email...
 *   →  backend us course ke price ka Razorpay order banata hai → /pay/<orderId> (checkout)
 *      (form details turant save → admin me "Form bhara, pay nahi kiya")
 *   →  user pays  →  POST /api/pay/verify (signature server par check)
 *   →  lead PAID save (MongoDB)  →  admin me "Paid"  →  thank-you page
 *   (optional) webhook /api/razorpay/webhook — tab band ho jaye tab bhi payment save.
 *
 * Price HAMESHA server decide karta hai (course id se). Page par likha price sirf dikhane ke liye hai.
 * Free course (fee 0): form → save → thank-you.
 *
 * Files:  server.js + admin.html (same folder)  ·  admin → https://api.uncodemy.com/playwright-admin
 * Run:    npm install express cors mongodb dotenv razorpay  →  .env bharo  →  pm2 restart all
 */
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const {
  MONGODB_URI,
  MONGODB_DB = 'uncodemy',
  ADMIN_KEY,
  PORT = 3000,
  ALLOWED_ORIGINS = '',
  BRAND_NAME = 'Uncodemy',
  RAZORPAY_KEY_ID = '',
  RAZORPAY_KEY_SECRET = '',
  RAZORPAY_WEBHOOK_SECRET = '',           // optional but recommended
  FEE_OVERRIDE = '',                      // TESTING ONLY: e.g. 1 → har course ₹1. Live se pehle hata do.
} = process.env;

/* ============================== COURSES ==============================
   ★ Naya course add karna ho to bas yahan ek entry jodo:
     id       → course page ke UC_COURSE_ID jaisa hi (lowercase, a-z 0-9 -)
     fee      → rupees me final price (No GST upar se). 0 = free.
                .env me FEE_<ID> likh kar badal sakte ho (e.g. FEE_SELENIUM_PLAYWRIGHT=5999)
     url      → course page (error par user yahin wapas jata hai)
     thankyou → payment ke baad yahan redirect
   ==================================================================== */
const SITE = 'https://uncodemy.com';
const COURSE_LIST = [
  {
    id: 'playwright',
    title: 'Playwright Testing — Recorded Course',
    fee: 1499,
    url: SITE + '/recorded/course/playwright-testing/',
    thankyou: SITE + '/recorded/course/playwright-testing/thankyou',
  },
  {
    id: 'selenium-playwright',
    title: 'Selenium + Playwright Automation — Recorded Course',
    fee: 5999,
    url: SITE + '/recorded/course/selenium-playwright.html',
    thankyou: SITE + '/recorded/course/selenium-playwright-thankyou.html',
  },
  {
    id: 'excel',
    title: 'MS Excel with 8 Projects — Recorded Course',
    fee: 99,
    url: SITE + '/recorded/course/excel.html',
    thankyou: SITE + '/recorded/course/excel-thankyou.html',
  },
];
const DEFAULT_COURSE = 'playwright';     // purane page/link jo course id nahi bhejte, unke liye
const CURRENCY = 'INR';

if (!MONGODB_URI) { console.error('✗ MONGODB_URI missing in .env'); process.exit(1); }
if (!ADMIN_KEY || ADMIN_KEY.length < 12) { console.error('✗ ADMIN_KEY missing or shorter than 12 characters in .env'); process.exit(1); }

/* build COURSES map: fee from .env (FEE_<ID>) → else COURSE_LIST default */
const envFeeKey = id => 'FEE_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const COURSES = {};
for (const c of COURSE_LIST) {
  if (!/^[a-z0-9-]{2,60}$/.test(c.id)) { console.error(`✗ bad course id "${c.id}" (use a-z, 0-9, -)`); process.exit(1); }
  let raw = process.env[envFeeKey(c.id)];
  // backward compatible: old .env had COURSE_FEE for the Playwright course
  if ((raw === undefined || raw === '') && c.id === 'playwright' && process.env.COURSE_FEE) {
    raw = process.env.COURSE_FEE;
    console.warn('⚠ COURSE_FEE is old — use FEE_PLAYWRIGHT in .env instead');
  }
  if (String(FEE_OVERRIDE).trim() !== '') raw = FEE_OVERRIDE;
  const rs = (raw === undefined || String(raw).trim() === '') ? c.fee : Number(String(raw).trim());
  if (!Number.isFinite(rs) || rs < 0) { console.error(`✗ fee for "${c.id}" must be a number in rupees (or 0 for free)`); process.exit(1); }
  const feePaise = Math.round(rs * 100);
  if (feePaise > 0 && feePaise < 100) { console.error(`✗ fee for "${c.id}" must be at least ₹1 (Razorpay minimum)`); process.exit(1); }
  COURSES[c.id] = { ...c, feePaise, paid: feePaise > 0 };
}
if (!COURSES[DEFAULT_COURSE]) { console.error('✗ DEFAULT_COURSE not in COURSE_LIST'); process.exit(1); }
const ANY_PAID = Object.values(COURSES).some(c => c.paid);
if (ANY_PAID && (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET)) { console.error('✗ a paid course exists but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing in .env'); process.exit(1); }

const getCourse = id => COURSES[String(id || '').trim().toLowerCase()] || null;
const courseIdOf = id => String(id || '').trim().toLowerCase() || DEFAULT_COURSE;
const publicCourse = c => ({ id: c.id, title: c.title, fee: c.feePaise / 100, paid: c.paid });

let razorpay = null;
if (ANY_PAID) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
}

const app = express();
app.set('trust proxy', 1);
// keep the raw body so the Razorpay webhook signature can be checked
app.use(express.json({ limit: '64kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

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
let leads, payments;
async function connectDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  leads = db.collection('leads');
  payments = db.collection('payments');           // one doc per Razorpay order (created / paid)
  await leads.createIndex({ email: 1, course: 1 }, { unique: true });
  await leads.createIndex({ createdAt: -1 });
  await leads.createIndex({ course: 1, paid: 1, paidAt: -1 });
  await payments.createIndex({ orderId: 1 }, { unique: true });
  await payments.createIndex({ createdAt: -1 });
  await payments.createIndex({ status: 1, createdAt: -1 });
  await payments.createIndex({ 'form.course': 1, status: 1 });
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
const ORDER_RE = /^order_[A-Za-z0-9]{6,40}$/;
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const rupees = paise => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const escRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function requireAdmin(req, res, next) {
  if (safeEqual(req.get('x-admin-key'), ADMIN_KEY)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

/* ---------- read + validate the enrollment form ---------- */
function readForm(b, req) {
  const name = clean(b.name, 80);
  const phone = clean(b.phone, 14).replace(/\D/g, '').slice(-10);
  const email = clean(b.email, 120).toLowerCase();
  const course = courseIdOf(clean(b.course, 80));

  if (!COURSES[course]) return { error: 'This course is not available. Please refresh the page and try again.' };
  if (name.length < 2) return { error: 'Please enter your full name.' };
  if (!PHONE_RE.test(phone)) return { error: 'Please enter a valid 10-digit mobile number.' };
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.' };

  // Never drop a lead silently. Very fast submissions are only flagged as "suspect" for review in admin.
  const elapsed = Number(b.elapsed);
  return {
    data: {
      name, phone, email, course,
      page: clean(b.page, 200),
      utm: { source: clean(b.utm_source, 60), medium: clean(b.utm_medium, 60), campaign: clean(b.utm_campaign, 80) },
    },
    meta: {
      ip: req.ip,
      userAgent: clean(req.get('user-agent'), 200),
      suspect: Number.isFinite(elapsed) && elapsed > 0 && elapsed < 1500,
    },
  };
}

/* ---------- write a lead (free sign-up, or after a successful payment) ---------- */
async function writeLead(d, meta, payment) {
  const now = new Date();
  const set = { name: d.name, phone: d.phone, lastSeenAt: now, page: d.page, userAgent: meta.userAgent, ip: meta.ip, suspect: !!meta.suspect };
  if (payment) {
    Object.assign(set, {
      paid: true, amount: payment.amount, currency: payment.currency,
      orderId: payment.orderId, paymentId: payment.paymentId, paidAt: payment.paidAt,
    });
  }
  const r = await leads.updateOne(
    { email: d.email, course: d.course },
    {
      $set: set,
      $setOnInsert: { createdAt: now, status: 'new', utm: d.utm },   // first-touch attribution
      $inc: { attempts: 1 },
    },
    { upsert: true }
  );
  return { ok: true, existing: !(r && r.upsertedCount) };
}

/* ---------- create a Razorpay order for a filled form ----------
   Amount comes ONLY from the course config on the server.
   The form data is stored in `payments` right away (status "created"). */
async function createOrder(b, req, links) {
  const f = readForm(b, req);
  if (f.error) return { ok: false, error: f.error };
  const d = f.data;
  const course = COURSES[d.course];
  if (!course.paid) return { ok: false, error: 'This course is free.' };

  // already paid for this course with this email → don't charge again
  const already = await leads.findOne({ email: d.email, course: d.course, paid: true }, { projection: { _id: 1 } });
  if (already) return { ok: true, alreadyPaid: true };

  const receipt = ('rc_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex')).slice(0, 40);
  const order = await razorpay.orders.create({
    amount: course.feePaise,         // exact course price — no GST / convenience fee added by our code
    currency: CURRENCY,
    receipt,
    notes: { name: d.name, email: d.email, phone: d.phone, course: d.course },
  });

  await payments.insertOne({
    orderId: order.id, receipt, amount: order.amount, currency: order.currency,
    status: 'created', course: d.course, form: d, meta: f.meta,
    ty: links.ty, back: links.back, createdAt: new Date(),
  });
  return { ok: true, orderId: order.id, amount: order.amount, currency: order.currency, form: d, course };
}

/* ---------- mark an order paid + save the lead ----------
   Safe to call twice at the same time (checkout + webhook): the status flip
   is atomic, so only one caller writes the lead. */
async function finalizePayment(orderId, paymentId, via) {
  const paidAt = new Date();
  const r = await payments.findOneAndUpdate(
    { orderId, status: { $ne: 'paid' } },
    { $set: { status: 'paid', paymentId, paidAt, via } },
    { returnDocument: 'before', includeResultMetadata: false }
  );
  const p = r && r.value !== undefined && r.ok !== undefined ? r.value : r;   // works on mongodb driver v4, v5 and v6
  if (!p) {
    const existing = await payments.findOne({ orderId });
    if (!existing) return { ok: false, error: 'Order not found' };
    return { ok: true, doc: existing, duplicate: true };                        // already finalized
  }

  try {
    await writeLead(p.form, p.meta || {}, { amount: p.amount, currency: p.currency, orderId, paymentId, paidAt });
  } catch (err) {
    // roll back the flag so the webhook / a retry can finish the job
    await payments.updateOne({ orderId }, { $set: { status: 'created' }, $unset: { paymentId: '', paidAt: '', via: '' } });
    throw err;
  }
  console.log(`✓ PAID ${rupees(p.amount)} · ${p.form.course} · ${p.form.email} · ${orderId} · ${paymentId} (${via})`);
  return { ok: true, doc: p };
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

/* thank-you + back links for a request (page-sent links first, else course defaults) */
function linksFor(course, ty, back) {
  const c = course || COURSES[DEFAULT_COURSE];
  return { ty: safeUrl(ty) || new URL(c.thankyou), back: safeUrl(back) || new URL(c.url) };
}

/* ---------- people who filled the form but have NOT paid (yet) ----------
   One row per email+course (latest attempt), hidden as soon as that email pays for that course. */
async function pendingRows(q) {
  const match = { status: 'created' };
  if (q.course) match['form.course'] = q.course;
  if (q.search) {
    const rx = new RegExp(escRx(q.search), 'i');
    match.$or = [{ 'form.name': rx }, { 'form.email': rx }, { 'form.phone': rx }, { orderId: rx }];
  }
  if (q.from || q.to) {
    match.createdAt = {};
    if (q.from) match.createdAt.$gte = new Date(q.from + 'T00:00:00+05:30');
    if (q.to) match.createdAt.$lte = new Date(q.to + 'T23:59:59+05:30');
  }
  const groups = await payments.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { email: '$form.email', course: '$form.course' }, doc: { $first: '$$ROOT' }, tries: { $sum: 1 } } },
  ]).toArray();
  if (!groups.length) return [];

  // drop anyone who has paid for that course since (e.g. paid on a second try)
  const paid = await leads.find(
    { paid: true, email: { $in: [...new Set(groups.map(g => g._id.email))] } },
    { projection: { email: 1, course: 1 } }
  ).toArray();
  const paidSet = new Set(paid.map(l => l.email + '|' + l.course));
  return groups
    .filter(g => !paidSet.has(g._id.email + '|' + g._id.course))
    .sort((a, b) => new Date(b.doc.createdAt) - new Date(a.doc.createdAt));
}

async function pendingList(q, limit) {
  const rows = (await pendingRows(q)).slice(0, limit);
  return rows.map(r => {
    const d = r.doc, f = d.form || {};
    const c = getCourse(f.course);
    return {
      _id: d._id, pending: true, paid: false,
      name: f.name, phone: f.phone, email: f.email, course: f.course, courseTitle: c ? c.title : f.course,
      utm: f.utm, page: f.page,
      amount: d.amount, orderId: d.orderId, createdAt: d.createdAt, lastSeenAt: d.createdAt,
      attempts: r.tries, status: 'pending', suspect: !!(d.meta && d.meta.suspect),
    };
  });
}

async function pendingCount(course) {
  return (await pendingRows({ course })).length;
}

/* ---------- PUBLIC: price info (optional) ·  /api/config?course=excel ---------- */
app.get('/api/config', (req, res) => {
  const base = { ok: true, currency: CURRENCY, gst: false, keyId: ANY_PAID ? RAZORPAY_KEY_ID : null };
  if (req.query.course) {
    const c = getCourse(req.query.course);
    if (!c) return res.status(404).json({ ok: false, error: 'Unknown course' });
    return res.json({ ...base, ...publicCourse(c) });
  }
  res.json({ ...base, courses: Object.values(COURSES).map(publicCourse) });
});

/* ---------- PUBLIC: free enrollment via JSON (only for free courses) ---------- */
app.post('/api/leads', rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  const c = getCourse(courseIdOf(req.body && req.body.course));
  if (!c) return res.status(400).json({ ok: false, error: 'Unknown course' });
  if (c.paid) return res.status(402).json({ ok: false, error: 'This course is paid. Use /api/pay/order to pay first.' });
  try {
    const f = readForm(req.body || {}, req);
    if (f.error) return res.status(400).json({ ok: false, error: f.error });
    res.json(await writeLead(f.data, f.meta));
  } catch (err) {
    console.error('POST /api/leads', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- PUBLIC: enrollment via redirect (all course pages use this) ----------
   FREE course → save → thank-you.
   PAID course → Razorpay order → /pay/<orderId> (checkout) → after payment → thank-you. */
app.get('/api/enroll', rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  const q = req.query || {};
  const course = getCourse(courseIdOf(q.course));
  const { ty, back } = linksFor(course, q.ty, q.back);
  const sendBack = (msg) => {
    back.searchParams.set('enroll_error', msg);
    back.hash = 'enroll';
    res.redirect(303, back.toString());
  };
  try {
    if (!course) return sendBack('This course is not available. Please refresh the page and try again.');
    if (!course.paid) {
      const f = readForm(q, req);
      if (f.error) return sendBack(f.error);
      await writeLead(f.data, f.meta);
      return res.redirect(303, ty.toString());
    }
    const out = await createOrder(q, req, { ty: ty.toString(), back: back.toString() });
    if (!out.ok) return sendBack(out.error);
    if (out.alreadyPaid) return res.redirect(303, ty.toString());
    res.redirect(303, '/pay/' + out.orderId);
  } catch (err) {
    console.error('GET /api/enroll', err && (err.error || err));
    sendBack('Something went wrong on our side. Please try again.');
  }
});

/* ---------- PUBLIC: checkout page served by this backend ---------- */
app.get('/pay/:orderId', async (req, res) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  const home = COURSES[DEFAULT_COURSE].url;
  if (!ANY_PAID || !ORDER_RE.test(req.params.orderId)) return res.redirect(303, home);
  try {
    const p = await payments.findOne({ orderId: req.params.orderId });
    if (!p) return res.redirect(303, home);
    const c = getCourse(p.form && p.form.course) || COURSES[DEFAULT_COURSE];
    if (p.status === 'paid') return res.redirect(303, p.ty || c.thankyou);
    const data = {
      key: RAZORPAY_KEY_ID, orderId: p.orderId, amount: p.amount, currency: p.currency,
      price: rupees(p.amount), brand: BRAND_NAME, title: c.title,
      prefill: { name: p.form.name, email: p.form.email, contact: '+91' + p.form.phone },
      back: p.back || c.url,
    };
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    res.type('html').send(PAY_HTML.replace('__PAY_DATA__', () => json));
  } catch (err) {
    console.error('GET /pay', err);
    res.redirect(303, home);
  }
});

/* ---------- PUBLIC: create order via JSON (if a page calls the API with fetch) ---------- */
app.post('/api/pay/order', rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const course = getCourse(courseIdOf(b.course));
  if (!course) return res.status(400).json({ ok: false, error: 'Unknown course' });
  if (!course.paid) return res.status(400).json({ ok: false, error: 'This course is free.' });
  try {
    const { ty, back } = linksFor(course, b.ty, b.back);
    const out = await createOrder(b, req, { ty: ty.toString(), back: back.toString() });
    if (!out.ok) return res.status(400).json(out);
    if (out.alreadyPaid) return res.json({ ok: true, alreadyPaid: true, redirect: ty.toString() });
    res.json({
      ok: true, key: RAZORPAY_KEY_ID, orderId: out.orderId, amount: out.amount, currency: out.currency,
      name: BRAND_NAME, description: out.course.title,
      prefill: { name: out.form.name, email: out.form.email, contact: '+91' + out.form.phone },
    });
  } catch (err) {
    console.error('POST /api/pay/order', err && (err.error || err));
    res.status(500).json({ ok: false, error: 'Could not start payment. Please try again.' });
  }
});

/* ---------- PUBLIC: verify payment after Razorpay checkout succeeds ---------- */
app.post('/api/pay/verify', rateLimit(30, 10 * 60 * 1000), async (req, res) => {
  if (!ANY_PAID) return res.status(400).json({ ok: false, error: 'No paid course configured.' });
  try {
    const b = req.body || {};
    const orderId = String(b.razorpay_order_id || ''), paymentId = String(b.razorpay_payment_id || ''), sig = String(b.razorpay_signature || '');
    if (!ORDER_RE.test(orderId) || !paymentId || !sig) return res.status(400).json({ ok: false, error: 'Missing payment details.' });

    // the ONLY thing that proves the payment is real: HMAC(order_id|payment_id, key_secret)
    if (!safeEqual(hmac(RAZORPAY_KEY_SECRET, orderId + '|' + paymentId), sig)) {
      console.warn('✗ bad payment signature', orderId, paymentId);
      return res.status(400).json({ ok: false, error: 'Payment verification failed.' });
    }

    // if auto-capture is OFF in the Razorpay dashboard, capture it here so money is not auto-refunded
    try {
      const pay = await razorpay.payments.fetch(paymentId);
      if (pay.status === 'authorized') await razorpay.payments.capture(paymentId, pay.amount, pay.currency);
    } catch (e) { console.warn('capture check failed (payment still verified):', e && (e.error || e.message)); }

    const out = await finalizePayment(orderId, paymentId, 'checkout');
    if (!out.ok) return res.status(404).json(out);
    const c = getCourse(out.doc.form && out.doc.form.course) || COURSES[DEFAULT_COURSE];
    res.json({ ok: true, redirect: out.doc.ty || c.thankyou });
  } catch (err) {
    console.error('POST /api/pay/verify', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- Razorpay webhook (Dashboard → Webhooks, events: payment.captured + order.paid) ---------- */
app.post('/api/razorpay/webhook', async (req, res) => {
  if (!ANY_PAID || !RAZORPAY_WEBHOOK_SECRET) return res.status(404).json({ ok: false });
  if (!safeEqual(hmac(RAZORPAY_WEBHOOK_SECRET, req.rawBody || ''), req.get('x-razorpay-signature'))) {
    return res.status(400).json({ ok: false, error: 'Bad signature' });
  }
  try {
    const ev = req.body && req.body.event;
    const pay = req.body && req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
    if ((ev === 'payment.captured' || ev === 'order.paid') && pay && pay.order_id) {
      await finalizePayment(pay.order_id, pay.id, 'webhook');
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('webhook', err);
    res.status(500).json({ ok: false });   // Razorpay will retry
  }
});

/* ---------- ADMIN: list leads ----------
   ?course=excel  → sirf us course ke leads + stats (khaali = saare courses)
   ?pay=paid      → only students who paid
   ?pay=pending   → filled the form, opened payment, but did NOT pay
   ?pay=free      → free sign-ups
   (empty)        → paid + free
   Response me `courses` list bhi aati hai (admin dropdown ke liye).            */
app.get('/api/admin/leads', rateLimit(120, 10 * 60 * 1000), requireAdmin, async (req, res) => {
  try {
    const search = clean(req.query.search, 80);
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
    const cSel = getCourse(req.query.course);
    const course = cSel ? cSel.id : '';
    const cq = course ? { course } : {};

    const startToday = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
    const start7 = new Date(startToday.getTime() - 6 * 864e5);

    let itemsPromise;
    if (req.query.pay === 'pending') {
      itemsPromise = pendingList({ search, from, to, course }, limit);
    } else {
      const q = { ...cq };
      if (search) {
        const rx = new RegExp(escRx(search), 'i');
        q.$or = [{ name: rx }, { email: rx }, { phone: rx }, { paymentId: rx }];
      }
      if (['new', 'access_sent', 'contacted', 'not_interested'].includes(req.query.status)) q.status = req.query.status;
      if (req.query.pay === 'paid') q.paid = true;
      if (req.query.pay === 'free') q.paid = { $ne: true };
      if (from || to) {
        q.createdAt = {};
        if (from) q.createdAt.$gte = new Date(from + 'T00:00:00+05:30');
        if (to) q.createdAt.$lte = new Date(to + 'T23:59:59+05:30');
      }
      itemsPromise = leads.find(q).sort({ paidAt: -1, createdAt: -1 }).limit(limit).project({ ip: 0, userAgent: 0 }).toArray()
        .then(rows => rows.map(r => { const c = getCourse(r.course); return { ...r, courseTitle: c ? c.title : r.course }; }));
    }

    const [items, total, today, week, contacted, accessSent, rev, pending, byCourse] = await Promise.all([
      itemsPromise,
      leads.countDocuments(cq),
      leads.countDocuments({ ...cq, paid: true, paidAt: { $gte: startToday } }),
      leads.countDocuments({ ...cq, paid: true, paidAt: { $gte: start7 } }),
      leads.countDocuments({ ...cq, status: 'contacted' }),
      leads.countDocuments({ ...cq, status: 'access_sent' }),
      leads.aggregate([{ $match: { ...cq, paid: true } }, { $group: { _id: null, n: { $sum: 1 }, sum: { $sum: '$amount' } } }]).toArray(),
      ANY_PAID ? pendingCount(course) : Promise.resolve(0),
      leads.aggregate([{ $match: { paid: true } }, { $group: { _id: '$course', n: { $sum: 1 }, sum: { $sum: '$amount' } } }]).toArray(),
    ]);
    const paidCount = rev[0] ? rev[0].n : 0, revenue = rev[0] ? rev[0].sum / 100 : 0;
    const perCourse = Object.fromEntries(byCourse.map(r => [r._id, { paid: r.n, revenue: r.sum / 100 }]));
    res.json({
      ok: true, items,
      stats: { total, today, week, contacted, accessSent, paid: paidCount, revenue, pending },
      course: course || null,
      courses: Object.values(COURSES).map(c => ({ ...publicCourse(c), ...(perCourse[c.id] || { paid: 0, revenue: 0 }) })),
      fee: (cSel || COURSES[DEFAULT_COURSE]).feePaise / 100,   // kept for the old admin.html
    });
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
    await leads.updateOne({ _id: new ObjectId(req.params.id) }, { $set: set });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/admin/leads', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- admin page ----------
   admin.html file server.js ke bagal me (same folder) rakhni hai. */
const ADMIN_FILE = path.join(__dirname, 'admin.html');
app.get(['/admin', '/admin.html', '/playwright-admin', '/courses-admin'], (req, res) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  res.sendFile(ADMIN_FILE, err => {
    if (err) res.status(500).type('text').send('admin.html not found next to server.js');
  });
});

/* ---------- status ---------- */
const statusInfo = () => ({ ok: true, service: 'uncodemy-enroll-api', courses: Object.values(COURSES).map(publicCourse) });
app.get('/', (req, res) => res.json(statusInfo()));
app.get('/health', (req, res) => res.json({ ...statusInfo(), db: !!leads }));
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

connectDb()
  .then(() => app.listen(PORT, () => {
    console.log(`✓ API running on port ${PORT}`);
    for (const c of Object.values(COURSES)) {
      console.log(`  • ${c.id.padEnd(22)} ${c.paid ? rupees(c.feePaise) + ' (no GST added)' : 'FREE'}`);
    }
    if (ANY_PAID) console.log(`✓ Razorpay ${RAZORPAY_KEY_ID.startsWith('rzp_test') ? 'TEST keys' : 'LIVE keys'}`);
    if (String(FEE_OVERRIDE).trim() !== '') console.warn(`⚠ FEE_OVERRIDE=${FEE_OVERRIDE} is ON — every course charges this. Remove it before going live!`);
    if (ANY_PAID && !RAZORPAY_WEBHOOK_SECRET) console.warn('⚠ RAZORPAY_WEBHOOK_SECRET not set — webhook backup is off.');
  }))
  .catch(err => { console.error('✗ MongoDB connection failed:', err.message); process.exit(1); });

/* ====================== PAYMENT PAGE (HTML) ====================== */
/* eslint-disable */
var PAY_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Complete payment · Uncodemy</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
:root{--blue:#2563EB;--navy:#0F2A5C;--navy-9:#0A1628;--or:#FF5421;--green:#16A34A;--muted:#6B7280;--line:#E5E7EB}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;font-family:Inter,system-ui,sans-serif;background:linear-gradient(135deg,var(--navy),var(--navy-9));color:#171717}
.card{width:100%;max-width:400px;background:#fff;border-radius:18px;padding:26px;box-shadow:0 30px 60px -20px rgba(0,0,0,.5)}
.logo{font-size:20px;font-weight:900;color:var(--navy-9)}.logo span{color:var(--or)}
h1{font-size:18px;margin:14px 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 16px}
.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
.row b{text-align:right;word-break:break-all}
.total{font-size:18px;font-weight:900;border:0;padding-bottom:2px}
.nogst{font-size:12px;color:var(--green);font-weight:700;text-align:right}
.btn{width:100%;margin-top:16px;border:0;border-radius:10px;padding:14px;font:inherit;font-weight:800;font-size:16px;cursor:pointer;background:var(--blue);color:#fff}
.btn:disabled{opacity:.6;cursor:wait}
.msg{min-height:20px;margin-top:12px;font-size:13px;font-weight:600;text-align:center}
.msg.err{color:#B91C1C}.msg.ok{color:var(--green)}
.back{display:block;text-align:center;margin-top:10px;color:var(--muted);font-size:13px}
.safe{text-align:center;font-size:11.5px;color:var(--muted);margin-top:14px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Un<span>codemy</span></div>
  <h1 id="title"></h1>
  <p class="sub">Complete the payment to confirm your enrollment.</p>
  <div class="row"><span>Name</span><b id="nm"></b></div>
  <div class="row"><span>Email</span><b id="em"></b></div>
  <div class="row"><span>Mobile</span><b id="ph"></b></div>
  <div class="row total"><span>Total</span><b id="amt"></b></div>
  <div class="nogst">No GST · No extra charges</div>
  <button class="btn" id="payBtn" type="button">Pay now</button>
  <div class="msg" id="msg"></div>
  <a class="back" id="backLink" href="#">← Edit details</a>
  <div class="safe">🔒 Secure payment by Razorpay · UPI, cards, netbanking, wallets</div>
</div>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
(function () {
  var D = __PAY_DATA__;
  var $ = function (id) { return document.getElementById(id); };
  $('title').textContent = D.title; $('nm').textContent = D.prefill.name; $('em').textContent = D.prefill.email;
  $('ph').textContent = D.prefill.contact; $('amt').textContent = D.price; $('payBtn').textContent = 'Pay ' + D.price;
  $('backLink').href = D.back;
  function msg(t, cls) { var m = $('msg'); m.textContent = t; m.className = 'msg ' + (cls || ''); }
  function busy(b) { $('payBtn').disabled = b; }

  function verify(r) {
    busy(true); msg('Confirming your payment… please do not close this page.', 'ok');
    fetch('/api/pay/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) })
      .then(function (x) { return x.json(); })
      .then(function (d) {
        if (d.ok) { msg('Payment successful! Redirecting…', 'ok'); location.href = d.redirect; }
        else { busy(false); msg((d.error || 'Verification failed') + ' — if money was deducted, contact us with Payment ID ' + r.razorpay_payment_id, 'err'); }
      })
      .catch(function () { busy(false); msg('Network error. If money was deducted, contact us with Payment ID ' + r.razorpay_payment_id, 'err'); });
  }

  function open() {
    if (typeof Razorpay === 'undefined') { msg('Could not load Razorpay. Check your internet and refresh.', 'err'); return; }
    msg('');
    var rzp = new Razorpay({
      key: D.key, order_id: D.orderId, amount: D.amount, currency: D.currency,
      name: D.brand, description: D.title, prefill: D.prefill,
      theme: { color: '#2563EB' },
      handler: verify,
      modal: { ondismiss: function () { msg('Payment not completed. Click "Pay" to try again.', 'err'); } }
    });
    rzp.on('payment.failed', function (r) { msg('Payment failed: ' + ((r.error && r.error.description) || 'please try again') + '.', 'err'); });
    rzp.open();
  }
  $('payBtn').addEventListener('click', open);
  open();   // open checkout automatically
})();
</script>
</body>
</html>
`;