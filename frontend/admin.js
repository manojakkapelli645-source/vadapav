// Admin panel for restaurant staff: tables, waiting list, orders (order IDs), bookings, QR scanner, bills, menu
const api = makeApi('rb_admin_token');
const app = $('#app');
let cfg = { restaurant: 'Restaurant' };
let me = null, tab = 'tables', timer = null, scanner = null;

async function start() {
  try { cfg = await api.call('/api/config'); } catch (e) { /* shown at login */ }
  document.title = 'Admin - ' + cfg.restaurant;
  if (api.token()) {
    try {
      me = await api.call('/api/me');
      if (me.role === 'admin') return shell();
      api.clear();
    } catch { api.clear(); }
  }
  renderLogin(app, { title: 'Admin Login', subtitle: cfg.restaurant + ' - restaurant staff only', api, askName: false,
    onDone: u => {
      if (u.role !== 'admin') { api.clear(); return toast('This number is not in the admin list (check ADMIN_PHONES in the backend .env)'); }
      me = u; shell();
    } });
}

function shell() {
  app.innerHTML = `
  <header><h1>🛎 ${esc(cfg.restaurant)} - Admin</h1><div class="who"><span>+91 ${esc(me.phone)}</span><button id="logout">Logout</button></div></header>
  <nav class="tabs" id="tabs">
    <button data-t="tables">Tables & Waiting</button><button data-t="orders">Orders (Order ID)</button><button data-t="bookings">Bookings</button>
    <button data-t="scan">QR Scanner</button><button data-t="bills">Bills</button><button data-t="menu">Menu</button>
  </nav><main id="view"></main>`;
  $('#logout').onclick = () => { api.clear(); location.reload(); };
  $('#tabs').onclick = e => { if (e.target.dataset.t) go(e.target.dataset.t); };
  go(tab);
}
const view = () => $('#view');
const errBox = e => `<div class="msg err">${esc(e.message)}</div>`;

function go(t) {
  tab = t; clearInterval(timer); stopScanner();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  view().onclick = null; view().onchange = null;
  ({ tables: vTables, orders: vOrders, bookings: vBookings, scan: vScan, bills: vBills, menu: vMenu })[t]();
}
const auto = (fn, ms = 10000) => { fn(); timer = setInterval(fn, ms); };
const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) { toast(e.message); return false; } };

