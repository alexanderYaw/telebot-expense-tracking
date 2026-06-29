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
  Others:    { color: '#8a909c', icon: '•' },
};
const CAT_PALETTE = ['#1faa6c', '#3b82f6', '#a855f7', '#14b8a6', '#f59e0b', '#ef4444',
  '#eab308', '#06b6d4', '#f43f5e', '#84cc16', '#6366f1', '#d946ef'];
// Quick-pick emojis for the new-category form. The icon "field" is a display-only
// element (not a text input), so the user can ONLY set the emoji by tapping one of
// these — there's nothing to tap into and type.
const EMOJI_CHOICES = ['🍜', '🍔', '☕', '🛒', '🛍️', '🚌', '🚗', '⛽', '🏠', '💡',
  '🧾', '💊', '🏥', '🎬', '🎮', '✈️', '🏋️', '🧗', '🐶', '🎁', '💰', '📚', '👕', '💅'];
// Built-in pseudo-category for received one-off payments (type 'Incoming'). It is
// NOT a user expense category — it never lives in STATE.categories and can't be
// chosen when adding an expense. It exists only to group/filter Incoming payments
// in the Categories tab. The name is reserved server-side so a user can't create an
// expense category that collides with it.
const INCOMING_CAT = 'Incoming';
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
// Resolution order: the user's chosen icon/colour for the category (from /api) →
// a hand-picked style for known default names → a deterministic palette colour and
// a generic icon. STATE.categoryMeta is populated whenever categories are loaded.
const catColor = (c) => (STATE.categoryMeta[c] && STATE.categoryMeta[c].color)
  || (CAT_STYLE[c] && CAT_STYLE[c].color)
  || CAT_PALETTE[hashStr(String(c)) % CAT_PALETTE.length];
