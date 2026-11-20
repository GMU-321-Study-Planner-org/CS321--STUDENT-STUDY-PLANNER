# Canvas calendar sync (ical.js + SQLite)

## How it works

- Assignments and calendar events are separated using Canvas UIDs
  (`event-assignment-*` go to the to-do queue, `event-calendar-event-*` such as
  lectures and office hours go to a new `user_calendar_events` table).
- Assignments deleted in Canvas are removed on the next sync, unless the student
  already checked them off. An empty feed never deletes anything.
- Recurring events (RRULE) are expanded, including moved occurrences (RECURRENCE-ID).
- The feed's VTIMEZONE blocks are registered, so `TZID=` times convert correctly.
- Each sync is logged in `user_sync_runs` (time, counts, error message).
- Schema upgrades run automatically via `PRAGMA user_version`; existing
  `planner.db` files keep their data.

All planner data is stored per user (`user_courses`, `user_assignments`, `user_study_sessions`,
`user_calendar_events`, `user_settings`, `user_sync_runs`), and every sync, read and clear is scoped to the
signed-in user, so each student's Canvas feed and data stay separate.

Code: `backend/server/canvas.js` (fetch, parse with ical.js, save) and `database/db.js` (schema and migrations).
`backend/demo-feed.js` serves `test/sample-canvas.ics` shifted to the current week for demos.
