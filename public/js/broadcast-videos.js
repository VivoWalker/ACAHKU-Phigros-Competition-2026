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
    finale: Object.freeze({ videoPath: 'assets/finale/final-song-reveal.mp4', videoDuration: 94.333008 })
  });
  function intermission(value = {}) {
    return { ...value, videoPath: value.videoPath || clips.arcaea.videoPath };
  }
  function finale(value = {}) {
    return value.videoPath ? { ...value } : { ...value, ...clips.finale };
  }
  return Object.freeze({ clips, intermission, finale });
});
