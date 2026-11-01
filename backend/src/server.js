require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('./db');

const PORT = parseInt(process.env.PORT || '4000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DEV_OTP = String(process.env.DEV_OTP || 'true') === 'true';
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);
const DINING_MS = parseInt(process.env.DINING_MINUTES || '90', 10) * 60000;
const GRACE_MS = parseInt(process.env.GRACE_MINUTES || '15', 10) * 60000;
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || 'My Restaurant';
const GST_RATE = 0.05;
const MIN = 60000;

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

/* ---------------- helpers ---------------- */
const now = () => Date.now();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
function randCode(len, alphabet) {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const hash = s => crypto.createHash('sha256').update(String(s) + JWT_SECRET).digest('hex');
const round2 = n => Math.round(n * 100) / 100;

async function sendSms(phone, text) {
  console.log(`\n[SMS -> +91${phone}] ${text}\n`);
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) return;
  try {
    const to = (process.env.DEFAULT_COUNTRY_CODE || '+91') + phone;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: text }),
    });
  } catch (e) { console.error('SMS failed', e.message); }
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return bad(res, 'Login required', 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.id);
    if (!u) return bad(res, 'User not found', 401);
    req.user = u;
    next();
  } catch { return bad(res, 'Session expired, login again', 401); }
}
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : bad(res, 'Admin access only', 403);

/* ---------------- table availability + waitlist ---------------- */
const ACTIVE = "('confirmed','arrived')";

function tableFreeAt(tableId, start, end, ignoreBookingId = 0) {
  const r = db.prepare(`SELECT 1 FROM bookings WHERE table_id = ? AND status IN ${ACTIVE}
    AND start_ts < ? AND end_ts > ? AND id != ? LIMIT 1`).get(tableId, end, start, ignoreBookingId);
  return !r;
}
function findTable(start, end, party, ignoreId = 0) {
  const ts = db.prepare('SELECT * FROM tables_ WHERE seats >= ? ORDER BY seats, number').all(party);
  return ts.find(t => tableFreeAt(t.id, start, end, ignoreId)) || null;
}
function countFree(start, end, party) {
  const ts = db.prepare('SELECT * FROM tables_ WHERE seats >= ?').all(party);
  return ts.filter(t => tableFreeAt(t.id, start, end)).length;
}
// Earliest time >= start at which some suitable table is free for a full dining slot
function earliestFree(start, party) {
  const ts = db.prepare('SELECT * FROM tables_ WHERE seats >= ?').all(party);
  let best = null;
  for (const t of ts) {
    const cands = [start, ...db.prepare(`SELECT end_ts FROM bookings WHERE table_id = ? AND status IN ${ACTIVE}
      AND end_ts > ? ORDER BY end_ts`).all(t.id, start).map(r => r.end_ts)];
    for (const c of cands) {
      if (tableFreeAt(t.id, c, c + DINING_MS)) { if (best === null || c < best) best = c; break; }
    }
  }
  return best;
}
function waitInfo(b) {
  const base = Math.max(b.start_ts, now());
  const t = earliestFree(base, b.party_size);
  const queue = db.prepare(`SELECT id FROM bookings WHERE status = 'waiting' ORDER BY created_at, id`).all();
  const pos = queue.findIndex(q => q.id === b.id) + 1;
  // people ahead also need tables, so add a rough share of dining time for each one beyond the table count
  const nTables = db.prepare('SELECT COUNT(*) c FROM tables_ WHERE seats >= ?').get(b.party_size).c || 1;
  const extraRounds = pos > 0 ? Math.floor((pos - 1) / nTables) : 0;
  const ts = (t === null ? base : t) + extraRounds * DINING_MS;
  return { wait_minutes: Math.max(0, Math.ceil((ts - now()) / MIN)), expected_ts: ts, position: pos || null };
}

