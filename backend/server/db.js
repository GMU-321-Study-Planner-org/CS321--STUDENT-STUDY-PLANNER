import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(here, '..', 'planner.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id       INTEGER PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT,
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS assignments (
  id        INTEGER PRIMARY KEY,
  uid       TEXT UNIQUE,              -- Canvas event UID; NULL for tasks added by hand
  course_id INTEGER NOT NULL REFERENCES courses(id),
  title     TEXT NOT NULL,
  due_at    TEXT NOT NULL,            -- ISO 8601, UTC
  url       TEXT,
  notes     TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  source    TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  starts_at TEXT NOT NULL,
  minutes   INTEGER NOT NULL,
  topic     TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

export default db;
