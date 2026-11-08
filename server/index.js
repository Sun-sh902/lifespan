import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { resolveFormat } from './reminders.js';

const env = process.env;
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = resolve(env.LIFESPAN_DATA_DIR ?? resolve(root, 'data'));
const port = Number(env.PORT ?? 4747);
const host = env.HOST ?? '127.0.0.1';

function fail(message) {
  console.error(`Configuration error: ${message}`);
  process.exit(1);
}

// Host names the server answers to. Loopback binds default to loopback names;
// binding to the network accepts any name unless a list is given.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
let allowedHosts;
if (env.LIFESPAN_ALLOWED_HOSTS) {
  const list = env.LIFESPAN_ALLOWED_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  allowedHosts = list.includes('*') ? '*' : [...new Set([...list, 'localhost', '127.0.0.1', '[::1]'])];
} else {
  allowedHosts = LOOPBACK.has(host) ? ['localhost', '127.0.0.1', '[::1]'] : '*';
}

let webhook = null;
if (env.LIFESPAN_WEBHOOK_URL) {
  try {
    webhook = { url: env.LIFESPAN_WEBHOOK_URL, format: resolveFormat(env.LIFESPAN_WEBHOOK_URL, env.LIFESPAN_WEBHOOK_FORMAT ?? 'auto') };
  } catch (err) { fail(err.message); }
}
const remindDays = Number(env.LIFESPAN_REMIND_DAYS ?? 14);
if (!Number.isInteger(remindDays) || remindDays < 0 || remindDays > 365) fail('LIFESPAN_REMIND_DAYS must be a whole number from 0 to 365.');
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('PORT must be a valid port number.');

const server = createApp({
  dbPath: resolve(dataDir, 'lifespan.db'),
  uploadDir: resolve(dataDir, 'uploads'),
  allowedHosts,
  webhook,
  remindDays,
  schedule: true,
});

server.listen(port, host, () => {
  console.log(`Lifespan is running at http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${port}`);
  console.log(`Data directory: ${dataDir}`);
  console.log(webhook ? `Reminders: ${webhook.format} webhook, ${remindDays} days ahead, checked hourly` : 'Reminders: off (set LIFESPAN_WEBHOOK_URL to enable)');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
}
