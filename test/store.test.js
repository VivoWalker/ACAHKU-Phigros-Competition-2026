const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore, validateState } = require('../lib/store');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState } = require('../lib/tournament');
const { sourceStatus } = require('../lib/broadcast-check');

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new StateStore(dir, options) };
}
function venue(store, value) { return store.commit({ type: 'set-event', payload: { venue: value } }, store.state.revision); }

test('full schema validation rejects broken shapes, invalid scores and dangling references; valid schema-1 remains compatible', () => {
  const valid = createDefaultState(); delete valid.broadcast; assert.equal(validateState(valid), valid);
  const corruptions = [
    s => { delete s.qualifier; }, s => { s.qualifier.players[0].scores = [0]; },
    s => { s.qualifier.players[0].scores[0] = 1000001; }, s => { s.qualifier.activePlayers = ['missing']; },
    s => { s.qualifier.groups.A.songs[0] = 'missing'; }, s => { s.qualifier.players[1].id = 'p1'; },
    s => { s.scene = 'invalid-scene'; }, s => { s.revision = 0.5; },
    s => { applyAction(s, { type: 'seed-bracket', payload: { ids: s.qualifier.players.map(p => p.id) } }); s.tournament.matches[0].sources[0].value = 99; },
    s => { applyAction(s, { type: 'seed-bracket', payload: { ids: s.qualifier.players.map(p => p.id) } }); s.tournament.matches[0].songs = [{ id: 'fake' }]; }
  ];
  for (const corrupt of corruptions) { const s = createDefaultState(); corrupt(s); assert.throws(() => validateState(s), /Damaged state/); }
});

test('successful updates preserve the preceding revision with bounded retention and metadata-only audit', t => {
  const { dir, store } = fixture(t, { backupLimit: 3 });
  for (let i = 1; i <= 5; i++) venue(store, 'VENUE ' + i);
  const backups = store.listBackups(); assert.deepEqual(backups.map(b => b.revision), [4, 3, 2]);
  assert.equal(fs.readdirSync(store.backupDir).length, 3);
  const preview = store.previewBackup(backups[0].id); assert.equal(preview.event.venue, 'VENUE 4'); assert.equal(preview.scoredSlots, 0);
  assert.equal('library' in preview, false); assert.equal('auditLog' in preview, false);
  assert.equal(store.state.auditLog.length, 5); assert.deepEqual(Object.keys(store.state.auditLog[0]).sort(), ['at', 'revision', 'type']);
  assert.equal(new StateStore(dir).state.event.venue, 'VENUE 5');
  assert.equal('auditLog' in publicState(store.state), false);
});

test('reviewed restore requires a reason and current revision, backs up the replaced state and advances revision', t => {
  const { store } = fixture(t); venue(store, 'FIRST'); const original = store.listBackups()[0]; venue(store, 'SECOND');
  const before = structuredClone(store.state);
  assert.throws(() => store.restore(original.id, 1, 'Wrong entry'), error => error.code === 'STALE');
  assert.throws(() => store.restore(original.id, 2, ' '), /reason/);
  assert.throws(() => store.restore('../match-state.json', 2, 'Review'), /Unknown automatic backup/);
  assert.deepEqual(store.state, before);
  store.restore(original.id, 2, 'Referee verified original configuration');
  assert.equal(store.state.revision, 3); assert.equal(store.state.event.venue, 'UG201');
  assert.equal(store.state.auditLog.at(-1).type, 'restore-backup'); assert.equal(store.state.auditLog.at(-1).reason, 'Referee verified original configuration');
  assert.equal(store.readBackup(store.listBackups()[0].id).event.venue, 'SECOND');
  assert.equal('recovery' in publicState(store.state), false);
});

