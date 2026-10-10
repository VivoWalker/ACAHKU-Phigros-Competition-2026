# ACAHKU Phigros Broadcast

A local tournament server, transparent OBS overlays and an iPad-friendly control panel. The broadcast uses a quieter presentation with larger, bold titles, player names and totals, plus one shared current-song line. Each player's capture card and handcam can appear together; staff can switch between single and dual views live. Full scoring and tournament controls remain in the staff panel. HTML, CSS and JavaScript with Express and Socket.IO; no frontend framework, CDN, cloud login or Internet connection is needed while running the show.

## Quick start

Install Node.js **20 or newer** (verified with Node 24). From this project folder:

```sh
npm install
npm start
```

The downloadable **offline bundle** already includes the verified JavaScript dependencies and local fonts. With Node.js installed, unzip it and run `npm start` directly; `npm install` is only needed to install or refresh dependencies in the source-only package.

Keep that terminal open. It prints the laptop's LAN addresses and a **six-digit control pairing code**. Open the control panel and enter the code:

```text
Control Panel:       http://localhost:3000/control/
iPad on the LAN:     http://192.168.x.x:3000/control/
OBS Browser Source:  http://localhost:3000/overlay/start.html
```

The pairing code separates staff-only state from the public broadcast. It is created locally in `data/.control-pin`. The laptop and iPad do not need external accounts. Pairing is retained in that browser tab, including server restarts with the same data directory. You can optionally set `CONTROL_PIN` before starting the server. `PORT` defaults to `3000`; `HOST` defaults to `0.0.0.0` so the iPad can connect.

Initial data contains **sample players and editable sample song metadata**, with no scores or seeded bracket. Verify the official song pool, chart levels and roster before using it for the event. The supplied Phigros logo, society logos and event key visual are bundled as local files; see the replacement instructions below.

When upgrading an existing installation, preserve the whole `data/` folder, replace the application files, restart the server, and refresh every control-panel tab and the OBS Browser Source once. Older control scripts without explicit match IDs are rejected by the updated server; existing valid schema-1 event files and paired sessions remain supported.

## Laptop + iPad

1. Connect both devices to the same Wi-Fi or wired LAN. A network with client isolation or a guest Wi-Fi policy can block device-to-device access.
2. Start the server on the laptop. Its terminal prints an `iPad:` address. You can also find the laptop's IPv4 address with `ipconfig` on Windows, `ipconfig getifaddr en0` on macOS Wi-Fi, or `ip -4 addr` on Linux. Use the LAN address, not a VPN or loopback address.
3. On the iPad, open Safari and enter `http://<laptop-LAN-IP>:3000/control/`. Enter the pairing code from the laptop. Use either orientation.
4. If necessary, allow Node.js / TCP port 3000 through the laptop's firewall **on the local network**. Internet port forwarding is unnecessary.
5. Check that the control panel says **Connected to laptop**. Changes save after the server acknowledges them; the footer shows the saved revision. Offline controls reject updates and automatically reconnect. Broadcast overlays keep their last saved frame during disconnection.

The preview inside the control panel counts as one connected overlay. “Overlay connected” means a browser source is receiving state; it does not prove OBS itself is connected. OBS WebSocket integration is reserved in `lib/obs-adapter.js`, and is not enabled in this version.

## OBS setup

