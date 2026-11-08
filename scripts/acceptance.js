// End-to-end acceptance run: boots the real server process on a throwaway data
// directory and walks through the full user journey over HTTP.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'lifespan-acceptance-'));
const port = 4800 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  \x1b[32m✔\x1b[0m ${name}`); }
  catch (err) { results.push([false, name]); console.log(`  \x1b[31m✖\x1b[0m ${name}\n      ${err.message}`); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
async function call(method, path, body, headers = {}) {
  const init = { method, headers };
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Uint8Array) init.body = body;
    else { init.body = JSON.stringify(body); init.headers = { ...headers, 'content-type': 'application/json' }; }
  }
  const res = await fetch(base + path, init);
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, data: res.status === 204 ? null : type.includes('json') ? await res.json() : await res.text() };
}

// A local stand-in for Discord/Slack/ntfy that records what Lifespan posts.
const hookMessages = [];
const hook = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { hookMessages.push(body); res.end('ok'); });
});
await new Promise((r) => hook.listen(0, '127.0.0.1', r));
const serverEnv = {
  ...process.env, PORT: String(port), LIFESPAN_DATA_DIR: dataDir,
  LIFESPAN_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/hook`, LIFESPAN_REMIND_DAYS: '365',
};

const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start.\n${serverLog}`);
}

try {
  await waitUp();
  console.log(`\nLifespan acceptance — ${base}\n`);
  let itemId; let docUrl;

  await check('Fresh install starts empty and serves the app', async () => {
    const d = await call('GET', '/api/dashboard');
    expect(d.status === 200 && d.data.counts.total === 0, 'dashboard should be empty');
    const page = await call('GET', '/');
    expect(page.status === 200 && page.data.includes('<title>Lifespan</title>'), 'index.html not served');
    for (const asset of ['/app.js', '/styles.css', '/favicon.svg']) expect((await call('GET', asset)).status === 200, `${asset} missing`);
  });

  await check('User adds an item with two warranties', async () => {
    const r = await call('POST', '/api/items', {
      name: 'Front-load Washer', brand: 'LG', model: 'WM4000HWA', serial_number: 'LG-WM-555', location: 'Laundry', category: 'Appliances',
      purchase_date: '2025-03-01', price_cents: 99900, life_months: 120,
      coverages: [
        { label: 'Manufacturer warranty', provider: 'LG', starts_on: '2025-03-01', expires_on: '2026-03-01' },
        { label: 'Direct drive motor', provider: 'LG', starts_on: '2025-03-01', expires_on: '2035-03-01' },
      ],
    });
    expect(r.status === 201, `expected 201, got ${r.status}`);
    expect(r.data.coverages.length === 2 && r.data.status === 'covered', 'item should be covered');
    itemId = r.data.id;
  });

  await check('Invalid input is rejected with helpful field errors', async () => {
    const r = await call('POST', '/api/items', { name: '', purchase_date: 'yesterday' });
    expect(r.status === 422 && r.data.error.fields.name && r.data.error.fields.purchase_date, 'expected field errors');
  });

  await check('User attaches a receipt and can open it', async () => {
    const up = await call('POST', `/api/items/${itemId}/documents?kind=receipt`, new TextEncoder().encode('%PDF-1.7 receipt'), { 'content-type': 'application/pdf', 'x-filename': 'washer-receipt.pdf' });
    expect(up.status === 201, `upload failed: ${up.status}`);
    docUrl = up.data.url;
    const file = await fetch(base + docUrl);
    expect(file.status === 200 && (await file.text()) === '%PDF-1.7 receipt', 'document content mismatch');
    const item = await call('GET', `/api/items/${itemId}`);
    expect(item.data.has_receipt === true, 'receipt not registered');
  });

  await check('User adds, edits and removes a coverage', async () => {
    const c = await call('POST', `/api/items/${itemId}/coverages`, { label: 'Store protection plan', provider: 'Best Buy', expires_on: '2029-03-01' });
    expect(c.status === 201, 'create coverage failed');
    const p = await call('PATCH', `/api/coverages/${c.data.id}`, { provider: 'Geek Squad' });
    expect(p.data.provider === 'Geek Squad', 'patch failed');
    expect((await call('DELETE', `/api/coverages/${c.data.id}`)).status === 204, 'delete failed');
  });

  await check('User edits item details', async () => {
    const r = await call('PATCH', `/api/items/${itemId}`, { location: 'Basement', notes: 'Clean gasket monthly.' });
    expect(r.status === 200 && r.data.location === 'Basement', 'edit failed');
  });

  await check('Search finds the item by serial number and provider', async () => {
    expect((await call('GET', '/api/items?q=lg-wm-555')).data.total === 1, 'serial search failed');
    expect((await call('GET', '/api/items?q=direct drive')).data.total === 1, 'coverage search failed');
  });

  await check('User imports a spreadsheet', async () => {
    const soon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const csv = `name,location,price,coverage_label,coverage_expires_on\nRobot Vacuum,Living Room,"$499.00",Manufacturer,${soon}\nToolbox,Garage,,,\n`;
    const r = await call('POST', '/api/import', csv, { 'content-type': 'text/csv' });
    expect(r.status === 200 && r.data.items_created === 2 && r.data.coverages_created === 1, JSON.stringify(r.data));
  });

  await check('Dashboard summarises value, rooms and upcoming dates', async () => {
    const d = (await call('GET', '/api/dashboard')).data;
    expect(d.counts.total === 3, `expected 3 items, got ${d.counts.total}`);
    expect(d.purchase_value_cents === 99900 + 49900, 'purchase value wrong');
    expect(d.by_location.length === 3, 'rooms wrong');
    expect(Array.isArray(d.timeline), 'timeline missing');
  });

  await check('Calendar feed is subscribable', async () => {
    const r = await call('GET', '/api/calendar.ics');
    expect(r.headers.get('content-type').startsWith('text/calendar'), 'wrong content type');
    expect(r.data.includes('BEGIN:VCALENDAR') && r.data.includes('Front-load Washer: Direct drive motor ends'), 'event missing');
  });

  await check('CSV export contains every item and warranty', async () => {
    const r = await call('GET', '/api/export.csv');
    const lines = r.data.trim().split('\r\n');
    expect(lines.length === 1 + 2 + 1 + 1, `expected 5 lines, got ${lines.length}`);
  });

  await check('Duplicating an item copies its warranties', async () => {
    const r = await call('POST', `/api/items/${itemId}/duplicate`);
    expect(r.status === 201 && r.data.coverages.length === 2 && r.data.serial_number === '', 'duplicate wrong');
    expect((await call('DELETE', `/api/items/${r.data.id}`)).status === 204, 'cleanup failed');
  });

  await check('Webhook reminders are delivered once', async () => {
    const status = (await call('GET', '/api/reminders')).data;
    expect(status.configured === true && status.format === 'json', 'reminders not configured from env');
    const first = await call('POST', '/api/reminders/run');
    expect(first.status === 200 && first.data.sent > 0, `run failed: ${JSON.stringify(first.data)}`);
    expect(hookMessages.some((m) => m.includes('Robot Vacuum')), 'webhook did not receive the digest');
    const second = await call('POST', '/api/reminders/run');
    expect(second.data.sent === 0, 'reminders were repeated');
  });

  await check('Data survives a server restart', async () => {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
    const again = spawn(process.execPath, ['server/index.js'], { cwd: root, env: serverEnv, stdio: 'ignore' });
    globalThis.restarted = again;
    await waitUp();
    const d = (await call('GET', '/api/dashboard')).data;
    expect(d.counts.total === 3, 'items lost after restart');
    expect((await fetch(base + docUrl)).status === 200, 'document lost after restart');
  });

  await check('Deleting an item removes everything attached', async () => {
    expect((await call('DELETE', `/api/items/${itemId}`)).status === 204, 'delete failed');
    expect((await call('GET', `/api/items/${itemId}`)).status === 404, 'item still exists');
    expect((await fetch(base + docUrl)).status === 404, 'document still served');
  });

  await check('Security: unknown Host headers are refused (DNS rebinding)', async () => {
    const code = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/dashboard', headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(code === 421, `expected 421, got ${code}`);
  });

  await check('Security: traversal, cross-origin writes and oversize bodies are refused', async () => {
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status === 404, 'traversal not blocked');
    expect((await call('POST', '/api/items', { name: 'x' }, { origin: 'https://evil.example' })).status === 403, 'cross-origin not blocked');
    expect((await call('POST', '/api/items', `{"name":"${'x'.repeat(1_100_000)}"}`, { 'content-type': 'application/json' })).status === 413, 'oversize json accepted');
  });
} finally {
  server.kill('SIGTERM');
  globalThis.restarted?.kill('SIGTERM');
  hook.close();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} acceptance checks passed\n`);
process.exit(failed ? 1 : 0);
