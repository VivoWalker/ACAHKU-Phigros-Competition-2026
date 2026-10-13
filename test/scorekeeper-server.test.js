const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { scorekeeperState } = require('../lib/scorekeeper');
const { expandSongLibrary, finalCandidates } = require('./helpers/song-library');

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error('Timed out: ' + name)); }, 6000);
    function handler(value) { if (!predicate(value)) return; clearTimeout(timer); socket.off(name, handler); resolve(value); }
    socket.on(name, handler);
  });
}
function emit(socket, name, payload) {
  return new Promise((resolve, reject) => socket.timeout(6000).emit(name, payload, (error, result) => error ? reject(error) : resolve(result)));
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-scorekeeper-'));
  const config = { dataDir: dir, pin: 'fixture-main-code', ...options };
  let app = createBroadcastServer(config), url, mainToken, scorerToken, control, scorer;
  const sockets = [];
  async function listen(port = 0) { const address = await app.listen(port, '127.0.0.1'); url = `http://127.0.0.1:${address.port}`; }
  async function session(role, pin = role === 'scorekeeper' ? app.scorekeeperPin : app.pin) {
    return fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pin }) });
  }
  async function connect(namespace, token = namespace === '/control' ? mainToken : scorerToken) {
    const socket = io(url + namespace, { autoConnect: false, auth: { token }, forceNew: true, reconnection: false });
    sockets.push(socket); const initial = event(socket, 'state'); socket.connect(); const state = await initial; return { socket, state };
  }
  await listen();
  mainToken = (await (await session('control')).json()).token;
  scorerToken = (await (await session('scorekeeper')).json()).token;
  control = (await connect('/control')).socket; scorer = (await connect('/scorekeeper')).socket;
  const f = {
    dir, get app() { return app; }, get url() { return url; }, get control() { return control; }, get scorer() { return scorer; },
    mainToken, scorerToken, session, connect,
    command(type, payload = {}, socket = control) { return emit(socket, 'command', { expectedRevision: app.store.state.revision, action: { type, payload } }); },
    score(type, payload = {}, extra = {}, socket = scorer) {
      const view = scorekeeperState(app.store.state);
      return emit(socket, 'command', { expectedRevision: view.revision, contextKey: view.contextKey, action: { type, payload }, ...extra });
    },
    async restart() {
      const port = new URL(url).port; for (const socket of sockets) socket.close(); await app.close();
      app = createBroadcastServer(config); await listen(Number(port));
      control = (await connect('/control', mainToken)).socket; scorer = (await connect('/scorekeeper', scorerToken)).socket;
    }
  };
  t.after(async () => { for (const socket of sockets) socket.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}
async function forbiddenConnection(f, namespace, token, expected = 'FORBIDDEN') {
  const socket = io(f.url + namespace, { autoConnect: false, auth: { token }, forceNew: true, reconnection: false });
  try { const rejected = event(socket, 'connect_error'); socket.connect(); assert.equal((await rejected).message, expected); }
  finally { socket.close(); }
}
async function pick(f, matchId) {
  assert.equal((await f.command('select-match', { matchId })).ok, true);
  assert.equal((await f.command('draw-candidates', { matchId })).ok, true);
  const candidates = f.app.store.state.tournament.matches.find(match => match.id === matchId).candidates;
  for (const playerIndex of [0, 1]) assert.equal((await f.command('ban-song', { matchId, playerIndex, songId: candidates[playerIndex].id })).ok, true);
  assert.equal((await f.command('pick-songs', { matchId })).ok, true);
}

test('main and scorekeeper pairing are isolated; original main tokens retain their exact signing format', async t => {
  const f = await fixture(t, { scorekeeperPin: 'fixture-score-code' });
  const ordinary = await fetch(f.url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: f.app.pin }) });
  const paired = await ordinary.json(); assert.equal(paired.role, 'control'); assert.match(paired.token, /^[a-f0-9]{64}\.[a-f0-9]{64}$/);
  const scorePaired = await (await f.session('scorekeeper')).json(); assert.equal(scorePaired.role, 'scorekeeper'); assert.match(scorePaired.token, /^scorekeeper\.[a-f0-9]{64}\.[a-f0-9]{64}$/);
  assert.equal((await f.session('control', f.app.scorekeeperPin)).status, 401);
  assert.equal((await f.session('scorekeeper', f.app.pin)).status, 401);
  assert.equal((await f.session('admin', f.app.pin)).status, 400);
  const nonce = 'ab'.repeat(32), legacy = nonce + '.' + createHmac('sha256', fs.readFileSync(path.join(f.dir, '.session-key'))).update(nonce + ':' + f.app.pin).digest('hex');
  assert.equal((await fetch(f.url + '/api/control-state', { headers: { Authorization: 'Bearer ' + legacy } })).status, 200);
  assert.equal((await f.connect('/control', legacy)).state.revision, 0);
  for (const endpoint of ['/api/control-state', '/api/export', '/api/backups', '/api/backups/unknown/preview', '/api/result-correction/W1']) {
    assert.equal((await fetch(f.url + endpoint)).status, 401);
    assert.equal((await fetch(f.url + endpoint, { headers: { Authorization: 'Bearer ' + f.scorerToken } })).status, 403);
  }
  assert.equal((await fetch(f.url + '/api/scorekeeper-state')).status, 401);
  assert.equal((await fetch(f.url + '/api/scorekeeper-state', { headers: { Authorization: 'Bearer ' + f.mainToken } })).status, 403);
  assert.equal((await fetch(f.url + '/api/scorekeeper-state', { headers: { Authorization: 'Bearer ' + f.scorerToken } })).status, 200);
  const unchanged = fs.readFileSync(f.app.store.file, 'utf8');
  assert.equal((await fetch(f.url + '/api/restore', { method: 'POST', headers: { Authorization: 'Bearer ' + f.scorerToken, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(fs.readFileSync(f.app.store.file, 'utf8'), unchanged);
  await forbiddenConnection(f, '/control', f.scorerToken); await forbiddenConnection(f, '/scorekeeper', f.mainToken);
  await forbiddenConnection(f, '/scorekeeper', undefined, 'PAIRING_REQUIRED');
  await forbiddenConnection(f, '/control', f.scorerToken.replace('scorekeeper.', ''), 'PAIRING_REQUIRED');
  await forbiddenConnection(f, '/scorekeeper', 'scorekeeper.' + f.mainToken, 'PAIRING_REQUIRED');
});

test('pairing attempt limits cannot be cleared by successfully pairing the other role', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i++) assert.equal((await f.session('control', 'incorrect')).status, 401);
  assert.equal((await f.session('scorekeeper')).status, 200);
  assert.equal((await f.session('control', 'incorrect')).status, 401);
  assert.equal((await f.session('control')).status, 429);
  assert.equal((await f.session('scorekeeper')).status, 200);
  assert.equal((await f.session('control')).status, 429);
});

test('scorekeeper socket rejects every non-score command and countdown without writing state or backups', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.app.store.file, 'utf8'), backups = f.app.store.listBackups();
  for (const type of ['set-event', 'set-scene', 'set-stage', 'set-qualifier-display', 'record-result', 'seed-bracket', 'reopen-result', 'set-final-picks', 'set-broadcast-sources', '__proto__', null]) {
    const result = await f.score(type, { venue: 'UNAUTHORIZED', scene: 'result' }); assert.equal(result.ok, false); assert.equal(result.code, 'FORBIDDEN');
  }
  const cue = await emit(f.scorer, 'countdown-command', { action: 'start', expectedRevision: 0 }); assert.equal(cue.code, 'FORBIDDEN');
  assert.equal(f.app.store.state.revision, 0); assert.equal(fs.readFileSync(f.app.store.file, 'utf8'), before); assert.deepEqual(f.app.store.listBackups(), backups);
  const view = (await f.connect('/scorekeeper')).state;
  assert.deepEqual(Object.keys(view).sort(), ['contextKey', 'event', 'match', 'qualifier', 'revision', 'stage']);
  assert.equal(view.match, null); assert.deepEqual(view.qualifier.players.map(player => player.id), ['p1', 'p2', 'p3', 'p4']);
  for (const forbidden of ['library', 'auditLog', 'recovery', 'correctionLog', 'broadcast', 'sourceSlots', 'candidates', 'backup']) assert.equal(JSON.stringify(view).includes('"' + forbidden + '"'), false);
  const connections = event(f.control, 'connections', value => value.scorekeepers === 3);
  const third = await f.connect('/scorekeeper'); assert.equal((await connections).controls, 1);
  const disconnected = event(f.control, 'connections', value => value.scorekeepers === 2); third.socket.close(); await disconnected;
});

