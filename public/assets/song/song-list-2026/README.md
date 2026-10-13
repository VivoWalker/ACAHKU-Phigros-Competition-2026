# Song-list jacket assets

This folder contains the 47 unique Phigros jackets matching the organiser's 49-line song list. Original 2048×1080 PNG bytes were obtained from Rhythm Archive; every image matches the official catalog SHA-256 and dimensions and passes a full decode.

- `song-map.csv` maps all 49 input lines to local `art` paths (UTF-8 with BOM).
- `manifest.json` records original titles, artists/illustrators when present in the site metadata, resource identifiers, source URLs and image checksums.
- `song-list.txt` preserves the uploaded text exactly.
- Safe ASCII image filenames work on Windows and satisfy the broadcast server's local asset path rules. The original titles remain in the mapping files.

## Use in the broadcast

When using the jacket ZIP, copy its `song-list-2026` folder into the project's `public/assets/song/` directory.

In main control → Event & library, set a song's artwork/`art` field to its mapped path, for example `assets/song/song-list-2026/01-secret-illumination.png`. The corresponding browser URL is `/assets/song/song-list-2026/01-secret-illumination.png`. These assets work offline after downloading the repository. Verify the intended chart/difficulty, eligibility and finals grouping when entering the event song library.

## Matching notes

The two repeated input songs (`INFiNiTE ENERZY -Overdoze-`, `Re：End of a Dream`) share their one local jacket file. The two `Retribution` titles have separate jackets. `BANGING STRIKE` uses the current `(new)` artwork identified by the site's Phigros browse index. The leading backslash in `\+ERABY+E CONNEC+10N` was treated as a text escape; the game title starts with `+`. Hydra, [NWAD], Chronos Collapse - La Campanella and Stardust:RAY were matched using the site's exact game song-name metadata. No substring or unreviewed fuzzy matches were used.

## Source and attribution

Source gallery: https://rhythmarchive.github.io/phigros/jacket/

Catalog and browse source commit: `57594018eee6196481636c4113229d129d3de818` in https://github.com/rhythmarchive/rhythmarchive.github.io

Art is credited to its respective creators/rightsholders; source metadata credits are preserved in the manifest. The application's source license does not grant rights to these jacket illustrations. Images are preserved without edits.
