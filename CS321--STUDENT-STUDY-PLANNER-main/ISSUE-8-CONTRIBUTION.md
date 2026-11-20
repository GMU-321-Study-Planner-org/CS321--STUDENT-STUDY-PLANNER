# Issue #8: Assignment and Task Management

## Changes
- Edit titles, courses, and deadlines of manually added assignments.
- Delete manually added assignments with confirmation.
- Display completed assignments and restore them to the active queue.
- Prevent editing/deleting Canvas-synced assignments (their details are managed through Canvas).
- Validate assignment IDs and input values.

## Running
1. `cd backend`
2. `npm install`
3. `npm start`
4. Open http://localhost:3000

## Manual verification
1. Add a manual assignment and check that it appears in Up next.
2. Click Edit, change its title and due date, save, and reload the page.
3. Click its checkbox: it should move to Completed assignments.
4. Click Restore: it should return to Up next.
5. Click Delete and confirm: it should disappear and stay deleted after refresh.
6. If Canvas tasks exist, verify they cannot be edited/deleted, but can be completed/restored.

## Repo note
The source ZIP had entrypoint and frontend/backend files mismatched with its package script. This ZIP moves those files under `backend/server` and `backend/public`, and adds runtime dependencies so the app can start using `cd backend && npm install && npm start`. `database/db.js` is retained as the original copy.