test('startup restores the newest valid snapshot, preserves damaged bytes and exposes an explicit staff notice', t => {
  const { dir, store } = fixture(t); venue(store, 'FIRST'); venue(store, 'SECOND');
  const bad = { schemaVersion: 1, revision: store.state.revision, tournament: { matches: [] } };
  const bytes = JSON.stringify(bad); fs.writeFileSync(store.file, bytes);
  // A newer malformed backup cannot hide the most recent valid revision.
  fs.writeFileSync(path.join(store.backupDir, 'revision-000000000009-1999999999999-deadbeef.json'), '{');
  const recovered = new StateStore(dir); assert.equal(recovered.state.event.venue, 'FIRST'); assert.ok(recovered.state.revision > 2);
  assert.match(recovered.state.recovery.message, /damaged/);
  assert.equal(fs.readFileSync(path.join(dir, recovered.state.recovery.preservedFile), 'utf8'), bytes);
  assert.equal(recovered.state.auditLog.at(-1).type, 'startup-recovery');
  assert.equal('recovery' in publicState(recovered.state), false);
  assert.equal(new StateStore(dir).state.revision, recovered.state.revision);
});

test('damaged state with no valid backup fails clearly without replacing the saved tournament', t => {
  const { dir, store } = fixture(t); const bytes = '{ malformed'; fs.writeFileSync(store.file, bytes);
  assert.throws(() => new StateStore(dir), /No valid automatic backup/); assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
});

test('failed official write or failed backup leaves live memory and official state unchanged', t => {
  const { store } = fixture(t); venue(store, 'FIRST'); const before = structuredClone(store.state), bytes = fs.readFileSync(store.file, 'utf8');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === store.file) { const failure = new Error('Fixture disk failure'); failure.code = 'EIO'; throw failure; } return rename(from, to); });
  assert.throws(() => venue(store, 'FAIL'), /Fixture disk failure/); assert.deepEqual(store.state, before); assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
  assert.equal(fs.readdirSync(path.dirname(store.file)).some(name => name.endsWith('.tmp')), false);
  t.mock.restoreAll();
  t.mock.method(store, 'saveBackup', () => { throw new Error('Fixture backup failure'); });
  assert.throws(() => venue(store, 'FAIL'), /Fixture backup failure/); assert.deepEqual(store.state, before); assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
});

test('a damaged selected backup is rejected before touching the current tournament', t => {
  const { store } = fixture(t); venue(store, 'FIRST'); const backup = store.listBackups()[0];
  fs.writeFileSync(path.join(store.backupDir, backup.id), JSON.stringify({ schemaVersion: 1, tournament: { matches: [] } }));
  const before = structuredClone(store.state); assert.throws(() => store.restore(backup.id, 1, 'Referee review'), /damaged/); assert.deepEqual(store.state, before);
});

test('changing the OBS entrant context invalidates a visual check even after switching back; restores also require a new check', t => {
  const { store } = fixture(t);
  const commit = (type, payload) => store.commit({ type, payload }, store.state.revision);
  commit('set-broadcast-sources', { layout: 'qualifier', slots: Array.from({ length: 3 }, (_, index) => ({ capture: `Capture ${index}`, handcam: `Handcam ${index}` })) });
  commit('confirm-broadcast-sources', { signature: sourceStatus(store.state).signature });
  assert.equal(sourceStatus(store.state).confirmed, true);
  venue(store, 'SAME SOURCES'); // Event copy does not change which real feeds must be checked.
  assert.equal(sourceStatus(store.state).confirmed, true);
  const checkedBackup = store.listBackups()[0];
  commit('set-qualifier-display', { group: 'B' });
  commit('set-qualifier-display', { group: 'A', players: ['p1', 'p2', 'p3'] });
  assert.equal(sourceStatus(store.state).confirmed, false);
  store.restore(checkedBackup.id, store.state.revision, 'Verified state snapshot');
  assert.equal(sourceStatus(store.state).confirmed, false);
  commit('confirm-broadcast-sources', { signature: sourceStatus(store.state).signature });
  venue(store, 'AFTER CHECK');
  const invalid = structuredClone(store.state); delete invalid.qualifier;
  fs.writeFileSync(store.file, JSON.stringify(invalid));
  const recovered = new StateStore(path.dirname(store.file));
  assert.equal(sourceStatus(recovered.state).confirmed, false);
});

