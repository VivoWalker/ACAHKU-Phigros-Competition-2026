const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { scorekeeperState, scorekeeperAction } = require('../lib/scorekeeper');

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error('Timed out: ' + name)); }, 6000);
    function receive(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, receive);
  });
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-tiebreak-score-lock-'));
  const app = createBroadcastServer({ dataDir: dir, pin: 'main-score-lock-fixture', scorekeeperPin: 'scorer-score-lock-fixture' });
  const address = await app.listen(0, '127.0.0.1'), url = `http://127.0.0.1:${address.port}`;
  const response = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'scorekeeper', pin: 'scorer-score-lock-fixture' }) });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const socket = io(url + '/scorekeeper', { autoConnect: false, auth: { token }, forceNew: true, reconnection: false });
  const initial = event(socket, 'state'); socket.connect(); await initial;
  t.after(async () => { socket.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const f = {
    app, socket,
    command(type, payload = {}) { return app.store.commit({ type, payload }, app.store.state.revision); },
    score(type, payload = {}) {
      const view = scorekeeperState(app.store.state);
      return new Promise((resolve, reject) => socket.timeout(6000).emit('command', {
        expectedRevision: view.revision, contextKey: view.contextKey, action: { type, payload }
      }, (error, result) => error ? reject(error) : resolve(result)));
    }
  };
  f.command('set-qualifier-plan', { plan: 'A' });
  return f;
}
function drawQualifierTie(f) {
  const scores = [990000, 980000, 970000, 900000, 900000, 800000, 700000, 600000];
  scores.forEach((score, index) => {
    for (let songIndex = 0; songIndex < 3; songIndex++) f.command('set-qualifier-score', {
      group: 'A', playerId: `p${index + 1}`, songIndex, score, judgements: { accuracy: 98 }
    });
  });
  f.command('draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
}
function diskSnapshot(f) {
  return { revision: f.app.store.state.revision, state: fs.readFileSync(f.app.store.file, 'utf8'), backups: fs.readdirSync(f.app.store.backupDir).sort() };
}
async function assertBaseRejected(f, payload) {
  const before = diskSnapshot(f);
  const result = await f.score('set-qualifier-score', { playerId: 'p4', songIndex: 0, score: 999999, ...payload });
  assert.equal(result.ok, false); assert.equal(result.code, 'INVALID');
  assert.deepEqual(diskSnapshot(f), before, 'Rejected scorer commands must not alter official state or create backups');
}

test('paired scorer can enter ordinary qualifier scores, but cannot retain master correction flags', async t => {
  const f = await fixture(t), payload = { playerId: 'p4', songIndex: 0, score: 900000, judgements: { accuracy: 98 },
    confirmClearTiebreaks: true, verified: true, reason: 'Pretend scorer approval' };
  const view = scorekeeperState(f.app.store.state);
  assert.equal(view.qualifier.baseLocked, false); assert.equal(view.qualifier.baseLockedReason, '');
  assert.deepEqual(scorekeeperAction(f.app.store.state, { contextKey: view.contextKey, action: { type: 'set-qualifier-score', payload } }).payload,
    { playerId: 'p4', songIndex: 0, score: 900000, judgements: { accuracy: 98 } });
  const result = await f.score('set-qualifier-score', payload);
  assert.equal(result.ok, true);
  assert.equal(f.app.store.state.qualifier.rounds.A.results.p4.scores[0], 900000);
  assert.deepEqual(f.app.store.state.qualifier.rounds.A.results.p4.judgements[0], { accuracy: 98 });
});

test('pending qualifier tiebreak locks every base score while its eligible participants can still submit tiebreak scores', async t => {
  const f = await fixture(t); drawQualifierTie(f);
  const view = scorekeeperState(f.app.store.state);
  assert.equal(view.qualifier.baseLocked, true);
  assert.equal(view.qualifier.locked, false, 'Base locking must not lock the pending tiebreak sheet');
  assert.match(view.qualifier.baseLockedReason, /主控/); assert.equal(view.qualifier.tiebreak.index, 0);
  await assertBaseRejected(f);
  await assertBaseRejected(f, { confirmClearTiebreaks: true, verified: true, reason: 'Pretend scorer approval' });
  await assertBaseRejected(f, { playerId: 'p1', score: 990000 });
  const beforeBase = structuredClone(f.app.store.state.qualifier.rounds.A.results);
  const result = await f.score('set-qualifier-tiebreak-score', { group: 'A', index: 0, playerId: 'p4', score: 950000,
    judgements: { accuracy: 99.2 }, confirmClearTiebreaks: true, verified: true });
  assert.equal(result.ok, true);
  assert.deepEqual(f.app.store.state.qualifier.rounds.A.results, beforeBase);
  assert.equal(f.app.store.state.qualifier.rounds.A.tiebreaks[0].scores.p4, 950000);
  assert.equal(f.app.store.state.qualifier.rounds.A.tiebreaks[0].confirmed, false);
});

test('confirmed qualifier tiebreak keeps base scores read-only and rejects scorer flags without state or backup writes', async t => {
  const f = await fixture(t); drawQualifierTie(f);
  for (const [playerId, score] of [['p4', 950000], ['p5', 960000]]) {
    assert.equal((await f.score('set-qualifier-tiebreak-score', { group: 'A', index: 0, playerId, score })).ok, true);
  }
  f.command('confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  const before = scorekeeperState(f.app.store.state);
  assert.equal(before.qualifier.baseLocked, true); assert.equal(before.qualifier.locked, false);
  assert.equal(before.qualifier.tiebreak, undefined);
  await assertBaseRejected(f);
  await assertBaseRejected(f, { score: 900000, judgements: { accuracy: 100 }, confirmClearTiebreaks: true, verified: true, reason: 'Pretend scorer approval' });
  const disk = diskSnapshot(f);
  const result = await f.score('set-qualifier-tiebreak-score', { group: 'A', index: 0, playerId: 'p4', score: 970000 });
  assert.equal(result.ok, false); assert.equal(result.code, 'FORBIDDEN');
  assert.deepEqual(diskSnapshot(f), disk);
  assert.equal(f.app.store.state.qualifier.rounds.A.tiebreaks[0].scores.p4, 950000);
});

test('double-elimination sheets expose the same base lock and leave only the pending extra song editable', async t => {
  const f = await fixture(t);
  f.command('seed-bracket', { ids: f.app.store.state.qualifier.players.map(player => player.id), verified: true, note: 'Fixture arbiter approves direct bracket testing.' });
  f.command('select-match', { matchId: 'W1' }); f.command('draw-candidates', { matchId: 'W1' });
  for (const playerIndex of [0, 1]) f.command('ban-song', { matchId: 'W1', playerIndex, songId: null, confirmed: true });
  f.command('pick-songs', { matchId: 'W1' });
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) {
    assert.equal((await f.score('set-match-score', { matchId: 'W1', playerIndex, songIndex, score: 900000, judgements: { accuracy: 98 } })).ok, true);
  }
  f.command('draw-match-tiebreak', { matchId: 'W1' });
  const view = scorekeeperState(f.app.store.state);
  assert.equal(view.match.baseLocked, true); assert.equal(view.match.locked, false);
  assert.match(view.match.baseLockedReason, /主控/); assert.equal(view.match.tiebreak.index, 0);
  const before = diskSnapshot(f);
  const baseResult = await f.score('set-match-score', { matchId: 'W1', playerIndex: 0, songIndex: 0, score: 999999, confirmClearTiebreaks: true, verified: true });
  assert.equal(baseResult.ok, false); assert.equal(baseResult.code, 'INVALID'); assert.deepEqual(diskSnapshot(f), before);
  for (const [playerIndex, score] of [[0, 950000], [1, 960000]]) {
    assert.equal((await f.score('set-match-tiebreak-score', { matchId: 'W1', index: 0, playerIndex, score })).ok, true);
  }
  f.command('confirm-match-tiebreak', { matchId: 'W1', index: 0, verified: true });
  assert.equal(scorekeeperState(f.app.store.state).match.tiebreak, undefined);
  assert.equal(scorekeeperState(f.app.store.state).match.baseLocked, true);
});
