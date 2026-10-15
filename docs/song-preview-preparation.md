# Preparing local song previews

The preparation tool requires Python 3.11+, `ffmpeg` and `ffprobe`. It uses the organiser's ZIP and the official chart catalog; it does not download replacement songs. Full music and the source ZIP must stay outside `public/` and should not be committed.

```sh
python3 scripts/prepare-song-previews.py plan /tmp/song-audio.zip --plan /tmp/song-preview-plan.json
```

This produces a private review plan. Matching considers audio title tags and filenames, normalizes Unicode punctuation, and shares one clip between the IN and AT charts of the same song. Identical source copies are deduplicated by hash. `Retribution` and `Retribution ~ Cycle of Redemption ~` remain separate. Missing songs, conflicting duplicate recordings and unmatched files appear in the plan; ambiguous matches require correction. To resolve a conflicting duplicate, choose one entry from its `candidates`, move that entry into `tracks`, and remove the resolved duplicate group.

The initial `start` is a **sustained-energy suggestion**, not an externally verified climax. Listen to each suggested section and set `start` and `duration` (10–15 seconds; default 12). Change `selection.method` to `manual` when choosing a different section, keep a useful `selection.note`, and mark `selection.reviewed: true`. If a published reference actually establishes the highlight timestamp, use `method: "referenced"` and include its URL in `selection.sourceUrl`; do not claim a reference for an automatic suggestion.

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

By default, unreviewed clips and an incomplete official catalog are rejected. `--allow-missing` deliberately exports a partial library; `--allow-unreviewed` exports clearly labelled heuristic drafts for auditioning. Neither option makes the suggestions verified climaxes. Generated Grand Final assets do not enable Grand Final page playback.

Archive entries are validated before extraction; traversal paths, symlinks, duplicate names, encrypted archives and excessive expansion are refused. Only supported audio types are extracted into a temporary directory. The tool reads catalog JSON without evaluating JavaScript.

Run the offline safety, mapping and real encoding checks with:

```sh
python3 test/song-preview-preparation.py
```

The tests create their own tones and ZIPs in a temporary directory and do not access event data or supplied full songs.
