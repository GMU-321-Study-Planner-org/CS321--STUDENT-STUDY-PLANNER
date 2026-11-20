// Run with: npm test
// Starts the real server against an in-memory database and checks that two signed-in
// students can never see or change each other's planner data.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLANNER_DB = ':memory:';
process.env.PORT = '3917';
await import('../backend/server.js');
const base = 'http://localhost:3917';

// Minimal client that keeps its own session cookie, like a browser tab would.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}

const alice = client();
const bob = client();
const anon = client();
const due = '2030-01-15T12:00:00.000Z';
let aliceTask, aliceCourse;

before(async () => {
  assert.equal((await alice('/api/auth/register', { method: 'POST', body: { name: 'Alice A', email: 'alice@example.com', password: 'password-alice' } })).status, 201);
  assert.equal((await bob('/api/auth/register', { method: 'POST', body: { name: 'Bob B', email: 'bob@example.com', password: 'password-bob!' } })).status, 201);

  aliceTask = (await alice('/api/assignments', { method: 'POST', body: { title: 'Alice essay', courseCode: 'ENG 101', dueAt: due } })).data.id;
  await alice('/api/sessions', { method: 'POST', body: { courseCode: 'ENG 101', startsAt: due, minutes: 45, topic: 'outline' } });
  aliceCourse = (await alice('/api/state')).data.courses[0].id;
});

test('API requires sign-in', async () => {
  assert.equal((await anon('/api/state')).status, 401);
});

test('a new account starts empty and does not see another user\'s data', async () => {
  const mine = (await alice('/api/state')).data;
  assert.deepEqual(mine.queue.map((a) => a.title), ['Alice essay']);
  assert.equal(mine.sessions.length, 1);
  assert.equal(mine.courses.length, 1);

  const theirs = (await bob('/api/state')).data;
  assert.deepEqual([theirs.courses, theirs.queue, theirs.done, theirs.sessions, theirs.events], [[], [], [], [], []]);
  assert.equal(theirs.linked, false);
});

test('each user has their own copy of a course with the same code', async () => {
  await bob('/api/assignments', { method: 'POST', body: { title: 'Bob lab', courseCode: 'ENG 101', dueAt: due } });
  const a = (await alice('/api/state')).data;
  const b = (await bob('/api/state')).data;
  assert.notEqual(a.courses[0].id, b.courses[0].id);
  assert.deepEqual(b.queue.map((x) => x.title), ['Bob lab']);
  assert.deepEqual(a.queue.map((x) => x.title), ['Alice essay']);
});

test('course priority is per user', async () => {
  assert.equal((await bob(`/api/courses/${aliceCourse}`, { method: 'PATCH', body: { priority: 5 } })).status, 404);
  assert.equal((await alice(`/api/courses/${aliceCourse}`, { method: 'PATCH', body: { priority: 5 } })).status, 200);
  assert.equal((await bob('/api/state')).data.courses[0].priority, 3);
  assert.equal((await alice('/api/state')).data.courses[0].priority, 5);
});

test('users cannot complete, edit or delete each other\'s assignments', async () => {
  const body = { title: 'hacked', courseCode: 'ENG 101', dueAt: due };
  assert.equal((await bob(`/api/assignments/${aliceTask}`, { method: 'PATCH', body: { completed: true } })).status, 404);
  assert.equal((await bob(`/api/assignments/${aliceTask}`, { method: 'PUT', body })).status, 404);
  assert.equal((await bob(`/api/assignments/${aliceTask}`, { method: 'DELETE' })).status, 404);

  const a = (await alice('/api/state')).data;
  assert.deepEqual(a.queue.map((x) => [x.title, x.completed]), [['Alice essay', 0]]);
});

test('owners can still edit, complete, restore and delete their own tasks', async () => {
  const edit = await alice(`/api/assignments/${aliceTask}`, { method: 'PUT', body: { title: 'Alice essay v2', courseCode: 'ENG 101', dueAt: due } });
  assert.equal(edit.status, 200);
  await alice(`/api/assignments/${aliceTask}`, { method: 'PATCH', body: { completed: true } });
  assert.deepEqual((await alice('/api/state')).data.done.map((x) => x.title), ['Alice essay v2']);
  await alice(`/api/assignments/${aliceTask}`, { method: 'PATCH', body: { completed: false } });
  assert.equal((await alice(`/api/assignments/${aliceTask}`, { method: 'DELETE' })).status, 200);
  assert.equal((await alice('/api/state')).data.queue.length, 0);
});

test('invalid ids are rejected', async () => {
  assert.equal((await alice('/api/assignments/abc', { method: 'DELETE' })).status, 400);
  assert.equal((await alice('/api/assignments/0', { method: 'PATCH', body: { completed: true } })).status, 400);
});

test('clearing Canvas data only affects the signed-in user', async () => {
  const { default: db } = await import('../database/db.js');
  const [a, b] = ['alice@example.com', 'bob@example.com'].map((e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id);
  const ins = db.prepare("INSERT INTO user_courses (user_id, code) VALUES (?, 'CS 1')");
  const cid = (u) => (ins.run(u), db.prepare("SELECT id FROM user_courses WHERE user_id = ? AND code = 'CS 1'").get(u).id);
  for (const u of [a, b]) {
    db.prepare("INSERT INTO user_assignments (user_id, uid, course_id, title, due_at, source) VALUES (?, 'x1', ?, 'Canvas hw', ?, 'canvas')").run(u, cid(u), due);
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'feed_url', 'https://x.example/f.ics')").run(u);
  }
  assert.equal((await alice('/api/state')).data.linked, true);

  const r = await alice('/api/calendar', { method: 'DELETE' });
  assert.equal(r.data.assignments, 1);
  assert.equal((await alice('/api/state')).data.linked, false);

  const bobState = (await bob('/api/state')).data;
  assert.equal(bobState.linked, true);
  assert.ok(bobState.queue.some((x) => x.title === 'Canvas hw'));
});

test('after logout the old session no longer works', async () => {
  const carol = client();
  await carol('/api/auth/register', { method: 'POST', body: { name: 'Carol C', email: 'carol@example.com', password: 'password-carol' } });
  assert.equal((await carol('/api/state')).status, 200);
  await carol('/api/auth/logout', { method: 'POST' });
  // the browser drops the cleared cookie; the server must also have deleted the session row
  const { default: db } = await import('../database/db.js');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').get('carol@example.com').n, 0);
});

test.after(() => setTimeout(() => process.exit(0), 50));