test('every saved step of a full tournament remains valid, including sealed finals and correction clearing', t => {
  const { dir, store } = fixture(t);
  const commit = (type, payload = {}) => store.commit({ type, payload }, store.state.revision);
  commit('seed-bracket', { ids: store.state.qualifier.players.map(p => p.id) });
  for (const id of store.state.tournament.matches.map(m => m.id)) {
    commit('select-match', { matchId: id });
    if (id === 'GF') {
      commit('set-final-candidates', { matchId: id, ids: store.state.library.slice(0, 8).map(s => s.id) });
      commit('set-final-picks', { matchId: id, audienceIds: ['song-1', 'song-2'], hostId: 'song-3' });
      assert.equal(publicState(store.state).tournament.matches.at(-1).songs[2].hidden, true);
      commit('reveal-host-song', { matchId: id });
    } else {
      commit('draw-candidates', { matchId: id });
      const candidates = store.state.tournament.matches.find(m => m.id === id).candidates;
      commit('ban-song', { matchId: id, playerIndex: 0, songId: candidates[0].id });
      commit('ban-song', { matchId: id, playerIndex: 1, songId: candidates[1].id });
      commit('pick-songs', { matchId: id });
    }
    for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < (id === 'GF' ? 3 : 2); songIndex++) commit('set-match-score', { matchId: id, playerIndex, songIndex, score: playerIndex === 0 ? 990000 : 980000 });
    commit('record-result', { matchId: id });
  }
  assert.equal(new StateStore(dir).state.tournament.matches.filter(m => m.status === 'complete').length, 14);
  const invalid = structuredClone(store.state); const first = invalid.tournament.matches[0];
  [first.winnerId, first.loserId] = [first.loserId, first.winnerId]; assert.throws(() => validateState(invalid), /winner differs from scores/);
  const { resultCorrectionImpact } = require('../lib/tournament'), impact = resultCorrectionImpact(store.state, 'W1');
  commit('reopen-result', { matchId: 'W1', reason: 'Referee verified original card', affectedMatchIds: impact.affectedMatchIds, confirmClear: true });
  assert.equal(new StateStore(dir).state.correctionLog.length, 1);
  assert.equal(publicState(store.state).correctionLog, undefined);
  assert.ok(store.listBackups().length > 100);
});

test('vacancy byes and three-person lottery snapshots have valid dependencies and no phantom loser', t => {
  const { store } = fixture(t);
  store.commit({ type: 'seed-bracket', payload: { ids: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', null] } }, 0);
  store.commit({ type: 'lottery-bye', payload: { matchId: 'W1', playerId: 'p4' } }, 1);
  assert.equal(store.state.tournament.matches[0].resultType, 'draw'); validateState(store.state);
});

test('known legacy empty-final cursor is normalized with an original snapshot and migration audit; new writes remain strict', t => {
  const { dir, store } = fixture(t);
  store.commit({ type: 'seed-bracket', payload: { ids: store.state.qualifier.players.map(p => p.id) } }, 0);
  const legacy = structuredClone(store.state); legacy.tournament.matches.at(-1).currentSong = 2;
  assert.throws(() => validateState(legacy), /currentSong/);
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  const loaded = new StateStore(dir);
  assert.equal(loaded.state.tournament.matches.at(-1).currentSong, 0); assert.equal(loaded.state.revision, 2); assert.equal(loaded.state.recovery, undefined);
  assert.equal(loaded.state.auditLog.at(-1).type, 'legacy-final-cursor-normalized');
  const original = loaded.listBackups().find(backup => backup.revision === 1); assert.ok(original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(loaded.backupDir, original.id), 'utf8')).tournament.matches.at(-1).currentSong, 2);
  assert.equal(loaded.readBackup(original.id).tournament.matches.at(-1).currentSong, 0);
  assert.equal(JSON.parse(fs.readFileSync(loaded.file, 'utf8')).tournament.matches.at(-1).currentSong, 0);
  loaded.restore(original.id, 2, 'Referee reviewed legacy backup'); assert.equal(loaded.state.revision, 3); assert.equal(loaded.state.tournament.matches.at(-1).currentSong, 0);
  const invalid = structuredClone(loaded.state); invalid.tournament.matches.at(-1).currentSong = 3;
  fs.writeFileSync(loaded.file, JSON.stringify(invalid)); const recovered = new StateStore(dir);
  assert.match(recovered.state.recovery.message, /damaged/);
});
