(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./score-rules'));
  else root.QualifierRules = factory(root.ScoreRules);
})(typeof globalThis === 'object' ? globalThis : this, function (ScoreRules) {
  'use strict';
  const groups = ['A', 'B'];
  const CHALLENGE_MODE = 'challenge-total';
  const MAX_CHALLENGE_TOTAL = 3000000;
  const isChallenge = state => state.qualifier.scoringMode === CHALLENGE_MODE;
  const configured = state => groups.includes(state.qualifier.plan);
  const roster = state => state.qualifier.players;
  const eligible = player => !player.disqualification;
  const numberOrder = (a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
  const requireValue = (value, message) => { if (!value) throw new Error(message); };
  const unique = values => new Set(values).size === values.length;
  const planForCount = count => count <= 20 ? 'A' : 'B';
  const emptyResult = state => ({ scores: [null, null, null], judgements: [null, null, null], ...(isChallenge(state) ? { challengeTotal: null } : {}) });
  function challengeTotal(value) {
    if (value === null || value === '') return null;
    requireValue(Number.isSafeInteger(value) && value >= 0 && value <= MAX_CHALLENGE_TOTAL,
      'Challenge Mode total must be an integer from 0 to 3,000,000.');
    return value;
  }
  const total = (state, row) => isChallenge(state) ? row.challengeTotal ?? null : ScoreRules.total(row.scores);
  const complete = (state, row) => isChallenge(state) ? row.challengeTotal !== null && row.challengeTotal !== undefined : row.scores.every(value => value !== null);
  const recorded = row => row.challengeTotal !== undefined && row.challengeTotal !== null || row.scores.some(value => value !== null) || row.judgements?.some(Boolean) || row.songStats?.some(Boolean) || row.songStatsRecorded === true;
  function normaliseSongStats(raw) {
    if (raw === null) return null;
    requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'Enter the song score and all four judgement counts.');
    const fields = ['score', 'perfect', 'good', 'bad', 'miss'];
    requireValue(Object.keys(raw).every(key => fields.includes(key) || key === 'accuracy'), 'Unknown song statistics field.');
    requireValue(Number.isSafeInteger(raw.score) && raw.score >= 0 && raw.score <= 1000000,
      'Song score must be an integer from 0 to 1,000,000.');
    const stats = { score: raw.score };
    for (const key of fields.slice(1)) {
      requireValue(Number.isSafeInteger(raw[key]) && raw[key] >= 0, 'Enter all four nonnegative integer judgement counts.');
      stats[key] = raw[key];
    }
    if (Object.hasOwn(raw, 'accuracy')) {
      requireValue(typeof raw.accuracy === 'number' && Number.isFinite(raw.accuracy) && raw.accuracy >= 0 && raw.accuracy <= 100,
        'Accuracy must be a number from 0 to 100.');
      stats.accuracy = raw.accuracy;
    }
    return stats;
  }
  const roundStarted = (state, group) => Boolean(state.qualifier.rounds?.[group]?.scoringStarted ||
    (configured(state) ? Object.values(state.qualifier.rounds[group].results) : roster(state).filter(player => player.group === group)).some(recorded));
  function canChangeScoringMode(state) {
    const t = state.tournament, q = state.qualifier;
    return !t.seeded && !hasScores(state) && !state.result && !t.matches.length && !t.seeds.length && !t.drawLog.length &&
      !Object.keys(t.songHistory || {}).length && !state.correctionLog?.length && !q.scoringStarted &&
      !roster(state).some(player => player.tiePriority !== null) && !q.adjudications?.some(entry => entry.type !== 'set-player-readiness') &&
      !state.auditLog?.some(entry => ['set-qualifier-total', 'set-qualifier-score', 'set-qualifier-song-stats', 'set-qualifier-tiebreak-score', 'qualify', 'finalize-qualifier-round', 'seed-bracket', 'restore-backup'].includes(entry.type));
  }
  function setScoringMode(state, mode) {
    requireValue([CHALLENGE_MODE, 'legacy-score'].includes(mode), 'Choose Challenge Mode total or legacy individual scores.');
    requireValue(canChangeScoringMode(state), 'Change qualifier scoring only before any recorded scores, qualification or tournament history. Preserve this event and prepare a fresh event instead.');
    state.qualifier.scoringMode = mode;
    for (const row of [...roster(state), ...groups.flatMap(group => Object.values(state.qualifier.rounds?.[group]?.results || {}))]) {
      if (mode === CHALLENGE_MODE) row.challengeTotal = null;
      else delete row.challengeTotal;
    }
  }
  function result(state, group, playerId) {
    return configured(state) ? state.qualifier.rounds?.[group]?.results?.[playerId] : roster(state).find(player => player.id === playerId && player.group === group);
  }
  function activeTiebreak(state, group = state.qualifier.activeGroup) {
    const tie = configured(state) ? state.qualifier.rounds?.[group]?.tiebreaks?.at(-1) : null;
    return tie && !tie.confirmed ? tie : null;
  }
  function entries(state, group) {
    const ids = configured(state) ? new Set(state.qualifier.rounds?.[group]?.playerIds || []) : null;
    return roster(state).filter(player => eligible(player) && (ids ? ids.has(player.id) : player.group === group))
      .map(player => ({ ...player, group, ...result(state, group, player.id) })).sort(numberOrder);
  }
  function challengeDecision(left, right) {
    if (left === null || left === undefined || right === null || right === undefined || left === right) return { winnerIndex: null, reason: 'tie' };
    return { winnerIndex: left > right ? 0 : 1, reason: 'score' };
  }
  function baseDecision(state, a, b) {
    if (isChallenge(state)) return challengeDecision(a.challengeTotal, b.challengeTotal);
    const left = ScoreRules.total(a.scores), right = ScoreRules.total(b.scores);
    if (left !== right) return { winnerIndex: left > right ? 0 : 1, reason: 'score' };
    return ScoreRules.compare(a.scores, b.scores, a.judgements, b.judgements);
  }
  function decision(state, group, a, b) {
    let compared = baseDecision(state, a, b);
    if (compared.winnerIndex !== null || !configured(state)) return compared;
    // Missing base accuracy cannot be bypassed by an unrelated extra song.
    if (compared.reason === 'missing-accuracy') return compared;
    for (const round of state.qualifier.rounds[group].tiebreaks || []) {
      if (!round.confirmed || !round.playerIds.includes(a.id) || !round.playerIds.includes(b.id)) continue;
      compared = isChallenge(state) ? challengeDecision(round.scores[a.id], round.scores[b.id]) :
        ScoreRules.compare([round.scores[a.id]], [round.scores[b.id]], [round.judgements[a.id]], [round.judgements[b.id]]);
      if (compared.winnerIndex !== null || compared.reason === 'missing-accuracy') return compared;
    }
    return compared;
  }
  function rankings(state, group) {
    const legacy = !configured(state) && !isChallenge(state);
    const players = entries(state, group).map(player => ({ ...player, total: total(state, player),
      accuracy: isChallenge(state) ? null : ScoreRules.meanAccuracy(player.judgements || []), complete: complete(state, player) }));
    const compare = (a, b) => {
      if (isChallenge(state) && a.complete !== b.complete) return a.complete ? -1 : 1;
      if (legacy) return b.total - a.total || (a.tiePriority ?? 999) - (b.tiePriority ?? 999);
      const outcome = decision(state, group, a, b);
      return outcome.winnerIndex === 0 ? -1 : outcome.winnerIndex === 1 ? 1 : 0;
    };
    players.sort((a, b) => compare(a, b) || numberOrder(a, b));
    return players.map((player, index) => ({ ...player, rank: index + 1,
      tied: players.some(other => other.id !== player.id && (legacy ? other.total === player.total &&
        (other.tiePriority === null || player.tiePriority === null || other.tiePriority === player.tiePriority) : compare(player, other) === 0)) }));
  }
  function tiedSets(state, group) {
    const players = rankings(state, group), visited = new Set(), sets = [];
    for (const player of players) {
      if (visited.has(player.id) || !player.complete || !player.tied) continue;
      const connected = new Set([player.id]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const other of players) if (other.complete && !connected.has(other.id) && players.some(member => connected.has(member.id) && decision(state, group, member, other).winnerIndex === null)) {
          connected.add(other.id); expanded = true;
        }
      }
      connected.forEach(id => visited.add(id));
      if (connected.size > 1 && players.slice(0, 4).some(member => connected.has(member.id))) sets.push(players.filter(member => connected.has(member.id)).map(member => member.id));
    }
    return sets;
  }
  function seeds(state) {
    const q = state.qualifier;
    const ids = group => {
      const selected = configured(state) && q.rounds[group].locked ? q.rounds[group].qualifiedIds : rankings(state, group).slice(0, 4).map(player => player.id);
      return Array.from({ length: 4 }, (_, index) => {
        const id = selected[index];
        return id && roster(state).some(player => player.id === id && eligible(player)) ? id : null;
      });
    };
    const a = ids('A'), b = ids('B');
    return q.plan === 'A' ? [...a, ...b] : Array.from({ length: 4 }, (_, index) => [a[index] ?? null, b[index] ?? null]).flat();
  }
  function hasScores(state) {
    return state.qualifier.scoringStarted || roster(state).some(player => player.disqualification || recorded(player)) ||
      state.qualifier.incidents?.length || Object.keys(state.qualifier.waits || {}).length || groups.some(group =>
      Object.values(state.qualifier.rounds?.[group]?.results || {}).some(recorded) ||
      state.qualifier.rounds?.[group]?.scoringStarted || state.qualifier.rounds?.[group]?.locked || state.qualifier.rounds?.[group]?.tiebreaks?.length);
  }
  function assignMissingNumbers(state) {
    const used = new Set(roster(state).map(player => player.number).filter(Number.isSafeInteger));
    let next = 1;
    for (const player of roster(state)) if (!Number.isSafeInteger(player.number)) {
      while (used.has(next)) next++;
      player.number = next; used.add(next++);
    }
  }
  function makeRound(state, ids) {
    return { playerIds: [...ids], results: Object.fromEntries(ids.map(id => [id, emptyResult(state)])), qualifiedIds: [], locked: false, tiebreaks: [] };
  }
  function initialise(state, plan) {
    const q = state.qualifier;
    assignMissingNumbers(state); q.plan = plan;
    for (const player of roster(state)) player.group = plan === 'A' || player.number % 2 ? 'A' : 'B';
    q.rounds = { A: makeRound(state, roster(state).filter(player => plan === 'A' || player.number % 2).map(player => player.id)),
      B: makeRound(state, plan === 'A' ? [] : roster(state).filter(player => player.number % 2 === 0).map(player => player.id)) };
    q.activeGroup = 'A'; q.currentSong = 0; q.activePlayers = entries(state, 'A').slice(0, 3).map(player => player.id);
  }
  function finalize(state, group, assert) {
    const q = state.qualifier, round = q.rounds[group];
    assert(!round.locked, 'This qualifier round is already locked.');
    assert(q.plan !== 'A' || group !== 'B' || q.rounds.A.locked, 'Finalize the first qualifier round before the revival round.');
    const ranked = rankings(state, group);
    assert(ranked.length >= 4 && ranked.every(player => player.complete), 'Enter all eligible qualifier scores, with at least four players in the round.');
    assert(!ranked.slice(0, 4).some(player => player.tied), 'Compare accuracy and complete the remaining qualifier tiebreaks before qualification.');
    assert(!round.tiebreaks.some(tie => !tie.confirmed), 'Confirm the current qualifier tiebreak first.');
    round.qualifiedIds = ranked.slice(0, 4).map(player => player.id); round.locked = true;
    if (q.plan === 'A' && group === 'A') {
      const remaining = q.rounds.A.playerIds.filter(id => !round.qualifiedIds.includes(id));
      q.rounds.B = makeRound(state, remaining); q.activeGroup = 'B'; q.currentSong = 0;
      q.activePlayers = entries(state, 'B').slice(0, 3).map(player => player.id);
    }
  }
  function applyAction(state, action, helpers = {}) {
    const q = state.qualifier, p = action.payload || {}, assert = helpers.assert || requireValue;
    const score = helpers.score || (value => { if (value === null || value === '') return null; assert(Number.isSafeInteger(value) && value >= 0 && value <= 1000000, 'Scores must be integers from 0 to 1,000,000.'); return value; });
    const shuffled = helpers.shuffled || (values => { const array = [...values]; for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; });
    const findSong = id => helpers.findSong ? helpers.findSong(state, id) : (() => { const song = state.library.find(value => value.id === id); assert(song, 'Unknown song.'); return { ...song }; })();
    const setupOnly = () => assert(!state.tournament.seeded && !hasScores(state), 'Configure qualifier rules and numbers before scoring or seeding.');
    const group = p.group ?? q.activeGroup;
    const roundEditable = () => {
      assert(configured(state), 'Configure Plan A or Plan B first.');
      assert(groups.includes(group), 'Choose Group A or B.');
      assert(!state.tournament.seeded && !q.rounds[group].locked, 'Qualifier scores are locked after round qualification or seeding.');
    };
    const slotMetadata = (value, oldScore) => {
      if (value === null) return null;
      return Object.hasOwn(p, 'judgements') ? ScoreRules.normaliseJudgements(p.judgements) : value !== oldScore ? null : undefined;
    };
    switch (action.type) {
      case 'set-qualifier-scoring-mode': setScoringMode(state, p.mode); return true;
      case 'set-qualifier-song-stats': {
        assert(groups.includes(p.group) && p.group === q.activeGroup, 'Only the active qualifier group may have song statistics entered.');
        assert(!state.tournament.seeded && !q.rounds?.[group]?.locked, 'Qualifier statistics are locked after round qualification or seeding.');
        assert(!q.rounds?.[group]?.tiebreaks?.length, 'Base song statistics are locked after a qualifier tiebreak starts.');
        assert(!isChallenge(state) || configured(state), 'Configure Plan A or Plan B before entering Challenge Mode song statistics.');
        assert(Number.isInteger(p.songIndex) && p.songIndex >= 0 && p.songIndex < 3, 'Invalid qualifier song number.');
        assert(q.groups[group]?.songs[p.songIndex], 'Choose the qualifier songs first.');
        const player = entries(state, group).find(value => value.id === p.playerId);
        assert(player, 'Player is not eligible in this qualifier round.');
        const stats = normaliseSongStats(p.stats), row = result(state, group, player.id);
        row.songStats ??= Array(3).fill(null);
        row.songStats[p.songIndex] = stats;
        if (stats !== null) {
          q.scoringStarted = true;
          row.songStatsRecorded = true;
          if (q.rounds?.[group]) q.rounds[group].scoringStarted = true;
        }
        return true;
      }
      case 'set-qualifier-total': {
        assert(isChallenge(state), 'Use Challenge Mode total scoring for this command.');
        assert(configured(state), 'Configure Plan A or Plan B before entering Challenge Mode totals.');
        assert(groups.includes(group), 'Choose Group A or B.');
        roundEditable();
        const player = entries(state, group).find(value => value.id === p.playerId);
        assert(player, 'Player is not eligible in this qualifier round.');
        assert(!Object.hasOwn(p, 'judgements') && !Object.hasOwn(p, 'score') && !Object.hasOwn(p, 'songIndex'), 'Enter only the total shown by Challenge Mode.');
        const row = result(state, group, player.id), value = challengeTotal(p.total), changed = value !== row.challengeTotal;
        const invalidatedTiebreaks = q.rounds?.[group]?.tiebreaks || [];
        if (changed && invalidatedTiebreaks.length) {
          assert(p.confirmClearTiebreaks === true && p.verified === true, 'An arbiter must explicitly confirm this base-score correction and clearing the qualifier tiebreaks.');
          assert(typeof p.reason === 'string' && p.reason.trim().length >= 8 && p.reason.trim().length <= 500, 'Record a meaningful correction reason (8–500 characters) before clearing qualifier tiebreaks.');
          assert((q.adjudications || []).length < 10000, 'Qualifier adjudication history limit reached.');
          const now = typeof helpers.now === 'function' ? helpers.now() : (helpers.now ?? Date.now()), at = new Date(now);
          assert(Number.isFinite(at.getTime()), 'The correction time is invalid.');
          (q.adjudications ||= []).push({ type: action.type, at: at.toISOString(), group, playerId: player.id,
            scoringMode: CHALLENGE_MODE, previousChallengeTotal: row.challengeTotal, note: p.reason.trim(),
            invalidatedTiebreaks: structuredClone(invalidatedTiebreaks) });
        }
        row.challengeTotal = value;
        if (value !== null) { q.scoringStarted = true; q.rounds[group].scoringStarted = true; }
        if (changed && q.rounds?.[group]) q.rounds[group].tiebreaks = [];
        return true;
      }
      case 'set-qualifier-score': if (isChallenge(state)) throw new Error('Enter the Challenge Mode total once for the three-song set.'); break;
      case 'set-tie-priority': if (isChallenge(state)) throw new Error('Challenge Mode ties require recorded tiebreak songs.'); break;
      case 'set-competition-roster': {
        setupOnly(); assert(Array.isArray(p.names) && p.names.length <= 64, 'Provide up to 64 player names.');
        const names = p.names.map(value => { assert(typeof value === 'string', 'Expected a player name.'); return value.trim().slice(0, 48); }).filter(Boolean);
        assert(unique(names), 'Player names must be unique.');
        const old = roster(state);
        q.players = names.map((name, index) => {
          const existing = old.find(player => player.name === name);
          if (existing) return existing;
          const id = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          return { id, name, group: index % 2 ? 'B' : 'A', ...emptyResult(state), tiePriority: null };
        });
        if (q.readiness) q.readiness = Object.fromEntries(Object.entries(q.readiness).filter(([id]) => q.players.some(player => player.id === id)));
        assignMissingNumbers(state);
        // A prepared roster can still cross the proposal's 20-player boundary.
        // Derive the format again before any results lock the setup.
        if (configured(state)) initialise(state, planForCount(q.players.length));
        else q.activePlayers = q.activePlayers.filter(id => q.players.some(player => player.id === id));
        return true;
      }
      case 'set-qualifier-plan': {
        setupOnly(); assert(['auto', 'A', 'B'].includes(p.plan), 'Choose Auto, Plan A or Plan B.');
        const count = roster(state).length;
        const plan = p.plan === 'auto' ? planForCount(count) : p.plan;
        assert(plan === 'A' ? count <= 20 : count > 20, plan === 'A' ? 'Plan A applies to 20 or fewer competitors.' : 'Plan B applies to more than 20 competitors.');
        initialise(state, plan); return true;
      }
      case 'draw-player-numbers': {
        setupOnly(); const numbers = shuffled(Array.from({ length: roster(state).length }, (_, index) => index + 1));
        roster(state).forEach((player, index) => { player.number = numbers[index]; });
        if (configured(state)) initialise(state, q.plan);
        return true;
      }
      case 'set-player-number': {
        setupOnly(); const player = roster(state).find(value => value.id === p.playerId); assert(player, 'Unknown player.');
        assert(Number.isSafeInteger(p.number) && p.number >= 1 && p.number <= 64, 'Player number must be 1–64.');
        assert(!roster(state).some(value => value.id !== player.id && value.number === p.number), 'Player numbers must be unique.');
        player.number = p.number;
        if (configured(state)) initialise(state, q.plan);
        return true;
      }
      case 'next-qualifier-batch': {
        const tie = activeTiebreak(state), list = entries(state, q.activeGroup).filter(player => !tie || tie.playerIds.includes(player.id) && tie.scores[player.id] === null);
        const indices = q.activePlayers.map(id => list.findIndex(player => player.id === id)).filter(index => index >= 0);
        const next = indices.length ? Math.max(...indices) + 1 : 0;
        q.activePlayers = list.slice(next >= list.length ? 0 : next, (next >= list.length ? 0 : next) + 3).map(player => player.id);
        if (!tie) q.currentSong = 0;
        return true;
      }
      case 'finalize-qualifier-round':
        roundEditable(); assert(p.verified === true, 'An arbiter must double-check the qualifier scores before confirming.');
        finalize(state, group, assert); return true;
      case 'draw-qualifier-tiebreak': {
        roundEditable(); const round = q.rounds[group];
        assert(!round.tiebreaks.some(value => !value.confirmed), 'Complete and confirm the current tiebreak before drawing again.');
        assert(Array.isArray(p.playerIds) && p.playerIds.length >= 2 && unique(p.playerIds), 'Choose the unresolved tied players.');
        const tied = tiedSets(state, group).find(ids => ids.length === p.playerIds.length && ids.every(id => p.playerIds.includes(id)));
        assert(tied, 'Choose all players in one unresolved qualifier tie affecting the top four.');
        const players = entries(state, group).filter(player => tied.includes(player.id));
        assert(isChallenge(state) || players.every(player => ScoreRules.meanAccuracy(player.judgements || []) !== null), 'Enter every tied player’s original accuracy before drawing a tiebreak.');
        assert(state.library.length > 0, 'Add the full available Phigros song list to the local library for qualifier tiebreaks.');
        assert(round.tiebreaks.length < 1000, 'Qualifier tiebreak history limit reached.');
        const song = { ...shuffled(state.library)[0] };
        round.tiebreaks.push({ song, playerIds: [...tied], scores: Object.fromEntries(tied.map(id => [id, null])),
          judgements: Object.fromEntries(tied.map(id => [id, null])), confirmed: false });
        q.activeGroup = group; q.currentSong = 0;
        q.activePlayers = players.sort(numberOrder).slice(0, 3).map(player => player.id);
        return true;
      }
      case 'set-qualifier-tiebreak-score': {
        roundEditable(); const rounds = q.rounds[group].tiebreaks;
        assert(Number.isInteger(p.index) && p.index === rounds.length - 1, 'Choose the current qualifier tiebreak.');
        const tie = rounds[p.index]; assert(tie && !tie.confirmed && tie.playerIds.includes(p.playerId), 'This qualifier tiebreak score is locked or the player is not eligible.');
        assert(eligible(roster(state).find(player => player.id === p.playerId)), 'A disqualified player cannot be scored.');
        const value = score(p.score), metadata = slotMetadata(value, tie.scores[p.playerId]);
        tie.scores[p.playerId] = value;
        if (metadata !== undefined) tie.judgements[p.playerId] = metadata;
        return true;
      }
      case 'confirm-qualifier-tiebreak': {
        roundEditable(); const rounds = q.rounds[group].tiebreaks;
        assert(p.verified === true, 'An arbiter must double-check the tiebreak scores before confirming.');
        assert(Number.isInteger(p.index) && p.index === rounds.length - 1, 'Choose the current qualifier tiebreak.');
        const tie = rounds[p.index]; assert(tie && !tie.confirmed, 'This tiebreak is already confirmed.');
        assert(tie.playerIds.every(id => eligible(roster(state).find(player => player.id === id))), 'A disqualified player’s unfinished tiebreak must be cancelled before confirming.');
        assert(tie.playerIds.every(id => tie.scores[id] !== null), 'Enter every tiebreak score.');
        for (let a = 0; a < tie.playerIds.length; a++) for (let b = a + 1; b < tie.playerIds.length; b++) {
          const left = tie.playerIds[a], right = tie.playerIds[b];
          assert(isChallenge(state) || ScoreRules.compare([tie.scores[left]], [tie.scores[right]], [tie.judgements[left]], [tie.judgements[right]]).reason !== 'missing-accuracy', 'Enter original accuracy for equal tiebreak scores.');
        }
        tie.confirmed = true; return true;
      }
      default: break;
    }
    if (!configured(state)) return false;
    switch (action.type) {
      case 'randomise-groups': throw new Error('Plan B groups follow odd/even player numbers. Use Draw player numbers before scoring.');
      case 'set-roster': throw new Error('Use the combined competition roster before scoring when Plan A or B is configured.');
      case 'set-tie-priority': throw new Error('Proposal qualifier ties use accuracy and recorded tiebreak songs.');
      case 'set-qualifier-display': {
        if (p.group !== undefined) {
          assert(groups.includes(p.group), 'Invalid group.');
          assert(q.plan !== 'A' || p.group !== 'B' || q.rounds.A.locked, 'Finalize the first round before displaying the revival round.');
          q.activeGroup = p.group;
          const tie = activeTiebreak(state, p.group);
          q.activePlayers = tie ? entries(state, p.group).filter(player => tie.playerIds.includes(player.id)).slice(0, 3).map(player => player.id) : [];
        }
        if (p.players !== undefined) {
          assert(Array.isArray(p.players) && p.players.length <= 3 && unique(p.players), 'Choose up to three different players.');
          const tie = activeTiebreak(state), ids = new Set(entries(state, q.activeGroup).filter(player => !tie || tie.playerIds.includes(player.id)).map(player => player.id));
          assert(p.players.every(id => ids.has(id)), 'Displayed players must be eligible in the active qualifier round.');
          q.activePlayers = [...p.players];
        }
        if (p.currentSong !== undefined) { assert(Number.isInteger(p.currentSong) && p.currentSong >= 0 && p.currentSong < 3, 'Invalid song number.'); q.currentSong = p.currentSong; }
        return true;
      }
      case 'set-qualifier-songs': {
        roundEditable(); assert(Array.isArray(p.ids) && p.ids.length === 3 && unique(p.ids), 'Choose three different songs.');
        assert(!roundStarted(state, group), 'Qualifier songs are locked after this round starts scoring.');
        const other = q.groups[group === 'A' ? 'B' : 'A'].songs;
        assert(!p.ids.some(id => other.includes(id)), 'The two qualifier rounds must use different songs.');
        p.ids.forEach(findSong); q.groups[group].songs = [...p.ids]; return true;
      }
      case 'set-qualifier-score': {
        roundEditable(); const player = entries(state, group).find(value => value.id === p.playerId); assert(player, 'Player is not eligible in this qualifier round.');
        assert(Number.isInteger(p.songIndex) && p.songIndex >= 0 && p.songIndex < 3, 'Invalid song number.');
        const row = result(state, group, player.id), value = score(p.score), metadata = slotMetadata(value, row.scores[p.songIndex]);
        const previousJudgements = row.judgements[p.songIndex];
        const changed = value !== row.scores[p.songIndex] || metadata !== undefined &&
          JSON.stringify(ScoreRules.normaliseJudgements(metadata)) !== JSON.stringify(ScoreRules.normaliseJudgements(previousJudgements));
        const invalidatedTiebreaks = q.rounds[group].tiebreaks;
        if (changed && invalidatedTiebreaks.length) {
          assert(p.confirmClearTiebreaks === true && p.verified === true,
            'An arbiter must explicitly confirm this base-score correction and clearing the qualifier tiebreaks.');
          assert(typeof p.reason === 'string' && p.reason.trim().length >= 8 && p.reason.trim().length <= 500,
            'Record a meaningful correction reason (8–500 characters) before clearing qualifier tiebreaks.');
          assert((q.adjudications || []).length < 10000, 'Qualifier adjudication history limit reached.');
          const now = typeof helpers.now === 'function' ? helpers.now() : (helpers.now ?? Date.now());
          const time = new Date(now);
          assert(Number.isFinite(time.getTime()), 'The correction time is invalid.');
          (q.adjudications ||= []).push({ type: action.type, at: time.toISOString(), group, playerId: player.id,
            songIndex: p.songIndex, songId: q.groups[group].songs[p.songIndex], reason: p.reason.trim(), note: p.reason.trim(),
            previousScore: row.scores[p.songIndex], previousJudgements: structuredClone(previousJudgements),
            invalidatedTiebreaks: structuredClone(invalidatedTiebreaks) });
        }
        row.scores[p.songIndex] = value;
        if (metadata !== undefined) row.judgements[p.songIndex] = metadata;
        if (changed) q.rounds[group].tiebreaks = [];
        return true;
      }
      case 'qualify': {
        assert(!state.tournament.seeded, 'Bracket already seeded.');
        assert(p.verified === true, 'An arbiter must double-check the qualifier scores before confirming.');
        assert(q.plan !== 'A' || q.rounds.A.locked, 'Finalize the first qualifier round before advancing the revival winners.');
        // Validate both groups before locking either; a failed command must not partially qualify.
        for (const key of groups) if (!q.rounds[key].locked) {
          const ranked = rankings(state, key);
          assert(ranked.length >= 4 && ranked.every(player => player.complete), 'Enter all eligible qualifier scores, with at least four players in the round.');
          assert(!ranked.slice(0, 4).some(player => player.tied) && !q.rounds[key].tiebreaks.some(tie => !tie.confirmed), 'Compare accuracy and complete the remaining qualifier tiebreaks before qualification.');
        }
        assert(typeof helpers.createBracket === 'function', 'The tournament bracket helper is unavailable.');
        for (const key of groups) if (!q.rounds[key].locked) finalize(state, key, assert);
        state.tournament = helpers.createBracket(seeds(state)); state.tournament.ruleset = 'proposal-2026'; state.stage = 'double-elimination';
        return true;
      }
      default: return false;
    }
  }
  return { CHALLENGE_MODE, MAX_CHALLENGE_TOTAL, isChallenge, challengeTotal, normaliseSongStats, total, complete, recorded, roundStarted, canChangeScoringMode, setScoringMode,
    configured, entries, rankings, seeds, result, tiedSets, activeTiebreak, hasScores, applyAction };
});
