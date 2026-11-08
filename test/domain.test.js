import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, bookValueCents, coverageState, daysBetween, isIsoDate, itemStatus, nextExpiry, writeOffDate,
} from '../server/domain.js';
import { parseCsv, toCsv } from '../server/csv.js';
import { buildCalendar } from '../server/ics.js';

const T = '2026-06-15';

test('isIsoDate accepts real dates and rejects impossible ones', () => {
  assert.equal(isIsoDate('2024-02-29'), true);
  assert.equal(isIsoDate('2025-02-29'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('15/06/2026'), false);
  assert.equal(isIsoDate(20260615), false);
});

test('date arithmetic handles month ends and leap years', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2025-11-30', 3), '2026-02-28');
  assert.equal(addMonths('2026-06-15', 120), '2036-06-15');
});

test('coverageState covers every phase', () => {
  assert.equal(coverageState({ starts_on: '2026-07-01', expires_on: '2027-07-01' }, T), 'upcoming');
  assert.equal(coverageState({ starts_on: null, expires_on: '2026-12-01' }, T), 'active');
  assert.equal(coverageState({ starts_on: null, expires_on: '2026-07-15' }, T), 'expiring');
  assert.equal(coverageState({ starts_on: null, expires_on: T }, T), 'expiring');
  assert.equal(coverageState({ starts_on: null, expires_on: '2026-06-14' }, T), 'expired');
});

test('itemStatus prefers the best live coverage', () => {
  assert.equal(itemStatus([], T), 'none');
  assert.equal(itemStatus([{ expires_on: '2026-06-01' }, { expires_on: '2030-01-01' }], T), 'covered');
  assert.equal(itemStatus([{ expires_on: '2026-06-01' }, { expires_on: '2026-06-20' }], T), 'expiring');
  assert.equal(itemStatus([{ expires_on: '2026-06-01' }], T), 'expired');
  assert.equal(itemStatus([{ starts_on: '2026-08-01', expires_on: '2027-08-01' }], T), 'covered');
});

test('nextExpiry ignores ended coverages', () => {
  const covs = [{ id: 1, expires_on: '2026-01-01' }, { id: 2, expires_on: '2028-01-01' }, { id: 3, expires_on: '2027-01-01' }];
  assert.equal(nextExpiry(covs, T).id, 3);
  assert.equal(nextExpiry([{ id: 1, expires_on: '2020-01-01' }], T), null);
});

test('straight-line depreciation', () => {
  assert.equal(writeOffDate('2026-01-01', 12), '2027-01-01');
  assert.equal(writeOffDate(null, 12), null);
  assert.equal(bookValueCents(100000, '2026-06-15', 12, T), 100000);
  assert.equal(bookValueCents(100000, '2020-01-01', 12, T), 0);
  const half = bookValueCents(100000, '2025-06-15', 24, T);
  assert.ok(Math.abs(half - 50000) < 200, `expected about half, got ${half}`);
  assert.equal(bookValueCents(5000, null, 12, T), 5000);
  assert.equal(bookValueCents(null, '2025-01-01', 12, T), null);
});

test('csv round-trips quotes, commas, newlines and neutralizes formulas', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'Hello, "world"', b: 'line1\nline2' }, { a: '=SUM(A1)', b: '' }]);
  const { header, records } = parseCsv(csv);
  assert.deepEqual(header, ['a', 'b']);
  assert.equal(records[0].a, 'Hello, "world"');
  assert.equal(records[0].b, 'line1\nline2');
  assert.ok(csv.includes("'=SUM(A1)"));
  assert.equal(records[1].a, '=SUM(A1)');
  assert.throws(() => parseCsv('a\n"unterminated'), /Unterminated/);
});

test('ics output is valid and folded', () => {
  const ics = buildCalendar([{ uid: 'x1', date: '2026-12-31', summary: `A very long summary ${'x'.repeat(120)}`, description: 'a,b;c' }], { stamp: new Date('2026-06-15T00:00:00Z') });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261231/);
  assert.match(ics, /DTEND;VALUE=DATE:20270101/);
  assert.match(ics, /DESCRIPTION:a\\,b\\;c/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});
