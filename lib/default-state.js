const tracks = [
  ['Stardust:RAY', 'kanone vs. BlackY', 16],
  ['Desultory Signals', 'technoplanet', 17],
  ["Rrhar’il", 'Team Grimoire', 15],
  ['Igallta', 'Se-U-Ra', 15],
  ['Chronostasis', '黒皇帝', 15],
  ['Spasmodic', '姜米條', 15],
  ['Cthugha', 'USAO', 15],
  ['Distorted Fate', 'Sakuzyo', 16],
  ['Crave Wave', 'LandRoot', 15],
  ['DESTRUCTION 3,2,1', 'Normal1zer', 15],
  ['Dlyrotz', 'Likey', 14],
  ['INFiNiTE ENERZY -Overdoze-', 'Reku Mochizuki', 15]
];
function createDefaultState() {
  const library = tracks.map(([title, artist, level], i) => ({
    id: `song-${i + 1}`, title, artist, difficulty: 'IN', level,
    art: `assets/song/cover-${i % 4 + 1}.svg`, eligible: true
  }));
  return {
    schemaVersion: 1, revision: 0, updatedAt: new Date().toISOString(),
    event: {
      title: 'ACAHKU Phigros Competition',
      organiser: 'ACAHKU — The Animation and Comics Association',
      organiserZH: '香港大學動漫聯盟', date: '2026-11-07',
      time: '13:00–19:30', venue: 'UG201', message: 'A new rhythm. A new champion.'
    },
    scene: 'start', stage: 'qualifier', broadcast: { showHandcams: false }, library,
    qualifier: {
      activeGroup: 'A', currentSong: 0, activePlayers: ['p1', 'p2', 'p3'],
      groups: { A: { songs: ['song-1', 'song-3', 'song-5'] }, B: { songs: ['song-2', 'song-4', 'song-6'] } },
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
