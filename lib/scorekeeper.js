const QualifierRules = require('../public/js/qualifier-rules');
const ScoreRules = require('../public/js/score-rules');
const FinalSequence = require('../public/js/final-sequence');

const SCORE_ACTIONS = new Set(['set-qualifier-challenge-result', 'set-qualifier-total', 'set-qualifier-score', 'set-match-score', 'set-qualifier-tiebreak-score', 'set-match-tiebreak-score']);
function failure(message, code = 'FORBIDDEN') { const error = new Error(message); error.code = code; return error; }
function songView(song) {
  return song ? { id: song.id, title: song.title, difficulty: song.difficulty, level: song.level } :
    { id: null, title: '尚未選曲', difficulty: '', level: null };
}
function scoreRow(row, count, sealed = false) {
  return Array.from({ length: count }, (_, index) => sealed && index === 2 ? null : row?.[index] ?? null);
}
function playerView(player, scores, judgements) {
  return { id: player?.id ?? null, name: player?.name || '待定／空位', group: player?.group, number: player?.number ?? null,
    scores, judgements, total: ScoreRules.total(scores), accuracy: ScoreRules.meanAccuracy(judgements), disqualified: !!player?.disqualification || !!player?.disqualified };
}
function activeTiebreak(tiebreaks) {
  const index = (tiebreaks?.length || 0) - 1, round = tiebreaks?.[index];
  return round && !round.confirmed ? { index, round } : null;
}
function scorekeeperState(state) {
  const q = state.qualifier, group = q.activeGroup, round = q.plan ? q.rounds?.[group] : null;
  const entries = QualifierRules.entries(state, group);
  const qualifier = {
    scoringMode: q.scoringMode || 'legacy-score',
    needsPlan: QualifierRules.isChallenge(state) && !q.plan,
    lockedReason: QualifierRules.isChallenge(state) && !q.plan ? '請由主控先設定 Plan A 或 Plan B，再錄入課題模式總分。' : '',
    activeGroup: group, plan: q.plan || null, currentSong: q.currentSong, locked: !!state.tournament.seeded || !!round?.locked,
    baseLocked: !!round?.tiebreaks?.length,
    baseLockedReason: round?.tiebreaks?.length ? '加賽開始後，原有三首分數已鎖定；如需修正，請由主控核對並處理加賽紀錄。' : '',
    songs: (q.groups[group]?.songs || []).map(id => songView(state.library.find(song => song.id === id))),
    players: q.activePlayers.map(id => entries.find(player => player.id === id)).filter(Boolean).map(player => ({ ...playerView(player, scoreRow(player.scores, 3), scoreRow(player.judgements, 3)),
      ...(QualifierRules.isChallenge(state) ? { challengeTotal: player.challengeTotal ?? null, total: QualifierRules.total(state, player), accuracy: null,
        songStats: Array.from({ length: 3 }, (_, index) => player.songStats?.[index] ? { ...player.songStats[index] } : null) } : {}) })),
    activePlayers: [...q.activePlayers]
  };
  const qualifierTie = activeTiebreak(round?.tiebreaks);
  if (qualifierTie && !qualifier.locked) {
    const tie = qualifierTie.round;
    qualifier.tiebreak = { index: qualifierTie.index, song: songView(tie.song), confirmed: false,
      players: (tie.playerIds || []).map(id => {
        const player = entries.find(item => item.id === id);
        return playerView(player, [tie.scores?.[id] ?? null], [tie.judgements?.[id] ?? null]);
      }) };
  }
  const current = state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
  let match = null;
  if (current) {
    const fixed = current.finalMode === 'fixed-two', count = FinalSequence.songCount(current);
    const sealed = current.id === 'GF' && (FinalSequence.isEnabled(current) ? FinalSequence.phase(current).concealed : !fixed && !current.hostRevealed);
    match = {
      id: current.id, label: current.label, round: current.round, status: current.status, currentSong: current.currentSong,
      ...(fixed ? { finalMode: 'fixed-two' } : {}),
      players: current.players.map((id, index) => playerView(q.players.find(player => player.id === id), scoreRow(current.scores[index], count, sealed), scoreRow(current.judgements?.[index], count, sealed))),
      songs: Array.from({ length: count }, (_, index) => sealed && index === 2 ?
        { id: 'sealed', title: FinalSequence.isEnabled(current) ? 'FINAL SONG — SEALED' : 'MC PICK — SEALED', difficulty: '', level: null, hidden: true } : songView(current.songs[index])),
      locked: current.status === 'complete' || current.status === 'pending' || !current.players.every(Boolean) || current.songs.length !== count
    };
    match.baseLocked = !!current.tiebreaks?.length;
    match.baseLockedReason = match.baseLocked ? '加賽開始後，原有比賽分數已鎖定；如需修正，請由主控重新開啟或重設此場比賽。' : '';
    const matchTie = activeTiebreak(current.tiebreaks);
    if (matchTie && !match.locked && !sealed) {
      const tie = matchTie.round;
      match.tiebreak = { index: matchTie.index, song: songView(tie.song), confirmed: false,
        players: match.players.map((player, index) => playerView(player, [tie.scores?.[index] ?? null], [tie.judgements?.[index] ?? null])) };
    }
  }
  const playersKey = players => players.map(player => [player.id, player.name, player.number, player.disqualified]);
  const songsKey = songs => songs.map(song => [song.id, song.title, song.difficulty, song.level]);
  const tiesKey = source => [source?.tiebreak?.index ?? null, source?.tiebreak?.confirmed ?? null,
    songsKey(source?.tiebreak ? [source.tiebreak.song] : []), playersKey(source?.tiebreak?.players || [])];
  const key = state.stage === 'qualifier' ?
    [state.stage, group, qualifier.plan, qualifier.scoringMode, [...q.activePlayers], playersKey(qualifier.players), songsKey(qualifier.songs), qualifier.locked,
      q.plan ? [round?.playerIds || [], round?.qualifiedIds || [], (round?.tiebreaks || []).map(tie => !!tie.confirmed)] : null, tiesKey(qualifier), (q.incidents || []).filter(incident => incident.group === group).map(incident => [incident.playerId, incident.songIndex])] :
    [state.stage, match?.id || null, playersKey(match?.players || []), songsKey(match?.songs || []), Boolean(current?.hostRevealed), match?.status || null,
      (current?.tiebreaks || []).map(tie => !!tie.confirmed), tiesKey(match), (current?.rematches || []).map(incident => incident.songIndex)];
  return {
    eventId: state.eventId, revision: state.revision, event: { title: state.event.title, titleZH: state.event.titleZH || state.event.title },
    stage: state.stage, contextKey: JSON.stringify(key), qualifier, match
  };
}
function scorekeeperAction(state, request) {
  const action = request?.action;
  if (!SCORE_ACTIONS.has(action?.type)) throw failure('Scorekeepers may only enter scores.');
  const view = scorekeeperState(state);
  if (request.contextKey !== view.contextKey) throw failure('The scoring group, players or selected songs changed. Review the current scoring sheet.', 'CONTEXT_CHANGED');
  const p = action.payload || {};
  const metadata = Object.prototype.hasOwnProperty.call(p, 'judgements') ? { judgements: ScoreRules.normaliseJudgements(p.judgements) } : {};
  if (action.type.startsWith('set-qualifier-')) {
    if (state.stage !== 'qualifier') throw failure('Only the current qualifier batch may be scored.');
    if (view.qualifier.locked) throw failure('The current qualifier round is locked.', 'INVALID');
    if (view.qualifier.needsPlan) throw failure(view.qualifier.lockedReason, 'INVALID');
    if (action.type === 'set-qualifier-tiebreak-score') {
      const tie = view.qualifier.tiebreak;
      if (!tie || p.group !== view.qualifier.activeGroup || p.index !== tie.index || !tie.players.some(player => player.id === p.playerId && !player.disqualified)) {
        throw failure('Only the active qualifier tiebreak may be scored.');
      }
      return { type: action.type, payload: { group: p.group, index: p.index, playerId: p.playerId, score: p.score, ...metadata } };
    }
    if (view.qualifier.baseLocked) throw failure(view.qualifier.baseLockedReason, 'INVALID');
    if (!view.qualifier.players.some(player => player.id === p.playerId && !player.disqualified)) {
      throw failure('Only eligible players in the current qualifier batch may be scored.');
    }
    if (view.qualifier.songs.length !== 3 || view.qualifier.songs.some(song => !song.id)) {
      throw failure('Select the qualifier songs before entering scores.', 'INVALID');
    }
    if (action.type === 'set-qualifier-challenge-result') {
      if (!QualifierRules.isChallenge(state)) throw failure('This qualifier uses individual song scores.', 'INVALID');
      if (p.group !== view.qualifier.activeGroup) throw failure('Only the active qualifier group may be scored.');
      const result = QualifierRules.normaliseChallengeResult(p.total, p.songStats);
      return { type: action.type, payload: { group: p.group, playerId: p.playerId, ...result } };
    }
    if (action.type === 'set-qualifier-total') {
      if (!QualifierRules.isChallenge(state)) throw failure('This qualifier uses individual song scores.', 'INVALID');
      QualifierRules.challengeTotal(p.total);
      if (Object.hasOwn(p, 'judgements') || Object.hasOwn(p, 'score') || Object.hasOwn(p, 'songIndex')) throw failure('Enter only the total shown by Challenge Mode.', 'INVALID');
      if (p.group !== view.qualifier.activeGroup) throw failure('Only the active qualifier group may be scored.');
      return { type: action.type, payload: { group: p.group, playerId: p.playerId, total: p.total } };
    }
    if (QualifierRules.isChallenge(state)) throw failure('Enter the Challenge Mode total once for the three-song set.', 'INVALID');
    return { type: action.type, payload: { playerId: p.playerId, songIndex: p.songIndex, score: p.score, ...metadata } };
  }
  if (state.stage !== 'double-elimination' || !view.match || p.matchId !== view.match.id) {
    throw failure('Only the selected match may be scored.');
  }
  if (view.match.locked || !view.match.players[p.playerIndex]?.id || view.match.players[p.playerIndex].disqualified) throw failure('This player or match cannot be scored.', 'INVALID');
  if (action.type === 'set-match-tiebreak-score') {
    if (!view.match.tiebreak || p.index !== view.match.tiebreak.index) throw failure('Only the active match tiebreak may be scored.');
    return { type: action.type, payload: { matchId: p.matchId, index: p.index, playerIndex: p.playerIndex, score: p.score, ...metadata } };
  }
  if (view.match.baseLocked) throw failure(view.match.baseLockedReason, 'INVALID');
  if (!Number.isInteger(p.songIndex) || !view.match.songs[p.songIndex]?.id || view.match.songs[p.songIndex].hidden) throw failure('This song is not available for scoring.', 'INVALID');
  return { type: action.type, payload: { matchId: p.matchId, playerIndex: p.playerIndex, songIndex: p.songIndex, score: p.score, ...metadata } };
}
module.exports = { scorekeeperState, scorekeeperAction, SCORE_ACTIONS };
