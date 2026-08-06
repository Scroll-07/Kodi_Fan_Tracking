require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const twilio = require('twilio');
const { Resend } = require('resend');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Config ----
const PORT = process.env.PORT || 3000;
const EVENT_NAME = process.env.EVENT_NAME || 'Your Event';
const EVENT_SUBTITLE = process.env.EVENT_SUBTITLE || 'Private listening session';
const PASS_PREFIX = process.env.PASS_PREFIX || 'CR';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'changeme';

// SMS (Twilio) and Email (Resend) — both optional; features quietly no-op if unset
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Railway Volume should be mounted at /data (see railway.toml)
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'entries.json');

// ---- Storage: JSON file on Railway Volume, with a simple write queue ----
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

let writeQueue = Promise.resolve();
function appendEntry(entry) {
  writeQueue = writeQueue.then(() => {
    const entries = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    entries.push(entry);
    fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
    return entries;
  });
  return writeQueue;
}
function resetEntries() {
  writeQueue = writeQueue.then(() => {
    fs.writeFileSync(DATA_FILE, '[]');
    return [];
  });
  return writeQueue;
}
function getEntries() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// One row per person (deduped by email, last check-in wins for name/phone/location)
function uniquePeople(entries) {
  const map = new Map();
  entries.forEach(e => {
    map.set(e.email, { name: e.name, email: e.email, phone: e.phone, city: e.city, state: e.state, country: e.country });
  });
  return [...map.values()];
}

// ---- Basic Auth for /admin ----
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Auth required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Invalid credentials');
}

// ---- Messaging helpers ----
// Normalizes to E.164. Assumes US (+1) for bare 10-digit numbers — adjust if you expect international guests.
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

async function sendConfirmationSMS(phone, name) {
  if (!twilioClient || !phone) return;
  const to = normalizePhone(phone);
  if (!to) return;
  try {
    await twilioClient.messages.create({
      body: `You're checked in for ${EVENT_NAME}, ${name.split(' ')[0]}! We'll text the address as showtime gets closer.`,
      from: TWILIO_FROM_NUMBER,
      to
    });
  } catch (err) {
    console.error(`Confirmation SMS failed for ${to}:`, err.message);
  }
}

// ---- Routes ----
app.get('/', (req, res) => res.redirect('/checkin'));

function passId() {
  const n = getEntries().length + 1;
  return `${PASS_PREFIX} · ${String(n).padStart(6, '0')}`;
}

