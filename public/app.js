// Lifespan client. No framework, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// ---------------------------------------------------------------- state

const state = {
  items: [],
  dash: null,
  meta: { locations: [], categories: [], brands: [], retailers: [], providers: [], document_kinds: [] },
  filters: { q: '', status: '', location: '', category: '', sort: 'expiry' },
  route: 'overview',
  drawerId: null,
  reminders: null,
  loaded: false,
};

const STATUS_LABEL = { covered: 'Covered', expiring: 'Ending soon', expired: 'Expired', none: 'No coverage', active: 'Active', upcoming: 'Starts later' };
const KIND_LABEL = { receipt: 'Receipt', warranty: 'Warranty', manual: 'Manual', photo: 'Photo', invoice: 'Invoice', other: 'Other' };

// ---------------------------------------------------------------- api

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.fields = body?.error?.fields ?? {};
    this.rows = body?.error?.rows ?? [];
  }
}

async function api(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob || typeof body === 'string') init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function refresh() {
  const [dash, list, meta] = await Promise.all([api('GET', '/api/dashboard'), api('GET', '/api/items?sort=expiry'), api('GET', '/api/meta')]);
  state.dash = dash; state.items = list.items; state.meta = meta; state.loaded = true;
  renderSidebar();
  render();
  if (state.drawerId) {
    const item = state.items.find((i) => i.id === state.drawerId);
    if (item) renderDrawer(item); else closeDrawer();
  }
}

// ---------------------------------------------------------------- formatting

const money = (cents, opts = {}) => cents == null ? '—' : new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: opts.exact ? 2 : (Math.abs(cents) >= 100000 ? 0 : 2), minimumFractionDigits: opts.exact ? 2 : 0,
}).format(cents / 100);
const parseIso = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => iso ? parseIso(iso).toLocaleDateString('en-US', opts) : '—';
const dayDiff = (a, b) => Math.round((Date.UTC(...b.split('-').map((n, i) => i === 1 ? n - 1 : +n)) - Date.UTC(...a.split('-').map((n, i) => i === 1 ? n - 1 : +n))) / 86400000);
const today = () => state.dash?.today ?? new Date().toISOString().slice(0, 10);
const addDaysIso = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return toIso(d); };
const addMonthsIso = (iso, n) => { const d = parseIso(iso); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return toIso(d); };
const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function relative(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const abs = Math.abs(days);
  let txt;
  if (abs < 45) txt = plural(abs, 'day');
  else if (abs < 365 * 1.5) txt = plural(Math.round(abs / 30.44), 'month');
  else txt = `${(abs / 365.25).toFixed(abs < 365 * 10 ? 1 : 0).replace(/\.0$/, '')} years`;
  return days > 0 ? `in ${txt}` : `${txt} ago`;
}

function coverageSummary(item) {
  if (item.next_expiry) {
    const d = item.next_expiry.days_left;
    return `${h(item.next_expiry.label)} ends ${relative(d)}`;
  }
  if (item.coverages.length) return `Ended ${relative(dayDiff(today(), item.coverage_ends_on))}`;
  return 'No coverage recorded';
}

const initials = (name) => (name.match(/[A-Za-z0-9]/g) ?? ['?'])[0].toUpperCase();

// ---------------------------------------------------------------- lifespan bar

function lifebar(item, { large = false } = {}) {
  const t = today();
  const starts = [item.purchase_date, ...item.coverages.map((c) => c.starts_on)].filter(Boolean).sort();
  const start = starts[0] ?? item.created_at.slice(0, 10);
  const ends = [item.coverage_ends_on, item.write_off_date, addDaysIso(t, 60)].filter(Boolean).sort();
  let end = ends[ends.length - 1];
  const cap = addMonthsIso(t, large ? 180 : 60);
  if (end > cap) end = cap;
  const span = Math.max(dayDiff(start, end), 1);
  const pct = (iso) => Math.min(100, Math.max(0, (dayDiff(start, iso) / span) * 100));
  const order = { expired: 0, upcoming: 1, expiring: 2, active: 3 };
  const segs = [...item.coverages].sort((a, b) => order[a.state] - order[b.state]).map((c) => {
    const l = pct(c.starts_on ?? start); const r = pct(c.expires_on);
    return `<i class="seg s-${c.state}" style="left:${l}%;width:${Math.max(r - l, 1.2)}%"></i>`;
  }).join('');
  const wo = item.write_off_date && item.write_off_date <= end ? `<i class="wo" style="left:${pct(item.write_off_date)}%" title="Write-off ${h(fmtDate(item.write_off_date))}"></i>` : '';
  return {
    html: `<div class="lifebar${large ? ' lg' : ''}" role="img" aria-label="${h(STATUS_LABEL[item.status])}">${segs}${wo}<i class="now" style="left:${pct(t)}%"></i></div>`,
    start, end,
  };
}

// ---------------------------------------------------------------- sidebar & nav

function renderSidebar() {
  const rooms = state.dash?.by_location ?? [];
  $('#side-rooms').innerHTML = rooms.length ? rooms.map((r) => `
    <a class="room-link${state.route === 'inventory' && state.filters.location === r.name ? ' active' : ''}" href="#/inventory?room=${encodeURIComponent(r.name)}">
      <span class="dot"></span><span>${h(r.name)}</span><span class="count">${r.count}</span>
    </a>`).join('') : '<div class="side-empty">Rooms appear as you add items.</div>';
  const count = (sel, n) => { $$(`[data-count="${sel}"]`).forEach((el) => { el.textContent = n ? String(n) : ''; }); };
  count('items', state.dash?.counts.total ?? 0);
  count('soon', (state.dash?.timeline ?? []).filter((e) => e.days_left >= 0 && e.days_left <= 30).length);
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.route));
}

// ---------------------------------------------------------------- routing

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const route = ['overview', 'inventory', 'timeline'].includes(path) ? path : 'overview';
  if (route === 'inventory') {
    const room = params.get('room');
    const st = params.get('status');
    if (room !== null || st !== null) {
      state.filters.location = room ?? '';
      state.filters.status = st ?? '';
      state.filters.category = '';
    }
  }
  state.route = route;
  const item = Number(params.get('item'));
  state.pendingItem = Number.isInteger(item) && item > 0 ? item : null;
}

// Keep ?item=<id> in the hash so an open item can be linked, bookmarked and reloaded.
function setItemParam(id) {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  if (id) params.set('item', String(id)); else params.delete('item');
  const qs = params.toString();
  const next = `#${path || '/overview'}${qs ? `?${qs}` : ''}`;
  if (next !== location.hash) history.replaceState(null, '', next);
}

function openPendingItem() {
  if (!state.pendingItem || !state.loaded) return;
  const id = state.pendingItem;
  state.pendingItem = null;
  if (state.items.some((i) => i.id === id)) { if (state.drawerId !== id) openDrawer(id); } else setItemParam(null);
}

