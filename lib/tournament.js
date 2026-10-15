const { randomInt, randomUUID } = require('node:crypto');
const { applyBroadcastCheckAction } = require('./broadcast-check');
const QualifierRules = require('../public/js/qualifier-rules');
const MatchRules = require('./match-rules');
const Adjudication = require('./adjudication');
const ScoreRules = require('../public/js/score-rules');
const SongPool = require('../public/js/song-pool');
const CompetitionConfig = require('../public/js/competition-config');
const SCENES = ['start', 'qualifier-waiting', 'double-elimination-waiting', 'qualifier-match', 'double-elimination-match', 'result', 'bracket', 'song-selection', 'grand-final-announcement'];
const CURRENT_MATCH_ACTIONS = new Set(['draw-candidates', 'ban-song', 'pick-songs', 'set-final-candidates', 'set-final-picks',
  'reveal-host-song', 'set-song-progress', 'set-match-score', 'record-result', 'record-bye', 'lottery-bye', 'reset-current-match',
  'draw-match-tiebreak', 'set-match-tiebreak-score', 'confirm-match-tiebreak']);
const seed = n => ({ type: 'seed', value: n });
const win = id => ({ type: 'winner', value: id });
const lose = id => ({ type: 'loser', value: id });
const DEFINITIONS = [
  ['W1', 1, 'WB', 'Winners’ Bracket Round 1', seed(1), seed(8)],
  ['W2', 1, 'WB', 'Winners’ Bracket Round 1', seed(4), seed(5)],
  ['W3', 1, 'WB', 'Winners’ Bracket Round 1', seed(2), seed(7)],
  ['W4', 1, 'WB', 'Winners’ Bracket Round 1', seed(3), seed(6)],
  ['W5', 2, 'WB', 'Winners’ Bracket Round 2', win('W1'), win('W2')],
  ['W6', 2, 'WB', 'Winners’ Bracket Round 2', win('W3'), win('W4')],
  ['L1', 2, 'LB', 'Losers’ Bracket Entry', lose('W1'), lose('W2')],
  ['L2', 2, 'LB', 'Losers’ Bracket Entry', lose('W3'), lose('W4')],
  ['W7', 3, 'WB', 'Winners’ Bracket Final', win('W5'), win('W6')],
  ['L3', 3, 'LB', 'Losers’ Bracket Round 2', win('L1'), lose('W6')],
  ['L4', 3, 'LB', 'Losers’ Bracket Round 2', win('L2'), lose('W5')],
  ['L5', 4, 'LB', 'Losers’ Bracket Round 3', win('L3'), win('L4')],
  ['L6', 5, 'LB', 'Losers’ Bracket Final', win('L5'), lose('W7')],
  ['GF', 6, 'GF', 'Grand Finals', win('W7'), win('L6')]
];
function assert(value, message) { if (!value) throw new Error(message); }
function text(value, max = 120) {
  assert(typeof value === 'string', 'Expected text.');
  return value.trim().slice(0, max);
}
function score(value) {
  if (value === '' || value === null) return null;
  assert(Number.isInteger(value) && value >= 0 && value <= 1000000, 'Scores must be integers from 0 to 1,000,000.');
  return value;
}
function shuffled(values, rand = randomInt) {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function total(scores) { return scores.reduce((s, n) => s + (n ?? 0), 0); }
function rankings(state, group) {
  if (state.qualifier.plan || QualifierRules.isChallenge(state)) return QualifierRules.rankings(state, group);
  const players = state.qualifier.players.filter(p => p.group === group && !p.disqualification)
    .map(p => ({ ...p, total: total(p.scores), complete: p.scores.every(n => n !== null) }))
    .sort((a, b) => b.total - a.total || (a.tiePriority ?? 999) - (b.tiePriority ?? 999) || a.id.localeCompare(b.id));
  return players.map((p, i) => ({ ...p, rank: i + 1,
    tied: players.some(other => other.id !== p.id && other.total === p.total &&
      (other.tiePriority === null || p.tiePriority === null || other.tiePriority === p.tiePriority))
  }));
}
function createBracket(ids, options = {}) {
  assert(ids.length === 8, 'Exactly eight seed slots are required. Use null for a vacancy.');
  const used = ids.filter(Boolean);
  assert(new Set(used).size === used.length, 'A player cannot occupy two seed slots.');
  assert(used.length >= 2, 'At least two players are required.');
  const proposal = options.ruleset === 'proposal-2026';
  const fixedSongs = options.finalSongs;
  if (fixedSongs) assert(fixedSongs.length === 2 && CompetitionConfig.FINAL_SONG_IDS.every((id, i) => fixedSongs[i]?.id === id), 'Configure both fixed Grand Final songs first.');
  return { seeded: true, seeds: ids, currentMatchId: 'W1', drawLog: [], ...(proposal ? { ruleset: 'proposal-2026' } : {}),
    ...(options.seedingPlan === 'B' ? { seedingPlan: 'B' } : {}),
    matches: DEFINITIONS.map(([id, round, bracket, label, a, b]) => ({
      id, round, bracket, label, sources: initialSources(id, options.seedingPlan), players: [null, null],
      status: 'pending', candidates: [], bans: [null, null], songs: id === 'GF' && fixedSongs ? fixedSongs.map(song => ({ ...song })) : [],
      ...(id === 'GF' && fixedSongs ? { finalMode: 'fixed-two', usedSongs: fixedSongs.map(song => ({ ...song })) } : {}),
      audiencePicks: [], hostPick: null, hostRevealed: false,
      currentSong: 0, scores: [Array(id === 'GF' && !fixedSongs ? 3 : 2).fill(null), Array(id === 'GF' && !fixedSongs ? 3 : 2).fill(null)],
      winnerId: null, loserId: null, resultType: null, note: '', overridePlayers: null,
      ...(proposal ? { ...(id === 'GF' && !fixedSongs ? { finalCandidateCount: 6 } : {}), bansConfirmed: [false, false],
        judgements: [Array(id === 'GF' && !fixedSongs ? 3 : 2).fill(null), Array(id === 'GF' && !fixedSongs ? 3 : 2).fill(null)], tiebreaks: [] } : {})
    }))
  };
}
// Keep the alternating qualifier seed ranking for later reseeding; only the
// first-round pairings differ under Plan B. Unmarked schema-1 backups retain
// their original fixed source graph.
function initialSources(matchId, plan) {
  if (plan === 'B' && matchId === 'W2') return [seed(4), seed(7)];
  if (plan === 'B' && matchId === 'W3') return [seed(2), seed(5)];
  return DEFINITIONS.find(definition => definition[0] === matchId).slice(4).map(source => ({ ...source }));
}
function configuredFinalSongs(state) {
  return state.event.competitionVersion === CompetitionConfig.VERSION ? CompetitionConfig.FINAL_SONG_IDS.map(id => findSong(state, id)) : undefined;
}
const RESEED_FIELDS = [
  { matches: ['W5', 'W6'], sources: ['W1', 'W2', 'W3', 'W4'].map(win) },
  { matches: ['L1', 'L2'], sources: ['W1', 'W2', 'W3', 'W4'].map(lose) },
  { matches: ['L3', 'L4'], sources: [win('L1'), win('L2'), lose('W5'), lose('W6')] }
];
function reseedFields(state) {
  const t = state.tournament;
  if (t.ruleset !== 'proposal-2026') return;
  for (const field of RESEED_FIELDS) {
    const matches = field.matches.map(id => t.matches.find(m => m.id === id));
    if (matches.some(m => m.reseeded)) continue;
    const entries = field.sources.map(source => {
      const previous = t.matches.find(m => m.id === source.value);
      return { source, ready: previous?.status === 'complete',
        id: source.type === 'winner' ? previous?.winnerId : previous?.loserId };
    });
    if (!entries.every(entry => entry.ready)) continue;
    const rank = id => id ? t.seeds.indexOf(id) : Number.MAX_SAFE_INTEGER;
    entries.sort((a, b) => rank(a.id) - rank(b.id) || a.source.value.localeCompare(b.source.value));
    [[entries[0], entries[3]], [entries[1], entries[2]]].forEach((pair, i) => {
      matches[i].sources = pair.map(entry => ({ ...entry.source })); matches[i].reseeded = true;
    });
  }
}
const eligible = (state, id) => Boolean(id) && !participant(state, id)?.disqualification;
function resolveBracket(state) {
  const t = state.tournament;
  reseedFields(state);
  for (const m of t.matches) {
    const resolved = m.sources.map(source => {
      if (source.type === 'seed') return { ready: true, id: t.seeds[source.value - 1] ?? null };
      const prior = t.matches.find(x => x.id === source.value);
      return { ready: prior?.status === 'complete', id: source.type === 'winner' ? prior?.winnerId : prior?.loserId };
    });
    if (m.status !== 'complete') {
      const field = t.ruleset === 'proposal-2026' && RESEED_FIELDS.find(field => field.matches.includes(m.id));
      m.players = field && !m.reseeded ? [null, null] :
        (m.overridePlayers ?? resolved.map(s => s.id ?? null)).map(id => eligible(state, id) ? id : null);
      const ready = resolved.every(s => s.ready) && (!field || m.reseeded === true);
      m.status = ready ? (m.id === t.currentMatchId ? 'live' : 'ready') : 'pending';
    }
  }
}
function losses(state, playerId) {
  if (!playerId) return 0;
  return state.tournament.matches.filter(m => m.status === 'complete' && m.loserId === playerId).length;
}
function getMatch(state, id = state.tournament.currentMatchId) {
  const m = state.tournament.matches.find(x => x.id === id);
  assert(m, 'Seed the bracket and select a match first.');
  return m;
}
function editable(m) { assert(m.status !== 'complete', 'This result is locked. Completed matches cannot be reset or overwritten.'); }
function playable(m) { editable(m); assert(m.status !== 'pending', 'Previous matches must finish before this match is available.'); }
function findSong(state, id) { const s = state.library.find(x => x.id === id); assert(s, 'Unknown song.'); return { ...s }; }
function participant(state, id) { return state.qualifier.players.find(p => p.id === id); }
function requireCurrentMatch(state, payload) {
  if (typeof payload.matchId !== 'string' || payload.matchId !== state.tournament.currentMatchId) {
    const error = new Error('The selected match changed, or this command has no match ID. Refresh the match before trying again.');
    error.code = 'MATCH_CHANGED'; throw error;
  }
}
function lotteryField(m) {
  return m.round === 1 ? (['W1', 'W2'].includes(m.id) ? ['W1', 'W2'] : ['W3', 'W4']) :
    m.round === 2 ? (m.bracket === 'LB' ? ['L1', 'L2'] : ['W5', 'W6']) :
      m.round === 3 && m.bracket === 'LB' ? ['L3', 'L4'] : [];
}
function selectionStarted(m) {
  return Boolean(m.candidates.length || m.bans.some(Boolean) || m.songs.length || m.audiencePicks.length || m.hostPick || m.hostRevealed);
}
function resetSelection(m) {
  SongPool.remember(m);
  const fixed = m.finalMode === 'fixed-two', count = m.id === 'GF' && !fixed ? 3 : 2;
  m.candidates = []; m.bans = [null, null]; if (!fixed) m.songs = []; m.audiencePicks = []; m.hostPick = null; m.hostRevealed = false; m.currentSong = 0;
  m.scores = [Array(count).fill(null), Array(count).fill(null)];
  if (m.judgements) m.judgements = [Array(count).fill(null), Array(count).fill(null)];
  if (m.tiebreaks) m.tiebreaks = [];
  if (m.bansConfirmed) m.bansConfirmed = [false, false];
  delete m.selectionPreviewCue;
  delete m.verifiedAt; delete m.decisionReason;
}
function resultCorrectionImpact(state, matchId) {
  assert(typeof matchId === 'string' && matchId.length > 0, 'Choose the completed match to correct.');
  const target = getMatch(state, matchId);
  assert(target.status === 'complete', 'Only a completed result can be reopened.');
  const affected = new Set([target.id]), matches = state.tournament.matches;
  let changed = true;
  while (changed) {
    const size = affected.size;
    for (const m of matches) {
      if (m.sources.some(source => source.type !== 'seed' && affected.has(source.value))) affected.add(m.id);
      // A corrected upstream entrant can change every pairing in a reseeded
      // four-player field, including a match outside the old fixed route.
      if (state.tournament.ruleset === 'proposal-2026') {
        for (const field of RESEED_FIELDS) if (field.sources.some(source => affected.has(source.value)))
          field.matches.forEach(id => affected.add(id));
      }
      // A lottery changes both entry matches, including the companion match
      // which is not a descendant in the winner/loser source graph.
      if (m.overridePlayers || m.resultType === 'draw') {
        const pair = lotteryField(m);
        if (pair.some(id => affected.has(id))) pair.forEach(id => affected.add(id));
      }
    }
    changed = affected.size !== size;
  }
  const affectedMatches = matches.filter(m => m.id !== target.id && affected.has(m.id)).map(m => ({
    id: m.id, label: m.label, status: m.status, players: [...m.players],
    hasStartedSelection: selectionStarted(m), hasScores: m.scores.flat().some(n => n !== null),
    hasResult: m.status === 'complete', hasOverride: Boolean(m.overridePlayers)
  }));
  return { matchId: target.id, revision: state.revision, affectedMatchIds: affectedMatches.map(m => m.id), affectedMatches,
    requiresConfirmation: affectedMatches.some(m => m.hasStartedSelection || m.hasScores || m.hasResult || m.hasOverride),
    blockedReason: target.resultType === 'draw' || target.overridePlayers ?
      'This match belongs to a vacancy lottery with reassigned entrants. Restore a backup from before that lottery to correct the field safely.' : null };
}
function makeResult(state, m) {
  const placements = {};
  if (m.id === 'L6' && eligible(state, m.loserId)) placements[m.loserId] = 'Third place';
  if (m.id === 'GF') { if (eligible(state, m.winnerId)) placements[m.winnerId] = 'Champion'; if (eligible(state, m.loserId)) placements[m.loserId] = 'First Runner-up'; }
  state.result = { matchId: m.id, label: m.label, bracket: m.bracket, round: m.round,
    winnerId: m.winnerId, loserId: m.loserId, type: m.resultType, note: m.note,
    players: [...m.players], totals: m.scores.map(total), placements,
    ...(m.decisionReason ? { decisionReason: m.decisionReason } : {}) };
}
function finish(state, m, winnerId, kind, note = '') {
  m.winnerId = winnerId;
  m.loserId = m.players.find(id => id && id !== winnerId) ?? null;
  m.resultType = kind; m.note = note; m.status = 'complete';
  delete m.selectionPreviewCue;
  resolveBracket(state); makeResult(state, m);
}
function rawEntrants(state, match) {
  return match.overridePlayers || match.sources.map(source => source.type === 'seed' ? state.tournament.seeds[source.value - 1] ?? null : (() => {
    const previous = state.tournament.matches.find(m => m.id === source.value);
    return (source.type === 'winner' ? previous?.winnerId : previous?.loserId) ?? null;
  })());
}
function requiresLottery(state, match) {
  const field = lotteryField(match).map(id => getMatch(state, id));
  return field.length === 2 && field.every(m => ['ready', 'live'].includes(m.status) && m.scores.flat().every(n => n === null)) &&
    field.flatMap(m => m.players).filter(Boolean).length === 3;
}
function resolveDisqualification(state, playerId) {
  const player = participant(state, playerId);
  for (const m of state.tournament.matches) {
    if (!['ready', 'live'].includes(m.status)) continue;
    const raw = rawEntrants(state, m);
    if (!raw.includes(playerId) || requiresLottery(state, m)) continue;
    const remaining = raw.filter(id => eligible(state, id));
    if (remaining.length !== 1) continue;
    // Preserve the original opponent in the completed forfeiture record; only
    // future entries mask a disqualified player out of the tournament.
    m.players = raw.map(id => id ?? null);
    finish(state, m, remaining[0] ?? null, 'forfeit', `Disqualified: ${player?.disqualification?.reason || 'arbiter decision'}`);
    if (m.id === state.tournament.currentMatchId) state.scene = 'result';
  }
}
function applyAction(state, action) {
  assert(action && typeof action.type === 'string', 'Invalid command.');
  const p = action.payload ?? {};
  if (CURRENT_MATCH_ACTIONS.has(action.type)) requireCurrentMatch(state, p);
  if (action.type === 'disqualify-player') assert(!state.tournament.matches.some(m => m.id === 'GF' && m.status === 'complete'),
    'The tournament has finished. Review completed results before changing qualification.');
  if (applyBroadcastCheckAction(state, action)) return state;
  const helpers = { assert, text, score, shuffled, findSong, participant, getMatch, playable, finish,
    createBracket: ids => {
      const bracket = createBracket(ids, { ruleset: 'proposal-2026', seedingPlan: state.qualifier.plan, finalSongs: configuredFinalSongs(state) });
      SongPool.carryUsage(bracket, state.tournament); return bracket;
    } };
  if (QualifierRules.applyAction(state, action, helpers) || MatchRules.applyAction(state, action, helpers) ||
    Adjudication.applyAction(state, action, helpers)) {
    if (action.type === 'draw-match-tiebreak') delete getMatch(state).selectionPreviewCue;
    resolveBracket(state);
    if (action.type === 'disqualify-player') resolveDisqualification(state, p.playerId);
    return state;
  }
  switch (action.type) {
    case 'apply-competition-config': {
      assert(p.confirmed === true, 'Review and confirm replacing the song catalog and qualifier songs with the official competition configuration.');
      assert(!state.tournament.seeded && !QualifierRules.hasScores(state) && !state.result &&
        !state.tournament.matches.length && !state.tournament.seeds.length && !state.tournament.drawLog.length &&
        !Object.keys(state.tournament.songHistory || {}).length && !state.correctionLog?.length &&
        !state.qualifier.players.some(player => player.judgements?.some(Boolean)) &&
        !['A', 'B'].some(group => Object.values(state.qualifier.rounds?.[group]?.results || {}).some(row => row.judgements?.some(Boolean))),
      'Apply the official configuration only before any scoring, seeding or tournament history. Preserve this event and prepare a fresh event instead.');
      QualifierRules.setScoringMode(state, QualifierRules.CHALLENGE_MODE);
      state.library = CompetitionConfig.library(); state.event.competitionVersion = CompetitionConfig.VERSION;
      state.qualifier.groups = Object.fromEntries(['A', 'B'].map(group => [group, { songs: [...CompetitionConfig.QUALIFIER_SONG_IDS[group]] }]));
      state.qualifier.currentSong = 0;
      break;
    }
    case 'set-event': {
      for (const key of ['title', 'organiser', 'organiserZH', 'date', 'time', 'venue', 'message']) {
        if (key in p) state.event[key] = text(p[key], key === 'organiser' ? 180 : 120);
      }
      assert(state.event.title && state.event.venue, 'Event name and venue are required.');
      assert(/^\d{4}-\d{2}-\d{2}$/.test(state.event.date), 'Use a YYYY-MM-DD date.');
      break;
    }
    case 'set-scene':
      assert(SCENES.includes(p.scene), 'Unknown scene.');
      if (p.scene === 'grand-final-announcement') assert(configuredFinalSongs(state) &&
        (!state.tournament.seeded || state.tournament.matches.find(match => match.id === 'GF')?.finalMode === 'fixed-two'),
      'Apply the fixed two-song Grand Final configuration before announcing its songs.');
      state.scene = p.scene;
      if (p.scene.startsWith('qualifier-')) state.stage = 'qualifier';
      else if (p.scene.startsWith('double-elimination-') || ['bracket', 'song-selection', 'grand-final-announcement'].includes(p.scene)) state.stage = 'double-elimination';
      break;
    case 'set-stage': assert(['qualifier', 'double-elimination'].includes(p.stage), 'Unknown stage.'); state.stage = p.stage; break;
    case 'set-broadcast-display':
      assert(typeof p.showHandcams === 'boolean', 'showHandcams must be a boolean.');
      state.broadcast = { ...state.broadcast, showHandcams: p.showHandcams };
      break;
    case 'set-roster': {
      assert(!state.tournament.seeded, 'The seeded player roster is locked.');
      assert(!state.qualifier.players.some(player => player.disqualification), 'The roster is locked after a disqualification; preserve the recorded entrant identities.');
      assert(['A', 'B'].includes(p.group) && Array.isArray(p.names), 'Choose Group A or B.');
      assert(p.names.length <= 32, 'Maximum 32 players per group.');
      const names = p.names.map(n => text(n, 48)).filter(Boolean);
      assert(new Set(names).size === names.length, 'Names within a group must be unique.');
      const old = state.qualifier.players.filter(x => x.group === p.group);
      assert(old.every(player => !QualifierRules.recorded(player) || names.includes(player.name)),
        'Scored players cannot be removed or renamed through roster replacement. Use Rename player to preserve their scores.');
      const removed = old.filter(player => !names.includes(player.name));
      assert(!removed.some(player => state.qualifier.waits?.[player.id]),
        'Cancel the running player wait before removing that entrant from the roster.');
      state.qualifier.players = state.qualifier.players.filter(x => x.group !== p.group).concat(names.map(name =>
        old.find(x => x.name === name) ?? { id: randomUUID(), name, group: p.group, scores: [null, null, null], ...(QualifierRules.isChallenge(state) ? { challengeTotal: null } : {}), tiePriority: null }));
      state.qualifier.activePlayers = state.qualifier.activePlayers.filter(id => participant(state, id));
      for (const player of removed) if (state.qualifier.readiness) delete state.qualifier.readiness[player.id];
      break;
    }
    case 'rename-player': {
      const player = participant(state, p.playerId); assert(player, 'Unknown player.');
      const name = text(p.name, 48); assert(name, 'Player name is required.');
      assert(!state.qualifier.players.some(other => other.id !== player.id && other.group === player.group && other.name === name),
        'Names within a group must be unique.');
      player.name = name; break;
    }
    case 'randomise-groups': {
      assert(!state.tournament.seeded && state.qualifier.players.every(p => !QualifierRules.recorded(p)), 'Randomise groups before scoring or seeding.');
      shuffled(state.qualifier.players).forEach((p, i) => { p.group = i % 2 ? 'B' : 'A'; });
      state.qualifier.activePlayers = []; break;
    }
    case 'set-qualifier-display': {
      if (p.group !== undefined) { assert(['A', 'B'].includes(p.group), 'Invalid group.'); state.qualifier.activeGroup = p.group; state.qualifier.activePlayers = []; }
      if (p.players !== undefined) {
        assert(Array.isArray(p.players) && p.players.length <= 3 && new Set(p.players).size === p.players.length, 'Choose up to three different players.');
        assert(p.players.every(id => participant(state, id)?.group === state.qualifier.activeGroup), 'Displayed players must be in the active group.');
        state.qualifier.activePlayers = p.players;
      }
      if (p.currentSong !== undefined) { assert(Number.isInteger(p.currentSong) && p.currentSong >= 0 && p.currentSong < 3, 'Invalid song number.'); state.qualifier.currentSong = p.currentSong; }
      break;
    }
    case 'set-qualifier-songs': {
      assert(['A', 'B'].includes(p.group) && Array.isArray(p.ids) && p.ids.length === 3 && new Set(p.ids).size === 3, 'Choose three different songs.');
      assert(!state.qualifier.players.some(x => x.group === p.group && QualifierRules.recorded(x)), 'Group songs are locked after scoring starts.');
      const other = state.qualifier.groups[p.group === 'A' ? 'B' : 'A'].songs;
      assert(!p.ids.some(id => other.includes(id)), 'Groups A and B must use different songs.');
      p.ids.forEach(id => findSong(state, id)); state.qualifier.groups[p.group].songs = p.ids; break;
    }
    case 'set-qualifier-score': {
      assert(!state.tournament.seeded, 'Qualifier scores are locked after seeding.');
      const player = participant(state, p.playerId); assert(player, 'Unknown player.');
      assert(Number.isInteger(p.songIndex) && p.songIndex >= 0 && p.songIndex < 3, 'Invalid song number.');
      assert(!player.disqualification, 'A disqualified player cannot be scored.');
      const value = score(p.score), oldScore = player.scores[p.songIndex];
      const metadata = value === null ? null : Object.hasOwn(p, 'judgements') ? ScoreRules.normaliseJudgements(p.judgements) : value !== oldScore ? null : player.judgements?.[p.songIndex] ?? null;
      player.scores[p.songIndex] = value;
      if (p.judgements !== undefined || player.judgements) { player.judgements ??= Array(3).fill(null); player.judgements[p.songIndex] = metadata; }
      break;
    }
    case 'set-tie-priority': {
      assert(!state.qualifier.plan, 'Proposal events resolve ties through accuracy and recorded tiebreaks.');
      assert(!state.tournament.seeded, 'Qualifier rankings are locked after seeding.');
      const player = participant(state, p.playerId); assert(player, 'Unknown player.');
      assert(p.priority === null || (Number.isInteger(p.priority) && p.priority >= 1 && p.priority <= 64), 'Tie priority must be 1–64.');
      player.tiePriority = p.priority; break;
    }
    case 'qualify': {
      assert(!state.tournament.seeded, 'Bracket already seeded.');
      const groups = ['A', 'B'].map(group => rankings(state, group));
      groups.forEach(group => {
        assert(group.length >= 4 && group.every(p => p.complete), 'All group scores must be entered, with at least four players in each group.');
        assert(!group.slice(0, 4).some(p => p.tied), 'Resolve tied qualifier rankings using unique tie priorities.');
      });
      const ids = Array.from({ length: 4 }, (_, i) => [groups[0][i].id, groups[1][i].id]).flat();
      const bracket = createBracket(ids, { finalSongs: configuredFinalSongs(state),
        ...(state.event.competitionVersion === CompetitionConfig.VERSION ? { ruleset: 'proposal-2026' } : {}) }); SongPool.carryUsage(bracket, state.tournament);
      state.tournament = bracket; state.stage = 'double-elimination'; resolveBracket(state); break;
    }
    case 'seed-bracket': {
      assert(!state.tournament.matches.some(m => m.status === 'complete' || m.scores.flat().some(n => n !== null)), 'Seeding is locked once scoring or results begin.');
      assert(Array.isArray(p.ids), 'Provide eight seed slots.');
      p.ids.filter(Boolean).forEach(id => { assert(participant(state, id), 'Unknown seeded player.'); assert(eligible(state, id), 'A disqualified player cannot be seeded.'); });
      assert(!state.qualifier.plan || p.verified === true, 'Confirm that the qualifier results and seed order were checked by the arbiters.');
      if (state.qualifier.plan) {
        const expected = QualifierRules.seeds(state);
        const override = !['A', 'B'].every(group => state.qualifier.rounds[group].locked) || p.ids.some((id, index) => id !== expected[index]);
        assert(!override || typeof p.note === 'string' && text(p.note, 500).length >= 8,
          'Record a meaningful ACA decision before overriding unfinished qualification or the proposed seed order.');
      }
      const previous = state.tournament;
      state.tournament = createBracket(p.ids, { ruleset: p.ruleset || (state.qualifier.plan || state.event.competitionVersion === CompetitionConfig.VERSION ? 'proposal-2026' : undefined),
        seedingPlan: state.qualifier.plan, finalSongs: configuredFinalSongs(state) });
      SongPool.carryUsage(state.tournament, previous);
      if (p.note) (state.qualifier.adjudications ??= []).push({ type: 'seed-bracket', at: new Date().toISOString(), note: text(p.note, 500), seeds: [...p.ids] });
      state.result = null; state.stage = 'double-elimination'; resolveBracket(state); break;
    }
    case 'select-match': {
      const m = getMatch(state, p.matchId); assert(m.status !== 'pending' && m.status !== 'complete', 'Select a ready match.');
      state.tournament.currentMatchId = m.id; state.stage = 'double-elimination'; resolveBracket(state); break;
    }
    case 'draw-candidates': {
      const m = getMatch(state); playable(m); assert(m.id !== 'GF', 'Set Grand Finals candidates separately.');
      assert(m.players.every(Boolean), 'This match has a vacancy; record a bye or draw.');
      assert(m.scores.flat().every(n => n === null), 'Reset this match before redrawing songs.');
      const pool = SongPool.available(state, m.id, { eligibleOnly: true });
      assert(pool.length >= 6, `At least six eligible songs not selected by another match are required (${pool.length} available). Add unused songs to the pool; selected songs will not be reused across matches.`);
      SongPool.remember(m);
      m.candidates = shuffled(pool).slice(0, 6).map(s => ({ ...s })); m.bans = [null, null];
      if (m.bansConfirmed) m.bansConfirmed = [false, false];
      m.songs = []; m.currentSong = 0; delete m.selectionPreviewCue; break;
    }
    case 'ban-song': {
      const m = getMatch(state); playable(m); assert(m.id !== 'GF' && m.candidates.length === 6, 'Draw six candidates first.');
      assert([0, 1].includes(p.playerIndex), 'Invalid player.');
      assert(m.songs.length === 0, 'Bans are locked after the final draw.');
      assert(p.songId === null || m.candidates.some(s => s.id === p.songId), 'Song is not in this draw.');
      assert(p.songId === null || SongPool.isAvailable(state, m.candidates.find(song => song.id === p.songId), m.id),
        'Another match selected this candidate. Choose another ban or redraw the candidates.');
      assert(!p.songId || m.bans[1 - p.playerIndex] !== p.songId, 'The other player has already banned that song.');
      const previousBan = m.bans[p.playerIndex];
      m.bans[p.playerIndex] = p.songId;
      if (m.bansConfirmed) m.bansConfirmed[p.playerIndex] = Boolean(p.songId) || p.confirmed === true;
      if (p.songId && previousBan !== p.songId) {
        m.selectionPreviewCue = { id: randomUUID(), kind: 'ban', songIds: [p.songId], startedAt: Date.now() };
      } else if (p.songId === null && m.selectionPreviewCue?.kind === 'ban' && m.selectionPreviewCue.songIds[0] === previousBan) {
        delete m.selectionPreviewCue;
      }
      break;
    }
    case 'pick-songs': {
      const m = getMatch(state); playable(m); assert(m.id !== 'GF', 'Use the Grand Finals selection flow.');
      assert(m.songs.length === 0 && m.candidates.length === 6 && (m.bansConfirmed ? m.bansConfirmed.every(Boolean) : m.bans.every(Boolean)), 'Both players must record their ban or pass before the draw.');
      const remaining = SongPool.distinct(m.candidates.filter(s => !m.bans.includes(s.id) && SongPool.isAvailable(state, s, m.id)));
      assert(remaining.length >= 2, 'Fewer than two unbanned songs remain available: another match selected these candidates. Redraw six unused candidates.');
      m.songs = shuffled(remaining).slice(0, 2); SongPool.remember(m); m.currentSong = 0;
      m.selectionPreviewCue = { id: randomUUID(), kind: 'picks', songIds: m.songs.map(song => song.id), startedAt: Date.now() };
      break;
    }
    case 'set-final-candidates': {
      const m = getMatch(state); playable(m); assert(m.id === 'GF', 'Select Grand Finals first.');
      assert(m.finalMode !== 'fixed-two', 'Grand Final uses two fixed songs with no candidate, ban, audience or MC selection.');
      assert(m.scores.flat().every(n => n === null), 'Reset the final before changing candidates.');
      const count = m.finalCandidateCount || 8;
      assert(Array.isArray(p.ids) && p.ids.length === count && new Set(p.ids).size === count, `Choose ${count} distinct final candidates.`);
      const candidates = p.ids.map(id => findSong(state, id));
      assert(SongPool.distinct(candidates).length === count, 'Final candidates must be different songs, including across chart difficulties.');
      assert(candidates.every(song => SongPool.isAvailable(state, song, m.id)), 'A final candidate was selected by another match. Choose unused songs.');
      SongPool.remember(m);
      m.candidates = candidates; m.audiencePicks = []; m.hostPick = null; m.hostRevealed = false; m.songs = []; m.currentSong = 0; break;
    }
    case 'set-final-picks': {
      const m = getMatch(state); playable(m); assert(m.finalMode !== 'fixed-two', 'Grand Final uses two fixed songs with no candidate, ban, audience or MC selection.');
      assert(m.id === 'GF' && m.candidates.length === (m.finalCandidateCount || 8), 'Set the final candidates first.');
      assert(m.scores.flat().every(n => n === null), 'Picks are locked after scoring begins.');
      assert(Array.isArray(p.audienceIds) && p.audienceIds.length === 2 && new Set(p.audienceIds).size === 2, 'Record two different audience picks.');
      assert(!p.audienceIds.includes(p.hostId), 'MC pick must differ from the audience picks.');
      const lookup = id => { const s = m.candidates.find(x => x.id === id); assert(s, 'Pick from the final candidates.'); return { ...s }; };
      const songs = [...p.audienceIds.map(lookup), lookup(p.hostId)];
      assert(SongPool.distinct(songs).length === 3 && songs.every(song => SongPool.isAvailable(state, song, m.id)),
        'Final picks must be three different songs not selected by another match. Review the final candidates.');
      SongPool.remember(m);
      m.audiencePicks = p.audienceIds; m.hostPick = songs[2]; m.songs = songs; SongPool.remember(m); m.hostRevealed = false; m.currentSong = 0; break;
    }
    case 'reveal-host-song': {
      const m = getMatch(state); playable(m); assert(m.id === 'GF' && m.hostPick, 'Set an MC pick first.'); m.hostRevealed = true; break;
    }
    case 'set-song-progress': {
      const m = getMatch(state); playable(m);
      assert(Number.isInteger(p.index) && p.index >= 0 && p.index < m.songs.length, 'Choose a selected song.');
      assert(m.id !== 'GF' || p.index !== 2 || m.hostRevealed, 'Reveal the MC pick before going to song three.');
      m.currentSong = p.index; break;
    }
    case 'record-bye': {
      const m = getMatch(state); playable(m); const present = m.players.filter(Boolean);
      assert(state.tournament.ruleset !== 'proposal-2026' || !requiresLottery(state, m), 'A four-player field with one vacancy requires its lottery before recording a bye.');
      assert(present.length <= 1, 'Byes are only valid for vacant matches.');
      assert(m.scores.flat().every(value => value === null), 'Review and reset recorded match scores before closing a vacant match.');
      assert(state.tournament.ruleset !== 'proposal-2026' || present.length !== 0 || typeof p.note === 'string' && text(p.note, 240).length >= 8,
        'Record the ACA decision before closing a completely vacant proposal match.');
      finish(state, m, present[0] ?? null, 'bye', text(p.note ?? 'Vacant slot', 240)); break;
    }
    case 'lottery-bye': {
      const m = getMatch(state); playable(m);
      const pairIds = lotteryField(m);
      assert(pairIds.includes(m.id), 'A four-player entry field is required for a lottery.');
      const pair = pairIds.map(id => getMatch(state, id));
      assert(pair.every(x => ['ready', 'live'].includes(x.status) && x.scores.flat().every(n => n === null)), 'Both entry matches must be ready and unscored.');
      assert(pair.every(x => !selectionStarted(x)) || (state.tournament.ruleset === 'proposal-2026' && p.confirmClear === true),
        'Draw the vacancy lottery before drawing candidates, or confirm clearing both unscored proposal entry matches.');
      const all = pair.flatMap(x => x.players).filter(Boolean); assert(all.length === 3 && new Set(all).size === 3, 'Lottery requires exactly three players and one vacancy in this field.');
      const winner = p.playerId || shuffled(all)[0]; assert(all.includes(winner), 'Draw winner must belong to this four-player field.');
      if (p.confirmClear === true) pair.forEach(resetSelection);
      const others = all.filter(id => id !== winner); const other = pair.find(x => x.id !== m.id);
      m.overridePlayers = [winner, null]; m.players = [...m.overridePlayers];
      other.overridePlayers = others; other.players = [...others];
      const note = text(p.note || 'Four-player vacancy lottery', 240);
      state.tournament.drawLog.push({ matchId: m.id, eligible: all, winnerId: winner, target: m.id, note, timestamp: new Date().toISOString() });
      finish(state, m, winner, 'draw', note); break;
    }
    case 'reset-current-match': {
      const m = getMatch(state); playable(m); resetSelection(m); break;
    }
    case 'reopen-result': {
      const impact = resultCorrectionImpact(state, p.matchId);
      assert(!impact.blockedReason, impact.blockedReason);
      const reason = text(p.reason ?? '', 240); assert(reason, 'A correction reason is required.');
      assert(Array.isArray(p.affectedMatchIds) && p.affectedMatchIds.every(id => typeof id === 'string') &&
        new Set(p.affectedMatchIds).size === p.affectedMatchIds.length && p.affectedMatchIds.length === impact.affectedMatchIds.length &&
        p.affectedMatchIds.every(id => impact.affectedMatchIds.includes(id)),
      'The affected match list changed. Preview the correction again before reopening this result.');
      assert(!impact.requiresConfirmation || p.confirmClear === true, 'Confirm clearing the affected downstream selections, scores and results.');
      const target = getMatch(state, p.matchId), clearedIds = new Set(impact.affectedMatchIds);
      const cleared = state.tournament.matches.filter(m => clearedIds.has(m.id));
      const removedDrawLog = state.tournament.drawLog.filter(log => clearedIds.has(log.matchId) || clearedIds.has(log.target));
      const correction = { matchId: target.id, reason, at: new Date().toISOString(), affectedMatchIds: [...impact.affectedMatchIds],
        previousMatch: structuredClone(target), clearedMatches: structuredClone(cleared), removedDrawLog: structuredClone(removedDrawLog) };
      assert(state.correctionLog === undefined || Array.isArray(state.correctionLog), 'Invalid correction log. Restore a valid backup.');
      state.correctionLog ??= []; state.correctionLog.push(correction);
      for (const m of cleared) {
        resetSelection(m); m.overridePlayers = null; m.winnerId = m.loserId = m.resultType = null; m.note = ''; m.status = 'pending';
        delete m.reseeded;
        m.sources = initialSources(m.id, state.tournament.seedingPlan);
      }
      state.tournament.drawLog = state.tournament.drawLog.filter(log => !clearedIds.has(log.matchId) && !clearedIds.has(log.target));
      SongPool.remember(target);
      target.winnerId = target.loserId = target.resultType = null; target.note = ''; target.status = 'live';
      if (target.tiebreaks) target.tiebreaks = [];
      delete target.verifiedAt; delete target.decisionReason;
      state.tournament.currentMatchId = target.id; state.stage = 'double-elimination'; state.scene = 'double-elimination-match';
      if (state.result && (state.result.matchId === target.id || clearedIds.has(state.result.matchId))) state.result = null;
      break;
    }
    case 'upsert-song': {
      assert(p.song && typeof p.song === 'object', 'Provide song details.');
      const s = p.song;
      const song = { id: s.id ? text(s.id, 80) : randomUUID(), title: text(s.title, 100), artist: text(s.artist ?? '', 100),
        difficulty: text(s.difficulty, 2), level: Number(s.level), art: text(s.art || 'assets/song/cover-1.svg', 180), eligible: Boolean(s.eligible) };
      assert(song.title && ['EZ', 'HD', 'IN', 'AT'].includes(song.difficulty) && Number.isFinite(song.level) && song.level >= 1 && song.level <= 20, 'Provide title, difficulty and a level from 1 to 20.');
      if (state.event.competitionVersion === CompetitionConfig.VERSION && CompetitionConfig.FINAL_SONG_IDS.includes(song.id)) {
        const fixed = CompetitionConfig.library().find(value => value.id === song.id);
        assert(['title', 'difficulty', 'level'].every(key => song[key] === fixed[key]) && !song.eligible,
          'The fixed Grand Final title, difficulty and level are locked; its songs cannot enter the regular draw pool.');
      }
      assert(/^assets\/[a-zA-Z0-9_./-]+\.(svg|png|jpg|jpeg|webp)$/i.test(song.art) && !song.art.includes('..'), 'Artwork must be a local assets path.');
      const index = state.library.findIndex(x => x.id === song.id);
      // Older controls omit this optional field; only an explicit blank clears it.
      const existing = state.library[index];
      const previewAudio = Object.hasOwn(s, 'previewAudio') ? s.previewAudio : existing && Object.hasOwn(existing, 'previewAudio') ?
        existing.previewAudio : CompetitionConfig.LIBRARY.find(value => value.id === song.id)?.previewAudio || '';
      assert(typeof previewAudio === 'string' && previewAudio.length <= 180, 'Preview audio must be a local path of at most 180 characters.');
      song.previewAudio = previewAudio.trim();
      assert(!song.previewAudio || /^assets\/song-preview\/[a-zA-Z0-9_./-]+\.(mp3|ogg|wav|m4a)$/i.test(song.previewAudio) && !song.previewAudio.includes('..'), 'Preview audio must be a local assets/song-preview/ path (MP3, OGG, WAV or M4A).');
      if (index >= 0) {
        const locked = ['A', 'B'].some(group => state.qualifier.groups[group].songs.includes(song.id) && QualifierRules.roundStarted(state, group));
        assert(!locked || ['title', 'artist', 'difficulty', 'level'].every(key => state.library[index][key] === song[key]),
          'Qualifier song metadata is locked after this group starts scoring. Create a new library song for future draws.');
      }
      if (index < 0) assert(state.library.length < 500, 'Library limit is 500 songs.');
      // Also handle re-adding an occupied ID absent from a restored library.
      // Both stable IDs and metadata aliases remain attached to their owner.
      SongPool.recordAlias(state, state.library[index] || song, song);
      if (index < 0) state.library.push(song);
      else state.library[index] = song;
      break;
    }
    default: throw new Error('Unknown command.');
  }
  resolveBracket(state);
  return state;
}
function publicState(state) {
  const copy = structuredClone(state);
  delete copy.auditLog; delete copy.correctionLog; delete copy.recovery;
  for (const key of ['waits', 'readiness', 'adjudications', 'incidents']) delete copy.qualifier[key];
  for (const player of copy.qualifier.players) if (player.disqualification) player.disqualification = { reason: player.disqualification.reason };
  copy.broadcast = { ...copy.broadcast, showHandcams: copy.broadcast?.showHandcams === true };
  delete copy.tournament.songHistory;
  delete copy.broadcast.sourceSlots; delete copy.broadcast.sourceCheck; delete copy.broadcast.sourceStatus;
  for (const m of copy.tournament.matches) {
    delete m.rematches;
    delete m.usedSongs;
    delete m.hostPick;
    if (m.id === 'GF') delete m.selectionPreviewCue;
    if (m.id === 'GF' && !m.hostRevealed && m.songs.length >= 3) {
      m.songs[2] = { id: 'sealed', title: 'MC PICK — SEALED', artist: 'To be revealed', difficulty: '', level: null, art: 'assets/song/sealed.svg', hidden: true };
      m.scores.forEach(row => { row[2] = null; });
      m.judgements?.forEach(row => { row[2] = null; });
    }
  }
  copy.qualifier.rankings = { A: rankings(copy, 'A'), B: rankings(copy, 'B') };
  copy.tournament.standings = copy.tournament.seeds.map((id, i) => ({
    playerId: id, seed: i + 1, losses: losses(copy, id), eliminated: Boolean(id) && (losses(copy, id) >= 2 || !eligible(copy, id)),
    disqualified: Boolean(id) && !eligible(copy, id),
    placement: copy.tournament.matches.find(m => m.id === 'GF' && m.status === 'complete')?.winnerId === id && eligible(copy, id) ? 'Champion' :
      copy.tournament.matches.find(m => m.id === 'GF' && m.status === 'complete')?.loserId === id && eligible(copy, id) ? 'First Runner-up' :
      copy.tournament.matches.find(m => m.id === 'L6' && m.status === 'complete')?.loserId === id && eligible(copy, id) ? 'Third place' : null
  }));
  return copy;
}
module.exports = { SCENES, DEFINITIONS, RESEED_FIELDS, CURRENT_MATCH_ACTIONS, initialSources, createBracket, resolveBracket, rankings, total, losses, applyAction, publicState, resultCorrectionImpact };