function promoteWaiting() {
  const list = db.prepare(`SELECT b.*, u.phone FROM bookings b JOIN users u ON u.id = b.user_id
    WHERE b.status = 'waiting' ORDER BY b.created_at, b.id`).all();
  for (const w of list) {
    if (now() - w.created_at > 3 * 3600 * 1000 && w.start_ts < now()) {
      db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(w.id);
      continue;
    }
    const s = Math.max(w.start_ts, now()), e = s + DINING_MS;
    const t = findTable(s, e, w.party_size, w.id);
    if (t) {
      db.prepare("UPDATE bookings SET status='confirmed', table_id=?, start_ts=?, end_ts=? WHERE id=?").run(t.id, s, e, w.id);
      sendSms(w.phone, `${RESTAURANT_NAME}: Your table #${t.number} is confirmed (${w.party_size} guests). Please show the QR in the app when you arrive.`);
    }
  }
}
function sweepNoShows() {
  const rows = db.prepare(`SELECT id FROM bookings WHERE status='confirmed' AND start_ts + ? < ?`).all(GRACE_MS, now());
  rows.forEach(r => db.prepare("UPDATE bookings SET status='no_show' WHERE id=?").run(r.id));
  // arrived bookings that exceeded 4 hours are closed automatically
  db.prepare("UPDATE bookings SET status='completed' WHERE status='arrived' AND start_ts + ? < ?").run(4 * 3600 * 1000, now());
  promoteWaiting();
}
setInterval(sweepNoShows, 30 * 1000);

function bookingView(b) {
  const t = b.table_id ? db.prepare('SELECT number, seats FROM tables_ WHERE id=?').get(b.table_id) : null;
  const v = { id: b.id, status: b.status, party_size: b.party_size, start_ts: b.start_ts, end_ts: b.end_ts,
    table_number: t ? t.number : null, table_seats: t ? t.seats : null };
  if (b.status === 'waiting') Object.assign(v, waitInfo(b));
  return v;
}

