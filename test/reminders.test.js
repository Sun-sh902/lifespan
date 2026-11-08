import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { buildRequest, digestText, resolveFormat } from '../server/reminders.js';

describe('webhook formats', () => {
  test('auto-detects common services', () => {
    assert.equal(resolveFormat('https://discord.com/api/webhooks/1/abc'), 'discord');
    assert.equal(resolveFormat('https://hooks.slack.com/services/T/B/X'), 'slack');
    assert.equal(resolveFormat('https://ntfy.sh/my-topic'), 'text');
    assert.equal(resolveFormat('https://ntfy.example.org/home'), 'text');
    assert.equal(resolveFormat('https://example.org/hook'), 'json');
    assert.equal(resolveFormat('https://example.org/hook', 'text'), 'text');
    assert.throws(() => resolveFormat('not a url'), /valid URL/);
    assert.throws(() => resolveFormat('https://x.org', 'xml'), /must be one of/);
  });

  test('builds a readable digest per format', () => {
    const events = [{ item_name: 'TV', label: 'Extension', provider: 'Costco', date: '2026-06-20', days_left: 5 }];
    assert.match(digestText(events), /^Lifespan: 1 warranty ends soon\n- TV: Extension \(Costco\) ends Jun 20, 2026, in 5 days$/);
    assert.equal(JSON.parse(buildRequest('discord', events).body).content, digestText(events));
    assert.equal(JSON.parse(buildRequest('slack', events).body).text, digestText(events));
    assert.equal(buildRequest('text', events).body, digestText(events));
    assert.deepEqual(JSON.parse(buildRequest('json', events).body).events, events);
  });
});

describe('reminder delivery', () => {
  const TODAY = new Date(2026, 5, 15, 12);
  let hook; let received; let hookStatus = 200;
  let app; let base; let dir;

  before(async () => {
    received = [];
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push({ type: req.headers['content-type'], body }); res.writeHead(hookStatus); res.end(); });
    });
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    dir = mkdtempSync(join(tmpdir(), 'lifespan-remind-'));
    app = createApp({
      dbPath: join(dir, 'db.sqlite'), uploadDir: join(dir, 'u'), clock: () => TODAY, remindDays: 14,
      webhook: { url: `http://127.0.0.1:${hook.address().port}/hook`, format: 'json' },
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.address().port}`;
  });

  after(async () => {
    await new Promise((r) => app.close(r));
    await new Promise((r) => hook.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('sends due coverages once, re-arms when the date changes', async () => {
    await post('/api/items', {
      name: 'Television',
      coverages: [
        { label: 'Due soon', expires_on: '2026-06-20' },
        { label: 'Far away', expires_on: '2027-06-20' },
        { label: 'Already ended', expires_on: '2026-06-01' },
      ],
    });
    const status = await (await fetch(`${base}/api/reminders`)).json();
    assert.equal(status.configured, true);
    assert.deepEqual(status.pending.map((p) => p.label), ['Due soon']);

    const first = await (await fetch(`${base}/api/reminders/run`, { method: 'POST' })).json();
    assert.deepEqual(first, { sent: 1, configured: true });
    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0].body);
    assert.equal(payload.events[0].item_name, 'Television');
    assert.match(payload.text, /Due soon/);

    const second = await (await fetch(`${base}/api/reminders/run`, { method: 'POST' })).json();
    assert.equal(second.sent, 0, 'must not repeat a reminder');
    assert.equal(received.length, 1);

    const covId = status.pending[0].coverage_id;
    await fetch(`${base}/api/coverages/${covId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expires_on: '2026-06-25' }) });
    const third = await (await fetch(`${base}/api/reminders/run`, { method: 'POST' })).json();
    assert.equal(third.sent, 1, 'a new end date re-arms the reminder');
  });

  test('a failing webhook reports 502 and keeps the reminder pending', async () => {
    await post('/api/items', { name: 'Fridge', coverages: [{ label: 'Compressor', expires_on: '2026-06-18' }] });
    hookStatus = 500;
    const res = await fetch(`${base}/api/reminders/run`, { method: 'POST' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'webhook_failed');
    hookStatus = 200;
    const status = await (await fetch(`${base}/api/reminders`)).json();
    assert.ok(status.pending.some((p) => p.label === 'Compressor'), 'still pending after failure');
    const ok = await (await fetch(`${base}/api/reminders/run`, { method: 'POST' })).json();
    assert.equal(ok.sent, 1);
  });

  test('test message endpoint', async () => {
    const before = received.length;
    const res = await fetch(`${base}/api/reminders/test`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(received.length, before + 1);
    assert.equal(JSON.parse(received.at(-1).body).test, true);
  });
});

describe('reminders when not configured', () => {
  test('status says off and run/test refuse with 409', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifespan-noremind-'));
    const app = createApp({ dbPath: join(dir, 'db.sqlite'), uploadDir: join(dir, 'u') });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const status = await (await fetch(`${base}/api/reminders`)).json();
      assert.equal(status.configured, false);
      assert.equal((await fetch(`${base}/api/reminders/run`, { method: 'POST' })).status, 409);
      assert.equal((await fetch(`${base}/api/reminders/test`, { method: 'POST' })).status, 409);
      assert.deepEqual(await app.runReminders(), { sent: 0, configured: false });
    } finally {
      await new Promise((r) => app.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
