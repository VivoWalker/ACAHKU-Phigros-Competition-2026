'use strict';

const QualifierRules = require('../public/js/qualifier-rules');

const QUALIFIER_SCENES = new Set(['qualifier-waiting', 'qualifier-match', 'song-result', 'result']);
const DOUBLE_SCENES = new Set(['double-elimination-waiting', 'double-elimination-match', 'song-result',
  'song-selection', 'grand-final-announcement', 'result', 'bracket']);

// A cue updates the selection and its on-air scene in one saved revision. The
// caller still supplies the revision; match IDs also prevent a stale control
// from applying a valid scene to a different match after the bracket advances.
function applyAction(state, action, helpers) {
  if (action.type !== 'set-broadcast-cue') return false;
  const p = action.payload || {}, { assert, getMatch, requireCurrentMatch, configuredFinalSongs } = helpers;
  assert(['qualifier', 'double-elimination'].includes(p.stage), 'Choose the competition stage.');
  if (p.stage === 'qualifier') {
    assert(QUALIFIER_SCENES.has(p.scene), 'Choose a qualifier broadcast scene.');
    const q = state.qualifier, group = p.group ?? q.activeGroup;
    assert(['A', 'B'].includes(group), 'Choose Group A or B.');
    assert(q.plan !== 'A' || group !== 'B' || q.rounds.A.locked,
      'Finalize the first round before displaying the revival round.');
    const tie = QualifierRules.activeTiebreak(state, group);
    const eligible = new Set(QualifierRules.entries(state, group)
      .filter(player => !tie || tie.playerIds.includes(player.id)).map(player => player.id));
    const players = p.players ?? (group === q.activeGroup ? q.activePlayers : []);
    assert(Array.isArray(players) && players.length <= 3 && new Set(players).size === players.length,
      'Choose up to three different players.');
    assert(players.every(id => eligible.has(id)), 'Displayed players must be eligible in the active qualifier round.');
    const index = p.songIndex ?? q.currentSong;
    assert(Number.isInteger(index) && index >= 0 && index < 3, 'Invalid qualifier song number.');
    if (['qualifier-match', 'song-result'].includes(p.scene)) {
      assert(players.length > 0, 'Choose the players to display before starting or showing song results.');
      assert(tie?.song || q.groups[group]?.songs[index], 'Choose the qualifier songs first.');
    }
    q.activeGroup = group; q.activePlayers = [...players]; q.currentSong = index;
  } else {
    assert(DOUBLE_SCENES.has(p.scene), 'Choose a Double Elimination broadcast scene.');
    assert(state.tournament.seeded, 'Seed the bracket before broadcasting Double Elimination.');
    if (p.scene === 'result') {
      assert(state.result && p.matchId === state.result.matchId,
        'Choose the completed match result currently available for broadcast.');
      assert(getMatch(state, p.matchId).status === 'complete', 'Complete and verify this match before showing its round result.');
      assert(p.songIndex === undefined, 'Round results do not change the current match song.');
    } else if (p.scene === 'bracket') {
      if (p.matchId !== undefined) requireCurrentMatch(state, p);
      assert(p.songIndex === undefined, 'The bracket does not change the current match song.');
    } else {
      const match = getMatch(state, p.matchId);
      assert(typeof p.matchId === 'string', 'Choose the current match.');
      const selectsFixedFinal = p.scene === 'grand-final-announcement' && match.id === 'GF' && match.finalMode === 'fixed-two';
      if (p.scene !== 'double-elimination-waiting' && !selectsFixedFinal) requireCurrentMatch(state, p);
      assert(['ready', 'live'].includes(match.status), 'Select a ready match.');
      const count = match.id === 'GF' && match.finalMode !== 'fixed-two' ? 3 : 2;
      const index = p.songIndex ?? match.currentSong;
      assert(Number.isInteger(index) && index >= 0 && index < (match.songs.length || 1), 'Choose a selected match song.');
      assert(match.id !== 'GF' || index !== 2 || match.hostRevealed, 'Reveal the MC song before going to song three.');
      if (['double-elimination-match', 'song-result'].includes(p.scene)) {
        assert(match.players.every(Boolean), 'A vacant match needs a bye or adjudication before it can be played.');
        assert(match.songs.length === count, 'Select the match songs before starting or showing song results.');
      }
      if (p.scene === 'grand-final-announcement') {
        assert(match.id === 'GF' && match.finalMode === 'fixed-two' && configuredFinalSongs(state),
          'Select the fixed-song Grand Final before announcing its songs.');
      }
      match.currentSong = index;
      state.tournament.currentMatchId = match.id;
    }
  }
  state.stage = p.stage; state.scene = p.scene;
  return true;
}

module.exports = { applyAction };