function createBooking(user, party, start) {
  const maxSeats = db.prepare('SELECT MAX(seats) m FROM tables_').get().m;
  if (!Number.isInteger(party) || party < 1) return { error: 'Enter a valid number of guests' };
  if (party > maxSeats) return { error: `A table seats at most ${maxSeats} people` };
  if (!Number.isFinite(start)) return { error: 'Choose a valid time' };
  if (start < now() - 5 * MIN) return { error: 'That time has already passed' };
  if (start > now() + 30 * 24 * 3600 * 1000) return { error: 'You can book up to 30 days ahead' };
  const dup = db.prepare(`SELECT 1 FROM bookings WHERE user_id=? AND status IN ('confirmed','waiting','arrived')
    AND start_ts < ? AND end_ts > ?`).get(user.id, start + DINING_MS, start);
  if (dup) return { error: 'You already have a booking at this time' };
  const end = start + DINING_MS;
  const token = randCode(16, ALNUM);
  const t = findTable(start, end, party);
  const info = db.prepare(`INSERT INTO bookings (user_id, table_id, party_size, start_ts, end_ts, status, qr_token, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(user.id, t ? t.id : null, party, start, end, t ? 'confirmed' : 'waiting', token, now());
  return { booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(info.lastInsertRowid) };
}

/* ---------------- auth ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, restaurant: RESTAURANT_NAME }));

app.get('/api/config', (req, res) => {
  const t = db.prepare('SELECT COUNT(*) n, MAX(seats) seats FROM tables_').get();
  res.json({ restaurant: RESTAURANT_NAME, tables: t.n, seats_per_table: t.seats,
    dining_minutes: DINING_MS / MIN, grace_minutes: GRACE_MS / MIN, gst_percent: GST_RATE * 100 });
});

app.post('/api/auth/send-otp', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return bad(res, 'Enter a valid 10-digit mobile number');
  const row = db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
  if (row && now() - row.last_sent_at < 30000) return bad(res, 'Please try again after 30 seconds', 429);
  const code = randCode(6, '0123456789');
  db.prepare(`INSERT INTO otps (phone, code, expires_at, attempts, last_sent_at) VALUES (?,?,?,0,?)
    ON CONFLICT(phone) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, attempts=0, last_sent_at=excluded.last_sent_at`)
    .run(phone, hash(code), now() + 5 * MIN, now());
  await sendSms(phone, `${RESTAURANT_NAME}: Your OTP is ${code}. It expires in 5 minutes.`);
  res.json({ ok: true, ...(DEV_OTP ? { devOtp: code } : {}) });
}));

app.post('/api/auth/verify-otp', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (!phone || !code) return bad(res, 'Enter your phone number and OTP');
  const row = db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
  if (!row) return bad(res, 'Request an OTP first');
  if (row.expires_at < now()) return bad(res, 'OTP expired, please request a new one');
  if (row.attempts >= 5) return bad(res, 'Too many wrong attempts, please request a new OTP', 429);
  if (row.code !== hash(code)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone=?').run(phone);
    return bad(res, 'Wrong OTP');
  }
  db.prepare('DELETE FROM otps WHERE phone=?').run(phone);
  const role = ADMIN_PHONES.includes(phone) ? 'admin' : 'customer';
  let u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!u) {
    const i = db.prepare('INSERT INTO users (phone, name, role, created_at) VALUES (?,?,?,?)').run(phone, name || null, role, now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(i.lastInsertRowid);
  } else {
    db.prepare('UPDATE users SET role=?, name=COALESCE(NULLIF(?,\'\'), name) WHERE id=?').run(role, name, u.id);
    u = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  }
  const token = jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: u.id, phone: u.phone, name: u.name, role: u.role } });
}));

app.get('/api/me', auth, (req, res) => {
  const u = req.user; res.json({ id: u.id, phone: u.phone, name: u.name, role: u.role });
});
app.patch('/api/me', auth, (req, res) => {
  db.prepare('UPDATE users SET name=? WHERE id=?').run(String(req.body.name || '').trim().slice(0, 60), req.user.id);
  res.json({ ok: true });
});

/* ---------------- menu ---------------- */
app.get('/api/menu', (req, res) => {
  res.json(db.prepare('SELECT * FROM menu_items WHERE available=1 ORDER BY category, name').all());
});

/* ---------------- availability + bookings (customer) ---------------- */
app.get('/api/availability', (req, res) => {
  const start = parseInt(req.query.start, 10) || now();
  const party = parseInt(req.query.party, 10) || 1;
  const maxSeats = db.prepare('SELECT MAX(seats) m FROM tables_').get().m;
  if (party > maxSeats) return bad(res, `Maximum ${maxSeats} seats per table`);
  const total = db.prepare('SELECT COUNT(*) c FROM tables_ WHERE seats >= ?').get(party).c;
  const free = countFree(start, start + DINING_MS, party);
  const out = { total_tables: total, free_tables: free, available: free > 0 };
  if (free === 0) {
    const t = earliestFree(Math.max(start, now()), party);
    const queueLen = db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='waiting'").get().c;
    const extra = Math.floor(queueLen / (total || 1)) * DINING_MS;
    const exp = (t === null ? start : t) + extra;
    out.wait_minutes = Math.max(0, Math.ceil((exp - now()) / MIN));
    out.expected_ts = exp;
    out.waiting_ahead = queueLen;
  }
  res.json(out);
});

app.post('/api/bookings', auth, (req, res) => {
  const r = createBooking(req.user, parseInt(req.body.party_size, 10), parseInt(req.body.start_ts, 10));
  if (r.error) return bad(res, r.error);
  const b = r.booking;
  sendSms(req.user.phone, b.status === 'confirmed'
    ? `${RESTAURANT_NAME}: Table booking confirmed. Table #${bookingView(b).table_number}, ${b.party_size} guests, ${new Date(b.start_ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Please show the QR in the app when you arrive.`
    : `${RESTAURANT_NAME}: All tables are full right now. You are on the waiting list; we will SMS you when a table is ready.`);
  res.json(bookingView(b));
});

app.get('/api/bookings/mine', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings WHERE user_id=? ORDER BY start_ts DESC LIMIT 30').all(req.user.id);
  res.json(rows.map(bookingView));
});

app.get('/api/bookings/:id/qr', auth, wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!b) return bad(res, 'Booking not found', 404);
  if (!['confirmed', 'arrived'].includes(b.status)) return bad(res, 'A QR code is only available for confirmed bookings');
  const qr = await QRCode.toDataURL('RB:' + b.qr_token, { width: 360, margin: 2 });
  res.json({ qr, code: b.qr_token });
}));