const catIcon = (c) => (STATE.categoryMeta[c] && STATE.categoryMeta[c].icon)
  || (CAT_STYLE[c] && CAT_STYLE[c].icon) || '•';

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
  categoryMeta: {},               // name -> {icon, color} chosen by the user (from /api)
  recurring: null,                // active recurring txs for the Recurring section (null = unloaded)
  income: null,                   // income entries for the Income section (null = unloaded)
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
  // One request for the whole Home screen: { transactions, recurring, categories, budget }.
  async home(month) {
    const r = await fetch(`/api/home?month=${month}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    return await r.json();
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
  async income() {
    const r = await fetch('/api/income', { headers: this.headers() });
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    return (await r.json()).transactions;
  },
  async categories() {
    const r = await fetch('/api/categories', { headers: this.headers() });
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    return (await r.json()).categories;
  },
  async categoryAdd(name, icon, color) {
    const r = await fetch('/api/categories', {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ name, icon: icon || '', color: color || '' }),
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

// Store the category list from /api: names (for the rest of the app) plus a
// name -> {icon, color} map for catColor/catIcon. Accepts the new object form and,
// defensively, a plain-string form.
function setCategories(list) {
  const arr = (list || []).map((c) => (typeof c === 'string' ? { name: c } : c));
  STATE.categories = arr.map((c) => c.name);
  STATE.categoryMeta = {};
  for (const c of arr) STATE.categoryMeta[c.name] = { icon: c.icon || '', color: c.color || '' };
  if (!STATE.categories.includes(STATE.addCategory)) STATE.addCategory = STATE.categories[0] || '';
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

// Load the income entries for the Income section.
async function ensureIncome({ force = false } = {}) {
  if (!force && STATE.income) return;
  try {
    STATE.income = await API.income();
  } catch (e) {
    STATE.error = e.message || 'Could not load income';
    STATE.income = STATE.income || [];
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

// Load everything the Home screen needs in a single /api/home request: the month's
// transactions, the recurring list, categories and the budget summary. Populates the
// same STATE caches the per-resource loaders use, so the other tabs keep working.
async function ensureHome(ym, { force = false } = {}) {
  if (!force && STATE.cache[ym] && STATE.recurring && STATE.categories.length
      && STATE.budgetMonth === ym && STATE.budget) return;
  STATE.loading = true;
  STATE.error = null;
  try {
    const d = await API.home(ym);
    STATE.cache[ym] = d.transactions;
    STATE.recurring = d.recurring;
    setCategories(d.categories);
    STATE.budget = d.budget;
    STATE.budgetMonth = ym;
  } catch (e) {
    STATE.error = e.message || 'Could not load data';
    STATE.cache[ym] = STATE.cache[ym] || [];
  } finally {
    STATE.loading = false;
  }
}

// Re-fetch the active tab's data and re-render. Home pulls everything in one request.
async function refreshActive() {
  invalidateBudget();   // any add/delete can change the surplus / savings / left
  if (STATE.activeTab === 'home') {
    await ensureHome(STATE.month, { force: true });
  } else {
    await ensureMonth(STATE.month, { force: true });
    if (STATE.activeTab === 'budget') await ensureBudget(STATE.month);
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
    <div class="tx tappable" data-edit-tx="${escapeHtml(t.id || '')}" data-month="${(t.date || '').slice(0, 7)}" role="button" tabindex="0">
      <div class="tx-icon" style="background:${iconBg}22;color:${t.type==='Expense'?catColor(t.category):'var(--pos)'}">${icon}</div>
      <div class="tx-main">
        <div class="tx-name">${escapeHtml(t.name || '(no name)')}${t.recurring ? ' 🔁' : ''}</div>
        <div class="tx-sub">${pillHtml} · ${dayLabel(t.date)}${t.budget_excluded ? ' · <span class="off-budget">off-budget</span>' : ''}</div>
      </div>
      <div class="tx-amt ${isIn ? 'pos' : ''}">${sign}${money(t.amount)}</div>
      <span class="tx-chevron" aria-hidden="true">›</span>
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
      <p class="card-title">Expenditure in ${monthLabel(STATE.month)}</p>
      <div class="amount-lg">${money(t.spent)}</div>
      <div class="sub-muted">Net ${t.net >= 0 ? '+' : '−'}<span class="${t.net >= 0 ? 'pos' : 'neg'}">${money(Math.abs(t.net))}</span> this month</div>
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
}

// Budget summary shown on Home as a prominent blue hero card: amount left to spend
// (or overspend) inline with its label, and this-month spending vs the budget.
function budgetCard(t) {
  const b = STATE.budget;
  // No budget configured for this month → invite the user to set one.
  if (!b || b.budget == null) {
    return `
      <div class="card">
        <p class="card-title">Budget spent · ${monthLabel(STATE.month)}</p>
        <div class="sub">No budget set for this month.</div>
        <button class="btn-primary" data-goto="budget">Set a budget</button>
      </div>`;
  }
  const left = b.left;                       // budget − spent (negative = overspent)
  const over = left < 0;
  return `
    <div class="card hero hero-budget">
      <p class="card-title">Budget spent · ${monthLabel(STATE.month)}</p>
      <div class="budget-amount-row">
        <span class="amount">${money(b.spent_this_month)}</span>
      </div>
      <div class="sub">${money(Math.abs(left))} <span class="budget-state${over ? ' is-over' : ' is-under'}">${over ? 'over budget' : 'left to spend'}</span></div>
    </div>`;
}

function emptyInline(msg) {
  return `<div class="empty"><div class="big">🗒️</div>${msg}</div>`;
}

// =======================================
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

  // The Recurring / Income sections also list existing entries to edit/delete.
  const recurringList = STATE.addType === 'recurring'
    ? `<div class="card"><p class="card-title">Active recurring expenses</p>${recurringListBody()}</div>`
    : '';
  const incomeList = STATE.addType === 'income'
    ? `<div class="card"><p class="card-title">Active income</p>${incomeListBody()}</div>`
    : '';

  $('#view-add').innerHTML = `
    <div class="segmented">${seg}</div>
    <div class="card">${addForm(STATE.addType)}</div>
    ${recurringList}${incomeList}`;

  // Lazy-load the relevant list the first time the section is opened.
  if (STATE.addType === 'recurring' && STATE.recurring === null) {
    ensureRecurring().then(() => {
      if (STATE.activeTab === 'add' && STATE.addType === 'recurring') renderAdd();
    });
  }
  if (STATE.addType === 'income' && STATE.income === null) {
    ensureIncome().then(() => {
      if (STATE.activeTab === 'add' && STATE.addType === 'income') renderAdd();
    });
  }

  // wire segmented control (switching type cancels any in-progress edit)
  $('#view-add').querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => {
      STATE.addType = b.dataset.add;
      STATE.editingId = null; STATE.editingTx = null;
      renderAdd();
    }));

  // wire "edit" on a recurring/income row → prefill the form in update mode
  $('#view-add').querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => startEdit(b.dataset.edit)));

  // wire "cancel edit" / "delete" inside the edit form
  const cancelEdit = $('#edit-cancel');
  if (cancelEdit) cancelEdit.addEventListener('click', () => {
    STATE.editingId = null; STATE.editingTx = null; renderAdd();
  });
  const editDelete = $('#edit-delete');
  if (editDelete) editDelete.addEventListener('click', onEditDelete);

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

// An income row. Tapping anywhere opens it for editing (edit/delete in that form).
function incomeRow(t) {
  return `
    <div class="tx tappable" data-edit="${escapeHtml(t.id || '')}" role="button" tabindex="0">
      <div class="tx-icon" style="background:var(--pos)22;color:var(--pos)">💰</div>
      <div class="tx-main">
        <div class="tx-name">${escapeHtml(t.name || '(no name)')}</div>
        <div class="tx-sub"><span class="pill" style="background:var(--pos)">Income</span></div>
      </div>
      <div class="tx-amt pos">${money(t.amount)}</div>
      <span class="tx-chevron" aria-hidden="true">›</span>
    </div>`;
}

function incomeListBody() {
  if (STATE.income === null) return `<div class="banner">Loading…</div>`;
  if (!STATE.income.length) return emptyInline('No income yet');
  return STATE.income.map(incomeRow).join('');
}

// Open the form in edit mode for the tapped row — recurring expense or income,
// depending on which section is active.
function startEdit(id) {
  if (STATE.addType === 'income') return startEditIncome(id);
  return startEditRecurring(id);
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

function startEditIncome(id) {
  const tx = (STATE.income || []).find((t) => t.id === id);
  if (!tx) return;
  STATE.editingId = id;
  STATE.editingTx = tx;
  renderAdd();
  $('.view').scrollTop = 0;
}

// Delete the entry currently being edited (recurring expense or income).
async function onEditDelete() {
  if (!STATE.editingId || !STATE.editingTx) return;
  const isIncome = STATE.addType === 'income';
  const label = isIncome ? 'income' : 'recurring expense';
  const ok = (tg && tg.showConfirm)
    ? await new Promise((res) => tg.showConfirm(`Delete this ${label}?`, res))
    : window.confirm(`Delete this ${label}?`);
  if (!ok) return;
  const id = STATE.editingId;
  const month = (STATE.editingTx.date || '').slice(0, 7);
  try {
    await API.remove(id, month);
    STATE.editingId = null; STATE.editingTx = null;
    if (isIncome) STATE.income = null; else STATE.recurring = null;   // reload the list
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
    const e = STATE.editingTx;  // set when editing an existing income entry
    const nameVal = e ? escapeHtml(e.name || '') : '';
    const amtVal = e ? e.amount : '';
    return `
      <div class="field"><label>Source</label><input id="f-name" placeholder="e.g. Monthly salary" value="${nameVal}"></div>
      <div class="field"><label>Amount</label><div class="amount-input"><span>$</span><input id="f-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01" min="0" value="${amtVal}"></div></div>
      <p class="hint-text">Recurring monthly income.</p>
      <button id="add-submit" class="btn-primary">${e ? 'Update income' : 'Add income'}</button>
      ${e ? `<button id="edit-delete" class="btn-secondary">Delete income</button>
      <button id="edit-cancel" class="btn-ghost">Cancel edit</button>` : ''}`;
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

  // Editing an existing income entry → PATCH name/amount instead of inserting.
  if (type === 'income' && STATE.editingId) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await API.edit(STATE.editingId, { name, amount });
      STATE.editingId = null; STATE.editingTx = null;
      STATE.income = null;   // reload the list
      STATE.cache = {};      // the edited row may be in any month
      invalidateBudget();
      haptic('success');
      toast('✅ Updated');
      renderAdd();
    } catch (e) {
      haptic('error');
      toast('⚠️ ' + (e.message || 'Could not save'));
      if (btn) { btn.disabled = false; btn.textContent = 'Update income'; }
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
    // New entry → reload the relevant section list.
    if (tx.type === 'Income') STATE.income = null;
    else if (tx.recurring) STATE.recurring = null;
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
  const monthRows = txForMonth(STATE.month);
  const rows = monthRows.filter((t) => t.type === 'Expense');
  // Received one-off payments, grouped under the built-in "Incoming" pseudo-category.
  const incomingRows = monthRows.filter((t) => t.type === 'Incoming');

  // per-category totals for the breakdown (expenses only)
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + r.amount;
  const maxCat = Math.max(1, ...Object.values(byCat));
  const totalSpent = Object.values(byCat).reduce((a, b) => a + b, 0);

  // All + the user's expense categories + the built-in Incoming filter (only shown
  // when there are payments to browse, so it doesn't clutter an empty month).
  const filterCats = ['All', ...STATE.categories];
  // Keep the chip while it's the active filter so an empty month isn't a dead-end.
  if (incomingRows.length || STATE.categoryFilter === INCOMING_CAT) filterCats.push(INCOMING_CAT);
  const chips = filterCats.map((c) => {
    const label = c === INCOMING_CAT ? '🤝 ' + escapeHtml(c) : escapeHtml(c);
    return `<button class="chip ${STATE.categoryFilter === c ? 'is-active' : ''}" data-filter="${escapeHtml(c)}">${label}</button>`;
  }).join('');

  const breakdown = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `
    <div class="bar-row">
      <div class="bar-head"><span>${catIcon(c)} ${escapeHtml(c)}</span><span>${money(v)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / maxCat) * 100}%;background:${catColor(c)}"></div></div>
    </div>`).join('');

  // Body card depends on the active filter: All → breakdown; Incoming → received
  // payments; any expense category → that category's expenses.
  let bodyCard;
  if (STATE.categoryFilter === 'All') {
    bodyCard = `
      <div class="card">
        <p class="card-title">Breakdown · ${money(totalSpent)}</p>
        ${breakdown || emptyInline('No expenses this month')}
      </div>`;
  } else if (STATE.categoryFilter === INCOMING_CAT) {
    const total = incomingRows.reduce((a, r) => a + r.amount, 0);
    bodyCard = `
      <div class="card">
        <p class="card-title">🤝 Incoming · ${money(total)}</p>
        ${incomingRows.length ? incomingRows.map(txRow).join('') : emptyInline('No incoming payments this month')}
      </div>`;
  } else {
    const filtered = rows.filter((r) => r.category === STATE.categoryFilter);
    bodyCard = `
      <div class="card">
        <p class="card-title">${escapeHtml(STATE.categoryFilter)} · ${money(filtered.reduce((a, r) => a + r.amount, 0))}</p>
        ${filtered.length ? filtered.map(txRow).join('') : emptyInline('Nothing in ' + STATE.categoryFilter)}
      </div>`;
  }

  // Manage categories: a clickable bar that opens the edit popup.
  const manageBar = `<button class="manage-bar" id="manage-cats">Manage categories<span class="chev">›</span></button>`;

  $('#view-categories').innerHTML = `
    ${statusBanner()}
    <div class="chips">${chips}</div>
    ${bodyCard}
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
      <div class="cat-create">
        <div class="cat-create-top">
          <span id="new-cat-icon" class="emoji-input emoji-display is-placeholder" data-icon="" role="img" aria-label="Chosen emoji">🙂</span>
          <input id="new-cat" placeholder="New category" maxlength="24">
        </div>
        <div class="emoji-picker" id="emoji-picker">${EMOJI_CHOICES.map((e) =>
          `<button class="emoji-opt" type="button" data-emoji="${e}">${e}</button>`
        ).join('')}</div>
        <div class="swatches" id="cat-swatches">${CAT_PALETTE.map((col, i) =>
          `<button class="swatch${i === 0 ? ' is-active' : ''}" data-color="${col}" style="background:${col}" aria-label="Colour"></button>`
        ).join('')}</div>
        <button id="add-cat" class="btn-mini btn-block">Add category</button>
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
  // Emoji quick-pick: tapping one sets the chosen emoji. The icon "field" is a
  // display-only <span> (not an input), so the palette is the ONLY way to pick — the
  // user can't tap into it and type. onCategoryAdd reads iconEl.dataset.icon.
  root.querySelectorAll('#emoji-picker .emoji-opt').forEach((b) =>
    b.addEventListener('click', () => {
      const iconEl = $('#new-cat-icon', root);
      if (iconEl) {
        iconEl.dataset.icon = b.dataset.emoji;
        iconEl.textContent = b.dataset.emoji;
        iconEl.classList.remove('is-placeholder');
      }
      root.querySelectorAll('#emoji-picker .emoji-opt').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
    }));
  // Colour swatches: tapping one selects it (single active swatch).
  root.querySelectorAll('#cat-swatches .swatch').forEach((s) =>
    s.addEventListener('click', () => {
      root.querySelectorAll('#cat-swatches .swatch').forEach((x) => x.classList.remove('is-active'));
      s.classList.add('is-active');
    }));
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
  const root = $('.modal-overlay');
  const nameEl = $('#new-cat', root);
  const name = ((nameEl && nameEl.value) || '').trim();
  if (!name) { toast('⚠️ Enter a category name'); return; }
  const iconEl = $('#new-cat-icon', root);
  const icon = ((iconEl && iconEl.dataset.icon) || '').trim();
  const sw = $('#cat-swatches .swatch.is-active', root);
  const color = sw ? sw.dataset.color : '';
  try {
    setCategories(await API.categoryAdd(name, icon, color));
    if (nameEl) nameEl.value = '';
    if (iconEl) { iconEl.dataset.icon = ''; iconEl.textContent = '🙂'; iconEl.classList.add('is-placeholder'); }
    root.querySelectorAll('#emoji-picker .emoji-opt.is-active').forEach((x) => x.classList.remove('is-active'));
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
    setCategories(await API.categoryRemove(name));
    if (STATE.categoryFilter === name) STATE.categoryFilter = 'All';
    haptic('success');
    refreshCategoryModal();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Could not remove'));
  }
}

