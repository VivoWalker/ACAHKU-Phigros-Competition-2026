'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { StateStore, validateState } = require('../lib/store');
const { sourceStatus } = require('../lib/broadcast-check');
const Waiting = require('../public/js/waiting-preview');
const { DIRECTORY, listManualSaves, loadManualSave } = require('../scripts/manual-save-loader');

const ROOT = path.join(__dirname, '..');
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-save-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function at(value, key) { return key.split('.').reduce((parent, part) => parent?.[part], value); }

for (const entry of listManualSaves()) test('manual save ' + entry.id + ': ' + entry.title, t => {
  const { state } = loadManualSave(entry.id);
  const original = JSON.parse(fs.readFileSync(path.join(DIRECTORY, entry.file), 'utf8'));
  assert.notEqual(state.eventId, original.eventId);
  assert.ok(state.event.title.startsWith('[TEST ' + entry.id + ']'));
  assert.equal(state.scene, entry.scene); assert.equal(state.stage, entry.stage);
  assert.ok(state.qualifier.players.every(player => player.name.startsWith('TEST Player ')));
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'match-state.json'), JSON.stringify(state));
  const store = new StateStore(dir);
  assert.deepEqual(store.state, state, 'Snapshot starts without legacy repair or fallback recovery');
  for (const probe of entry.probes) {
    const before = structuredClone(store.state);
    const action = { type: probe.type, payload: probe.payload };
    if (probe.reject) {
      assert.throws(() => store.commit(action, store.state.revision), new RegExp(probe.reject, 'i'), probe.type);
      assert.deepEqual(store.state, before, 'Rejected action is atomic');
    } else {
      store.commit(action, store.state.revision);
      validateState(store.state);
      const actual = { state: store.state, sources: sourceStatus(store.state) };
      for (const [key, value] of Object.entries(probe.expected)) assert.deepEqual(at(actual, key), value, probe.type + ': ' + key);
    }
  }
  assert.deepEqual(new StateStore(dir).state, store.state, 'Manual actions persist across restart');
});

test('manual loads refresh looping cues, wait deadlines and browser draft identity', () => {
  const now = Date.now(), first = loadManualSave('D04', { now }).state, second = loadManualSave('D04', { now }).state;
  assert.notEqual(first.eventId, second.eventId);
  const match = first.tournament.matches.find(item => item.id === first.tournament.currentMatchId);
  assert.equal(match.waitingPreviewCue.startedAt, now);
  assert.equal(match.waitingPreviewCue.contextKey, Waiting.context(first, now).key);
  const ban = loadManualSave('D03', { now }).state.tournament.matches[0].selectionPreviewCue;
  assert.equal(ban.kind, 'ban'); assert.equal(ban.startedAt, now);
  const waits = Object.values(loadManualSave('O05', { now }).state.qualifier.waits);
  assert.equal(waits.length, 1);
  assert.equal(Date.parse(waits[0].deadline) - now, 30000);
  assert.equal(Date.parse(waits[0].deadline) - Date.parse(waits[0].startsAt), 600000);
});

test('manual saves reject unknown selections and changed bytes before starting a server', t => {
  assert.throws(() => loadManualSave('../data/match-state'), /Unknown test case/);
  const dir = directory(t), entries = listManualSaves();
  fs.copyFileSync(path.join(DIRECTORY, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, entries[0].file), '{}');
  assert.throws(() => loadManualSave(entries[0].id, { directory: dir }), /checksum differs/);
});

