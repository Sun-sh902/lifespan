// Loads the sample household into a running Lifespan server (default http://127.0.0.1:4747).
const base = process.env.LIFESPAN_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4747}`;

const res = await fetch(`${base}/api/demo`, { method: 'POST' });
const body = await res.json();
if (!res.ok) {
  console.error(`Seed skipped: ${body.error?.message ?? res.statusText}`);
  process.exit(res.status === 409 ? 0 : 1);
}
console.log(`Seeded ${body.items_created} items into ${base}`);
