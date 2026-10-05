const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState, rankings, losses } = require('../lib/tournament');
const { StateStore } = require('../lib/store');
function act(state, type, payload = {}) { return applyAction(state, { type, payload }); }
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
