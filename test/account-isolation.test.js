// Integration tests for account isolation, profile photos and focus logs.
// Copy into test/account-isolation.test.js. Uses a temporary SQLite database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

// One sequential integration scenario avoids races between mutable test accounts.
test('real HTTP API: permissions, focus logs, and photos are isolated by user', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cs321-isolation-'));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLANNER_DB: join(dir, 'isolation-test.db'),
      PORT: String(port),
      DEMO: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += String(chunk); });
  child.stderr.on('data', chunk => { serverOutput += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(`${base}/api/state`);
      if (response.status === 401) { ready = true; break; }
    } catch { /* server is starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `App failed to start with temporary DB: ${serverOutput.slice(-2000)}`);

  async function request(path, { method = 'GET', cookie, body, contentType = 'application/json' } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = contentType;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { /* binary or empty */ }
    return { status: res.status, json, bytes, headers: res.headers };
  }

  async function createAccount(label) {
    const response = await request('/api/auth/register', {
      method: 'POST', body: {
        name: `Test ${label}`, email: `test-${label}@example.invalid`, password: 'safe-test-pass-321',
      },
    });
    assert.equal(response.status, 201, `register ${label}: ${JSON.stringify(response.json)}`);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('planner_session='), `No session cookie for ${label}`);
    return cookie;
  }

  const alice = await createAccount('alice');
  const bob = await createAccount('bob');

  await t.test('unauthenticated requests are rejected', async () => {
    for (const path of ['/api/state', '/api/auth/avatar']) {
      assert.equal((await request(path)).status, 401, path);
    }
  });

  let assignmentId;
  await t.test('assignments cannot be viewed, updated or deleted by another account', async () => {
    const created = await request('/api/assignments', {
      method: 'POST', cookie: alice,
      body: { title: 'Alice private assignment', courseCode: 'CS 321', dueAt: '2026-12-10T19:00:00.000Z' },
    });
    assert.equal(created.status, 201);
    assignmentId = created.json.id;
    assert.ok(assignmentId);
    const bobState = await request('/api/state', { cookie: bob });
    assert.equal(bobState.status, 200);
    assert.equal(bobState.json.queue.length, 0);
    assert.equal(bobState.json.done.length, 0);
    assert.equal(bobState.json.courses.length, 0);
    assert.equal((await request(`/api/assignments/${assignmentId}`, {
      method: 'PATCH', cookie: bob, body: { completed: true },
    })).status, 404);
    assert.equal((await request(`/api/assignments/${assignmentId}`, {
      method: 'DELETE', cookie: bob,
    })).status, 404);
    assert.equal((await request(`/api/assignments/${assignmentId}`, {
      method: 'PUT', cookie: bob,
      body: { title: 'Tampered', courseCode: 'CS 321', dueAt: '2026-12-11T19:00:00Z' },
    })).status, 404);
    const aliceState = await request('/api/state', { cookie: alice });
    assert.equal(aliceState.json.queue.length, 1);
    assert.equal(aliceState.json.queue[0].title, 'Alice private assignment');
  });

  await t.test('owner can complete and delete a manually created assignment', async () => {
    const changed = await request(`/api/assignments/${assignmentId}`, {
      method: 'PATCH', cookie: alice, body: { completed: true },
    });
    assert.equal(changed.status, 200);
    const state = await request('/api/state', { cookie: alice });
    assert.ok(state.json.done.some(a => String(a.id) === String(assignmentId)));
    assert.equal((await request(`/api/assignments/${assignmentId}`, {
      method: 'DELETE', cookie: alice,
    })).status, 200);
    const after = await request('/api/state', { cookie: alice });
    assert.ok(![...after.json.queue, ...after.json.done].some(a => String(a.id) === String(assignmentId)));
  });

  await t.test('focus logs are scoped to the signed-in account', async () => {
    const created = await request('/api/focus-logs', {
      method: 'POST', cookie: alice,
      body: { courseCode: 'CS 321', topic: 'Review design diagrams', minutes: 25 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const aliceState = await request('/api/state', { cookie: alice });
    const bobState = await request('/api/state', { cookie: bob });
    assert.ok(aliceState.json.focusLogs.some(log => log.topic === 'Review design diagrams'));
    assert.equal(bobState.json.focusLogs.length, 0);
    const invalid = await request('/api/focus-logs', {
      method: 'POST', cookie: alice, body: { courseCode: 'CS 321', minutes: 999 },
    });
    assert.equal(invalid.status, 400);
  });

  await t.test('private avatar upload, retrieval, validation, and removal', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VRsAAAAASUVORK5CYII=', 'base64');
    const before = await request('/api/auth/avatar', { cookie: bob });
    assert.equal(before.status, 404);
    const upload = await request('/api/auth/avatar', {
      method: 'PUT', cookie: alice, body: png, contentType: 'image/png',
    });
    assert.equal(upload.status, 200, JSON.stringify(upload.json));
    const ownPhoto = await request('/api/auth/avatar', { cookie: alice });
    assert.equal(ownPhoto.status, 200);
    assert.deepEqual(ownPhoto.bytes, png);
    assert.match(ownPhoto.headers.get('content-type') || '', /image\/png/);
    assert.equal((await request('/api/auth/avatar', { cookie: bob })).status, 404);
    const invalid = await request('/api/auth/avatar', {
      method: 'PUT', cookie: alice, body: Buffer.from('not an image'), contentType: 'image/png',
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual((await request('/api/auth/avatar', { cookie: alice })).bytes, png);
    assert.equal((await request('/api/auth/avatar', {
      method: 'DELETE', cookie: bob,
    })).status, 200);
    assert.equal((await request('/api/auth/avatar', { cookie: alice })).status, 200);
    assert.equal((await request('/api/auth/avatar', { method: 'DELETE', cookie: alice })).status, 200);
    assert.equal((await request('/api/auth/avatar', { cookie: alice })).status, 404);
  });
});