1. Add each player's capture-card source to an OBS scene. Add their handcam source as well if you want to use dual view, and position both using the rectangles below.
2. Add a **Browser Source** above those sources. Disable **Local file**, use `http://localhost:3000/overlay/start.html`, and set **Width 1920 / Height 1080**.
3. Keep the Browser Source active. Prefer leaving **Shutdown source when not visible** and **Refresh browser when scene becomes active** unchecked; scene changes arrive over Socket.IO.
4. Use the control panel's **Broadcast** tab to select the on-air screen. The same Browser Source changes scenes without a reload. Shared logos, artwork and player names move to their new positions; other content exits before the new content slides in. It does not switch your OBS capture sources or OBS scenes automatically.
5. In **Broadcast → 畫面顯示**, select **單畫面** for capture card only or **雙畫面** for capture card plus each player's handcam. This setting updates all connected overlays immediately and is saved across restarts. Capture-card positions stay fixed; single view covers the handcam areas with the overlay background. Keep both sources beneath the Browser Source. The interface does not capture video or move OBS sources. Different player counts may use separate OBS scenes with the matching source arrangement.
6. In the Broadcast source-check panel, enter the actual OBS capture-card and handcam source names for each slot, save them, inspect the real feeds, and confirm the manual check. Changing entrants, their names, the match, sources, stage or single/dual mode invalidates that confirmation. A restored backup also requires a new check. This records a crew member's visual check; it does not connect to OBS, inspect video, or switch sources automatically.
7. Once the players are ready, select the qualifier or double-elimination **match screen**, then press **Broadcast → 比賽開始倒計時 → 開始倒計時 · 3 2 1 START**. Each number lasts one second; START displays for 700 ms, followed by a 250 ms fade. The opaque countdown covers the whole Browser Source, including logos and capture windows, and then restores the match. **取消倒計時** removes it immediately. Both single and dual views support it; a Grand Finals MC song must be revealed before its countdown can start.

The countdown uses one server timestamp for all connected sources and the control-panel preview. Refreshing or reconnecting during a countdown resumes the current number; an expired countdown or server restart does not replay it. Changing the scene, match, selected players, current song, single/dual mode or saved source assignments cancels it. Score updates keep its original timing. Countdown commands require a paired staff session and do not change scores, save a revision or create a backup. This is a visual start cue without audio.

All overlay documents keep their root and body backgrounds transparent. Opaque or translucent information panels are intentional; gameplay and webcam interiors contain no fill. The canvas is always 1920×1080 and fits smaller viewports with its 16:9 ratio intact.

The filtered background stays mounted between scenes; only the transparent capture apertures change. Exit snapshots copy only the appearance/layout styles they use, keeping scene switches lightweight. On a scene change, the old content first slides **left and fades out**, starting with the leftmost element. Exits use the same nonlinear easing, 560 ms duration and 65 ms stagger as entrances. Outgoing snapshots are clipped to their original slots and removed automatically; score and state revisions continue to commit immediately. Logos then move on the top layer for **760 ms**, using nonlinear easing. During that travel, the new scene's content and video apertures wait so branding never crosses visible content. New elements then enter **from right to left with a fade**, beginning with the leftmost element (top to bottom for equal horizontal positions); each entrance lasts 560 ms and starts 65 ms after the preceding one. Incoming elements stay inside their final slots, and logos are never clipped behind text or video. Score and state revisions apply immediately; in-flight animations retain their original timing when those revisions arrive. Song artwork keeps its 550 ms nonlinear slide inside its fixed slanted window, with at most two images. Rapid requests retain the latest scene, and Reduce motion makes every transition immediate.

### Overlay documents

| Screen | Path |
| --- | --- |
| Start screen / default source that follows scene controls | `/overlay/start.html` |
| Qualifier waiting | `/overlay/qualifier-waiting.html` |
| Double elimination waiting | `/overlay/double-elimination-waiting.html` |
| Three-player qualifier match | `/overlay/qualifier-match.html` |
| Two-player double elimination match, including the three-song final | `/overlay/double-elimination-match.html` |
| Group A / B qualifier rankings or double elimination result | `/overlay/result.html` |
| Current-round bracket focus and advancement destinations | `/overlay/bracket.html` |
| Additional requested song-selection screen | `/overlay/song-selection.html` |

`/overlay/live.html` is an alias for the source following the control panel; it is not an extra tournament scene. The start document follows the shared scene by default. Other named documents show their named screen and still update live data. Append `?follow=1` to make any document follow scene controls, or `?fixed=1` to pin a preview (including the start screen). Thus there are seven main screens plus the separately requested selection screen.

