import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const TODAY = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15 local time
let server; let base; let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lifespan-test-'));
  server = createApp({ dbPath: join(dir, 'test.db'), uploadDir: join(dir, 'uploads'), clock: () => TODAY });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Uint8Array) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(base + path, init);
  const type = res.headers.get('content-type') ?? '';
  const data = res.status === 204 ? null : type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

describe('health and static', () => {
  test('health reports the clock date', async () => {
    const { status, data } = await api('GET', '/api/health');
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true, today: '2026-06-15' });
  });

  test('serves the app shell with security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await res.text(), /<title>Lifespan<\/title>/);
  });

  test('blocks path traversal', async () => {
    const res = await fetch(`${base}/..%2fpackage.json`);
    assert.equal(res.status, 404);
    const res2 = await fetch(`${base}/%2e%2e/server/app.js`);
    assert.equal(res2.status, 404);
  });

  test('rejects unexpected Host headers (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = (host) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/health', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(await status('evil.example:80'), 421);
    assert.equal(await status('localhost:4747'), 200);
    assert.equal(await status('127.0.0.1'), 200);
    assert.equal(await status('[::1]:4747'), 200);
  });

  test('unknown API route and wrong method', async () => {
    assert.equal((await api('GET', '/api/nope')).status, 404);
    const r = await api('PUT', '/api/items');
    assert.equal(r.status, 405);
    assert.match(r.headers.get('allow'), /GET/);
  });
});

