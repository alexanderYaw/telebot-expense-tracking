/* ============================================================
   Expense Mini App — prototype logic.
   Pure front-end with MOCK data; no backend calls yet. The render
   functions are written so they can later be fed real data from the
   bot's Google Sheet (same shape as `records` in main.py).
   ============================================================ */

// --- Telegram Mini App bootstrap (no-op in a plain browser) ---
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor && tg.setHeaderColor('secondary_bg_color');
}

// --- Categories (mirrors CATEGORIES in main.py) with display colors ---
const CATEGORIES = {
  Food:      { color: '#1faa6c', icon: '🍜' },
  Transport: { color: '#3b82f6', icon: '🚌' },
  Shopping:  { color: '#a855f7', icon: '🛍️' },
  Groceries: { color: '#14b8a6', icon: '🛒' },
  Bills:     { color: '#f59e0b', icon: '🧾' },
  Climbing:  { color: '#ef4444', icon: '🧗' },
  Others:    { color: '#8a909c', icon: '•' },
};
const catColor = (c) => (CATEGORIES[c] || CATEGORIES.Others).color;
const catIcon  = (c) => (CATEGORIES[c] || CATEGORIES.Others).icon;

// --- App state ----------------------------------------------------
// Each tx: {id, date 'YYYY-MM-DD', type, category, amount, name, recurring}
// type: 'Expense' | 'Income' | 'Incoming'. Data is fetched live from the
// bot's Google Sheet via /api and cached per month in STATE.cache.
const STATE = {
  month: thisMonthISO(),          // active month (YYYY-MM)
  activeTab: 'home',
  addType: 'expense',             // expense | recurring | income | incoming
  addCategory: 'Food',
  categoryFilter: 'All',
  cache: {},                      // { 'YYYY-MM': [tx, ...] }  (undefined = not loaded)
  loading: false,
  error: null,
};

function thisMonthISO() { return new Date().toISOString().slice(0, 7); }

