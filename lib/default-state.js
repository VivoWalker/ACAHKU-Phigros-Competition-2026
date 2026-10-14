const CompetitionConfig = require('../public/js/competition-config');
function createDefaultState() {
  const library = CompetitionConfig.library();
  return {
    schemaVersion: 1, revision: 0, updatedAt: new Date().toISOString(),
    event: {
      title: 'ACAHKU Phigros Competition', competitionVersion: CompetitionConfig.VERSION,
      organiser: 'ACAHKU — The Animation and Comics Association',
      organiserZH: '香港大學動漫聯盟', date: '2026-11-07',
      time: '13:00–19:30', venue: 'UG201', message: 'A new rhythm. A new champion.'
    },
    scene: 'start', stage: 'qualifier', broadcast: { showHandcams: false }, library,
    qualifier: {
      activeGroup: 'A', currentSong: 0, activePlayers: ['p1', 'p2', 'p3'],
      groups: Object.fromEntries(['A', 'B'].map(group => [group, { songs: [...CompetitionConfig.QUALIFIER_SONG_IDS[group]] }])),
      players: Array.from({ length: 8 }, (_, i) => ({
        id: `p${i + 1}`, name: `Player ${String(i + 1).padStart(2, '0')}`,
        group: i < 4 ? 'A' : 'B', scores: [null, null, null], tiePriority: null
      }))
    },
    tournament: { seeded: false, seeds: [], matches: [], currentMatchId: null, drawLog: [] },
    result: null, correctionLog: []
  };
}
module.exports = { createDefaultState };
