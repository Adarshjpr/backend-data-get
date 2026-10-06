/**
 * Uncodemy — FREE Playwright recorded course · BACKEND (API only)
 * Saves enrollments to MongoDB and serves them to admin.html.
 * index + thankyou pages live on uncodemy.com; the admin dashboard is built into this file (/admin).
 * Only ONE file to deploy: replace server.js and run `pm2 restart all`.
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
  THANKYOU_URL = 'https://uncodemy.com/recorded/course/playwright-testing/thankyou',
  COURSE_URL = 'https://uncodemy.com/recorded/course/playwright-testing/',
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
  const ty = safeUrl(req.query.ty) || new URL(THANKYOU_URL);
  const back = safeUrl(req.query.back) || new URL(COURSE_URL);
  const sendBack = (msg) => {
    back.searchParams.set('enroll_error', msg);
    back.hash = 'enroll';
    res.redirect(303, back.toString());
  };
  try {
    const out = await saveLead(req.query || {}, req);
    if (!out.ok) return sendBack(out.error);
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
  res.type('html').send(ADMIN_HTML);
});

/* ---------- status ---------- */
app.get('/', (req, res) => res.json({ ok: true, service: 'uncodemy-enroll-api' }));
app.get('/health', (req, res) => res.json({ ok: true, db: !!leads }));
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

connectDb()
  .then(() => app.listen(PORT, () => console.log(`✓ API running on port ${PORT}`)))
  .catch(err => { console.error('✗ MongoDB connection failed:', err.message); process.exit(1); });

