const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const obsAdapter = require('../lib/obs-adapter');

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'Disconnected clients must be released from server registries');
}
async function pair(base, role, pin) {
  return fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, pin }) });
}

test('pairing retains separate role lockouts and successful attempts reset only that role', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-pairing-memory-'));
  const app = createBroadcastServer({ dataDir: dir, pin: 'fixture-main-code', scorekeeperPin: 'fixture-scorer-code' });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  for (let attempt = 0; attempt < 9; attempt++) assert.equal((await pair(base, 'control', 'incorrect')).status, 401);
  assert.equal((await pair(base, 'control', 'fixture-main-code')).status, 200);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await pair(base, 'control', 'incorrect')).status, 401);
  assert.equal((await pair(base, 'control', 'fixture-main-code')).status, 429);
  assert.equal((await pair(base, 'scorekeeper', 'fixture-scorer-code')).status, 200);
  assert.equal((await pair(base, 'control', 'incorrect')).status, 429);
});

test('repeated server lifecycles and panel reconnects release sockets, rooms and transport clients', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-socket-memory-'));
  const baselineListeners = obsAdapter.listenerCount('sceneChanged');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let cycle = 0; cycle < 3; cycle++) {
    const app = createBroadcastServer({ dataDir: dir, pin: 'fixture-main-code', scorekeeperPin: 'fixture-scorer-code' });
    const sockets = [];
    try {
      const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
      const control = await (await pair(base, 'control', 'fixture-main-code')).json();
      const scorer = await (await pair(base, 'scorekeeper', 'fixture-scorer-code')).json();
      for (let batch = 0; batch < 5; batch++) {
        const clients = [['/overlay', undefined], ['/control', control.token], ['/scorekeeper', scorer.token]].map(([namespace, token]) => {
          const socket = io(base + namespace, { auth: { token }, autoConnect: false, forceNew: true,
            transports: ['websocket'], reconnection: false });
          sockets.push(socket); return socket;
        });
        await Promise.all(clients.map(async socket => { const connected = once(socket, 'connect'); socket.connect(); await connected; }));
        assert.equal(app.io.engine.clientsCount, 3);
        for (const socket of clients) socket.close();
        await waitFor(() => app.io.engine.clientsCount === 0);
        for (const namespace of ['/overlay', '/control', '/scorekeeper']) {
          const current = app.io.of(namespace);
          assert.equal(current.sockets.size, 0);
          assert.equal(current.adapter.rooms.size, 0);
          assert.equal(current.adapter.sids.size, 0);
        }
      }
    } finally { sockets.forEach(socket => socket.close()); await app.close(); }
    assert.equal(app.io.engine.clientsCount, 0);
    assert.equal(app.server.listening, false);
    assert.equal(obsAdapter.listenerCount('sceneChanged'), baselineListeners);
  }
});
