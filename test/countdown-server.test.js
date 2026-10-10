const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { context } = require('../public/js/countdown');

function event(socket, name, predicate = () => true, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error('Timed out: ' + name)); }, timeout);
    function handler(value) { if (!predicate(value)) return; clearTimeout(timer); socket.off(name, handler); resolve(value); }
    socket.on(name, handler);
  });
}
function emit(socket, name, body) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit(name, body, (error, reply) => error ? reject(error) : resolve(reply)));
}
function sync(socket) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit('countdown-sync', (error, reply) => error ? reject(error) : resolve(reply)));
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-countdown-'));
  let app = createBroadcastServer({ dataDir: directory, pin: 'countdown-fixture-code' });
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.close()); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app.store.commit({ type: 'set-scene', payload: { scene: 'qualifier-match' } }, 0);
  const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  const paired = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'countdown-fixture-code' }) });
  const { token } = await paired.json();
  async function connect(namespace) {
    const socket = io(base + namespace, { forceNew: true, reconnection: false, autoConnect: false, auth: namespace === '/control' ? { token } : {} });
    sockets.push(socket);
    const firstState = event(socket, 'state'), firstCue = event(socket, 'countdown');
    socket.connect(); const [state, countdown] = await Promise.all([firstState, firstCue]);
    return { socket, state, countdown };
  }
  const { socket: control } = await connect('/control');
  const command = (type, payload = {}) => emit(control, 'command', { expectedRevision: app.store.state.revision, action: { type, payload } });
  const cue = (action = 'start', overrides = {}, socket = control) => emit(socket, 'countdown-command', {
    action, expectedRevision: app.store.state.revision, contextKey: context(app.store.state)?.key, ...overrides
  });
  return { get app() { return app; }, directory, base, token, control, connect, command, cue,
    async restart() { const port = address.port; await app.close(); app = createBroadcastServer({ dataDir: directory, pin: 'countdown-fixture-code' }); await app.listen(port, '127.0.0.1'); }
  };
}

test('paired crew broadcast one ephemeral cue to every overlay and control; public overlays cannot start it', async t => {
  const f = await fixture(t), a = (await f.connect('/overlay')).socket, b = (await f.connect('/overlay')).socket;
  const crew = (await f.connect('/control')).socket;
  const unpaired = io(f.base + '/control', { forceNew: true, reconnection: false, autoConnect: false });
  t.after(() => unpaired.close()); const denied = event(unpaired, 'connect_error'); unpaired.connect();
  assert.equal((await denied).message, 'PAIRING_REQUIRED');
  a.emit('countdown-command', { action: 'start', expectedRevision: f.app.store.state.revision, contextKey: context(f.app.store.state).key });
  assert.equal((await sync(a)).cue, null);
  assert.equal((await f.command('set-broadcast-sources', { layout: 'qualifier', slots: Array.from({ length: 3 }, (_, i) => ({ capture: `PRIVATE CARD ${i}`, handcam: `PRIVATE HAND ${i}` })) })).ok, true);
  const saved = fs.readFileSync(f.app.store.file, 'utf8'), backups = fs.readdirSync(f.app.store.backupDir), revision = f.app.store.state.revision;
  const receives = [a, b, crew].map(socket => event(socket, 'countdown', value => Boolean(value.cue)));
  assert.equal((await f.cue()).ok, true);
  const messages = await Promise.all(receives), first = messages[0];
  for (const message of messages) assert.deepEqual(message, first);
  assert.match(first.cue.id, /^[a-f0-9]{32}$/);
  assert.equal(first.sequence, 1);
  assert.equal(first.cue.endsAt - first.cue.startsAt, 3950);
  assert.ok(first.cue.startsAt > first.serverNow && first.cue.startsAt <= first.serverNow + 350);
  assert.equal(first.cue.context.scene, 'qualifier-match');
  assert.equal(JSON.stringify(first).includes('PRIVATE'), false, 'Source names must remain private even inside the context key');
  assert.equal(f.app.store.state.revision, revision);
  assert.equal(fs.readFileSync(f.app.store.file, 'utf8'), saved);
  assert.deepEqual(fs.readdirSync(f.app.store.backupDir), backups);
  const state = await (await fetch(f.base + '/api/state')).json();
  assert.equal('countdown' in state, false);
  assert.equal((await sync(a)).cue.id, first.cue.id);
  const stopped = event(b, 'countdown', value => value.cue === null);
  assert.equal((await f.cue('cancel', { cueId: first.cue.id })).ok, true); assert.equal((await stopped).sequence, 2);
  assert.equal(fs.readFileSync(f.app.store.file, 'utf8'), saved);
  assert.deepEqual(fs.readdirSync(f.app.store.backupDir), backups);
});