/* ---------- Tables + waiting list ---------- */
function vTables() {
  view().innerHTML = `<div id="stats"></div><div class="card"><h3>Tables (${cfg.tables || 12} tables × ${cfg.seats_per_table || 12} seats)</h3><div class="grid" id="grid"></div>
    <p class="muted">🟢 Free · 🟡 Reserved (guest arriving soon) · 🔴 Occupied (checked in)</p></div>
    <div class="card"><h3>Waiting list</h3><div id="wl"></div></div>
    <div class="card"><h3>Walk-in / phone booking</h3>
      <div class="row"><div class="grow"><label>Customer mobile</label><input id="wp" type="tel" maxlength="10"></div>
      <div class="grow"><label>Name</label><input id="wn"></div>
      <div style="width:110px"><label>Guests</label><input id="wc" type="number" min="1" max="${cfg.seats_per_table || 12}" value="2"></div></div>
      <button class="btn" id="wb" style="margin-top:10px">Book a table for now</button><div id="wm"></div></div>`;
  $('#wb').onclick = async () => {
    try {
      const r = await api.call('/api/admin/bookings', { method: 'POST', body: { phone: $('#wp').value, name: $('#wn').value, party_size: parseInt($('#wc').value, 10), start_ts: Date.now() } });
      $('#wm').innerHTML = `<div class="msg ${r.status === 'confirmed' ? 'ok' : 'info'}">${r.status === 'confirmed' ? 'Table #' + r.table_number + ' assigned' : 'Added to the waiting list, about ' + r.wait_minutes + ' minutes'}</div>`;
      load();
    } catch (e) { $('#wm').innerHTML = errBox(e); }
  };
  const load = async () => {
    try {
      const d = await api.call('/api/admin/overview');
      $('#stats').innerHTML = `<div class="stats">
        <div class="stat"><b>${d.stats.free}</b>Free tables</div><div class="stat"><b>${d.stats.reserved}</b>Reserved</div>
        <div class="stat"><b>${d.stats.occupied}</b>Occupied</div><div class="stat"><b>${d.waiting.length}</b>Waiting</div>
        <div class="stat"><b>${d.stats.open_orders}</b>Open orders</div><div class="stat"><b>${d.stats.unpaid_bills}</b>Unpaid bills</div></div>`;
      $('#grid').innerHTML = d.tables.map(t => `<div class="tbl t-${t.state}"><b>Table ${t.number}</b> <span class="muted">· ${t.seats} seats</span><br>
        ${t.booking ? `${esc(t.booking.name || 'Guest')}<br>+91 ${esc(t.booking.phone)}<br>${t.booking.party_size} guests · ${fmtClock(t.booking.start_ts)}-${fmtClock(t.booking.end_ts)}
          <br><button class="btn sec sm" data-cancel="${t.booking.id}" style="margin-top:4px">Free this table</button>` : (t.next_booking_ts ? `<span class="muted">Next booking ${fmtClock(t.next_booking_ts)}</span>` : '<span class="muted">Free</span>')}</div>`).join('');
      $('#wl').innerHTML = d.waiting.length ? `<table class="list"><tr><th>#</th><th>Customer</th><th>Guests</th><th>Wait (min)</th><th>Expected time</th><th></th></tr>` +
        d.waiting.map(w => `<tr><td>${w.position}</td><td>${esc(w.name || '-')}<br><span class="muted">+91 ${esc(w.phone)}</span></td><td>${w.party_size}</td>
          <td><b>${w.wait_minutes} min</b></td><td>${fmtClock(w.expected_ts)}</td><td><button class="btn sec sm" data-cancel="${w.id}">Remove</button></td></tr>`).join('') + '</table>' : '<span class="muted">Nobody is waiting.</span>';
    } catch (e) { $('#stats').innerHTML = errBox(e); }
  };
  view().onclick = async e => {
    const id = e.target.dataset.cancel; if (!id) return;
    if (confirm('Cancel this booking / free the table?') && await act(() => api.call(`/api/admin/bookings/${id}/cancel`, { method: 'POST' }), 'Done')) load();
  };
  auto(load);
}

/* ---------- Orders ---------- */
function vOrders() {
  view().innerHTML = `<div class="row"><div class="grow"><select id="of"><option value="">All orders</option><option value="placed">New (placed)</option><option value="preparing">Preparing</option>
    <option value="served">Served</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></div></div><div id="ol"></div>`;
  const load = async () => {
    try {
      const f = $('#of').value;
      const list = await api.call('/api/admin/orders' + (f ? '?status=' + f : ''));
      $('#ol').innerHTML = list.length ? list.map(o => `<div class="card"><div class="row">
        <div class="grow"><span class="muted">Order ID</span><div class="code">${esc(o.order_code)}</div></div>${badge(o.status)}</div>
        <div>${esc(o.customer || 'Guest')} · +91 ${esc(o.phone)}${o.table_number ? ' · <b>Table #' + o.table_number + '</b>' : ''} · <span class="muted">${fmtTime(o.created_at)}</span></div>
        <ul style="margin:8px 0;padding-left:18px">${o.items.map(i => `<li>${esc(i.name)} × ${i.qty}</li>`).join('')}</ul>
        <b>${inr(o.total)}</b>
        <div class="row" style="margin-top:8px">
          ${o.status === 'placed' ? `<button class="btn sm blue" data-st="preparing" data-id="${o.id}">Start preparing</button>` : ''}
          ${['placed', 'preparing'].includes(o.status) ? `<button class="btn sm" data-st="served" data-id="${o.id}">Mark served</button>` : ''}
          ${['placed', 'preparing'].includes(o.status) ? `<button class="btn sm sec" data-st="cancelled" data-id="${o.id}">Cancel</button>` : ''}
          ${['placed', 'preparing', 'served'].includes(o.status) ? `<button class="btn sm ok" data-bill="${o.user_id}">🧾 Generate bill & send SMS</button>` : ''}
        </div></div>`).join('') : '<div class="card muted">No orders.</div>';
    } catch (e) { $('#ol').innerHTML = errBox(e); }
  };
  $('#of').onchange = load;
  view().onclick = async e => {
    const d = e.target.dataset;
    if (d.st && await act(() => api.call('/api/admin/orders/' + d.id, { method: 'PATCH', body: { status: d.st } }), 'Updated')) load();
    if (d.bill && confirm("Generate a bill for all of this customer's unbilled orders and send it to their phone?")) {
      if (await act(() => api.call('/api/admin/bills', { method: 'POST', body: { user_id: parseInt(d.bill, 10) } }), 'Bill generated and SMS sent')) load();
    }
  };
  auto(load);
}

