// Full-bracket fixtures need enough distinct tracks for selection without reuse.
// Keep the real default/demo catalog unchanged and expand only fixtures that
// exercise many matches, corrections, or a Grand Final after thirteen games.
function expandSongLibrary(state, count = 42) {
  for (let index = state.library.length; index < count; index++) {
    state.library.push({
      ...state.library[0], id: `fixture-song-${index + 1}`,
      title: `Distinct fixture track ${index + 1}`, artist: 'Fixture composer', eligible: true
    });
  }
  return state;
}

function finalCandidates(state, count = 6) {
  const SongPool = require('../../public/js/song-pool');
  const ids = SongPool.available(state, 'GF', { eligibleOnly: false }).slice(0, count).map(song => song.id);
  if (ids.length !== count) throw new Error(`Fixture needs ${count} unused Grand Final candidates`);
  return ids;
}

module.exports = { expandSongLibrary, finalCandidates };