test('concurrent starts, stale controls and stale cancellation cannot replace or stop an active cue', async t => {
  const f = await fixture(t), other = (await f.connect('/control')).socket;
  const starts = await Promise.all([f.cue(), f.cue('start', {}, other)]);
  assert.equal(starts.filter(result => result.ok).length, 1);
  assert.equal(starts.find(result => !result.ok).code, 'ALREADY_RUNNING');
  const first = (await sync(other)).cue;
  assert.equal((await f.cue('start', { expectedRevision: 0 })).code, 'STALE');
  assert.equal((await f.cue('cancel', { cueId: first.id, contextKey: 'old-context' })).code, 'CONTEXT_CHANGED');
  assert.equal((await sync(other)).cue.id, first.id);
  assert.equal((await f.cue('cancel', { cueId: first.id })).ok, true);
  assert.equal((await f.cue()).ok, true);
  const second = (await sync(other)).cue; assert.notEqual(second.id, first.id);
  assert.equal((await sync(other)).sequence, 3);
  assert.equal((await f.cue('cancel', { cueId: first.id })).code, 'CUE_CHANGED');
  assert.equal((await sync(other)).cue.id, second.id);
  assert.equal((await f.cue('cancel', { cueId: second.id })).ok, true);
});

test('live match context and source changes cancel a cue, but score updates keep its original timeline', async t => {
  const f = await fixture(t), overlay = (await f.connect('/overlay')).socket;
  assert.equal((await f.cue()).ok, true); const initial = (await sync(overlay)).cue;
  assert.equal((await f.command('set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 980000 })).ok, true);
  assert.deepEqual((await sync(overlay)).cue, initial, 'Scoring does not restart or cancel the start signal');
  for (const [type, payload] of [
    ['set-qualifier-display', { currentSong: 1 }],
    ['set-qualifier-display', { players: ['p1', 'p3'] }],
    ['set-broadcast-display', { showHandcams: true }],
    ['set-broadcast-sources', { layout: 'qualifier', slots: Array.from({ length: 3 }, (_, i) => ({ capture: `Card ${i}`, handcam: `Hand ${i}` })) }],
    ['set-scene', { scene: 'qualifier-waiting' }]
  ]) {
    if (!(await sync(overlay)).cue) assert.equal((await f.cue()).ok, true);
    const stopped = event(overlay, 'countdown', value => value.cue === null);
    assert.equal((await f.command(type, payload)).ok, true); await stopped;
    assert.equal((await sync(overlay)).cue, null, `${type} cancels the old cue`);
  }
  assert.equal((await f.cue()).code, 'INVALID');
  assert.equal((await f.command('set-scene', { scene: 'qualifier-match' })).ok, true);
  assert.equal((await f.cue()).ok, true);
  const stopped = event(overlay, 'countdown', value => value.cue === null);
  assert.equal((await f.command('set-qualifier-display', { group: 'B' })).ok, true); await stopped;
  assert.equal((await f.cue()).code, 'INVALID', 'A group with no selected entrants cannot be started');
});

test('refresh synchronizes to the same timestamp, completed cues expire, and restart does not replay them', async t => {
  const f = await fixture(t);
  assert.equal((await f.cue()).ok, true); const original = (await sync(f.control)).cue;
  await new Promise(resolve => setTimeout(resolve, 1400));
  const fresh = await f.connect('/overlay');
  assert.deepEqual(fresh.countdown.cue, original);
  assert.ok(fresh.countdown.serverNow >= original.startsAt + 900, 'A late connection receives the current phase rather than a new 3');
  const ended = event(fresh.socket, 'countdown', value => value.cue === null);
  const finish = await ended; assert.ok(finish.serverNow >= original.endsAt);
  assert.equal((await sync(fresh.socket)).cue, null);
  assert.equal((await f.connect('/overlay')).countdown.cue, null, 'Finished cues are not replayed on refresh');
  assert.equal((await f.cue()).ok, true);
  await f.restart();
  const restarted = await f.connect('/overlay'); assert.equal(restarted.countdown.cue, null);
  assert.equal(f.app.store.state.scene, 'qualifier-match');
});

test('restoring even the same match context clears a cue without persisting countdown data', async t => {
  const f = await fixture(t), overlay = (await f.connect('/overlay')).socket;
  const id = f.app.store.saveBackup(f.app.store.state);
  assert.equal((await f.cue()).ok, true);
  const stopped = event(overlay, 'countdown', value => value.cue === null);
  const response = await fetch(f.base + '/api/restore', {
    method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupId: id, expectedRevision: f.app.store.state.revision, reason: 'Fixture restore of the current match' })
  });
  assert.equal(response.status, 200); await stopped;
  assert.equal((await sync(overlay)).cue, null);
  assert.ok(context(f.app.store.state));
  const snapshot = JSON.parse(fs.readFileSync(f.app.store.file, 'utf8'));
  assert.equal('countdown' in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes('startsAt'), false);
});

test('double-elimination cues need complete song selection and cancel when the current song or match changes', async t => {
  const f = await fixture(t), overlay = (await f.connect('/overlay')).socket;
  assert.equal((await f.command('seed-bracket', { ids: f.app.store.state.qualifier.players.map(player => player.id) })).ok, true);
  assert.equal((await f.command('set-scene', { scene: 'double-elimination-match' })).ok, true);
  assert.equal((await f.cue()).code, 'INVALID', 'An unselected song must not receive a start signal');
  const matchId = 'W1';
  assert.equal((await f.command('draw-candidates', { matchId })).ok, true);
  const candidates = f.app.store.state.tournament.matches.find(match => match.id === matchId).candidates;
  for (const playerIndex of [0, 1]) assert.equal((await f.command('ban-song', { matchId, playerIndex, songId: candidates[playerIndex].id })).ok, true);
  assert.equal((await f.command('pick-songs', { matchId })).ok, true);
  assert.equal((await f.cue()).ok, true); const first = (await sync(overlay)).cue;
  assert.equal(first.context.matchId, matchId); assert.equal(first.context.songIndex, 0);
  let stopped = event(overlay, 'countdown', value => value.cue === null);
  assert.equal((await f.command('set-song-progress', { matchId, index: 1 })).ok, true); await stopped;
  assert.equal((await f.cue()).ok, true);
  stopped = event(overlay, 'countdown', value => value.cue === null);
  assert.equal((await f.command('select-match', { matchId: 'W2' })).ok, true); await stopped;
  assert.equal((await sync(overlay)).cue, null);
  assert.equal((await f.cue()).code, 'INVALID');
});

test('Grand Finals sealed MC song cannot be cued or leaked; it becomes eligible only after reveal', async t => {
  const f = await fixture(t), overlay = (await f.connect('/overlay')).socket;
  const apply = (type, payload = {}) => f.app.store.commit({ type, payload }, f.app.store.state.revision);
  apply('seed-bracket', { ids: f.app.store.state.qualifier.players.map(player => player.id) });
  // Build a real final through the engine rather than inventing unresolved player slots.
  for (const matchId of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'L1', 'L2', 'W7', 'L3', 'L4', 'L5', 'L6']) {
    apply('select-match', { matchId }); apply('draw-candidates', { matchId });
    const m = f.app.store.state.tournament.matches.find(match => match.id === matchId);
    for (const playerIndex of [0, 1]) apply('ban-song', { matchId, playerIndex, songId: m.candidates[playerIndex].id });
    apply('pick-songs', { matchId });
    for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) apply('set-match-score', { matchId, playerIndex, songIndex, score: playerIndex === 0 ? 990000 : 980000 });
    apply('record-result', { matchId });
  }
  apply('select-match', { matchId: 'GF' });
  const ids = f.app.store.state.library.slice(0, 8).map(song => song.id), secretId = ids[2];
  apply('set-final-candidates', { matchId: 'GF', ids });
  apply('set-final-picks', { matchId: 'GF', audienceIds: ids.slice(0, 2), hostId: secretId });
  assert.equal((await f.command('set-scene', { scene: 'double-elimination-match' })).ok, true);
  assert.equal((await f.command('set-song-progress', { matchId: 'GF', index: 2 })).ok, false, 'A sealed MC song must not become the current song');
  const gf = f.app.store.state.tournament.matches.find(match => match.id === 'GF');
  const sealed = structuredClone(f.app.store.state); sealed.tournament.matches.find(match => match.id === 'GF').currentSong = 2;
  assert.equal(context(sealed), null, 'Even a preexisting sealed cursor is ineligible for countdown');
  assert.equal((await f.cue()).ok, true); const first = (await sync(overlay)).cue;
  assert.equal(first.context.songId, ids[0]); assert.equal(JSON.stringify(first).includes(secretId), false);
  assert.equal((await f.cue('cancel', { cueId: first.id })).ok, true);
  assert.equal((await f.command('reveal-host-song', { matchId: 'GF' })).ok, true);
  assert.equal((await f.command('set-song-progress', { matchId: 'GF', index: 2 })).ok, true);
  assert.equal((await f.cue()).ok, true);
  const revealed = (await sync(overlay)).cue;
  assert.equal(revealed.context.songId, gf.hostPick.id); assert.equal(revealed.context.songIndex, 2);
});