test('scores persist and broadcast in both directions while invalid values, old revisions and old contexts are rejected', async t => {
  const f = await fixture(t), second = (await f.connect('/scorekeeper')).socket, overlay = (await f.connect('/overlay')).socket;
  const initial = scorekeeperState(f.app.store.state), receives = [event(f.control, 'state'), event(second, 'state'), event(overlay, 'state')];
  const saved = await f.score('set-qualifier-score', { playerId: 'p4', songIndex: 0, score: 0, ignoredField: 'IGNORED' }); assert.equal(saved.ok, true);
  const [main, other, publicView] = await Promise.all(receives);
  assert.equal(main.qualifier.players.find(player => player.id === 'p4').scores[0], 0);
  assert.equal(other.qualifier.players[3].scores[0], 0); assert.equal(publicView.qualifier.players.find(player => player.id === 'p4').scores[0], 0);
  assert.equal(other.contextKey, initial.contextKey); assert.equal(JSON.stringify(f.app.store.state).includes('IGNORED'), false);
  for (const score of [-1, 1000001, 12.5, '990000']) assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 0, score })).ok, false);
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 990000 }, { expectedRevision: initial.revision })).code, 'STALE');
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 990000 }, { contextKey: undefined })).code, 'CONTEXT_CHANGED');
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p5', songIndex: 0, score: 990000 })).code, 'FORBIDDEN');
  const updated = event(second, 'state'); assert.equal((await f.command('set-qualifier-score', { playerId: 'p1', songIndex: 1, score: 1000000 })).ok, true);
  assert.equal((await updated).qualifier.players[0].total, 1000000);
  const stableKey = scorekeeperState(f.app.store.state).contextKey;
  assert.equal((await f.command('set-qualifier-display', { currentSong: 2, players: ['p4'] })).ok, true);
  assert.equal(scorekeeperState(f.app.store.state).contextKey, stableKey, 'The sheet remains valid across the host song cursor and display selection');
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p4', songIndex: 0, score: null })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f.app.store.file, 'utf8')).qualifier.players[3].scores[0], null);
  assert.equal((await f.command('set-qualifier-display', { group: 'B' })).ok, true);
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p5', songIndex: 0, score: 990000 }, { contextKey: stableKey })).code, 'CONTEXT_CHANGED');
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 990000 })).code, 'FORBIDDEN');
  const staleGroup = scorekeeperState(f.app.store.state).contextKey;
  assert.equal((await f.command('set-qualifier-songs', { group: 'B', ids: ['song-2', 'song-4', 'song-8'] })).ok, true);
  assert.notEqual(scorekeeperState(f.app.store.state).contextKey, staleGroup);
});

