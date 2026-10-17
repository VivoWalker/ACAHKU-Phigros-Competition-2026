'use strict';

const { randomInt } = require('node:crypto');
const CompetitionConfig = require('../public/js/competition-config');
const SongPool = require('../public/js/song-pool');

const MATCH_ORDER = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'L1', 'L2', 'W7', 'L3', 'L4', 'L5', 'L6'];
const MAX_STATES = 75000;
const NO_SAFE_DRAW = 'No safe difficulty-gradient draw is possible with the remaining song pool. Restore eligible songs with decimal chart constants or review reserved songs; R5 must retain six songs at 16.9 or above.';

function assert(condition, message) { if (!condition) throw new Error(message); }
const tier = constant => constant <= 16.5 ? 0 : constant <= 16.8 ? 1 : 2;
const sum = values => values.reduce((total, value) => total + value, 0);
const counts = songs => songs.reduce((result, song) => { result[tier(constant(song))]++; return result; }, [0, 0, 0]);
function constant(song) {
  const value = CompetitionConfig.chartConstant(song);
  assert(Number.isFinite(value) && value >= 1 && value <= 20 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-8,
    `Missing or invalid chart constant for "${song?.title || song?.id || 'unknown song'}". Enter its original one-decimal chart constant in the song library before drawing.`);
  return value;
}
function hardQuota(round, quota) {
  const [low, , high] = quota;
  return sum(quota) === 6 && (round === 1 ? low >= 3 && high <= 1 :
    round === 2 ? low >= 1 && high <= 2 : round === 3 ? low <= 1 :
      round === 4 ? low === 0 && high >= 3 : round === 5 && high === 6);
}
function quotas(round) {
  const rule = CompetitionConfig.DRAW_RULES[round];
  assert(rule, 'Unsupported round for difficulty-gradient drawing.');
  const distance = quota => quota.reduce((total, count, index) => total + (count - rule.target[index]) ** 2, 0);
  const result = [];
  for (let low = 0; low <= 6; low++) for (let mid = 0; mid <= 6 - low; mid++) {
    const quota = [low, mid, 6 - low - mid];
    if (hardQuota(round, quota)) result.push(quota);
  }
  return result.sort((left, right) => distance(left) - distance(right));
}
function sortedPending(state, excludedId) {
  const result = (state.tournament?.matches || []).filter(match => match.id !== 'GF' && match.bracket !== 'GF' &&
    match.id !== excludedId && match.status !== 'complete' && !(match.songs || []).length);
  assert(result.length <= 13, 'Too many pending matches for difficulty-gradient drawing.');
  for (const match of result) assert(Number.isInteger(match.round) && match.round >= 1 && match.round <= 5,
    'Unsupported round for difficulty-gradient drawing.');
  return result.sort((left, right) => left.round - right.round ||
    MATCH_ORDER.indexOf(left.id) - MATCH_ORDER.indexOf(right.id) || String(left.id).localeCompare(String(right.id)));
}

