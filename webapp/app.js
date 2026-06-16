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

  // True fullscreen needs Bot API 8.0+. Older clients ignore this and just stay
  // expanded (tg.expand above), so it degrades gracefully.
  if (tg.isVersionAtLeast && tg.isVersionAtLeast('8.0')) {
    try { tg.requestFullscreen(); } catch (_) {}
    // Stop a downward swipe from collapsing/closing the app mid-scroll.
    tg.disableVerticalSwipes && tg.disableVerticalSwipes();

    // In fullscreen the status bar and Telegram's floating close/menu buttons sit
    // over our content, so push the UI down by the reported safe-area insets and
    // keep it in sync as they change (rotation, etc.).
    const applySafeArea = () => {
      const dev = (tg.safeAreaInset && tg.safeAreaInset.top) || 0;
      const content = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.top) || 0;
      document.documentElement.style.setProperty('--safe-top', (dev + content) + 'px');
    };
    applySafeArea();
    tg.onEvent && tg.onEvent('safeAreaChanged', applySafeArea);
    tg.onEvent && tg.onEvent('contentSafeAreaChanged', applySafeArea);
    tg.onEvent && tg.onEvent('fullscreenChanged', applySafeArea);
  }
}

// --- Category display styles ---
// Categories are user-editable and loaded from /api into STATE.categories. Known
// names get a hand-picked colour/icon; custom ones get a deterministic colour from
// the palette and a generic icon.
const CAT_STYLE = {
  Food:      { color: '#1faa6c', icon: '🍜' },
  Transport: { color: '#3b82f6', icon: '🚌' },
  Shopping:  { color: '#a855f7', icon: '🛍️' },
  Groceries: { color: '#14b8a6', icon: '🛒' },
  Bills:     { color: '#f59e0b', icon: '🧾' },
  Climbing:  { color: '#ef4444', icon: '🧗' },
  Others:    { color: '#8a909c', icon: '•' },
};
const CAT_PALETTE = ['#1faa6c', '#3b82f6', '#a855f7', '#14b8a6', '#f59e0b', '#ef4444',
  '#eab308', '#06b6d4', '#f43f5e', '#84cc16', '#6366f1', '#d946ef'];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const catColor = (c) => (CAT_STYLE[c] && CAT_STYLE[c].color) || CAT_PALETTE[hashStr(String(c)) % CAT_PALETTE.length];
