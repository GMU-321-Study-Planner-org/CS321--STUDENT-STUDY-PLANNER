import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { syncFeed } from './canvas.js';
import { rankAssignments } from './priority.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(here, '..', 'public')));

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

function courseIdFor(code) {
  const c = String(code ?? '').trim();
  if (!c) throw new Error('Choose a course.');
  db.prepare('INSERT INTO courses (code) VALUES (?) ON CONFLICT(code) DO NOTHING').run(c);
  return db.prepare('SELECT id FROM courses WHERE code = ?').get(c).id;
}

const validDate = (s) => typeof s === 'string' && s.trim() !== '' && Number.isFinite(Date.parse(s));
const validId = (raw) => /^[1-9]\d*$/.test(String(raw));

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
    linked: Boolean(getSetting('feed_url')), // the feed URL itself is a secret, so it never goes to the browser
    lastSync: getSetting('last_sync'),
  });
});

app.post('/api/calendar/link', route(async (req, res) => {
  const url = String(req.body.url ?? '').trim().replace(/^webcal:/i, 'https:');
  if (new URL(url).protocol !== 'https:') throw new Error('Use the https link from Canvas.');
  const imported = await syncFeed(url);
  setSetting('feed_url', url);
  setSetting('last_sync', new Date().toISOString());
  res.json({ imported });
}));

app.post('/api/calendar/sync', route(async (req, res) => {
  const url = getSetting('feed_url');
  if (!url) throw new Error('Link your Canvas calendar first.');
  const imported = await syncFeed(url);
  setSetting('last_sync', new Date().toISOString());
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

// Manual assignments can be edited without changing Canvas-managed events.
app.put('/api/assignments/:id', route((req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid assignment ID.' });
  const existing = db.prepare('SELECT id, source FROM assignments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Assignment not found.' });
  if (existing.source !== 'manual') return res.status(403).json({ error: 'Canvas assignments cannot be edited here.' });
  const { title, courseCode, dueAt } = req.body;
  if (!String(title ?? '').trim() || !validDate(dueAt)) throw new Error('Add a title and a due date.');
  const courseId = courseIdFor(courseCode);
  db.prepare('UPDATE assignments SET title = ?, course_id = ?, due_at = ? WHERE id = ?')
    .run(title.trim(), courseId, new Date(dueAt).toISOString(), req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/assignments/:id', route((req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid assignment ID.' });
  const existing = db.prepare('SELECT id, source FROM assignments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Assignment not found.' });
  if (existing.source !== 'manual') return res.status(403).json({ error: 'Canvas assignments cannot be deleted here.' });
  db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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
app.listen(port, () => console.log(`Plan of Study running at http://localhost:${port}`));
