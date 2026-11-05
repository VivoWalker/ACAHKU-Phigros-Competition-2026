# Supplied broadcast videos

Both organiser-supplied videos are bundled locally and ready in the main control.
Empty or previously unset video settings use these files; explicit replacement
paths and their durations remain unchanged. Entering the illustrated rest page
does not start playback. Staff still choose **播放預告** or the Grand Final's
**播放公布視頻** action.

| Use | Original filename | Local path | Measured duration | Integrated loudness |
| --- | --- | --- | --- | --- |
| Intermission Arcaea trailer | Arcaea Competition announcement.mp4 | `assets/intermission/arcaea-trailer.mp4` | 29.566341 s | −18.01 LUFS |
| Final-song reveal PV | Ending Song Video.mp4 | `assets/finale/final-song-reveal.mp4` | 94.333008 s | −18.03 LUFS |

The five supplied ZIP volumes were joined with `zip -s 0` and both entries passed
CRC verification. [manifest.json](manifest.json) records original and delivered
SHA-256 hashes, sizes, codecs, frame rates, durations and audio measurements.

Audio matches the bundled BGM's −18 LUFS target. The originals measured −7.28 and
−13.53 LUFS. Constant gains of −10.55 dB and −4.47 dB were applied respectively,
with no dynamic compression or changes to pitch/speed. Full delivered files were
decoded and measured again after AAC encoding; true peaks are −10.19 and
−6.97 dBTP, below the −2 dBTP ceiling. The same saved global volume applies after
normalization (25% by default). Staff previews stay muted and video playback
stops the menu music and song previews.

Both deliveries are 1920×1080 MP4s with 48 kHz stereo AAC at 192 kbit/s and
`faststart`. The Arcaea trailer retains its original H.264 video bitstream at
30 fps. The final PV was converted from HEVC to H.264 High 4.1, yuv420p, using
x264 medium CRF 20 at its original 24 fps for Chromium/OBS compatibility. No
frames were intentionally cut and both durations match the originals within
1 ms. Runtime defaults are in `public/js/broadcast-videos.js`; the final reveal
clock uses the measured delivered duration.

To reproduce the deliveries from the supplied originals:

```sh
ffmpeg -i 'Arcaea Competition announcement.mp4' -map 0:v:0 -map 0:a:0 \
  -c:v copy -af volume=-10.55dB -c:a aac -b:a 192k -ar 48000 \
  -map_metadata -1 -movflags +faststart arcaea-trailer.mp4
ffmpeg -i 'Ending Song Video.mp4' -map 0:v:0 -map 0:a:0 \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -profile:v high -level:v 4.1 \
  -af volume=-4.47dB -c:a aac -b:a 192k -ar 48000 \
  -map_metadata -1 -movflags +faststart final-song-reveal.mp4
```

Measure the complete decoded output with
`ffmpeg -i FILE.mp4 -map 0:a:0 -af loudnorm=I=-18:TP=-2:LRA=20:print_format=json -f null -`.