// ============================================================
//  Edit / delete a transaction (popup)
// ============================================================
// Tapping any transaction row opens this popup; delete lives inside it (rows no
// longer carry an inline ✕). The PATCH endpoint supports name/amount/category/
// budget_excluded — date and type aren't editable here.
function openTxEditModal(id, month) {
  const tx = (STATE.cache[month] || []).find((t) => t.id === id);
  if (!tx) { toast('⚠️ Could not find that entry'); return; }
  const isExpense = tx.type === 'Expense';
  const kind = isExpense ? 'expense' : (tx.type === 'Income' ? 'income' : 'incoming');
  const nameLabel = tx.type === 'Income' ? 'Source' : (tx.type === 'Incoming' ? 'From' : 'Name');

  // Category chips + budget-exclusion toggle only apply to expenses.
  const catChips = isExpense ? STATE.categories.map((c) => {
    const active = tx.category === c;
    const style = active ? `background:${catColor(c)};border-color:${catColor(c)};color:#fff` : '';
    return `<button data-ecat="${escapeHtml(c)}" class="chip ${active ? 'is-active' : ''}" style="${style}">${catIcon(c)} ${escapeHtml(c)}</button>`;
  }).join('') : '';
  const catField = isExpense ? `<div class="field"><label>Category</label><div class="cat-grid">${catChips}</div></div>` : '';
  const excludeField = isExpense ? `
    <label class="switch-field">
      <span class="switch-label">Exclude from monthly budget</span>
      <span class="switch"><input id="e-exclude" type="checkbox" ${tx.budget_excluded ? 'checked' : ''}><span class="slider"></span></span>
    </label>` : '';

  const root = document.createElement('div');
  root.className = 'modal-overlay';
  root.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-head"><span>Edit ${kind} · ${dayLabel(tx.date)}</span><button class="modal-close" aria-label="Close">✕</button></div>
      <div class="field"><label>${nameLabel}</label><input id="e-name" value="${escapeHtml(tx.name || '')}"></div>
      <div class="field"><label>Amount</label><div class="amount-input"><span>$</span><input id="e-amount" type="number" inputmode="decimal" step="0.01" min="0" value="${tx.amount}"></div></div>
      ${catField}
      ${excludeField}
      <button id="e-save" class="btn-primary">Save changes</button>
      <button id="e-delete" class="btn-secondary">Delete</button>
    </div>`;
  document.body.appendChild(root);

  // Track the chosen category as the user taps chips (expense only).
  const chosen = { category: tx.category };
  root.querySelectorAll('[data-ecat]').forEach((c) =>
    c.addEventListener('click', () => {
      chosen.category = c.dataset.ecat;
      root.querySelectorAll('[data-ecat]').forEach((chip) => {
        const active = chip.dataset.ecat === chosen.category;
        chip.classList.toggle('is-active', active);
        chip.style.cssText = active ? `background:${catColor(chip.dataset.ecat)};border-color:${catColor(chip.dataset.ecat)};color:#fff` : '';
      });
    }));

  // Close on backdrop tap or the ✕.
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('.modal-close')) root.remove();
  });
  $('#e-save', root).addEventListener('click', () => onTxEditSave(tx, month, chosen, root));
  $('#e-delete', root).addEventListener('click', () => onTxDelete(tx, month, root));
}