const catIcon  = (c) => (CAT_STYLE[c] && CAT_STYLE[c].icon) || '•';

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
  budget: null,                   // last-fetched budget summary (see API.budgetGet)
  budgetMonth: null,              // the month STATE.budget was computed for
  categories: [],                 // user's category names (from /api)
  recurring: null,                // active recurring txs for the Recurring section (null = unloaded)
  editingId: null,                // id of the recurring tx being edited (else null)
  editingTx: null,                // the recurring tx object being edited (for prefill)
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
  async edit(id, patch) {
    const r = await fetch(`/api/transactions/${id}`, {
      method: 'PATCH', headers: this.headers(), body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(await detail(r) || `Edit failed (${r.status})`);
    return (await r.json()).transaction;
  },
  async recurring() {
    const r = await fetch('/api/recurring', { headers: this.headers() });
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    return (await r.json()).transactions;
  },
  async categories() {
    const r = await fetch('/api/categories', { headers: this.headers() });
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    return (await r.json()).categories;
  },
  async categoryAdd(name) {
    const r = await fetch('/api/categories', {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(await detail(r) || `Add failed (${r.status})`);
    return (await r.json()).categories;
  },
  async categoryRemove(name) {
    const r = await fetch(`/api/categories/${encodeURIComponent(name)}`, {
      method: 'DELETE', headers: this.headers(),
    });
    if (!r.ok) throw new Error(`Remove failed (${r.status})`);
    return (await r.json()).categories;
  },
  // Budget summary for `month`: { budget, left, spent_this_month, overall_surplus,
  // total_savings }. budget/left are null when no budget applies to that month.
  async budgetGet(month) {
    const r = await fetch(`/api/budget?month=${month}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`Budget load failed (${r.status})`);
    return await r.json();
  },
  async budgetSet(month, amount) {
    const r = await fetch(`/api/budget?month=${month}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ amount }),
    });
    if (!r.ok) throw new Error(`Budget save failed (${r.status})`);
    return await r.json();
  },
  async budgetRemove(month) {
    const r = await fetch(`/api/budget?month=${month}`, {
      method: 'DELETE', headers: this.headers(),
    });
    if (!r.ok) throw new Error(`Budget remove failed (${r.status})`);
    return await r.json();
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

// Pull FastAPI's {detail: "..."} message out of an error response, if present.
async function detail(r) {
  try { return (await r.clone().json()).detail; } catch (_) { return ''; }
}

// Budget totals span every month, so any add/delete can change the surplus and
// savings — force the next ensureBudget to refetch.
function invalidateBudget() { STATE.budgetMonth = null; }

// Load the user's categories once (kept in sync directly on add/remove).
async function ensureCategories({ force = false } = {}) {
  if (!force && STATE.categories.length) return;
  try {
    STATE.categories = await API.categories();
    if (!STATE.categories.includes(STATE.addCategory)) STATE.addCategory = STATE.categories[0] || '';
  } catch (e) {
    STATE.error = e.message || 'Could not load categories';
  }
}

// Load the active recurring transactions for the Recurring section.
async function ensureRecurring({ force = false } = {}) {
  if (!force && STATE.recurring) return;
  try {
    STATE.recurring = await API.recurring();
  } catch (e) {
    STATE.error = e.message || 'Could not load recurring';
    STATE.recurring = STATE.recurring || [];
  }
}

// Load the budget summary for `ym` if we don't already have it for that month.
async function ensureBudget(ym, { force = false } = {}) {
  if (!force && STATE.budgetMonth === ym && STATE.budget) return;
  try {
    STATE.budget = await API.budgetGet(ym);
    STATE.budgetMonth = ym;
  } catch (e) {
    STATE.error = e.message || 'Could not load budget';
  }
}

// Re-fetch the active month and re-render the current tab.
async function refreshActive() {
  await ensureMonth(STATE.month, { force: true });
  invalidateBudget();
  if (STATE.activeTab === 'home' || STATE.activeTab === 'budget') {
    await ensureBudget(STATE.month);
  }
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

// Clear a stuck :hover highlight from a button after a cancelled confirm dialog.
// On touch (incl. Telegram's webview, which reports hover capability) the tapped
// element keeps :hover until the next interaction, so the red ✕ lingers after you
// cancel a delete. blur() only drops :focus; toggling display forces the browser
// to re-evaluate hover with no pointer present, clearing it immediately.
function clearHover(el) {
  if (!el) return;
  const prev = el.style.display;
  el.style.display = 'none';
  void el.offsetHeight;   // force reflow
  el.style.display = prev;
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
        <div class="tx-sub">${pillHtml} · ${dayLabel(t.date)}${t.budget_excluded ? ' · <span class="off-budget">off-budget</span>' : ''}</div>
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
  // Total recurring expenses = sum of the user's active recurring expense items.
  // STATE.recurring is lazy-loaded (null until fetched); show "…" until it arrives.
  const recurringTotal = STATE.recurring ? STATE.recurring.reduce((a, r) => a + r.amount, 0) : null;
  $('#view-home').innerHTML = `
    ${statusBanner()}
    ${budgetCard(t)}

    <div class="card">
      <p class="card-title">Spent in ${monthLabel(STATE.month)}</p>
      <div class="amount-lg">${money(t.spent)}</div>
      <div class="sub-muted">Net ${t.net >= 0 ? '+' : '−'}${money(Math.abs(t.net))} this month</div>
    </div>

    <div class="stat-row">
      <div class="card stat">
        <div class="label">Income</div>
        <div class="value pos">${money(t.income)}</div>
      </div>
      <div class="card stat">
        <div class="label">Recurring expenses</div>
        <div class="value">${recurringTotal == null ? '…' : money(recurringTotal)}</div>
      </div>
    </div>

    <div class="card">
      <p class="card-title">Recent activity</p>
      ${recent.length ? recent.map(txRow).join('') : emptyInline('Nothing logged yet')}
    </div>`;

  // Lazy-load the recurring list the first time Home needs its total, then repaint.
  if (STATE.recurring === null) {
    ensureRecurring().then(() => { if (STATE.activeTab === 'home') renderHome(); });
  }
}

// Budget summary shown on Home as a prominent blue hero card: amount left to spend
// (or overspend) inline with its label, and this-month spending vs the budget.
function budgetCard(t) {
  const b = STATE.budget;
  // No budget configured for this month → invite the user to set one.
  if (!b || b.budget == null) {
    return `
      <div class="card">
        <p class="card-title">Budget · ${monthLabel(STATE.month)}</p>
        <div class="sub">No budget set for this month.</div>
        <button class="btn-primary" data-goto="budget">Set a budget</button>
      </div>`;
  }
  const left = b.left;                       // budget − spent (negative = overspent)
  const over = left < 0;
  return `
    <div class="card hero hero-budget">
      <p class="card-title">Budget · ${monthLabel(STATE.month)}</p>
      <div class="budget-amount-row">
        <span class="amount">${over ? '−' : ''}${money(Math.abs(left))}</span>
        <span class="budget-amount-label">${over ? 'over budget' : 'left to spend'}</span>
      </div>
      <div class="sub">${money(b.spent_this_month)} of ${money(b.budget)} used</div>
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

  // The Recurring section also lists every active recurring expense to edit/delete.
  const recurringList = STATE.addType === 'recurring'
    ? `<div class="card"><p class="card-title">Active recurring expenses</p>${recurringListBody()}</div>`
    : '';

  $('#view-add').innerHTML = `
    <div class="segmented">${seg}</div>
    <div class="card">${addForm(STATE.addType)}</div>
    ${recurringList}`;

  // Lazy-load the recurring list the first time the section is opened.
  if (STATE.addType === 'recurring' && STATE.recurring === null) {
    ensureRecurring().then(() => {
      if (STATE.activeTab === 'add' && STATE.addType === 'recurring') renderAdd();
    });
  }

  // wire segmented control (switching type cancels any in-progress edit)
  $('#view-add').querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => {
      STATE.addType = b.dataset.add;
      STATE.editingId = null; STATE.editingTx = null;
      renderAdd();
    }));

  // wire "edit" on a recurring row → prefill the form in update mode
  $('#view-add').querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => startEditRecurring(b.dataset.edit)));

  // wire "cancel edit" / "delete" inside the edit form
  const cancelEdit = $('#edit-cancel');
  if (cancelEdit) cancelEdit.addEventListener('click', () => {
    STATE.editingId = null; STATE.editingTx = null; renderAdd();
  });
  const editDelete = $('#edit-delete');
  if (editDelete) editDelete.addEventListener('click', onRecurringDelete);

  // wire category chips (only present for expense/recurring). Restyle in place
  // rather than re-rendering the form, which would wipe the amount/name the user
  // has already typed.
  $('#view-add').querySelectorAll('[data-cat]').forEach((c) =>
    c.addEventListener('click', () => {
      STATE.addCategory = c.dataset.cat;
      $('#view-add').querySelectorAll('[data-cat]').forEach((chip) => {
        const active = chip.dataset.cat === STATE.addCategory;
        chip.classList.toggle('is-active', active);
        chip.style.cssText = active
          ? `background:${catColor(chip.dataset.cat)};border-color:${catColor(chip.dataset.cat)};color:#fff`
          : '';
      });
    }));

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
  const chips = STATE.categories.map((c) => {
    const active = STATE.addCategory === c;
    const style = active ? `background:${catColor(c)};border-color:${catColor(c)};color:#fff` : '';
    return `<button data-cat="${escapeHtml(c)}" class="chip ${active ? 'is-active' : ''}" style="${style}">${catIcon(c)} ${escapeHtml(c)}</button>`;
  }).join('');
  const note = STATE.categories.length ? '' : `<p class="hint-text">No categories yet — add some in the Categories tab.</p>`;
  return `<div class="field"><label>Category</label><div class="cat-grid">${chips}</div>${note}</div>`;
}

