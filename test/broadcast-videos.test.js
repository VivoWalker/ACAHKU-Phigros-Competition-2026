const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Videos = require('../public/js/broadcast-videos');
const manifest = require('../public/assets/broadcast-videos/manifest.json');

test('delivered video files match the measured duration, loudness and checksum manifest', async () => {
  assert.equal(manifest.clips.length, 2);
  for (const clip of manifest.clips) {
    const file = path.join(__dirname, '../public', clip.path);
    assert.equal(Videos.clips[clip.id].videoPath, clip.path);
    assert.equal(Videos.clips[clip.id].videoDuration, clip.duration);
    assert.equal(fs.statSync(file).size, clip.bytes);
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    assert.equal(digest.digest('hex'), clip.sha256);
    assert.ok(Math.abs(clip.integratedLufs + 18) < .1);
    assert.ok(clip.truePeakDb <= -2);
    assert.equal(clip.videoCodec, 'h264'); assert.equal(clip.audioCodec, 'aac');
  }
});

test('empty saved video settings pick up the supplied files without changing scene or playback cues', () => {
  const rest = { videoPath: '', loop: false, resumeTime: '16:00', cue: null };
  assert.deepEqual(Videos.intermission(rest), { ...rest, videoPath: Videos.clips.arcaea.videoPath });
  const finale = { videoPath: '', videoDuration: 0, stage: 'sealed', song: null };
  assert.deepEqual(Videos.finale(finale), { ...finale, ...Videos.clips.finale });
  assert.equal(rest.videoPath, ''); assert.equal(finale.videoDuration, 0);
});

test('operator-selected replacement files keep their own duration, loop and clock', () => {
  const rest = { videoPath: 'media/intermission/custom.mp4', loop: false, cue: { id: 'current' } };
  const finale = { videoPath: 'assets/finale/custom.mp4', videoDuration: 7.25, stage: 'video', videoCue: { id: 'current' } };
  assert.deepEqual(Videos.intermission(rest), rest);
  assert.deepEqual(Videos.finale(finale), finale);
  assert.equal(Videos.finale({ videoPath: finale.videoPath, videoDuration: 0 }).videoDuration, 0,
    'A custom clip must never inherit the bundled clip duration.');
});
