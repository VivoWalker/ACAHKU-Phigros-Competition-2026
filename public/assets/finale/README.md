# Final-song reveal video

The final-version final-song PV is bundled as `final-song-reveal.mp4` (H.264/AAC, 1920×1080). Its path and measured 88.512-second duration are selected automatically when no replacement is configured. Saved defaults using the first PV's 94.333008-second slot adopt the new duration before playback. Custom paths and timings keep their settings; an active saved cue keeps its clock until the next play action. See [processing and loudness measurements](../broadcast-videos/README.md).

The final song is **What do you want more than a Happy ending? — AT 17**. Its title and difficulty are already filled in on the main control, and starting the finale setup or provisional-total step automatically attaches it to an unfinished GF. No title entry is needed. Artwork and composer remain unspecified until their actual assets/metadata are supplied. Existing explicitly configured final songs are preserved.

The main control's **Grand Final / 最後一首** panel already contains these defaults. For a replacement, configure:

- Local video path: `assets/finale/final-song-reveal.mp4`
- Video duration: the exact duration in seconds, including its ending; a decimal is supported.

The video plays once, with its own audio, on the active OBS live source. Menu music and song previews are stopped during playback. Control previews and `audio=0` sources show the video muted. After the shared video clock ends, the live overlay returns to the final-song waiting screen and reveals the configured song title. A refreshed or reactivated source seeks to the current playback position.

Use **手動結束影片** if the video must be interrupted, or **直接公布並返回準備** to rehearse without an uploaded video. The third song contributes to the sum of all three Grand Final scores. The first-two-song standings do not confirm a champion.

The main control offers three sequential purification effects for the last song: irregular pixel erosion, detached fragments and narrow tears open through the red corruption, expand and merge across the screen without repeated square tile outlines, clearing roughly 28%, 65%, then all of the red effect. Text glitches use short stepped displacements and red/cyan splits. Each stage reduces UI jitter; the final stage removes added flicker and adds a soft glow to text only. Reduced-motion mode freezes the geometry. **恢復普通效果** removes the added treatment. Existing event data and staff passwords do not need replacing.