app.post('/api/bookings/:id/cancel', auth, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!b) return bad(res, 'Booking not found', 404);
  if (!['confirmed', 'waiting'].includes(b.status)) return bad(res, 'This booking cannot be cancelled');
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id);
  promoteWaiting();
  res.json({ ok: true });
});

/* ---------------- orders (customer) ---------------- */
function newOrderCode() {
  for (let i = 0; i < 10; i++) {
    const c = 'ORD-' + randCode(6, ALNUM);
    if (!db.prepare('SELECT 1 FROM orders WHERE order_code=?').get(c)) return c;
  }
  throw new Error('Could not generate order id');
}
function orderView(o) {
  const items = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id=?').all(o.id);
  const t = o.booking_id ? db.prepare(`SELECT t.number FROM bookings b JOIN tables_ t ON t.id=b.table_id WHERE b.id=?`).get(o.booking_id) : null;
  return { id: o.id, order_code: o.order_code, status: o.status, total: o.total, created_at: o.created_at,
    booking_id: o.booking_id, table_number: t ? t.number : null, items };
}

app.post('/api/orders', auth, (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return bad(res, 'Your cart is empty');
  let booking = null;
  if (req.body.booking_id) {
    booking = db.prepare("SELECT * FROM bookings WHERE id=? AND user_id=? AND status IN ('confirmed','arrived')").get(req.body.booking_id, req.user.id);
    if (!booking) return bad(res, 'Booking is not valid');
  } else {
    booking = db.prepare("SELECT * FROM bookings WHERE user_id=? AND status='arrived' ORDER BY start_ts DESC").get(req.user.id) || null;
  }
  const lines = [];
  for (const it of items) {
    const qty = parseInt(it.qty, 10);
    const m = db.prepare('SELECT * FROM menu_items WHERE id=? AND available=1').get(it.id);
    if (!m || !(qty >= 1 && qty <= 50)) return bad(res, 'Invalid menu item or quantity');
    lines.push({ m, qty });
  }
  const total = round2(lines.reduce((s, l) => s + l.m.price * l.qty, 0));
  const tx = db.transaction(() => {
    const o = db.prepare('INSERT INTO orders (order_code, user_id, booking_id, total, created_at) VALUES (?,?,?,?,?)')
      .run(newOrderCode(), req.user.id, booking ? booking.id : null, total, now());
    const ins = db.prepare('INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?,?,?,?,?)');
    lines.forEach(l => ins.run(o.lastInsertRowid, l.m.id, l.m.name, l.m.price, l.qty));
    return o.lastInsertRowid;
  });
  const id = tx();
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  sendSms(req.user.phone, `${RESTAURANT_NAME}: Order received. Order ID ${o.order_code}, total Rs ${total}.`);
  res.json(orderView(o));
});

app.get('/api/orders/mine', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json(rows.map(orderView));
});

/* ---------------- bills ---------------- */
function billView(b) {
  const orders = db.prepare(`SELECT o.id, o.order_code, o.total FROM bill_orders bo JOIN orders o ON o.id=bo.order_id WHERE bo.bill_id=?`).all(b.id);
  const items = db.prepare(`SELECT oi.name, oi.price, SUM(oi.qty) qty FROM bill_orders bo JOIN order_items oi ON oi.order_id=bo.order_id
    WHERE bo.bill_id=? GROUP BY oi.name, oi.price`).all(b.id);
  return { id: b.id, bill_no: b.bill_no, subtotal: b.subtotal, gst: b.gst, total: b.total, status: b.status,
    method: b.method, created_at: b.created_at, paid_at: b.paid_at, orders, items, restaurant: RESTAURANT_NAME };
}
function closeIfAllPaid(bookingId) {
  if (!bookingId) return;
  const unpaidBills = db.prepare("SELECT COUNT(*) c FROM bills WHERE booking_id=? AND status != 'paid'").get(bookingId).c;
  const unbilled = db.prepare(`SELECT COUNT(*) c FROM orders WHERE booking_id=? AND status != 'cancelled'
    AND id NOT IN (SELECT order_id FROM bill_orders)`).get(bookingId).c;
  if (!unpaidBills && !unbilled) {
    db.prepare("UPDATE bookings SET status='completed', end_ts=MIN(end_ts, ?) WHERE id=? AND status='arrived'").run(now(), bookingId);
    promoteWaiting();
  }
}
function markPaid(bill, method, ref) {
  db.prepare("UPDATE bills SET status='paid', method=?, txn_ref=?, paid_at=? WHERE id=?").run(method, ref || null, now(), bill.id);
  db.prepare(`UPDATE orders SET status='completed' WHERE status != 'cancelled' AND id IN (SELECT order_id FROM bill_orders WHERE bill_id=?)`).run(bill.id);
  closeIfAllPaid(bill.booking_id);
  const u = db.prepare('SELECT phone FROM users WHERE id=?').get(bill.user_id);
  sendSms(u.phone, `${RESTAURANT_NAME}: Payment of Rs ${bill.total} received (Bill ${bill.bill_no}). Thank you, see you again!`);
}

