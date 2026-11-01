// Shared helpers + phone OTP login screen (used by customer app and admin panel)
const API = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || 'http://localhost:4000';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtTime = ts => new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
const fmtClock = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
const statusLabel = s => ({ confirmed: 'Confirmed', waiting: 'On waiting list', arrived: 'Checked in', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
  placed: 'Order placed', preparing: 'Preparing', served: 'Served', unpaid: 'Payment due', pay_at_counter: 'Pay at counter', paid: 'Paid' }[s] || s);
const badge = s => `<span class="badge b-${esc(s)}">${esc(statusLabel(s))}</span>`;

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2800);
}

function makeApi(tokenKey) {
  const get = () => localStorage.getItem(tokenKey);
  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(get() ? { Authorization: 'Bearer ' + get() } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch { throw new Error('Cannot connect to the server. Is the backend running? (' + API + ')'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { localStorage.removeItem(tokenKey); if (!path.startsWith('/api/auth')) { location.reload(); } }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  return { call, token: get, set: t => localStorage.setItem(tokenKey, t), clear: () => localStorage.removeItem(tokenKey) };
}

// Login screen: step 1 phone (+name for new users), step 2 OTP
function renderLogin(root, { title, subtitle, onDone, api, askName }) {
  root.innerHTML = `
  <div class="login card">
    <h2 style="margin-top:0">${esc(title)}</h2>
    <p class="muted">${esc(subtitle || '')}</p>
    <div id="step1">
      ${askName ? '<label>Your name</label><input id="lname" placeholder="Name" maxlength="60">' : ''}
      <label>Mobile number</label>
      <div class="row" style="flex-wrap:nowrap"><span class="badge" style="padding:10px">+91</span>
        <input id="lphone" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit number"></div>
      <button class="btn" id="sendOtp" style="width:100%;margin-top:14px">Send OTP</button>
    </div>
    <div id="step2" style="display:none">
      <label>6-digit OTP sent by SMS</label>
      <input id="lotp" type="tel" inputmode="numeric" maxlength="6" placeholder="------" style="letter-spacing:6px;font-size:20px;text-align:center">
      <button class="btn" id="verify" style="width:100%;margin-top:14px">Log in</button>
      <button class="btn sec" id="back" style="width:100%;margin-top:8px">Change number</button>
    </div>
    <div id="lmsg"></div>
  </div>`;
  const msg = (t, cls = 'err') => { $('#lmsg', root).innerHTML = t ? `<div class="msg ${cls}">${t}</div>` : ''; };
  $('#sendOtp', root).onclick = async () => {
    const phone = $('#lphone', root).value.trim();
    msg('');
    const b = $('#sendOtp', root); b.disabled = true;
    try {
      const r = await api.call('/api/auth/send-otp', { method: 'POST', body: { phone } });
      $('#step1', root).style.display = 'none'; $('#step2', root).style.display = 'block';
      msg(r.devOtp ? `Test mode: your OTP is <b>${esc(r.devOtp)}</b> (set DEV_OTP=false in the backend .env to send real SMS)` : 'An OTP has been sent to your mobile number', 'info');
    } catch (e) { msg(esc(e.message)); }
    b.disabled = false;
  };
  $('#verify', root).onclick = async () => {
    msg('');
    const b = $('#verify', root); b.disabled = true;
    try {
      const r = await api.call('/api/auth/verify-otp', { method: 'POST',
        body: { phone: $('#lphone', root).value.trim(), code: $('#lotp', root).value.trim(), name: askName ? $('#lname', root).value : '' } });
      api.set(r.token); onDone(r.user);
    } catch (e) { msg(esc(e.message)); }
    b.disabled = false;
  };
  $('#back', root).onclick = () => { $('#step2', root).style.display = 'none'; $('#step1', root).style.display = 'block'; msg(''); };
}

function openModal(html) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="box">${html}<button class="btn" style="margin-top:14px;width:100%" data-close>Close</button></div>`;
  m.addEventListener('click', e => { if (e.target === m || e.target.hasAttribute('data-close')) m.remove(); });
  document.body.appendChild(m); return m;
}
