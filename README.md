# CS 321 — Student Study Planner

Project for CS 321 

## Project Overview
Help students organize coursework, track deadlines,
prioritize assignments, and prepare for exams.

## Planned Features
- Course and assignment dashboard
- Deadline and priority management
- Weekly study schedule
- AI-generated study materials
- Practice exam timer
- Canvas integration

## Proposed MVP
- Basic course dashboard
- Manual assignment entry
- Deadline tracking
- Assignment prioritization

## Project Structure
- frontend/
- backend/
- database/
- docs/

## Development Status
Initial repository setup and project planning.
Implementation is pending.

## Running locally

Requires Node.js 20 or newer (`node -v` to check).

    npm install
    npm run demo

Then open http://localhost:3000 and:

1. Click **Link Canvas calendar**.
2. Paste `http://localhost:3000/demo/canvas.ics` and import.
3. Assignments appear in **Up next**; lectures and events appear in **This week**.
4. Change a course's priority (1 to 5) and watch the queue reorder. Check off an
   assignment, add a manual task, or plan a study session.

Demo mode serves a fake Canvas feed whose dates move to the current week, and
stores data in `demo.db`. Delete `demo.db` to start over.

### With a real Canvas calendar

    npm start

In Canvas, open **Calendar** and click **Calendar Feed** (bottom right). Copy the
link and paste it into **Link Canvas calendar**. Data goes in `planner.db`.
The feed link gives read access to your calendar, so don't commit it or share it.

### Tests

    npm test

See `docs/canvas-sync.md` for how the Canvas import works.
