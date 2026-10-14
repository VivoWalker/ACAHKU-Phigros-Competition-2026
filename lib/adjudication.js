// Staff decisions are explicit commands. A deadline never disqualifies a player
// by itself, and the tournament resolver owns any resulting bracket vacancies.
const WAIT_MS = 10 * 60 * 1000;
const WAIT_REASONS = ['absence', 'chart-unlock'];
const DISQUALIFICATION_REASONS = [...WAIT_REASONS, 'headphones', 'rule-violation', 'score-unavailable', 'other'];
const REMATCH_REASONS = ['game-error', 'score-page-left'];
const READINESS_KEYS = ['device', 'globalVersion', 'headphones', 'charts', 'streamConsent'];
const SongPool = require('../public/js/song-pool');
const QualifierRules = require('../public/js/qualifier-rules');
const ACTIONS = new Set(['start-player-wait', 'cancel-player-wait', 'disqualify-player', 'authorize-song-rematch', 'set-player-readiness']);

function readinessCount(state, playerId) {
  const records = state.qualifier.readiness || {};
  const ids = playerId === undefined ? state.qualifier.players.map(player => player.id) : [playerId];
  return ids.reduce((count, id) => count + READINESS_KEYS.filter(key => records[id]?.[key] === true).length, 0);
}

