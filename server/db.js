import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL DEFAULT '',
  brand           TEXT    NOT NULL DEFAULT '',
  model           TEXT    NOT NULL DEFAULT '',
  serial_number   TEXT    NOT NULL DEFAULT '',
  location        TEXT    NOT NULL DEFAULT '',
  retailer        TEXT    NOT NULL DEFAULT '',
  purchase_date   TEXT,
  price_cents     INTEGER,
  life_months     INTEGER,
  notes           TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS coverages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  provider    TEXT    NOT NULL DEFAULT '',
  starts_on   TEXT,
  expires_on  TEXT    NOT NULL,
  notes       TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL DEFAULT 'other',
  filename     TEXT    NOT NULL,
  mime         TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_key  TEXT    NOT NULL UNIQUE,
  uploaded_at  TEXT    NOT NULL
);

-- One row per coverage end date already announced through the webhook.
-- Keyed on expires_on so editing the date re-arms the reminder.
CREATE TABLE IF NOT EXISTS reminders_sent (
  coverage_id INTEGER NOT NULL REFERENCES coverages(id) ON DELETE CASCADE,
  expires_on  TEXT    NOT NULL,
  sent_at     TEXT    NOT NULL,
  PRIMARY KEY (coverage_id, expires_on)
);

CREATE INDEX IF NOT EXISTS idx_coverages_item   ON coverages(item_id);
CREATE INDEX IF NOT EXISTS idx_coverages_expiry ON coverages(expires_on);
CREATE INDEX IF NOT EXISTS idx_documents_item   ON documents(item_id);
`;

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
