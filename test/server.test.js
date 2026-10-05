const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { getBranding } = require('../lib/branding');
function waitEvent(socket, name, timeout = 6000) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.off(name, handler); reject(new Error('Timed out: ' + name)); }, timeout); function handler(value) { clearTimeout(timer); resolve(value); } socket.once(name, handler); }); }
async function pair(url) { const r = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'fixture-code' }) }); return (await r.json()).token; }
test('HTTP pages and authenticated live updates, reconnect and process restart retain state and privacy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-server-')); let app, control, overlay, unpaired;
  try {
    app = createBroadcastServer({ dataDir: dir, pin: 'fixture-code' }); const address = await app.listen(0, '127.0.0.1'); let url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(url + '/api/health')).status, 200);
    const brandingResponse = await fetch(url + '/api/branding');
    assert.equal(brandingResponse.status, 200);
    const brandingJson = await brandingResponse.json();
    assert.deepEqual(Object.keys(brandingJson).sort(), ['kiramekiLogo', 'logo', 'socLogo', 'visual']);
    assert.deepEqual(brandingJson, getBranding());
    assert.equal((await fetch(url + '/api/control-state')).status, 401);
    assert.equal((await fetch(url + '/data/match-state.json')).status, 404);
    for (const page of ['start', 'qualifier-waiting', 'double-elimination-waiting', 'qualifier-match', 'double-elimination-match', 'result', 'bracket', 'song-selection']) {
      const r = await fetch(url + '/overlay/' + page + '.html'); assert.equal(r.status, 200); assert.match(await r.text(), new RegExp(`data-scene="${page}"`));
    }
    assert.equal((await fetch(url + '/control/')).status, 200);
    assert.equal((await fetch(url + '/assets/fonts/saira-latin-400-normal.woff2')).status, 200);
    const token = await pair(url); assert.ok(token);
    unpaired = io(url + '/control', { reconnection: false, forceNew: true }); const error = await waitEvent(unpaired, 'connect_error'); assert.equal(error.message, 'PAIRING_REQUIRED'); unpaired.close();
    control = io(url + '/control', { auth: { token }, forceNew: true }); let state = await waitEvent(control, 'state');
    overlay = io(url + '/overlay', { forceNew: true }); await waitEvent(overlay, 'state');
    const updated = waitEvent(overlay, 'state');
    const ack = await new Promise(resolve => control.emit('command', { expectedRevision: state.revision, action: { type: 'set-event', payload: { venue: 'LIVE TEST' } } }, resolve));
    assert.equal(ack.ok, true); assert.equal((await updated).event.venue, 'LIVE TEST');
    const stale = await new Promise(resolve => control.emit('command', { expectedRevision: 0, action: { type: 'set-scene', payload: { scene: 'result' } } }, resolve));
    assert.equal(stale.ok, false); assert.equal(stale.code, 'STALE');
    const recovered = waitEvent(overlay, 'state'); overlay.io.engine.close(); assert.equal((await recovered).event.venue, 'LIVE TEST');
    // A private MC pick must never reach HTTP public state or the overlay namespace.
    const final = app.store.state.tournament;
    final.matches = [{ id: 'GF', hostPick: { id: 'secret', title: 'PRIVATE SELECTION' }, hostRevealed: false, songs: [{ id: 'a' }, { id: 'b' }, { id: 'secret', title: 'PRIVATE SELECTION' }], scores: [[null, null, null], [null, null, null]], status: 'pending', players: [null, null], sources: [], loserId: null }];
    app.store.write(app.store.state);
    const publicJson = await (await fetch(url + '/api/state')).json(); assert.equal('hostPick' in publicJson.tournament.matches[0], false); assert.equal(publicJson.tournament.matches[0].songs[2].hidden, true);
    const authJson = await (await fetch(url + '/api/control-state', { headers: { Authorization: 'Bearer ' + token } })).json(); assert.equal(authJson.tournament.matches[0].hostPick.title, 'PRIVATE SELECTION');
    const publicSocket = waitEvent(overlay, 'state'); overlay.io.engine.close(); assert.equal((await publicSocket).tournament.matches[0].songs[2].hidden, true);
    const port = address.port; await app.close(); app = createBroadcastServer({ dataDir: dir, pin: 'fixture-code' });
    const restored = waitEvent(control, 'state', 10000); await app.listen(port, '127.0.0.1');
    assert.equal((await restored).event.venue, 'LIVE TEST'); assert.equal((await fetch(url + '/api/control-state', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
    assert.equal(app.store.state.revision, 1);
  } finally { control?.close(); overlay?.close(); unpaired?.close(); if (app) await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
module.exports = { waitEvent };
