const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS, publicState } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const Q = require('../public/js/qualifier-rules');
const Bracket = require('../public/js/bracket-view');
const { expandSongLibrary } = require('./helpers/song-library');
function act(s, type, payload = {}) {
  const next = structuredClone(s);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(s, next); return s;
}
const m = (s, id = s.tournament.currentMatchId) => s.tournament.matches.find(x => x.id === id);
function seeded(songCount = 12) { const s = expandSongLibrary(createDefaultState(), songCount); act(s, 'seed-bracket', { ids: s.qualifier.players.map(p => p.id), ruleset: 'proposal-2026' }); return s; }
function choose(s, id) {
  act(s, 'select-match', { matchId: id }); act(s, 'draw-candidates');
  for (const playerIndex of [0, 1]) act(s, 'ban-song', { playerIndex, songId: null, confirmed: true });
  act(s, 'pick-songs');
}
function complete(s, id) {
  choose(s, id);
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(s, 'set-match-score', { playerIndex, songIndex, score: 990000 - playerIndex * 1000, judgements: { accuracy: 99 } });
  act(s, 'record-result', { verified: true });
}
const dq = (s, id, note = 'ACA verified this rule violation.') => act(s, 'disqualify-player', { playerId: id, reason: 'rule-violation', note });
const rematch = payload => ({ stage: 'double-elimination', matchId: 'W1', songIndex: 0, reason: 'game-error', videoChecked: false, unintentional: false, allAgree: false, note: 'Private game-error evidence was verified.', ...payload });

test('a qualifier DQ is permanent, leaves evidence private and lets remaining entrants continue', () => {
  const s = createDefaultState(); act(s, 'set-qualifier-plan', { plan: 'A' });
  act(s, 'set-player-readiness', { playerId: 'p1', device: true, globalVersion: true, headphones: true, charts: true, streamConsent: true });
  dq(s, 'p1', 'PRIVATE arbitration evidence: rule violation observed.');
  assert.ok(!Q.entries(s, 'A').some(p => p.id === 'p1'));
  assert.ok(!s.qualifier.activePlayers.includes('p1'));
  act(s, 'set-qualifier-score', { playerId: 'p2', group: 'A', songIndex: 0, score: 990000, judgements: { accuracy: 99 } });
  assert.throws(() => act(s, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 0 }), /eligible/);
  assert.throws(() => act(s, 'seed-bracket', { ids: s.qualifier.players.map(p => p.id), verified: true, note: 'ACA verified the vacant field.' }), /disqualified/);
  const pub = publicState(s); assert.ok(!JSON.stringify(pub).includes('PRIVATE'));
  for (const key of ['readiness', 'waits', 'incidents', 'adjudications']) assert.equal(pub.qualifier[key], undefined);
});
test('legacy roster replacement cannot erase a permanent qualifier disqualification', () => {
  const s = createDefaultState(); dq(s, 'p1');
  assert.throws(() => act(s, 'set-roster', { group: 'A', names: ['New entrant'] }), /locked after a disqualification/);
});

test('a three-person four-player field requires a lottery and its DQ can never enter the losers bracket', () => {
  const s = seeded(); dq(s, 'p1');
  assert.deepEqual(m(s, 'W1').players, [null, 'p8']); assert.equal(m(s, 'W1').status, 'live');
  assert.throws(() => act(s, 'record-bye'), /requires its lottery/);
  act(s, 'lottery-bye', { playerId: 'p4', note: 'ACA draw selected Player 4.' });
  assert.equal(m(s, 'W1').winnerId, 'p4'); assert.equal(m(s, 'W1').loserId, null);
  assert.deepEqual(new Set(m(s, 'W2').players), new Set(['p8', 'p5']));
  for (const id of ['W2', 'W3', 'W4']) complete(s, id);
  assert.ok(s.tournament.matches.filter(x => x.status !== 'complete').every(x => !x.players.includes('p1')));
  assert.equal(publicState(s).tournament.standings.find(x => x.playerId === 'p1').disqualified, true);
});

test('unscored selections are explicitly reviewed before a proposal vacancy lottery clears them', () => {
  const s = seeded(); choose(s, 'W1'); dq(s, 'p1');
  assert.throws(() => act(s, 'lottery-bye', { playerId: 'p4' }), /confirm clearing/);
  act(s, 'lottery-bye', { playerId: 'p4', confirmClear: true, note: 'ACA reviewed clearing the unscored field.' });
  assert.equal(m(s, 'W1').songs.length, 0); assert.equal(m(s, 'W2').songs.length, 0);
});

test('a two-person late-round DQ advances its opponent without leaking long arbiter notes', () => {
  const s = seeded(42); for (const id of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6']) complete(s, id);
  act(s, 'select-match', { matchId: 'W7' }); const [absent, opponent] = m(s).players;
  dq(s, absent, 'PRIVATE: ' + 'Detailed evidence '.repeat(26));
  assert.equal(m(s).resultType, 'forfeit'); assert.equal(m(s).winnerId, opponent); assert.equal(m(s).loserId, absent);
  assert.equal(s.scene, 'result'); assert.ok(m(s).note.length < 240);
  assert.equal(m(s, 'L6').players.includes(absent), false);
  assert.equal(Bracket.destination(publicState(s), m(s), absent).label, 'DQ · DISQUALIFIED');
  assert.ok(!JSON.stringify(publicState(s)).includes('PRIVATE'));
  assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(s))));
});

