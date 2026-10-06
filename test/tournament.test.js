const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState, rankings, losses, CURRENT_MATCH_ACTIONS, resultCorrectionImpact } = require('../lib/tournament');
const { StateStore } = require('../lib/store');
function act(state, type, payload = {}) {
  return applyAction(state, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: state.tournament.currentMatchId, ...payload } : payload });
}
function seeded(ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) { return act(createDefaultState(), 'seed-bracket', { ids }); }
function chooseSongs(s, m) {
  if (m.id === 'GF') {
    act(s, 'set-final-candidates', { ids: s.library.slice(0, 8).map(x => x.id) });
    act(s, 'set-final-picks', { audienceIds: ['song-1', 'song-2'], hostId: 'song-3' });
    act(s, 'reveal-host-song');
  } else {
    act(s, 'draw-candidates');
    act(s, 'ban-song', { playerIndex: 0, songId: m.candidates[0].id });
    act(s, 'ban-song', { playerIndex: 1, songId: m.candidates[1].id });
    act(s, 'pick-songs');
  }
}
function complete(s, id, side = 0) {
  act(s, 'select-match', { matchId: id }); const m = s.tournament.matches.find(x => x.id === id);
  chooseSongs(s, m);
  m.scores.forEach((row, pi) => row.forEach((_, si) => act(s, 'set-match-score', { playerIndex: pi, songIndex: si, score: pi === side ? 980000 : 970000 })));
  act(s, 'record-result'); return m;
}
test('shared start and result scenes preserve qualifier rankings or double-elimination results', () => {
  const qualifiers = createDefaultState();
  act(qualifiers, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 990000 });
  for (const scene of ['result', 'start', 'result']) {
    act(qualifiers, 'set-scene', { scene });
    assert.equal(qualifiers.stage, 'qualifier');
    assert.equal(rankings(qualifiers, 'A')[0].total, 990000);
  }
  const elimination = seeded(); complete(elimination, 'W1');
  const result = structuredClone(elimination.result);
  for (const scene of ['start', 'result']) {
    act(elimination, 'set-scene', { scene });
    assert.equal(elimination.stage, 'double-elimination');
    assert.deepEqual(elimination.result, result);
  }
});
test('stage-specific match, waiting, bracket and selection scenes switch stages explicitly', () => {
  const s = createDefaultState();
  for (const scene of ['double-elimination-match', 'double-elimination-waiting', 'bracket', 'song-selection']) {
    act(s, 'set-stage', { stage: 'qualifier' });
    act(s, 'set-scene', { scene });
    assert.equal(s.stage, 'double-elimination', scene);
  }
  for (const scene of ['qualifier-match', 'qualifier-waiting']) {
    act(s, 'set-stage', { stage: 'double-elimination' });
    act(s, 'set-scene', { scene });
    assert.equal(s.stage, 'qualifier', scene);
  }
});
test('qualifiers rank full three-song totals, resolve ties, and alternate group seeds', () => {
  const s = createDefaultState();
  s.qualifier.players.forEach((p, i) => p.scores.forEach((_, songIndex) => act(s, 'set-qualifier-score', { playerId: p.id, songIndex, score: 990000 - (i % 4) * 1000 })));
  assert.equal(rankings(s, 'A')[0].total, 2970000);
  act(s, 'qualify'); assert.deepEqual(s.tournament.seeds, ['p1', 'p5', 'p2', 'p6', 'p3', 'p7', 'p4', 'p8']);
  assert.equal(s.tournament.matches.length, 14);
  assert.throws(() => act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 0 }), /locked/);
  const tied = createDefaultState(); tied.qualifier.players.forEach(p => { p.scores = [0, 0, 0]; });
  assert.throws(() => act(tied, 'qualify'), /tied/);
  tied.qualifier.players.forEach((p, i) => act(tied, 'set-tie-priority', { playerId: p.id, priority: i % 4 + 1 }));
  act(tied, 'qualify'); assert.equal(tied.tournament.seeded, true);
});
test('missing scores differ from zero; invalid scores and overlapping group songs are rejected', () => {
  const s = createDefaultState();
  assert.throws(() => act(s, 'qualify'), /All group scores/);
  for (const value of [-1, 1000001, 1.5, '999999']) assert.throws(() => act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: value }), /integers/);
  act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 0 }); assert.equal(s.qualifier.players[0].scores[0], 0);
  assert.throws(() => act(s, 'set-qualifier-songs', { group: 'B', ids: s.qualifier.groups.A.songs }), /different songs/);
});
test('regular selection draws six unique candidates, distinct bans and two remaining songs', () => {
  const s = seeded(), m = s.tournament.matches[0];
  act(s, 'draw-candidates'); assert.equal(new Set(m.candidates.map(x => x.id)).size, 6);
  assert.throws(() => act(s, 'pick-songs'), /Both players/);
  act(s, 'ban-song', { playerIndex: 0, songId: m.candidates[0].id });
  assert.throws(() => act(s, 'ban-song', { playerIndex: 1, songId: m.candidates[0].id }), /already banned/);
  act(s, 'ban-song', { playerIndex: 1, songId: m.candidates[1].id }); act(s, 'pick-songs');
  assert.equal(m.songs.length, 2); assert.equal(new Set(m.songs.map(x => x.id)).size, 2);
  assert.ok(m.songs.every(song => !m.bans.includes(song.id)));
  assert.throws(() => act(s, 'ban-song', { playerIndex: 0, songId: null }), /locked/);
  act(s, 'set-match-score', { playerIndex: 0, songIndex: 0, score: 999999 });
  assert.throws(() => act(s, 'draw-candidates'), /Reset/);
  act(s, 'reset-current-match'); assert.equal(m.songs.length, 0); assert.deepEqual(m.scores, [[null, null], [null, null]]);
});
test('all fourteen matches advance the correct winner and loser paths, with podium placements', () => {
  const s = seeded();
  assert.deepEqual(s.tournament.matches.slice(0, 4).map(m => m.players), [['p1', 'p8'], ['p4', 'p5'], ['p2', 'p7'], ['p3', 'p6']]);
  assert.throws(() => act(s, 'select-match', { matchId: 'GF' }), /ready match/);
  for (const m of s.tournament.matches) complete(s, m.id);
  assert.equal(s.tournament.matches.filter(m => m.status === 'complete').length, 14);
  const get = id => s.tournament.matches.find(m => m.id === id);
  assert.deepEqual(get('L3').players, ['p8', 'p3']); assert.deepEqual(get('L4').players, ['p7', 'p4']);
  assert.deepEqual(get('L6').players, ['p8', 'p2']); assert.deepEqual(get('GF').players, ['p1', 'p8']);
  assert.equal(get('GF').winnerId, 'p1'); assert.equal(losses(s, 'p1'), 0);
  assert.ok(s.tournament.seeds.filter(id => id !== 'p1').every(id => losses(s, id) === 2));
  assert.equal(publicState(s).tournament.standings.find(p => p.playerId === 'p2').placement, 'Third place');
  assert.deepEqual(s.result.placements, { p1: 'Champion', p8: 'First Runner-up' });
  assert.throws(() => act(s, 'reset-current-match'), /locked/);
});
test('fourteen-match final is decisive even when the winners-bracket champion loses their first match', () => {
  const s = seeded(); for (const m of s.tournament.matches) complete(s, m.id, m.id === 'GF' ? 1 : 0);
  assert.equal(s.tournament.matches.length, 14); assert.equal(s.result.placements.p8, 'Champion');
  assert.equal(s.result.placements.p1, 'First Runner-up'); assert.equal(losses(s, 'p1'), 1);
  assert.equal(publicState(s).tournament.standings.find(p => p.playerId === 'p1').eliminated, false);
});
test('final MC choice is private until reveal and final requires three songs', () => {
  const s = seeded(); for (const m of s.tournament.matches.filter(x => x.id !== 'GF')) complete(s, m.id);
  act(s, 'select-match', { matchId: 'GF' });
  act(s, 'upsert-song', { song: { title: 'Finals exclusive', artist: 'Guest', difficulty: 'AT', level: 17, eligible: false } });
  const outside = s.library.at(-1); const ids = [...s.library.slice(0, 7).map(s => s.id), outside.id];
  act(s, 'set-final-candidates', { ids }); act(s, 'set-final-picks', { audienceIds: ['song-1', 'song-2'], hostId: outside.id });
  const gf = s.tournament.matches.at(-1), redacted = publicState(s).tournament.matches.at(-1);
  assert.equal(gf.hostPick.title, 'Finals exclusive'); assert.equal('hostPick' in redacted, false);
  assert.equal(redacted.songs[2].hidden, true); assert.equal(redacted.songs[2].title, 'MC PICK — SEALED');
  assert.throws(() => act(s, 'set-song-progress', { index: 2 }), /Reveal/);
  assert.throws(() => act(s, 'set-match-score', { playerIndex: 0, songIndex: 2, score: 999999 }), /Reveal/);
  assert.throws(() => act(s, 'record-result'), /every song score/);
  act(s, 'reveal-host-song'); assert.equal(publicState(s).tournament.matches.at(-1).songs[2].title, 'Finals exclusive');
  gf.scores.forEach((row, pi) => row.forEach((_, si) => act(s, 'set-match-score', { playerIndex: pi, songIndex: si, score: pi === 0 ? 990000 : 980000 })));
  act(s, 'record-result'); assert.equal(s.result.totals[0], 2970000);
});
test('ties require adjudication and incomplete scores cannot accidentally become a result', () => {
  const s = seeded(), m = s.tournament.matches[0]; chooseSongs(s, m);
  act(s, 'set-match-score', { playerIndex: 0, songIndex: 0, score: 0 });
  assert.throws(() => act(s, 'record-result'), /every song/);
  m.scores.forEach((row, pi) => row.forEach((_, si) => act(s, 'set-match-score', { playerIndex: pi, songIndex: si, score: 0 })));
  assert.throws(() => act(s, 'record-result'), /adjudication/);
  act(s, 'record-result', { tieWinnerId: 'p8', note: 'Referee-approved tie-break' }); assert.equal(m.winnerId, 'p8');
});
test('byes and four-player lotteries preserve remaining players and have no phantom loser', () => {
  const s = seeded(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', null]);
  act(s, 'lottery-bye', { playerId: 'p4', note: 'Recorded live draw' });
  assert.equal(s.tournament.matches[0].winnerId, 'p4'); assert.equal(s.tournament.matches[0].loserId, null);
  assert.deepEqual(s.tournament.matches[1].players, ['p1', 'p5']); assert.equal(s.tournament.drawLog[0].winnerId, 'p4');
  assert.equal(losses(s, null), 0); assert.equal(losses(s, 'p4'), 0);
  const simple = seeded(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', null]);
  act(simple, 'record-bye', { note: 'Absent entrant' }); assert.equal(simple.tournament.matches[0].winnerId, 'p1');
  act(simple, 'select-match', { matchId: 'W2' }); assert.throws(() => act(simple, 'record-bye'), /vacant/);
});
test('random grouping is balanced and cannot replace already scored groups', () => {
  const s = createDefaultState(); act(s, 'randomise-groups');
  assert.equal(s.qualifier.players.filter(p => p.group === 'A').length, 4); assert.equal(s.qualifier.players.filter(p => p.group === 'B').length, 4);
  assert.equal(new Set(s.qualifier.players.map(p => p.id)).size, 8);
  act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 1 }); assert.throws(() => act(s, 'randomise-groups'), /before scoring/);
});
test('store persists valid commands, rejects stale writes, and does not save failed mutations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-store-'));
  try {
    const store = new StateStore(dir); store.commit({ type: 'set-event', payload: { venue: 'TEST VENUE' } }, 0);
    assert.equal(new StateStore(dir).state.event.venue, 'TEST VENUE');
    assert.throws(() => store.commit({ type: 'set-scene', payload: { scene: 'result' } }, 0), error => error.code === 'STALE');
    const before = fs.readFileSync(store.file, 'utf8');
    assert.throws(() => store.commit({ type: 'set-event', payload: { title: '' } }, 1), /required/);
    assert.equal(fs.readFileSync(store.file, 'utf8'), before); assert.equal(store.state.revision, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('all current-match actions identify their original match after selecting another match', () => {
  const s = seeded();
  for (const type of CURRENT_MATCH_ACTIONS) {
    assert.throws(() => applyAction(s, { type, payload: {} }), error => error.code === 'MATCH_CHANGED', type);
    assert.throws(() => applyAction(s, { type, payload: { matchId: 'W2' } }), error => error.code === 'MATCH_CHANGED', type);
  }
  act(s, 'select-match', { matchId: 'W2' });
  const before = structuredClone(s);
  assert.throws(() => act(s, 'draw-candidates', { matchId: 'W1' }), error => error.code === 'MATCH_CHANGED');
  assert.deepEqual(s, before);
  act(s, 'draw-candidates'); assert.equal(s.tournament.matches.find(m => m.id === 'W2').candidates.length, 6);
});
test('a fresh revision cannot authorize a queued command from the previously selected match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-match-binding-'));
  try {
    const store = new StateStore(dir);
    store.commit({ type: 'seed-bracket', payload: { ids: store.state.qualifier.players.map(p => p.id) } }, 0);
    store.commit({ type: 'select-match', payload: { matchId: 'W2' } }, 1);
    const before = fs.readFileSync(store.file, 'utf8');
    assert.throws(() => store.commit({ type: 'draw-candidates', payload: { matchId: 'W1' } }, 2), error => error.code === 'MATCH_CHANGED');
    assert.equal(fs.readFileSync(store.file, 'utf8'), before); assert.equal(store.state.revision, 2);
    assert.equal(store.state.tournament.matches.find(m => m.id === 'W2').candidates.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('vacancy lotteries run before either entry match starts selection', () => {
  const s = seeded(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', null]);
  act(s, 'select-match', { matchId: 'W2' }); chooseSongs(s, s.tournament.matches[1]);
  act(s, 'select-match', { matchId: 'W1' }); const before = structuredClone(s);
  assert.throws(() => act(s, 'lottery-bye', { playerId: 'p4' }), /before drawing candidates/);
  assert.deepEqual(s, before);
  act(s, 'select-match', { matchId: 'W2' }); act(s, 'reset-current-match');
  act(s, 'select-match', { matchId: 'W1' }); act(s, 'lottery-bye', { playerId: 'p4' });
  assert.deepEqual(s.tournament.matches[1].players, ['p1', 'p5']); assert.equal(s.tournament.matches[1].songs.length, 0);
});
test('scored qualifier charts keep their identity while artwork and future eligibility remain editable', () => {
  const s = createDefaultState(); delete s.correctionLog;
  act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 0 });
  const song = s.library[0];
  for (const change of [{ title: 'Replacement chart' }, { artist: 'Other artist' }, { difficulty: 'AT' }, { level: 20 }]) {
    assert.throws(() => act(s, 'upsert-song', { song: { ...song, ...change } }), /metadata is locked/);
  }
  act(s, 'upsert-song', { song: { ...song, art: 'assets/song/actual-chart.webp', eligible: false } });
  assert.equal(s.library[0].title, song.title); assert.equal(s.qualifier.players[0].scores[0], 0);
  assert.equal(s.library[0].art, 'assets/song/actual-chart.webp'); assert.equal(s.library[0].eligible, false);
  act(s, 'upsert-song', { song: { ...s.library[1], title: 'Unscored Group B chart' } });
  assert.equal(s.library[1].title, 'Unscored Group B chart');
});
test('stable player renaming preserves scores, group, displayed slots, seeds and recorded results', () => {
  const s = createDefaultState(); act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 999999 });
  act(s, 'seed-bracket', { ids: s.qualifier.players.map(p => p.id) }); complete(s, 'W1');
  const before = structuredClone(s), player = s.qualifier.players.find(p => p.id === 'p1');
  act(s, 'rename-player', { playerId: 'p1', name: 'Corrected player' });
  assert.equal(player.name, 'Corrected player'); assert.equal(player.group, 'A'); assert.equal(player.scores[0], 999999);
  assert.deepEqual(s.qualifier.activePlayers, before.qualifier.activePlayers);
  assert.deepEqual(s.tournament, before.tournament); assert.deepEqual(s.result, before.result);
  assert.throws(() => act(s, 'rename-player', { playerId: 'p1', name: 'Player 02' }), /unique/);
  assert.throws(() => act(s, 'rename-player', { playerId: 'p1', name: '  ' }), /required/);
});
test('bulk roster replacement cannot silently remove or rename a scored player', () => {
  const s = createDefaultState(); act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 999999 });
  const before = structuredClone(s);
  assert.throws(() => act(s, 'set-roster', { group: 'A', names: ['Corrected Player 01', 'Player 02', 'Player 03', 'Player 04'] }), /Rename player/);
  assert.deepEqual(s, before);
  act(s, 'set-roster', { group: 'A', names: ['Player 01', 'New unscored player'] });
  assert.equal(s.qualifier.players.find(p => p.id === 'p1').scores[0], 999999);
  assert.equal(s.qualifier.players.filter(p => p.group === 'A').length, 2);
});
test('correction preview is read-only and includes every logical winner and loser descendant', () => {
  const s = seeded(); complete(s, 'W1'); const before = structuredClone(s);
  const impact = resultCorrectionImpact(s, 'W1');
  assert.deepEqual(impact.affectedMatchIds, ['W5', 'L1', 'W7', 'L3', 'L4', 'L5', 'L6', 'GF']);
  assert.equal(impact.requiresConfirmation, false); assert.equal(impact.blockedReason, null); assert.deepEqual(s, before);
  assert.throws(() => resultCorrectionImpact(s), /Choose/);
});
test('correction clears scored descendants after an explicit, current preview and preserves independent results', () => {
  const s = seeded(); ['W1', 'W2', 'W3', 'W4', 'W5'].forEach(id => complete(s, id));
  act(s, 'select-match', { matchId: 'L1' }); chooseSongs(s, s.tournament.matches.find(m => m.id === 'L1'));
  act(s, 'set-match-score', { playerIndex: 0, songIndex: 0, score: 990000 });
  const impact = resultCorrectionImpact(s, 'W1'), before = structuredClone(s), target = s.tournament.matches[0];
  assert.equal(impact.requiresConfirmation, true);
  for (const payload of [{ reason: '', affectedMatchIds: impact.affectedMatchIds, confirmClear: true },
    { reason: 'Score transcribed incorrectly', affectedMatchIds: [] },
    { reason: 'Score transcribed incorrectly', affectedMatchIds: [...impact.affectedMatchIds, 'W5'], confirmClear: true },
    { reason: 'Score transcribed incorrectly', affectedMatchIds: impact.affectedMatchIds }]) {
    assert.throws(() => act(s, 'reopen-result', { matchId: 'W1', ...payload })); assert.deepEqual(s, before);
  }
  act(s, 'reopen-result', { matchId: 'W1', reason: 'Score transcribed incorrectly', affectedMatchIds: impact.affectedMatchIds, confirmClear: true });
  assert.equal(target.status, 'live'); assert.deepEqual(target.songs, before.tournament.matches[0].songs);
  assert.deepEqual(target.scores, before.tournament.matches[0].scores); assert.equal(target.winnerId, null); assert.equal(s.result, null);
  for (const m of s.tournament.matches.filter(m => impact.affectedMatchIds.includes(m.id))) {
    assert.deepEqual(m.scores, [Array(m.id === 'GF' ? 3 : 2).fill(null), Array(m.id === 'GF' ? 3 : 2).fill(null)]);
    assert.equal(m.songs.length, 0); assert.equal(m.candidates.length, 0); assert.equal(m.winnerId, null); assert.equal(m.loserId, null);
  }
  for (const id of ['W2', 'W3', 'W4']) assert.deepEqual(s.tournament.matches.find(m => m.id === id), before.tournament.matches.find(m => m.id === id));
  for (let songIndex = 0; songIndex < 2; songIndex++) act(s, 'set-match-score', { playerIndex: 1, songIndex, score: 999999 });
  act(s, 'record-result'); assert.equal(target.winnerId, 'p8');
  assert.deepEqual(s.tournament.matches.find(m => m.id === 'W5').players, ['p8', 'p4']);
  for (const m of s.tournament.matches) if (m.status !== 'complete') complete(s, m.id);
  assert.equal(s.result.placements.p8, 'Champion'); assert.equal(s.tournament.matches.filter(m => m.status === 'complete').length, 14);
});
test('correcting an upstream result invalidates both lottery matches and rejects a pre-lottery impact list', () => {
  const s = seeded(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', null]);
  act(s, 'record-bye'); ['W2', 'W3', 'W4'].forEach(id => complete(s, id));
  const oldImpact = resultCorrectionImpact(s, 'W2');
  act(s, 'select-match', { matchId: 'L1' }); act(s, 'lottery-bye', { playerId: 'p7' });
  act(s, 'select-match', { matchId: 'L2' }); chooseSongs(s, s.tournament.matches.find(m => m.id === 'L2'));
  act(s, 'set-match-score', { playerIndex: 0, songIndex: 0, score: 999999 });
  const impact = resultCorrectionImpact(s, 'W2'), before = structuredClone(s);
  assert.ok(!oldImpact.affectedMatchIds.includes('L2') && impact.affectedMatchIds.includes('L2'));
  assert.throws(() => act(s, 'reopen-result', { matchId: 'W2', reason: 'Changed referee result', affectedMatchIds: oldImpact.affectedMatchIds, confirmClear: true }), /affected match list changed/);
  assert.deepEqual(s, before);
  act(s, 'reopen-result', { matchId: 'W2', reason: 'Changed referee result', affectedMatchIds: impact.affectedMatchIds, confirmClear: true });
  for (const id of ['L1', 'L2']) {
    const m = s.tournament.matches.find(m => m.id === id); assert.equal(m.overridePlayers, null); assert.equal(m.songs.length, 0);
    assert.deepEqual(m.scores, [[null, null], [null, null]]); assert.equal(m.resultType, null);
  }
  assert.equal(s.tournament.drawLog.length, 0); assert.equal(s.correctionLog[0].removedDrawLog.length, 1);
});
test('lottery roots cannot be reopened by a single-match correction', () => {
  const s = seeded(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', null]); act(s, 'lottery-bye', { playerId: 'p4' });
  complete(s, 'W2');
  for (const id of ['W1', 'W2']) {
    const impact = resultCorrectionImpact(s, id), before = structuredClone(s); assert.match(impact.blockedReason, /vacancy lottery/);
    assert.throws(() => act(s, 'reopen-result', { matchId: id, reason: 'Changed result', affectedMatchIds: impact.affectedMatchIds, confirmClear: true }), /vacancy lottery/);
    assert.deepEqual(s, before);
  }
});
test('reopening a final preserves all three songs and scores while removing the old podium', () => {
  const s = seeded(); for (const m of s.tournament.matches) complete(s, m.id);
  const original = structuredClone(s.tournament.matches.at(-1));
  act(s, 'reopen-result', { matchId: 'GF', reason: 'Final score correction', affectedMatchIds: [] });
  const gf = s.tournament.matches.at(-1);
  assert.deepEqual(gf.songs, original.songs); assert.deepEqual(gf.scores, original.scores);
  assert.deepEqual(gf.hostPick, original.hostPick); assert.equal(gf.hostRevealed, true); assert.equal(s.result, null);
  assert.ok(publicState(s).tournament.standings.every(p => p.placement !== 'Champion'));
  for (let songIndex = 0; songIndex < 3; songIndex++) act(s, 'set-match-score', { playerIndex: 1, songIndex, score: 999999 });
  act(s, 'record-result'); assert.equal(s.result.placements.p8, 'Champion');
});
test('old states can be corrected and public broadcasts contain no audit, recovery or source-check details', () => {
  const s = seeded(); complete(s, 'W1'); delete s.correctionLog;
  act(s, 'reopen-result', { matchId: 'W1', reason: 'Private correction reason', affectedMatchIds: resultCorrectionImpact(s, 'W1').affectedMatchIds });
  s.auditLog = [{ reason: 'Private audit note' }]; s.recovery = { preservedFile: '/private/recovery-file' };
  s.broadcast = { showHandcams: true, sourceSlots: { private: true }, sourceCheck: { reason: 'Source operator' }, sourceStatus: { private: true } };
  const publicCopy = publicState(s);
  for (const key of ['auditLog', 'correctionLog', 'recovery']) assert.equal(key in publicCopy, false);
  assert.deepEqual(publicCopy.broadcast, { showHandcams: true }); assert.equal(s.correctionLog[0].reason, 'Private correction reason');
});
test('bracket source objects are isolated from other brackets and the shared definitions', () => {
  const a = seeded(), b = seeded(); a.tournament.matches[0].sources[0].value = 99;
  assert.equal(b.tournament.matches[0].sources[0].value, 1); assert.equal(seeded().tournament.matches[0].sources[0].value, 1);
});
test('redrawing final candidates after viewing song three resets the empty-song cursor and persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-final-redraw-'));
  try {
    const fixture = seeded(); for (const m of fixture.tournament.matches.filter(m => m.id !== 'GF')) complete(fixture, m.id);
    act(fixture, 'select-match', { matchId: 'GF' });
    const store = new StateStore(dir); store.write(fixture); store.state = fixture;
    const commit = (type, payload = {}) => store.commit({ type, payload: { matchId: 'GF', ...payload } }, store.state.revision);
    commit('set-final-candidates', { ids: store.state.library.slice(0, 8).map(song => song.id) });
    commit('set-final-picks', { audienceIds: ['song-1', 'song-2'], hostId: 'song-3' });
    commit('reveal-host-song'); commit('set-song-progress', { index: 2 });
    commit('set-final-candidates', { ids: store.state.library.slice(1, 9).map(song => song.id) });
    const reloaded = new StateStore(dir).state.tournament.matches.at(-1);
    assert.equal(reloaded.currentSong, 0); assert.equal(reloaded.songs.length, 0);
    assert.equal(reloaded.hostPick, null); assert.equal(reloaded.hostRevealed, false); assert.equal(reloaded.candidates.length, 8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
