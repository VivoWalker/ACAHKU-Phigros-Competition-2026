const HOST_ACTIONS = new Set(['draw-candidates', 'ban-song', 'pick-songs']);
function failure(message, code = 'FORBIDDEN') { const error = new Error(message); error.code = code; return error; }
function hostState(state) {
  const current = state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
  const regular = state.stage === 'double-elimination' && current && current.id !== 'GF';
  const song = value => ({ id: value.id, title: value.title, difficulty: value.difficulty, level: value.level, art: value.art });
  const match = regular ? { id: current.id, status: current.status,
    players: current.players.map(id => { const entry = state.qualifier.players.find(player => player.id === id);
      return { id: id || null, name: entry?.name || '待定', number: entry?.number || null }; }),
    candidates: current.candidates.map(song), bans: [...current.bans], songs: current.songs.map(song) } : null;
  const editable = !!regular && ['ready', 'live'].includes(current.status) && current.players.every(Boolean)
    && !current.songs.length && !current.tiebreaks?.length && current.scores.flat().every(value => value === null)
    && ['bracket', 'song-selection', 'double-elimination-waiting'].includes(state.scene);
  const available = { drawCandidates: editable && current.candidates.length === 0, ban: editable && current.candidates.length === 6,
    pickSongs: editable && current.candidates.length === 6 && current.bans.every(Boolean) };
  const contextKey = JSON.stringify([state.eventId, state.stage, match, editable]);
  return { eventId: state.eventId, revision: state.revision, contextKey, match, available };
}
function hostAction(state, request) {
  const action = request?.action;
  if (!HOST_ACTIONS.has(action?.type)) throw failure('Hosts may only draw candidates, ban songs and draw match songs.');
  const view = hostState(state), payload = action.payload || {};
  if (request.contextKey !== view.contextKey || !view.match || payload.matchId !== view.match.id)
    throw failure('The current match or song selection changed. Review the host panel.', 'CONTEXT_CHANGED');
  const allowed = { 'draw-candidates': 'drawCandidates', 'ban-song': 'ban', 'pick-songs': 'pickSongs' };
  if (!view.available[allowed[action.type]]) throw failure('The main operator has not opened this selection, or it is already locked.', 'INVALID');
  if (action.type === 'ban-song') {
    if (![0, 1].includes(payload.playerIndex) || typeof payload.songId !== 'string'
      || !view.match.candidates.some(song => song.id === payload.songId)) throw failure('Choose P1 or P2 and a current candidate.', 'INVALID');
    return { type: action.type, payload: { matchId: view.match.id, playerIndex: payload.playerIndex, songId: payload.songId } };
  }
  return { type: action.type, payload: { matchId: view.match.id, ...(action.type === 'draw-candidates' ? { showSelection: true } : {}) } };
}
module.exports = { HOST_ACTIONS, hostState, hostAction };
