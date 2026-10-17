'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CompetitionConfig = require('../public/js/competition-config');
const SongPool = require('../public/js/song-pool');
const Draw = require('../lib/difficulty-draw');

const IDS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'L1', 'L2', 'W7', 'L3', 'L4', 'L5', 'L6'];
const ROUNDS = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 5];
const constant = CompetitionConfig.chartConstant;
const band = song => constant(song) <= 16.5 ? 0 : constant(song) <= 16.8 ? 1 : 2;
const quota = songs => [0, 1, 2].map(tier => songs.filter(song => band(song) === tier).length);
function state() {
  return { event: { competitionVersion: CompetitionConfig.VERSION }, library: CompetitionConfig.library(),
    tournament: { matches: IDS.map((id, index) => ({ id, round: ROUNDS[index], status: 'pending', songs: [], tiebreaks: [] })) } };
}
function rng(seed) {
  return upper => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 4294967296 * upper);
  };
}
function limits(round, songs) {
  assert.equal(songs.length, 6); assert.equal(SongPool.distinct(songs).length, 6);
  const [low, , high] = quota(songs);
  if (round === 1) { assert.ok(low >= 3); assert.ok(high <= 1); }
  if (round === 2) { assert.ok(low >= 1); assert.ok(high <= 2); }
  if (round === 3) assert.ok(low <= 1);
  if (round === 4) { assert.equal(low, 0); assert.ok(high >= 3); }
  if (round === 5) assert.equal(high, 6);
}
function complete(event, match, songs) {
  match.songs = songs.map(song => ({ ...song })); match.status = 'complete';
}
function runTournament(seed, policy = 'random', order = IDS) {
  const event = state(), random = rng(seed), played = [], means = [[], [], [], [], []];
  for (const id of order) {
    const match = event.tournament.matches.find(value => value.id === id), before = structuredClone(event);
    const candidates = Draw.draw(event, match, random);
    assert.deepEqual(event, before, 'drawing must be read-only');
    limits(match.round, candidates); assert.equal(Draw.validateCandidates(event, match, candidates), true);
    means[match.round - 1].push(candidates.reduce((total, song) => total + constant(song), 0) / 6);
    assert.ok(candidates.every(song => played.every(previous => !SongPool.sameSong(song, previous))));
    // Either adversarial pair is reachable after banning two of the other four
    // candidates. The safety proof must allow both, not assume a typical pick.
    const sorted = [...candidates].sort((left, right) => constant(left) - constant(right));
    const songs = policy === 'hardest' ? sorted.slice(-2) : policy === 'easiest' ? sorted.slice(0, 2) :
      [candidates.splice(random(candidates.length), 1)[0], candidates.splice(random(candidates.length), 1)[0]];
    complete(event, match, songs); played.push(...songs);
    assert.equal(Draw.assertFutureFeasible(event), true);
  }
  assert.equal(SongPool.distinct(played).length, 26);
  return means.map(values => values.reduce((total, value) => total + value, 0) / values.length);
}

test('official chart pool supports complete gradient tournaments against random and adversarial picks', () => {
  const observed = [0, 0, 0, 0, 0];
  for (let seed = 1; seed <= 20; seed++) {
    const means = runTournament(seed);
    means.forEach((value, index) => { observed[index] += value / 20; });
    if (seed <= 5) { runTournament(seed, 'hardest'); runTournament(seed, 'easiest'); }
  }
  for (let index = 1; index < observed.length; index++)
    assert.ok(observed[index] > observed[index - 1] + 0.08, `Expected rising round means: ${observed}`);
});