test('match scoring remains limited to the active match and respects selection, vacancies and completed-result locks', async t => {
  const f = await fixture(t);
  assert.equal((await f.score('set-match-score', { matchId: 'W1', playerIndex: 0, songIndex: 0, score: 990000 })).code, 'FORBIDDEN');
  assert.equal((await f.command('seed-bracket', { ids: f.app.store.state.qualifier.players.map(player => player.id) })).ok, true);
  assert.equal((await f.command('set-stage', { stage: 'double-elimination' })).ok, true);
  assert.equal(scorekeeperState(f.app.store.state).qualifier.locked, true);
  assert.equal(scorekeeperState(f.app.store.state).match.locked, true);
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 990000 })).code, 'FORBIDDEN');
  assert.equal((await f.score('set-match-score', { matchId: 'W1', playerIndex: 0, songIndex: 0, score: 990000 })).ok, false);
  await pick(f, 'W1');
  const before = scorekeeperState(f.app.store.state); assert.equal(before.match.locked, false);
  assert.equal((await f.score('set-match-score', { matchId: 'W2', playerIndex: 0, songIndex: 0, score: 990000 })).code, 'FORBIDDEN');
  assert.equal((await f.command('set-song-progress', { matchId: 'W1', index: 1 })).ok, true);
  assert.equal(scorekeeperState(f.app.store.state).contextKey, before.contextKey, 'Host cursor does not invalidate a row being entered');
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) assert.equal((await f.score('set-match-score', { matchId: 'W1', playerIndex, songIndex, score: playerIndex === 0 ? 990000 : 980000 })).ok, true);
  assert.equal((await f.command('record-result', { matchId: 'W1' })).ok, true);
  assert.equal(scorekeeperState(f.app.store.state).match.locked, true);
  assert.equal((await f.score('set-match-score', { matchId: 'W1', playerIndex: 0, songIndex: 0, score: null })).ok, false);
  assert.equal((await f.command('set-stage', { stage: 'qualifier' })).ok, true);
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 990000 })).ok, false, 'Seeding locks the qualifier even when the main panel returns to that stage');
  assert.equal((await f.command('set-stage', { stage: 'double-elimination' })).ok, true);
  assert.equal((await f.command('select-match', { matchId: 'W2' })).ok, true);
  assert.equal((await f.score('set-match-score', { matchId: 'W2', playerIndex: 0, songIndex: 0, score: 990000 }, { contextKey: before.contextKey })).code, 'CONTEXT_CHANGED');
  const vacant = await fixture(t);
  assert.equal((await vacant.command('seed-bracket', { ids: ['p1', 'p2', null, null, null, null, null, null] })).ok, true);
  assert.equal((await vacant.command('set-stage', { stage: 'double-elimination' })).ok, true);
  assert.equal(scorekeeperState(vacant.app.store.state).match.players[1].id, null);
  assert.equal((await vacant.score('set-match-score', { matchId: 'W1', playerIndex: 0, songIndex: 0, score: 990000 })).ok, false);
});