app.get('/api/bills/mine', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM bills WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.user.id).map(billView));
});

// Customer chooses how to pay.
// online  -> demo payment (replace the marked block with Razorpay / UPI gateway verification for real money)
// offline -> customer will pay cash/card at the counter, admin marks it paid
app.post('/api/bills/:id/pay', auth, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!bill) return bad(res, 'Bill not found', 404);
  if (bill.status === 'paid') return bad(res, 'Bill is already paid');
  const method = req.body.method;
  if (method === 'offline') {
    db.prepare("UPDATE bills SET status='pay_at_counter', method='offline' WHERE id=?").run(bill.id);
    return res.json(billView(db.prepare('SELECT * FROM bills WHERE id=?').get(bill.id)));
  }
  if (method === 'online') {
    // ===== PAYMENT GATEWAY HOOK =====
    // Real app: create gateway order here, verify the signature in a webhook, then call markPaid().
    // Demo mode below simply treats the payment as successful.
    markPaid(bill, 'online', 'DEMO-' + randCode(10, ALNUM));
    return res.json(billView(db.prepare('SELECT * FROM bills WHERE id=?').get(bill.id)));
  }
  bad(res, 'Choose online or offline payment');
});

/* ---------------- admin ---------------- */
const admin = express.Router();
admin.use(auth, adminOnly);

admin.get('/overview', (req, res) => {
  const t0 = now();
  const tables = db.prepare('SELECT * FROM tables_ ORDER BY number').all().map(t => {
    const cur = db.prepare(`SELECT b.*, u.name, u.phone FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.table_id=? AND b.status IN ${ACTIVE}
      AND b.start_ts <= ? AND b.end_ts > ? ORDER BY b.start_ts LIMIT 1`).get(t.id, t0 + 30 * MIN, t0);
    const next = db.prepare(`SELECT start_ts FROM bookings WHERE table_id=? AND status='confirmed' AND start_ts > ? ORDER BY start_ts LIMIT 1`).get(t.id, t0);
    let state = 'free';
    if (cur) state = cur.status === 'arrived' ? 'occupied' : 'reserved';
    return { id: t.id, number: t.number, seats: t.seats, state,
      booking: cur ? { id: cur.id, name: cur.name, phone: cur.phone, party_size: cur.party_size, start_ts: cur.start_ts, end_ts: cur.end_ts, status: cur.status } : null,
      next_booking_ts: next ? next.start_ts : null };
  });
  const waiting = db.prepare(`SELECT b.*, u.name, u.phone FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.status='waiting' ORDER BY b.created_at`).all()
    .map(b => ({ id: b.id, name: b.name, phone: b.phone, party_size: b.party_size, start_ts: b.start_ts, ...waitInfo(b) }));
  const count = q => db.prepare(q).get().c;
  res.json({
    tables, waiting,
    stats: {
      free: tables.filter(t => t.state === 'free').length,
      reserved: tables.filter(t => t.state === 'reserved').length,
      occupied: tables.filter(t => t.state === 'occupied').length,
      open_orders: count("SELECT COUNT(*) c FROM orders WHERE status IN ('placed','preparing','served')"),
      unpaid_bills: count("SELECT COUNT(*) c FROM bills WHERE status != 'paid'"),
    },
  });
});

