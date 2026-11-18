# Canvas calendar sync (ical.js + SQLite)

## How it works

- Assignments and calendar events are separated using Canvas UIDs
  (`event-assignment-*` go to the to-do queue, `event-calendar-event-*` such as
  lectures and office hours go to a new `calendar_events` table).
- Assignments deleted in Canvas are removed on the next sync, unless the student
  already checked them off. An empty feed never deletes anything.
- Recurring events (RRULE) are expanded, including moved occurrences (RECURRENCE-ID).
- The feed's VTIMEZONE blocks are registered, so `TZID=` times convert correctly.
- Each sync is logged in `sync_runs` (time, counts, error message).
- Schema upgrades run automatically via `PRAGMA user_version`; existing
  `planner.db` files keep their data.

Code: `backend/canvas.js` (fetch, parse with ical.js, save) and `database/db.js` (schema and migrations).
`backend/demo-feed.js` serves `test/sample-canvas.ics` shifted to the current week for demos.
