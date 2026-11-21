
import {
  randomBytes,
  scrypt,
  createHash,
  timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);

const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'planner_session';

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64);

  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [salt, savedHash] = stored.split(':');
    const expected = Buffer.from(savedHash, 'hex');

    if (expected.length !== 64) return false;

    const actual = await deriveKey(password, salt, 64);

    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function getCookie(req) {
  const cookies = req.headers.cookie || '';

  const entry = cookies.split(';').map(s => s.trim())
    .find(s => s.startsWith(`${COOKIE_NAME}=`));

  return entry ? entry.slice(COOKIE_NAME.length + 1) : null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MS
  };
}

function startSession(db, userId, res) {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();

  db.prepare(`
    INSERT INTO user_sessions
      (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, tokenHash, expiresAt);

  res.cookie(COOKIE_NAME, token, cookieOptions());
}

export function getCurrentUser(db, req) {
  const token = getCookie(req);

  if (!token) return null;

  return db.prepare(`
    SELECT users.id, users.name, users.email
    FROM user_sessions
    JOIN users ON users.id = user_sessions.user_id
    WHERE user_sessions.token_hash = ?
      AND user_sessions.expires_at > ?
  `).get(hashToken(token), new Date().toISOString()) || null;
}

export function requireAuth(db) {
  return (req, res, next) => {
    const user = getCurrentUser(db, req);

    if (!user) {
      return res.status(401).json({
        error: 'Please sign in to continue.'
      });
    }

    req.user = user;
    next();
  };
}

export function setupAuth(app, db) {
  app.post('/api/auth/register', async (req, res) => {
    try {
      const name = String(req.body.name ?? '').trim();
      const email = String(req.body.email ?? '').trim().toLowerCase();
      const password = req.body.password;

      if (name.length < 2 || name.length > 100) {
        return res.status(400).json({
          error: 'Please enter a valid name.'
        });
      }

      if (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return res.status(400).json({
          error: 'Please enter a valid email address.'
        });
      }

      if (
        typeof password !== 'string' ||
        password.length < 8 ||
        Buffer.byteLength(password, 'utf8') > 128
      ) {
        return res.status(400).json({
          error: 'Password must be at least 8 characters and no more than 128 bytes.'
        });
      }

      const existing = db.prepare(
        'SELECT id FROM users WHERE email = ?'
      ).get(email);

      if (existing) {
        return res.status(409).json({
          error: 'An account with this email already exists.'
        });
      }

      const passwordHash = await hashPassword(password);

      const result = db.prepare(`
        INSERT INTO users (name, email, password_hash)
        VALUES (?, ?, ?)
      `).run(name, email, passwordHash);

      startSession(db, result.lastInsertRowid, res);

      res.status(201).json({
        user: {
          id: Number(result.lastInsertRowid),
          name,
          email
        }
      });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({
          error: 'An account with this email already exists.'
        });
      }

      console.error('Registration failed:', error);
      res.status(500).json({
        error: 'Unable to create account.'
      });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const email = String(req.body.email ?? '').trim().toLowerCase();
      const password = req.body.password;

      if (
        email.length > 254 ||
        typeof password !== 'string' ||
        Buffer.byteLength(password, 'utf8') > 128
      ) {
        return res.status(401).json({
          error: 'Invalid email or password.'
        });
      }

      const user = db.prepare(`
        SELECT id, name, email, password_hash
        FROM users
        WHERE email = ?
      `).get(email);

      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({
          error: 'Invalid email or password.'
        });
      }

      startSession(db, user.id, res);

      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email
        }
      });
    } catch (error) {
      console.error('Login failed:', error);
      res.status(500).json({
        error: 'Unable to sign in.'
      });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    const user = getCurrentUser(db, req);

    if (!user) {
      return res.status(401).json({
        error: 'Not signed in.'
      });
    }

    res.json({ user });
  });


  // profile-settings-v2: authenticated account details and per-user preferences.
  app.put('/api/auth/profile', requireAuth(db), (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Name must be 2–100 characters.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    try {
      db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, req.user.id);
      res.json({ user: { id: req.user.id, name, email } });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({error:'That email is already in use.'});
      console.error('Profile update failed:', err);
      res.status(500).json({error:'Unable to update profile.'});
    }
  });

  const preferenceKeys = ['university', 'major', 'weeklyHours', 'sessionMinutes'];
  app.get('/api/auth/preferences', requireAuth(db), (req,res) => {
    const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.user.id);
    const settings = Object.fromEntries(rows.filter(r => preferenceKeys.includes(r.key)).map(r=>[r.key,r.value]));
    res.json({preferences:settings});
  });
  app.put('/api/auth/preferences', requireAuth(db), (req,res) => {
    const b = req.body ?? {};
    const university = typeof b.university === 'string' ? b.university.trim() : '';
    const major = typeof b.major === 'string' ? b.major.trim() : '';
    const hours = Number(b.weeklyHours);
    const minutes = Number(b.sessionMinutes);
    if (university.length > 100 || major.length > 100 || !Number.isInteger(hours) || hours < 1 || hours > 80 || ![25,45,60,90].includes(minutes)) {
      return res.status(400).json({error:'Please check your study preferences.'});
    }
    const prefs = {university, major, weeklyHours:String(hours), sessionMinutes:String(minutes)};
    const put = db.prepare(`INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`);
    try {
      db.transaction(()=>{ for (const [key,value] of Object.entries(prefs)) put.run(req.user.id,key,value); })();
      res.json({preferences:prefs});
    } catch(err) {
      console.error('Preferences update failed:',err);
      res.status(500).json({error:'Unable to save preferences.'});
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = getCookie(req);

    if (token) {
      db.prepare(`
        DELETE FROM user_sessions WHERE token_hash = ?
      `).run(hashToken(token));
    }

    res.clearCookie(COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    res.json({ ok: true });
  });
}
