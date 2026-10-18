'use strict';

const { randomUUID } = require('node:crypto');
const Sequence = require('../public/js/final-sequence');
const FinalAnnouncement = require('../public/js/final-announcement');
const SongPool = require('../public/js/song-pool');
const CompetitionConfig = require('../public/js/competition-config');

const COMMANDS = new Set(['configure-final-finale', 'show-final-two-totals', 'start-final-finale',
  'play-final-finale-video', 'finish-final-finale-video', 'reveal-final-finale', 'set-final-finale-effect']);
function initial() {
  return { stage: 'base', song: null, videoPath: '', videoDuration: 0, effectLevel: 0, effectChangedAt: Date.now() };
}
function reset(match, { preserveReveal = false } = {}) {
  if (!Sequence.isEnabled(match)) return;
  const revealed = preserveReveal && match.scores.some(row => row[2] !== undefined && row[2] !== null);
  match.finale = { ...match.finale, stage: revealed ? 'revealed' : 'base', effectLevel: 0, effectChangedAt: Date.now() };
  delete match.finale.videoCue;
}
function applyAction(state, action, helpers) {
  if (!COMMANDS.has(action.type)) return false;
  const p = action.payload || {}, { assert, text, getMatch, playable, findSong } = helpers;
  const match = getMatch(state); playable(match);
  assert(FinalAnnouncement.isFixed(match), 'Select the fixed-song Grand Final before using its finale controls.');
  assert(match.players.every(Boolean), 'Both Grand Final players must be present.');
  assert(!match.tiebreaks?.length, 'The active Grand Final tiebreak has its own controls.');
  const finale = match.finale || initial();
  const thirdScored = () => match.scores.some(row => row[2] !== undefined && row[2] !== null);
  const firstTwoComplete = () => assert(match.scores.every(row => row.slice(0, 2).length === 2 && row.slice(0, 2).every(value => value !== null)),
    'Enter both players’ first two song scores before continuing the Grand Final.');
  const useDefaultSong = () => {
    if (finale.song || match.songs.length === 3 || thirdScored()) return;
    const selected = { ...CompetitionConfig.FINALE_SONG };
    assert(SongPool.isAvailable(state, selected, match.id), 'This song has already been selected by another match.');
    const existing = state.library.find(song => song.id === selected.id);
    // A custom library row may have adopted the same ID. Keep its metadata and
    // histories intact; an explicit configuration can resolve that conflict.
    assert(!existing || ['title', 'difficulty', 'level'].every(key => existing[key] === selected[key]), 'The default final song ID is already assigned to another library chart. Configure the final song explicitly.');
    if (existing) Object.assign(selected, existing);
    else { assert(state.library.length < 500, 'Library limit is 500 songs.'); state.library.push({ ...selected }); }
    finale.song = { ...selected };
    match.songs = [...match.songs, { ...selected }];
    match.scores = match.scores.map(row => [...row, null]);
    match.judgements = (match.judgements || [[], []]).map(row => [...Array.from({ length: 2 }, (_, i) => row[i] ?? null), null]);
    SongPool.remember(match);
  };
  const setWaiting = () => { match.currentSong = match.songs.length === 3 ? 2 : 1; state.stage = 'double-elimination'; state.scene = 'double-elimination-waiting'; };
  switch (action.type) {
    case 'configure-final-finale': {
      assert(!thirdScored(), 'The final song configuration is locked after its scoring starts.');
      assert(!['video', 'revealed'].includes(Sequence.phase(match).stage), 'Configure the final song and video before revealing them.');
      assert(!(p.songId !== undefined && p.song !== undefined), 'Choose a library song or enter a custom song, not both.');
      if (p.songId !== undefined || p.song !== undefined) {
        let selected;
        if (p.songId !== undefined) selected = findSong(state, p.songId);
        else {
          assert(p.song && typeof p.song === 'object' && !Array.isArray(p.song), 'Enter the final song details.');
          const s = p.song;
          selected = { id: 'gf-finale', title: text(s.title, 100), artist: text(s.artist ?? '', 100),
            difficulty: text(s.difficulty, 2), level: Number(s.level), art: text(s.art || 'assets/song/sealed.svg', 180), eligible: false };
          assert(selected.title && ['EZ', 'HD', 'IN', 'AT'].includes(selected.difficulty) &&
            Number.isInteger(selected.level) && selected.level >= 1 && selected.level <= 20,
          'Enter the actual title, chart difficulty and integer level from 1 to 20.');
          assert(/^assets\/[a-zA-Z0-9_./-]+\.(svg|png|jpg|jpeg|webp)$/i.test(selected.art) && !selected.art.includes('..'), 'Artwork must be a local assets path.');
        }
        assert(!match.songs.slice(0, 2).some(song => SongPool.sameSong(song, selected)), 'The final song must differ from the first two songs.');
        assert(SongPool.isAvailable(state, selected, match.id), 'This song has already been selected by another match.');
        if (p.song !== undefined) {
          const index = state.library.findIndex(song => song.id === selected.id);
          if (index < 0) { assert(state.library.length < 500, 'Library limit is 500 songs.'); state.library.push({ ...selected }); }
          else { SongPool.recordAlias(state, state.library[index], selected); state.library[index] = { ...selected }; }
        }
        finale.song = { ...selected };
        match.songs = [...match.songs.slice(0, 2), { ...selected }];
        match.scores = match.scores.map(row => [...row.slice(0, 2), null]);
        match.judgements = (match.judgements || match.scores.map(() => [])).map(row => [...Array.from({ length: 2 }, (_, i) => row[i] ?? null), null]);
        SongPool.remember(match);
      }
      if (Object.hasOwn(p, 'videoPath')) {
        assert(typeof p.videoPath === 'string' && (p.videoPath === '' || Sequence.validVideoPath(p.videoPath)), 'Video must be a local assets/finale/ MP4 or WebM path.');
        finale.videoPath = p.videoPath;
      }
      if (Object.hasOwn(p, 'videoDuration')) {
        assert(Number.isFinite(p.videoDuration) && p.videoDuration >= 0 && p.videoDuration <= 3600, 'Enter a video duration between 0 and 3600 seconds.');
        finale.videoDuration = p.videoDuration;
      }
      useDefaultSong();
      match.finale = finale;
      break;
    }
    case 'show-final-two-totals':
      firstTwoComplete(); assert(!thirdScored() && !['video', 'revealed'].includes(Sequence.phase(match).stage), 'The final song is already underway.');
      useDefaultSong();
      match.finale = { ...finale, stage: 'summary' }; state.stage = 'double-elimination'; state.scene = 'grand-final-totals'; break;
    case 'start-final-finale':
      firstTwoComplete(); assert(['summary', 'sealed'].includes(finale.stage) && !thirdScored(), 'Show the first two song totals before starting the sealed final song.');
      useDefaultSong();
      match.finale = { ...finale, stage: 'sealed', effectLevel: 0, effectChangedAt: Date.now() };
      delete match.finale.videoCue; setWaiting(); break;
    case 'play-final-finale-video':
      firstTwoComplete(); assert(['sealed', 'video'].includes(finale.stage) && !thirdScored(), 'Start the sealed waiting scene before playing the reveal video.');
      useDefaultSong();
      assert(finale.song && match.songs.length === 3, 'Configure the actual final song before playing its reveal video.');
      assert(Sequence.validVideoPath(finale.videoPath) && finale.videoDuration > 0, 'Configure the local reveal video and its duration first.');
      match.finale = { ...finale, stage: 'video', videoCue: { id: randomUUID(), startedAt: Date.now(), duration: finale.videoDuration } };
      match.currentSong = 2; state.stage = 'double-elimination'; state.scene = 'grand-final-video'; break;
    case 'finish-final-finale-video':
      assert(finale.stage === 'video', 'No Grand Final reveal video is active.');
      assert(finale.song && match.songs.length === 3, 'Configure the actual final song first.');
      match.finale = { ...finale, stage: 'revealed' }; delete match.finale.videoCue; setWaiting(); break;
    case 'reveal-final-finale':
      firstTwoComplete(); assert(['sealed', 'video', 'revealed'].includes(finale.stage), 'Start the sealed waiting scene before revealing the final song.');
      useDefaultSong();
      assert(finale.song && match.songs.length === 3, 'Configure the actual final song first.');
      match.finale = { ...finale, stage: 'revealed' }; delete match.finale.videoCue; setWaiting(); break;
    case 'set-final-finale-effect':
      assert(Sequence.phase(match).stage === 'revealed' && finale.song && match.currentSong === 2, 'Reveal the final song before changing its purification effects.');
      assert(Number.isInteger(p.level) && p.level >= 0 && p.level <= 4, 'Choose effect level 0, 1, 2, 3 or 4.');
      match.finale = { ...finale, stage: 'revealed', effectLevel: p.level, effectChangedAt: Date.now() };
      delete match.finale.videoCue;
      if (state.scene === 'grand-final-video') setWaiting();
      break;
  }
  return true;
}
module.exports = { COMMANDS, initial, reset, applyAction };
