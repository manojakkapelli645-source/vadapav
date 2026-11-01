// Customer app: login (phone OTP), table booking, menu + order, QR, bills
const api = makeApi('rb_token');
const app = $('#app');
let cfg = { restaurant: 'Restaurant', tables: 12, seats_per_table: 12 };
let me = null, tab = 'book', menu = [], cart = {}, timer = null;

async function start() {
  try { cfg = await api.call('/api/config'); } catch (e) { /* shown on login */ }
  document.title = cfg.restaurant;
  if (api.token()) {
    try { me = await api.call('/api/me'); return shell(); } catch { api.clear(); }
  }
  renderLogin(app, { title: cfg.restaurant, subtitle: 'Log in with your mobile number to book a table and order food', api, askName: true,
    onDone: u => { me = u; shell(); } });
}

function shell() {
  app.innerHTML = `
  <header><h1>🍽 ${esc(cfg.restaurant)}</h1>
    <div class="who"><span>${esc(me.name || '+91 ' + me.phone)}</span><button id="logout">Logout</button></div></header>
  <nav class="tabs" id="tabs">
    <button data-t="book">Book a Table</button><button data-t="menu">Menu & Order</button>
    <button data-t="my">My Bookings / QR</button><button data-t="orders">My Orders</button><button data-t="bills">Bills & Payment</button>
  </nav>
  <main id="view"></main><div id="cartbar"></div>`;
  $('#logout').onclick = () => { api.clear(); location.reload(); };
  $('#tabs').onclick = e => { const t = e.target.dataset.t; if (t) go(t); };
  go(tab);
}

function go(t) {
  tab = t; clearInterval(timer);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $('#cartbar').innerHTML = ''; view().onclick = null;
  ({ book: viewBook, menu: viewMenu, my: viewMy, orders: viewOrders, bills: viewBills })[t]();
}
const view = () => $('#view');
const errBox = e => `<div class="msg err">${esc(e.message)}</div>`;