/* ---------- Bookings ---------- */
function vBookings() {
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  view().innerHTML = `<div class="card"><label>Date</label><input type="date" id="bd" value="${today}"></div><div id="bl"></div>`;
  const load = async () => {
    try {
      const list = await api.call('/api/admin/bookings?date=' + $('#bd').value);
      $('#bl').innerHTML = list.length ? `<div class="card" style="overflow-x:auto"><table class="list"><tr><th>Time</th><th>Customer</th><th>Guests</th><th>Table</th><th>Status</th><th></th></tr>` +
        list.map(b => `<tr><td>${fmtClock(b.start_ts)}</td><td>${esc(b.name || '-')}<br><span class="muted">+91 ${esc(b.phone)}</span></td><td>${b.party_size}</td>
        <td>${b.table_number ? '#' + b.table_number : '-'}</td><td>${badge(b.status)}${b.status === 'waiting' ? `<br><span class="muted">${b.wait_minutes} min</span>` : ''}</td>
        <td>${['confirmed', 'waiting', 'arrived'].includes(b.status) ? `<button class="btn sec sm" data-cancel="${b.id}">Cancel</button>` : ''}</td></tr>`).join('') + '</table></div>'
        : '<div class="card muted">No bookings on this day.</div>';
    } catch (e) { $('#bl').innerHTML = errBox(e); }
  };
  $('#bd').onchange = load;
  view().onclick = async e => { const id = e.target.dataset.cancel; if (id && confirm('Cancel this booking?') && await act(() => api.call(`/api/admin/bookings/${id}/cancel`, { method: 'POST' }), 'Booking cancelled')) load(); };
  auto(load, 15000);
}

/* ---------- QR scanner (customer shows QR on arrival) ---------- */
function stopScanner() { if (scanner) { scanner.stop().catch(() => {}).finally(() => { try { scanner.clear(); } catch {} scanner = null; }); } }

function vScan() {
  view().innerHTML = `<div class="card"><h3>Scan the customer's QR code</h3>
    <p class="muted">The customer shows the QR on their phone when they arrive. Scan it with the camera, or type the code below.</p>
    <div id="reader"></div><div class="row" style="justify-content:center"><button class="btn" id="cam">📷 Start camera</button></div>
    <label>Or enter the code manually</label><div class="row" style="flex-wrap:nowrap"><input id="code" placeholder="e.g. AB12CD34EF56GH78" style="text-transform:uppercase"><button class="btn" id="chk">Check</button></div>
    <div id="sres"></div></div>`;
  const check = async (token, force) => {
    try {
      const r = await api.call('/api/admin/scan', { method: 'POST', body: { token, force } });
      const cls = r.valid ? (r.already ? 'info' : 'ok') : (r.early ? 'info' : 'err');
      $('#sres').innerHTML = `<div class="msg ${cls}"><b>${esc(r.message)}</b>${r.name !== undefined ? `<br><br>👤 ${esc(r.name || 'Guest')} · +91 ${esc(r.phone)}<br>👥 ${r.party_size} guests · 🕒 ${fmtTime(r.start_ts)}<br>🪑 Table: <b>${r.table_number ? '#' + r.table_number : '-'}</b>` : ''}
        ${r.early ? '<br><button class="btn sm" id="force" style="margin-top:8px">Check in anyway</button>' : ''}</div>`;
      if (r.early) $('#force').onclick = () => check(token, true);
    } catch (e) { $('#sres').innerHTML = errBox(e); }
  };
  $('#chk').onclick = () => { const c = $('#code').value.trim(); if (c) check(c); };
  $('#cam').onclick = async () => {
    if (!window.Html5Qrcode) return toast('The scanner library could not load (internet is required). Please enter the code manually.');
    if (scanner) return;
    scanner = new Html5Qrcode('reader');
    let done = false;
    try {
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, text => { if (done) return; done = true; stopScanner(); check(text); });
    } catch (e) { scanner = null; toast('Could not open the camera: ' + (e.message || e)); }
  };
}