test('expired waits require explicit DQ and retain exact ten-minute evidence', () => {
  const s = createDefaultState(); act(s, 'set-qualifier-plan', { plan: 'A' });
  act(s, 'start-player-wait', { playerId: 'p1', reason: 'absence' });
  assert.throws(() => act(s, 'disqualify-player', { playerId: 'p1', reason: 'absence' }), /has not ended/);
  const startsAt = Date.now() - 601000;
  s.qualifier.waits.p1 = { reason: 'absence', startsAt: new Date(startsAt).toISOString(), deadline: new Date(startsAt + 600000).toISOString() };
  validateState(s); assert.equal(s.qualifier.players[0].disqualification, undefined);
  act(s, 'disqualify-player', { playerId: 'p1', reason: 'absence' });
  assert.equal(s.qualifier.waits.p1, undefined); assert.equal(s.qualifier.players[0].disqualification.reason, 'absence');
});

test('a match reset cannot erase its rematch allowance, and private incident data never reaches OBS', () => {
  const s = seeded(); choose(s, 'W1'); act(s, 'authorize-song-rematch', rematch());
  const oldSong = m(s).rematches[0].songId;
  act(s, 'reset-current-match');
  assert.equal(m(s).rematches.length, 1);
  choose(s, 'W1'); assert.throws(() => act(s, 'authorize-song-rematch', rematch()), /already been used/);
  const pub = publicState(s); assert.equal(m(pub).rematches, undefined);
  assert.equal(pub.qualifier.adjudications, undefined); assert.ok(!JSON.stringify(pub).includes('Private game-error'));
  const damaged = structuredClone(s); m(damaged).rematches.push({ ...m(damaged).rematches[0] });
  assert.throws(() => validateState(damaged), /rematches/); assert.ok(oldSong);
});

test('a DE tiebreak replay clears only its extra-song results and keeps the original match total', () => {
  const s = seeded(); choose(s, 'W1');
  for (const pi of [0,1]) for (const si of [0,1]) act(s, 'set-match-score', { playerIndex: pi, songIndex: si, score: 990000, judgements: { accuracy: 99 } });
  act(s, 'draw-match-tiebreak');
  for (const pi of [0,1]) act(s, 'set-match-tiebreak-score', { index: 0, playerIndex: pi, score: 980000, judgements: { accuracy: 98 } });
  const base = structuredClone(m(s).scores);
  act(s, 'authorize-song-rematch', rematch({ tiebreakIndex: 0 }));
  assert.deepEqual(m(s).scores, base); assert.deepEqual(m(s).tiebreaks[0].scores, [null, null]);
  assert.deepEqual(m(s).tiebreaks[0].judgements, [null, null]);
  assert.throws(() => act(s, 'authorize-song-rematch', rematch({ tiebreakIndex: 0 })), /already been used/);
  assert.equal(m(s).rematches[0].tiebreakIndex, 0);
  for (const pi of [0,1]) act(s, 'set-match-tiebreak-score', { index: 0, playerIndex: pi, score: 990000 - pi, judgements: { accuracy: 99 } });
  act(s, 'confirm-match-tiebreak', { index: 0, verified: true });
  assert.throws(() => act(s, 'authorize-song-rematch', rematch({ tiebreakIndex: 0 })), /unconfirmed/);
  act(s, 'record-result', { verified: true }); assert.equal(m(s).winnerId, 'p1');
});

test('a qualifier tiebreak replay preserves base results and the other entrant score', () => {
  const s = createDefaultState(); act(s, 'set-qualifier-plan', { plan: 'A' });
  for (let n=1; n<=8; n++) for (let si=0; si<3; si++) act(s, 'set-qualifier-score', {
    group: 'A', playerId: `p${n}`, songIndex: si, score: 1000000 - (n===5 ? 4 : n)*1000, judgements: { accuracy: 99 }
  });
  act(s, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4','p5'] });
  for (const id of ['p4','p5']) act(s, 'set-qualifier-tiebreak-score', { group: 'A', playerId: id, index: 0, score: 990000, judgements: { accuracy: 99 } });
  const before=structuredClone(s.qualifier.rounds.A.results);
  const p=rematch({ stage: 'qualifier', group: 'A', playerId: 'p4', tiebreakIndex: 0 });
  delete p.matchId; act(s, 'authorize-song-rematch', p);
  assert.deepEqual(s.qualifier.rounds.A.results,before);
  assert.equal(s.qualifier.rounds.A.tiebreaks[0].scores.p4,null);
  assert.equal(s.qualifier.rounds.A.tiebreaks[0].scores.p5,990000);
  assert.throws(()=>act(s,'authorize-song-rematch',p),/already.*used/);
});

test('both competitors disqualified leave a vacant field for an explicit ACA decision', () => {
 const s=seeded();dq(s,'p1');dq(s,'p8');
 assert.equal(m(s).status,'live');assert.deepEqual(m(s).players,[null,null]);
 assert.equal(m(s).resultType,null);
 assert.throws(()=>act(s,'record-bye'),/ACA decision/);
 act(s,'record-bye',{note:'ACA reviewed this completely vacant field.'});
 assert.equal(m(s).winnerId,null);assert.equal(m(s).loserId,null);
});