async function onTxEditSave(tx, month, chosen, root) {
  const amount = parseFloat(($('#e-amount', root) || {}).value);
  if (!amount || amount <= 0) { toast('⚠️ Enter an amount greater than 0'); return; }
  const name = (($('#e-name', root) || {}).value || '').trim();
  const patch = { name, amount };
  if (tx.type === 'Expense') {
    patch.category = chosen.category;
    patch.budget_excluded = !!(($('#e-exclude', root) || {}).checked);
  }
  const btn = $('#e-save', root);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await API.edit(tx.id, patch);
    invalidate(month);
    invalidateBudget();
    if (tx.type === 'Income') STATE.income = null;   // keep the section lists fresh
    else if (tx.recurring) STATE.recurring = null;
    haptic('success');
    toast('✅ Updated');
    root.remove();
    await refreshActive();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Could not save'));
    if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
  }
}

async function onTxDelete(tx, month, root) {
  const ok = (tg && tg.showConfirm)
    ? await new Promise((res) => tg.showConfirm('Delete this entry?', res))
    : window.confirm('Delete this entry?');
  if (!ok) return;
  const btn = $('#e-delete', root);
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    await API.remove(tx.id, month);
    invalidate(month);
    invalidateBudget();
    if (tx.type === 'Income') STATE.income = null;   // keep the section lists fresh
    else if (tx.recurring) STATE.recurring = null;
    haptic('success');
    toast('🗑️ Deleted');
    root.remove();
    await refreshActive();
  } catch (e) {
    haptic('error');
    toast('⚠️ ' + (e.message || 'Delete failed'));
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
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
    <div class="card">
      <p class="card-title">Monthly budget</p>
      <div class="field">
        <label>Budget amount</label>
        <div class="amount-input"><span>$</span><input id="b-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01" min="0" value="${hasBudget ? b.budget : ''}"></div>
      </div>
      <p class="hint-text">Applies from ${monthLabel(thisMonthISO())} onward. Past months keep their budget.</p>
      <button id="b-save" class="btn-primary">${hasBudget ? 'Update budget' : 'Set budget'}</button>
      ${hasBudget ? `<button id="b-remove" class="btn-secondary">Remove budget</button>` : ''}
    </div>

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
  if (tab === 'home') {
    await ensureHome(STATE.month);  // tx + recurring + categories + budget in one request
  } else if (tab !== 'add') {
    await ensureMonth(STATE.month);
    // The Budget tab always edits the current calendar month (changes apply from now on).
    if (tab === 'budget') await ensureBudget(thisMonthISO());
  }
  if (tab !== 'add' && STATE.activeTab === tab) RENDERERS[tab]();
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

// Tap a transaction row to open its edit/delete popup (covers rows in any view).
$('#app').addEventListener('click', (e) => {
  const row = e.target.closest('[data-edit-tx]');
  if (!row) return;
  openTxEditModal(row.dataset.editTx, row.dataset.month);
});

// Initial load: keep the full-screen loader up until Home's data has been fetched
// (one /api/home request) and Home has painted, then reveal the app.
syncMonthPill();
(async () => {
  try {
    await switchTab('home');
  } finally {
    const loader = $('#loader');
    if (loader) loader.classList.add('hidden');
  }
})();
