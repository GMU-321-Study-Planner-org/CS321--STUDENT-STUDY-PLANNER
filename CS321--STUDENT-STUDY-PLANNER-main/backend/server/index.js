// Entry point kept so `cd backend && npm start` still works.
// The real (authenticated, per-user) server lives in backend/server.js; this used to be a
// second, unauthenticated copy that read the shared tables, so it now just starts that one.
import '../server.js';