/* ---------- Bills ---------- */
function vBills() {
  view().innerHTML = '<div id="bl"></div>';
  const load = async () => {
    try {
      const list = await api.call('/api/admin/bills');
      $('#bl').innerHTML = list.length ? list.map(b => `<div class="card"><div class="row"><div class="grow"><b>${esc(b.bill_no)}</b> · ${esc(b.customer || 'Guest')} · +91 ${esc(b.phone)}
        <div class="muted">${fmtTime(b.created_at)} · Orders: ${b.orders.map(o => esc(o.order_code)).join(', ')}</div></div>${badge(b.status)}</div>
        <div style="margin:6px 0">${inr(b.subtotal)} + GST ${inr(b.gst)} = <b>${inr(b.total)}</b>${b.method ? ' · ' + (b.method === 'online' ? 'Online' : 'Offline') : ''}</div>
        ${b.status !== 'paid' ? `<button class="btn ok sm" data-paid="${b.id}">✔ Payment received (mark as paid)</button>` : ''}</div>`).join('') : '<div class="card muted">No bills yet. Use "Generate bill" in the Orders tab.</div>';
    } catch (e) { $('#bl').innerHTML = errBox(e); }
  };
  view().onclick = async e => { const id = e.target.dataset.paid; if (id && confirm('Payment received?') && await act(() => api.call(`/api/admin/bills/${id}/mark-paid`, { method: 'POST', body: { method: 'offline' } }), 'Marked as paid')) load(); };
  auto(load);
}

/* ---------- Menu management ---------- */
function vMenu() {
  view().innerHTML = `<div class="card"><h3>Add a new item</h3><div class="row">
    <div class="grow"><label>Name</label><input id="mn"></div><div class="grow"><label>Category</label><input id="mc" placeholder="Starters / Main Course..."></div>
    <div style="width:110px"><label>Price ₹</label><input id="mp" type="number" min="1"></div>
    <div style="width:110px"><label>Type</label><select id="mv"><option value="1">Veg</option><option value="0">Non-veg</option></select></div></div>
    <label>Description (optional)</label><input id="md"><button class="btn" id="madd" style="margin-top:10px">Add item</button></div><div id="ml"></div>`;
  const load = async () => {
    try {
      const list = await api.call('/api/admin/menu');
      $('#ml').innerHTML = `<div class="card" style="overflow-x:auto"><table class="list"><tr><th>Item</th><th>Category</th><th>Price</th><th>Availability</th></tr>` + list.map(m => `<tr>
        <td><span class="dot ${m.veg ? '' : 'nv'}"></span>${esc(m.name)}</td><td>${esc(m.category)}</td>
        <td><input type="number" value="${m.price}" min="1" style="width:90px" data-price="${m.id}"></td>
        <td><button class="btn sm ${m.available ? 'ok' : 'sec'}" data-av="${m.id}" data-v="${m.available ? 0 : 1}">${m.available ? 'Available' : 'Unavailable'}</button></td></tr>`).join('') + '</table></div>';
    } catch (e) { $('#ml').innerHTML = errBox(e); }
  };
  $('#madd').onclick = async () => {
    if (await act(() => api.call('/api/admin/menu', { method: 'POST', body: { name: $('#mn').value, category: $('#mc').value, price: $('#mp').value, veg: $('#mv').value === '1', description: $('#md').value } }), 'Item added')) {
      ['mn', 'mc', 'mp', 'md'].forEach(i => $('#' + i).value = ''); load();
    }
  };
  view().onclick = async e => { const d = e.target.dataset; if (d.av && await act(() => api.call('/api/admin/menu/' + d.av, { method: 'PATCH', body: { available: d.v === '1' } }))) load(); };
  view().onchange = async e => { const id = e.target.dataset.price; if (id) await act(() => api.call('/api/admin/menu/' + id, { method: 'PATCH', body: { price: e.target.value } }), 'Price updated'); };
  load();
}

start();