// Toggle to keep a big-ticket expense out of the monthly budget. Expense/recurring
// only — the bot's messaging flow has no such option (everything counts there).
// Defaults OFF (counts toward budget) on every fresh form, so the exclusion is a
// deliberate per-entry choice that doesn't carry over to the next expense.
function excludeField(checked = false) {
  return `
    <label class="switch-field">
      <span class="switch-label">Exclude from monthly budget</span>
      <span class="switch">
        <input id="f-exclude" type="checkbox" ${checked ? 'checked' : ''}>
        <span class="slider"></span>
      </span>
    </label>
    <p class="hint-text">For big-ticket items you don't want counted against your budget. Still shows in total spending.</p>`;
}

// A recurring expense row. Tapping anywhere on the card opens it for editing
// (edit/delete live inside that form) — no per-row icons.
function recurringRow(t) {
  return `
    <div class="tx tappable" data-edit="${escapeHtml(t.id || '')}" role="button" tabindex="0">
      <div class="tx-icon" style="background:${catColor(t.category)}22;color:${catColor(t.category)}">${catIcon(t.category)}</div>
      <div class="tx-main">
        <div class="tx-name">${escapeHtml(t.name || '(no name)')}</div>
        <div class="tx-sub"><span class="pill" style="background:${catColor(t.category)}">${escapeHtml(t.category)}</span>${t.budget_excluded ? ' · <span class="off-budget">off-budget</span>' : ''}</div>
      </div>
      <div class="tx-amt">${money(t.amount)}</div>
      <span class="tx-chevron" aria-hidden="true">›</span>
    </div>`;
}

