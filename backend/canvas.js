import ICAL from 'ical.js';
import db from './db.js';

export async function fetchFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Canvas returned ${res.status}. Check that the feed link is correct.`);
  return res.text();
}

// Canvas titles look like "Homework 3 [CS 450-004]". Split the course code off the end.
const TITLE_RE = /^(.*?)\s*\[([^\]]+)\]\s*$/;

export function parseFeed(icsText) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(icsText));
  } catch {
    throw new Error('That link did not return a calendar. Use the Calendar Feed link from Canvas.');
  }

  return root
    .getAllSubcomponents('vevent')
    .map((vevent) => {
      const event = new ICAL.Event(vevent);
      const raw = event.summary || 'Untitled';
      const match = raw.match(TITLE_RE);

      const start = event.startDate;
      const due = start.toJSDate();
      if (start.isDate) due.setHours(23, 59, 0, 0); // all-day events: due at end of day

      const link = vevent.getFirstPropertyValue('url');
      return {
        uid: event.uid,
        title: match ? match[1].trim() : raw,
        courseCode: match ? match[2].trim() : null,
        dueAt: due.toISOString(),
        url: typeof link === 'string' && /^https?:\/\//i.test(link) ? link : null, // never store javascript: links
        notes: (event.description || '').slice(0, 2000),
      };
    })
    .filter((e) => e.uid);
}

export async function syncFeed(url) {
  const events = parseFeed(await fetchFeed(url));

  const addCourse = db.prepare('INSERT INTO courses (code) VALUES (?) ON CONFLICT(code) DO NOTHING');
  const findCourse = db.prepare('SELECT id FROM courses WHERE code = ?');
  // Re-syncing updates titles and due dates but keeps your completed checkmarks.
  const upsert = db.prepare(`
    INSERT INTO assignments (uid, course_id, title, due_at, url, notes, source)
    VALUES (@uid, @courseId, @title, @dueAt, @url, @notes, 'canvas')
    ON CONFLICT(uid) DO UPDATE SET
      course_id = excluded.course_id, title = excluded.title, due_at = excluded.due_at,
      url = excluded.url, notes = excluded.notes
  `);

  db.transaction((list) => {
    for (const ev of list) {
      const code = ev.courseCode ?? 'General';
      addCourse.run(code);
      upsert.run({ uid: ev.uid, courseId: findCourse.get(code).id, title: ev.title, dueAt: ev.dueAt, url: ev.url, notes: ev.notes });
    }
  })(events);

  return events.length;
}
