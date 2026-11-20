# Per-user data separation (login/logout follow-up)

Login and logout already worked, but every signed-in user read and wrote the same shared
tables (`courses`, `assignments`, `study_sessions`, `calendar_events`, `settings`, `sync_runs`).
Any account could see, change or delete anyone else's planner data, and one Canvas feed link
was shared by everybody. All planner data is now scoped to the signed-in user.

## What changed

| File | Change |
|---|---|
| `backend/server.js` | Every route now uses `req.user.id` (set by `requireAuth`) and the `user_*` tables. `/api/state` returns only the caller's courses, assignments, sessions, events, link status and last sync. Course/session creation uses a per-user `courseIdFor(userId, code)`. The Canvas feed URL is stored per user in `user_settings`. `PATCH /api/assignments/:id`, `PATCH /api/courses/:id`, `PUT` and `DELETE /api/assignments/:id` filter by `user_id` and return 404 for someone else's id (same as a missing one). Added ID validation. `DELETE /api/calendar` only clears the caller's imported data. Issue #8 edit/delete routes (previously only in the unauthenticated `server/index.js`) are now in this server, with ownership checks. |
| `backend/server/canvas.js` | `saveFeed`, `syncFeed`, `getEventsBetween`, `getLastSync` now take a `userId` as the first argument and read/write `user_courses`, `user_assignments`, `user_calendar_events`, `user_sync_runs`. Upserts conflict on `(user_id, uid)`; pruning is limited to that user. New `clearCanvasData(userId)`. `parseFeed` is unchanged. |
| `database/db.js` | New migration v4: indexes on `user_study_sessions(user_id, starts_at)` and `user_assignments(user_id, source)`. The v3 per-user tables were already defined and are unchanged. |
| `backend/public/app.js` | `api()` redirects to `/login.html` on a 401 (expired or signed-out session) instead of showing a raw error. |
| `backend/server/index.js` | Was a second server with no auth that used the shared tables. Now just imports `../server.js`, so `cd backend && npm start` runs the real server. |
| `backend/server/db.js` | Was a separate connection to `backend/planner.db`. Now re-exports `database/db.js`. |
| `test/canvas.test.js` | Updated to the new `userId` signatures and `user_*` tables. |
| `test/user-data.test.js` | New. Starts the server and checks: sign-in required, new accounts start empty, same course code is separate per user, priorities are per user, users can't complete/edit/delete each other's tasks (404), clearing Canvas data affects only the caller, logout deletes the session. |
| `docs/canvas-sync.md` | Updated table names and notes per-user scope. |

## Notes for the team
- Old rows in the shared tables (`courses`, `assignments`, ...) are left in place but are no longer read.
  There is no owner to attach them to, so they are not migrated. Users re-import from Canvas.
- `frontend/app.js` and `backend/priority.js` are old duplicate copies that nothing imports; not touched.
- `backend/package.json` has a `test` script pointing at a `tests/` folder that doesn't exist;
  use `npm test` from the repo root.

## Manual check
1. `npm install && npm run demo`, register user A, link `http://localhost:3000/demo/canvas.ics`, add a task.
2. Log out, register user B: the dashboard should be empty and not show A's Canvas link or tasks.
3. Log back in as A: A's data is intact.
