import { isIsoDate, daysBetween } from './domain.js';

export class HttpError extends Error {
  constructor(status, code, message, fields, rows) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.rows = rows;
  }
}

export const DOCUMENT_KINDS = ['receipt', 'warranty', 'manual', 'photo', 'invoice', 'other'];

const text = (max) => ({ type: 'text', max });

const ITEM_FIELDS = {
  name: { ...text(120), required: true },
  category: text(60),
  brand: text(80),
  model: text(80),
  serial_number: text(120),
  location: text(80),
  retailer: text(80),
  notes: text(4000),
  purchase_date: { type: 'date' },
  price_cents: { type: 'int', min: 0, max: 1_000_000_000_00 },
  life_months: { type: 'int', min: 1, max: 1200 },
};

const COVERAGE_FIELDS = {
  label: { ...text(100), required: true },
  provider: text(100),
  notes: text(2000),
  starts_on: { type: 'date' },
  expires_on: { type: 'date', required: true },
};

function check(rules, body, { partial }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body', 'Request body must be a JSON object.');
  }
  const out = {};
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!(key in rules)) fields[key] = 'Unknown field.';
  }
  for (const [key, rule] of Object.entries(rules)) {
    const present = Object.prototype.hasOwnProperty.call(body, key);
    if (!present) {
      if (rule.required && !partial) fields[key] = 'This field is required.';
      continue;
    }
    let value = body[key];
    if (rule.type === 'text') {
      if (value === null) value = '';
      if (typeof value !== 'string') { fields[key] = 'Must be text.'; continue; }
      value = value.trim();
      if (rule.required && value === '') { fields[key] = 'This field is required.'; continue; }
      if (value.length > rule.max) { fields[key] = `Must be ${rule.max} characters or fewer.`; continue; }
    } else if (rule.type === 'date') {
      if (value === '' || value === null) {
        if (rule.required) { fields[key] = 'This field is required.'; continue; }
        value = null;
      } else if (!isIsoDate(value)) { fields[key] = 'Must be a date in YYYY-MM-DD format.'; continue; }
    } else if (rule.type === 'int') {
      if (value === '' || value === null) value = null;
      else if (!Number.isInteger(value)) { fields[key] = 'Must be a whole number.'; continue; }
      else if (value < rule.min || value > rule.max) { fields[key] = `Must be between ${rule.min} and ${rule.max}.`; continue; }
    }
    out[key] = value;
  }
  if (Object.keys(fields).length) {
    throw new HttpError(422, 'validation_failed', 'Some fields need attention.', fields);
  }
  return out;
}

export function validateItem(body, opts = { partial: false }) {
  return check(ITEM_FIELDS, body, opts);
}

export function validateCoverage(body, opts = { partial: false }, existing = null) {
  const out = check(COVERAGE_FIELDS, body, opts);
  const starts = 'starts_on' in out ? out.starts_on : existing?.starts_on;
  const expires = 'expires_on' in out ? out.expires_on : existing?.expires_on;
  if (starts && expires && daysBetween(starts, expires) < 0) {
    throw new HttpError(422, 'validation_failed', 'Some fields need attention.', {
      expires_on: 'Must be on or after the start date.',
    });
  }
  return out;
}

export function parseId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found', 'Resource not found.');
  return n;
}