window.addEventListener('hashchange', () => {
  const before = state.route;
  parseRoute(); renderSidebar(); render();
  if (state.drawerId !== null && !state.pendingItem) closeDrawer();
  openPendingItem();
  if (state.route !== before) { $('#main').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
});

function render() {
  const main = $('#main');
  if (!state.loaded) { main.innerHTML = skeleton(); return; }
  if (state.items.length === 0 && state.route !== 'timeline') { main.innerHTML = welcome(); return; }
  if (state.route === 'inventory') main.innerHTML = inventoryPage();
  else if (state.route === 'timeline') main.innerHTML = timelinePage();
  else main.innerHTML = overviewPage();
  if (state.route === 'inventory') bindInventory();
  if (state.route === 'timeline') loadReminders();
  document.title = { overview: 'Lifespan', inventory: 'Inventory · Lifespan', timeline: 'Timeline · Lifespan' }[state.route];
}

function skeleton() {
  return `<div class="page"><div class="skeleton" style="height:16px;width:140px;margin-bottom:12px"></div>
    <div class="skeleton" style="height:44px;width:min(520px,80%);margin-bottom:32px"></div>
    <div class="skeleton" style="height:130px;border-radius:18px;margin-bottom:20px"></div>
    <div class="skeleton" style="height:320px;border-radius:18px"></div></div>`;
}

// ---------------------------------------------------------------- welcome

function welcome() {
  const ghost = (name, cls, w) => `<div class="ghost-row"><div class="avatar">${initials(name)}</div><div><b>${name}</b>
    <div class="lifebar"><i class="seg ${cls}" style="left:0;width:${w}%"></i><i class="now" style="left:58%"></i></div></div></div>`;
  return `<div class="page">
    <section class="card welcome">
      <div>
        <div class="eyebrow">${icon('sparkle', 'sm')} A calm home for the things you own</div>
        <h1>Know when your<br>things are <em>covered.</em></h1>
        <p>Lifespan keeps every warranty, receipt and manual in one place, and quietly tells you before coverage runs out — not the week after it breaks.</p>
        <div class="actions">
          <button class="btn primary" data-action="new-item">${icon('plus')} Add your first item</button>
          <button class="btn" data-action="demo">${icon('sparkle')} Explore with sample data</button>
          <button class="btn ghost" data-action="import">${icon('upload')} Import CSV</button>
        </div>
      </div>
      <div class="welcome-art" aria-hidden="true">
        ${ghost('Dishwasher', 's-covered', 92)}
        ${ghost('OLED Television', 's-expiring', 61)}
        ${ghost('Laptop', 's-covered', 100)}
        ${ghost('Cordless Vacuum', 's-expired', 52)}
      </div>
    </section>
    <div class="features">
      <div class="card feature">${icon('shield')}<b>Layered coverage</b><span>Manufacturer, extended and part-specific warranties, each with its own dates.</span></div>
      <div class="card feature">${icon('receipt')}<b>Receipts & manuals</b><span>Drop in PDFs and photos so proof of purchase is one click away.</span></div>
      <div class="card feature">${icon('calendar')}<b>Calendar alerts</b><span>Subscribe from any calendar app and get a reminder two weeks ahead.</span></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- overview

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

function overviewPage() {
  const d = state.dash;
  const c = d.counts;
  const soon = d.timeline.filter((e) => e.type === 'coverage_ends' && e.days_left >= 0 && e.days_left <= 30);
  const attention = buildAttention();
  const headline = attention.urgent
    ? `<em>${plural(attention.urgent, 'thing')}</em> ${attention.urgent === 1 ? 'needs' : 'need'} a look.`
    : 'Everything is <em>covered.</em>';
  const pctCovered = c.total ? Math.round((c.covered / c.total) * 100) : 0;
  const seg = (n, cls) => n ? `<i style="width:${(n / c.total) * 100}%;background:var(--${cls})"></i>` : '';
  const dep = d.purchase_value_cents ? Math.round((1 - d.book_value_cents / d.purchase_value_cents) * 100) : 0;

  return `<div class="page">
    <header class="page-head">
      <div>
        <div class="eyebrow">${h(parseIso(d.today).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
        <h1 class="page-title">${greeting()}. ${headline}</h1>
      </div>
      <div class="head-actions">
        <button class="btn primary" data-action="new-item">${icon('plus')} New item</button>
      </div>
    </header>

    <section class="card stats" aria-label="Summary">
      <div class="stat">
        <div class="stat-label">${icon('box')} Items tracked</div>
        <div class="stat-value">${c.total}</div>
        <div class="stat-foot">across ${plural(d.by_location.length, 'room')} · ${plural(d.documents, 'document')}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon('shield')} Protected</div>
        <div class="stat-value">${pctCovered}<small>%</small></div>
        <div class="meter" title="${c.covered} covered, ${c.expiring} ending soon, ${c.expired} expired, ${c.none} without coverage">
          ${seg(c.covered, 'covered')}${seg(c.expiring, 'expiring')}${seg(c.expired, 'expired')}${seg(c.none, 'ink-4')}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon('clock')} Ending in 30 days</div>
        <div class="stat-value">${soon.length}</div>
        <div class="stat-foot">${soon.length ? `Next: <a class="card-link" href="#" data-open="${soon[0].item_id}">${h(soon[0].item_name)}</a>` : 'Nothing ending this month'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon('receipt')} Current value</div>
        <div class="stat-value">${money(d.book_value_cents)}</div>
        <div class="stat-foot">${money(d.purchase_value_cents)} paid · ${dep}% depreciated</div>
      </div>
    </section>

    <div class="grid-2">
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <h2 class="card-title">The next twelve months</h2>
            <a class="card-link" href="#/timeline">Full timeline ${icon('arrow')}</a>
          </div>
          ${horizon()}
        </section>
        <section class="card">
          <div class="card-head">
            <h2 class="card-title">Needs attention</h2>
            <span class="card-sub">${attention.missingReceipts ? `${plural(attention.missingReceipts, 'item')} without a receipt` : ''}</span>
          </div>
          ${attention.length ? `<ul class="list">${attention.slice(0, 8).map(attentionRow).join('')}</ul>`
            : `<div class="empty-mini">${icon('check')}<div>Nothing is ending soon and every item has a receipt.</div></div>`}
        </section>
      </div>
      <div class="stack">
        ${breakdown('By room', d.by_location, 'room')}
        ${breakdown('By category', d.by_category)}
      </div>
    </div>
  </div>`;
}

function buildAttention() {
  const t = today();
  const out = [];
  const seen = new Set();
  for (const e of state.dash.timeline) {
    if (e.type !== 'coverage_ends') continue;
    if (e.days_left > 45 || e.days_left < -45) continue;
    const item = state.items.find((i) => i.id === e.item_id);
    if (!item) continue;
    // An ended coverage only matters if nothing else still protects the item.
    if (e.days_left < 0 && item.status === 'covered') continue;
    const key = `${e.item_id}:${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: e.days_left < 0 ? 'expired' : 'expiring', item, title: item.name, sub: `${e.label}${e.provider ? ` · ${e.provider}` : ''}`, date: e.date, days: e.days_left });
  }
  out.sort((a, b) => Math.abs(a.days) - Math.abs(b.days));
  const urgent = new Set(out.map((a) => a.item.id)).size;
  const noReceipt = state.items
    .filter((item) => !item.has_receipt && item.price_cents && item.price_cents >= 20000)
    .sort((a, b) => b.price_cents - a.price_cents);
  for (const item of noReceipt.slice(0, 3)) {
    out.push({ kind: 'none', item, title: item.name, sub: 'No receipt on file', date: item.purchase_date, days: item.purchase_date ? dayDiff(t, item.purchase_date) : null, receipt: true });
  }
  out.urgent = urgent;
  out.missingReceipts = noReceipt.length;
  return out;
}

function attentionRow(a) {
  const ic = a.receipt ? 'receipt' : a.kind === 'expired' ? 'alert' : 'clock';
  const aside = a.receipt
    ? `<strong>${money(a.item.price_cents)}</strong><span class="muted">Add proof</span>`
    : `<strong>${h(fmtDate(a.date, { month: 'short', day: 'numeric' }))}</strong><span class="s-${a.kind}">${relative(a.days)}</span>`;
  return `<li><a class="row-link" href="#" data-open="${a.item.id}">
    <span class="row-icon s-${a.kind}">${icon(ic, `s-${a.kind}`)}</span>
    <span class="row-main"><div class="row-title">${h(a.title)}</div><div class="row-sub">${h(a.sub)}</div></span>
    <span class="row-aside">${aside}</span>
  </a></li>`;
}