// --- API client ---------------------------------------------------
// Served from the same origin as this page (FastAPI). The Telegram Mini App
// SDK provides signed initData which the backend verifies; in a plain browser
// it's empty and the backend's dev mode lets the request through.
const API = {
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (tg && tg.initData) h['X-Telegram-Init-Data'] = tg.initData;
    return h;
  },
  async list(month) {
    const r = await fetch(`/api/transactions?month=${month}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    return (await r.json()).transactions;
  },
  async add(tx) {
    const r = await fetch('/api/transactions', {
      method: 'POST', headers: this.headers(), body: JSON.stringify(tx),
    });
    if (!r.ok) throw new Error(`Add failed (${r.status})`);
    return (await r.json()).transaction;
  },
  async remove(id, month) {
    const r = await fetch(`/api/transactions/${id}?month=${month}`, {
      method: 'DELETE', headers: this.headers(),
    });
    if (!r.ok) throw new Error(`Delete failed (${r.status})`);
  },
};

// Load a month into the cache if not already present. Sets loading/error flags.
async function ensureMonth(ym, { force = false } = {}) {
  if (!force && STATE.cache[ym]) return;
  STATE.loading = true;
  STATE.error = null;
  try {
    STATE.cache[ym] = await API.list(ym);
  } catch (e) {
    STATE.error = e.message || 'Could not load data';
    STATE.cache[ym] = STATE.cache[ym] || [];
  } finally {
    STATE.loading = false;
  }
}

function invalidate(ym) { delete STATE.cache[ym]; }

// Re-fetch the active month and re-render the current tab.
async function refreshActive() {
  await ensureMonth(STATE.month, { force: true });
  RENDERERS[STATE.activeTab]();
}

// --- Helpers ------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};
const dayLabel = (d) => {
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
};
const inMonth = (d, ym) => d.startsWith(ym);
const txForMonth = (ym) => (STATE.cache[ym] || []).slice()
  .sort((a, b) => b.date.localeCompare(a.date));

// Banner shown at the top of a view while loading or after an error.
function statusBanner() {
  if (STATE.loading) return `<div class="banner">Loading…</div>`;
  if (STATE.error) return `<div class="banner error">⚠️ ${escapeHtml(STATE.error)}</div>`;
  return '';
}

function shiftMonth(ym, delta) {
  let [y, m] = ym.split('-').map(Number);
  m += delta;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function totals(ym) {
  let spent = 0, income = 0, incoming = 0;
  for (const t of txForMonth(ym)) {
    if (t.type === 'Expense') spent += t.amount;
    else if (t.type === 'Income') income += t.amount;
    else if (t.type === 'Incoming') incoming += t.amount;
  }
  return { spent, income, incoming, net: income + incoming - spent };
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

// --- Transaction row markup --------------------------------------
function txRow(t) {
  const isIn = t.type !== 'Expense';
  const sign = isIn ? '+' : '−';
  const pillHtml = t.type === 'Expense'
    ? `<span class="pill" style="background:${catColor(t.category)}">${escapeHtml(t.category)}</span>`
    : `<span class="pill" style="background:${isIn ? 'var(--pos)' : 'var(--neg)'}">${t.type === 'Income' ? 'Income' : 'Incoming'}</span>`;
  const iconBg = t.type === 'Expense' ? catColor(t.category) : 'var(--pos)';
  const icon = t.type === 'Expense' ? catIcon(t.category) : (t.type === 'Income' ? '💰' : '🤝');
  return `
    <div class="tx">
      <div class="tx-icon" style="background:${iconBg}22;color:${t.type==='Expense'?catColor(t.category):'var(--pos)'}">${icon}</div>
      <div class="tx-main">
        <div class="tx-name">${escapeHtml(t.name || '(no name)')}${t.recurring ? ' 🔁' : ''}</div>
        <div class="tx-sub">${pillHtml} · ${dayLabel(t.date)}</div>
      </div>
      <div class="tx-amt ${isIn ? 'pos' : ''}">${sign}${money(t.amount)}</div>
      <button class="tx-del" data-del="${escapeHtml(t.id || '')}" data-month="${(t.date || '').slice(0, 7)}" aria-label="Delete" title="Delete">✕</button>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ============================================================
//  VIEW: HOME
// ============================================================
function renderHome() {
  const t = totals(STATE.month);
  const recent = txForMonth(STATE.month).slice(0, 6);
  $('#view-home').innerHTML = `
    ${statusBanner()}
    <div class="card hero">
      <p class="card-title">Spent in ${monthLabel(STATE.month)}</p>
      <div class="amount">${money(t.spent)}</div>
      <div class="sub">Net ${t.net >= 0 ? '+' : '−'}${money(Math.abs(t.net))} this month</div>
    </div>

    <div class="stat-row">
      <div class="card stat">
        <div class="label">Income</div>
        <div class="value pos">${money(t.income)}</div>
      </div>
      <div class="card stat">
        <div class="label">Incoming funds</div>
        <div class="value pos">${money(t.incoming)}</div>
      </div>
    </div>

    <div class="card">
      <p class="card-title">Recent activity</p>
      ${recent.length ? recent.map(txRow).join('') : emptyInline('Nothing logged yet')}
    </div>`;
}

function emptyInline(msg) {
  return `<div class="empty"><div class="big">🗒️</div>${msg}</div>`;
}

// ============================================================
//  VIEW: ADD  (recurring expense / income / incoming + one-off)
// ============================================================
const ADD_TYPES = [
  { key: 'expense',   label: 'Expense' },
  { key: 'recurring', label: 'Recurring' },
  { key: 'income',    label: 'Income' },
  { key: 'incoming',  label: 'Incoming' },
];

function renderAdd() {
  const seg = ADD_TYPES.map((a) =>
    `<button data-add="${a.key}" class="${STATE.addType === a.key ? 'is-active' : ''}">${a.label}</button>`
  ).join('');

  $('#view-add').innerHTML = `
    <div class="segmented">${seg}</div>
    <div class="card">${addForm(STATE.addType)}</div>`;

  // wire segmented control
  $('#view-add').querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => { STATE.addType = b.dataset.add; renderAdd(); }));

  // wire category chips (only present for expense/recurring)
  $('#view-add').querySelectorAll('[data-cat]').forEach((c) =>
    c.addEventListener('click', () => { STATE.addCategory = c.dataset.cat; renderAdd(); }));

  // wire submit
  const btn = $('#add-submit');
  if (btn) btn.addEventListener('click', onAddSubmit);
}

function amountField() {
  return `
    <div class="field">
      <label>Amount</label>
      <div class="amount-input"><span>$</span><input id="f-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01" min="0"></div>
    </div>`;
}