/* ---------- Book table ---------- */
function localDT(ts) { const d = new Date(ts - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }

function viewBook() {
  const soon = Date.now() + 30 * 60000;
  view().innerHTML = `
  <div class="card"><h3>Book a table</h3>
    <p class="muted">We have ${cfg.tables} tables with ${cfg.seats_per_table} seats each. A booking holds the table for ${cfg.dining_minutes || 90} minutes.</p>
    <label>How many guests? (1 - ${cfg.seats_per_table})</label>
    <input id="party" type="number" min="1" max="${cfg.seats_per_table}" value="2">
    <label>When will you arrive?</label>
    <input id="start" type="datetime-local" value="${localDT(soon)}">
    <div class="row" style="margin-top:8px"><button class="btn sec sm" id="nowBtn">Now (in 30 min)</button></div>
    <div id="avail"></div>
    <button class="btn" id="bookBtn" style="width:100%;margin-top:12px">Book table</button>
    <div id="bmsg"></div>
  </div>`;
  const check = async () => {
    const party = parseInt($('#party').value, 10), start = new Date($('#start').value).getTime();
    if (!party || !start) { $('#avail').innerHTML = ''; return; }
    try {
      const a = await api.call(`/api/availability?start=${start}&party=${party}`);
      $('#avail').innerHTML = a.available
        ? `<div class="msg ok">✅ A table is available (${a.free_tables} of ${a.total_tables} free)</div>`
        : `<div class="msg info">⏳ All tables are full at this time.<br><b>Estimated wait: about ${a.wait_minutes} minutes</b> (${a.waiting_ahead} people already waiting). If you book, you will join the waiting list and get an SMS as soon as a table is ready.</div>`;
    } catch (e) { $('#avail').innerHTML = errBox(e); }
  };
  ['party', 'start'].forEach(id => $('#' + id).addEventListener('change', check));
  $('#nowBtn').onclick = () => { $('#start').value = localDT(Date.now() + 30 * 60000); check(); };
  $('#bookBtn').onclick = async () => {
    const b = $('#bookBtn'); b.disabled = true;
    try {
      const r = await api.call('/api/bookings', { method: 'POST', body: { party_size: parseInt($('#party').value, 10), start_ts: new Date($('#start').value).getTime() } });
      $('#bmsg').innerHTML = r.status === 'confirmed'
        ? `<div class="msg ok">🎉 Booking confirmed! <b>Table #${r.table_number}</b> (${r.party_size} guests) - ${fmtTime(r.start_ts)}.<br>When you reach the restaurant, show the QR from "My Bookings / QR".</div>`
        : `<div class="msg info">You are on the waiting list (position ${r.position}). <b>Estimated wait: about ${r.wait_minutes} minutes.</b> The live status is shown in "My Bookings / QR".</div>`;
      check();
    } catch (e) { $('#bmsg').innerHTML = errBox(e); }
    b.disabled = false;
  };
  check();
}

/* ---------- Menu + order ---------- */
async function viewMenu() {
  view().innerHTML = '<p class="muted">Loading menu...</p>';
  try { menu = await api.call('/api/menu'); } catch (e) { return view().innerHTML = errBox(e); }
  const cats = [...new Set(menu.map(m => m.category))];
  view().innerHTML = `<div id="omsg"></div>` + cats.map(c => `<div class="menu-cat">${esc(c)}</div><div class="card" style="padding:4px 14px">` +
    menu.filter(m => m.category === c).map(m => `
      <div class="item"><div><span class="dot ${m.veg ? '' : 'nv'}"></span><b>${esc(m.name)}</b><div class="muted">${esc(m.description)}</div><div>${inr(m.price)}</div></div>
      <div class="qty"><button data-m="${m.id}" data-d="-1">−</button><span id="q${m.id}">${cart[m.id] || 0}</span><button data-m="${m.id}" data-d="1">+</button></div></div>`).join('') + '</div>').join('');
  view().onclick = e => {
    const id = e.target.dataset.m; if (!id) return;
    cart[id] = Math.max(0, Math.min(50, (cart[id] || 0) + parseInt(e.target.dataset.d, 10)));
    if (!cart[id]) delete cart[id];
    $('#q' + id).textContent = cart[id] || 0; cartBar();
  };
  cartBar();
}
function cartBar() {
  const lines = Object.entries(cart).map(([id, q]) => ({ m: menu.find(x => x.id == id), q })).filter(l => l.m);
  const total = lines.reduce((s, l) => s + l.m.price * l.q, 0), n = lines.reduce((s, l) => s + l.q, 0);
  $('#cartbar').innerHTML = n ? `<div><b>${n} item${n > 1 ? 's' : ''}</b> · ${inr(total)}<div class="muted">GST is added when the bill is generated</div></div><button class="btn" id="placeBtn">Place order</button>` : '';
  if (n) $('#placeBtn').onclick = async () => {
    const b = $('#placeBtn'); b.disabled = true;
    try {
      const mine = await api.call('/api/bookings/mine');
      const here = mine.find(x => x.status === 'arrived');
      const o = await api.call('/api/orders', { method: 'POST', body: { items: lines.map(l => ({ id: l.m.id, qty: l.q })), booking_id: here ? here.id : undefined } });
      cart = {};
      openModal(`<h2 style="margin-top:0">Order placed! 🎉</h2><p class="muted">Your Order ID</p><div class="code">${esc(o.order_code)}</div>
        <p>Total ${inr(o.total)}</p><p class="muted">You can quote this ID to the restaurant staff.</p>`);
      go('orders');
    } catch (e) { toast(e.message); b.disabled = false; }
  };
}

/* ---------- My bookings + QR ---------- */
async function viewMy() {
  const load = async () => {
    try {
      const list = await api.call('/api/bookings/mine');
      view().innerHTML = (list.length ? '' : '<div class="card muted">You have no bookings yet.</div>') + list.map(b => `
        <div class="card"><div class="row"><div class="grow"><b>${fmtTime(b.start_ts)}</b> · ${b.party_size} guests</div>${badge(b.status)}</div>
        ${b.status === 'waiting' ? `<div class="msg info">⏳ Waiting list position <b>${b.position}</b> · estimated wait about <b>${b.wait_minutes} minutes</b> (by ${fmtClock(b.expected_ts)})</div>` : ''}
        ${b.table_number ? `<p>Table <b>#${b.table_number}</b> (${b.table_seats} seats)</p>` : ''}
        <div class="row">
          ${['confirmed', 'arrived'].includes(b.status) ? `<button class="btn sm" data-qr="${b.id}">📱 Show entry QR</button>` : ''}
          ${['confirmed', 'waiting'].includes(b.status) ? `<button class="btn sec sm" data-cancel="${b.id}">Cancel</button>` : ''}
        </div></div>`).join('');
    } catch (e) { view().innerHTML = errBox(e); }
  };
  view().onclick = async e => {
    if (e.target.dataset.qr) {
      try {
        const r = await api.call(`/api/bookings/${e.target.dataset.qr}/qr`);
        openModal(`<h3 style="margin-top:0">Show this QR at the restaurant</h3><img src="${r.qr}" alt="QR"><p class="muted">The staff will scan it to identify you.<br>Code: <b>${esc(r.code)}</b></p>`);
      } catch (er) { toast(er.message); }
    } else if (e.target.dataset.cancel) {
      if (!confirm('Cancel this booking?')) return;
      try { await api.call(`/api/bookings/${e.target.dataset.cancel}/cancel`, { method: 'POST' }); load(); } catch (er) { toast(er.message); }
    }
  };
  await load(); timer = setInterval(load, 20000);
}

/* ---------- Orders ---------- */
async function viewOrders() {
  const load = async () => {
    try {
      const list = await api.call('/api/orders/mine');
      view().innerHTML = (list.length ? '' : '<div class="card muted">You have no orders yet.</div>') + list.map(o => `
        <div class="card"><div class="row"><div class="grow"><span class="muted">Order ID</span><div class="code">${esc(o.order_code)}</div></div>${badge(o.status)}</div>
        <div class="muted">${fmtTime(o.created_at)}${o.table_number ? ' · Table #' + o.table_number : ''}</div>
        <ul style="margin:8px 0;padding-left:18px">${o.items.map(i => `<li>${esc(i.name)} × ${i.qty} — ${inr(i.price * i.qty)}</li>`).join('')}</ul>
        <b>Total ${inr(o.total)}</b></div>`).join('');
    } catch (e) { view().innerHTML = errBox(e); }
  };
  await load(); timer = setInterval(load, 15000);
}

/* ---------- Bills ---------- */
async function viewBills() {
  const load = async () => {
    try {
      const list = await api.call('/api/bills/mine');
      view().innerHTML = (list.length ? '' : '<div class="card muted">Your bill will appear here once the restaurant staff generates it. You will also get it by SMS.</div>') + list.map(b => `
        <div class="card"><div class="row"><div class="grow"><span class="muted">Bill</span><div class="code" style="font-size:18px">${esc(b.bill_no)}</div></div>${badge(b.status)}</div>
        <table class="list">${b.items.map(i => `<tr><td>${esc(i.name)} × ${i.qty}</td><td style="text-align:right">${inr(i.price * i.qty)}</td></tr>`).join('')}
          <tr><td>Subtotal</td><td style="text-align:right">${inr(b.subtotal)}</td></tr>
          <tr><td>GST</td><td style="text-align:right">${inr(b.gst)}</td></tr>
          <tr><td><b>Total</b></td><td style="text-align:right"><b>${inr(b.total)}</b></td></tr></table>
        ${b.status === 'unpaid' || b.status === 'pay_at_counter' ? `<div class="row" style="margin-top:10px">
          <button class="btn ok" data-pay="online" data-id="${b.id}">💳 Pay online</button>
          ${b.status === 'unpaid' ? `<button class="btn sec" data-pay="offline" data-id="${b.id}">💵 Pay at the counter</button>` : '<span class="muted">Please pay at the counter; the staff will mark it as paid</span>'}</div>` : ''}
        ${b.status === 'paid' ? `<p class="muted">Paid (${b.method === 'online' ? 'Online' : 'Offline'}) · ${fmtTime(b.paid_at)}</p>` : ''}</div>`).join('');
    } catch (e) { view().innerHTML = errBox(e); }
  };
  view().onclick = async e => {
    const m = e.target.dataset.pay; if (!m) return;
    if (m === 'online' && !confirm('Demo payment: the bill will be marked as paid online. Continue?')) return;
    try { await api.call(`/api/bills/${e.target.dataset.id}/pay`, { method: 'POST', body: { method: m } }); toast(m === 'online' ? 'Payment successful ✅' : 'Please pay at the counter'); load(); }
    catch (er) { toast(er.message); }
  };
  await load(); timer = setInterval(load, 15000);
}

start();
