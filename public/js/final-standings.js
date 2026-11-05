(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastFinalStandings = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const MATCH_IDS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'L1', 'L2', 'W7', 'L3', 'L4', 'L5', 'L6', 'GF'];
  const PAGE_SIZE = 12, PAGE_MS = 12000;
  function build(state) {
    const tournament = state?.tournament, roster = state?.qualifier?.players || [];
    const matches = tournament?.matches || [];
    const ready = tournament?.seeded === true && MATCH_IDS.every(id => matches.some(match => match.id === id && match.status === 'complete'));
    if (!ready) return { ready: false, podium: [], groups: [] };
    const seeds = new Set(tournament.seeds.filter(Boolean));
    const eligible = id => seeds.has(id) && roster.some(player => player.id === id && !player.disqualification);
    const final = matches.find(match => match.id === 'GF'), bronze = matches.find(match => match.id === 'L6');
    const awarded = new Set();
    const entry = player => ({ id: player.id, name: player.name });
    const podium = [final.winnerId, final.loserId, bronze.loserId].map((id, i) => {
      const player = eligible(id) && !awarded.has(id) ? roster.find(player => player.id === id) : null;
      if (player) awarded.add(id);
      return { place: i + 1, player: player ? entry(player) : null };
    });
    // Keep registration order within each band. Seeds, scores and elimination
    // rounds must never imply an individual placing inside an unordered band.
    const groups = [
      { id: 'top-eight', label: '第 4–8 名', english: '4TH–8TH', unordered: true,
        players: roster.filter(player => seeds.has(player.id) && !awarded.has(player.id) && !player.disqualification).map(entry) },
      { id: 'remaining', label: '第 9 名起', english: '9TH ONWARD', unordered: true,
        players: roster.filter(player => !seeds.has(player.id) && !player.disqualification).map(entry) },
      { id: 'disqualified', label: '取消資格', english: 'DISQUALIFIED', unordered: false,
        players: roster.filter(player => player.disqualification).map(entry) }
    ];
    return { ready: true, podium, groups };
  }
  function pages(standings) {
    return standings.groups.filter(group => group.id !== 'top-eight' && group.players.length).flatMap(group =>
      Array.from({ length: Math.ceil(group.players.length / PAGE_SIZE) }, (_, index) => ({
        ...group, players: group.players.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
        page: index + 1, count: Math.ceil(group.players.length / PAGE_SIZE)
      })));
  }
  return { build, pages, PAGE_SIZE, PAGE_MS };
});
