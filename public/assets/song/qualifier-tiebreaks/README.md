# Qualifier tiebreak songs

Round 1 uses **Aleph-0 — IN 16**; Round 2 / Revival uses
**ぱぴぷぴぷぴぱ — IN 15**. These current IN charts are fixed qualifier
tiebreaks and are excluded from the random DE song pool. Base Challenge totals
stay unchanged; confirmed extra-song scores resolve only the qualification tie.

The original PNG jackets were retrieved from the published Rhythm Archive
catalog and verified against its SHA-256 hashes. [manifest.json](manifest.json)
records the pinned catalog, resource IDs, chart metadata and download URLs.

The 12-second music fragments are local under
`assets/song-preview/qualifier-tiebreaks/`. Their start positions follow the
in-game preview windows in pinned Phigdata metadata: 11.519 seconds for Aleph-0
and 92.6 seconds for ぱぴぷぴぷぴぱ. Only these fragments are shipped; the full
source Ogg files are not published. The audio
[manifest](../../song-preview/qualifier-tiebreaks/manifest.json) records pinned
source URLs, original Git blob IDs, SHA-256 checksums and loudness measurements.
Constant gain aligns the fragments to approximately −18 LUFS before the saved
master volume, with measured true peaks below −2 dBTP.

An unresolved cutoff tie follows these operator steps:

1. Rankings show the tied cutoff players in yellow. **準備晉級加賽** selects
   those players and opens waiting, concealing the song on public and scorer views.
2. **公布加賽曲目** shows the jacket, title, IN/level and competitors, and plays
   the fragment once on the shared preview clock. Reloading joins the same cue;
   unrelated state/volume updates do not restart it. Staff previews stay muted.
3. **比賽準備** returns to waiting with the now-revealed song and difficulty.
4. Match → results processing → single-song results keeps the extra-score and
   Perfect/Good/Bad/Miss editors available.
5. Arbiter confirmation returns directly to the updated advancement rankings.
   Another unresolved tie remains yellow and requires another extra game.

The live source follows `qualifier-tiebreak-announcement`; a dedicated source is
available at `overlay/qualifier-tiebreak-announcement.html?fixed=1`. A saved
tiebreak without the new concealment flag retains its existing announced-song
behavior.