function horizon() {
  const t = today();
  const start = addMonthsIso(t, -1).slice(0, 8) + '01';
  const end = addMonthsIso(start, 12);
  const span = dayDiff(start, end);
  const pos = (iso) => (dayDiff(start, iso) / span) * 100;
  const months = [];
  for (let i = 0; i <= 12; i++) months.push(addMonthsIso(start, i));
  const events = state.dash.timeline.filter((e) => e.date >= start && e.date < end);
  const lanes = [[], [], []];
  const laneY = [44, 26, 8];
  const dots = events.map((e) => {
    const x = pos(e.date);
    let lane = lanes.findIndex((l) => l.every((px) => Math.abs(px - x) > 2.6));
    if (lane === -1) lane = 2;
    lanes[lane].push(x);
    const cls = e.type === 'write_off' ? 's-none' : e.days_left < 0 ? 's-expired' : e.days_left <= 30 ? 's-expiring' : 's-covered';
    return `<button class="horizon-dot ${cls}${e.type === 'write_off' ? ' writeoff' : ''}" style="left:${x}%;top:${laneY[lane] + 6}px" data-open="${e.item_id}" aria-label="${h(e.item_name)}: ${h(e.label)} ${h(fmtDate(e.date))}">
      <span class="tip"><b>${h(e.item_name)}</b>${h(e.label)} · ${h(fmtDate(e.date, { month: 'short', day: 'numeric' }))}</span></button>`;
  }).join('');
  return `<div class="horizon">
    <div class="horizon-track">
      <div class="horizon-axis"></div>
      ${months.slice(0, 12).map((m) => `<i class="horizon-tick" style="left:${pos(m)}%"></i><span class="horizon-month" style="left:${pos(addDaysIso(m, 14))}%">${parseIso(m).toLocaleDateString('en-US', { month: 'short' })}</span>`).join('')}
      <div class="horizon-today" style="left:${pos(t)}%"><span>Today</span></div>
      ${dots}
    </div>
    <div class="horizon-legend">
      <span class="s-expired"><i></i>Ended</span>
      <span class="s-expiring"><i></i>Within 30 days</span>
      <span class="s-covered"><i></i>Later</span>
      <span class="s-none"><i style="border-style:dotted"></i>Write-off</span>
    </div>
  </div>`;
}

function breakdown(title, rows, kind) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => r.value_cents), 1);
  return `<section class="card">
    <div class="card-head"><h2 class="card-title">${title}</h2><span class="card-sub">by purchase value</span></div>
    <div class="bars">${rows.slice(0, 7).map((r, i) => `
      <a class="bar-row" href="#/inventory?${kind === 'room' ? 'room' : 'category'}=${encodeURIComponent(r.name)}" ${kind === 'room' ? '' : `data-category="${h(r.name)}"`}>
        <span class="name">${h(r.name)} <span class="muted">· ${r.count}</span></span>
        <span class="val">${money(r.value_cents)}</span>
        <span class="track"><i style="width:${Math.max((r.value_cents / max) * 100, 2)}%;animation-delay:${i * 50}ms"></i></span>
      </a>`).join('')}
    </div>
  </section>`;
}

// ---------------------------------------------------------------- inventory