function categoryField() {
  const chips = Object.keys(CATEGORIES).map((c) => {
    const active = STATE.addCategory === c;
    const style = active ? `background:${catColor(c)};border-color:${catColor(c)};color:#fff` : '';
    return `<button data-cat="${c}" class="chip ${active ? 'is-active' : ''}" style="${style}">${catIcon(c)} ${c}</button>`;
  }).join('');
  return `<div class="field"><label>Category</label><div class="cat-grid">${chips}</div></div>`;
}

function addForm(type) {
  if (type === 'expense') {
    return `
      ${amountField()}
      <div class="field"><label>Name</label><input id="f-name" placeholder="e.g. Lunch — laksa"></div>
      ${categoryField()}
      <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayISO()}"></div>
      <button id="add-submit" class="btn-primary">Add expense</button>`;
  }
  if (type === 'recurring') {
    return `
      ${amountField()}
      <div class="field"><label>Name</label><input id="f-name" placeholder="e.g. Phone plan"></div>
      ${categoryField()}
      <div class="field"><label>Repeats on day of month</label><input id="f-day" type="number" min="1" max="28" value="1"></div>
      <p class="hint-text">🔁 Logged automatically each month on this day.</p>
      <button id="add-submit" class="btn-primary">Add recurring expense</button>`;
  }
  if (type === 'income') {
    return `
      ${amountField()}
      <div class="field"><label>Source</label><input id="f-name" placeholder="e.g. Monthly salary"></div>
      <div class="field"><label>Repeats on day of month</label><input id="f-day" type="number" min="1" max="28" value="1"></div>
      <p class="hint-text">💰 Recurring monthly income.</p>
      <button id="add-submit" class="btn-primary">Add income</button>`;
  }
  // incoming funds (one-off payment from a person)
  return `
    ${amountField()}
    <div class="field"><label>From</label><input id="f-name" placeholder="e.g. Dinner split — Wei"></div>
    <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayISO()}"></div>
    <p class="hint-text">🤝 A payment received from someone else.</p>
    <button id="add-submit" class="btn-primary">Add incoming funds</button>`;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function onAddSubmit() {
  const amount = parseFloat(($('#f-amount') || {}).value);
  if (!amount || amount <= 0) { toast('⚠️ Enter an amount greater than 0'); return; }
  const name = (($('#f-name') || {}).value || '').trim();
  const date = (($('#f-date') || {}).value) || todayISO();
  const type = STATE.addType;

  let tx;
  if (type === 'expense')   tx = { date, type: 'Expense',  category: STATE.addCategory, amount, name };
  else if (type === 'recurring') tx = { date: STATE.month + '-' + pad(($('#f-day')||{}).value), type: 'Expense', category: STATE.addCategory, amount, name, recurring: true };
  else if (type === 'income')    tx = { date: STATE.month + '-' + pad(($('#f-day')||{}).value), type: 'Income', category: 'Salary', amount, name, recurring: true };
  else                      tx = { date, type: 'Incoming', category: 'Transfer', amount, name };

  const btn = $('#add-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const created = await API.add(tx);
    // Drop it straight into the right month's cache so Home/History reflect it.
    const ym = (created.date || tx.date).slice(0, 7);
    if (STATE.cache[ym]) STATE.cache[ym].push(created); else invalidate(ym);
    haptic('success');
    toast('✅ Added ' + money(amount));
    STATE.month = ym;
    syncMonthPill();
    await ensureMonth(ym);
    switchTab('home');           // jump to Home so the user sees it land
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Could not save'));
    if (btn) { btn.disabled = false; btn.textContent = 'Add ' + STATE.addType; }
  }
}

// Telegram haptic feedback; no-op in a plain browser.
function haptic(kind) {
  try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(kind); } catch (_) {}
}
function pad(d) { return String(Math.max(1, Math.min(28, Number(d) || 1))).padStart(2, '0'); }

// ============================================================
//  VIEW: HISTORY  (expenses by month)
// ============================================================
function renderHistory() {
  const rows = txForMonth(STATE.month).filter((t) => t.type === 'Expense');
  const t = totals(STATE.month);

  // group by date
  const groups = {};
  for (const r of rows) (groups[r.date] = groups[r.date] || []).push(r);
  const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  const body = dates.length
    ? dates.map((d) => `<div class="tx-group-date">${dayLabel(d)}</div>${groups[d].map(txRow).join('')}`).join('')
    : emptyInline('No expenses this month');

  $('#view-history').innerHTML = `
    ${statusBanner()}
    <div class="card" style="display:flex;align-items:center;justify-content:space-between">
      <button class="month-pill" data-nav="-1">‹</button>
      <div style="text-align:center">
        <div style="font-weight:700">${monthLabel(STATE.month)}</div>
        <div style="font-size:13px;color:var(--neg);font-weight:700">${money(t.spent)} spent</div>
      </div>
      <button class="month-pill" data-nav="1">›</button>
    </div>
    <div class="card">${body}</div>`;

  $('#view-history').querySelectorAll('[data-nav]').forEach((b) =>
    b.addEventListener('click', async () => {
      STATE.month = shiftMonth(STATE.month, Number(b.dataset.nav));
      syncMonthPill();
      renderHistory();                 // paint immediately (shows Loading… banner)
      await ensureMonth(STATE.month);
      renderHistory();
    }));
}