test('all manual saves load with Windows newlines and UTF-8 BOMs', async t => {
  for (const [label, newline, bom] of [['CRLF', '\r\n', ''], ['BOM + LF', '\n', '\uFEFF'], ['BOM + CRLF', '\r\n', '\uFEFF']]) {
    await t.test(label, inner => {
      const dir = directory(inner), entries = listManualSaves();
      for (const file of ['manifest.json', ...entries.map(entry => entry.file)]) {
        const contents = fs.readFileSync(path.join(DIRECTORY, file), 'utf8').replace(/\r\n/g, '\n');
        fs.writeFileSync(path.join(dir, file), bom + contents.replace(/\n/g, newline));
      }
      for (const entry of entries) {
        const { state } = loadManualSave(entry.id, { directory: dir });
        assert.equal(state.scene, entry.scene, entry.id);
        assert.equal(state.stage, entry.stage, entry.id);
        assert.ok(state.event.title.startsWith('[TEST ' + entry.id + ']'), entry.id);
      }
      const file = path.join(dir, entries[0].file);
      const changed = fs.readFileSync(file, 'utf8').replace('TEST Player 01', 'TEST Player Changed');
      fs.writeFileSync(file, changed);
      assert.throws(() => loadManualSave(entries[0].id, { directory: dir }),
        /checksum differs:.*node scripts\/build-manual-saves\.js/);
    });
  }
});

test('manual saves can be reproduced byte for byte without changing the parent clock or RNG', t => {
  const dir = directory(t), started = Date.now(), uuid = require('node:crypto').randomUUID;
  execFileSync(process.execPath, ['scripts/build-manual-saves.js', '--output', dir], { cwd: ROOT, timeout: 30000 });
  assert.ok(Date.now() >= started); assert.equal(require('node:crypto').randomUUID, uuid);
  assert.deepEqual(fs.readdirSync(dir).sort(), fs.readdirSync(DIRECTORY).sort());
  for (const file of fs.readdirSync(dir)) assert.deepEqual(fs.readFileSync(path.join(dir, file)), fs.readFileSync(path.join(DIRECTORY, file)), file);
});

test('manual launcher serves a paired test event and removes its temporary data on shutdown', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['scripts/manual-rehearsal.js', '--case', 'q05', '--port', '0', '--host', '127.0.0.1', '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '', stopped = false;
  child.stderr.on('data', chunk => { errors += chunk; });
  const exit = once(child, 'exit').then(result => { stopped = true; return result; });
  t.after(async () => { if (!stopped) child.kill('SIGTERM'); await exit; });
  const lines = readline.createInterface({ input: child.stdout });
  const line = await Promise.race([
    once(lines, 'line').then(([text]) => text),
    exit.then(() => { throw new Error('Launcher exited before ready: ' + errors); })
  ]);
  const ready = JSON.parse(line), base = 'http://127.0.0.1:' + ready.port;
  assert.equal(ready.caseId, 'Q05'); assert.ok(fs.existsSync(ready.dataDir));
  const state = await fetch(base + '/api/state').then(response => response.json());
  assert.ok(state.event.title.startsWith('[TEST Q05]'));
  assert.equal((await fetch(base + '/control/')).status, 200);
  assert.equal((await fetch(base + '/scorekeeper/')).status, 200);
  assert.equal((await fetch(base + '/overlay/live.html')).status, 200);
  for (const [role, pin] of [['control', 'test-main'], ['scorekeeper', 'test-score']]) {
    const response = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pin }) });
    assert.equal(response.status, 200, role);
    assert.equal(typeof (await response.json()).token, 'string');
  }
  child.kill('SIGTERM'); assert.deepEqual(await exit, [0, null]);
  assert.equal(errors, ''); assert.equal(fs.existsSync(ready.dataDir), false);
});

test('manual launcher can stop and clean up immediately after announcing readiness', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['scripts/manual-rehearsal.js', '--case', 'B02', '--port', '0', '--host', '127.0.0.1', '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false;
  const exit = once(child, 'exit').then(result => { stopped = true; return result; });
  t.after(async () => { if (!stopped) child.kill('SIGTERM'); await exit; });
  const lines = readline.createInterface({ input: child.stdout });
  const ready = JSON.parse((await once(lines, 'line'))[0]);
  child.kill('SIGTERM');
  assert.deepEqual(await exit, [0, null]);
  assert.equal(fs.existsSync(ready.dataDir), false);
});
