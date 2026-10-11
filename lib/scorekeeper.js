const { total } = require('./tournament');

const SCORE_ACTIONS = new Set(['set-qualifier-score', 'set-match-score']);
function failure(message, code = 'FORBIDDEN') { const error = new Error(message); error.code = code; return error; }
function songView(song) {
  return song ? { id: song.id, title: song.title, difficulty: song.difficulty, level: song.level } :
    { id: null, title: '尚未選曲', difficulty: '', level: null };
}
function scorekeeperState(state) {
  const q = state.qualifier, group = q.activeGroup;
  const qualifier = {
    activeGroup: group, currentSong: q.currentSong, locked: state.tournament.seeded,
    songs: q.groups[group].songs.map(id => songView(state.library.find(song => song.id === id))),
    players: q.players.filter(player => player.group === group).map(player => ({
      id: player.id, name: player.name, group: player.group, scores: [...player.scores], total: total(player.scores)
    })),
    activePlayers: [...q.activePlayers]
  };
  const current = state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
  let match = null;
  if (current) {
    const count = current.id === 'GF' ? 3 : 2;
    const sealed = current.id === 'GF' && !current.hostRevealed;
    match = {
      id: current.id, label: current.label, round: current.round, status: current.status, currentSong: current.currentSong,
      players: current.players.map((id, index) => {
        const player = q.players.find(player => player.id === id);
        const scores = current.scores[index].map((value, songIndex) => sealed && songIndex === 2 ? null : value);
        return { id, name: player?.name || '待定／空位', scores, total: total(scores) };
      }),
      songs: Array.from({ length: count }, (_, index) => sealed && index === 2 ?
        { id: 'sealed', title: 'MC PICK — SEALED', difficulty: '', level: null, hidden: true } : songView(current.songs[index])),
      locked: current.status === 'complete' || current.status === 'pending' || !current.players.every(Boolean) || current.songs.length !== count
    };
  }
  const playersKey = players => players.map(player => [player.id, player.name]);
  const songsKey = songs => songs.map(song => [song.id, song.title, song.difficulty, song.level]);
  const key = state.stage === 'qualifier' ?
    [state.stage, group, playersKey(qualifier.players), songsKey(qualifier.songs), qualifier.locked] :
    [state.stage, match?.id || null, playersKey(match?.players || []), songsKey(match?.songs || []), Boolean(current?.hostRevealed), match?.status || null];
  return {
    revision: state.revision, event: { title: state.event.title, titleZH: state.event.titleZH || state.event.title },
    stage: state.stage, contextKey: JSON.stringify(key), qualifier, match
  };
}
function scorekeeperAction(state, request) {
  const action = request?.action;
  if (!SCORE_ACTIONS.has(action?.type)) throw failure('Scorekeepers may only enter scores.');
  const view = scorekeeperState(state);
  if (request.contextKey !== view.contextKey) throw failure('The scoring group, players or selected songs changed. Review the current scoring sheet.', 'CONTEXT_CHANGED');
  const p = action.payload || {};
  if (action.type === 'set-qualifier-score') {
    if (state.stage !== 'qualifier' || !view.qualifier.players.some(player => player.id === p.playerId)) {
      throw failure('Only the current qualifier group may be scored.');
    }
    if (view.qualifier.songs.length !== 3 || view.qualifier.songs.some(song => !song.id)) {
      throw failure('Select the qualifier songs before entering scores.', 'INVALID');
    }
    return { type: action.type, payload: { playerId: p.playerId, songIndex: p.songIndex, score: p.score } };
  }
  if (state.stage !== 'double-elimination' || !view.match || p.matchId !== view.match.id) {
    throw failure('Only the selected match may be scored.');
  }
  return { type: action.type, payload: { matchId: p.matchId, playerIndex: p.playerIndex, songIndex: p.songIndex, score: p.score } };
}
module.exports = { scorekeeperState, scorekeeperAction, SCORE_ACTIONS };