function recurringListBody() {
  if (STATE.recurring === null) return `<div class="banner">Loading…</div>`;
  if (!STATE.recurring.length) return emptyInline('No recurring expenses yet');
  return STATE.recurring.map(recurringRow).join('');
}

function startEditRecurring(id) {
  const tx = (STATE.recurring || []).find((t) => t.id === id);
  if (!tx) return;
  STATE.editingId = id;
  STATE.editingTx = tx;
  STATE.addCategory = tx.category;
  renderAdd();
  $('.view').scrollTop = 0;
}

async function onRecurringDelete() {
  if (!STATE.editingId || !STATE.editingTx) return;
  const ok = (tg && tg.showConfirm)
    ? await new Promise((res) => tg.showConfirm('Delete this recurring expense?', res))
    : window.confirm('Delete this recurring expense?');
  if (!ok) return;
  const id = STATE.editingId;
  const month = (STATE.editingTx.date || '').slice(0, 7);
  try {
    await API.remove(id, month);
    STATE.editingId = null; STATE.editingTx = null;
    STATE.recurring = null;   // reload the list
    STATE.cache = {};
    invalidateBudget();
    haptic('success');
    toast('🗑️ Deleted');
    renderAdd();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Delete failed'));
  }
}

function addForm(type) {
  if (type === 'expense') {
    return `
      <div class="field"><label>Name</label><input id="f-name" placeholder="e.g. Lunch — laksa"></div>
      ${amountField()}
      ${categoryField()}
      <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayISO()}"></div>
      ${excludeField()}
      <button id="add-submit" class="btn-primary">Add expense</button>`;
  }
  if (type === 'recurring') {
    const e = STATE.editingTx;  // set when editing an existing recurring item
    const nameVal = e ? escapeHtml(e.name || '') : '';
    const amtVal = e ? e.amount : '';
    return `
      <div class="field"><label>Name</label><input id="f-name" placeholder="e.g. Phone plan" value="${nameVal}"></div>
      <div class="field"><label>Amount</label><div class="amount-input"><span>$</span><input id="f-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01" min="0" value="${amtVal}"></div></div>
      ${categoryField()}
      ${excludeField(e ? e.budget_excluded : false)}
      <button id="add-submit" class="btn-primary">${e ? 'Update recurring expense' : 'Add recurring expense'}</button>
      ${e ? `<button id="edit-delete" class="btn-secondary">Delete recurring expense</button>
      <button id="edit-cancel" class="btn-ghost">Cancel edit</button>` : ''}`;
  }
  if (type === 'income') {
    return `
      <div class="field"><label>Source</label><input id="f-name" placeholder="e.g. Monthly salary"></div>
      ${amountField()}
      <p class="hint-text">Recurring monthly income.</p>
      <button id="add-submit" class="btn-primary">Add income</button>`;
  }
  // incoming funds (one-off payment from a person)
  return `
    <div class="field"><label>From</label><input id="f-name" placeholder="e.g. Dinner split — Wei"></div>
    ${amountField()}
    <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayISO()}"></div>
    <p class="hint-text">A payment received from someone else.</p>
    <button id="add-submit" class="btn-primary">Add incoming funds</button>`;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function onAddSubmit() {
  const amount = parseFloat(($('#f-amount') || {}).value);
  if (!amount || amount <= 0) { toast('⚠️ Enter an amount greater than 0'); return; }
  const name = (($('#f-name') || {}).value || '').trim();
  const type = STATE.addType;
  const budgetExcluded = !!(($('#f-exclude') || {}).checked);
  const btn = $('#add-submit');

  // Editing an existing recurring expense → PATCH instead of inserting.
  if (type === 'recurring' && STATE.editingId) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await API.edit(STATE.editingId, { category: STATE.addCategory, name, amount, budget_excluded: budgetExcluded });
      STATE.editingId = null; STATE.editingTx = null;
      STATE.recurring = null;   // reload the list
      STATE.cache = {};         // the edited row may be in any month
      invalidateBudget();
      haptic('success');
      toast('✅ Updated');
      renderAdd();
    } catch (e) {
      haptic('error');
      toast('⚠️ ' + (e.message || 'Could not save'));
      if (btn) { btn.disabled = false; btn.textContent = 'Update recurring expense'; }
    }
    return;
  }

  const date = (($('#f-date') || {}).value) || todayISO();
  let tx;
  if (type === 'expense')   tx = { date, type: 'Expense',  category: STATE.addCategory, amount, name, budget_excluded: budgetExcluded };
  else if (type === 'recurring') tx = { date: todayISO(), type: 'Expense', category: STATE.addCategory, amount, name, recurring: true, budget_excluded: budgetExcluded };
  else if (type === 'income')    tx = { date: todayISO(), type: 'Income', category: 'Salary', amount, name, recurring: true };
  else                      tx = { date, type: 'Incoming', category: 'Transfer', amount, name };

  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const created = await API.add(tx);
    // Drop it straight into the right month's cache so Home/History reflect it.
    const ym = (created.date || tx.date).slice(0, 7);
    if (STATE.cache[ym]) STATE.cache[ym].push(created); else invalidate(ym);
    invalidateBudget();           // surplus/savings/left changed
    if (tx.recurring) STATE.recurring = null;  // new recurring → reload its list
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

  const filterCats = ['All', ...STATE.categories];
  const chips = filterCats.map((c) =>
    `<button class="chip ${STATE.categoryFilter === c ? 'is-active' : ''}" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`
  ).join('');

  const filtered = STATE.categoryFilter === 'All' ? rows : rows.filter((r) => r.category === STATE.categoryFilter);

  const breakdown = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `
    <div class="bar-row">
      <div class="bar-head"><span>${catIcon(c)} ${escapeHtml(c)}</span><span>${money(v)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / maxCat) * 100}%;background:${catColor(c)}"></div></div>
    </div>`).join('');

  // Manage categories: a clickable bar that opens the edit popup.
  const manageBar = `<button class="manage-bar" id="manage-cats">Manage categories<span class="chev">›</span></button>`;

  $('#view-categories').innerHTML = `
    ${statusBanner()}
    <div class="chips">${chips}</div>
    ${STATE.categoryFilter === 'All' ? `
      <div class="card">
        <p class="card-title">Breakdown · ${money(totalSpent)}</p>
        ${breakdown || emptyInline('No expenses this month')}
      </div>` : `
      <div class="card">
        <p class="card-title">${escapeHtml(STATE.categoryFilter)} · ${money(filtered.reduce((a, r) => a + r.amount, 0))}</p>
        ${filtered.length ? filtered.map(txRow).join('') : emptyInline('Nothing in ' + STATE.categoryFilter)}
      </div>`}
    ${manageBar}`;

  $('#view-categories').querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => { STATE.categoryFilter = b.dataset.filter; renderCategories(); }));

  const manageBtn = $('#manage-cats');
  if (manageBtn) manageBtn.addEventListener('click', openCategoryModal);
}