function credentialStyles() {
  return `
  :root{--stage:#0A0A0C;--stage-2:#131114;--cream:#F7F2E7;--gold:#C6A15B;--gold-bright:#DCB975;--ink:#17140F;--graphite:#6B6355;--line:rgba(198,161,91,0.35)}
  *{box-sizing:border-box}
  @media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
  body{margin:0;min-height:100vh;background:radial-gradient(ellipse 900px 700px at 50% 30%,rgba(198,161,91,.10),transparent 65%),radial-gradient(ellipse 1200px 900px at 50% 0%,var(--stage-2),var(--stage) 60%);font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;padding:48px 20px}
  .card{position:relative;width:100%;max-width:380px;background:var(--cream);border-radius:18px;padding:40px 32px 32px;box-shadow:0 40px 80px -20px rgba(0,0,0,.7),0 0 0 1px rgba(198,161,91,.4),0 0 60px -10px rgba(198,161,91,.15);animation:rise .7s cubic-bezier(.16,1,.3,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
  .clip{position:absolute;top:-14px;left:50%;transform:translateX(-50%);width:64px;height:28px;display:flex;align-items:center;justify-content:center}
  .clip::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,#3a3530,#17140F);border-radius:6px;box-shadow:0 4px 10px rgba(0,0,0,.5)}
  .clip .hole{position:relative;width:14px;height:14px;border-radius:50%;background:var(--stage);box-shadow:inset 0 2px 4px rgba(0,0,0,.8)}
  .eyebrow-row{display:flex;align-items:center;justify-content:space-between;margin-top:8px;margin-bottom:22px}
  .eyebrow{font-size:11px;font-weight:600;letter-spacing:.18em;color:var(--gold);text-transform:uppercase}
  .pass-id{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.05em;color:var(--graphite)}
  .hr{height:1px;background:linear-gradient(90deg,transparent,var(--line),transparent);margin-bottom:24px}
  .event-name{font-family:'Bodoni Moda',serif;font-weight:500;font-size:30px;line-height:1.08;color:var(--ink);letter-spacing:.01em;margin:0 0 6px}
  .event-sub{font-family:'Bodoni Moda',serif;font-style:italic;font-weight:500;font-size:14px;color:var(--graphite);margin:0 0 28px}
  form{display:flex;flex-direction:column;gap:18px}
  .field label{display:block;font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--graphite);margin-bottom:7px}
  .field input{width:100%;border:none;border-bottom:1.5px solid rgba(23,20,15,.18);background:transparent;padding:6px 2px 9px;font-family:'Inter',sans-serif;font-size:15px;font-weight:500;color:var(--ink);outline:none;transition:border-color .25s ease}
  .field input::placeholder{color:rgba(23,20,15,.28);font-weight:400}
  .field input:focus{border-bottom-color:var(--gold)}
  .field input:focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:2px}
  .optional-tag{font-weight:400;text-transform:none;letter-spacing:0;color:rgba(107,99,85,.7)}
  button.submit{margin-top:10px;border:none;border-radius:8px;padding:15px;background:linear-gradient(180deg,var(--gold-bright),var(--gold));color:#1A150C;font-family:'Inter',sans-serif;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease;box-shadow:0 8px 20px -8px rgba(198,161,91,.6);width:100%}
  button.submit:hover{transform:translateY(-1px);box-shadow:0 12px 24px -8px rgba(198,161,91,.75)}
  button.submit:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
  .barcode-wrap{margin-top:26px;padding-top:18px;border-top:1px dashed rgba(23,20,15,.18);display:flex;align-items:center;justify-content:space-between;gap:12px}
  .barcode{height:30px;flex:1;background:repeating-linear-gradient(90deg,var(--ink) 0px,var(--ink) 2px,transparent 2px,transparent 3px,var(--ink) 3px,var(--ink) 4px,transparent 4px,transparent 6px,var(--ink) 6px,var(--ink) 7px,transparent 7px,transparent 10px);opacity:.55;border-radius:2px}
  .status-tag{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--graphite);white-space:nowrap}
  .stamp{position:absolute;top:38%;right:-10px;transform:rotate(-14deg) scale(1);opacity:.88;border:2.5px solid #8B2E2E;color:#8B2E2E;padding:5px 10px;border-radius:6px;font-family:'Inter',sans-serif;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;background:rgba(255,255,255,.6);mix-blend-mode:multiply}
  .caption{text-align:center;margin-top:22px;font-size:11px;color:rgba(247,242,231,.35);letter-spacing:.04em}
  `;
}

