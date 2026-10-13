(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SongPool = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const normal = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const identity = song => JSON.stringify([normal(song?.title), normal(song?.artist)]);
  const usable = song => !!song && !song.hidden && song.id !== 'sealed';
  const sameSong = (left, right) => usable(left) && usable(right) &&
    (left.id === right.id || identity(left) === identity(right));
  function matches(state) {
    const tournament = state.tournament || {}, history = tournament.songHistory || {};
    const result = (tournament.matches || []).map(match => history[match.id] ?
      { ...match, usedSongs: [...(match.usedSongs || []), ...history[match.id]] } : match);
    for (const [id, songs] of Object.entries(history)) if (!result.some(match => match.id === id))
      result.push({ id, songs: [], usedSongs: songs, tiebreaks: [] });
    return result;
  }
  function distinct(songs) {
    const result = [], ids = new Set(), identities = new Set();
    for (const song of songs.filter(usable)) {
      const key = identity(song);
      if (ids.has(song.id) || identities.has(key)) continue;
      ids.add(song.id); identities.add(key); result.push(song);
    }
    return result;
  }
  function usedByMatch(match) {
    // Keep metadata aliases for stable IDs: renaming a library entry must not free
    // either its old title or its new title for another match.
    const entries = [...(match?.usedSongs || []), ...(match?.songs || []), ...(match?.tiebreaks || []).map(tie => tie.song)];
    const seen = new Set();
    return entries.filter(song => {
      if (!usable(song)) return false;
      const key = JSON.stringify([song.id, identity(song)]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function occupiedBy(state, song, exceptMatchId) {
    return matches(state).filter(match => match.id !== exceptMatchId &&
      usedByMatch(match).some(previous => sameSong(previous, song))).map(match => match.id);
  }
  const isAvailable = (state, song, matchId) => usable(song) && occupiedBy(state, song, matchId).length === 0;
  function available(state, matchId, options = {}) {
    const ids = new Set(), identities = new Set();
    for (const match of matches(state)) if (match.id !== matchId) for (const song of usedByMatch(match)) {
      ids.add(song.id); identities.add(identity(song));
    }
    return distinct((state.library || []).filter(song => usable(song) && (!options.eligibleOnly || song.eligible) &&
      !ids.has(song.id) && !identities.has(identity(song))));
  }
  function remember(match) {
    match.usedSongs = usedByMatch(match).map(song => ({ ...song }));
  }
  function carryUsage(nextTournament, previousTournament) {
    const history = {};
    for (const match of [...matches({ tournament: previousTournament }), ...matches({ tournament: nextTournament })]) {
      const songs = usedByMatch({ usedSongs: [...(history[match.id] || []), ...usedByMatch(match)] });
      if (songs.length) history[match.id] = songs.map(song => ({ ...song }));
    }
    for (const match of nextTournament.matches || []) if (history[match.id]) {
      match.usedSongs = history[match.id]; delete history[match.id];
    }
    if (Object.keys(history).length) nextTournament.songHistory = history;
    else delete nextTournament.songHistory;
  }
  function recordAlias(state, previousSong, nextSong) {
    for (const entry of matches(state)) if (usedByMatch(entry).some(song => sameSong(song, previousSong))) {
      const match = state.tournament.matches.find(match => match.id === entry.id);
      const target = match || { usedSongs: state.tournament.songHistory[entry.id] };
      // Fold any restored pre-seeding history into the matching live record.
      target.usedSongs = usedByMatch(entry).map(song => ({ ...song }));
      for (const alias of [previousSong, nextSong]) if (!target.usedSongs.some(song => song.id === alias.id && identity(song) === identity(alias)))
        target.usedSongs.push({ ...alias });
      if (!match) state.tournament.songHistory[entry.id] = target.usedSongs;
    }
  }
  function status(state) {
    const eligible = distinct((state.library || []).filter(song => song.eligible));
    const availableRegular = available(state, null, { eligibleOnly: true }).length;
    const regularMatchesRemaining = state.tournament?.seeded ? matches(state).filter(match =>
      match.id !== 'GF' && match.status !== 'complete' && match.songs.length === 0).length : 13;
    return { eligibleTotal: eligible.length, reservedRegular: eligible.length - availableRegular,
      availableRegular, regularMatchesRemaining,
      minimumRegularNeeded: regularMatchesRemaining ? 2 * regularMatchesRemaining + 4 : 0,
      minimumRegularTarget: 30, suggestedRegularTarget: 42 };
  }
  return { identity, sameSong, distinct, usedByMatch, occupiedBy, isAvailable, available, remember, carryUsage, recordAlias, status };
});
