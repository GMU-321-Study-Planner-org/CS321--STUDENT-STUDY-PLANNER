import express from 'express';
import path from 'node:path';
import { setupAuth, requireAuth, getCurrentUser } from './auth.js';
import { fileURLToPath } from 'node:url';
import db from '../database/db.js';
import { syncFeed, getEventsBetween, getLastSync, clearCanvasData } from './server/canvas.js';
import { demoFeed } from './demo-feed.js';
import { rankAssignments } from './server/priority.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

setupAuth(app, db);

// Require authentication for planner API requests.
app.use('/api', requireAuth(db));

const publicDir = path.join(here, 'public');

app.get('/', (req, res) => {
  if (!getCurrentUser(db, req)) {
    return res.redirect('/login.html');
  }

  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/index.html', (req, res) => {
  if (!getCurrentUser(db, req)) {
    return res.redirect('/login.html');
  }

  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(express.static(publicDir, {
  index: false
}));

// Demo mode: serves a fake Canvas feed with dates around today, so the app can be
// shown without a real Canvas account. Link http://localhost:3000/demo/canvas.ics
const DEMO = process.env.DEMO === '1';
if (DEMO) {
  app.get('/demo/canvas.ics', (req, res) => res.type('text/calendar').send(demoFeed()));
}

// Everything below runs behind requireAuth, so req.user is always set. Every query
// is scoped to req.user.id (user_* tables) so each student only ever sees their own data.
const getSetting = (userId, k) =>
  db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, k)?.value ?? null;
const setSetting = (userId, k, v) =>
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, k, v);

function courseIdFor(userId, code) {
  const c = String(code ?? '').trim();
  if (!c) throw new Error('Choose a course.');
  db.prepare('INSERT INTO user_courses (user_id, code) VALUES (?, ?) ON CONFLICT(user_id, code) DO NOTHING').run(userId, c);
  return db.prepare('SELECT id FROM user_courses WHERE user_id = ? AND code = ?').get(userId, c).id;
}

const validDate = (s) => typeof s === 'string' && s.trim() !== '' && Number.isFinite(Date.parse(s));
const validId = (raw) => /^[1-9]\d*$/.test(String(raw));

// Wraps handlers so thrown errors become JSON the UI can show.
const route = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message });
  });

// One call returns everything the dashboard needs, for the signed-in user only.
app.get('/api/state', (req, res) => {
  const userId = req.user.id;
  const rows = db.prepare(`
    SELECT a.*, c.code AS course_code, c.priority AS course_priority
    FROM user_assignments a JOIN user_courses c ON c.id = a.course_id
    WHERE a.user_id = ?
  `).all(userId);

  res.json({
    courses: db.prepare('SELECT * FROM user_courses WHERE user_id = ? ORDER BY priority DESC, code').all(userId),
    queue: rankAssignments(rows),
    done: rows.filter((r) => r.completed),
    sessions: db.prepare(`
      SELECT s.*, c.code AS course_code FROM user_study_sessions s
      JOIN user_courses c ON c.id = s.course_id
      WHERE s.user_id = ? ORDER BY s.starts_at
    `).all(userId),
    focusLogs: db.prepare(`
      SELECT f.id, f.topic, f.minutes, f.finished_at, c.code AS course_code
      FROM user_focus_logs f LEFT JOIN user_courses c ON c.id = f.course_id
      WHERE f.user_id = ? ORDER BY f.finished_at DESC LIMIT 200
    `).all(userId),
    events: getEventsBetween(userId, '0000', '9999'), // the whole synced window; the week view pages on the client
    linked: Boolean(getSetting(userId, 'feed_url')), // the feed URL itself is a secret, so it never goes to the browser
    lastSync: getLastSync(userId),
  });
});

app.post('/api/calendar/link', route(async (req, res) => {
  const url = String(req.body.url ?? '').trim().replace(/^webcal:/i, 'https:');
  const u = new URL(url);
  const demoLink = DEMO && u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !demoLink) throw new Error('Use the https link from Canvas.');
  const { imported } = await syncFeed(req.user.id, url);
  setSetting(req.user.id, 'feed_url', url);
  res.json({ imported });
}));

app.post('/api/calendar/sync', route(async (req, res) => {
  const url = getSetting(req.user.id, 'feed_url');
  if (!url) throw new Error('Link your Canvas calendar first.');
  const { imported } = await syncFeed(req.user.id, url);
  res.json({ imported });
}));

// Clear this user's imported Canvas data while keeping their manually added tasks.
app.delete('/api/calendar', route((req, res) => {
  res.json({ ok: true, ...clearCanvasData(req.user.id) });
}));