test('reusing player or chart IDs with changed visible identities invalidates pending scoring sheets', async t => {
  const f = await fixture(t), action = { playerId: 'p1', songIndex: 0, score: 990000 };
  const beforeRename = scorekeeperState(f.app.store.state).contextKey;
  assert.equal((await f.command('rename-player', { playerId: 'p1', name: 'Replacement competitor' })).ok, true);
  assert.notEqual(scorekeeperState(f.app.store.state).contextKey, beforeRename);
  assert.equal((await f.score('set-qualifier-score', action, { contextKey: beforeRename })).code, 'CONTEXT_CHANGED');
  const beforeChart = scorekeeperState(f.app.store.state).contextKey;
  const song = { ...f.app.store.state.library[0], title: 'Changed chart identity', difficulty: 'AT', level: 18 };
  assert.equal((await f.command('upsert-song', { song })).ok, true);
  assert.notEqual(scorekeeperState(f.app.store.state).contextKey, beforeChart);
  assert.equal((await f.score('set-qualifier-score', action, { contextKey: beforeChart })).code, 'CONTEXT_CHANGED');
  assert.equal(f.app.store.state.qualifier.players[0].scores[0], null);
  assert.equal((await f.score('set-qualifier-score', action)).ok, true);
});

test('sealed final picks and their score slots never reach scorekeeper HTTP/socket/context; reveal enables scoring', async t => {
  const f = await fixture(t);
  expandSongLibrary(f.app.store.state);
  assert.equal((await f.command('seed-bracket', { ids: f.app.store.state.qualifier.players.map(player => player.id) })).ok, true);
  assert.equal((await f.command('set-stage', { stage: 'double-elimination' })).ok, true);
  for (const matchId of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'L1', 'L2', 'W7', 'L3', 'L4', 'L5', 'L6']) {
    await pick(f, matchId);
    for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) assert.equal((await f.command('set-match-score', { matchId, playerIndex, songIndex, score: playerIndex === 0 ? 990000 : 980000 })).ok, true);
    assert.equal((await f.command('record-result', { matchId })).ok, true);
  }
  assert.equal((await f.command('select-match', { matchId: 'GF' })).ok, true);
  const ids = finalCandidates(f.app.store.state, 8), secretId = ids[7];
  assert.equal((await f.command('set-final-candidates', { matchId: 'GF', ids })).ok, true);
  assert.equal((await f.command('set-final-picks', { matchId: 'GF', audienceIds: [ids[0], ids[1]], hostId: secretId })).ok, true);
  const gf = f.app.store.state.tournament.matches.find(match => match.id === 'GF');
  gf.hostPick.title = 'PRIVATE MC SONG'; gf.songs[2].title = 'PRIVATE MC SONG'; gf.scores[0][2] = 990001;
  require('../public/js/song-pool').remember(gf);
  f.app.store.state.broadcast.sourceSlots = { qualifier: Array.from({ length: 3 }, () => ({ capture: 'PRIVATE CAPTURE', handcam: 'PRIVATE HANDCAM' })) };
  f.app.store.write(f.app.store.state);
  const authenticated = await (await fetch(f.url + '/api/scorekeeper-state', { headers: { Authorization: 'Bearer ' + f.scorerToken } })).json();
  const received = (await f.connect('/scorekeeper')).state;
  for (const view of [authenticated, received]) {
    const json = JSON.stringify(view);
    for (const forbidden of [secretId, 'PRIVATE MC SONG', 'PRIVATE CAPTURE', 'PRIVATE HANDCAM', 'hostPick', 'candidates', 'sourceSlots', 'auditLog', 'recovery']) assert.equal(json.includes(forbidden), false, forbidden);
    assert.deepEqual(view.match.songs[2], { id: 'sealed', title: 'MC PICK — SEALED', difficulty: '', level: null, hidden: true });
    assert.equal(view.match.players[0].scores[2], null); assert.equal(view.match.players[0].total, 0);
  }
  const revision = f.app.store.state.revision;
  assert.equal((await f.score('set-match-score', { matchId: 'GF', playerIndex: 0, songIndex: 2, score: 999999 })).ok, false); assert.equal(f.app.store.state.revision, revision);
  const before = authenticated.contextKey, updated = event(f.scorer, 'state', value => value.match?.songs[2].id === secretId);
  assert.equal((await f.command('reveal-host-song', { matchId: 'GF' })).ok, true);
  const revealed = await updated; assert.notEqual(revealed.contextKey, before); assert.equal(revealed.match.songs[2].title, 'PRIVATE MC SONG');
  assert.equal((await f.score('set-match-score', { matchId: 'GF', playerIndex: 0, songIndex: 2, score: 999999 })).ok, true);
});

