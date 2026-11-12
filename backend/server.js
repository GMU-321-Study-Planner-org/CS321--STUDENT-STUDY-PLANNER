import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../database/db.js';
import { syncFeed, getEventsBetween, getLastSync } from './canvas.js';
import { demoFeed } from './demo-feed.js';
import { rankAssignments } from './priority.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(here, '..', 'frontend')));

// Demo mode: serves a fake Canvas feed with dates around today, so the app can be
// shown without a real Canvas account. Link http://localhost:3000/demo/canvas.ics
const DEMO = process.env.DEMO === '1';
if (DEMO) {
  app.get('/demo/canvas.ics', (req, res) => res.type('text/calendar').send(demoFeed()));
}

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

function courseIdFor(code) {
  const c = String(code ?? '').trim();
  if (!c) throw new Error('Choose a course.');
  db.prepare('INSERT INTO courses (code) VALUES (?) ON CONFLICT(code) DO NOTHING').run(c);
  return db.prepare('SELECT id FROM courses WHERE code = ?').get(c).id;
}

const validDate = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

// Wraps handlers so thrown errors become JSON the UI can show.
const route = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message });
  });

// One call returns everything the dashboard needs.
app.get('/api/state', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, c.code AS course_code, c.priority AS course_priority
    FROM assignments a JOIN courses c ON c.id = a.course_id
  `).all();

  res.json({
    courses: db.prepare('SELECT * FROM courses ORDER BY priority DESC, code').all(),
    queue: rankAssignments(rows),
    done: rows.filter((r) => r.completed),
    sessions: db.prepare(`
      SELECT s.*, c.code AS course_code FROM study_sessions s
      JOIN courses c ON c.id = s.course_id ORDER BY s.starts_at
    `).all(),
    events: getEventsBetween('0000', '9999'), // the whole synced window; the week view pages on the client
    linked: Boolean(getSetting('feed_url')), // the feed URL itself is a secret, so it never goes to the browser
    lastSync: getLastSync(),
  });
});

app.post('/api/calendar/link', route(async (req, res) => {
  const url = String(req.body.url ?? '').trim().replace(/^webcal:/i, 'https:');
  const u = new URL(url);
  const demoLink = DEMO && u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !demoLink) throw new Error('Use the https link from Canvas.');
  const { imported } = await syncFeed(url);
  setSetting('feed_url', url);
  res.json({ imported });
}));

app.post('/api/calendar/sync', route(async (req, res) => {
  const url = getSetting('feed_url');
  if (!url) throw new Error('Link your Canvas calendar first.');
  const { imported } = await syncFeed(url);
  res.json({ imported });
}));

app.post('/api/assignments', route((req, res) => {
  const { title, courseCode, dueAt } = req.body;
  if (!String(title ?? '').trim() || !validDate(dueAt)) throw new Error('Add a title and a due date.');
  const info = db.prepare(
    "INSERT INTO assignments (course_id, title, due_at, source) VALUES (?, ?, ?, 'manual')"
  ).run(courseIdFor(courseCode), title.trim(), new Date(dueAt).toISOString());
  res.status(201).json({ id: info.lastInsertRowid });
}));

app.patch('/api/assignments/:id', route((req, res) => {
  db.prepare('UPDATE assignments SET completed = ? WHERE id = ?').run(req.body.completed ? 1 : 0, req.params.id);
  res.json({ ok: true });
}));

app.patch('/api/courses/:id', route((req, res) => {
  const p = Number(req.body.priority);
  if (!Number.isInteger(p) || p < 1 || p > 5) throw new Error('Priority is a whole number from 1 to 5.');
  db.prepare('UPDATE courses SET priority = ? WHERE id = ?').run(p, req.params.id);
  res.json({ ok: true });
}));

app.post('/api/sessions', route((req, res) => {
  const { courseCode, startsAt, minutes, topic } = req.body;
  const mins = Number(minutes);
  if (!validDate(startsAt) || !Number.isInteger(mins) || mins < 5 || mins > 600) {
    throw new Error('Pick a start time and a length between 5 and 600 minutes.');
  }
  const info = db.prepare(
    'INSERT INTO study_sessions (course_id, starts_at, minutes, topic) VALUES (?, ?, ?, ?)'
  ).run(courseIdFor(courseCode), new Date(startsAt).toISOString(), mins, String(topic ?? '').trim() || null);
  res.status(201).json({ id: info.lastInsertRowid });
}));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Plan of Study running at http://localhost:${port}`);
  if (DEMO) console.log(`Demo feed: http://localhost:${port}/demo/canvas.ics`);
});
