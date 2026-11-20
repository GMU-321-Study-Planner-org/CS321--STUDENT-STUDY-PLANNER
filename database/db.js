// database/db.js
// SQLite setup for the study planner. Keeps the existing tables and adds what
// Canvas sync needs, using PRAGMA user_version so existing planner.db files
// upgrade in place instead of having to be deleted.
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(process.env.PLANNER_DB ?? path.join(here, '..', 'planner.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Version 0: the tables the project already has.
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

// Each entry upgrades the database by one version. Append new ones; never edit old ones.
const migrations = [
  // v1: Canvas sync bookkeeping.
  `
  -- When this row was last seen in the Canvas feed. Rows Canvas no longer
  -- lists (deleted or unpublished assignments) are pruned after a sync.
  ALTER TABLE assignments ADD COLUMN synced_at TEXT;
  CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due_at);

  -- Canvas feeds also contain things that are not assignments: class meetings,
  -- office hours, exam sessions. They belong on the calendar, not in the to-do queue.
  CREATE TABLE IF NOT EXISTS calendar_events (
    id        INTEGER PRIMARY KEY,
    uid       TEXT NOT NULL UNIQUE,   -- Canvas UID (plus the occurrence time for recurring events)
    course_id INTEGER REFERENCES courses(id),
    title     TEXT NOT NULL,
    starts_at TEXT NOT NULL,          -- ISO 8601, UTC
    ends_at   TEXT NOT NULL,
    all_day   INTEGER NOT NULL DEFAULT 0,
    location  TEXT,
    url       TEXT,
    synced_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(starts_at);

  -- One row per sync attempt, so the UI can show "last synced" and the last error.
  CREATE TABLE IF NOT EXISTS sync_runs (
    id          INTEGER PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
    assignments INTEGER,
    events      INTEGER,
    removed     INTEGER,
    error       TEXT
  );

  `,

  // v2: User accounts and login sessions.
  `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id)
      ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON user_sessions(user_id);

  
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry
    ON user_sessions(expires_at);
  `,

  // v3: Separate planner data for each student.
  `
  CREATE TABLE user_courses (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    code TEXT NOT NULL,
    name TEXT,
    priority INTEGER NOT NULL DEFAULT 3
      CHECK (priority BETWEEN 1 AND 5),
    UNIQUE(user_id, code)
  );

  CREATE TABLE user_assignments (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    uid TEXT,
    course_id INTEGER NOT NULL REFERENCES user_courses(id),
    title TEXT NOT NULL,
    due_at TEXT NOT NULL,
    url TEXT,
    notes TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    synced_at TEXT,
    UNIQUE(user_id, uid)
  );

  CREATE INDEX idx_user_assignments_due
    ON user_assignments(user_id, due_at);

  CREATE TABLE user_study_sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    course_id INTEGER NOT NULL REFERENCES user_courses(id),
    starts_at TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    topic TEXT
  );

  CREATE TABLE user_calendar_events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    uid TEXT NOT NULL,
    course_id INTEGER REFERENCES user_courses(id),
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    url TEXT,
    synced_at TEXT NOT NULL,
    UNIQUE(user_id, uid)
  );

  CREATE INDEX idx_user_calendar_events_start
    ON user_calendar_events(user_id, starts_at);

  CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY(user_id, key)
  );

  CREATE TABLE user_sync_runs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'ok', 'error')),
    assignments INTEGER,
    events INTEGER,
    removed INTEGER,
    error TEXT
  );

  CREATE INDEX idx_user_sync_runs
    ON user_sync_runs(user_id, id);
  `,
];



const current = db.pragma('user_version', { simple: true });
db.transaction(() => {
  for (let v = current; v < migrations.length; v++) {
    db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  }
})();

export default db;