test('scorekeeper codes and tokens survive a process restart and use a distinct persisted six-digit code', async t => {
  const f = await fixture(t);
  const pin = f.app.scorekeeperPin; assert.match(pin, /^\d{6}$/); assert.notEqual(pin, f.app.pin);
  assert.equal(fs.readFileSync(path.join(f.dir, '.scorekeeper-pin'), 'utf8').trim(), pin);
  assert.equal(fs.statSync(path.join(f.dir, '.scorekeeper-pin')).mode & 0o777, 0o600);
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 990000 })).ok, true);
  await f.restart(); assert.equal(f.app.scorekeeperPin, pin);
  assert.equal((await fetch(f.url + '/api/scorekeeper-state', { headers: { Authorization: 'Bearer ' + f.scorerToken } })).status, 200);
  assert.equal((await f.connect('/scorekeeper')).state.qualifier.players[0].scores[0], 990000);
  assert.equal((await f.score('set-qualifier-score', { playerId: 'p1', songIndex: 1, score: 980000 })).ok, true);
  assert.throws(() => createBroadcastServer({ dataDir: f.dir, pin: 'same-fixture-code', scorekeeperPin: 'same-fixture-code' }), /must be different/);
  const alternative = createBroadcastServer({ dataDir: f.dir, pin });
  t.after(() => alternative.close()); assert.notEqual(alternative.scorekeeperPin, pin);
  assert.equal(fs.readFileSync(path.join(f.dir, '.scorekeeper-pin'), 'utf8').trim(), alternative.scorekeeperPin);
});