test('Winners R3 can precede remaining Losers R2 without losing later draw feasibility', () => {
  runTournament(357, 'hardest', ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
});

test('same-match historical songs remain drawable without subtracting future global stock again', () => {
  const event = state(), current = event.tournament.matches.find(match => match.id === 'L5');
  const mids = event.library.filter(song => band(song) === 1).slice(0, 3);
  const highs = event.library.filter(song => band(song) === 2).slice(0, 9);
  event.library = [...mids, ...highs]; current.usedSongs = [...mids, ...highs.slice(0, 3)].map(song => ({ ...song }));
  event.tournament.matches = [current, event.tournament.matches.find(match => match.id === 'L6')];
  assert.equal(SongPool.available(event, null, { eligibleOnly: true }).length, 6);
  const candidates = Draw.draw(event, current, rng(5));
  assert.deepEqual(quota(candidates), [0, 3, 3]);
  assert.ok(candidates.every(song => current.usedSongs.some(previous => SongPool.sameSong(song, previous))));
  assert.equal(Draw.validateCandidates(event, current, candidates), true);
  complete(event, current, candidates.filter(song => band(song) === 2).slice(0, 2));
  const final = event.tournament.matches[1];
  limits(5, Draw.draw(event, final, rng(6)));
});

test('future historical reservations can provide their owner six candidates', () => {
  const event = state(), current = event.tournament.matches.find(match => match.id === 'L5');
  const final = event.tournament.matches.find(match => match.id === 'L6');
  const mids = event.library.filter(song => band(song) === 1).slice(0, 3);
  const highs = event.library.filter(song => band(song) === 2).slice(0, 9);
  event.library = [...mids, ...highs]; event.tournament.matches = [current, final];
  current.usedSongs = [...mids, ...highs.slice(0, 3)]; final.usedSongs = highs.slice(3, 7);
  assert.equal(SongPool.available(event, null, { eligibleOnly: true }).length, 2);
  const candidates = Draw.draw(event, current, rng(8));
  assert.equal(Draw.validateCandidates(event, current, candidates), true);
  complete(event, current, candidates.slice(0, 2));
  limits(5, Draw.draw(event, final, rng(9)));
});

test('R5 never silently falls back to low or middle charts when high stock is depleted', () => {
  const event = state(), final = event.tournament.matches.find(match => match.id === 'L6');
  event.tournament.matches = [final];
  const highs = event.library.filter(song => song.eligible && band(song) === 2).slice(0, 5);
  event.library = [...event.library.filter(song => song.eligible && band(song) !== 2), ...highs];
  const before = structuredClone(event);
  assert.throws(() => Draw.draw(event, final, rng(3)), /No safe difficulty-gradient/);
  assert.throws(() => Draw.assertFutureFeasible(event), /R5 must retain six songs at 16.9/);
  assert.deepEqual(event, before);
});

test('candidate recheck rejects old low R5 draws and updated library constants', () => {
  const event = state(), final = event.tournament.matches.find(match => match.id === 'L6');
  event.tournament.matches = [final];
  const oldCandidates = event.library.filter(song => song.eligible && band(song) === 0).slice(0, 6);
  assert.throws(() => Draw.validateCandidates(event, final, oldCandidates), /do not meet R5 limits/);
  const candidates = structuredClone(Draw.draw(event, final, rng(20)));
  const live = event.library.find(song => song.id === candidates[0].id);
  live.constant = 16.8; live.level = 16;
  assert.throws(() => Draw.validateCandidates(event, final, candidates), /candidate chart metadata has changed/);
});

test('candidate chart identity edits require redrawing even within a tier, while artwork edits remain valid', () => {
  const event = state(), final = event.tournament.matches.find(match => match.id === 'L6');
  event.tournament.matches = [final];
  const candidates = structuredClone(Draw.draw(event, final, rng(28)));
  const live = event.library.find(song => song.id === candidates[0].id), original = { ...live };
  live.art = 'assets/replacement.png'; live.previewAudio = 'assets/replacement.mp3';
  assert.equal(Draw.validateCandidates(event, final, candidates), true);
  for (const [key, replacement] of [['title', live.title + ' corrected'], ['artist', 'Corrected composer'],
    ['difficulty', live.difficulty === 'AT' ? 'IN' : 'AT'], ['level', 18], ['constant', live.constant === 16.9 ? 17 : 16.9]]) {
    Object.assign(live, original); live[key] = replacement;
    assert.throws(() => Draw.validateCandidates(event, final, candidates), /candidate chart metadata has changed|Missing or invalid chart constant/);
  }
});

test('late consumption of a fresh high song invalidates an earlier safe six-candidate set', () => {
  const event = state(), current = event.tournament.matches.find(match => match.id === 'L5');
  const final = event.tournament.matches.find(match => match.id === 'L6');
  const mids = event.library.filter(song => song.eligible && band(song) === 1).slice(0, 3);
  const highs = event.library.filter(song => song.eligible && band(song) === 2).slice(0, 8);
  event.library = [...mids, ...highs]; event.tournament.matches = [current, final];
  const candidates = Draw.draw(event, current, rng(10));
  assert.equal(Draw.validateCandidates(event, current, candidates), true);
  // Consume one high that is not among this match's candidates, so this checks
  // inventory safety rather than only direct candidate identity collisions.
  const newlyUsed = highs.find(song => !candidates.some(candidate => candidate.id === song.id));
  event.tournament.songHistory = { earlier: [{ ...newlyUsed }] };
  assert.throws(() => Draw.validateCandidates(event, current, candidates), /No safe difficulty-gradient/);
});

test('each of the fifteen actual pairs in a protected R4 draw leaves a feasible R5', () => {
  const event = state(), current = event.tournament.matches.find(match => match.id === 'L5');
  const final = event.tournament.matches.find(match => match.id === 'L6');
  event.library = [...event.library.filter(song => song.eligible && band(song) === 1).slice(0, 3),
    ...event.library.filter(song => song.eligible && band(song) === 2).slice(0, 8)];
  event.tournament.matches = [current, final];
  const candidates = Draw.draw(event, current, rng(13));
  for (let left = 0; left < 6; left++) for (let right = left + 1; right < 6; right++) {
    const projected = structuredClone(event);
    complete(projected, projected.tournament.matches[0], [candidates[left], candidates[right]]);
    assert.equal(Draw.assertFutureFeasible(projected), true);
    limits(5, Draw.draw(projected, projected.tournament.matches[1], rng(left * 6 + right)));
  }
});

test('missing decimal constants reject actionable unknown songs without using integer levels', () => {
  const event = state();
  event.library.push({ ...event.library.find(song => song.eligible), id: 'custom-unknown', title: 'Unknown custom chart', constant: undefined });
  const before = structuredClone(event);
  assert.throws(() => Draw.draw(event, event.tournament.matches[0], rng(1)), /Missing or invalid chart constant.*Unknown custom chart/);
  assert.deepEqual(event, before);
});

test('duplicate chart aliases cannot inflate six-candidate stock or pass validation', () => {
  const event = state(), final = event.tournament.matches.find(match => match.id === 'L6');
  event.tournament.matches = [final];
  event.library = event.library.filter(song => song.eligible && band(song) === 2).slice(0, 5);
  event.library.push({ ...event.library[0], id: 'high-alias', title: '  ' + event.library[0].title.toUpperCase() + '  ' });
  assert.throws(() => Draw.draw(event, final, rng(1)), /six eligible songs; 5 available/);
  assert.throws(() => Draw.validateCandidates(event, final, event.library), /six distinct eligible songs/);
});

test('completed and already selected matches need no new two-song reservation, and GF is excluded', () => {
  const event = state();
  for (const match of event.tournament.matches) match.songs = event.library.filter(song => song.eligible).slice(0, 2);
  event.tournament.matches.push({ id: 'GF', round: 6, status: 'pending', songs: [] });
  event.library = [];
  assert.equal(Draw.assertFutureFeasible(event), true);
  event.library.push({ id: 'unknown-after-completion', title: 'No further draw needed', eligible: true, level: 16 });
  assert.equal(Draw.assertFutureFeasible(event), true);
});

test('random source validation fails safely and oversized work inputs are bounded', () => {
  const event = state();
  assert.throws(() => Draw.draw(event, event.tournament.matches[0], () => -1), /Invalid difficulty-gradient random source/);
  event.tournament.matches.push({ id: 'extra', round: 1, status: 'pending', songs: [] });
  assert.throws(() => Draw.draw(event, event.tournament.matches[0], rng(1)), /Too many pending matches/);
});

test('tiebreak pool filters unsafe fresh highs before random selection and retains safe own history', () => {
  const event = state(), current = event.tournament.matches.find(match => match.id === 'L5');
  const final = event.tournament.matches.find(match => match.id === 'L6');
  const lows = event.library.filter(song => song.eligible && band(song) === 0).slice(0, 2);
  const mids = event.library.filter(song => song.eligible && band(song) === 1).slice(0, 3);
  const highs = event.library.filter(song => song.eligible && band(song) === 2).slice(0, 7);
  event.library = [...lows, ...mids, ...highs]; event.tournament.matches = [current, final];
  current.songs = [mids[0], highs[0]];
  const before = structuredClone(event), input = SongPool.available(event, current.id, { eligibleOnly: true });
  const safe = Draw.tiebreakPool(event, current, input);
  assert.equal(safe.length, 6);
  assert.deepEqual(safe.map(song => song.id), [...lows, ...mids, highs[0]].map(song => song.id));
  assert.deepEqual(event, before);
  for (const song of safe) {
    const projected = structuredClone(event);
    projected.tournament.matches[0].tiebreaks = [{ song }];
    assert.equal(Draw.assertFutureFeasible(projected), true);
  }
  for (const song of highs.slice(1)) {
    const projected = structuredClone(event);
    projected.tournament.matches[0].tiebreaks = [{ song }];
    assert.throws(() => Draw.assertFutureFeasible(projected), /No safe difficulty-gradient/);
  }
});

test('R5 tiebreaks contain only charts at 16.9 or above, including same-match repeat songs', () => {
  const event = state(), final = event.tournament.matches.find(match => match.id === 'L6');
  event.tournament.matches = [final];
  final.songs = event.library.filter(song => song.eligible && band(song) === 2).slice(0, 2);
  const safe = Draw.tiebreakPool(event, final, SongPool.available(event, final.id, { eligibleOnly: true }));
  assert.equal(safe.length, 13); assert.ok(safe.every(song => constant(song) >= 16.9));
  assert.ok(final.songs.every(song => safe.some(candidate => candidate.id === song.id)));
  const lows = event.library.filter(song => song.eligible && band(song) === 0);
  assert.throws(() => Draw.tiebreakPool(event, final, lows), /R5 tiebreaks require 16.9 or above/);
});

test('GF tiebreak without future regular matches preserves ungraded input and needs no metadata', () => {
  const event = state(), final = { id: 'GF', round: 6, status: 'ready', songs: [], tiebreaks: [] };
  const unknown = { id: 'unknown-gf-tie', title: 'Custom extra chart', artist: 'Composer', eligible: true, level: 16 };
  event.tournament.matches = [final]; event.library = [unknown];
  assert.deepEqual(Draw.tiebreakPool(event, final, [unknown]), [unknown]);
});

test('tiebreak metadata is mandatory when R5 floor or future stock analysis requires it', () => {
  const event = state(), current = event.tournament.matches.find(match => match.id === 'L5');
  const final = event.tournament.matches.find(match => match.id === 'L6');
  const unknown = { id: 'unknown-tie', title: 'Unknown tie constant', artist: 'Composer', eligible: true, level: 16 };
  event.library.push(unknown); event.tournament.matches = [current, final];
  assert.throws(() => Draw.tiebreakPool(event, current, [unknown]), /Missing or invalid chart constant.*Unknown tie constant/);
  event.tournament.matches = [final];
  assert.throws(() => Draw.tiebreakPool(event, final, [unknown]), /Missing or invalid chart constant.*Unknown tie constant/);
});
