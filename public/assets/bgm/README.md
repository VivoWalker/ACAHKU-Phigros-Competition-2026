# Phigros interface background music

These are full-length interface/background loops, separate from the competition's playable songs and song-selection previews. All audio is served locally for offline OBS use.

The public source is [DDZmumo/Phiguess, commit `3840ad52fbd121f90ed0dec69f29702114f58925`](https://github.com/DDZmumo/Phiguess/tree/3840ad52fbd121f90ed0dec69f29702114f58925/apps/web/public/audio/phigros-4.0.1). Its [audio README](https://github.com/DDZmumo/Phiguess/blob/3840ad52fbd121f90ed0dec69f29702114f58925/apps/web/public/audio/phigros-4.0.1/README.md) identifies the WAV files as an unchanged, user-provided **Phigros 4.0.1** audio collection. This is a community mirror, not an official distribution endpoint. Its [manifest](https://raw.githubusercontent.com/DDZmumo/Phiguess/3840ad52fbd121f90ed0dec69f29702114f58925/apps/web/public/audio/phigros-4.0.1/manifest.json) records original folder names, lengths and SHA-256 hashes. Every downloaded WAV was checked against that manifest before conversion on 2026-10-15.

| Local file | Original game asset / purpose | Length | Broadcast use |
| --- | --- | ---: | --- |
| `chapter-select.ogg` | `06_选曲包背景音乐/ChapterSelect0.wav` — chapter selection menu | 27.429 s | Main and waiting screens |
| `result-in.ogg` | `08_游戏结算音乐/IN_LevelOver2.wav` — IN results | 27.442 s | Per-song statistics |
| `result-at.ogg` | `08_游戏结算音乐/AT_LevelOver3.wav` — AT results | 27.442 s | Overall results and rankings |
| `chapter9-ambience.ogg` | `07_第八章第九章背景音乐/第九章_里包氛围音乐.wav` — Chapter 9 inner-pack ambience | 65.829 s | Bracket and Grand Final announcement |

Titles above are asset identifiers, not invented commercial release titles or composer credits. Music and underlying game audio rights remain with their respective owners; this repository's software license does not license these recordings.

`manifest.json` retains each exact source URL, original WAV hash, local Ogg hash, file size, duration, codec, original loudness and final measured loudness. The four Ogg files total 2,708,893 bytes. Conversion preserved the complete duration, 44.1 kHz stereo, and original pitch/speed. The recordings were normalized to a common **−18 LUFS** using two-pass linear loudness normalization with a −2 dBTP ceiling and 20 LU LRA target, then encoded as Ogg Vorbis quality 5. Original hashes refer to the unmodified source WAVs; only the processed Ogg files are bundled here.

The first pass reads loudness measurements:

```sh
ffmpeg -i SOURCE.wav -af loudnorm=I=-18:TP=-2:LRA=20:print_format=json -f null -
```

The second pass supplies the first pass's `measured_I`, `measured_LRA`, `measured_TP`, `measured_thresh` and `offset` values with `linear=true`, then encodes with `-ar 44100 -c:a libvorbis -q:a 5`. All four files confirmed linear processing. Each complete Ogg was decoded and measured again: final levels range from −18.01 to −18.05 LUFS; true peaks remain below −4.32 dBTP. Decoded durations match the originals to within 0.01 ms. Playback `gain` is `1` for all tracks; the common broadcast volume applies afterward. A default volume of 25% places the music around −30 LUFS beneath commentary.

Scene mappings are broadcast choices, rather than claims that Phigros itself uses those assets in a tournament bracket. Song selection keeps its exclusive ban/pick previews; candidate draws, gameplay and the match countdown have no background music.
