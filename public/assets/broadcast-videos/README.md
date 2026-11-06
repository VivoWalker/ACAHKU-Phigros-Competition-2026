# Supplied broadcast videos

Both organiser-supplied videos are bundled locally and ready in the main control.
Empty or previously unset video settings use these files. Saved defaults for the
first final PV adopt the final version's measured duration before playback;
custom paths, custom timings and active playback clocks keep their settings.
Entering the illustrated rest page
does not start playback. Staff still choose **播放預告** or the Grand Final's
**播放公布視頻** action.

| Use | Original filename | Local path | Measured duration | Integrated loudness |
| --- | --- | --- | --- | --- |
| Intermission Arcaea trailer | Arcaea Competition announcement.mp4 | `assets/intermission/arcaea-trailer.mp4` | 29.566341 s | −18.01 LUFS |
| Final-song reveal PV | Ending Song Video Final Ver.mp4 | `assets/finale/final-song-reveal.mp4` | 88.512 s | −18.03 LUFS |

The Arcaea trailer came from the original five-volume archive. The final PV now
comes from `Ending Song Video Final Ver.z01`, `.z02` and `.zip`, joined with
`zip -s 0`; its MP4 passed CRC verification. [manifest.json](manifest.json)
records original and delivered SHA-256 hashes, sizes, codecs, frame rates,
durations and audio measurements.
The final version also records all three archive-part hashes and matching source
and delivered H.264 stream hashes.

Audio matches the bundled BGM's −18 LUFS target. The originals measured −7.28 and
−13.55 LUFS. Constant gains of −10.55 dB and −4.45 dB were applied respectively,
with no dynamic compression or changes to pitch/speed. Full delivered files were
decoded and measured again after AAC encoding; true peaks are −10.19 and
−7.70 dBTP, below the −2 dBTP ceiling. The same saved global volume applies after
normalization (25% by default). Staff previews stay muted and video playback
stops the menu music and song previews.

Both deliveries are 1920×1080 MP4s with 48 kHz stereo AAC at 192 kbit/s and
`faststart`. The Arcaea trailer retains its original H.264 video bitstream at
30 fps. The final version is already H.264 Main 4.1, yuv420p, at 24 fps, so its
video bitstream is also copied without re-encoding. The full 88.5-second visual
track is preserved; AAC ending padding adds 12 ms to the delivered container.
Runtime defaults are in `public/js/broadcast-videos.js`; the final reveal
clock uses the measured delivered duration.

To reproduce the deliveries from the supplied originals:

```sh
ffmpeg -i 'Arcaea Competition announcement.mp4' -map 0:v:0 -map 0:a:0 \
  -c:v copy -af volume=-10.55dB -c:a aac -b:a 192k -ar 48000 \
  -map_metadata -1 -movflags +faststart arcaea-trailer.mp4
ffmpeg -i 'Ending Song Video Final Ver.mp4' -map 0:v:0 -map 0:a:0 \
  -c:v copy -af volume=-4.45dB -c:a aac -b:a 192k -ar 48000 \
  -map_metadata -1 -movflags +faststart final-song-reveal.mp4
```

Measure the complete decoded output with
`ffmpeg -i FILE.mp4 -map 0:a:0 -af loudnorm=I=-18:TP=-2:LRA=20:print_format=json -f null -`.