admin.get('/orders', (req, res) => {
  const st = req.query.status;
  const rows = st
    ? db.prepare(`SELECT o.*, u.name cname, u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status=? ORDER BY o.created_at DESC LIMIT 200`).all(st)
    : db.prepare(`SELECT o.*, u.name cname, u.phone FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200`).all();
  res.json(rows.map(o => ({ ...orderView(o), customer: o.cname, phone: o.phone, user_id: o.user_id })));
});

admin.patch('/orders/:id', (req, res) => {
  const st = req.body.status;
  if (!['placed', 'preparing', 'served', 'completed', 'cancelled'].includes(st)) return bad(res, 'Invalid status');
  const r = db.prepare('UPDATE orders SET status=? WHERE id=?').run(st, req.params.id);
  if (!r.changes) return bad(res, 'Order not found', 404);
  res.json({ ok: true });
});

admin.get('/bookings', (req, res) => {
  const day = req.query.date; // YYYY-MM-DD (IST)
  let rows;
  if (day) {
    const s = new Date(day + 'T00:00:00+05:30').getTime();
    rows = db.prepare(`SELECT b.*, u.name, u.phone FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.start_ts >= ? AND b.start_ts < ? ORDER BY b.start_ts`).all(s, s + 86400000);
  } else {
    rows = db.prepare(`SELECT b.*, u.name, u.phone FROM bookings b JOIN users u ON u.id=b.user_id ORDER BY b.start_ts DESC LIMIT 200`).all();
  }
  res.json(rows.map(b => ({ ...bookingView(b), name: b.name, phone: b.phone })));
});

admin.post('/bookings', (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return bad(res, "Enter the customer's valid mobile number");
  let u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if (!u) {
    const i = db.prepare("INSERT INTO users (phone, name, role, created_at) VALUES (?,?,'customer',?)").run(phone, String(req.body.name || '').slice(0, 60) || null, now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(i.lastInsertRowid);
  }
  const r = createBooking(u, parseInt(req.body.party_size, 10), parseInt(req.body.start_ts, 10) || now());
  if (r.error) return bad(res, r.error);
  res.json(bookingView(r.booking));
});

admin.post('/bookings/:id/cancel', (req, res) => {
  const r = db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND status IN ('confirmed','waiting','arrived')").run(req.params.id);
  if (!r.changes) return bad(res, 'Could not cancel the booking');
  promoteWaiting();
  res.json({ ok: true });
});

// Customer shows the QR at the hotel, staff scans it (camera) or types the code.
admin.post('/scan', (req, res) => {
  const token = String(req.body.token || '').trim().replace(/^RB:/i, '').toUpperCase();
  const b = db.prepare(`SELECT b.*, u.name, u.phone FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.qr_token=?`).get(token);
  if (!b) return res.json({ valid: false, message: 'Invalid QR code: no booking found' });
  const base = { name: b.name, phone: b.phone, party_size: b.party_size, start_ts: b.start_ts, booking_id: b.id };
  const t = b.table_id ? db.prepare('SELECT number FROM tables_ WHERE id=?').get(b.table_id) : null;
  base.table_number = t ? t.number : null;
  if (b.status === 'arrived') return res.json({ valid: true, already: true, message: 'This customer has already checked in', ...base });
  if (b.status !== 'confirmed') return res.json({ valid: false, message: `Booking status: ${b.status}`, ...base });
  const early = b.start_ts - now() > 60 * MIN;
  if (early && !req.body.force) return res.json({ valid: false, early: true, message: 'The customer arrived more than 1 hour before the booking time. Check in anyway?', ...base });
  db.prepare("UPDATE bookings SET status='arrived' WHERE id=?").run(b.id);
  res.json({ valid: true, message: 'Checked in. Please seat the customer at their table.', ...base });
});

admin.get('/menu', (req, res) => res.json(db.prepare('SELECT * FROM menu_items ORDER BY category, name').all()));
admin.post('/menu', (req, res) => {
  const { name, category, price, description, veg } = req.body;
  if (!name || !category || !(Number(price) > 0)) return bad(res, 'Name, category and price are required');
  const i = db.prepare('INSERT INTO menu_items (name, category, price, description, veg) VALUES (?,?,?,?,?)')
    .run(String(name).slice(0, 80), String(category).slice(0, 40), Number(price), String(description || '').slice(0, 200), veg === false || veg === 0 ? 0 : 1);
  res.json(db.prepare('SELECT * FROM menu_items WHERE id=?').get(i.lastInsertRowid));
});
admin.patch('/menu/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM menu_items WHERE id=?').get(req.params.id);
  if (!m) return bad(res, 'Item not found', 404);
  const price = req.body.price !== undefined ? Number(req.body.price) : m.price;
  const avail = req.body.available !== undefined ? (req.body.available ? 1 : 0) : m.available;
  if (!(price > 0)) return bad(res, 'Invalid price');
  db.prepare('UPDATE menu_items SET price=?, available=? WHERE id=?').run(price, avail, m.id);
  res.json({ ok: true });
});

