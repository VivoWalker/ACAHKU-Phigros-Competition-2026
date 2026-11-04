(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./final-sequence') : root.BroadcastFinalSequence);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastWaitingPreview = api;
})(typeof window === 'undefined' ? globalThis : window, function (FinalSequence) {
  'use strict';
  function context(state, now = Date.now()) {
    if (state?.stage !== 'double-elimination' || state.scene !== 'double-elimination-waiting') return null;
    const match = state.tournament.matches.find(item => item.id === state.tournament.currentMatchId);
    if (!match || !['ready', 'live'].includes(match.status) || !match.players.every(Boolean)) return null;
    const index = (match.tiebreaks?.length || 0) - 1, tie = match.tiebreaks?.[index];
    const pending = tie && !tie.confirmed ? tie : null, song = pending?.song || match.songs[match.currentSong];
    if (tie && !pending) return null;
    const concealedFinal = !pending && match.id === 'GF' && match.currentSong === 2 &&
      (match.finalMode === 'fixed-two' ? FinalSequence?.phase(match, now).concealed : !match.hostRevealed);
    if (!song || song.hidden || concealedFinal) return null;
    return { matchId: match.id, song,
      key: JSON.stringify([state.eventId, match.id, match.currentSong, pending ? index : null, song.id, match.players]) };
  }
  return { context };
});
