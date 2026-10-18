# Final-song reveal video

Put the final song's reveal video in this directory, for example `final-song-reveal.mp4` (H.264 video with AAC audio is recommended). The video has not been supplied yet.

In the main control's **Grand Final / 最後一首** panel, enter the actual song title, chart difficulty and integer level, then configure:

- Local video path: `assets/finale/final-song-reveal.mp4`
- Video duration: the exact duration in seconds, including its ending; a decimal is supported.

The video plays once, with its own audio, on the active OBS live source. Menu music and song previews are stopped during playback. Control previews and `audio=0` sources show the video muted. After the shared video clock ends, the live overlay returns to the final-song waiting screen and reveals the configured song title. A refreshed or reactivated source seeks to the current playback position.

Use **手動結束影片** if the video must be interrupted, or **直接公布並返回準備** to rehearse without an uploaded video. The third song contributes to the sum of all three Grand Final scores. The first-two-song standings do not confirm a champion.

The main control offers three sequential purification effects and a **恢復普通效果** button for the last song. Existing event data and staff passwords do not need replacing.
