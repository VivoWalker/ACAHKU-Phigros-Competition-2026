const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { scorekeeperState } = require('../lib/scorekeeper');

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error('Timed out: ' + name)); }, 6000);
    function receive(value) { if (!predicate(value)) return; clearTimeout(timer); socket.off(name, receive); resolve(value); }
    socket.on(name, receive);
  });
}
function send(socket, request) {
  return new Promise((resolve, reject) => socket.timeout(6000).emit('command', request, (error, result) => error ? reject(error) : resolve(result)));
}

test('paired scorekeepers publish Challenge totals and complete three-song statistics, retaining both through export and process restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-challenge-live-'));
  const config = { dataDir: dir, pin: 'challenge-main-fixture', scorekeeperPin: 'challenge-score-fixture' };
  let app = createBroadcastServer(config), sockets = [];
  t.after(async () => { for (const socket of sockets) socket.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await app.listen(0, '127.0.0.1'), port = address.port, url = `http://127.0.0.1:${port}`;
  async function pair(role, pin) {
    const response = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pin }) });
    assert.equal(response.status, 200); return (await response.json()).token;
  }
  async function connect(namespace, token) {
    const socket = io(url + namespace, { autoConnect: false, auth: { token }, forceNew: true, reconnection: false });
    sockets.push(socket); const initial = event(socket, 'state'); socket.connect(); return { socket, state: await initial };
  }
  const mainToken = await pair('control', config.pin), scorerToken = await pair('scorekeeper', config.scorekeeperPin);
  let main = (await connect('/control', mainToken)).socket, scorer = (await connect('/scorekeeper', scorerToken)).socket;
  const overlay = (await connect('/overlay')).socket;
  const command = (type, payload = {}) => send(main, { expectedRevision: app.store.state.revision, action: { type, payload } });
  const score = (total, contextKey = scorekeeperState(app.store.state).contextKey) => send(scorer, {
    expectedRevision: app.store.state.revision, contextKey, action: { type: 'set-qualifier-total', payload: { group: 'A', playerId: 'p1', total } } });
  const before = fs.readFileSync(app.store.file, 'utf8'), oldContext = scorekeeperState(app.store.state).contextKey;
  assert.equal((await score(2876543)).code, 'INVALID'); assert.equal(fs.readFileSync(app.store.file, 'utf8'), before);
  assert.equal(app.store.listBackups().length, 0);
  assert.equal((await command('set-qualifier-plan', { plan: 'A' })).ok, true);
  assert.equal((await score(2876543, oldContext)).code, 'CONTEXT_CHANGED');
  const zeroRevision = app.store.state.revision + 1;
  const projectedZero = event(overlay, 'state', value => value.revision === zeroRevision); assert.equal((await score(0)).ok, true);
  const zero = await projectedZero;
  assert.equal(zero.qualifier.rounds.A.results.p1.challengeTotal, 0);
  assert.equal(zero.qualifier.rankings.A[0].total, 0); assert.equal(zero.qualifier.rankings.A[0].complete, true);
  const disk = fs.readFileSync(app.store.file, 'utf8'), snapshots = app.store.listBackups().length;
  for (const invalid of [3000001, 99.5, '2900000']) assert.equal((await score(invalid)).ok, false);
  assert.equal(fs.readFileSync(app.store.file, 'utf8'), disk); assert.equal(app.store.listBackups().length, snapshots);
  const lastRevision = app.store.state.revision + 1;
  const last = event(overlay, 'state', value => value.revision === lastRevision); assert.equal((await score(3000000)).ok, true); assert.equal((await last).qualifier.rankings.A[0].total, 3000000);
  const songStats = [
    { score: 1000000, perfect: 987, good: 0, bad: 0, miss: 0 },
    { score: 1000000, perfect: 1240, good: 0, bad: 0, miss: 0 },
    { score: 1000000, perfect: 1567, good: 0, bad: 0, miss: 0 }
  ];
  const result = (extra = {}) => send(scorer, { expectedRevision: app.store.state.revision,
    contextKey: scorekeeperState(app.store.state).contextKey, action: { type: 'set-qualifier-challenge-result',
      payload: { group: 'A', playerId: 'p1', total: 3000000, songStats, ...extra } } });
  const statsRevision = app.store.state.revision + 1, publicStats = event(overlay, 'state', value => value.revision === statsRevision);
  assert.equal((await result()).ok, true);
  assert.deepEqual((await publicStats).qualifier.rounds.A.results.p1.songStats, songStats);
  const protectedDisk = fs.readFileSync(app.store.file, 'utf8'), protectedBackups = app.store.listBackups().length, protectedRevision = app.store.state.revision;
  assert.equal((await result({ total: 2800000, songStats: [songStats[0], songStats[1], { ...songStats[2], miss: -1 }] })).ok, false);
  assert.equal((await result({ playerId: 'p4' })).code, 'FORBIDDEN', 'The scorer cannot fill another player in the same group outside the live batch');
  assert.equal(app.store.state.revision, protectedRevision); assert.equal(fs.readFileSync(app.store.file, 'utf8'), protectedDisk);
  assert.equal(app.store.listBackups().length, protectedBackups);
  const scorerView = await (await fetch(url + '/api/scorekeeper-state', { headers: { Authorization: 'Bearer ' + scorerToken } })).json();
  assert.deepEqual(scorerView.qualifier.players.map(player => player.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(scorerView.qualifier.players[0].songStats, songStats);
  const forbidden = await send(scorer, { expectedRevision: app.store.state.revision, contextKey: scorekeeperState(app.store.state).contextKey,
    action: { type: 'set-qualifier-scoring-mode', payload: { mode: 'legacy-score' } } });
  assert.equal(forbidden.code, 'FORBIDDEN');
  const exported = await (await fetch(url + '/api/export', { headers: { Authorization: 'Bearer ' + mainToken } })).json();
  assert.equal(exported.qualifier.scoringMode, 'challenge-total'); assert.equal(exported.qualifier.rounds.A.results.p1.challengeTotal, 3000000);
  assert.deepEqual(exported.qualifier.rounds.A.results.p1.scores, [null, null, null]);
  assert.deepEqual(exported.qualifier.rounds.A.results.p1.songStats, songStats);
  assert.equal((await fetch(url + '/api/export', { headers: { Authorization: 'Bearer ' + scorerToken } })).status, 403);
  const expectedRevision = app.store.state.revision;
  for (const socket of sockets) socket.close(); sockets = []; await app.close(); app = createBroadcastServer(config); await app.listen(port, '127.0.0.1');
  main = (await connect('/control', mainToken)).socket;
  const reconnected = await connect('/scorekeeper', scorerToken); scorer = reconnected.socket;
  assert.equal(reconnected.state.revision, expectedRevision); assert.equal(reconnected.state.qualifier.players[0].challengeTotal, 3000000);
  assert.equal(reconnected.state.qualifier.players[0].total, 3000000); assert.equal(reconnected.state.qualifier.players[0].accuracy, null);
  assert.deepEqual(reconnected.state.qualifier.players[0].songStats, songStats);
  assert.equal((await command('set-qualifier-scoring-mode', { mode: 'legacy-score' })).ok, false);
  assert.equal((await score(2987654)).ok, true); assert.equal(app.store.state.qualifier.rounds.A.results.p1.challengeTotal, 2987654);
});
