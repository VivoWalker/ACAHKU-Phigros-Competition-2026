(function () {
  const scenes = [
    ['start', 'Start screen', '開始界面'], ['qualifier-waiting', 'Qualifier waiting', '預選賽等候'],
    ['double-elimination-waiting', 'Double elimination waiting', '雙淘汰賽等候'], ['qualifier-match', 'Qualifier match', '預選賽'],
    ['double-elimination-match', 'Double elimination match', '雙淘汰賽'], ['result', 'Result announcement', '結果公佈'],
    ['bracket', 'Bracket progress', '雙淘汰賽進度'], ['song-selection', 'Song selection', '選曲'],
    ['grand-final-announcement', 'Grand Final songs', '總決賽曲目公佈']
  ];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const total = values => (values || []).reduce((s, n) => s + (n ?? 0), 0);
  const score = n => n === null || n === undefined ? '—' : n.toLocaleString('en-US');
  const qualifierPlayers = (state, group) => window.QualifierRules ? QualifierRules.entries(state, group) : state.qualifier.players.filter(p => p.group === group);
  const player = (state, id) => state.qualifier.plan ? qualifierPlayers(state, state.qualifier.activeGroup).find(p => p.id === id) || state.qualifier.players.find(p => p.id === id) : state.qualifier.players.find(p => p.id === id);
  const name = (state, id) => player(state, id)?.name || 'Vacant slot';
  const currentMatch = state => state.tournament.matches.find(m => m.id === state.tournament.currentMatchId);
  const matchSongCount = match => match?.id === 'GF' && match.finalMode !== 'fixed-two' ? 3 : 2;
  const fixedFinalSongs = state => {
    const final = state.tournament.matches.find(match => match.id === 'GF');
    if (final?.finalMode === 'fixed-two') return final.songs;
    const config = window.CompetitionConfig;
    return config && state.event.competitionVersion === config.VERSION ? config.FINAL_SONG_IDS.map(id => state.library.find(song => song.id === id)).filter(Boolean) : [];
  };
  const seed = (state, id) => state.tournament.seeds.indexOf(id) + 1;
  const losses = (state, id) => id ? state.tournament.matches.filter(m => m.loserId === id && m.status === 'complete').length : 0;
  const legacyRankings = (state, group) => state.qualifier.players.filter(p => p.group === group && !p.disqualification).map(p => ({ ...p, total: total(p.scores) }))
    .sort((a, b) => b.total - a.total || (a.tiePriority ?? 999) - (b.tiePriority ?? 999) || a.id.localeCompare(b.id))
    .map((p, i) => ({ ...p, rank: i + 1, tied: state.qualifier.players.some(q => !q.disqualification && q.group === group && q.id !== p.id && total(q.scores) === p.total && (p.tiePriority === null || q.tiePriority === null || p.tiePriority === q.tiePriority)) }));
  const song = (state, id) => state.library.find(s => s.id === id);
  const date = value => new Date(value + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'short' });
  const icon = id => `<svg class="phi-icon" aria-hidden="true"><use href="../assets/icons/icons.svg#phi-${id}"></use></svg>`;
  const challengeQualifier = state => window.QualifierRules?.isChallenge(state) === true;
  const qualifierTotal = (state, entry) => entry ? window.QualifierRules ? QualifierRules.total(state, entry) : total(entry.scores) : null;
  const rankings = (state, group) => (state.qualifier.plan || challengeQualifier(state)) && window.QualifierRules ? QualifierRules.rankings(state, group) : legacyRankings(state, group);
  const qualifierLabel = (state, group = state.qualifier.activeGroup) => state.qualifier.plan === 'A' ? group === 'A' ? 'Qualifier Round 1' : 'Revival Round' : `Group ${group}${state.qualifier.plan === 'B' ? group === 'A' ? ' · Odd numbers' : ' · Even numbers' : ''}`;
  const qualifierTiebreak = state => { const rounds = state.qualifier.rounds?.[state.qualifier.activeGroup]?.tiebreaks; const round = rounds?.at(-1); return round && !round.confirmed ? { ...round, index: rounds.length - 1 } : null; };
  const matchTiebreak = state => { const rounds = currentMatch(state)?.tiebreaks; const round = rounds?.at(-1); return round && !round.confirmed ? { ...round, index: rounds.length - 1 } : null; };
  window.Broadcast = { scenes, escape, total, score, player, name, currentMatch, matchSongCount, fixedFinalSongs, seed, losses, rankings, qualifierPlayers, qualifierLabel, qualifierTiebreak, challengeQualifier, qualifierTotal, matchTiebreak, song, date, icon };
})();