Capture-card source rectangles in the 1920×1080 canvas, in player order. These positions are identical in single and dual view:

| Layout | Gameplay frames (x, y, width, height) |
| --- | --- |
| Three-player qualifier: three equal columns | `(64,300,576,324)`, `(672,300,576,324)`, `(1280,300,576,324)` |
| Two-player match / final: side by side | `(64,280,872,490.5)`, `(984,280,872,490.5)` |

The qualifier's first, second and third selected players occupy the left, middle and right columns. Match displays show each player's name and total, plus a shared current song and progress indicator. Individual song scores stay in the control panel. Append `?details=1` to show a compact per-song score line alongside each player’s capture. **Upgrading from the old single-view layout:** realign the three qualifier capture-card sources once to the new fixed columns.

Handcam rectangles, paired in the same player order:

| Layout | Handcam frames (x, y, width, height) |
| --- | --- |
| Three-player qualifier | `(64,800,240,135)`, `(672,800,240,135)`, `(1280,800,240,135)` |
| Two-player match / final | `(64,846,224,126)`, `(1632,846,224,126)` |

Use the normal URL without `cameras` for control-panel switching. For a source that must remain in one mode, the existing `?cameras=1` forces dual view and `?cameras=0` forces single view, overriding the shared setting. Options can be combined, for example `/overlay/live.html?cameras=1&details=1`. Use OBS's transform and crop controls to fit the captures. Exact rectangles are accessible through `[data-capture]`; each frame also carries `data-player-id` and `data-feed` (`capture-card` or `handcam`) to identify the paired sources. When changing the selected entrants, make sure OBS shows the corresponding players in those slots.

Qualifier results show separate Group A and Group B ranking tables. Groups with up to four players use large text; five to eight use a compact table. Longer groups show **eight players per page**, with a visible range such as `1–8 / 32`, and automatically turn pages every **12 seconds**. Each group cycles through its own pages. To keep a particular page on screen, append `?rankPage=2` (or `&rankPage=2` when another option is present). A requested page beyond a group's page count displays its last page.

### Local logos and key visual

The supplied transparent character PNG, Phigros logo, Soc Logo and Kirameki logo are already bundled as local assets. The two society logos keep their original image bytes and proportions. To add or replace branding, copy the real artwork into this project's local asset directory:

```text
public/assets/event/phigros-logo.webp
public/assets/event/key-visual.png
public/assets/event/soc-logo.png
public/assets/event/kirameki-logo.png
```

`/api/branding` recognises these fixed local filenames, in the listed priority order:

| Asset | Accepted filenames in `public/assets/event/` |
| --- | --- |
| Phigros logo | `phigros-logo.webp`, `phigros-logo.png`, `Site-logo.webp`, `Site-logo.png` |
| Event key visual | `key-visual.png`, `key-visual.webp`, `key-visual.jpg`, `key-visual.jpeg`, `PhigrosComp Poster (A5 size).jpg` |
| Soc Logo | `soc-logo.png`, `soc-logo.webp` |
| Kirameki logo | `kirameki-logo.png`, `kirameki-logo.webp` |

The start screen places the society logos to the right of the organiser's name, with **Soc Logo on the left and Kirameki on the right**, at a larger size. Every other screen places the same pair in the upper-right corner in the same order. Both logos display directly with their original transparent backgrounds.

Refresh the OBS Browser Source after copying or replacing a file. The API checks the directory on each request, so a server restart is unnecessary. Start and waiting screens show the supplied transparent character alongside short event or next-match information. The PNG keeps its original transparency and proportions, with the full character and book visible. PNG/WebP take priority over older JPG copies. If an asset is absent, the display leaves that area clear and uses event text; it does not substitute a fabricated poster or logo. Original Windows paths such as `E:/...` are not browser assets: the files must exist in this project's `public/assets/event/` directory on the machine running the server. Once copied, artwork is served locally and needs no Internet connection during the event.

