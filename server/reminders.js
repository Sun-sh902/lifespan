// Webhook reminders: one digest per run for coverages ending soon.
// Works with Discord, Slack, ntfy and any endpoint that accepts JSON.

const FORMATS = ['auto', 'json', 'text', 'discord', 'slack'];

export function resolveFormat(url, format = 'auto') {
  if (!FORMATS.includes(format)) throw new Error(`LIFESPAN_WEBHOOK_FORMAT must be one of: ${FORMATS.join(', ')}`);
  if (format !== 'auto') return format;
  let host = '';
  try { host = new URL(url).hostname; } catch { throw new Error('LIFESPAN_WEBHOOK_URL is not a valid URL.'); }
  if (host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com') return 'discord';
  if (host === 'hooks.slack.com') return 'slack';
  if (host === 'ntfy.sh' || host.startsWith('ntfy.')) return 'text';
  return 'json';
}

const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);

export function digestText(events, { test = false } = {}) {
  if (test) return 'Lifespan test message: reminders are set up correctly.';
  const head = events.length === 1 ? 'Lifespan: 1 warranty ends soon' : `Lifespan: ${events.length} warranties end soon`;
  const lines = events.map((e) => `- ${e.item_name}: ${e.label}${e.provider ? ` (${e.provider})` : ''} ends ${fmt(e.date)}, ${when(e.days_left)}`);
  return [head, ...lines].join('\n');
}

export function buildRequest(format, events, opts = {}) {
  const text = digestText(events, opts);
  switch (format) {
    case 'discord': return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 2000) }) };
    case 'slack': return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) };
    case 'text': return { headers: { 'content-type': 'text/plain; charset=utf-8', title: 'Lifespan', tags: 'calendar' }, body: text };
    default: return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, events, test: Boolean(opts.test) }) };
  }
}

export async function sendWebhook({ url, format }, events, opts = {}) {
  const { headers, body } = buildRequest(format, events, opts);
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer().catch(() => {});
  if (!res.ok) throw new Error(`Webhook responded with HTTP ${res.status}.`);
  return res.status;
}