admin.get('/bills', (req, res) => {
  const rows = db.prepare(`SELECT b.*, u.name cname, u.phone FROM bills b JOIN users u ON u.id=b.user_id ORDER BY b.created_at DESC LIMIT 100`).all();
  res.json(rows.map(b => ({ ...billView(b), customer: b.cname, phone: b.phone })));
});

// Generate the bill for a customer's unbilled orders and send it to their phone.
admin.post('/bills', (req, res) => {
  const userId = parseInt(req.body.user_id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) return bad(res, 'Customer not found', 404);
  const orders = db.prepare(`SELECT * FROM orders WHERE user_id=? AND status != 'cancelled'
    AND id NOT IN (SELECT order_id FROM bill_orders) ORDER BY created_at`).all(userId);
  if (!orders.length) return bad(res, 'This customer has no unbilled orders');
  const subtotal = round2(orders.reduce((s, o) => s + o.total, 0));
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);
  const bookingId = (orders.find(o => o.booking_id) || {}).booking_id || null;
  const billNo = 'BILL-' + randCode(6, ALNUM);
  const tx = db.transaction(() => {
    const i = db.prepare('INSERT INTO bills (bill_no, user_id, booking_id, subtotal, gst, total, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(billNo, userId, bookingId, subtotal, gst, total, now());
    orders.forEach(o => db.prepare('INSERT INTO bill_orders (bill_id, order_id) VALUES (?,?)').run(i.lastInsertRowid, o.id));
    db.prepare("UPDATE orders SET status='served' WHERE status IN ('placed','preparing') AND id IN (" + orders.map(() => '?').join(',') + ')').run(...orders.map(o => o.id));
    return i.lastInsertRowid;
  });
  const id = tx();
  sendSms(u.phone, `${RESTAURANT_NAME}: Your bill ${billNo} is Rs ${total} (incl. ${GST_RATE * 100}% GST). Open "Bills" in the app to pay online, or pay at the counter.`);
  res.json(billView(db.prepare('SELECT * FROM bills WHERE id=?').get(id)));
});

admin.post('/bills/:id/mark-paid', (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.id);
  if (!bill) return bad(res, 'Bill not found', 404);
  if (bill.status === 'paid') return bad(res, 'Bill is already paid');
  markPaid(bill, req.body.method === 'online' ? 'online' : 'offline', null);
  res.json({ ok: true });
});

app.use('/api/admin', admin);

app.use('/api', (req, res) => bad(res, 'Route not found', 404));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error, please try again' }); });

if (require.main === module) {
  sweepNoShows();
  app.listen(PORT, () => {
    console.log(`\n${RESTAURANT_NAME} backend running: http://localhost:${PORT}`);
    console.log(`Admin phones: ${ADMIN_PHONES.join(', ') || '(none set - edit ADMIN_PHONES in .env)'}`);
    console.log(`OTP mode: ${DEV_OTP ? 'DEV (OTP is printed here)' : 'SMS'}\n`);
  });
}
module.exports = app;
