const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { loadManualSave } = require('../scripts/manual-save-loader');
const { hostState } = require('../lib/host');
const { loadPairingCredentials } = require('../lib/pairing-credentials');

async function fixture(t, id = 'D01', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-host-test-'));
  const { state } = loadManualSave(id);
  fs.writeFileSync(path.join(dir, 'match-state.json'), JSON.stringify(state));
  const app = createBroadcastServer({ dataDir: dir, pin: 'host-test-main', scorekeeperPin: 'host-test-score', ...options });
  const clients = [];
  t.after(async () => { clients.forEach(socket => socket.disconnect()); await app.close(); fs.rmSync(dir, { force: true, recursive: true }); });
  const address = await app.listen(0, '127.0.0.1'), base = 'http://127.0.0.1:' + address.port;
  async function pair(role, pin = { control: app.pin, scorekeeper: app.scorekeeperPin, host: app.hostPin }[role]) {
    return fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pin }) });
  }
  const tokens = {};
  for (const role of ['control', 'scorekeeper', 'host']) tokens[role] = (await (await pair(role)).json()).token;
  async function connect(namespace, token = tokens.host) {
    return new Promise((resolve, reject) => {
      const socket = io(base + namespace, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(socket);
      socket.once('state', state => resolve({ socket, state })); socket.once('connect_error', reject);
    });
  }
  const { socket } = await connect('/host');
  const emit = (event, request) => new Promise((resolve, reject) => socket.timeout(3000).emit(event, request, (error, response) => error ? reject(error) : resolve(response)));
  const command = (type, payload = {}, extra = {}) => {
    const view = hostState(app.store.state);
    return emit('command', { expectedRevision: view.revision, contextKey: view.contextKey,
      action: { type, payload: { matchId: view.match?.id, ...payload } }, ...extra });
  };
  return { app, dir, base, pair, tokens, connect, command, emit };
}

test('host pairing persists separately and all other panel sessions and private APIs reject it', async t => {
  const f = await fixture(t);
  assert.match(f.app.hostPin, /^\d{6}$/); assert.ok(![f.app.pin, f.app.scorekeeperPin].includes(f.app.hostPin));
  const file = path.join(f.dir, '.host-pin');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), f.app.hostPin); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(f.tokens.host, /^host\.[a-f0-9]{64}\.[a-f0-9]{64}$/);
  for (const role of ['control', 'scorekeeper']) {
    assert.equal((await f.pair(role, f.app.hostPin)).status, 401);
    assert.equal((await f.pair('host', { control: f.app.pin, scorekeeper: f.app.scorekeeperPin }[role])).status, 401);
    await assert.rejects(f.connect('/' + role), /FORBIDDEN/);
    await assert.rejects(f.connect('/host', f.tokens[role]), /FORBIDDEN/);
  }
  for (const endpoint of ['/api/control-state', '/api/scorekeeper-state', '/api/export', '/api/backups', '/api/backups/example/preview', '/api/result-correction/W1'])
    assert.equal((await fetch(f.base + endpoint, { headers: { Authorization: 'Bearer ' + f.tokens.host } })).status, 403, endpoint);
  for (const endpoint of ['/api/restore', '/api/intermission/video'])
    assert.equal((await fetch(f.base + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + f.tokens.host, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, endpoint);
  assert.equal((await fetch(f.base + '/api/host-state')).status, 401);
  assert.equal((await fetch(f.base + '/api/host-state', { headers: { Authorization: 'Bearer ' + f.tokens.control } })).status, 403);
  const response = await fetch(f.base + '/api/host-state', { headers: { Authorization: 'Bearer ' + f.tokens.host } });
  assert.equal(response.status, 200);
  const projected = JSON.stringify(await response.json());
  for (const key of ['library', 'scores', 'judgements', 'broadcast', 'auditLog', 'qualifier']) assert.equal(projected.includes('"' + key + '"'), false);
});

