import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, transaction } from './db.js';
import {
  bookValueCents, coverageState, daysBetween, itemStatus, nextExpiry, todayIso, writeOffDate, addDays,
} from './domain.js';
import {
  DOCUMENT_KINDS, HttpError, parseId, validateCoverage, validateItem,
} from './validation.js';
import { parseCsv, toCsv } from './csv.js';
import { buildCalendar } from './ics.js';
import { demoInventory } from './demo.js';
import { sendWebhook } from './reminders.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const JSON_LIMIT = 1_000_000;
const CSV_LIMIT = 5_000_000;
export const UPLOAD_LIMIT = 25 * 1024 * 1024;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

const ITEM_COLUMNS = ['name', 'category', 'brand', 'model', 'serial_number', 'location', 'retailer', 'purchase_date', 'price_cents', 'life_months', 'notes'];
const CSV_HEADER = [
  'item_ref', 'name', 'category', 'brand', 'model', 'serial_number', 'location', 'retailer',
  'purchase_date', 'price', 'life_months', 'notes',
  'coverage_label', 'coverage_provider', 'coverage_starts_on', 'coverage_expires_on', 'coverage_notes',
];

export function createApp({
  dbPath = ':memory:', uploadDir, clock = () => new Date(),
  allowedHosts = LOOPBACK_HOSTS, webhook = null, remindDays = 14, schedule = false,
} = {}) {
  if (!uploadDir) throw new Error('uploadDir is required');
  mkdirSync(uploadDir, { recursive: true });
  const db = openDatabase(dbPath);
  const now = () => clock().toISOString();
  const today = () => todayIso(clock());

  // ---------- data access ----------

  const q = {
    item: db.prepare('SELECT * FROM items WHERE id = ?'),
    items: db.prepare('SELECT * FROM items ORDER BY id'),
    coveragesFor: db.prepare('SELECT * FROM coverages WHERE item_id = ? ORDER BY expires_on, id'),
    allCoverages: db.prepare('SELECT * FROM coverages ORDER BY expires_on, id'),
    coverage: db.prepare('SELECT * FROM coverages WHERE id = ?'),
    documentsFor: db.prepare('SELECT * FROM documents WHERE item_id = ? ORDER BY uploaded_at DESC, id DESC'),
    allDocuments: db.prepare('SELECT * FROM documents ORDER BY uploaded_at DESC, id DESC'),
    document: db.prepare('SELECT * FROM documents WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM items'),
    insertItem: db.prepare(`INSERT INTO items (${ITEM_COLUMNS.join(', ')}, created_at, updated_at)
      VALUES (${ITEM_COLUMNS.map((c) => `:${c}`).join(', ')}, :created_at, :updated_at)`),
    insertCoverage: db.prepare(`INSERT INTO coverages (item_id, label, provider, starts_on, expires_on, notes, created_at)
      VALUES (:item_id, :label, :provider, :starts_on, :expires_on, :notes, :created_at)`),
    insertDocument: db.prepare(`INSERT INTO documents (item_id, kind, filename, mime, size_bytes, storage_key, uploaded_at)
      VALUES (:item_id, :kind, :filename, :mime, :size_bytes, :storage_key, :uploaded_at)`),
    deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
    deleteCoverage: db.prepare('DELETE FROM coverages WHERE id = ?'),
    deleteDocument: db.prepare('DELETE FROM documents WHERE id = ?'),
    touchItem: db.prepare('UPDATE items SET updated_at = ? WHERE id = ?'),
    dueReminders: db.prepare(`SELECT c.*, i.name AS item_name FROM coverages c JOIN items i ON i.id = c.item_id
      WHERE c.expires_on BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM reminders_sent r WHERE r.coverage_id = c.id AND r.expires_on = c.expires_on)
      ORDER BY c.expires_on, i.name`),
    markReminded: db.prepare('INSERT OR IGNORE INTO reminders_sent (coverage_id, expires_on, sent_at) VALUES (?, ?, ?)'),
  };

  const ITEM_DEFAULTS = Object.fromEntries(ITEM_COLUMNS.map((c) => [c, ['purchase_date', 'price_cents', 'life_months'].includes(c) ? null : '']));

  function insertItem(fields) {
    const stamp = now();
    const { lastInsertRowid } = q.insertItem.run({ ...ITEM_DEFAULTS, ...fields, created_at: stamp, updated_at: stamp });
    return Number(lastInsertRowid);
  }

  function insertCoverage(itemId, fields) {
    const { lastInsertRowid } = q.insertCoverage.run({
      provider: '', notes: '', starts_on: null, ...fields, item_id: itemId, created_at: now(),
    });
    return Number(lastInsertRowid);
  }

  function getItemRow(id) {
    const row = q.item.get(id);
    if (!row) throw new HttpError(404, 'not_found', 'Item not found.');
    return row;
  }

  function presentCoverage(c, t) {
    return { ...c, state: coverageState(c, t), days_left: daysBetween(t, c.expires_on) };
  }

  function presentDocument(d) {
    const { storage_key: _k, ...rest } = d;
    return { ...rest, url: `/api/documents/${d.id}/file` };
  }

  function presentItem(row, coverages, documents, t) {
    const covs = coverages.map((c) => presentCoverage(c, t));
    const next = nextExpiry(coverages, t);
    const lastEnd = coverages.reduce((m, c) => (m && m > c.expires_on ? m : c.expires_on), null);
    return {
      ...row,
      status: itemStatus(coverages, t),
      next_expiry: next ? { coverage_id: next.id, label: next.label, date: next.expires_on, days_left: daysBetween(t, next.expires_on) } : null,
      coverage_ends_on: lastEnd,
      write_off_date: writeOffDate(row.purchase_date, row.life_months),
      book_value_cents: bookValueCents(row.price_cents, row.purchase_date, row.life_months, t),
      has_receipt: documents.some((d) => d.kind === 'receipt' || d.kind === 'invoice'),
      document_count: documents.length,
      coverages: covs,
      documents: documents.map(presentDocument),
    };
  }

  function loadItem(id) {
    const row = getItemRow(id);
    return presentItem(row, q.coveragesFor.all(id), q.documentsFor.all(id), today());
  }

  function loadAll() {
    const t = today();
    const covs = new Map();
    for (const c of q.allCoverages.all()) (covs.get(c.item_id) ?? covs.set(c.item_id, []).get(c.item_id)).push(c);
    const docs = new Map();
    for (const d of q.allDocuments.all()) (docs.get(d.item_id) ?? docs.set(d.item_id, []).get(d.item_id)).push(d);
    return q.items.all().map((row) => presentItem(row, covs.get(row.id) ?? [], docs.get(row.id) ?? [], t));
  }

  function updateItem(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sql = `UPDATE items SET ${keys.map((k) => `${k} = :${k}`).join(', ')}, updated_at = :updated_at WHERE id = :id`;
    db.prepare(sql).run({ ...fields, updated_at: now(), id });
  }

  function removeStoredFile(key) {
    try { unlinkSync(join(uploadDir, key)); } catch { /* already gone */ }
  }

  // ---------- handlers ----------

  const SORTS = {
    name: (a, b) => a.name.localeCompare(b.name),
    recent: (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id,
    purchased: (a, b) => (b.purchase_date ?? '').localeCompare(a.purchase_date ?? ''),
    value: (a, b) => (b.price_cents ?? -1) - (a.price_cents ?? -1),
    expiry: (a, b) => {
      const ad = a.next_expiry?.date ?? '9999-12-31';
      const bd = b.next_expiry?.date ?? '9999-12-31';
      return ad.localeCompare(bd) || a.name.localeCompare(b.name);
    },
  };

  function listItems(url) {
    const p = url.searchParams;
    const term = (p.get('q') ?? '').trim().toLowerCase();
    const status = p.get('status');
    const location = p.get('location');
    const category = p.get('category');
    const sort = p.get('sort') ?? 'expiry';
    if (!SORTS[sort]) throw new HttpError(400, 'invalid_sort', `Sort must be one of: ${Object.keys(SORTS).join(', ')}.`);
    if (status && !['covered', 'expiring', 'expired', 'none'].includes(status)) {
      throw new HttpError(400, 'invalid_status', 'Status must be one of: covered, expiring, expired, none.');
    }
    let items = loadAll();
    if (term) {
      items = items.filter((it) => [it.name, it.brand, it.model, it.serial_number, it.location, it.category, it.retailer, it.notes,
        ...it.coverages.map((c) => `${c.label} ${c.provider}`)].join('\n').toLowerCase().includes(term));
    }
    if (status) items = items.filter((it) => it.status === status);
    if (location) items = items.filter((it) => it.location === location);
    if (category) items = items.filter((it) => it.category === category);
    items.sort(SORTS[sort]);
    return { items, total: items.length };
  }

  function dashboard() {
    const t = today();
    const items = loadAll();
    const counts = { total: items.length, covered: 0, expiring: 0, expired: 0, none: 0 };
    let purchase = 0; let book = 0;
    const byLocation = new Map(); const byCategory = new Map();
    const events = [];
    const horizon = addDays(t, 365);
    const lookback = addDays(t, -45);
    for (const it of items) {
      counts[it.status]++;
      purchase += it.price_cents ?? 0;
      book += it.book_value_cents ?? 0;
      for (const [map, key] of [[byLocation, it.location || 'Unassigned'], [byCategory, it.category || 'Uncategorized']]) {
        const e = map.get(key) ?? { name: key, count: 0, value_cents: 0 };
        e.count++; e.value_cents += it.price_cents ?? 0; map.set(key, e);
      }
      for (const c of it.coverages) {
        if (c.expires_on >= lookback && c.expires_on <= horizon) {
          events.push({ type: 'coverage_ends', date: c.expires_on, days_left: c.days_left, item_id: it.id, item_name: it.name, label: c.label, provider: c.provider });
        }
      }
      if (it.write_off_date && it.write_off_date >= lookback && it.write_off_date <= horizon) {
        events.push({ type: 'write_off', date: it.write_off_date, days_left: daysBetween(t, it.write_off_date), item_id: it.id, item_name: it.name, label: 'Fully depreciated', provider: '' });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.item_name.localeCompare(b.item_name));
    const rank = (m) => [...m.values()].sort((a, b) => b.value_cents - a.value_cents || a.name.localeCompare(b.name));
    return {
      today: t,
      counts,
      purchase_value_cents: purchase,
      book_value_cents: book,
      documents: items.reduce((n, it) => n + it.document_count, 0),
      missing_receipts: items.filter((it) => !it.has_receipt).length,
      timeline: events,
      by_location: rank(byLocation),
      by_category: rank(byCategory),
    };
  }

  function meta() {
    const pick = (col) => db.prepare(`SELECT DISTINCT ${col} AS v FROM items WHERE ${col} <> '' ORDER BY ${col} COLLATE NOCASE`).all().map((r) => r.v);
    return {
      locations: pick('location'), categories: pick('category'), brands: pick('brand'), retailers: pick('retailer'),
      providers: db.prepare("SELECT DISTINCT provider AS v FROM coverages WHERE provider <> '' ORDER BY provider COLLATE NOCASE").all().map((r) => r.v),
      document_kinds: DOCUMENT_KINDS,
    };
  }

  function createItem(body) {
    const { coverages = [], ...rest } = body ?? {};
    if (!Array.isArray(coverages)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { coverages: 'Must be a list.' });
    const fields = validateItem(rest);
    const covFields = coverages.map((c, i) => {
      try { return validateCoverage(c); } catch (err) {
        if (err instanceof HttpError && err.fields) {
          throw new HttpError(422, 'validation_failed', 'Some fields need attention.',
            Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [`coverages[${i}].${k}`, v])));
        }
        throw err;
      }
    });
    const id = transaction(db, () => {
      const newId = insertItem(fields);
      for (const c of covFields) insertCoverage(newId, c);
      return newId;
    });
    return loadItem(id);
  }

  function exportCsv() {
    const rows = [];
    for (const it of loadAll()) {
      const base = {
        item_ref: it.id, name: it.name, category: it.category, brand: it.brand, model: it.model,
        serial_number: it.serial_number, location: it.location, retailer: it.retailer,
        purchase_date: it.purchase_date ?? '', price: it.price_cents == null ? '' : (it.price_cents / 100).toFixed(2),
        life_months: it.life_months ?? '', notes: it.notes,
      };
      if (it.coverages.length === 0) rows.push(base);
      for (const c of it.coverages) {
        rows.push({ ...base, coverage_label: c.label, coverage_provider: c.provider, coverage_starts_on: c.starts_on ?? '', coverage_expires_on: c.expires_on, coverage_notes: c.notes });
      }
    }
    return toCsv(CSV_HEADER, rows);
  }

  function importCsv(text) {
    let parsed;
    try { parsed = parseCsv(text); } catch (err) { throw new HttpError(400, 'invalid_csv', err.message); }
    if (!parsed.header.includes('name')) throw new HttpError(400, 'invalid_csv', 'CSV must include a "name" column.');
    const groups = new Map();
    const errors = [];
    parsed.records.forEach((rec, idx) => {
      const rowNo = idx + 2;
      const ref = rec.item_ref || `row-${rowNo}`;
      let group = groups.get(ref);
      if (!group) {
        const price = rec.price ?? '';
        let priceNum = price === '' ? null : Number(price.replace(/[$,\s]/g, ''));
        let rowFailed = false;
        if (priceNum !== null && !Number.isFinite(priceNum)) {
          errors.push({ row: rowNo, field: 'price', message: 'Price must be a number.' });
          priceNum = null; rowFailed = true;
        }
        const life = rec.life_months ?? '';
        let lifeNum = life === '' ? null : Number(life);
        if (lifeNum !== null && !Number.isInteger(lifeNum)) {
          errors.push({ row: rowNo, field: 'life_months', message: 'Must be a whole number of months.' });
          lifeNum = null; rowFailed = true;
        }
        const candidate = {
          ...Object.fromEntries(['name', 'category', 'brand', 'model', 'serial_number', 'location', 'retailer', 'notes'].map((k) => [k, rec[k] ?? ''])),
          purchase_date: rec.purchase_date || null,
          price_cents: priceNum === null ? null : Math.round(priceNum * 100),
          life_months: lifeNum,
        };
        try { group = { item: validateItem(candidate), coverages: [] }; } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          for (const [field, message] of Object.entries(err.fields ?? {})) errors.push({ row: rowNo, field, message });
          group = { item: null, coverages: [] };
        }
        if (rowFailed) group.item = null;
        groups.set(ref, group);
      }
      if (rec.coverage_label || rec.coverage_expires_on) {
        try {
          group.coverages.push(validateCoverage({
            label: rec.coverage_label ?? '', provider: rec.coverage_provider ?? '', notes: rec.coverage_notes ?? '',
            starts_on: rec.coverage_starts_on || null, expires_on: rec.coverage_expires_on ?? '',
          }));
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          for (const [field, message] of Object.entries(err.fields ?? {})) errors.push({ row: rowNo, field: `coverage_${field.replace(/^coverage_/, '')}`, message });
        }
      }
    });
    if (errors.length) throw new HttpError(422, 'import_failed', `Nothing was imported: ${errors.length} problem${errors.length === 1 ? '' : 's'} found.`, undefined, errors);
    let coveragesCreated = 0;
    transaction(db, () => {
      for (const { item, coverages } of groups.values()) {
        const id = insertItem(item);
        for (const c of coverages) { insertCoverage(id, c); coveragesCreated++; }
      }
    });
    return { items_created: groups.size, coverages_created: coveragesCreated };
  }

  function calendar() {
    const events = [];
    for (const it of loadAll()) {
      for (const c of it.coverages) {
        events.push({
          uid: `coverage-${c.id}`, date: c.expires_on,
          summary: `${it.name}: ${c.label} ends`,
          description: [c.provider && `Provider: ${c.provider}`, it.serial_number && `Serial: ${it.serial_number}`, c.notes].filter(Boolean).join('\n'),
        });
      }
      if (it.write_off_date) {
        events.push({ uid: `writeoff-${it.id}`, date: it.write_off_date, summary: `${it.name}: fully depreciated`, description: 'Book value reaches zero.' });
      }
    }
    return buildCalendar(events, { stamp: clock() });
  }

  function loadDemo() {
    if (q.count.get().n > 0) throw new HttpError(409, 'not_empty', 'Sample data can only be loaded into an empty inventory.');
    transaction(db, () => {
      for (const { coverages, ...item } of demoInventory(today())) {
        const id = insertItem(item);
        for (const c of coverages) insertCoverage(id, c);
      }
    });
    return { items_created: q.count.get().n };
  }

  async function uploadDocument(req, itemId, url) {
    getItemRow(itemId);
    const kind = url.searchParams.get('kind') ?? 'other';
    if (!DOCUMENT_KINDS.includes(kind)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { kind: `Must be one of: ${DOCUMENT_KINDS.join(', ')}.` });
    let filename = 'document';
    try { filename = decodeURIComponent(req.headers['x-filename'] ?? 'document'); } catch { /* keep default */ }
    filename = filename.replace(/[\\/\0\r\n"]/g, '_').trim().slice(0, 200) || 'document';
    const mime = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) throw new HttpError(415, 'unsupported_type', 'Unrecognized content type.');
    const body = await readBody(req, UPLOAD_LIMIT);
    if (body.length === 0) throw new HttpError(400, 'empty_file', 'The uploaded file is empty.');
    const ext = (extname(filename).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) ?? [''])[0];
    const key = `${randomUUID()}${ext}`;
    writeFileSync(join(uploadDir, key), body);
    try {
      const { lastInsertRowid } = q.insertDocument.run({
        item_id: itemId, kind, filename, mime, size_bytes: body.length, storage_key: key, uploaded_at: now(),
      });
      q.touchItem.run(now(), itemId);
      return presentDocument(q.document.get(Number(lastInsertRowid)));
    } catch (err) { removeStoredFile(key); throw err; }
  }

  function serveDocument(res, id, download) {
    const doc = q.document.get(id);
    if (!doc) throw new HttpError(404, 'not_found', 'Document not found.');
    const path = join(uploadDir, doc.storage_key);
    let size;
    try { size = statSync(path).size; } catch { throw new HttpError(410, 'file_missing', 'The stored file is missing.'); }
    const inline = !download && INLINE_SAFE.has(doc.mime);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': inline ? doc.mime : 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${doc.filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      // Chrome refuses to render PDFs in sandboxed documents, so PDFs get a locked-down policy without `sandbox`.
      'Content-Security-Policy': doc.mime === 'application/pdf' && inline
        ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'"
        : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    pipeFile(path, res);
  }

  // ---------- duplicate ----------

  function duplicateItem(id) {
    const row = getItemRow(id);
    const covs = q.coveragesFor.all(id);
    const fields = Object.fromEntries(ITEM_COLUMNS.map((c) => [c, row[c]]));
    const suffix = ' (copy)';
    fields.name = `${row.name.slice(0, 120 - suffix.length)}${suffix}`;
    fields.serial_number = '';
    const newId = transaction(db, () => {
      const nid = insertItem(fields);
      for (const c of covs) insertCoverage(nid, { label: c.label, provider: c.provider, starts_on: c.starts_on, expires_on: c.expires_on, notes: c.notes });
      return nid;
    });
    return loadItem(newId);
  }

  // ---------- reminders ----------

  function pendingReminders() {
    const t = today();
    return q.dueReminders.all(t, addDays(t, remindDays)).map((c) => ({
      coverage_id: c.id, item_id: c.item_id, item_name: c.item_name, label: c.label, provider: c.provider,
      date: c.expires_on, days_left: daysBetween(t, c.expires_on),
    }));
  }

  let reminderRun = null;
  async function runReminders() {
    if (!webhook) return { sent: 0, configured: false };
    if (reminderRun) return reminderRun; // never double-send from overlapping runs
    reminderRun = (async () => {
      const events = pendingReminders();
      if (events.length === 0) return { sent: 0, configured: true };
      await sendWebhook(webhook, events);
      const stamp = now();
      transaction(db, () => { for (const e of events) q.markReminded.run(e.coverage_id, e.date, stamp); });
      return { sent: events.length, configured: true };
    })();
    try { return await reminderRun; } finally { reminderRun = null; }
  }

  function reminderStatus() {
    return {
      configured: Boolean(webhook),
      format: webhook?.format ?? null,
      remind_days: remindDays,
      pending: pendingReminders(),
    };
  }

  // ---------- routing ----------

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, today: today() })],
    ['GET', /^\/api\/dashboard$/, () => dashboard()],
    ['GET', /^\/api\/meta$/, () => meta()],
    ['GET', /^\/api\/items$/, (_r, _m, url) => listItems(url)],
    ['POST', /^\/api\/items$/, async (req, _m, _u, res) => { res.statusCode = 201; return createItem(await readJson(req)); }],
    ['GET', /^\/api\/items\/([^/]+)$/, (_r, m) => loadItem(parseId(m[1]))],
    ['PATCH', /^\/api\/items\/([^/]+)$/, async (req, m) => {
      const id = parseId(m[1]); getItemRow(id);
      updateItem(id, validateItem(await readJson(req), { partial: true }));
      return loadItem(id);
    }],
    ['DELETE', /^\/api\/items\/([^/]+)$/, (_r, m) => {
      const id = parseId(m[1]); getItemRow(id);
      const keys = q.documentsFor.all(id).map((d) => d.storage_key);
      q.deleteItem.run(id);
      keys.forEach(removeStoredFile);
      return null;
    }],
    ['POST', /^\/api\/items\/([^/]+)\/coverages$/, async (req, m, _u, res) => {
      const id = parseId(m[1]); getItemRow(id);
      const covId = insertCoverage(id, validateCoverage(await readJson(req)));
      q.touchItem.run(now(), id);
      res.statusCode = 201;
      return presentCoverage(q.coverage.get(covId), today());
    }],
    ['PATCH', /^\/api\/coverages\/([^/]+)$/, async (req, m) => {
      const id = parseId(m[1]);
      const existing = q.coverage.get(id);
      if (!existing) throw new HttpError(404, 'not_found', 'Coverage not found.');
      const fields = validateCoverage(await readJson(req), { partial: true }, existing);
      const keys = Object.keys(fields);
      if (keys.length) db.prepare(`UPDATE coverages SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`).run({ ...fields, id });
      q.touchItem.run(now(), existing.item_id);
      return presentCoverage(q.coverage.get(id), today());
    }],
    ['DELETE', /^\/api\/coverages\/([^/]+)$/, (_r, m) => {
      const id = parseId(m[1]);
      const existing = q.coverage.get(id);
      if (!existing) throw new HttpError(404, 'not_found', 'Coverage not found.');
      q.deleteCoverage.run(id); q.touchItem.run(now(), existing.item_id);
      return null;
    }],
    ['POST', /^\/api\/items\/([^/]+)\/documents$/, async (req, m, url, res) => { res.statusCode = 201; return uploadDocument(req, parseId(m[1]), url); }],
    ['GET', /^\/api\/documents\/([^/]+)\/file$/, (_r, m, url, res) => { serveDocument(res, parseId(m[1]), url.searchParams.has('download')); return undefined; }],
    ['DELETE', /^\/api\/documents\/([^/]+)$/, (_r, m) => {
      const id = parseId(m[1]);
      const doc = q.document.get(id);
      if (!doc) throw new HttpError(404, 'not_found', 'Document not found.');
      q.deleteDocument.run(id); removeStoredFile(doc.storage_key); q.touchItem.run(now(), doc.item_id);
      return null;
    }],
    ['GET', /^\/api\/export\.csv$/, (_r, _m, _u, res) => sendText(res, 200, exportCsv(), 'text/csv; charset=utf-8', `lifespan-export-${today()}.csv`)],
    ['POST', /^\/api\/import$/, async (req) => importCsv((await readBody(req, CSV_LIMIT)).toString('utf8'))],
    ['GET', /^\/api\/calendar\.ics$/, (_r, _m, _u, res) => sendText(res, 200, calendar(), 'text/calendar; charset=utf-8')],
    ['POST', /^\/api\/items\/([^/]+)\/duplicate$/, (_r, m, _u, res) => { res.statusCode = 201; return duplicateItem(parseId(m[1])); }],
    ['GET', /^\/api\/reminders$/, () => reminderStatus()],
    ['POST', /^\/api\/reminders\/run$/, async () => {
      if (!webhook) throw new HttpError(409, 'not_configured', 'Set LIFESPAN_WEBHOOK_URL to enable reminders.');
      try { return await runReminders(); } catch (err) { throw new HttpError(502, 'webhook_failed', err.message); }
    }],
    ['POST', /^\/api\/reminders\/test$/, async () => {
      if (!webhook) throw new HttpError(409, 'not_configured', 'Set LIFESPAN_WEBHOOK_URL to enable reminders.');
      try { return { ok: true, status: await sendWebhook(webhook, [], { test: true }) }; } catch (err) { throw new HttpError(502, 'webhook_failed', err.message); }
    }],
    ['POST', /^\/api\/demo$/, (_r, _m, _u, res) => { res.statusCode = 201; return loadDemo(); }],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!hostAllowed(req.headers.host, allowedHosts)) {
        throw new HttpError(421, 'host_not_allowed', 'This host name is not allowed. Set LIFESPAN_ALLOWED_HOSTS to permit it.');
      }
      if (url.pathname.startsWith('/api/')) {
        const pathMatches = routes.filter(([, re]) => re.test(url.pathname));
        if (pathMatches.length === 0) throw new HttpError(404, 'not_found', 'No such endpoint.');
        const route = pathMatches.find(([method]) => method === req.method);
        if (!route) {
          res.setHeader('Allow', pathMatches.map(([m]) => m).join(', '));
          throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here.`);
        }
        if (['POST', 'PATCH', 'DELETE'].includes(req.method)) assertSameOrigin(req);
        const result = await route[2](req, url.pathname.match(route[1]), url, res);
        if (res.headersSent || res.writableEnded) return;
        if (result === null) { res.writeHead(204, SECURITY_HEADERS); res.end(); return; }
        sendJson(res, res.statusCode || 200, result);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      serveStatic(req, res, url.pathname);
    } catch (err) {
      if (res.headersSent) { res.destroy(err); return; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.fields && { fields: err.fields }), ...(err.rows && { rows: err.rows }) } });
      } else {
        console.error(err);
        sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on our side.' } });
      }
    }
  }

  const server = createServer((req, res) => { handle(req, res); });
  let timer = null;
  if (schedule && webhook) {
    const tick = () => runReminders().catch((err) => console.error(`Reminder webhook failed: ${err.message}`));
    server.on('listening', () => { setTimeout(tick, 5_000).unref(); timer = setInterval(tick, 60 * 60 * 1000); timer.unref(); });
  }
  server.on('close', () => { if (timer) clearInterval(timer); db.close(); });
  server.runReminders = runReminders;
  return server;
}

// ---------- http helpers ----------

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients (curl, tests)
  const host = req.headers.host;
  let originHost;
  try { originHost = new URL(origin).host; } catch { originHost = null; }
  if (originHost !== host) throw new HttpError(403, 'cross_origin', 'Cross-origin requests are not allowed.');
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'too_large', `Payload exceeds ${Math.round(limit / 1024 / 1024)} MB.`));
      return;
    }
    const chunks = []; let size = 0; let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; reject(new HttpError(413, 'too_large', `Payload exceeds ${Math.round(limit / 1024 / 1024)} MB.`)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolveBody(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_type', 'Send JSON with Content-Type: application/json.');
  const raw = await readBody(req, JSON_LIMIT);
  try { return JSON.parse(raw.toString('utf8') || 'null'); } catch { throw new HttpError(400, 'invalid_json', 'Body is not valid JSON.'); }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, status, body, type, downloadName) {
  res.writeHead(status, {
    ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    ...(downloadName && { 'Content-Disposition': `attachment; filename="${downloadName}"` }),
  });
  res.end(body);
  return undefined;
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad_path', 'Malformed path.'); }
  if (rel.includes('\0')) throw new HttpError(400, 'bad_path', 'Malformed path.');
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = resolve(PUBLIC_DIR);
  let file = resolve(root, normalize(`.${rel}`));
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'not_found', 'Not found.');
  let stat;
  try { stat = statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    // SPA fallback for extensionless paths.
    if (extname(rel)) throw new HttpError(404, 'not_found', 'Not found.');
    file = join(root, 'index.html'); stat = statSync(file);
  }
  const type = STATIC_TYPES[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'Last-Modified': stat.mtime.toUTCString() });
  if (req.method === 'HEAD') { res.end(); return; }
  pipeFile(file, res);
}

// A failed read must end this one response, never crash the process.
function pipeFile(path, res) {
  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Guards against DNS rebinding: a hostile page that rebinds its own domain to
// 127.0.0.1 would otherwise be able to read and write the whole inventory.
function hostAllowed(hostHeader, allowedHosts) {
  if (allowedHosts === '*') return true;
  if (!hostHeader) return false;
  let hostname;
  try { hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase(); } catch { return false; }
  return allowedHosts.some((h) => h === hostname || (h.startsWith('.') && hostname.endsWith(h)));
}