describe('items', () => {
  let itemId;

  test('creates an item with nested coverages', async () => {
    const { status, data } = await api('POST', '/api/items', {
      name: '  Espresso Machine  ', category: 'Kitchenware', brand: 'Breville', serial_number: 'BES870-1',
      location: 'Kitchen', purchase_date: '2025-06-15', price_cents: 59999, life_months: 24,
      coverages: [
        { label: 'Manufacturer', provider: 'Breville', starts_on: '2025-06-15', expires_on: '2026-07-01' },
        { label: 'Extended', provider: 'Asurion', starts_on: '2026-07-01', expires_on: '2028-06-15' },
      ],
    });
    assert.equal(status, 201);
    assert.equal(data.name, 'Espresso Machine');
    assert.equal(data.coverages.length, 2);
    assert.equal(data.status, 'covered');
    assert.equal(data.next_expiry.label, 'Manufacturer');
    assert.equal(data.next_expiry.days_left, 16);
    assert.equal(data.coverages[0].state, 'expiring');
    assert.equal(data.coverages[1].state, 'upcoming');
    assert.equal(data.write_off_date, '2027-06-15');
    assert.ok(Math.abs(data.book_value_cents - 30000) < 100);
    assert.equal(data.has_receipt, false);
    itemId = data.id;
  });

  test('rejects invalid input with field-level errors', async () => {
    const { status, data } = await api('POST', '/api/items', { name: '', price_cents: -5, purchase_date: '2026-02-30', color: 'red' });
    assert.equal(status, 422);
    assert.equal(data.error.code, 'validation_failed');
    assert.ok(data.error.fields.name);
    assert.ok(data.error.fields.price_cents);
    assert.ok(data.error.fields.purchase_date);
    assert.ok(data.error.fields.color);
  });

  test('rejects coverage that ends before it starts', async () => {
    const { status, data } = await api('POST', '/api/items', { name: 'X', coverages: [{ label: 'Bad', starts_on: '2026-01-02', expires_on: '2026-01-01' }] });
    assert.equal(status, 422);
    assert.ok(data.error.fields['coverages[0].expires_on']);
    const list = await api('GET', '/api/items?q=X');
    assert.equal(list.data.items.filter((i) => i.name === 'X').length, 0, 'failed create must not leave a partial item');
  });

  test('rejects malformed JSON and wrong content type', async () => {
    const bad = await api('POST', '/api/items', '{"name":', { 'content-type': 'application/json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'invalid_json');
    const wrong = await api('POST', '/api/items', 'name=x', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(wrong.status, 415);
  });

  test('blocks cross-origin writes', async () => {
    const r = await api('POST', '/api/items', { name: 'Evil' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  test('reads, patches and clears fields', async () => {
    const got = await api('GET', `/api/items/${itemId}`);
    assert.equal(got.status, 200);
    const patched = await api('PATCH', `/api/items/${itemId}`, { location: 'Pantry', life_months: null, notes: 'Descale monthly' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.location, 'Pantry');
    assert.equal(patched.data.life_months, null);
    assert.equal(patched.data.write_off_date, null);
    assert.equal(patched.data.book_value_cents, 59999);
    assert.equal(patched.data.name, 'Espresso Machine');
    const badPatch = await api('PATCH', `/api/items/${itemId}`, { name: '' });
    assert.equal(badPatch.status, 422);
  });

  test('404s for missing or malformed ids', async () => {
    assert.equal((await api('GET', '/api/items/99999')).status, 404);
    assert.equal((await api('GET', '/api/items/abc')).status, 404);
    assert.equal((await api('PATCH', '/api/items/99999', { name: 'x' })).status, 404);
  });

  test('coverage CRUD', async () => {
    const created = await api('POST', `/api/items/${itemId}/coverages`, { label: 'Accidental damage', expires_on: '2026-06-01' });
    assert.equal(created.status, 201);
    assert.equal(created.data.state, 'expired');
    const patched = await api('PATCH', `/api/coverages/${created.data.id}`, { expires_on: '2029-01-01' });
    assert.equal(patched.data.state, 'active');
    const invalid = await api('PATCH', `/api/coverages/${created.data.id}`, { starts_on: '2030-01-01' });
    assert.equal(invalid.status, 422, 'start after existing expiry must be rejected');
    const del = await api('DELETE', `/api/coverages/${created.data.id}`);
    assert.equal(del.status, 204);
    assert.equal((await api('DELETE', `/api/coverages/${created.data.id}`)).status, 404);
  });

  test('document upload, inline view, download and delete', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 fake receipt');
    const up = await api('POST', `/api/items/${itemId}/documents?kind=receipt`, pdf, { 'content-type': 'application/pdf', 'x-filename': encodeURIComponent('Receipt – June.pdf') });
    assert.equal(up.status, 201);
    assert.equal(up.data.filename, 'Receipt – June.pdf');
    assert.equal(up.data.size_bytes, pdf.length);
    assert.equal(up.data.storage_key, undefined, 'storage key must not leak');

    const item = await api('GET', `/api/items/${itemId}`);
    assert.equal(item.data.has_receipt, true);
    assert.equal(item.data.document_count, 1);

    const inline = await fetch(base + up.data.url);
    assert.equal(inline.headers.get('content-type'), 'application/pdf');
    assert.match(inline.headers.get('content-disposition'), /^inline/);
    assert.equal(await inline.text(), '%PDF-1.4 fake receipt');

    const dl = await fetch(`${base}${up.data.url}?download`);
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
    await dl.arrayBuffer();

    const html = await api('POST', `/api/items/${itemId}/documents?kind=other`, '<script>alert(1)</script>', { 'content-type': 'text/html', 'x-filename': 'x.html' });
    const risky = await fetch(base + html.data.url);
    assert.equal(risky.headers.get('content-type'), 'application/octet-stream', 'html must never be served inline');
    assert.match(risky.headers.get('content-disposition'), /^attachment/);
    await risky.arrayBuffer();

    assert.equal((await api('POST', `/api/items/${itemId}/documents?kind=bogus`, 'x', { 'content-type': 'text/plain' })).status, 422);
    assert.equal((await api('POST', `/api/items/${itemId}/documents`, '', { 'content-type': 'text/plain' })).status, 400);

    assert.equal((await api('DELETE', `/api/documents/${html.data.id}`)).status, 204);
    assert.equal((await fetch(base + html.data.url)).status, 404);
  });

  test('rejects uploads over the size limit', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const r = await api('POST', `/api/items/${itemId}/documents`, big, { 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 413);
  });

  test('duplicates an item with its coverages but not its serial or files', async () => {
    const r = await api('POST', `/api/items/${itemId}/duplicate`);
    assert.equal(r.status, 201);
    assert.equal(r.data.name, 'Espresso Machine (copy)');
    assert.equal(r.data.serial_number, '');
    assert.equal(r.data.coverages.length, 2);
    assert.equal(r.data.documents.length, 0);
    assert.notEqual(r.data.id, itemId);
    assert.equal((await api('POST', '/api/items/99999/duplicate')).status, 404);
    assert.equal((await api('DELETE', `/api/items/${r.data.id}`)).status, 204);
  });

  test('deleting an item removes its coverages and stored files', async () => {
    const tmp = await api('POST', '/api/items', { name: 'Disposable', coverages: [{ label: 'W', expires_on: '2027-01-01' }] });
    await api('POST', `/api/items/${tmp.data.id}/documents?kind=photo`, 'png-bytes', { 'content-type': 'image/png', 'x-filename': 'a.png' });
    const before = readdirSync(join(dir, 'uploads')).length;
    assert.equal((await api('DELETE', `/api/items/${tmp.data.id}`)).status, 204);
    assert.equal(readdirSync(join(dir, 'uploads')).length, before - 1);
    assert.equal((await api('GET', `/api/items/${tmp.data.id}`)).status, 404);
  });
});

describe('demo, listing and dashboard', () => {
  test('demo refuses a non-empty inventory', async () => {
    const r = await api('POST', '/api/demo');
    assert.equal(r.status, 409);
  });

  test('import CSV is all-or-nothing', async () => {
    const bad = 'name,price,coverage_label,coverage_expires_on\nGood,10,W,2027-01-01\n,abc,W,not-a-date\n';
    const r = await api('POST', '/api/import', bad, { 'content-type': 'text/csv' });
    assert.equal(r.status, 422);
    assert.ok(r.data.error.rows.length >= 2);
    assert.ok(r.data.error.rows.every((e) => e.row === 3));
    const list = await api('GET', '/api/items?q=Good');
    assert.equal(list.data.total, 0);
  });

  test('import CSV groups rows by item_ref', async () => {
    const csv = [
      'item_ref,name,category,location,purchase_date,price,life_months,coverage_label,coverage_provider,coverage_starts_on,coverage_expires_on',
      'a,Washer,Appliances,Laundry,2025-01-10,"$1,099.00",120,Manufacturer,LG,2025-01-10,2026-01-10',
      'a,Washer,Appliances,Laundry,2025-01-10,"$1,099.00",120,Direct drive motor,LG,2025-01-10,2035-01-10',
      'b,Ladder,Tools,Garage,,,,,,,',
    ].join('\n');
    const r = await api('POST', '/api/import', csv, { 'content-type': 'text/csv' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { items_created: 2, coverages_created: 2 });
    const washer = (await api('GET', '/api/items?q=washer')).data.items[0];
    assert.equal(washer.price_cents, 109900);
    assert.equal(washer.coverages.length, 2);
    assert.equal(washer.status, 'covered');
  });

  test('filters, search and sort', async () => {
    const all = await api('GET', '/api/items?sort=name');
    const names = all.data.items.map((i) => i.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
    const none = await api('GET', '/api/items?status=none');
    assert.ok(none.data.items.every((i) => i.status === 'none'));
    assert.ok(none.data.items.some((i) => i.name === 'Ladder'));
    const loc = await api('GET', '/api/items?location=Garage');
    assert.deepEqual(loc.data.items.map((i) => i.name), ['Ladder']);
    const bySerial = await api('GET', '/api/items?q=bes870');
    assert.equal(bySerial.data.items[0].name, 'Espresso Machine');
    const byProvider = await api('GET', '/api/items?q=asurion');
    assert.equal(byProvider.data.total, 1);
    assert.equal((await api('GET', '/api/items?sort=bogus')).status, 400);
    assert.equal((await api('GET', '/api/items?status=bogus')).status, 400);
  });

  test('dashboard aggregates', async () => {
    const { status, data } = await api('GET', '/api/dashboard');
    assert.equal(status, 200);
    assert.equal(data.today, '2026-06-15');
    assert.equal(data.counts.total, 3);
    assert.equal(data.counts.covered + data.counts.expiring + data.counts.expired + data.counts.none, 3);
    assert.equal(data.purchase_value_cents, 59999 + 109900);
    assert.ok(data.timeline.some((e) => e.label === 'Manufacturer' && e.days_left === 16));
    const dates = data.timeline.map((e) => e.date);
    assert.deepEqual(dates, [...dates].sort());
    assert.ok(data.by_location.find((l) => l.name === 'Unassigned') === undefined);
    assert.equal(data.missing_receipts, 2);
  });

  test('meta lists distinct values', async () => {
    const { data } = await api('GET', '/api/meta');
    assert.deepEqual(data.locations, ['Garage', 'Laundry', 'Pantry']);
    assert.ok(data.providers.includes('Breville'));
    assert.ok(data.document_kinds.includes('receipt'));
  });

  test('CSV export round-trips through import', async () => {
    const res = await fetch(`${base}/api/export.csv`);
    assert.match(res.headers.get('content-disposition'), /lifespan-export-2026-06-15\.csv/);
    const csv = await res.text();
    const lines = csv.trim().split('\r\n');
    assert.ok(lines[0].startsWith('item_ref,name'));
    const before = (await api('GET', '/api/dashboard')).data.counts.total;
    const r = await api('POST', '/api/import', csv, { 'content-type': 'text/csv' });
    assert.equal(r.status, 200);
    assert.equal(r.data.items_created, before);
  });

  test('calendar feed lists coverage ends and write-offs', async () => {
    const res = await fetch(`${base}/api/calendar.ics`);
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    const ics = await res.text();
    assert.match(ics, /SUMMARY:Espresso Machine: Manufacturer ends/);
    assert.match(ics, /SUMMARY:Washer: fully depreciated/);
    assert.match(ics, /TRIGGER:-P14D/);
  });
});

describe('demo on an empty inventory', () => {
  test('loads a realistic household covering every status', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lifespan-demo-'));
    const s = createApp({ dbPath: join(d, 'db.sqlite'), uploadDir: join(d, 'u'), clock: () => TODAY });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}`;
    try {
      const r = await fetch(`${url}/api/demo`, { method: 'POST' });
      assert.equal(r.status, 201);
      const dash = await (await fetch(`${url}/api/dashboard`)).json();
      assert.equal(dash.counts.total, 12);
      for (const k of ['covered', 'expiring', 'expired', 'none']) assert.ok(dash.counts[k] > 0, `expected some ${k}`);
      assert.ok(dash.timeline.length > 3);
    } finally {
      await new Promise((r) => s.close(r));
      rmSync(d, { recursive: true, force: true });
    }
  });
});