/* ====================== ADMIN DASHBOARD (HTML) ====================== */
/* eslint-disable */
var ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Enrollments Admin · Uncodemy</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
:root{--blue:#2563EB;--blue-l:#EAF1FF;--navy:#0F2A5C;--navy-9:#0A1628;--or:#FF5421;--green:#16A34A;--text:#171717;--muted:#6B7280;--line:#E5E7EB;--bg:#F6F8FC}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:14px;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit}
.hide{display:none!important}
/* login */
.login{min-height:100vh;display:grid;place-items:center;padding:20px;background:linear-gradient(135deg,var(--navy),var(--navy-9))}
.login form{width:100%;max-width:360px;background:#fff;border-radius:18px;padding:28px;box-shadow:0 30px 60px -20px rgba(0,0,0,.5)}
.logo{font-size:20px;font-weight:900;color:var(--navy-9)}.logo span{color:var(--or)}
.login h1{font-size:18px;margin:14px 0 4px}.login p{color:var(--muted);margin:0 0 18px;font-size:13px}
.login input{width:100%;padding:12px 14px;border:1.5px solid var(--line);border-radius:10px;margin-bottom:12px}
.login input:focus,.bar input:focus,.bar select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 4px rgba(37,99,235,.12)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;background:var(--blue);color:#fff}
.btn.w{width:100%;padding:12px}
.btn.ghost{background:#fff;color:var(--text);border:1px solid var(--line)}
.btn.green{background:var(--green)}
.err{color:#B91C1C;font-size:12.5px;font-weight:600;min-height:18px;margin-top:8px}
/* app */
header{background:var(--navy-9);color:#fff}
header .in{max-width:1280px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
header .logo{color:#fff}header small{color:#8fa4c0;font-weight:600;margin-left:8px}
.wrap{max-width:1280px;margin:0 auto;padding:20px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px}
.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.stat small{display:block;color:var(--muted);font-weight:600;font-size:12px}
.stat b{font-size:24px;font-weight:900}
.stat:nth-child(1){border-top:3px solid var(--blue)}.stat:nth-child(2){border-top:3px solid var(--or)}.stat:nth-child(3){border-top:3px solid #8B5CF6}.stat:nth-child(4){border-top:3px solid #F59E0B}.stat:nth-child(5){border-top:3px solid var(--green)}
@media(max-width:800px){.stats{grid-template-columns:repeat(2,1fr)}}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:12px}
.bar input,.bar select{padding:9px 12px;border:1.5px solid var(--line);border-radius:9px;background:#fff}
.bar .s{flex:1 1 220px}
.bar label{font-size:12px;color:var(--muted);font-weight:600;display:flex;align-items:center;gap:6px}
.bar .sp{flex:1}
.tbl{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:auto}
table{width:100%;border-collapse:collapse;min-width:900px}
th,td{padding:11px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
th{background:#F8FAFC;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);position:sticky;top:0}
tr:hover td{background:#FAFBFF}
td .nm{font-weight:700}
td .sub{font-size:12px;color:var(--muted)}
td a{color:var(--blue);font-weight:600}
.wa{display:inline-block;margin-left:6px;font-size:11px;font-weight:800;color:#fff!important;background:#25D366;padding:2px 7px;border-radius:99px}
.flag{font-size:10.5px;font-weight:800;color:#B45309;background:#FFFBEB;border:1px solid #FDE68A;padding:1px 6px;border-radius:99px;margin-left:4px}
.badge{font-size:11px;font-weight:800;padding:2px 8px;border-radius:99px;background:var(--blue-l);color:var(--blue)}
td select{padding:6px 8px;border-radius:8px;border:1.5px solid var(--line);font-weight:700;font-size:12.5px}
td select.new{color:var(--blue);border-color:#C7D7FE;background:#EFF6FF}
td select.contacted{color:#B45309;border-color:#FDE68A;background:#FFFBEB}
td select.access_sent{color:#15803D;border-color:#BBF7D0;background:#F0FDF4}
td select.not_interested{color:#6B7280;background:#F3F4F6}
.empty{padding:40px;text-align:center;color:var(--muted);font-weight:600}
.note{font-size:12px;color:var(--muted);margin-top:10px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--navy-9);color:#fff;padding:10px 16px;border-radius:10px;font-weight:600;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.on{opacity:1}
</style>
</head>
<body>

<!-- LOGIN -->
<div class="login" id="loginView">
  <form id="loginForm" autocomplete="off">
    <div class="logo">Un<span>codemy</span></div>
    <h1>Enrollments admin</h1>
    <p>Enter the admin key (ADMIN_KEY from the backend .env).</p>
    <input id="keyInput" type="password" placeholder="Admin key" required>
    <button class="btn w" type="submit">Open dashboard</button>
    <div class="err" id="loginErr"></div>
  </form>
</div>

<!-- DASHBOARD -->
<div id="appView" class="hide">
  <header><div class="in">
    <div><span class="logo">Un<span>codemy</span></span><small>Free Playwright course · enrollments</small></div>
    <div style="display:flex;gap:8px"><a class="btn ghost" href="https://uncodemy.com/recorded/course/playwright-testing/" target="_blank" rel="noopener">Course page ↗</a><button class="btn ghost" id="logoutBtn" type="button">Log out</button></div>
  </div></header>

  <div class="wrap">
    <div class="stats">
      <div class="stat"><small>Total enrolled</small><b id="sTotal">0</b></div>
      <div class="stat"><small>Today</small><b id="sToday">0</b></div>
      <div class="stat"><small>Last 7 days</small><b id="sWeek">0</b></div>
      <div class="stat"><small>Access sent</small><b id="sSent">0</b></div>
      <div class="stat"><small>Called</small><b id="sContacted">0</b></div>
    </div>

    <div class="bar">
      <input class="s" id="fSearch" type="search" placeholder="Search name, email or phone">
      <select id="fStatus">
        <option value="">All status</option><option value="new">New</option><option value="access_sent">Access sent</option><option value="contacted">Called</option><option value="not_interested">Not interested</option>
      </select>
      <label>From <input id="fFrom" type="date"></label>
      <label>To <input id="fTo" type="date"></label>
      <span class="sp"></span>
      <button class="btn ghost" id="refreshBtn" type="button">↻ Refresh</button>
      <button class="btn green" id="csvBtn" type="button">⬇ Export CSV</button>
    </div>

    <div class="tbl">
      <table>
        <thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Email</th><th>Course</th><th>Sign-ups</th><th>Source</th><th>Status</th></tr></thead>
        <tbody id="rows"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
    <p class="note">Someone is added here when they submit the free enrollment form. "Sign-ups" counts repeat submissions with the same email. Call them, mark <b>Called</b>, then send the course details by email within 24 hours and mark <b>Access sent</b>.</p>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
/* admin.html is served by the backend itself (http://IP:PORT/admin), so the API is on the same address */
var API_BASE = '';
(function () {
  var KEY_NAME = 'uc_admin_key', items = [], timer;
  var $ = function (id) { return document.getElementById(id); };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function key() { try { return sessionStorage.getItem(KEY_NAME) || ''; } catch (e) { return window.__k || ''; } }
  function setKey(k) { try { k ? sessionStorage.setItem(KEY_NAME, k) : sessionStorage.removeItem(KEY_NAME); } catch (e) { window.__k = k; } }
  function toast(t) { var el = $('toast'); el.textContent = t; el.classList.add('on'); setTimeout(function () { el.classList.remove('on'); }, 1800); }
  function fmt(d) { return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'x-admin-key': key(), 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(API_BASE + path, opts).then(function (r) {
      if (r.status === 401) { logout('Wrong admin key.'); throw new Error('401'); }
      return r.json();
    });
  }

  function load() {
    var p = new URLSearchParams();
    if ($('fSearch').value.trim()) p.set('search', $('fSearch').value.trim());
    if ($('fStatus').value) p.set('status', $('fStatus').value);
    if ($('fFrom').value) p.set('from', $('fFrom').value);
    if ($('fTo').value) p.set('to', $('fTo').value);
    p.set('limit', '2000');
    return api('/api/admin/leads?' + p.toString()).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'Error');
      items = d.items;
      $('sTotal').textContent = d.stats.total; $('sToday').textContent = d.stats.today; $('sWeek').textContent = d.stats.week;
      $('sContacted').textContent = d.stats.contacted; $('sSent').textContent = d.stats.accessSent;
      render();
    });
  }

  function render() {
    if (!items.length) { $('rows').innerHTML = '<tr><td colspan="8" class="empty">No leads found.</td></tr>'; return; }
    var opts = [['new', 'New'], ['access_sent', 'Access sent'], ['contacted', 'Called'], ['not_interested', 'Not interested']];
    $('rows').innerHTML = items.map(function (l) {
      var st = l.status || 'new', src = (l.utm && l.utm.source) ? l.utm.source + (l.utm.campaign ? ' / ' + l.utm.campaign : '') : 'direct';
      return '<tr>' +
        '<td><div>' + esc(fmt(l.createdAt)) + '</div>' + (l.lastSeenAt && l.lastSeenAt !== l.createdAt ? '<div class="sub">last: ' + esc(fmt(l.lastSeenAt)) + '</div>' : '') + '</td>' +
        '<td><div class="nm">' + esc(l.name) + (l.suspect ? ' <span class="flag" title="Submitted within 1.5 s of page load — may be a bot">⚠ check</span>' : '') + '</div></td>' +
        '<td><a href="tel:+91' + esc(l.phone) + '">' + esc(l.phone) + '</a><a class="wa" href="https://wa.me/91' + esc(l.phone) + '" target="_blank" rel="noopener">WA</a></td>' +
        '<td><a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a></td>' +
        '<td><span class="badge">' + esc(l.course) + '</span></td>' +
        '<td>' + esc(l.attempts || 1) + '</td>' +
        '<td class="sub">' + esc(src) + '</td>' +
        '<td><select class="' + esc(st) + '" data-id="' + esc(l._id) + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === st ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>' +
        '</tr>';
    }).join('');
  }

  $('rows').addEventListener('change', function (e) {
    var s = e.target; if (s.tagName !== 'SELECT') return;
    s.className = s.value;
    api('/api/admin/leads/' + encodeURIComponent(s.dataset.id), { method: 'PATCH', body: JSON.stringify({ status: s.value }) })
      .then(function (d) { if (d.ok) { toast('Status updated'); load(); } else toast(d.error || 'Failed'); })
      .catch(function () {});
  });

  function csvCell(v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }
  $('csvBtn').addEventListener('click', function () {
    if (!items.length) return toast('Nothing to export');
    var head = ['Created (IST)', 'Name', 'Phone', 'Email', 'Course', 'Clicks', 'Status', 'UTM source', 'UTM medium', 'UTM campaign', 'Page'];
    var lines = [head.map(csvCell).join(',')].concat(items.map(function (l) {
      var u = l.utm || {};
      return [new Date(l.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), l.name, l.phone, l.email, l.course, l.attempts || 1, l.status, u.source, u.medium, u.campaign, l.page].map(csvCell).join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'playwright-enrollments-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  });

  ['fStatus', 'fFrom', 'fTo'].forEach(function (id) { $(id).addEventListener('change', load); });
  $('fSearch').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 350); });
  $('refreshBtn').addEventListener('click', function () { load().then(function () { toast('Refreshed'); }); });

  function showApp() { $('loginView').classList.add('hide'); $('appView').classList.remove('hide'); }
  function logout(msg) { setKey(''); $('appView').classList.add('hide'); $('loginView').classList.remove('hide'); $('loginErr').textContent = msg || ''; }
  $('logoutBtn').addEventListener('click', function () { logout(''); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); $('loginErr').textContent = '';
    setKey($('keyInput').value.trim());
    load().then(function () { showApp(); $('keyInput').value = ''; }).catch(function (err) { if (err.message !== '401') $('loginErr').textContent = 'Could not reach the server. Is the backend running?'; });
  });

  if (key()) load().then(showApp).catch(function () {});
})();
</script>
</body>
</html>
`;