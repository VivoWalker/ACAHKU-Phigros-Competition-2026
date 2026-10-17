# Preparing local song previews

The preparation tool requires Python 3.11+, `ffmpeg` and `ffprobe`. It uses the organiser's ZIP and the official chart catalog; it does not download replacement songs. Full music and the source ZIP must stay outside `public/` and should not be committed.

```sh
python3 scripts/prepare-song-previews.py plan /tmp/song-audio.zip --plan /tmp/song-preview-plan.json
```

This produces a private review plan. Matching considers audio title tags and filenames, normalizes Unicode punctuation, and shares one clip between the IN and AT charts of the same song. Identical source copies are deduplicated by hash. `Retribution` and `Retribution ~ Cycle of Redemption ~` remain separate. Missing songs, conflicting duplicate recordings and unmatched files appear in the plan; ambiguous matches require correction. To resolve a conflicting duplicate, choose one entry from its `candidates`, move that entry into `tracks`, and remove the resolved duplicate group.

The initial `start` is a **sustained-energy suggestion**, not an externally verified climax. Review each section and set `start` and `duration` (10–15 seconds; default 12); listening is recommended before broadcast. Keep a useful `selection.note` and mark `selection.reviewed: true` after reviewing the selection. Record the actual review method in `selection.reviewMethod` and whether listening occurred in `selection.auditioned`; waveform review must not imply an auditory review. Use `method: "manual"` for an auditioned manual choice, or retain `energy-suggestion` for a selection made from signal/structure analysis. If a reference actually establishes the selected window, use `method: "referenced"` and include its URL in `selection.sourceUrl`; do not claim a reference for an automatic suggestion.

The bundled 2026 cuts use the organiser's five-volume 7z upload: concatenate volumes in numeric order, inspect archive entries, and extract only regular files into a private temporary directory. A private ZIP conversion is used by the existing tool. The source archive contains a CSV mapping game filenames to titles; this was checked against all 48 unique official titles before encoding. It resolves short titles such as Ark and 彩, and aliases such as Cuvism³ and sølips, which filename guessing alone cannot reliably match. The unused old-list song is excluded. Source hashes and exact cut timestamps remain in the shipped manifest and `preview-map.csv`; full songs and the source archives are excluded from the repository.

28 cuts use in-game preview windows from a [pinned community export of GameInformation](https://raw.githubusercontent.com/000ylop/Phigdata/5cc4ec2f26c2d8cbcc2bb0d6d254a2297272d6bf/MonoBehaviour/GameInformation.json); the remaining 20 use reviewed waveform and spectral structure. The game windows are recognisable preview references, not proof of a unique musical climax. All selections explicitly record `auditioned: false`. For Re：End of a Dream, the reference is only 9.34 seconds: the 10-second cut starts 0.66 seconds earlier and retains the reference end. AbsoluTe disoRdeR uses a later return after a breakdown because its referenced preview begins in a much quieter intro.

```json
{
  "title": "Song title",
  "songIds": ["competition-2026-de-01"],
  "sourceFile": "songs/Song title.mp3",
  "sourceSha256": "sha256 recorded by the plan command",
  "sourceDuration": 150.0,
  "start": 72.0,
  "duration": 12,
  "selection": {
    "method": "manual",
    "reviewed": true,
    "note": "Main drop after the breakdown",
    "sourceUrl": ""
  },
  "output": "assets/song-preview/competition-2026-de-01.mp3"
}
```

Keep the generated `archiveSha256` and source hashes. After reviewing all tracks:

```sh
python3 scripts/prepare-song-previews.py render /tmp/song-audio.zip --plan /tmp/song-preview-plan.json
```

The command checks the original hashes, chart IDs and trim boundaries, encodes 160 kbps stereo MP3s, applies short click-prevention fades and a peak limiter, and verifies every encoded duration. MP3 padding can make a 15-second trim slightly longer than 15 seconds; use 14.9 seconds or less at the upper limit. Normal music playback fades are handled by the selection player separately.

The generated `public/assets/song-preview/manifest.json` includes the preview path and duration for each chart ID, clip/source hashes and highlight provenance. It excludes the original ZIP paths and full music. All clips are encoded and checked privately before publication. Each encoded clip and the manifest are then copied or written into a temporary file beside their destination, flushed to disk and atomically replaced, so a separate `/tmp` filesystem works correctly. An encoding failure leaves the existing published clips and manifest untouched.

By default, unreviewed clips and an incomplete official catalog are rejected. `--allow-missing` deliberately exports a partial library; `--allow-unreviewed` exports clearly labelled heuristic drafts for auditioning. Neither option makes the suggestions verified climaxes. Generating files alone does not start playback; the fixed Grand Final's main-control announcement cue plays its two bundled previews in order. Preserve its 12.042449-second windows when replacing those files so the shared presentation timeline remains aligned.

Archive entries are validated before extraction; traversal paths, symlinks, duplicate names, encrypted archives and excessive expansion are refused. Only supported audio types are extracted into a temporary directory. The tool reads catalog JSON without evaluating JavaScript.

Run the offline safety, mapping and real encoding checks with:

```sh
python3 test/song-preview-preparation.py
```

The tests create their own tones and ZIPs in a temporary directory and do not access event data or supplied full songs.
