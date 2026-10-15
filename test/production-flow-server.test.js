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

test('main broadcast cues publish one complete revision; stale, invalid and scorekeeper commands cannot partially update or save', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-production-flow-'));
  const config = { dataDir: dir, pin: 'production-main-fixture', scorekeeperPin: 'production-score-fixture' };
  let app = createBroadcastServer(config); const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  app.store.commit({ type: 'set-qualifier-plan', payload: { plan: 'A' } }, 0);
  const address = await app.listen(0, '127.0.0.1'), url = `http://127.0.0.1:${address.port}`;
  async function pair(role, pin) {
    const response = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pin }) });
    assert.equal(response.status, 200); return (await response.json()).token;
  }
  async function connect(namespace, token) {
    const socket = io(url + namespace, { autoConnect: false, auth: { token }, forceNew: true, reconnection: false });
    sockets.push(socket); const initial = event(socket, 'state'); socket.connect(); await initial; return socket;
  }
  const mainToken = await pair('control', config.pin), scorerToken = await pair('scorekeeper', config.scorekeeperPin);
  const main = await connect('/control', mainToken), scorer = await connect('/scorekeeper', scorerToken), overlay = await connect('/overlay');
  const published = []; overlay.on('state', value => published.push(value));
  const beforeRevision = app.store.state.revision, beforeBackups = app.store.listBackups().length;
  const payload = { stage: 'qualifier', scene: 'qualifier-match', group: 'A', players: ['p4', 'p5', 'p6'], songIndex: 1 };
  const visible = event(overlay, 'state', value => value.revision === beforeRevision + 1);
  const accepted = await send(main, { expectedRevision: beforeRevision, action: { type: 'set-broadcast-cue', payload } });
  assert.equal(accepted.ok, true); const onAir = await visible;
  assert.equal(onAir.scene, 'qualifier-match'); assert.equal(onAir.stage, 'qualifier');
  assert.equal(onAir.qualifier.currentSong, 1); assert.deepEqual(onAir.qualifier.activePlayers, ['p4', 'p5', 'p6']);
  assert.equal(published.length, 1); assert.equal(app.store.listBackups().length, beforeBackups + 1);
  const saved = fs.readFileSync(app.store.file, 'utf8'), backups = app.store.listBackups().length;
  const stale = await send(main, { expectedRevision: beforeRevision, action: { type: 'set-broadcast-cue', payload: { ...payload, scene: 'song-result' } } });
  assert.equal(stale.code, 'STALE');
  const invalid = await send(main, { expectedRevision: app.store.state.revision,
    action: { type: 'set-broadcast-cue', payload: { ...payload, group: 'B', players: ['p1'] } } });
  assert.equal(invalid.ok, false);
  for (const action of [{ type: 'set-broadcast-cue', payload }, { type: 'set-qualifier-song-stats',
    payload: { group: 'A', playerId: 'p4', songIndex: 1, stats: { score: 900000, perfect: 100, good: 0, bad: 0, miss: 0 } } }]) {
    const denied = await send(scorer, { expectedRevision: app.store.state.revision, contextKey: scorekeeperState(app.store.state).contextKey, action });
    assert.equal(denied.code, 'FORBIDDEN');
  }
  assert.equal(fs.readFileSync(app.store.file, 'utf8'), saved); assert.equal(app.store.listBackups().length, backups);
  assert.equal(published.length, 1);
  const stats = { score: 0, perfect: 0, good: 0, bad: 0, miss: 0, accuracy: 0 };
  const statisticsRevision = app.store.state.revision;
  const statisticsLive = event(overlay, 'state', value => value.revision === statisticsRevision + 1);
  const statisticsAck = await send(main, { expectedRevision: statisticsRevision,
    action: { type: 'set-qualifier-song-stats', payload: { group: 'A', playerId: 'p4', songIndex: 1, stats } } });
  assert.equal(statisticsAck.ok, true);
  const statisticsState = await statisticsLive;
  assert.deepEqual(statisticsState.qualifier.rounds.A.results.p4.songStats[1], stats);
  assert.equal(statisticsState.qualifier.rankings.A.find(player => player.id === 'p4').total, null);
  assert.equal(statisticsState.qualifier.adjudications, undefined);
  const expectedRevision = app.store.state.revision;
  for (const socket of sockets) socket.close(); await app.close();
  app = createBroadcastServer(config); await app.listen(address.port, '127.0.0.1');
  assert.equal(app.store.state.revision, expectedRevision); assert.equal(app.store.state.scene, 'qualifier-match');
  assert.deepEqual(app.store.state.qualifier.rounds.A.results.p4.songStats[1], stats);
  assert.equal(app.store.state.qualifier.rounds.A.results.p4.challengeTotal, null);
});