## Staff workflow

### Qualifiers

1. In **Event & library**, verify event name, organiser, date, time, venue and song metadata.
2. In **Qualifiers**, edit the Group A and Group B rosters (one name per line). Names unchanged within a group retain their scores. Use **Rename player** to correct a name while keeping its player ID, scores and bracket references, including after seeding. Bulk roster replacement cannot remove a player who already has scores.
3. Optionally use **Randomise A / B** before any scores have been entered. This balances the two groups. It cannot redistribute scored players.
4. Select three different group songs for each group. The groups must have different sets; a group's selection is locked once its scoring begins.
5. Choose up to three on-stage players, select the current song, and use the waiting or match scene. Empty slots remain empty; no fake scores are inserted.
6. Enter integer Phigros scores from 0 to 1,000,000. Changes save on field change / leaving the input. A blank is unplayed; **zero is a valid score**. Rankings use the three-song sum.
7. Equal totals need unique **Tie order** values, with `1` first, based on the referee's decision. All scores must be complete and the top-four ordering unambiguous before advancement.
8. **Advance top four** locks qualifier scores and creates the bracket. Default seeds alternate **A1, B1, A2, B2, A3, B3, A4, B4** because the groups play different songs; they are not ranked together by incomparable totals. Manual seed ordering is available in **Bracket → Seeding & vacancies** before scoring or results begin.

### Regular double elimination, R1–R5

1. Select a ready match in **Bracket**. Pending matches cannot start until both incoming paths resolve.
2. In **Song selection**, draw six distinct candidates from songs marked eligible for regular draws.
3. P1 and P2 each ban one different song. A ban can be changed or removed before the final draw. Both sides are clearly labelled with the actual player names.
4. **Draw 2 match songs** randomly chooses two of the remaining four. These songs automatically populate the match overlay and scoring fields. Picks lock further bans.
5. Enter both players' two scores and select Song 1 / 2 or Song 2 / 2. The winner is determined by the two-song total.
6. In **Record result**, confirm the result. For a tied total, choose a referee winner and provide an adjudication note. All song scores are required; partial totals cannot win.
7. The result opens incoming winner/loser paths. The live scene changes to result announcement. Select the next ready match to continue.

**Reset current match** clears candidates, bans, picks and scores only for the unfinished current match. It preserves entrants, seeding and every other result. Score entries and other match commands carry the displayed match ID; a command for a different selected match is rejected. Switching matches keeps their drafts separate. Unsaved form fields, dropdowns and checkboxes survive live updates and tab changes. If another operator edits the same field, the panel retains the draft and requires an explicit conflict review.

Completed results lock against ordinary editing. To correct one, preview its downstream impact in the result-correction panel, enter a reason, and explicitly confirm any affected selections, scores and results that must be cleared. Reopening retains the chosen match's songs and scores for correction, selects it as the active match, and clears its dependent matches before the result is confirmed again. An unrelated newer update invalidates the reviewed preview and requires another review. The automatic backup and private correction log retain the previous data. A result belonging to a vacancy lottery with reassigned entrants must instead be corrected by restoring a backup from before that lottery. There is no one-click whole-tournament reset.

### Grand Finals, R6