function applyAction(state, action, helpers = {}) {
  if (!ACTIONS.has(action?.type)) return false;
  const p = action.payload || {}, q = state.qualifier;
  const check = helpers.assert || ((valid, message) => { if (!valid) throw new Error(message); });
  const cleanText = helpers.text || ((value, max = 120) => {
    check(typeof value === 'string', 'Expected text.'); return value.trim().slice(0, max);
  });
  const timestamp = typeof helpers.now === 'function' ? helpers.now() : (helpers.now ?? Date.now());
  const now = new Date(timestamp);
  check(Number.isFinite(now.getTime()), 'The staff decision time is invalid.');
  const at = now.toISOString();
  const player = id => {
    const found = q.players.find(entry => entry.id === id);
    check(found, 'Unknown player.'); return found;
  };
  const eligible = entry => check(!entry.disqualification, 'This player has already been disqualified.');
  const log = entry => { (q.adjudications ||= []).push({ type: action.type, at, ...entry }); };
  const rules = () => helpers.qualifierRules || require('../public/js/qualifier-rules');
  const inCurrentField = entry => {
    if (state.stage === 'qualifier') {
      check(!state.tournament.seeded, 'Qualifier adjudications are locked after seeding.');
      check(['A', 'B'].includes(q.activeGroup), 'Choose the current qualifier round.');
      if (q.plan) {
        check(q.rounds?.[q.activeGroup] && !q.rounds[q.activeGroup].locked, 'This qualifier round is locked.');
        check(rules().entries(state, q.activeGroup).some(candidate => candidate.id === entry.id),
          'This player is not in the current qualifier round.');
      } else check(entry.group === q.activeGroup, 'This player is not in the current qualifier group.');
    } else {
      check(state.stage === 'double-elimination', 'Choose the competition stage first.');
      const match = helpers.getMatch(state);
      helpers.playable(match);
      check(match.players.includes(entry.id), 'This player is not in the current match.');
    }
  };

  switch (action.type) {
    case 'set-player-readiness': {
      player(p.playerId);
      for (const key of READINESS_KEYS) check(typeof p[key] === 'boolean', `Confirm ${key} with a boolean.`);
      const record = Object.fromEntries(READINESS_KEYS.map(key => [key, p[key]]));
      (q.readiness ||= {})[p.playerId] = { ...record, at };
      log({ playerId: p.playerId, ...record });
      break;
    }
    case 'start-player-wait': {
      const entry = player(p.playerId); eligible(entry); inCurrentField(entry);
      check(WAIT_REASONS.includes(p.reason), 'A ten-minute wait is only for absence or chart unlocking.');
      check(!q.waits?.[entry.id], 'A wait is already running. Cancel it before recording a new incident.');
      let songId;
      if (p.songId !== undefined) {
        check(p.reason === 'chart-unlock', 'Only chart unlocking needs a song.');
        const song = state.library.find(song => song.id === p.songId);
        check(song, 'Unknown song.'); songId = song.id;
      }
      const record = { reason: p.reason, startsAt: at, deadline: new Date(now.getTime() + WAIT_MS).toISOString(),
        ...(songId ? { songId } : {}) };
      (q.waits ||= {})[entry.id] = record;
      log({ playerId: entry.id, ...record });
      break;
    }
    case 'cancel-player-wait': {
      const entry = player(p.playerId), wait = q.waits?.[entry.id];
      check(wait, 'This player has no running wait.');
      delete q.waits[entry.id];
      log({ playerId: entry.id, reason: wait.reason, startsAt: wait.startsAt, deadline: wait.deadline });
      break;
    }
    case 'disqualify-player': {
      const entry = player(p.playerId); eligible(entry);
      check(DISQUALIFICATION_REASONS.includes(p.reason), 'Choose a supported disqualification reason.');
      const note = cleanText(p.note ?? '', 500);
      if (WAIT_REASONS.includes(p.reason)) {
        const wait = q.waits?.[entry.id];
        check(wait && wait.reason === p.reason, 'Record the matching ten-minute wait before disqualifying this player.');
        check(Number.isFinite(Date.parse(wait.deadline)) && now.getTime() >= Date.parse(wait.deadline),
          'The ten-minute waiting period has not ended.');
      } else {
        check(note.length > 0, 'Record the arbiter decision and its reason.');
        if (['other', 'rule-violation', 'score-unavailable'].includes(p.reason))
          check(note.length >= 8, 'Record a meaningful ACAHKU adjudication note.');
      }
      entry.disqualification = { reason: p.reason, at, note };
      if (q.waits) delete q.waits[entry.id];
      q.activePlayers = q.activePlayers.filter(id => id !== entry.id);
      const cancelledTiebreaks = [];
      for (const group of ['A', 'B']) {
        const round = q.rounds?.[group];
        if (!round || round.locked || !round.tiebreaks) continue;
        round.tiebreaks = round.tiebreaks.filter((tie, index) => {
          if (tie.confirmed || !tie.playerIds.includes(entry.id)) return true;
          cancelledTiebreaks.push({ group, index, tiebreak: structuredClone(tie) }); return false;
        });
      }
      log({ playerId: entry.id, reason: p.reason, note, ...(cancelledTiebreaks.length ? { cancelledTiebreaks } : {}) });
      // Completed results and all recorded scores remain historical evidence.
      // Root resolveBracket masks this player from every future source and
      // applies the proposal's ordinary forfeit / four-player lottery rules.
      break;
    }
    case 'authorize-song-rematch': {
      check(REMATCH_REASONS.includes(p.reason), 'A rematch is only for a game error or an unavailable score page.');
      const note = cleanText(p.note ?? '', 500);
      check(note.length > 0, 'Record why the arbiter authorised the rematch.');
      for (const key of ['videoChecked', 'unintentional', 'allAgree'])
        check(typeof p[key] === 'boolean', `Confirm ${key} with a boolean.`);
      if (p.reason === 'score-page-left') check(p.videoChecked && p.unintentional && p.allAgree,
        'First check the livestream record; an unintentional missing score requires every player to agree to the rematch.');
      check(p.stage === state.stage, 'The competition stage changed. Refresh the incident before trying again.');
      check(Number.isInteger(p.songIndex) && p.songIndex >= 0, 'Choose the song to replay.');
      const record = { songIndex: p.songIndex, reason: p.reason, videoChecked: p.videoChecked,
        unintentional: p.unintentional, allAgree: p.allAgree, note, at };
      if (p.tiebreakIndex !== undefined) {
        check(Number.isInteger(p.tiebreakIndex) && p.tiebreakIndex >= 0 && p.songIndex === 0, 'Choose the current tiebreak song.');
        if (p.stage === 'qualifier') {
          const entry = player(p.playerId); eligible(entry); inCurrentField(entry);
          check(p.group === q.activeGroup, 'The qualifier round changed. Refresh the incident.');
          const ties = q.rounds?.[p.group]?.tiebreaks || [], tie = ties[p.tiebreakIndex];
          check(tie && !tie.confirmed && p.tiebreakIndex === ties.length - 1 && tie.playerIds.includes(entry.id), 'Only the current unconfirmed tiebreak may be replayed.');
          check(!(q.incidents || []).some(incident => incident.group === p.group && incident.playerId === entry.id && incident.tiebreakIndex === p.tiebreakIndex), 'This player has already used this tiebreak rematch.');
          const saved = { score: tie.scores[entry.id], judgements: structuredClone(tie.judgements[entry.id]) };
          tie.scores[entry.id] = null; tie.judgements[entry.id] = null;
          const incident = { ...record, group: p.group, playerId: entry.id, songId: tie.song.id, tiebreakIndex: p.tiebreakIndex };
          (q.incidents ||= []).push(incident); log({ stage: p.stage, ...incident,
            ...(QualifierRules.isChallenge(state) ? { scoringMode: q.scoringMode } : {}), previousResult: saved });
        } else {
          check(p.stage === 'double-elimination' && p.matchId === state.tournament.currentMatchId, 'The current match changed.');
          const match = helpers.getMatch(state, p.matchId); helpers.playable(match);
          const ties = match.tiebreaks || [], tie = ties[p.tiebreakIndex];
          check(tie && !tie.confirmed && p.tiebreakIndex === ties.length - 1 && match.players.every(Boolean), 'Only the current unconfirmed tiebreak may be replayed.');
          match.players.forEach(id => eligible(player(id)));
          check(!(match.rematches || []).some(incident => incident.tiebreakIndex === p.tiebreakIndex), 'The shared rematch for this tiebreak has already been used.');
          const saved = { scores: [...tie.scores], judgements: structuredClone(tie.judgements) };
          tie.scores = [null, null]; tie.judgements = [null, null];
          const incident = { ...record, matchId: match.id, songId: tie.song.id, tiebreakIndex: p.tiebreakIndex };
          (match.rematches ||= []).push(incident); log({ stage: p.stage, ...incident, previousResult: saved });
        }
        break;
      }
      if (p.stage === 'qualifier') {
        const entry = player(p.playerId); eligible(entry); inCurrentField(entry);
        check(p.group === q.activeGroup, 'The qualifier round changed. Refresh the incident before trying again.');
        check(p.songIndex < 3, 'Choose one of the three qualifier songs.');
        const songId = q.groups[p.group]?.songs[p.songIndex];
        check(songId, 'Choose the qualifier songs before authorising a rematch.');
        check(!(q.incidents || []).some(incident => incident.tiebreakIndex === undefined && incident.group === p.group && incident.playerId === entry.id &&
          (incident.songId === songId || incident.songIndex === p.songIndex)), 'This player has already used the rematch for this song in this qualifier round.');
        const result = q.plan ? rules().result(state, p.group, entry.id) : entry;
        check(result && Array.isArray(result.scores) && p.songIndex < result.scores.length, 'The qualifier result is unavailable.');
        const invalidatedTiebreaks = structuredClone(q.rounds?.[p.group]?.tiebreaks || []);
        const previousResult = QualifierRules.isChallenge(state) ? { challengeTotal: result.challengeTotal } : null;
        if (q.rounds?.[p.group]?.tiebreaks) q.rounds[p.group].tiebreaks = [];
        result.scores[p.songIndex] = null;
        if (result.judgements) result.judgements[p.songIndex] = null;
        if (QualifierRules.isChallenge(state)) result.challengeTotal = null;
        const incident = { ...record, group: p.group, playerId: entry.id, songId };
        (q.incidents ||= []).push(incident);
        log({ stage: p.stage, ...incident, ...(previousResult ? { scoringMode: q.scoringMode, previousResult } : {}),
          ...(invalidatedTiebreaks.length ? { invalidatedTiebreaks } : {}) });
      } else {
        check(p.stage === 'double-elimination', 'Choose the competition stage.');
        check(typeof p.matchId === 'string' && p.matchId === state.tournament.currentMatchId,
          'The current match changed. Refresh the incident before trying again.');
        const match = helpers.getMatch(state, p.matchId); helpers.playable(match);
        check(match.players.length === 2 && match.players.every(Boolean), 'A rematch needs both players in the current match.');
        match.players.forEach(id => eligible(player(id)));
        const song = match.songs[p.songIndex];
        check(song && p.songIndex < match.scores[0].length, 'Select the match song before authorising a rematch.');
        check(match.id !== 'GF' || p.songIndex < 2 || match.hostRevealed,
          'Reveal the host song before authorising its rematch.');
        check(!(match.rematches || []).some(incident => incident.tiebreakIndex === undefined && (incident.songId === song.id || incident.songIndex === p.songIndex)),
          'The shared rematch for this song has already been used in this match.');
        const invalidatedTiebreaks = structuredClone(match.tiebreaks || []);
        SongPool.remember(match);
        if (match.tiebreaks) match.tiebreaks = [];
        match.scores.forEach(row => { row[p.songIndex] = null; });
        if (match.judgements) match.judgements.forEach(row => { row[p.songIndex] = null; });
        const incident = { ...record, matchId: match.id, songId: song.id };
        (match.rematches ||= []).push(incident);
        log({ stage: p.stage, ...incident, ...(invalidatedTiebreaks.length ? { invalidatedTiebreaks } : {}) });
      }
      break;
    }
  }
  return true;
}

module.exports = { applyAction, readinessCount, WAIT_MS, WAIT_REASONS, DISQUALIFICATION_REASONS, REMATCH_REASONS, READINESS_KEYS };
