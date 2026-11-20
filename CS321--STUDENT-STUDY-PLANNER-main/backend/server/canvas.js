// backend/canvas.js
// Imports a Canvas calendar feed (.ics) into the planner database using ical.js.
// Every store/read function takes a userId and only touches that user's rows
// (the user_* tables), so students never see or overwrite each other's data.
//
// Where to get the feed: Canvas > Calendar > "Calendar Feed" (bottom right).
// The link looks like https://<school>.instructure.com/feeds/calendars/user_XXXX.ics
// Anyone with that link can read the calendar, so treat it like a password.
import ICAL from 'ical.js';
import db from '../../database/db.js';

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const PAST_DAYS = 30;     // how far back recurring events are expanded
const FUTURE_DAYS = 180;  // how far forward recurring events are expanded
const MAX_OCCURRENCES = 500;

// Canvas titles look like "Homework 3 [CS 450-004]". Split the course code off the end.
const TITLE_RE = /^(.*?)\s*\[([^\]]+)\]\s*$/;

/* ------------------------------------------------------------------ fetch */

export async function fetchFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Canvas returned ${res.status}. Check that the feed link is correct.`);
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error('That calendar is too large to import.');
  return text;
}

/* ------------------------------------------------------------------ parse */

// Canvas UIDs say what each entry is:
//   event-assignment-12345            an assignment (due date)
//   event-assignment-override-678     an assignment with a section-specific due date
//   event-calendar-event-999          a calendar event (lecture, office hours, exam)
// For feeds from anywhere else, an entry with no duration is treated as a due date.
function kindOf(uid, start, end) {
  if (/^event-assignment-/.test(uid)) return 'assignment';
  if (/^event-calendar-event-/.test(uid)) return 'event';
  return !end || end.compare(start) === 0 ? 'assignment' : 'event';
}

const safeUrl = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null); // never store javascript: links

function splitTitle(summary) {
  const raw = (summary || 'Untitled').trim();
  const m = raw.match(TITLE_RE);
  return m ? { title: m[1].trim(), courseCode: m[2].trim() } : { title: raw, courseCode: null };
}

// ICAL.Time -> ISO string in UTC. All-day due dates become 11:59 pm that day,
// in the server's time zone (set TZ=America/New_York when running the server).
function toIso(time, { endOfDay = false } = {}) {
  const d = time.toJSDate();
  if (time.isDate && endOfDay) d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

// Yields every occurrence of an event inside the window. Non-recurring events
// yield once. Recurring ones (RRULE) are expanded, with RECURRENCE-ID overrides applied.
function* occurrences(event, windowStart, windowEnd) {
  if (!event.isRecurring()) {
    yield { uid: event.uid, item: event, start: event.startDate, end: event.endDate };
    return;
  }
  const it = event.iterator();
  for (let n = 0, next; (next = it.next()) && n < MAX_OCCURRENCES; n++) {
    if (next.compare(windowEnd) > 0) break;
    const d = event.getOccurrenceDetails(next);
    if (d.endDate.compare(windowStart) < 0) continue;
    yield { uid: `${event.uid}@${next.toString()}`, item: d.item, start: d.startDate, end: d.endDate };
  }
}

export function parseFeed(icsText, now = new Date()) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(icsText));
  } catch {
    throw new Error('That link did not return a calendar. Use the Calendar Feed link from Canvas.');
  }
  if (root.name !== 'vcalendar') throw new Error('That link did not return a calendar.');

  // Register the feed's own VTIMEZONE blocks so TZID= times convert correctly.
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid');
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(vtz);
  }

  // Group VEVENTs by UID: the master event plus any RECURRENCE-ID overrides.
  const masters = new Map();
  const overrides = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(vevent);
    if (!event.uid || !event.startDate) continue;
    if (event.isRecurrenceException()) overrides.push(event);
    else masters.set(event.uid, event);
  }
  for (const ex of overrides) masters.get(ex.uid)?.relateException(ex);

  const windowStart = ICAL.Time.fromJSDate(new Date(now.getTime() - PAST_DAYS * 864e5), true);
  const windowEnd = ICAL.Time.fromJSDate(new Date(now.getTime() + FUTURE_DAYS * 864e5), true);

  const assignments = [];
  const events = [];
  for (const master of masters.values()) {
    for (const occ of occurrences(master, windowStart, windowEnd)) {
      const { title, courseCode } = splitTitle(occ.item.summary);
      const url = safeUrl(occ.item.component.getFirstPropertyValue('url'));

      if (kindOf(master.uid, occ.start, occ.end) === 'assignment') {
        assignments.push({
          uid: occ.uid,
          title,
          courseCode,
          dueAt: toIso(occ.start, { endOfDay: true }),
          url,
          notes: (occ.item.description || '').slice(0, 2000),
        });
      } else {
        events.push({
          uid: occ.uid,
          title,
          courseCode,
          startsAt: toIso(occ.start),
          endsAt: toIso(occ.end ?? occ.start),
          allDay: occ.start.isDate ? 1 : 0,
          location: occ.item.location || null,
          url,
        });
      }
    }
  }
  return { assignments, events };
}

/* ------------------------------------------------------------------ store */

const stmts = {
  addCourse: db.prepare('INSERT INTO user_courses (user_id, code) VALUES (?, ?) ON CONFLICT(user_id, code) DO NOTHING'),
  findCourse: db.prepare('SELECT id FROM user_courses WHERE user_id = ? AND code = ?'),

  // Re-syncing updates titles and due dates but leaves the student's completed checkmark alone.
  upsertAssignment: db.prepare(`
    INSERT INTO user_assignments (user_id, uid, course_id, title, due_at, url, notes, source, synced_at)
    VALUES (@userId, @uid, @courseId, @title, @dueAt, @url, @notes, 'canvas', @syncedAt)
    ON CONFLICT(user_id, uid) DO UPDATE SET
      course_id = excluded.course_id, title = excluded.title, due_at = excluded.due_at,
      url = excluded.url, notes = excluded.notes, synced_at = excluded.synced_at
  `),
  upsertEvent: db.prepare(`
    INSERT INTO user_calendar_events (user_id, uid, course_id, title, starts_at, ends_at, all_day, location, url, synced_at)
    VALUES (@userId, @uid, @courseId, @title, @startsAt, @endsAt, @allDay, @location, @url, @syncedAt)
    ON CONFLICT(user_id, uid) DO UPDATE SET
      course_id = excluded.course_id, title = excluded.title, starts_at = excluded.starts_at,
      ends_at = excluded.ends_at, all_day = excluded.all_day, location = excluded.location,
      url = excluded.url, synced_at = excluded.synced_at
  `),

  // Anything from Canvas that this sync did not see has been removed in Canvas.
  // Completed assignments are kept so the student's history doesn't vanish.
  pruneAssignments: db.prepare(`
    DELETE FROM user_assignments
    WHERE user_id = ? AND source = 'canvas' AND completed = 0 AND (synced_at IS NULL OR synced_at <> ?)
  `),
  pruneEvents: db.prepare('DELETE FROM user_calendar_events WHERE user_id = ? AND synced_at <> ?'),

  startRun: db.prepare('INSERT INTO user_sync_runs (user_id, started_at) VALUES (?, ?)'),
  finishRun: db.prepare(`
    UPDATE user_sync_runs SET finished_at = @finishedAt, status = @status,
      assignments = @assignments, events = @events, removed = @removed, error = @error
    WHERE id = @id AND user_id = @userId
  `),
};

function courseId(userId, code) {
  if (!code) return null;
  stmts.addCourse.run(userId, code);
  return stmts.findCourse.get(userId, code).id;
}

// Writes parsed feed data for one user in one transaction: either the whole sync lands or none of it does.
export function saveFeed(userId, { assignments, events }, syncedAt = new Date().toISOString()) {
  return db.transaction(() => {
    for (const a of assignments) {
      stmts.upsertAssignment.run({ ...a, userId, courseId: courseId(userId, a.courseCode ?? 'General'), syncedAt });
    }
    for (const e of events) {
      stmts.upsertEvent.run({ ...e, userId, courseId: courseId(userId, e.courseCode), syncedAt });
    }

    // An empty feed is more likely a Canvas hiccup than a student with zero work.
    // Skip pruning so one bad response can't wipe the planner.
    let removed = 0;
    if (assignments.length + events.length > 0) {
      removed += stmts.pruneAssignments.run(userId, syncedAt).changes;
      removed += stmts.pruneEvents.run(userId, syncedAt).changes;
    }
    return { assignments: assignments.length, events: events.length, removed };
  })();
}

// Fetch, parse, save, and log the attempt in user_sync_runs.
export async function syncFeed(userId, url) {
  const startedAt = new Date().toISOString();
  const runId = stmts.startRun.run(userId, startedAt).lastInsertRowid;
  try {
    const counts = saveFeed(userId, parseFeed(await fetchFeed(url)), startedAt);
    stmts.finishRun.run({ id: runId, userId, finishedAt: new Date().toISOString(), status: 'ok', error: null, ...counts });
    return { imported: counts.assignments + counts.events, ...counts };
  } catch (err) {
    stmts.finishRun.run({
      id: runId, userId, finishedAt: new Date().toISOString(), status: 'error',
      assignments: null, events: null, removed: null, error: err.message,
    });
    throw err;
  }
}

/* ------------------------------------------------------------------ read */

// One user's calendar events for the week view, e.g. getEventsBetween(userId, mondayIso, nextMondayIso).
export const getEventsBetween = (userId, fromIso, toIso) =>
  db.prepare(`
    SELECT e.*, c.code AS course_code FROM user_calendar_events e
    LEFT JOIN user_courses c ON c.id = e.course_id
    WHERE e.user_id = ? AND e.starts_at < ? AND e.ends_at >= ?
    ORDER BY e.starts_at
  `).all(userId, toIso, fromIso);

export const getLastSync = (userId) =>
  db.prepare('SELECT * FROM user_sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) ?? null;

// Remove one user's imported Canvas data (their manual tasks stay) and forget their feed link.
export function clearCanvasData(userId) {
  return db.transaction(() => {
    const assignments = db.prepare("DELETE FROM user_assignments WHERE user_id = ? AND source = 'canvas'").run(userId).changes;
    const events = db.prepare('DELETE FROM user_calendar_events WHERE user_id = ?').run(userId).changes;
    db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = 'feed_url'").run(userId);
    return { assignments, events };
  })();
}
