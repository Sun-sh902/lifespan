// Pure domain logic: dates, coverage status, depreciation.
// Everything here is deterministic given a "today" string (YYYY-MM-DD).

export const EXPIRING_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toUtc(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / DAY_MS);
}

export function addDays(iso, days) {
  return new Date(toUtc(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/**
 * State of a single coverage on a given day.
 * upcoming: has not started yet
 * active:   running, more than EXPIRING_WINDOW_DAYS left
 * expiring: running, EXPIRING_WINDOW_DAYS or fewer left
 * expired:  ended before today
 */
export function coverageState(coverage, today) {
  if (coverage.starts_on && daysBetween(today, coverage.starts_on) > 0) return 'upcoming';
  const left = daysBetween(today, coverage.expires_on);
  if (left < 0) return 'expired';
  if (left <= EXPIRING_WINDOW_DAYS) return 'expiring';
  return 'active';
}

/**
 * Item status, derived from all its coverages.
 * covered  : at least one coverage is active or upcoming
 * expiring : nothing comfortably active, but something ends within the window
 * expired  : every coverage has ended
 * none     : no coverage recorded
 */
export function itemStatus(coverages, today) {
  if (!coverages || coverages.length === 0) return 'none';
  const states = coverages.map((c) => coverageState(c, today));
  if (states.some((s) => s === 'active' || s === 'upcoming')) return 'covered';
  if (states.includes('expiring')) return 'expiring';
  return 'expired';
}

/** The coverage that matters most right now: the next one to end that has not ended yet. */
export function nextExpiry(coverages, today) {
  const live = coverages
    .filter((c) => daysBetween(today, c.expires_on) >= 0)
    .sort((a, b) => a.expires_on.localeCompare(b.expires_on));
  return live[0] ?? null;
}

export function writeOffDate(purchaseDate, lifeMonths) {
  if (!purchaseDate || !lifeMonths) return null;
  return addMonths(purchaseDate, lifeMonths);
}

/** Straight-line depreciation to zero over lifeMonths. Returns integer cents. */
export function bookValueCents(priceCents, purchaseDate, lifeMonths, today) {
  if (priceCents == null) return null;
  if (!purchaseDate || !lifeMonths) return priceCents;
  const end = writeOffDate(purchaseDate, lifeMonths);
  const total = daysBetween(purchaseDate, end);
  const elapsed = Math.min(Math.max(daysBetween(purchaseDate, today), 0), total);
  if (total <= 0) return 0;
  return Math.round(priceCents * (1 - elapsed / total));
}
