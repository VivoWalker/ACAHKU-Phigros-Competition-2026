const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { scorekeeperState } = require('../lib/scorekeeper');
const Final = require('../public/js/final-announcement');

function fixture() {
  const state = createDefaultState();
  function act(type, payload = {}) {
    applyAction(state, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: state.tournament.currentMatchId, ...payload } : payload });
    validateState(state);
  }
  act('seed-bracket', { ids: state.qualifier.players.slice(0, 8).map(player => player.id) });
  for (let index = 0; index < 13; index++) {
    const match = state.tournament.matches.find(match => match.id !== 'GF' && ['ready', 'live'].includes(match.status));
    act('select-match', { matchId: match.id }); act('draw-candidates');
    for (const playerIndex of [0, 1]) act('ban-song', { playerIndex, songId: null, confirmed: true });
    act('pick-songs');
    for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act('set-match-score', {
      playerIndex, songIndex, score: playerIndex ? 980000 : 990000 });
    act('record-result', { verified: true });
  }
  act('select-match', { matchId: 'GF' }); act('set-song-progress', { index: 1 }); return state;
}
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

test('the main control broadcasts and persists one final clock; scorers and stale commands cannot replay it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-final-cue-server-'));
  const config = { dataDir: dir, pin: 'final-main-fixture-only', scorekeeperPin: 'final-score-fixture-only' };
  let app = createBroadcastServer(config); const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  app.store.state = fixture(); app.store.write(app.store.state);
  const address = await app.listen(0, '127.0.0.1'), url = `http://127.0.0.1:${address.port}`;
  async function pair(role, pin) {
    const response = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pin }) });
    assert.equal(response.status, 200); return (await response.json()).token;
  }
  async function connect(namespace, token) {
    const socket = io(url + namespace, { autoConnect: false, auth: { token }, forceNew: true, reconnection: false });
    sockets.push(socket); const initial = event(socket, 'state'); socket.connect(); await initial; return socket;
  }
  const main = await connect('/control', await pair('control', config.pin));
  const scorer = await connect('/scorekeeper', await pair('scorekeeper', config.scorekeeperPin));
  const overlay = await connect('/overlay'), published = []; overlay.on('state', value => published.push(value));
  const revision = app.store.state.revision, contextKey = scorekeeperState(app.store.state).contextKey;
  const action = { type: 'start-final-announcement', payload: { matchId: 'GF', songIndex: 0 } };
  const live = event(overlay, 'state', value => value.revision === revision + 1);
  const scoreView = event(scorer, 'state', value => value.revision === revision + 1);
  assert.equal((await send(main, { expectedRevision: revision, action })).ok, true);
  const onAir = await live, scoring = await scoreView;
  const final = onAir.tournament.matches.find(match => match.id === 'GF');
  assert.equal(onAir.scene, 'grand-final-announcement'); assert.equal(onAir.stage, 'double-elimination');
  assert.ok(Final.validCue(final.finalAnnouncement)); assert.equal(final.currentSong, 1);
  assert.equal(scoring.match.finalAnnouncement, undefined); assert.equal(scoring.contextKey, contextKey);
  assert.equal(published.length, 1, 'A single command publishes one complete shared clock');
  const saved = fs.readFileSync(app.store.file, 'utf8'), backups = app.store.listBackups().length;
  assert.equal((await send(main, { expectedRevision: revision, action })).code, 'STALE');
  assert.equal((await send(main, { expectedRevision: app.store.state.revision,
    action: { ...action, payload: { matchId: 'W1', songIndex: 0 } } })).code, 'MATCH_CHANGED');
  assert.equal((await send(scorer, { expectedRevision: app.store.state.revision, contextKey, action })).code, 'FORBIDDEN');
  assert.equal(fs.readFileSync(app.store.file, 'utf8'), saved); assert.equal(app.store.listBackups().length, backups);
  assert.equal(published.length, 1);
  const cue = structuredClone(final.finalAnnouncement), expectedRevision = app.store.state.revision;
  for (const socket of sockets) socket.close(); await app.close();
  app = createBroadcastServer(config); await app.listen(address.port, '127.0.0.1');
  const reloaded = app.store.state.tournament.matches.find(match => match.id === 'GF');
  assert.equal(app.store.state.revision, expectedRevision); assert.deepEqual(reloaded.finalAnnouncement, cue);
  assert.equal(reloaded.currentSong, 1);
  assert.equal(Final.phase(reloaded, cue.startedAt + 60000).complete, true, 'A late OBS source does not replay both songs');
});