function filteredItems() {
  const f = state.filters;
  const term = f.q.trim().toLowerCase();
  const sorts = {
    expiry: (a, b) => (a.next_expiry?.date ?? '9999').localeCompare(b.next_expiry?.date ?? '9999') || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    value: (a, b) => (b.price_cents ?? -1) - (a.price_cents ?? -1),
    purchased: (a, b) => (b.purchase_date ?? '').localeCompare(a.purchase_date ?? ''),
    recent: (a, b) => b.updated_at.localeCompare(a.updated_at),
  };
  return state.items.filter((it) => {
    if (f.status && it.status !== f.status) return false;
    if (f.location && it.location !== f.location) return false;
    if (f.category && it.category !== f.category) return false;
    if (term) {
      const hay = [it.name, it.brand, it.model, it.serial_number, it.location, it.category, it.retailer, it.notes, ...it.coverages.map((c) => `${c.label} ${c.provider}`)].join('\n').toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  }).sort(sorts[f.sort] ?? sorts.expiry);
}

function inventoryPage() {
  const f = state.filters;
  const items = filteredItems();
  const counts = { '': state.items.length, covered: 0, expiring: 0, expired: 0, none: 0 };
  for (const it of state.items) counts[it.status]++;
  const seg = (val, label) => `<button type="button" data-status="${val}" aria-pressed="${f.status === val}">${label}<span class="n">${counts[val]}</span></button>`;
  const opts = (list, sel, all) => `<option value="">${all}</option>${list.map((v) => `<option value="${h(v)}"${v === sel ? ' selected' : ''}>${h(v)}</option>`).join('')}`;

  return `<div class="page">
    <header class="page-head">
      <div>
        <div class="eyebrow">${f.location ? `${icon('pin', 'sm')} ${h(f.location)}` : 'Everything you own'}</div>
        <h1 class="page-title">${f.location ? h(f.location) : 'Inventory'}</h1>
      </div>
      <div class="head-actions">
        <a class="btn ghost" href="/api/export.csv" download>${icon('download')} Export</a>
        <button class="btn primary" data-action="new-item">${icon('plus')} New item</button>
      </div>
    </header>

    <div class="toolbar">
      <label class="search">${icon('search')}<span class="visually-hidden">Search items</span>
        <input class="input" id="inv-search" type="search" placeholder="Search name, serial, brand…" value="${h(f.q)}" autocomplete="off"></label>
      <div class="segmented" role="group" aria-label="Filter by status">
        ${seg('', 'All')}${seg('covered', 'Covered')}${seg('expiring', 'Ending soon')}${seg('expired', 'Expired')}${seg('none', 'None')}
      </div>
      <span class="spacer"></span>
      <select class="select" id="inv-location" aria-label="Room">${opts(state.meta.locations, f.location, 'All rooms')}</select>
      <select class="select" id="inv-category" aria-label="Category">${opts(state.meta.categories, f.category, 'All types')}</select>
      <select class="select" id="inv-sort" aria-label="Sort">
        ${[['expiry', 'Ending first'],['name', 'Name'], ['value', 'Highest value'], ['purchased', 'Newest purchase'], ['recent', 'Recently edited']].map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>

    <div id="inv-results">${inventoryTable(items)}</div>
  </div>`;
}

function inventoryTable(items) {
  if (!items.length) {
    return `<div class="card empty">${icon('search')}<h3>No matches</h3><p>Try a different search or clear the filters.</p>
      <button class="btn" data-action="clear-filters">Clear filters</button></div>`;
  }
  const total = items.reduce((s, i) => s + (i.price_cents ?? 0), 0);
  return `<div class="card table" role="table" aria-label="Items">
    <div class="thead" role="row"><span>Item</span><span class="c-loc">Room</span><span>Coverage</span><span class="c-status">Status</span><span class="r">Value</span></div>
    ${items.map((it) => `
      <div class="trow" role="row" tabindex="0" data-open="${it.id}">
        <div class="item-cell c-item"><div class="avatar">${h(initials(it.name))}</div>
          <div style="min-width:0"><div class="item-name">${h(it.name)}</div>
          <div class="item-meta">${h([it.brand, it.model].filter(Boolean).join(' · ') || it.category || '—')}</div></div></div>
        <div class="cell-loc c-loc">${it.location ? `${icon('pin')}<span>${h(it.location)}</span>` : '<span class="muted">—</span>'}</div>
        <div class="cell-cov c-cov">${lifebar(it).html}<div class="when">${coverageSummary(it)}</div></div>
        <div class="c-status"><span class="status s-${it.status}">${STATUS_LABEL[it.status]}</span></div>
        <div class="cell-val c-val r">${money(it.price_cents)}${it.book_value_cents != null && it.book_value_cents !== it.price_cents ? `<small>now ${money(it.book_value_cents)}</small>` : ''}</div>
      </div>`).join('')}
  </div>
  <div class="list-foot"><span>${plural(items.length, 'item')}</span><span class="num">${money(total)} total</span></div>`;
}

function bindInventory() {
  const update = () => {
    $('#inv-results').innerHTML = inventoryTable(filteredItems());
    $$('.segmented [data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === state.filters.status)));
  };
  $('#inv-search').addEventListener('input', (e) => { state.filters.q = e.target.value; update(); });
  $('#inv-location').addEventListener('change', (e) => {
    state.filters.location = e.target.value;
    history.replaceState(null, '', state.filters.location ? `#/inventory?room=${encodeURIComponent(state.filters.location)}` : '#/inventory');
    render(); renderSidebar();
  });
  $('#inv-category').addEventListener('change', (e) => { state.filters.category = e.target.value; update(); });
  $('#inv-sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; update(); });
  $$('.segmented [data-status]').forEach((b) => b.addEventListener('click', () => { state.filters.status = b.dataset.status; update(); }));
}

// ---------------------------------------------------------------- timeline

function timelinePage() {
  const feed = `${location.origin}/api/calendar.ics`;
  const events = state.dash?.timeline ?? [];
  const t = today();
  const groups = new Map();
  for (const e of events) {
    const key = e.days_left < 0 ? 'past' : e.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === 'past' ? -1 : b === 'past' ? 1 : a.localeCompare(b)));
  const row = (e) => {
    const cls = e.type === 'write_off' ? 's-none' : e.days_left < 0 ? 's-expired' : e.days_left <= 30 ? 's-expiring' : 's-covered';
    const d = parseIso(e.date);
    return `<a class="tl-row" href="#" data-open="${e.item_id}">
      <div class="tl-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('en-US', { month: 'short' })}</span></div>
      <span class="row-icon ${cls}">${icon(e.type === 'write_off' ? 'receipt' : e.days_left < 0 ? 'alert' : 'shield', cls)}</span>
      <div class="row-main"><div class="row-title">${h(e.item_name)}</div><div class="row-sub">${h(e.label)}${e.provider ? ` · ${h(e.provider)}` : ''}</div></div>
      <div class="row-aside"><span class="pill ${cls}">${relative(e.days_left)}</span></div>
    </a>`;
  };
  return `<div class="page">
    <header class="page-head">
      <div><div class="eyebrow">Coverage endings and write-offs</div><h1 class="page-title">Timeline</h1>
      <p class="page-sub">Every date that matters over the next year, plus anything that ended in the last six weeks.</p></div>
    </header>
    <section class="card subscribe">
      <span class="ic-wrap">${icon('calendar')}</span>
      <div class="txt"><b>Subscribe in your calendar</b><span>Apple Calendar, Google Calendar and Outlook will remind you two weeks before each date.</span></div>
      <code>${h(feed)}</code>
      <button class="btn sm" data-copy="${h(feed)}">${icon('copy')} Copy link</button>
      <a class="btn sm ghost" href="/api/calendar.ics" download="lifespan.ics">${icon('download')} .ics</a>
    </section>
    <section class="card subscribe" id="reminder-card">${reminderCard()}</section>
    ${events.length === 0 ? `<div class="card empty">${icon('calendar')}<h3>A quiet year ahead</h3><p>Add coverage dates to your items and they will appear here.</p></div>` : ''}
    ${ordered.map(([key, list]) => `
      <section class="tl-group">
        <div class="tl-month"><h3>${key === 'past' ? 'Recently ended' : parseIso(`${key}-01`).toLocaleDateString('en-US', { month: 'long', year: key.slice(0, 4) === t.slice(0, 4) ? undefined : 'numeric' })}</h3><span>${plural(list.length, 'date')}</span></div>
        <div class="card" style="overflow:hidden">${list.map(row).join('')}</div>
      </section>`).join('')}
  </div>`;
}

function reminderCard() {
  const r = state.reminders;
  if (!r) return `<span class="ic-wrap">${icon('bell')}</span><div class="txt"><b>Push reminders</b><span>Checking…</span></div>`;
  if (!r.configured) {
    return `<span class="ic-wrap">${icon('bell')}</span><div class="txt"><b>Push reminders are off</b>
      <span>Set <span class="mono">LIFESPAN_WEBHOOK_URL</span> to a Discord, Slack, ntfy or any JSON webhook and Lifespan will post a digest ${r.remind_days} days before coverage ends.</span></div>`;
  }
  const n = r.pending.length;
  return `<span class="ic-wrap">${icon('bell')}</span><div class="txt"><b>Push reminders are on</b>
    <span>${r.format[0].toUpperCase()}${r.format.slice(1)} webhook · ${r.remind_days} days ahead · ${n ? `${plural(n, 'reminder')} due at the next hourly check` : 'nothing due right now'}</span></div>
    <button class="btn sm" data-action="test-reminder">${icon('bell')} Send test</button>`;
}

async function loadReminders() {
  try {
    state.reminders = await api('GET', '/api/reminders');
    const card = $('#reminder-card');
    if (card) card.innerHTML = reminderCard();
  } catch { /* card keeps its last state */ }
}

// ---------------------------------------------------------------- drawer

function openDrawer(id) {
  const item = state.items.find((i) => i.id === Number(id));
  if (!item) return;
  const wasOpen = state.drawerId !== null;
  state.drawerId = item.id;
  state.lastFocus = wasOpen ? state.lastFocus : document.activeElement;
  renderDrawer(item);
  setItemParam(item.id);
  const drawer = $('#drawer'); const scrim = $('#drawer-scrim');
  drawer.classList.remove('closing'); scrim.classList.remove('closing');
  drawer.hidden = false; scrim.hidden = false;
  document.body.style.overflow = 'hidden';
  $('.shell').inert = true;
  if (!wasOpen) $('.drawer-top .icon-btn[data-action="close-drawer"]', drawer)?.focus();
}

function closeDrawer() {
  if (state.drawerId === null) return;
  state.drawerId = null;
  setItemParam(null);
  const drawer = $('#drawer'); const scrim = $('#drawer-scrim');
  drawer.classList.add('closing'); scrim.classList.add('closing');
  setTimeout(() => { if (state.drawerId === null) { drawer.hidden = true; scrim.hidden = true; drawer.innerHTML = ''; } }, 190);
  document.body.style.overflow = '';
  $('.shell').inert = false;
  state.lastFocus?.focus?.();
}

function renderDrawer(item, { editing = null } = {}) {
  const t = today();
  const bar = lifebar(item, { large: true });
  const fact = (label, value, extra = '') => `<div class="fact"><dt>${label}</dt><dd>${value}${extra}</dd></div>`;
  const kinds = state.meta.document_kinds;
  const lastDays = item.coverage_ends_on ? dayDiff(t, item.coverage_ends_on) : null;
  const heroText = item.next_expiry
    ? `<b>Covered ${lastDays === 0 ? 'until today' : `for ${relative(lastDays).replace('in ', '')}`}</b><span class="muted">${item.next_expiry.date === item.coverage_ends_on ? `Until ${h(fmtDate(item.coverage_ends_on))}` : `Next to end: ${h(item.next_expiry.label)} · ${h(fmtDate(item.next_expiry.date))}`}</span>`
    : item.coverages.length
      ? `<b>Coverage ended ${relative(dayDiff(t, item.coverage_ends_on))}</b><span class="muted">${h(fmtDate(item.coverage_ends_on))}</span>`
      : `<b>No coverage on file</b><span class="muted">Add a warranty below</span>`;

  $('#drawer').innerHTML = `
    <div class="drawer-top">
      <div class="crumbs">${item.location ? `${icon('pin', 'sm')} ${h(item.location)}` : ''}${item.category ? ` <span>·</span> ${h(item.category)}` : ''}</div>
      <div class="tools">
        <button class="icon-btn" data-action="edit-item" aria-label="Edit item" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" data-action="duplicate-item" aria-label="Duplicate item" title="Duplicate">${icon('duplicate')}</button>
        <button class="icon-btn danger" data-action="delete-item" aria-label="Delete item" title="Delete">${icon('trash')}</button>
        <button class="icon-btn" data-action="close-drawer" aria-label="Close">${icon('x')}</button>
      </div>
    </div>
    <div class="drawer-body">
      <h2 class="d-title" id="drawer-title">${h(item.name)}</h2>
      <div class="d-sub">
        <span class="status s-${item.status}">${STATUS_LABEL[item.status]}</span>
        ${[item.brand, item.model].filter(Boolean).length ? `<span>${h([item.brand, item.model].filter(Boolean).join(' · '))}</span>` : ''}
      </div>

      <div class="d-hero">
        <div class="d-hero-top">${heroText}</div>
        ${bar.html}
        <div class="d-scale"><span>${h(fmtDate(bar.start, { month: 'short', year: 'numeric' }))}</span><span>${h(fmtDate(bar.end, { month: 'short', year: 'numeric' }))}</span></div>
      </div>

      <dl class="facts">
        ${fact('Serial number', item.serial_number ? `<span class="mono">${h(item.serial_number)}</span>` : '<span class="muted">Not recorded</span>', item.serial_number ? `<button class="copy-btn" data-copy="${h(item.serial_number)}" aria-label="Copy serial number">${icon('copy')}</button>` : '')}
        ${fact('Purchased', item.purchase_date ? `<span>${h(fmtDate(item.purchase_date))}</span>` : '<span class="muted">Unknown</span>', item.retailer ? ` <span class="muted">· ${h(item.retailer)}</span>` : '')}
        ${fact('Price paid', `<span class="mono">${money(item.price_cents, { exact: true })}</span>`)}
        ${fact('Value today', `<span class="mono">${money(item.book_value_cents, { exact: true })}</span>`, item.life_months ? ` <span class="muted">· ${item.life_months % 12 === 0 ? plural(item.life_months / 12, 'yr') : `${item.life_months} mo`} life</span>` : '')}
        ${fact('Written off', item.write_off_date ? `<span>${h(fmtDate(item.write_off_date))}</span>` : '<span class="muted">No useful life set</span>')}
        ${fact('Coverage ends', item.coverage_ends_on ? `<span>${h(fmtDate(item.coverage_ends_on))}</span>` : '<span class="muted">—</span>')}
      </dl>

      <section class="d-section">
        <div class="d-section-head"><h3>${icon('shield', 'sm')} Coverage <span class="n">${item.coverages.length}</span></h3>
          ${editing === 'new' ? '' : `<button class="btn sm" data-action="add-coverage">${icon('plus')} Add</button>`}</div>
        ${editing === 'new' ? coverageForm(item) : ''}
        ${item.coverages.map((c) => editing === c.id ? coverageForm(item, c) : coverageCard(item, c)).join('')}
        ${item.coverages.length === 0 && editing !== 'new' ? '<div class="empty-mini" style="padding:14px 0">No warranties yet. Most products come with at least a one-year manufacturer warranty.</div>' : ''}
      </section>

      <section class="d-section">
        <div class="d-section-head"><h3>${icon('file', 'sm')} Documents <span class="n">${item.documents.length}</span></h3></div>
        ${!item.has_receipt ? `<div class="missing">${icon('receipt')} No receipt yet — it is the first thing a manufacturer will ask for.</div>` : ''}
        ${item.documents.length ? `<div class="docs">${item.documents.map(docCard).join('')}</div>` : ''}
        <div class="dropzone" data-action="pick-docs" tabindex="0" role="button" aria-label="Upload documents">
          ${icon('upload')}<span><b>Drop files</b> or click to upload as</span>
          <select class="select" id="doc-kind" aria-label="Document type">${kinds.map((k) => `<option value="${k}"${k === (item.has_receipt ? 'manual' : 'receipt') ? ' selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
        </div>
      </section>

      ${item.notes ? `<section class="d-section"><div class="d-section-head"><h3>Notes</h3></div><div class="notes">${h(item.notes)}</div></section>` : ''}
      <p class="muted" style="font-size:12px;margin:0">Added ${h(fmtDate(item.created_at.slice(0, 10)))} · Updated ${h(new Date(item.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</p>
    </div>`;
  bindDrawer(item);
}

function coverageCard(item, c) {
  const start = c.starts_on ?? item.purchase_date ?? c.created_at.slice(0, 10);
  const total = Math.max(dayDiff(start, c.expires_on), 1);
  const done = Math.min(Math.max(dayDiff(start, today()), 0), total);
  const pct = (done / total) * 100;
  return `<div class="cov">
    <div class="cov-head">
      <div class="t"><b>${h(c.label)}</b><span>${h(c.provider || 'Provider not set')}</span></div>
      <span class="pill s-${c.state}">${c.state === 'expired' ? `Ended ${relative(c.days_left)}` : c.state === 'upcoming' ? `Starts ${relative(dayDiff(today(), c.starts_on))}` : `${relative(c.days_left).replace('in ', '')} left`}</span>
      <div class="cov-tools">
        <button class="icon-btn sm" data-edit-cov="${c.id}" aria-label="Edit coverage">${icon('edit')}</button>
        <button class="icon-btn sm danger" data-del-cov="${c.id}" aria-label="Delete coverage">${icon('trash')}</button>
      </div>
    </div>
    <div class="lifebar"><i class="seg s-${c.state}" style="left:0;width:${c.state === 'upcoming' ? 100 : Math.max(pct, 1.5)}%;${c.state === 'upcoming' ? 'opacity:.35' : ''}"></i></div>
    <div class="cov-foot"><span class="mono">${h(fmtDate(c.starts_on))}</span><span class="mono">${h(fmtDate(c.expires_on))}</span></div>
    ${c.notes ? `<div class="cov-notes">${h(c.notes)}</div>` : ''}
  </div>`;
}

function coverageForm(item, c = null) {
  const start = c?.starts_on ?? item.purchase_date ?? '';
  return `<form class="inline-form" id="cov-form" data-id="${c?.id ?? ''}" novalidate>
    <div class="grid">
      <label class="field"><span>Name</span><input class="input" name="label" required maxlength="100" value="${h(c?.label ?? (item.coverages.length ? '' : 'Manufacturer warranty'))}" placeholder="Manufacturer warranty"><small class="err" data-err="label"></small></label>
      <label class="field"><span>Provider</span><input class="input" name="provider" maxlength="100" list="dl-providers" value="${h(c?.provider ?? item.brand ?? '')}" placeholder="${h(item.brand || 'Brand or insurer')}"></label>
      <label class="field"><span>Starts</span><input class="input" type="date" name="starts_on" value="${h(start)}"><small class="err" data-err="starts_on"></small></label>
      <label class="field"><span>Ends</span><input class="input" type="date" name="expires_on" required value="${h(c?.expires_on ?? '')}"><small class="err" data-err="expires_on"></small></label>
    </div>
    <div class="quick" aria-label="Set length">${[1, 2, 3, 5, 10].map((y) => `<button type="button" data-years="${y}">+${y} yr</button>`).join('')}</div>
    <label class="field"><span>Notes</span><input class="input" name="notes" maxlength="2000" value="${h(c?.notes ?? '')}" placeholder="What it covers, claim number, conditions…"></label>
    <div class="actions"><button type="button" class="btn ghost sm" data-action="cancel-cov">Cancel</button><button class="btn primary sm" type="submit">${c ? 'Save' : 'Add coverage'}</button></div>
    <datalist id="dl-providers">${state.meta.providers.map((p) => `<option value="${h(p)}">`).join('')}</datalist>
  </form>`;
}

function docCard(d) {
  const isImg = d.mime.startsWith('image/') && d.mime !== 'image/svg+xml';
  return `<div class="doc">
    <a class="doc-thumb" href="${d.url}" target="_blank" rel="noopener">${isImg ? `<img src="${d.url}" alt="" loading="lazy">` : icon(d.mime === 'application/pdf' ? 'file' : 'file')}</a>
    <a href="${d.url}" target="_blank" rel="noopener" style="min-width:0"><div class="doc-name" title="${h(d.filename)}">${h(d.filename)}</div><div class="doc-meta">${KIND_LABEL[d.kind] ?? d.kind} · ${bytes(d.size_bytes)}</div></a>
    <div class="doc-tools">
      <a class="icon-btn sm" href="${d.url}?download" aria-label="Download">${icon('download')}</a>
      <button class="icon-btn sm danger" data-del-doc="${d.id}" aria-label="Delete document">${icon('trash')}</button>
    </div>
  </div>`;
}

function bindDrawer(item) {
  const drawer = $('#drawer');
  const form = $('#cov-form', drawer);
  if (form) {
    form.querySelector('[name="label"]').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = Object.fromEntries(['label', 'provider', 'starts_on', 'expires_on', 'notes'].map((k) => [k, (fd.get(k) ?? '').toString()]));
      const id = form.dataset.id;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        if (id) await api('PATCH', `/api/coverages/${id}`, body);
        else await api('POST', `/api/items/${item.id}/coverages`, body);
        toast(id ? 'Coverage updated' : 'Coverage added', 'ok');
        await refresh();
      } catch (err) {
        btn.disabled = false;
        showFieldErrors(form, err);
      }
    });
    $$('[data-years]', form).forEach((b) => b.addEventListener('click', () => {
      const s = form.querySelector('[name="starts_on"]');
      const base = s.value || today();
      if (!s.value) s.value = base;
      form.querySelector('[name="expires_on"]').value = addMonthsIso(base, Number(b.dataset.years) * 12);
    }));
  }
  const dz = $('.dropzone', drawer);
  if (dz) {
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); uploadDocs(item.id, e.dataTransfer.files); });
    $('#doc-kind', drawer).addEventListener('click', (e) => e.stopPropagation());
  }
}

async function uploadDocs(itemId, files) {
  const list = [...files];
  if (!list.length) return;
  const kind = $('#doc-kind')?.value ?? 'other';
  let ok = 0;
  for (const file of list) {
    if (file.size > 25 * 1024 * 1024) { toast(`${file.name} is larger than 25 MB`, 'error'); continue; }
    try {
      await api('POST', `/api/items/${itemId}/documents?kind=${encodeURIComponent(kind)}`, file, {
        'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name),
      });
      ok++;
    } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
  }
  if (ok) { toast(ok === 1 ? 'Document uploaded' : `${ok} documents uploaded`, 'ok'); await refresh(); }
}

// ---------------------------------------------------------------- item modal

function datalist(id, values) { return `<datalist id="${id}">${values.map((v) => `<option value="${h(v)}">`).join('')}</datalist>`; }

function openItemModal(item = null) {
  const v = (k) => h(item?.[k] ?? '');
  const lifeYears = item?.life_months ? (item.life_months % 12 === 0 ? String(item.life_months / 12) : String(+(item.life_months / 12).toFixed(2))) : '';
  const draftRow = (i) => `<div class="cov-draft" data-row="${i}">
    <label class="field"><span>Coverage</span><input class="input" name="c_label" placeholder="Manufacturer warranty" maxlength="100"><small class="err" data-err="coverages[${i}].label"></small></label>
    <label class="field"><span>Provider</span><input class="input" name="c_provider" list="dl-providers2" maxlength="100"></label>
    <label class="field"><span>Starts</span><input class="input" type="date" name="c_starts"></label>
    <label class="field"><span>Ends</span><input class="input" type="date" name="c_expires"><small class="err" data-err="coverages[${i}].expires_on"></small></label>
    <button type="button" class="icon-btn sm danger" data-remove-row aria-label="Remove coverage">${icon('x')}</button>
  </div>`;

  const modal = $('#modal');
  modal.innerHTML = `<form class="modal-card" id="item-form" novalidate>
    <div class="modal-head"><h2>${item ? 'Edit item' : 'New item'}</h2><button type="button" class="icon-btn" data-close-modal aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="form-section">The basics</div>
        <label class="field span-6"><span>Name</span><input class="input" name="name" required maxlength="120" value="${v('name')}" placeholder="e.g. Bosch 800 Series Dishwasher" autocomplete="off"><small class="err" data-err="name"></small></label>
        <label class="field span-3"><span>Brand</span><input class="input" name="brand" list="dl-brands" maxlength="80" value="${v('brand')}"></label>
        <label class="field span-3"><span>Model</span><input class="input" name="model" maxlength="80" value="${v('model')}"></label>
        <label class="field span-3"><span>Room</span><input class="input" name="location" list="dl-locations" maxlength="80" value="${v('location')}" placeholder="Kitchen"></label>
        <label class="field span-3"><span>Category</span><input class="input" name="category" list="dl-categories" maxlength="60" value="${v('category')}" placeholder="Appliances"></label>
        <label class="field span-6"><span>Serial number</span><input class="input mono" name="serial_number" maxlength="120" value="${v('serial_number')}" autocomplete="off" spellcheck="false"></label>

        <div class="form-section">Purchase</div>
        <label class="field span-2"><span>Date</span><input class="input" type="date" name="purchase_date" value="${v('purchase_date')}"><small class="err" data-err="purchase_date"></small></label>
        <label class="field span-2"><span>Price</span><span class="input-wrap"><span class="prefix">$</span><input class="input" name="price" inputmode="decimal" value="${item?.price_cents != null ? (item.price_cents / 100).toFixed(2) : ''}" placeholder="0.00"></span><small class="err" data-err="price_cents"></small></label>
        <label class="field span-2"><span>Retailer</span><input class="input" name="retailer" list="dl-retailers" maxlength="80" value="${v('retailer')}"></label>
        <label class="field span-3"><span>Useful life <span class="hint">years, for depreciation</span></span><input class="input" name="life_years" inputmode="decimal" value="${lifeYears}" placeholder="e.g. 10"><small class="err" data-err="life_months"></small></label>
        <div class="span-3"></div>

        ${item ? '' : `<div class="form-section">Coverage <button type="button" class="btn sm ghost" data-add-row>${icon('plus')} Add another</button></div>
        <div class="span-6" id="cov-rows" style="display:grid;gap:10px">${draftRow(0)}</div>`}

        <div class="form-section">Notes</div>
        <label class="field span-6"><span class="visually-hidden">Notes</span><textarea class="textarea" name="notes" maxlength="4000" placeholder="Installer, maintenance schedule, claim history…">${v('notes')}</textarea></label>
      </div>
      ${datalist('dl-brands', state.meta.brands)}${datalist('dl-locations', state.meta.locations)}${datalist('dl-categories', state.meta.categories)}${datalist('dl-retailers', state.meta.retailers)}${datalist('dl-providers2', state.meta.providers)}
    </div>
    <div class="modal-foot">
      <span class="form-error" id="form-error" hidden></span>
      <div class="right"><button type="button" class="btn ghost" data-close-modal>Cancel</button><button class="btn primary" type="submit">${item ? 'Save changes' : 'Add item'}</button></div>
    </div>
  </form>`;
  const form = $('#item-form');
  let rows = 1;
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-row]')) { $('#cov-rows').insertAdjacentHTML('beforeend', draftRow(rows++)); $('#cov-rows .cov-draft:last-child input').focus(); }
    const rm = e.target.closest('[data-remove-row]');
    if (rm) rm.closest('.cov-draft').remove();
  });
  // Default coverage start to purchase date.
  form.purchase_date.addEventListener('change', () => {
    $$('[name="c_starts"]', form).forEach((i) => { if (!i.value) i.value = form.purchase_date.value; });
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const s = (k) => (fd.get(k) ?? '').toString().trim();
    const errors = {};
    const priceRaw = s('price').replace(/[$,\s]/g, '');
    const price = priceRaw === '' ? null : Number(priceRaw);
    if (price !== null && (!Number.isFinite(price) || price < 0)) errors.price_cents = 'Enter a positive amount.';
    const lifeRaw = s('life_years');
    const life = lifeRaw === '' ? null : Math.round(Number(lifeRaw) * 12);
    if (life !== null && (!Number.isFinite(life) || life < 1)) errors.life_months = 'Enter a number of years.';
    const body = {
      name: s('name'), brand: s('brand'), model: s('model'), location: s('location'), category: s('category'),
      serial_number: s('serial_number'), purchase_date: s('purchase_date') || null, retailer: s('retailer'), notes: s('notes'),
      price_cents: price === null || errors.price_cents ? null : Math.round(price * 100), life_months: errors.life_months ? null : life,
    };
    if (!item) {
      body.coverages = $$('.cov-draft', form).map((r) => ({
        label: $('[name="c_label"]', r).value.trim(), provider: $('[name="c_provider"]', r).value.trim(),
        starts_on: $('[name="c_starts"]', r).value || null, expires_on: $('[name="c_expires"]', r).value,
      })).filter((c) => c.label || c.expires_on || c.provider);
      body.coverages.forEach((c) => { if (!c.label) c.label = 'Warranty'; });
    }
    if (Object.keys(errors).length) { showFieldErrors(form, { fields: errors, message: 'Some fields need attention.' }); return; }
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const saved = item ? await api('PATCH', `/api/items/${item.id}`, body) : await api('POST', '/api/items', body);
      modal.close();
      toast(item ? 'Changes saved' : `${saved.name} added`, 'ok');
      await refresh();
      if (!item) openDrawer(saved.id);
    } catch (err) {
      btn.disabled = false;
      // Map nested coverage errors to the draft rows by their visible order.
      if (err.fields) {
        const visible = $$('.cov-draft', form);
        for (const [k, msg] of Object.entries(err.fields)) {
          const m = k.match(/^coverages\[(\d+)\]\.(.+)$/);
          if (m && visible[m[1]]) { err.fields[`coverages[${visible[m[1]].dataset.row}].${m[2]}`] = msg; if (visible[m[1]].dataset.row !== m[1]) delete err.fields[k]; }
        }
      }
      showFieldErrors(form, err);
    }
  });
  modal.showModal();
  form.name.focus();
}

function showFieldErrors(form, err) {
  $$('[data-err]', form).forEach((el) => { el.textContent = ''; });
  $$('.invalid', form).forEach((el) => el.classList.remove('invalid'));
  let placed = 0;
  for (const [field, msg] of Object.entries(err.fields ?? {})) {
    const slot = form.querySelector(`[data-err="${CSS.escape(field)}"]`);
    if (slot) { slot.textContent = msg; slot.closest('.field')?.querySelector('.input, .textarea')?.classList.add('invalid'); placed++; }
  }
  const box = $('#form-error', form);
  if (box) { box.hidden = false; box.innerHTML = `${icon('alert', 'sm')} ${h(err.message)}`; }
  else if (!placed) toast(err.message, 'error');
  form.querySelector('.invalid')?.focus();
}

// ---------------------------------------------------------------- confirm / import

function confirmDialog({ title, body, action = 'Delete' }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    modal.innerHTML = `<div class="modal-card narrow">
      <div class="modal-head"><h2>${h(title)}</h2></div>
      <div class="modal-body"><p class="confirm-text">${body}</p></div>
      <div class="modal-foot"><div class="right"><button class="btn ghost" data-v="0">Cancel</button><button class="btn danger" data-v="1">${h(action)}</button></div></div>
    </div>`;
    const done = (v) => { modal.close(); resolve(v); };
    modal.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => done(b.dataset.v === '1')));
    modal.addEventListener('close', () => resolve(false), { once: true });
    modal.showModal();
    modal.querySelector('[data-v="0"]').focus();
  });
}

function openImportModal(errors = null, message = '') {
  const modal = $('#modal');
  modal.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h2>Import from CSV</h2><button class="icon-btn" data-close-modal aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">
      <p class="confirm-text">Bring in a spreadsheet of things you own. Only <b>name</b> is required. Rows that share an <b>item_ref</b> become one item with several warranties. A file exported from Lifespan imports as-is.</p>
      <pre class="code-sample">item_ref,name,location,purchase_date,price,life_months,coverage_label,coverage_expires_on
1,Washer,Laundry,2025-01-10,1099.00,120,Manufacturer,2026-01-10
1,Washer,Laundry,2025-01-10,1099.00,120,Direct drive motor,2035-01-10
2,Ladder,Garage,,,,,</pre>
      ${errors ? `<p class="form-error" style="margin-top:16px">${icon('alert', 'sm')} ${h(message)}</p>
        <ul class="import-errors">${errors.map((e) => `<li><span class="mono">Row ${e.row}</span><span class="mono">${h(e.field)}</span><span>${h(e.message)}</span></li>`).join('')}</ul>` : ''}
    </div>
    <div class="modal-foot"><a class="btn ghost" href="/api/export.csv" download>${icon('download')} Download current data</a>
      <div class="right"><button class="btn primary" data-action="pick-csv">${icon('upload')} Choose CSV file</button></div></div>
  </div>`;
  if (!modal.open) modal.showModal();
}

async function importCsvFile(file) {
  try {
    const text = await file.text();
    const res = await api('POST', '/api/import', text, { 'content-type': 'text/csv' });
    if ($('#modal').open) $('#modal').close();
    toast(`Imported ${plural(res.items_created, 'item')} and ${plural(res.coverages_created, 'warranty', 'warranties')}`, 'ok');
    await refresh();
    location.hash = '#/inventory';
  } catch (err) {
    if (err.rows?.length) openImportModal(err.rows, err.message);
    else toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- command palette

function openPalette() {
  const pal = $('#palette');
  pal.innerHTML = `<div class="palette-card">
    <label class="palette-input">${icon('search')}<input id="pal-q" placeholder="Search items or jump to…" autocomplete="off" spellcheck="false" aria-label="Search"><kbd>esc</kbd></label>
    <div class="palette-list" id="pal-list" role="listbox"></div>
    <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></div>
  </div>`;
  const actions = [
    { label: 'New item', hint: 'N', icon: 'plus', run: () => openItemModal() },
    { label: 'Go to Overview', icon: 'overview', run: () => { location.hash = '#/overview'; } },
    { label: 'Go to Inventory', icon: 'box', run: () => { location.hash = '#/inventory'; } },
    { label: 'Go to Timeline', icon: 'calendar', run: () => { location.hash = '#/timeline'; } },
    { label: 'Import CSV', icon: 'upload', run: () => openImportModal() },
    { label: 'Export CSV', icon: 'download', run: () => { location.href = '/api/export.csv'; } },
    { label: 'Toggle dark mode', icon: 'moon', run: () => toggleTheme() },
  ];
  let sel = 0; let results = [];
  const draw = () => {
    const q = $('#pal-q').value.trim().toLowerCase();
    const items = state.items.filter((i) => !q || `${i.name} ${i.brand} ${i.model} ${i.serial_number} ${i.location}`.toLowerCase().includes(q)).slice(0, 8)
      .map((i) => ({ label: i.name, sub: [i.location, i.serial_number].filter(Boolean).join(' · '), icon: 'box', status: i.status, run: () => openDrawer(i.id) }));
    const acts = actions.filter((a) => !q || a.label.toLowerCase().includes(q));
    results = [...items, ...acts];
    sel = Math.min(sel, Math.max(results.length - 1, 0));
    let idx = 0;
    const row = (r) => `<div class="palette-item" role="option" data-i="${idx}" aria-selected="${idx++ === sel}">${icon(r.icon)}<span class="t">${h(r.label)}${r.sub ? `<span>${h(r.sub)}</span>` : ''}</span>${r.status ? `<span class="status s-${r.status}"></span>` : r.hint ? `<kbd>${r.hint}</kbd>` : ''}</div>`;
    $('#pal-list').innerHTML = results.length
      ? `${items.length ? `<div class="palette-group">Items</div>${items.map(row).join('')}` : ''}${acts.length ? `<div class="palette-group">Actions</div>${acts.map(row).join('')}` : ''}`
      : '<div class="palette-empty">No results</div>';
  };
  const run = (i) => { const r = results[i]; if (!r) return; pal.close(); r.run(); };
  $('#pal-q').addEventListener('input', () => { sel = 0; draw(); });
  $('#pal-q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(results.length, 1); draw(); $('.palette-item[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + results.length) % Math.max(results.length, 1); draw(); $('.palette-item[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  $('#pal-list').addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) run(Number(it.dataset.i)); });
  $('#pal-list').addEventListener('mousemove', (e) => { const it = e.target.closest('[data-i]'); if (it && Number(it.dataset.i) !== sel) { sel = Number(it.dataset.i); $$('.palette-item').forEach((n) => n.setAttribute('aria-selected', String(Number(n.dataset.i) === sel))); } });
  pal.addEventListener('click', (e) => { if (e.target === pal) pal.close(); });
  draw();
  pal.showModal();
  $('#pal-q').focus();
}

// ---------------------------------------------------------------- toast, theme, copy

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : 'check')}<span>${h(msg)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, kind === 'error' ? 5000 : 2600);
}

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  const dark = effectiveTheme() === 'dark';
  $$('.theme-ic use').forEach((u) => u.setAttribute('href', dark ? '#i-sun' : '#i-moon'));
  $$('.theme-label').forEach((l) => { l.textContent = dark ? 'Light mode' : 'Dark mode'; });
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#121211' : '#F5F3EE'));
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  storage.set('lifespan-theme', next);
  applyTheme(next);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); } catch { toast('Copy failed — select and copy manually', 'error'); }
}

// ---------------------------------------------------------------- global events

document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open && !e.target.closest('.drawer')) { e.preventDefault(); openDrawer(open.dataset.open); return; }

  const cp = e.target.closest('[data-copy]');
  if (cp) { e.preventDefault(); copy(cp.dataset.copy); return; }

  if (e.target.closest('[data-close-modal]')) { $('#modal').close(); return; }

  const cat = e.target.closest('[data-category]');
  if (cat) { e.preventDefault(); state.filters = { ...state.filters, location: '', status: '', category: cat.dataset.category }; location.hash = '#/inventory'; if (state.route === 'inventory') render(); return; }

  const editCov = e.target.closest('[data-edit-cov]');
  if (editCov) { const item = state.items.find((i) => i.id === state.drawerId); renderDrawer(item, { editing: Number(editCov.dataset.editCov) }); return; }

  const delCov = e.target.closest('[data-del-cov]');
  if (delCov) {
    const item = state.items.find((i) => i.id === state.drawerId);
    const cov = item.coverages.find((c) => c.id === Number(delCov.dataset.delCov));
    if (await confirmDialog({ title: 'Remove coverage?', body: `<b>${h(cov.label)}</b> will be removed from ${h(item.name)}.`, action: 'Remove' })) {
      try { await api('DELETE', `/api/coverages/${cov.id}`); toast('Coverage removed', 'ok'); await refresh(); } catch (err) { toast(err.message, 'error'); }
    }
    return;
  }

  const delDoc = e.target.closest('[data-del-doc]');
  if (delDoc) {
    const item = state.items.find((i) => i.id === state.drawerId);
    const doc = item.documents.find((d) => d.id === Number(delDoc.dataset.delDoc));
    if (await confirmDialog({ title: 'Delete document?', body: `<b>${h(doc.filename)}</b> will be permanently deleted. This cannot be undone.` })) {
      try { await api('DELETE', `/api/documents/${doc.id}`); toast('Document deleted', 'ok'); await refresh(); } catch (err) { toast(err.message, 'error'); }
    }
    return;
  }

  const act = e.target.closest('[data-action]');
  if (!act) return;
  const item = state.items.find((i) => i.id === state.drawerId);
  switch (act.dataset.action) {
    case 'reload': location.reload(); break;
    case 'palette': openPalette(); break;
    case 'theme': toggleTheme(); break;
    case 'new-item': openItemModal(); break;
    case 'import': openImportModal(); break;
    case 'pick-csv': $('#csv-input').click(); break;
    case 'close-drawer': closeDrawer(); break;
    case 'edit-item': openItemModal(item); break;
    case 'duplicate-item':
      try {
        const copy = await api('POST', `/api/items/${item.id}/duplicate`);
        toast('Copy created — add its serial number', 'ok');
        await refresh();
        openDrawer(copy.id);
        openItemModal(state.items.find((i) => i.id === copy.id));
      } catch (err) { toast(err.message, 'error'); }
      break;
    case 'test-reminder':
      act.disabled = true;
      try { await api('POST', '/api/reminders/test'); toast('Test message sent', 'ok'); } catch (err) { toast(err.message, 'error'); }
      act.disabled = false;
      break;
    case 'add-coverage': renderDrawer(item, { editing: 'new' }); break;
    case 'cancel-cov': renderDrawer(item); break;
    case 'pick-docs': if (e.target.closest('select')) break; $('#doc-input').click(); break;
    case 'clear-filters': state.filters = { q: '', status: '', location: '', category: '', sort: state.filters.sort }; location.hash = '#/inventory'; render(); renderSidebar(); break;
    case 'delete-item':
      if (await confirmDialog({ title: 'Delete this item?', body: `<b>${h(item.name)}</b>, its ${plural(item.coverages.length, 'warranty', 'warranties')} and ${plural(item.documents.length, 'document')} will be permanently deleted. This cannot be undone.` })) {
        try { await api('DELETE', `/api/items/${item.id}`); closeDrawer(); toast('Item deleted', 'ok'); await refresh(); } catch (err) { toast(err.message, 'error'); }
      }
      break;
    case 'demo':
      act.disabled = true;
      try { await api('POST', '/api/demo'); toast('Sample household loaded', 'ok'); await refresh(); } catch (err) { act.disabled = false; toast(err.message, 'error'); }
      break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!$('#palette').open) openPalette(); return; }
  if (e.key === 'Escape' && state.drawerId !== null && !$('#modal').open && !$('#palette').open) { closeDrawer(); return; }
  if (typing || $('#modal').open || $('#palette').open) return;
  if (e.key === '/') { e.preventDefault(); openPalette(); }
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openItemModal(); }
  if (e.key === 'Enter' && e.target.matches('.trow, .dropzone')) e.target.click();
});

$('#drawer-scrim').addEventListener('click', closeDrawer);
$('#csv-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importCsvFile(f); });
$('#doc-input').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; if (state.drawerId) uploadDocs(state.drawerId, files); });
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').close(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

// ---------------------------------------------------------------- boot

applyTheme(storage.get('lifespan-theme'));
parseRoute();
render();
refresh().then(openPendingItem).catch((err) => {
  $('#main').innerHTML = `<div class="page"><div class="card empty">${icon('alert')}<h3>Can’t reach Lifespan</h3><p>${h(err.message)}</p><button class="btn" data-action="reload">Try again</button></div></div>`;
});