// A match may reuse its own historical songs after a redraw, but those songs
// remain unavailable to every other match. Keep owned and shared stock separate.
function context(state, match, excludedId) {
  assert(Array.isArray(state.library) && state.library.length <= 500, 'Song library exceeds the difficulty-gradient draw limit.');
  if (match) assert(Number.isInteger(match.round) && match.round >= 1 && match.round <= 5 && match.id !== 'GF',
    'Unsupported round for difficulty-gradient drawing.');
  const global = SongPool.available(state, null, { eligibleOnly: true });
  const globalIds = new Set(global.map(song => song.id)), globalIdentities = new Set(global.map(SongPool.identity));
  const shared = song => globalIds.has(song.id) || globalIdentities.has(SongPool.identity(song));
  const pending = sortedPending(state, match?.id || excludedId);
  const schedule = (match ? [match, ...pending] : pending).map(entry => {
    const pool = SongPool.available(state, entry.id, { eligibleOnly: true });
    return { match: entry, pool, owned: counts(pool.filter(song => !shared(song))), quotas: quotas(entry.round) };
  });
  assert(schedule.length <= 13, 'Too many pending matches for difficulty-gradient drawing.');
  const globalCounts = counts(global), memo = new Map(), outcomeMemo = new Map();
  let examined = 0;
  function outcomes(fresh, owned) {
    const key = [...fresh, ...owned].join(',');
    if (outcomeMemo.has(key)) return outcomeMemo.get(key);
    const result = [];
    for (let low = 0; low <= Math.min(2, fresh[0]); low++) for (let mid = 0; mid <= Math.min(2 - low, fresh[1]); mid++) {
      for (let high = 0; high <= Math.min(2 - low - mid, fresh[2]); high++) {
        if (2 - low - mid - high <= sum(owned)) result.push([low, mid, high]);
      }
    }
    outcomeMemo.set(key, result); return result;
  }
  function safe(stock, index, quota, freshOverride) {
    const own = schedule[index].owned;
    // Using an owned song instead of a shared song can only preserve future
    // options, so feasibility needs to consider this dominant allocation only.
    const owned = quota.map((amount, band) => Math.min(amount, own[band]));
    const fresh = freshOverride || quota.map((amount, band) => amount - owned[band]);
    if (fresh.some((amount, band) => amount > stock[band])) return false;
    const actualOwned = quota.map((amount, band) => amount - fresh[band]);
    return outcomes(fresh, actualOwned).every(picked => viable(stock.map((amount, band) => amount - picked[band]), index + 1));
  }
  function viable(stock, index) {
    if (index === schedule.length) return true;
    const key = `${index}:${stock.join(',')}`;
    if (memo.has(key)) return memo.get(key);
    assert(++examined <= MAX_STATES, 'Difficulty-gradient stock analysis reached its work limit. Review the song pool and pending matches before retrying.');
    // Necessary checks for every later match prune hopeless branches before
    // exploring quotas. In particular no path may spend R5's six high charts.
    for (const future of schedule.slice(index)) {
      const capacity = stock.map((amount, band) => amount + future.owned[band]);
      if (sum(capacity) < 6 || (future.match.round === 1 && capacity[0] < 3) ||
        (future.match.round === 2 && capacity[0] < 1) ||
        (future.match.round === 4 && capacity[1] + capacity[2] < 6) ||
        (future.match.round === 5 && capacity[2] < 6)) {
        memo.set(key, false); return false;
      }
    }
    const result = schedule[index].quotas.some(quota => safe(stock, index, quota));
    memo.set(key, result); return result;
  }
  return { schedule, globalCounts, shared, safe, viable };
}