app.post('/api/assignments', route((req, res) => {
  const { title, courseCode, dueAt } = req.body;
  if (!String(title ?? '').trim() || !validDate(dueAt)) throw new Error('Add a title and a due date.');
  const info = db.prepare(
    "INSERT INTO user_assignments (user_id, course_id, title, due_at, source) VALUES (?, ?, ?, ?, 'manual')"
  ).run(req.user.id, courseIdFor(req.user.id, courseCode), title.trim(), new Date(dueAt).toISOString());
  res.status(201).json({ id: info.lastInsertRowid });
}));

// Looks up an assignment by id for this user only. Another user's id looks exactly like a missing one (404).
const ownAssignment = (req) =>
  db.prepare('SELECT id, source FROM user_assignments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

// Manual assignments can be edited without changing Canvas-managed events.
app.put('/api/assignments/:id', route((req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid assignment ID.' });
  const existing = ownAssignment(req);
  if (!existing) return res.status(404).json({ error: 'Assignment not found.' });
  if (existing.source !== 'manual') return res.status(403).json({ error: 'Canvas assignments cannot be edited here.' });
  const { title, courseCode, dueAt } = req.body;
  if (!String(title ?? '').trim() || !validDate(dueAt)) throw new Error('Add a title and a due date.');
  const courseId = courseIdFor(req.user.id, courseCode);
  db.prepare('UPDATE user_assignments SET title = ?, course_id = ?, due_at = ? WHERE id = ? AND user_id = ?')
    .run(title.trim(), courseId, new Date(dueAt).toISOString(), existing.id, req.user.id);
  res.json({ ok: true });
}));

app.delete('/api/assignments/:id', route((req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid assignment ID.' });
  const existing = ownAssignment(req);
  if (!existing) return res.status(404).json({ error: 'Assignment not found.' });
  if (existing.source !== 'manual') return res.status(403).json({ error: 'Canvas assignments cannot be deleted here.' });
  db.prepare('DELETE FROM user_assignments WHERE id = ? AND user_id = ?').run(existing.id, req.user.id);
  res.json({ ok: true });
}));

app.patch('/api/assignments/:id', route((req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid assignment ID.' });
  const { changes } = db.prepare('UPDATE user_assignments SET completed = ? WHERE id = ? AND user_id = ?')
    .run(req.body.completed ? 1 : 0, req.params.id, req.user.id);
  if (!changes) return res.status(404).json({ error: 'Assignment not found.' });
  res.json({ ok: true });
}));

app.patch('/api/courses/:id', route((req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid course ID.' });
  const p = Number(req.body.priority);
  if (!Number.isInteger(p) || p < 1 || p > 5) throw new Error('Priority is a whole number from 1 to 5.');
  const { changes } = db.prepare('UPDATE user_courses SET priority = ? WHERE id = ? AND user_id = ?')
    .run(p, req.params.id, req.user.id);
  if (!changes) return res.status(404).json({ error: 'Course not found.' });
  res.json({ ok: true });
}));

// goals-focus-v9: a saved focus block counts as actual, not scheduled, study time.
app.post('/api/focus-logs', route((req, res) => {
  const minutes = Number(req.body?.minutes);
  const topic = String(req.body?.topic ?? '').trim();
  const courseCode = String(req.body?.courseCode ?? '').trim();
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240 || topic.length > 120 || courseCode.length > 100) {
    return res.status(400).json({ error: 'Study time must be 1–240 whole minutes.' });
  }
  const courseId = courseCode ? courseIdFor(req.user.id, courseCode) : null;
  const result = db.prepare(`
    INSERT INTO user_focus_logs(user_id, course_id, topic, minutes, finished_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, courseId, topic || null, minutes, new Date().toISOString());
  res.status(201).json({ id: result.lastInsertRowid });
}));

app.post('/api/sessions', route((req, res) => {
  const { courseCode, startsAt, minutes, topic } = req.body;
  const mins = Number(minutes);
  if (!validDate(startsAt) || !Number.isInteger(mins) || mins < 5 || mins > 600) {
    throw new Error('Pick a start time and a length between 5 and 600 minutes.');
  }
  const info = db.prepare(
    'INSERT INTO user_study_sessions (user_id, course_id, starts_at, minutes, topic) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, courseIdFor(req.user.id, courseCode), new Date(startsAt).toISOString(), mins, String(topic ?? '').trim() || null);
  res.status(201).json({ id: info.lastInsertRowid });
}));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Plan of Study running at http://localhost:${port}`);
  if (DEMO) console.log(`Demo feed: http://localhost:${port}/demo/canvas.ics`);
});