// ============================================================
//  VIEW: CATEGORIES  (list filtered by category)
// ============================================================
function renderCategories() {
  const rows = txForMonth(STATE.month).filter((t) => t.type === 'Expense');

  // per-category totals for the breakdown
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + r.amount;
  const maxCat = Math.max(1, ...Object.values(byCat));
  const totalSpent = Object.values(byCat).reduce((a, b) => a + b, 0);

  const filterCats = ['All', ...Object.keys(CATEGORIES)];
  const chips = filterCats.map((c) =>
    `<button class="chip ${STATE.categoryFilter === c ? 'is-active' : ''}" data-filter="${c}">${c}</button>`
  ).join('');

  const filtered = STATE.categoryFilter === 'All' ? rows : rows.filter((r) => r.category === STATE.categoryFilter);

  const breakdown = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `
    <div class="bar-row">
      <div class="bar-head"><span>${catIcon(c)} ${escapeHtml(c)}</span><span>${money(v)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / maxCat) * 100}%;background:${catColor(c)}"></div></div>
    </div>`).join('');

  $('#view-categories').innerHTML = `
    ${statusBanner()}
    <div class="chips">${chips}</div>
    ${STATE.categoryFilter === 'All' ? `
      <div class="card">
        <p class="card-title">Breakdown · ${money(totalSpent)}</p>
        ${breakdown || emptyInline('No expenses this month')}
      </div>` : `
      <div class="card">
        <p class="card-title">${STATE.categoryFilter} · ${money(filtered.reduce((a, r) => a + r.amount, 0))}</p>
        ${filtered.length ? filtered.map(txRow).join('') : emptyInline('Nothing in ' + STATE.categoryFilter)}
      </div>`}`;

  $('#view-categories').querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => { STATE.categoryFilter = b.dataset.filter; renderCategories(); }));
}

// ============================================================
//  Tab navigation
// ============================================================
const TITLES = { home: 'Home', add: 'Add', history: 'History', categories: 'Categories' };
const RENDERERS = { home: renderHome, add: renderAdd, history: renderHistory, categories: renderCategories };

async function switchTab(tab) {
  STATE.activeTab = tab;
  $('#topbar-title').textContent = TITLES[tab];
  document.querySelectorAll('.tabview').forEach((v) => v.classList.add('hidden'));
  $('#view-' + tab).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  RENDERERS[tab]();                 // paint immediately (Add tab needs no data)
  $('.view').scrollTop = 0;
  // The data-backed tabs need the active month loaded; fetch then repaint.
  if (tab !== 'add') {
    await ensureMonth(STATE.month);
    if (STATE.activeTab === tab) RENDERERS[tab]();
  }
}

function syncMonthPill() { $('#month-pill').textContent = monthLabel(STATE.month); }

// --- Wire up -----------------------------------------------------
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

// Tapping the month pill takes you to History, where the month stepper lives.
$('#month-pill').addEventListener('click', () => switchTab('history'));

// Delete: one delegated handler covers tx rows in any view.
$('#app').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const id = del.dataset.del;
  const month = del.dataset.month;
  if (!id) { toast('⚠️ Missing id'); return; }
  const ok = (tg && tg.showConfirm)
    ? await new Promise((res) => tg.showConfirm('Delete this entry?', res))
    : window.confirm('Delete this entry?');
  if (!ok) return;
  del.disabled = true;
  try {
    await API.remove(id, month);
    invalidate(month);
    haptic('success');
    toast('🗑️ Deleted');
    await refreshActive();
  } catch (err) {
    haptic('error');
    toast('⚠️ ' + (err.message || 'Delete failed'));
    del.disabled = false;
  }
});

syncMonthPill();
switchTab('home');