function integer(rand, upper) {
  const value = rand(upper);
  assert(Number.isInteger(value) && value >= 0 && value < upper, 'Invalid difficulty-gradient random source.');
  return value;
}
function shuffle(values, rand) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = integer(rand, index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function weighted(pool, amount, mean, rand) {
  const remaining = [...pool], result = [];
  for (let index = 0; index < amount; index++) {
    const logs = remaining.map(song => -0.5 * ((constant(song) - mean) / 0.35) ** 2);
    const largest = Math.max(...logs), weights = logs.map(log => Math.exp(log - largest));
    let cursor = integer(rand, 1000000000) / 1000000000 * sum(weights), selected = 0;
    while (selected < weights.length - 1 && cursor >= weights[selected]) cursor -= weights[selected++];
    result.push(remaining.splice(selected, 1)[0]);
  }
  return result;
}

function draw(state, match, rand = randomInt) {
  const analysis = context(state, match), current = analysis.schedule[0];
  assert(current.pool.length >= 6, `Difficulty-gradient drawing requires six eligible songs; ${current.pool.length} available.`);
  const options = current.quotas.filter(quota => analysis.safe(analysis.globalCounts, 0, quota));
  assert(options.length, NO_SAFE_DRAW);
  const rule = CompetitionConfig.DRAW_RULES[match.round];
  const distance = quota => quota.reduce((total, amount, band) => total + (amount - rule.target[band]) ** 2, 0);
  const bestDistance = distance(options[0]), closest = options.filter(quota => distance(quota) === bestDistance);
  const quota = closest[integer(rand, closest.length)], proposals = [];
  const pools = [0, 1, 2].map(band => current.pool.filter(song => tier(constant(song)) === band));
  for (let attempt = 0; attempt < 96; attempt++) {
    const songs = pools.flatMap((pool, band) => {
      const own = pool.filter(song => !analysis.shared(song)), fresh = pool.filter(analysis.shared);
      const ownAmount = Math.min(quota[band], own.length);
      return [...weighted(own, ownAmount, rule.mean, rand), ...weighted(fresh, quota[band] - ownAmount, rule.mean, rand)];
    });
    const difference = Math.abs(sum(songs.map(constant)) / 6 - rule.mean);
    proposals.push({ songs, difference });
  }
  const nearest = Math.min(...proposals.map(proposal => proposal.difference));
  const finalists = proposals.filter(proposal => proposal.difference <= nearest + 0.025);
  return shuffle(finalists[integer(rand, finalists.length)].songs, rand);
}

function validateCandidates(state, match, candidates) {
  assert(Array.isArray(candidates) && candidates.length === 6 && SongPool.distinct(candidates).length === 6,
    'Invalid difficulty-gradient candidate set. Draw six distinct eligible songs again.');
  const analysis = context(state, match), current = analysis.schedule[0];
  const songs = candidates.map(candidate => current.pool.find(song => song.id === candidate.id));
  assert(songs.every(Boolean) && SongPool.distinct(songs).length === 6,
    'The difficulty-gradient candidate pool has changed. Draw the six candidates again.');
  assert(songs.every((song, index) => ['title', 'artist', 'difficulty', 'level'].every(key => song[key] === candidates[index][key]) &&
    constant(song) === constant(candidates[index])),
  'The difficulty-gradient candidate chart metadata has changed. Draw the six candidates again.');
  const quota = counts(songs);
  assert(hardQuota(match.round, quota), `The difficulty-gradient candidates do not meet R${match.round} limits. Draw the six candidates again.`);
  const fresh = counts(songs.filter(analysis.shared));
  assert(analysis.safe(analysis.globalCounts, 0, quota, fresh), NO_SAFE_DRAW);
  return true;
}

function assertFutureFeasible(state) {
  if (!sortedPending(state).length) return true;
  const analysis = context(state);
  assert(analysis.viable(analysis.globalCounts, 0), NO_SAFE_DRAW);
  return true;
}

function tiebreakPool(state, match, pool) {
  assert(Array.isArray(pool), 'Invalid difficulty-gradient tiebreak pool.');
  let candidates = SongPool.distinct(pool).filter(song => song.eligible && SongPool.isAvailable(state, song, match.id));
  const r5 = match.round === 5 || match.id === 'L6';
  if (r5) candidates = candidates.filter(song => constant(song) >= 16.9);
  const message = 'No stock-safe difficulty-gradient tiebreak song remains. Add eligible songs with decimal chart constants or review reserved songs; R5 tiebreaks require 16.9 or above, and future R5 draws must retain six such songs.';
  assert(candidates.length, message);
  if (!sortedPending(state, match.id).length) return candidates;
  // Reuse one stock analysis for the entire input pool. There are only three
  // fresh-song costs (one per tier), and owned songs cost no fresh stock.
  const analysis = context(state, undefined, match.id);
  candidates = candidates.filter(song => {
    const stock = [...analysis.globalCounts];
    if (analysis.shared(song)) stock[tier(constant(song))]--;
    return analysis.viable(stock, 0);
  });
  assert(candidates.length, message);
  return candidates;
}

module.exports = { draw, validateCandidates, assertFutureFeasible, tiebreakPool };