1. Select **GF** after both bracket champions are known.
2. Set **eight distinct candidates**. You can add songs not in the regular pool via **Event & library**, leaving their regular-draw checkbox off.
3. Record two audience picks (from a live vote or the MC's interpretation of audience reactions), then choose the different third **MC pick** in the staff-only controls. This package records the choices; it does not provide a public voting service.
4. Lock the picks. The staff panel can see the MC selection; public state and overlay broadcasts replace the third selected song with **MC PICK — SEALED**. Candidate titles are still visible as candidates, but no candidate is identified as the hidden MC pick. Staff state and export endpoints require the paired session.
5. **Reveal MC song to broadcast** explicitly publishes it. The third song cannot be selected as current or scored before reveal.
6. Enter all **three** scores for both players and confirm the three-song result. The result screen shows **Champion** and **First Runner-up**.

### Fourteen-match bracket

| Round | Matches | Incoming / outgoing paths |
| --- | --- | --- |
| R1 | W1, W2, W3, W4 | Seeds 1–8, 4–5, 2–7, 3–6; winners to W5/W6, losers to L1/L2 |
| R2 | W5, W6; L1, L2 | WB winners to W7; WB losers to L3/L4; LB winners stay in LB |
| R3 | W7; L3, L4 | W7 winner to GF, loser to L6; L3/L4 winners to L5 |
| R4 | L5 | Winner to L6 |
| R5 | L6 | Winner to GF; loser is **Third place** |
| R6 | GF | Champion vs. First Runner-up |

L3 pairs the L1 winner with the W6 loser, and L4 pairs the L2 winner with the W5 loser to reduce immediate rematches. The progress overlay gives the current round a large, readable panel, with its actual destination matches alongside it and a six-round progress rail above. Winners and advancing players use green, losers transferring to the losers' bracket use amber, and eliminated players use red. Each completed player's route names the destination group, round and match; paired highlights connect the source row to its destination row. Final results also identify the champion, runner-up and third-place finisher. Detailed seeds, losses, advancement paths and adjudication notes remain available in the control panel. Two losses mark elimination.

The focus advances only when **every match in the current round** has finished, including both WB and LB matches in R2/R3. Completed-round results remain visible for **3.4 seconds** after their reveal begins. The old round then slides left, shrinks and fades out over **700 ms**; the next round slides in and expands over **950 ms**, using nonlinear easing. Live state revisions retain the original animation timing. Append `?round=1` through `?round=6` to `/overlay/bracket.html` to keep a particular round visible for historical results; that view still receives live data updates.

In the automatic view, a reviewed result correction cancels the current reveal or round transition, removes outgoing panels and returns focus to the earliest unfinished round, with corrected advancement paths. A fixed historical view stays on its requested round. With Reduce motion enabled, round changes and corrected results apply immediately, without the result hold or animation.

The requested **14-match format has one decisive Grand Final and no bracket reset**. If the WB champion loses GF, they finish as runner-up with one loss. This exception is preserved rather than silently introducing a fifteenth match.

### Vacancies and lottery byes

Use empty manual seed slots to represent absences. In a match with zero or one player, **Record vacant-match bye** advances its available player without inventing a loser or a loss.

For a four-player entry field with exactly three players and one vacancy, open **Vacancy, bye & lottery**. Choose the recorded draw winner or leave the dropdown blank for a random local lottery, then **Draw four-player bye**. The selected entrant advances directly; the other two stay paired in the companion match. Both entry matches must be ready and unscored, and the lottery must happen **before either match draws candidates, bans or selects songs**. Supported fields are W1/W2, W3/W4, and L1/L2. Eligible entrants, chosen player, destination, timestamp and notes are recorded in `drawLog`; the progress overlay marks the draw result. An unrelated player cannot receive the bye.

## Data, backups and local resources

- Shared state is stored atomically after every successful command in `data/match-state.json`. Restarting the server or refreshing a browser preserves it. Failed and stale commands do not overwrite it.
- Every successful update first creates a private automatic snapshot in `data/backups/`; the latest **500** snapshots are retained. A failed snapshot or official save does not advance the in-memory state. **Event & library** lets paired staff preview an automatic backup and restore it with a reason. Restore saves the current version first, uses a new revision, and updates all controls and overlays. A concurrent update invalidates the restore confirmation. Recent actions and recovery reasons remain in the private audit log.
- **Export state backup** downloads a staff-only JSON backup for storage elsewhere. To restore an exported file manually: stop the server, preserve the entire current `data/` folder, place the complete backup at `data/match-state.json`, and restart. Keep the PIN and session-key files to preserve paired browser sessions. Backups include unrevealed selections and must remain private.
- Startup fully validates the saved tournament before publishing it. If it is damaged and a valid automatic backup exists, the server preserves the damaged bytes in `data/match-state-damaged-*.json`, restores the latest valid snapshot, and shows a recovery notice to staff. Check the restored scores and actual OBS feeds before proceeding. With no valid backup, startup fails clearly and preserves the original file.
- New events can use `data/match-state.example.json` after preserving the old event and stopping the server. There is deliberately no destructive reset button.
- A second operator's newer revision is detected; stale commands are rejected and current state is sent back. Reconnect or inspect the latest state before retrying an unacknowledged command.
- Add authorised song artwork to `public/assets/song/`, then edit its local `assets/song/file.webp` path in the library. HTTP/CDN artwork paths are rejected. Existing match candidate/pick metadata stays fixed after a draw; library changes affect future draws. A qualifier group's song title, artist, difficulty and level lock once that group starts scoring; create a new library entry for a different chart.
- Song-art placeholders are bundled. Actual event branding is loaded only from the local logos and key-visual files described above. Uploaded skill screenshots were used only for visual analysis and are not shipped as page backgrounds. Saira is a **local implementation candidate**, not a claim about the original game font. Its SIL OFL licence is included. Hong Kong CJK fonts use system fallbacks (`Source Han Sans HC`, `Noto Sans HK`, `PingFang HK`, `Microsoft JhengHei`).
- CSS and scripts are separate local files. `public/assets/ui/phi-ui.css` and the mesh/icons come from the supplied `phigros-web-ui` skill. The broadcast reduces repeated headings, explanatory copy and large score cards while keeping horizontal text, restrained angled surfaces, masked cover changes and reduced-motion support.

### Adding song artwork and preview clips

The control panel's **Event & library → Song library** form keeps a **Local artwork path** field and adds an optional **Music preview path** field. Copy artwork into `public/assets/song/` and already-trimmed audio clips of about **10 seconds** into `public/assets/song-preview/`, then fill in their paths relative to `public/`:

```text
Artwork: assets/song/song-01.webp
Preview: assets/song-preview/song-01.mp3
```

Preview paths support MP3, OGG, WAV and M4A. Use ASCII filenames with letters, digits, underscores or hyphens. The preview field can remain blank, or hold a path before the file is supplied. This version reserves and saves the optional song field `previewAudio`; it does not load, play or trim audio yet. A future player should read this field only for a visible, unsealed song. The audio clip's approximate 10-second length is a preparation guideline, not an enforced playback limit.

Save media paths **before drawing candidates or selecting match songs**. Existing candidates and match picks retain their saved metadata; editing the library affects future draws. To fill artwork or audio for a saved selection, replace the file at its existing path and refresh the relevant browser. Old event files without `previewAudio` remain compatible, and older clients that omit the field preserve an existing value; explicitly clearing it removes the path. After upgrading the server files, restart the local server and refresh the control panel and OBS Browser Source, preserving the existing `data/` directory.

Song-art switches in both the staff selection panel and the broadcast selection screen take **550 ms**, with nonlinear easing, decoded-image loading and at most two clipped artwork layers.

## Validation and development

```sh
npm ci
npm test
npm run dev
```

`npm test` uses temporary data and covers group rankings, ties, selection rules, complete bracket progression, podium placements, byes/lotteries, private finals picks, atomic persistence, authenticated HTTP/Socket.IO, disconnection recovery, server restart, local branding lookup, and saved display modes with backwards compatibility for older tournaments. It does not modify the production tournament.

The repair regressions also cover commands aimed at an old match, stable player renaming, locked qualifier chart metadata, reviewed downstream result corrections, snapshot retention, disk failures, damaged-state recovery, authenticated restores and private source-check invalidation.

The countdown server regressions use real paired/public Socket.IO clients to check shared timestamps, authorization, duplicate and stale commands, automatic cancellation, refresh/restart behavior, unchanged saved state, and sealed Grand Finals picks. Its optional browser regression requires Python Playwright, Pillow, Chromium and ffmpeg. It checks the real start/cancel controls, number timing and legibility, full-screen coverage, restored transparent captures, synchronized sources, refresh during a cue, reduced motion and responsive controls:

```sh
python3 test/countdown-layout.py
```

Optional browser smoke test, if Python Playwright, Pillow and Chromium are installed:

```sh
python3 test/browser-smoke.py
```

It exercises real controls against temporary data, checks 8 overlay scenes, 1920×1080 / 720p / 540p scaling, iPad landscape/portrait and phone widths, alpha in every capture frame, offline reconnection, no navigation during state updates, local-only requests, keyboard selection and reduced-motion. Screenshots go to ignored `test-results/`. Browser emulation is not a physical iPad or OBS/CEF hardware test; rehearse those devices and actual capture sources before the event.

The motion regression checks all 56 directed page changes frame by frame: logo duration/layering, left-to-right exit/entrance order, right-to-left fade/slide, outgoing snapshot cleanup, element overlap, stage bounds, rapid updates, reduced motion and transparent captures. Cover loading, replacement and keyboard interaction use a separate suite. Both operate on temporary event data:

```sh
python3 test/motion-layout.py
python3 test/background-continuity.py
```

Set `MOTION_TEST_SCOPE=scenes` or `MOTION_TEST_SCOPE=covers` for a focused run. `MOTION_RECORD_PREVIEW=1` records a real browser WebM; outputs use `BROADCAST_TEST_OUTPUT` or `test-results/`.

The bracket regression plays through all 14 matches and six rounds using real commands against a temporary event. It checks winner/loser destinations, elimination and podium labels, round holds and nonlinear transitions, panel/text overlap, updates during animation, live-source re-entry, reviewed corrections, long names, fixed historical rounds and Reduce motion:

```sh
python3 test/bracket-focus.py
```

Set `BRACKET_RECORD=1` to record the browser sequence. Reports and screenshots use `BROADCAST_TEST_OUTPUT` or `test-results/bracket-focus/`; production tournament data is unchanged.

Focused regressions for two simultaneous operators and the motion edge cases use independent temporary events:

```sh
python3 test/control-drafts.py
python3 scripts/motion-regression.py
```

The operator test checks per-match drafts, complete forms and dropdown/checkbox focus, conflicting edits, reviewed result correction and backup restore, player renaming, source verification and preview continuity. The motion edge test repeats the current choreography checks with long player names, song titles and event headings.

An independent long-roster browser regression checks 32 players per group, eight-row pages, fixed and out-of-range page requests, row visibility and automatic rotation through every player. It accelerates only the 12-second ranking timer for the test and uses temporary tournament data:

```sh
python3 test/ranking-layout.py
```

The display regression checks actual control-panel switches against temporary legacy data, paired capture-card/handcam frames, unchanged capture-card positions, handcam masking, updates without reloading the live source or preview, saved settings across restart, URL overrides, real local bold fonts and text staying clear of captures:

```sh
python3 test/display-layout.py
```

## Project files

```text
server.js                 LAN server, pairing, public/private sockets and HTTP
lib/tournament.js         Rules, 14-match graph, scoring, lotteries, public redaction
lib/store.js              Revision checks, atomic saves, automatic backups and recovery
lib/state-validation.js   Complete saved-state structure and reference validation
lib/broadcast-check.js    Private manual OBS source assignments and check invalidation
lib/default-state.js      Event defaults and editable sample roster/song metadata
lib/branding.js           Fixed local logo/key-visual discovery for /api/branding
lib/obs-adapter.js         Optional future OBS WebSocket integration hook
data/                     Local state and pairing files (runtime data ignored by Git)
public/control/           Staff panel, responsive CSS and interactions
public/overlay/           Seven main documents + song selection + live alias
public/js/                Shared display helpers, sockets and overlay rendering
public/assets/            Local fonts, graphics, mesh and icons
test/                     Isolated rule, integration and optional browser tests
```