app.get('/checkin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${EVENT_NAME} — Check-In</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,500;1,6..96,500&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${credentialStyles()}</style></head>
<body>
  <div>
    <div class="card">
      <div class="clip"><div class="hole"></div></div>
      <div class="eyebrow-row">
        <span class="eyebrow">All Access</span>
        <span class="pass-id">${passId()}</span>
      </div>
      <div class="hr"></div>
      <h1 class="event-name">${EVENT_NAME}</h1>
      <p class="event-sub">${EVENT_SUBTITLE}</p>
      <form method="POST" action="/checkin">
        <div class="field"><label for="name">Full name</label><input id="name" name="name" type="text" required></div>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required></div>
        <div class="field"><label for="phone">Phone <span class="optional-tag">(optional)</span></label><input id="phone" name="phone" type="tel"></div>
        <div class="field"><label for="city">City <span class="optional-tag">(optional)</span></label><input id="city" name="city" type="text"></div>
        <div class="field"><label for="state">State <span class="optional-tag">(optional)</span></label><input id="state" name="state" type="text"></div>
        <div class="field"><label for="country">Country <span class="optional-tag">(optional)</span></label><input id="country" name="country" type="text"></div>
        <button class="submit" type="submit">Check In</button>
      </form>
      <div class="barcode-wrap"><div class="barcode"></div><span class="status-tag">PENDING</span></div>
    </div>
    <p class="caption">${EVENT_NAME}</p>
  </div>
</body></html>`);
});

app.post('/checkin', async (req, res) => {
  const { name, email, phone, city, state, country } = req.body;
  if (!name || !email) return res.status(400).send('Name and email are required.');

  await appendEntry({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: (phone || '').trim(),
    city: (city || '').trim(),
    state: (state || '').trim(),
    country: (country || '').trim(),
    timestamp: new Date().toISOString()
  });

  sendConfirmationSMS(phone, name); // fire-and-forget — don't hold up the response for it

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checked In — ${EVENT_NAME}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,500;1,6..96,500&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${credentialStyles()}</style></head>
<body>
  <div>
    <div class="card">
      <div class="clip"><div class="hole"></div></div>
      <div class="eyebrow-row">
        <span class="eyebrow">All Access</span>
        <span class="pass-id">${passId()}</span>
      </div>
      <div class="hr"></div>
      <h1 class="event-name">${EVENT_NAME}</h1>
      <p class="event-sub">${EVENT_SUBTITLE}</p>
      <p style="font-family:'Inter',sans-serif;font-size:15px;color:var(--ink);margin:0 0 8px">Welcome, ${name.split(' ')[0]}.</p>
      <p style="font-family:'Inter',sans-serif;font-size:12px;color:var(--graphite);margin:0">You're checked in. Enjoy the night.</p>
      <div class="barcode-wrap"><div class="barcode" style="opacity:1;filter:sepia(1) saturate(3) hue-rotate(-10deg) brightness(.9)"></div><span class="status-tag" style="color:var(--gold);font-weight:500">VERIFIED</span></div>
      <div class="stamp">Verified</div>
    </div>
  </div>
</body></html>`);
});