test('host can draw six, ban for both players and pick two, then all selection is locked', async t => {
  const f = await fixture(t), before = structuredClone(f.app.store.state.qualifier);
  assert.equal((await f.command('draw-candidates')).ok, true);
  assert.equal(f.app.store.state.scene, 'song-selection');
  assert.equal((await f.command('draw-candidates')).code, 'INVALID', 'Only main control can redraw an existing candidate pool');
  const m = f.app.store.state.tournament.matches.find(m => m.id === 'W1');
  assert.equal(m.candidates.length, 6);
  const songs = m.candidates.map(song => song.id);
  assert.equal((await f.command('pick-songs')).ok, false);
  assert.equal((await f.command('ban-song', { playerIndex: 0, songId: songs[0] })).ok, true);
  assert.equal((await f.command('ban-song', { playerIndex: 1, songId: songs[0] })).ok, false);
  assert.equal((await f.command('ban-song', { playerIndex: 1, songId: songs[1] })).ok, true);
  assert.equal((await f.command('pick-songs')).ok, true);
  const selected = f.app.store.state.tournament.matches[0];
  assert.equal(selected.songs.length, 2); assert.ok(selected.songs.every(song => !songs.slice(0, 2).includes(song.id)));
  assert.ok(selected.selectionPreviewCue.roulette);
  const snapshot = structuredClone(f.app.store.state);
  for (const type of ['draw-candidates', 'ban-song', 'pick-songs']) assert.equal((await f.command(type, { playerIndex: 0, songId: songs[2] })).ok, false);
  assert.deepEqual(f.app.store.state, snapshot); assert.deepEqual(f.app.store.state.qualifier, before);
});

test('forged host commands, other matches, stale contexts and no-ban passes cannot mutate any state', async t => {
  const f = await fixture(t), original = fs.readFileSync(f.app.store.file, 'utf8');
  for (const type of ['set-scene', 'set-stage', 'set-event', 'select-match', 'set-match-score', 'set-qualifier-challenge-result', 'record-result', 'reopen-result', 'seed-bracket', 'reset-current-match', 'set-broadcast-volume', 'start-intermission', 'play-final-finale-video', '__proto__', null]) {
    const response = await f.command(type, { scene: 'result', score: 999999 }); assert.equal(response.code, 'FORBIDDEN', String(type));
  }
  assert.equal((await f.emit('countdown-command', { action: 'start' })).code, 'FORBIDDEN');
  assert.equal(fs.readFileSync(f.app.store.file, 'utf8'), original);
  assert.equal((await f.command('draw-candidates', { matchId: 'W2' })).code, 'CONTEXT_CHANGED');
  assert.equal((await f.command('draw-candidates', {}, { contextKey: 'obsolete' })).code, 'CONTEXT_CHANGED');
  assert.equal((await f.command('draw-candidates', {}, { expectedRevision: -1 })).code, 'STALE');
  assert.equal((await f.command('draw-candidates')).ok, true);
  for (const payload of [{ playerIndex: 0, songId: null, confirmed: true }, { playerIndex: 2, songId: 'bad' }]) assert.equal((await f.command('ban-song', payload)).ok, false);
  const old = hostState(f.app.store.state);
  f.app.store.commit({ type: 'select-match', payload: { matchId: 'W2' } }, f.app.store.state.revision);
  assert.equal((await f.command('draw-candidates', { matchId: 'W1' }, { contextKey: old.contextKey })).code, 'CONTEXT_CHANGED');
});

test('breaks, qualifier stages, fixed finals, completed matches and tiebreaks expose no editable host controls', () => {
  for (const id of ['B01', 'Q03', 'F01', 'D08', 'D14']) {
    const { state } = loadManualSave(id), view = hostState(state);
    assert.ok(Object.values(view.available).every(value => value === false), id);
    if (state.stage !== 'double-elimination' || state.tournament.currentMatchId === 'GF') assert.equal(view.match, null);
  }
});

test('host credentials and sessions survive restart without changing existing role signing', async t => {
  const f = await fixture(t), original = f.app.hostPin;
  await f.app.close();
  const app = createBroadcastServer({ dataDir: f.dir, pin: 'host-test-main', scorekeeperPin: 'host-test-score' });
  t.after(() => app.close()); const address = await app.listen(0, '127.0.0.1');
  assert.equal(app.hostPin, original);
  const response = await fetch('http://127.0.0.1:' + address.port + '/api/host-state', { headers: { Authorization: 'Bearer ' + f.tokens.host } });
  assert.equal(response.status, 200);
});

test('explicit host codes must be nonempty and different from both other roles', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-code-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const hostPin of ['fixture-main', 'fixture-score', '', '  ']) {
    assert.throws(() => loadPairingCredentials(dir, { pin: 'fixture-main', scorekeeperPin: 'fixture-score', hostPin }), /must differ|must be nonempty/);
  }
});