// --- Category manage popup ----------------------------------------
function categoryTagsHtml() {
  const tags = STATE.categories.map((c) =>
    `<span class="cat-tag" style="border-color:${catColor(c)}">${catIcon(c)} ${escapeHtml(c)}<button class="cat-x" data-rmcat="${escapeHtml(c)}" aria-label="Remove">✕</button></span>`
  ).join('');
  return tags || '<span class="sub">No categories yet.</span>';
}

function openCategoryModal() {
  const root = document.createElement('div');
  root.className = 'modal-overlay';
  root.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-head"><span>Manage categories</span><button class="modal-close" aria-label="Close">✕</button></div>
      <div class="cat-manage">
        <input id="new-cat" placeholder="New category" maxlength="24">
        <button id="add-cat" class="btn-mini">Add</button>
      </div>
      <div class="cat-list" id="modal-cat-list">${categoryTagsHtml()}</div>
    </div>`;
  document.body.appendChild(root);
  wireCategoryModal(root);
  // Intentionally don't autofocus the input — that would pop the keyboard the moment
  // the popup opens. The user taps the field when they actually want to add one.
}

function wireCategoryModal(root) {
  // Close on backdrop tap or the ✕.
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('.modal-close')) closeCategoryModal();
  });
  const addCat = $('#add-cat', root);
  if (addCat) addCat.addEventListener('click', onCategoryAdd);
  const newCat = $('#new-cat', root);
  if (newCat) newCat.addEventListener('keydown', (e) => { if (e.key === 'Enter') onCategoryAdd(); });
  root.querySelectorAll('[data-rmcat]').forEach((b) =>
    b.addEventListener('click', () => onCategoryRemove(b.dataset.rmcat, b)));
}

function closeCategoryModal() {
  const root = $('.modal-overlay');
  if (root) root.remove();
  renderCategories();  // refresh the tab's filter chips behind the popup
}

// Re-render just the popup's category list (after add/remove) without closing it.
function refreshCategoryModal() {
  const list = $('#modal-cat-list');
  if (!list) return;
  list.innerHTML = categoryTagsHtml();
  list.querySelectorAll('[data-rmcat]').forEach((b) =>
    b.addEventListener('click', () => onCategoryRemove(b.dataset.rmcat, b)));
}

async function onCategoryAdd() {
  const input = $('#new-cat');
  const name = (input && input.value || '').trim();
  if (!name) { toast('⚠️ Enter a category name'); return; }
  try {
    STATE.categories = await API.categoryAdd(name);
    if (input) input.value = '';
    haptic('success');
    refreshCategoryModal();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Could not add'));
  }
}

async function onCategoryRemove(name, btn) {
  const ok = (tg && tg.showConfirm)
    ? await new Promise((res) => tg.showConfirm(`Remove category "${name}"? Past expenses keep it.`, res))
    : window.confirm(`Remove category "${name}"?`);
  // Cancelled → clear the stuck hover highlight on the ✕ without re-rendering.
  if (!ok) { clearHover(btn); return; }
  try {
    STATE.categories = await API.categoryRemove(name);
    if (STATE.categoryFilter === name) STATE.categoryFilter = 'All';
    if (STATE.addCategory === name) STATE.addCategory = STATE.categories[0] || '';
    haptic('success');
    refreshCategoryModal();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Could not remove'));
  }
}

// ============================================================
//  VIEW: BUDGET  (total savings + set / edit / remove budget)
// ============================================================
function renderBudget() {
  const b = STATE.budget;
  const savings = b ? b.total_savings : null;
  const hasBudget = b && b.budget != null;
  const surplus = b ? b.overall_surplus : null;

  $('#view-budget').innerHTML = `
    ${statusBanner()}
    <div class="card hero">
      <p class="card-title">Total savings</p>
      <div class="amount">${savings == null ? '—' : (savings < 0 ? '−' : '') + money(Math.abs(savings))}</div>
      <div class="sub">All income minus all expenses, across every month</div>
    </div>

    <div class="card hero ${surplus == null ? '' : (surplus < 0 ? 'hero-neg' : 'hero-pos')}">
      <p class="card-title">Overall budget surplus</p>
      <div class="amount">${surplus == null ? '—' : (surplus < 0 ? '−' : '+') + money(Math.abs(surplus))}</div>
      <div class="sub">Budget minus spending, summed across every budgeted month</div>
    </div>

    <div class="card">
      <p class="card-title">Monthly budget</p>
      <div class="field">
        <label>Budget amount</label>
        <div class="amount-input"><span>$</span><input id="b-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01" min="0" value="${hasBudget ? b.budget : ''}"></div>
      </div>
      <p class="hint-text">Applies from ${monthLabel(thisMonthISO())} onward. Past months keep their budget.</p>
      <button id="b-save" class="btn-primary">${hasBudget ? 'Update budget' : 'Set budget'}</button>
      ${hasBudget ? `<button id="b-remove" class="btn-secondary">Remove budget</button>` : ''}
    </div>`;

  const save = $('#b-save');
  if (save) save.addEventListener('click', onBudgetSave);
  const remove = $('#b-remove');
  if (remove) remove.addEventListener('click', onBudgetRemove);
}

async function onBudgetSave() {
  const amount = parseFloat(($('#b-amount') || {}).value);
  if (!amount || amount <= 0) { toast('⚠️ Budget must be greater than 0'); return; }
  const btn = $('#b-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const month = thisMonthISO();
    STATE.budget = await API.budgetSet(month, amount);
    STATE.budgetMonth = month;
    haptic('success');
    toast('✅ Budget saved');
    renderBudget();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Could not save'));
    if (btn) { btn.disabled = false; btn.textContent = 'Set budget'; }
  }
}

async function onBudgetRemove() {
  const ok = (tg && tg.showConfirm)
    ? await new Promise((res) => tg.showConfirm('Remove your monthly budget?', res))
    : window.confirm('Remove your monthly budget?');
  if (!ok) return;
  const btn = $('#b-remove');
  if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
  try {
    const month = thisMonthISO();
    STATE.budget = await API.budgetRemove(month);
    STATE.budgetMonth = month;
    haptic('success');
    toast('🗑️ Budget removed');
    renderBudget();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Could not remove'));
    if (btn) { btn.disabled = false; btn.textContent = 'Remove budget'; }
  }
}

// ============================================================
//  Tab navigation
// ============================================================
const TITLES = { home: 'Home', add: 'Add', history: 'History', categories: 'Categories', budget: 'Budget' };
const RENDERERS = { home: renderHome, add: renderAdd, history: renderHistory, categories: renderCategories, budget: renderBudget };

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
    // Home reflects the month being viewed; the Budget tab always edits the
    // current calendar month (budget changes apply from now on).
    if (tab === 'home') await ensureBudget(STATE.month);
    else if (tab === 'budget') await ensureBudget(thisMonthISO());
    if (STATE.activeTab === tab) RENDERERS[tab]();
  }
}

function syncMonthPill() { $('#month-pill').textContent = monthLabel(STATE.month); }

// --- Wire up -----------------------------------------------------
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

// Tapping the month pill takes you to History, where the month stepper lives.
$('#month-pill').addEventListener('click', () => switchTab('history'));

// Buttons that just navigate to another tab (e.g. Home's "Set a budget").
$('#app').addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) switchTab(goto.dataset.goto);
});

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
  // Cancelled → clear the stuck hover/focus highlight without re-rendering the view.
  if (!ok) { del.blur(); clearHover(del); return; }
  del.disabled = true;
  try {
    await API.remove(id, month);
    invalidate(month);
    invalidateBudget();
    if (del.dataset.recurring) STATE.recurring = null;  // reload the recurring list
    haptic('success');
    toast('🗑️ Deleted');
    await refreshActive();
  } catch (err) {
    haptic('error');
    toast('⚠️ ' + (err.message || 'Delete failed'));
    del.disabled = false;
  }
});

// Initial load: keep the full-screen loader up until categories + the first
// month's data have been fetched and Home has painted, then reveal the app.
syncMonthPill();
(async () => {
  try {
    await ensureCategories();
    await switchTab('home');
  } finally {
    const loader = $('#loader');
    if (loader) loader.classList.add('hidden');
  }
})();