// QR code pointing at the check-in URL
app.get('/qr', async (req, res) => {
  try {
    const url = `${PUBLIC_URL}/checkin`;
    const png = await QRCode.toBuffer(url, { width: 512, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).send('QR generation failed: ' + err.message);
  }
});

// Admin dashboard
app.get('/admin', requireAuth, (req, res) => {
  const entries = getEntries().slice().reverse();
  const uniqueEmails = new Set(entries.map(e => e.email)).size;
  const phoneCount = new Set(entries.filter(e => e.phone).map(e => normalizePhone(e.phone))).size;
  const people = uniquePeople(getEntries()); // chronological, so "last wins" reflects most recent info
  const rows = entries.map(e => {
    const location = [e.city, e.state, e.country].filter(Boolean).join(', ');
    return `<tr><td>${e.name}</td><td>${e.email}</td><td>${e.phone || ''}</td><td>${location}</td><td>${new Date(e.timestamp).toLocaleString()}</td></tr>`;
  }).join('');

  const peopleCheckboxes = people.map((p, i) => `
    <label class="recipient-row">
      <input type="checkbox" name="recipients" value="${p.email}" form="broadcastForm" checked>
      <span class="recipient-name">${p.name}</span>
      <span class="recipient-meta">${p.email}${p.phone ? ' · ' + p.phone : ''}${p.city ? ' · ' + p.city : ''}</span>
    </label>`).join('');

  const q = req.query;
  let banner = '';
  if (q.smsSent !== undefined) banner = `<div class="banner ok">SMS sent to ${q.smsSent} people${q.smsFailed > 0 ? `, ${q.smsFailed} failed` : ''}.</div>`;
  if (q.emailSent !== undefined) banner = `<div class="banner ok">Email sent to ${q.emailSent} people${q.emailFailed > 0 ? `, ${q.emailFailed} failed` : ''}.</div>`;
  if (q.smsError === 'not_configured') banner = `<div class="banner err">SMS isn't set up yet — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in Railway Variables.</div>`;
  if (q.emailError === 'not_configured') banner = `<div class="banner err">Email isn't set up yet — add RESEND_API_KEY in Railway Variables.</div>`;
  if (q.smsError === 'empty' || q.emailError === 'empty') banner = `<div class="banner err">Message can't be empty.</div>`;
  if (q.smsError === 'none_selected' || q.emailError === 'none_selected') banner = `<div class="banner err">No recipients selected — check at least one person below.</div>`;
  if (q.resetDone === '1') banner = `<div class="banner ok">All check-in data has been cleared.</div>`;
  if (q.resetError === 'badpass') banner = `<div class="banner err">Incorrect admin password — data was NOT deleted.</div>`;

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${EVENT_NAME} — Admin</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:30px auto;padding:0 20px;color:#1a1a1a}
  .stats{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap}
  .stat{background:#f5f5f5;border-radius:10px;padding:16px 20px}
  .stat .num{font-size:1.8rem;font-weight:700}
  .stat .label{color:#666;font-size:.85rem}
  table{width:100%;border-collapse:collapse;font-size:.9rem;margin-top:24px}
  th,td{text-align:left;padding:8px;border-bottom:1px solid #eee}
  a.btn{display:inline-block;margin-bottom:16px;padding:8px 14px;background:#111;color:#fff;border-radius:8px;text-decoration:none;font-size:.85rem}
  .banner{padding:12px 16px;border-radius:8px;margin-bottom:20px;font-size:.9rem}
  .banner.ok{background:#e8f7ee;color:#1a7a3f}
  .banner.err{background:#fdecec;color:#a3231b}
  .panel{background:#f9f9f7;border:1px solid #e5e3dc;border-radius:12px;padding:18px;margin-top:20px}
  .panel h3{margin:0 0 4px;font-size:.95rem}
  .panel p.hint{margin:0 0 12px;font-size:.78rem;color:#777}
  .panel input[type=text], .panel textarea{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-family:inherit;font-size:.88rem;margin-bottom:10px;box-sizing:border-box}
  .panel textarea{min-height:90px;resize:vertical}
  .recipients-box{max-height:220px;overflow-y:auto;border:1px solid #e3e1d9;border-radius:8px;background:#fff;padding:6px 10px;margin-bottom:14px}
  .recipient-row{display:flex;align-items:baseline;gap:8px;padding:7px 2px;border-bottom:1px solid #f2f1ec;font-size:.85rem;cursor:pointer}
  .recipient-row:last-child{border-bottom:none}
  .recipient-name{font-weight:600}
  .recipient-meta{color:#888;font-size:.78rem}
  .select-toggle{display:flex;gap:14px;margin-bottom:10px;font-size:.8rem}
  .select-toggle a{color:#555;text-decoration:underline;cursor:pointer}
  .btn-row{display:flex;gap:10px;flex-wrap:wrap}
  .btn-row button{flex:1;min-width:160px;padding:11px;border:none;border-radius:8px;background:#111;color:#fff;font-weight:600;font-size:.85rem;cursor:pointer}
  .btn-row button:hover{opacity:.9}
  .danger{background:#fdf3f2;border:1px solid #f3c9c5;border-radius:12px;padding:18px;margin-top:28px}
  .danger h3{margin:0 0 4px;font-size:.95rem;color:#a3231b}
  .danger p.hint{margin:0 0 12px;font-size:.78rem;color:#8a4f4a}
  .danger form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .danger input{padding:10px;border:1px solid #e3b3ae;border-radius:8px;font-size:.85rem;flex:1;min-width:180px}
  .danger button{padding:11px 18px;border:none;border-radius:8px;background:#a3231b;color:#fff;font-weight:600;font-size:.85rem;cursor:pointer}
  .danger button:hover{opacity:.9}
</style></head>
<body>
  <h1>${EVENT_NAME} — Check-Ins</h1>
  ${banner}
  <div class="stats">
    <div class="stat"><div class="num">${entries.length}</div><div class="label">Total check-ins</div></div>
    <div class="stat"><div class="num">${uniqueEmails}</div><div class="label">Unique people</div></div>
    <div class="stat"><div class="num">${phoneCount}</div><div class="label">Phone numbers on file</div></div>
  </div>
  <a class="btn" href="/admin/export.csv">Download CSV</a>

  <div class="panel">
    <h3>Message recipients</h3>
    <p class="hint">Check who should get this message — everyone's checked by default. Uncheck to exclude, or uncheck all then pick just one for a single-person test.</p>
    <div class="select-toggle">
      <a onclick="document.querySelectorAll('.recipient-row input').forEach(c=>c.checked=true)">Select all</a>
      <a onclick="document.querySelectorAll('.recipient-row input').forEach(c=>c.checked=false)">Select none</a>
    </div>
    <div class="recipients-box">
      ${peopleCheckboxes || '<p style="color:#999;font-size:.85rem">No check-ins yet.</p>'}
    </div>

    <form id="broadcastForm" method="POST">
      <input type="text" name="subject" placeholder="Email subject (ignored for SMS) — e.g. Tonight's location">
      <textarea name="message" placeholder="Message body — used for both SMS and email" required></textarea>
      <div class="btn-row">
        <button type="submit" formaction="/admin/broadcast/sms">Send SMS to Selected</button>
        <button type="submit" formaction="/admin/broadcast/email">Send Email to Selected</button>
      </div>
    </form>
  </div>

  <div class="danger">
    <h3>Clear all check-in data</h3>
    <p class="hint">Permanently deletes every check-in (including test entries). Cannot be undone. Requires your admin password to confirm.</p>
    <form method="POST" action="/admin/reset" onsubmit="return confirm('This will permanently delete all ${entries.length} check-in entries. Are you sure?');">
      <input type="password" name="confirmPassword" placeholder="Admin password" required>
      <button type="submit">Clear All Data</button>
    </form>
  </div>

  <table>
    <tr><th>Name</th><th>Email</th><th>Phone</th><th>Location</th><th>Time</th></tr>
    ${rows}
  </table>
</body></html>`);
});

app.post('/admin/broadcast/sms', requireAuth, async (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) return res.redirect('/admin?smsError=empty');
  if (!twilioClient) return res.redirect('/admin?smsError=not_configured');

  let selected = req.body.recipients || [];
  if (!Array.isArray(selected)) selected = [selected];
  if (selected.length === 0) return res.redirect('/admin?smsError=none_selected');

  const people = uniquePeople(getEntries());
  const phoneByEmail = new Map(people.map(p => [p.email, p.phone]));
  const recipients = [...new Set(
    selected.map(email => normalizePhone(phoneByEmail.get(email))).filter(Boolean)
  )];

  let sent = 0, failed = 0;
  for (const to of recipients) {
    try {
      await twilioClient.messages.create({ body: message, from: TWILIO_FROM_NUMBER, to });
      sent++;
    } catch (err) {
      failed++;
      console.error('Broadcast SMS failed for', to, err.message);
    }
  }
  res.redirect(`/admin?smsSent=${sent}&smsFailed=${failed}`);
});

app.post('/admin/broadcast/email', requireAuth, async (req, res) => {
  const message = (req.body.message || '').trim();
  const subject = (req.body.subject || `${EVENT_NAME} — Update`).trim();
  if (!message) return res.redirect('/admin?emailError=empty');
  if (!resend) return res.redirect('/admin?emailError=not_configured');

  let selected = req.body.recipients || [];
  if (!Array.isArray(selected)) selected = [selected];
  if (selected.length === 0) return res.redirect('/admin?emailError=none_selected');

  const recipients = [...new Set(selected)];

  let sent = 0, failed = 0;
  for (const to of recipients) {
    try {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to,
        subject,
        html: `<p>${message.replace(/\n/g, '<br>')}</p>`
      });
      sent++;
    } catch (err) {
      failed++;
      console.error('Broadcast email failed for', to, err.message);
    }
  }
  res.redirect(`/admin?emailSent=${sent}&emailFailed=${failed}`);
});

app.get('/admin/export.csv', requireAuth, (req, res) => {
  const entries = getEntries();
  const header = 'name,email,phone,city,state,country,timestamp\n';
  const rows = entries.map(e =>
    [e.name, e.email, e.phone, e.city, e.state, e.country, e.timestamp]
      .map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="checkins.csv"');
  res.send(header + rows);
});

app.post('/admin/reset', requireAuth, async (req, res) => {
  const confirmPassword = req.body.confirmPassword || '';
  if (confirmPassword !== ADMIN_PASS) {
    return res.redirect('/admin?resetError=badpass');
  }
  await resetEntries();
  res.redirect('/admin?resetDone=1');
});

app.listen(PORT, () => console.log(`Event check-in app running on port ${PORT}`));