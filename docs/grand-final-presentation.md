# Grand Final song reveal

The official fixed-song Grand Final has a staged broadcast presentation:

1. Show the bracket and select **公布決賽第一首**.
2. Reveal **Desultory Signals / IN17** with its jacket and preview clip.
3. After that clip's window, automatically reveal **Petrichor / AT17** with its jacket and clip.
4. Stop audio after the second window. The operator advances to first-song preparation, then gameplay using the normal controls.

Only one song is visible at a time. Main control can replay the whole sequence, skip to the second song or replay that second step. These presentation commands never change the gameplay song cursor or scores. Staff previews are muted. Legacy audience/MC finals retain their existing flow.

## Shared clock and audio

`GF.finalAnnouncement` persists only a UUID and start timestamp. The browser helper and preview player use the same 500 ms lead and two 12.042449-second windows. No server timer or score write advances the song. Normal state updates do not restart it; a refresh or reconnect joins the current time, and a completed cue stays complete. The existing anchored server clock remains authoritative during a disconnect, while audio and moving effects pause off air.

The dedicated announcement owns program audio and suppresses menu BGM before, during and after both clips. Leaving it fades out the preview before a waiting-scene BGM resumes. Gameplay has no menu BGM. Extra browser sources should use `audio=0`; the main-control preview already does so. If autoplay is blocked, enable audio through OBS Interact; playback resumes at the current shared phase.

The fixed cue's duration windows take precedence over decoded audio length. Keep replacement GF clips at the same length: longer replacements are cut at the window and shorter replacements leave silence until the next step. Regular DE previews retain their existing metadata-based lengths.

## Red corruption layer

The first reveal grows a morphing, pixel-stepped red front from the bottom toward one-third coverage. The second grows it toward two-thirds. The supplied local red texture adds grain, while bounded vector contours and 220 square particles provide changing shapes and upward flow. The existing 1920×1080 broadcast canvas is retained; there is no aspect-ratio override.

This layer is a persistent group inside the background's existing capture mask. It cannot fill the OBS capture-card or handcam holes, and the persistent branding plane remains above it. Subsequent GF waiting, gameplay, score and result screens retain a dimmer red layer and small drifting red accents. Qualifier and other matches remain unaffected. A reset or reviewed reopening clears the GF presentation cue; historical correction records retain their original snapshots.

The controller updates vectors at most 20 times per second with a fixed node count. A short 100 ms phase check exists only during an active reveal; it triggers DOM rendering only at phase changes. Hidden, inactive, disconnected and disposed sources stop their frame/timer work. Reduced-motion mode uses a static shape. The texture is decoded ahead of the reveal using the existing bounded media warmup queue. No fullscreen blur, strobe or per-frame DOM rebuild is used.

The texture is `public/assets/finale/error-texture.png`, generated from the organiser's supplied red-error visual reference. Its source image is retained in the cloud workspace's generated-images directory. It is a decorative local asset with no network dependency.

## Final song and purification

After the first two songs, show their provisional totals, enter the sealed waiting screen, play the final-song reveal video and return to waiting. The final song is **What do you want more than a Happy ending? — AT17**. Its metadata is attached only when an unfinished GF explicitly enters the finale setup or subtotal flow; completed historical two-song finals and existing custom or scored final songs are preserved. The champion is decided by the sum of all three scores.

During the last song, the main operator's three purification stages open distributed pixel holes through the red corruption. Their edges have irregular 8px notches and detached fragments; local boundary pixels glitch on the shared clock, with reduced motion in Stage 2. Holes expand and join: scattered gaps appear first, most of the red is removed in Stage 2, and Stage 3 clears the remainder. The pattern uses the pixel grid rather than a circular opening from the screen centre. UI movement diminishes across the stages; Stage 3 has no added jitter or flicker and retains bright outlines. Reduced-motion mode freezes the geometry. **恢復普通效果** removes the added treatment. Video placement remains documented in `public/assets/finale/README.md`.

## Verification

The new Node tests cover the shared timeline, player clocks, lifecycle cleanup, server permissions, atomic commands and restart persistence. `test/final-announcement-browser.py` checks both announcements, program audio ownership, responsive text geometry, morphing coverage, persistent background/logos, capture alpha and off-air cleanup. Existing fixed-final, selection-audio, scene-BGM and production-console browser checks retain their catalog, scoring and legacy coverage with the sequential reveal expectations.

After updating, restart the server and refresh main control and every OBS Browser Source to load the new helper and effects scripts. Preserve the existing event data directory.
