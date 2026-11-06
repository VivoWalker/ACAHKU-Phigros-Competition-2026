(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastVideos = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Durations are measured from the delivered H.264/AAC files. See the
  // processing manifest under assets/broadcast-videos for hashes and loudness.
  const clips = Object.freeze({
    arcaea: Object.freeze({ videoPath: 'assets/intermission/arcaea-trailer.mp4', videoDuration: 29.566341 }),
    finale: Object.freeze({ videoPath: 'assets/finale/final-song-reveal.mp4', videoDuration: 88.512 })
  });
  function intermission(value = {}) {
    const videoPath = value.videoPath || clips.arcaea.videoPath;
    return { ...value, videoPath, loop: false,
      ...(videoPath === clips.arcaea.videoPath ? { videoDuration: clips.arcaea.videoDuration } : {}) };
  }
  function finale(value = {}) {
    if (!value.videoPath) return { ...value, ...clips.finale };
    // Saved defaults from the first supplied PV need the new media duration.
    // Preserve operator timing and any cue already running on its saved clock.
    if (value.videoPath === clips.finale.videoPath && Number.isFinite(value.videoDuration)
      && Math.abs(value.videoDuration - 94.333008) < .001 && !(value.stage === 'video' && value.videoCue))
      return { ...value, videoDuration: clips.finale.videoDuration };
    return { ...value };
  }
  return Object.freeze({ clips, intermission, finale });
});
