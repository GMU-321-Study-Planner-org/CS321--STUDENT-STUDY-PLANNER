// Run with: npm test
// Uses an in-memory database and the sample feed, so no Canvas account is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.PLANNER_DB = ':memory:';
const { default: db } = await import('../database/db.js');
const { parseFeed, saveFeed, getEventsBetween } = await import('../backend/canvas.js');

const ics = readFileSync(new URL('./sample-canvas.ics', import.meta.url), 'utf8');
const NOW = new Date('2026-11-09T12:00:00Z');

test('splits assignments from calendar events', () => {
  const { assignments, events } = parseFeed(ics, NOW);
  assert.deepEqual(assignments.map((a) => a.uid).sort(),
    ['event-assignment-1001', 'event-assignment-1002', 'event-assignment-1003']);
  assert.equal(events.length, 5); // 4 weekly lectures + 1 open house
});

test('parses titles, course codes and times', () => {
  const { assignments, events } = parseFeed(ics, NOW);
  const hw = assignments.find((a) => a.uid === 'event-assignment-1001');
  assert.equal(hw.title, 'Homework 4: Graphs');
  assert.equal(hw.courseCode, 'CS 321-001');
  assert.equal(hw.dueAt, '2026-11-13T04:59:00.000Z');

  const quiz = assignments.find((a) => a.uid === 'event-assignment-1002');
  assert.equal(quiz.dueAt, '2026-11-21T04:59:00.000Z', 'all-day item is due 11:59 pm Eastern');
  assert.equal(quiz.url, null, 'javascript: links are dropped');

  const first = events.find((e) => e.startsAt.startsWith('2026-11-10'));
  assert.equal(first.startsAt, '2026-11-10T15:30:00.000Z', '10:30 EST is 15:30 UTC');
  assert.equal(first.location, 'Innovation Hall 103');

  const moved = events.find((e) => e.title.startsWith('Lecture (moved'));
  assert.equal(moved.startsAt, '2026-11-24T18:00:00.000Z', 'RECURRENCE-ID override applied');
  assert.equal(moved.location, 'Exploratory Hall 1004');

  const openHouse = events.find((e) => e.title === 'Advising open house');
  assert.equal(openHouse.courseCode, null);
});

test('saves to the database and re-syncs without losing checkmarks', () => {
  const first = saveFeed(parseFeed(ics, NOW), '2026-11-09T12:00:00.000Z');
  assert.deepEqual(first, { assignments: 3, events: 5, removed: 0 });

  // Student finishes Lab 9.
  db.prepare("UPDATE assignments SET completed = 1 WHERE uid = 'event-assignment-1003'").run();

  // Next sync: instructor moved Homework 4, deleted Lab 9 and Quiz 7 from Canvas.
  const edited = ics
    .replace('DTSTART:20261113T045900Z\nDTEND:20261113T045900Z', 'DTSTART:20261114T045900Z\nDTEND:20261114T045900Z')
    .replace(/BEGIN:VEVENT\nUID:event-assignment-100[23][\s\S]*?END:VEVENT\n/g, '');
  const second = saveFeed(parseFeed(edited, NOW), '2026-11-10T12:00:00.000Z');
  assert.equal(second.removed, 1, 'only the unfinished, deleted quiz is pruned');

  const rows = db.prepare("SELECT uid, due_at, completed FROM assignments ORDER BY uid").all();
  assert.deepEqual(rows, [
    { uid: 'event-assignment-1001', due_at: '2026-11-14T04:59:00.000Z', completed: 0 },
    { uid: 'event-assignment-1003', due_at: '2026-11-15T23:59:00.000Z', completed: 1 },
  ]);

  // Manual tasks are never touched by sync.
  const general = db.prepare("SELECT id FROM courses WHERE code = 'CS 321-001'").get().id;
  db.prepare("INSERT INTO assignments (course_id, title, due_at) VALUES (?, 'Study group', '2026-11-12T22:00:00Z')").run(general);
  saveFeed(parseFeed(edited, NOW), '2026-11-11T12:00:00.000Z');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assignments WHERE source = 'manual'").get().n, 1);
});

test('an empty feed does not wipe the planner', () => {
  const empty = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:x\nEND:VCALENDAR\n';
  const r = saveFeed(parseFeed(empty, NOW), '2026-11-12T12:00:00.000Z');
  assert.equal(r.removed, 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM calendar_events').get().n > 0);
});

test('week query returns lectures in order', () => {
  const week = getEventsBetween('2026-11-09T05:00:00.000Z', '2026-11-16T05:00:00.000Z');
  assert.deepEqual(week.map((e) => e.title), ['Lecture']);
  assert.equal(week[0].course_code, 'CS 321-001');
});

test('rejects things that are not calendars', () => {
  assert.throws(() => parseFeed('<html>Login</html>'), /did not return a calendar/);
});
