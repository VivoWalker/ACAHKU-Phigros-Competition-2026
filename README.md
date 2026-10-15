# ACAHKU Phigros Broadcast

A local tournament server, transparent OBS overlays and iPad-friendly main-control and scorekeeper panels with separate pairing codes. The broadcast uses a quieter presentation with larger, bold titles, player names and totals, plus one shared current-song line. Each player's capture card and handcam can appear together; staff can switch between single and dual views live. Main control keeps all scoring, tournament and broadcast controls; scorekeepers receive a separate score-entry panel. HTML, CSS and JavaScript with Express and Socket.IO; no frontend framework, CDN, cloud login or Internet connection is needed while running the show.

## Quick start

Install Node.js **20 or newer** (verified with Node 24). From this project folder:

```sh
npm install
npm start
```

The downloadable **offline bundle** already includes the verified JavaScript dependencies and local fonts. With Node.js installed, unzip it and run `npm start` directly; `npm install` is only needed to install or refresh dependencies in the source-only package.

Keep that terminal open. It prints the laptop's LAN addresses and **two different six-digit pairing codes**, one for main control and one for scorekeepers. Open the appropriate panel and enter its code:

```text
Main control:        http://localhost:3000/control/
Scorekeeper panel:   http://localhost:3000/scorekeeper/
iPad main control:   http://192.168.x.x:3000/control/
iPad scorekeeper:    http://192.168.x.x:3000/scorekeeper/
OBS Browser Source:  http://localhost:3000/overlay/start.html
```

The codes are created locally in `data/.control-pin` and `data/.scorekeeper-pin`. The laptop and iPad do not need external accounts. The two panels retain separate paired sessions in the browser tab, including server restarts with the same data directory. You can optionally set `CONTROL_PIN` and `SCOREKEEPER_PIN` before starting the server; explicitly configured codes must differ. Existing main-control codes and paired sessions continue to work after upgrading. `PORT` defaults to `3000`; `HOST` defaults to `0.0.0.0` so the iPad can connect.

Pairing codes and the session key are written through private atomic files. An empty saved main-control code, a blank explicitly configured code, or a damaged session key stops startup. Restore the affected credential from a private backup; a main-control code can also be supplied through a nonempty `CONTROL_PIN`. If the original session key cannot be recovered, stop the server, preserve the damaged file elsewhere, and remove it from `data/` before restarting. The server then creates a fresh key and each staff panel must pair again.

New events contain **sample players and the official 50-chart song list**, with no scores or seeded bracket. Qualifiers use **Challenge Mode total scoring**: record the total shown by Phigros after the three-song set. The six qualifier charts, 42 Double Elimination charts and two fixed Grand Final charts already have their local jackets, names, artists and specified difficulties. Levels discard the decimal part: 14.7 becomes 14 and 16.9 becomes 16. Verify the roster and choose the qualifier plan before recording totals. The supplied Phigros logo, society logos and event key visual are bundled as local files; see the replacement instructions below.

An existing unscored installation can load the same settings through **Event & library → 正式比赛歌单 → 套用正式歌单与决赛规则**. Review the displayed list and confirm replacing its library and qualifier song sets. The server rejects this operation once scoring, seeding or tournament history exists; preserve a running event and prepare a fresh event for the new settings. Existing saved events continue to load with their original rules.

When upgrading an existing installation, preserve the whole `data/` folder, replace the application files, restart the server, and refresh every control-panel tab and the OBS Browser Source once. Older control scripts without explicit match IDs are rejected by the updated server; existing valid schema-1 event files and paired sessions remain supported.

## Laptop + iPad

1. Connect both devices to the same Wi-Fi or wired LAN. A network with client isolation or a guest Wi-Fi policy can block device-to-device access.
2. Start the server on the laptop. Its terminal prints an `iPad:` address. You can also find the laptop's IPv4 address with `ipconfig` on Windows, `ipconfig getifaddr en0` on macOS Wi-Fi, or `ip -4 addr` on Linux. Use the LAN address, not a VPN or loopback address.
3. On the iPad, open Safari and enter `http://<laptop-LAN-IP>:3000/control/`. Enter the pairing code from the laptop. Use either orientation.
4. If necessary, allow Node.js / TCP port 3000 through the laptop's firewall **on the local network**. Internet port forwarding is unnecessary.
5. Check that the control panel says **Connected to laptop**. Changes save after the server acknowledges them; the footer shows the saved revision. Offline controls reject updates and automatically reconnect. Broadcast overlays keep their last saved frame during disconnection.

The preview inside the control panel counts as one connected overlay. “Overlay connected” means a browser source is receiving state; it does not prove OBS itself is connected. OBS WebSocket integration is reserved in `lib/obs-adapter.js`, and is not enabled in this version.

## Main control and scorekeepers

The main panel at `/control/` keeps the existing layout and all tournament and broadcast controls. Give its code to the main operator. The scorekeeper panel at `/scorekeeper/` uses its own code and only offers score entry. Both panels update the same saved tournament, and scores synchronize with every connected panel and overlay after the server acknowledges them. Main control shows separate connected-device counts for the two roles.

The scorekeeper sheet follows the main operator's current stage, qualifier round/group or selected elimination match. Challenge qualifiers have **one total field per player**, accepting the game's displayed three-song total from **0 to 3,000,000**. Select Plan A or Plan B in main control first. Enter the total exactly as shown by Phigros, then press the player's save button; leave it blank for an unrecorded result. Elimination matches and single-song tiebreaks retain their **0 to 1,000,000** score entries. Only edited fields are submitted. Qualification and seeding lock the relevant qualifier totals, and result confirmation locks completed matches. Older events retain their individual-song entries and sealed MC-score restrictions.

Live updates preserve unsaved drafts and input focus. If another operator changes the same score, review the server value and choose which value to keep before saving. When main control changes the group, match, roster or songs, old drafts remain marked with their original context and cannot be submitted to the new sheet. Disconnected scorekeepers retain drafts and must reconnect before saving; queued actions from an old connection are not replayed automatically. Save a player's edits before moving to the next group or match.

Scorekeeper permissions are enforced by the server: its session can only submit qualifier or match scores for the current sheet. It cannot change players or songs, resolve ties, confirm results, advance the bracket, switch scenes, start a countdown, manage sources, export private data, restore backups or open the main-control session. Main control keeps responsibility for those operations.

## OBS setup

1. Add each player's capture-card source to an OBS scene. Add their handcam source as well if you want to use dual view, and position both using the rectangles below.
2. Add a **Browser Source** above those sources. Disable **Local file**, use `http://localhost:3000/overlay/start.html`, and set **Width 1920 / Height 1080**.
3. Keep the Browser Source active. Prefer leaving **Shutdown source when not visible** and **Refresh browser when scene becomes active** unchecked; scene changes arrive over Socket.IO.
4. Use the control panel's **Broadcast** tab to select the on-air screen. The same Browser Source changes scenes without a reload. Shared logos, artwork and player names move to their new positions; other content exits before the new content slides in. It does not switch your OBS capture sources or OBS scenes automatically.
5. In **Broadcast → 畫面顯示**, select **單畫面** for capture card only or **雙畫面** for capture card plus each player's handcam. This setting updates all connected overlays immediately and is saved across restarts. Capture-card positions stay fixed; single view covers the handcam areas with the overlay background. Keep both sources beneath the Browser Source. The interface does not capture video or move OBS sources. Different player counts may use separate OBS scenes with the matching source arrangement.
6. In the Broadcast source-check panel, enter the actual OBS capture-card and handcam source names for each slot, save them, inspect the real feeds, and confirm the manual check. Changing entrants, their names, the match, sources, stage or single/dual mode invalidates that confirmation. A restored backup also requires a new check. This records a crew member's visual check; it does not connect to OBS, inspect video, or switch sources automatically.
7. Once the players are ready, select the qualifier or double-elimination **match screen**, then press **Broadcast → 比賽開始倒計時 → 開始倒計時 · 3 2 1 START**. Each number lasts one second; START displays for 700 ms, followed by a 250 ms fade. The opaque countdown covers the whole Browser Source, including logos and capture windows, and then restores the match. **取消倒計時** removes it immediately. Both single and dual views support it. The fixed two-song Grand Final uses the same cue directly; an older event's third MC song must be revealed before its cue can start.

The countdown uses one server timestamp for all connected sources and the control-panel preview. Refreshing or reconnecting during a countdown resumes the current number; an expired countdown or server restart does not replay it. Changing the scene, match, selected players, current song, single/dual mode or saved source assignments cancels it. Score updates keep its original timing. Countdown commands require a paired staff session and do not change scores, save a revision or create a backup. This is a visual start cue without audio.

All overlay documents keep their root and body backgrounds transparent. Opaque or translucent information panels are intentional; gameplay and webcam interiors contain no fill. The canvas is always 1920×1080 and fits smaller viewports with its 16:9 ratio intact.

The filtered background stays mounted between scenes; its HTML mask covers and reveals the calibrated video apertures. Exit snapshots copy only the appearance/layout styles they use, keeping scene switches lightweight. On a scene change, the old content first slides **left and fades out**, starting with the leftmost element. Capture-card and handcam windows gradually close **from right to left with a fade** as their borders exit. Exits use the same nonlinear easing, 560 ms duration and 65 ms stagger as entrances. Outgoing snapshots are clipped to their original slots and removed automatically; score and state revisions continue to commit immediately. Logos then move on the top layer for **760 ms**, using nonlinear easing. During that travel, the new scene's content and video apertures wait so branding never crosses visible content. New elements and video windows then enter **from right to left with a fade**, beginning with the leftmost element (top to bottom for equal horizontal positions); each entrance lasts 560 ms and starts 65 ms after the preceding one. Incoming elements stay inside their final slots, and logos are never clipped behind text or video. The aperture mask becomes fully transparent when each window settles. Switching single/dual view animates the changed handcam windows while the existing capture-card windows stay open at their calibrated positions. OBS video sources stay beneath the Browser Source; these transitions require no extra OBS plugin or source movement. Score and state revisions apply immediately; in-flight animations retain their original timing when those revisions arrive. Song artwork keeps its 550 ms nonlinear slide inside its fixed slanted window, with at most two images. Rapid requests retain the latest scene, and Reduce motion makes every transition immediate.

### Overlay documents

Decoded Phigros and club logos stay attached to one persistent top branding plane. Scene content uses invisible layout slots to position them, so switching to the bracket or updating its results never removes/reinserts the displayed logo images or rewrites an unchanged image URL. Their 760 ms travel, original layout positions and full-screen countdown coverage remain intact.

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
| Fixed Grand Final song announcement | `/overlay/grand-final-announcement.html` |

`/overlay/live.html` is an alias for the source following the control panel; it is not an extra tournament scene. The start document follows the shared scene by default. Other named documents show their named screen and still update live data. Append `?follow=1` to make any document follow scene controls, or `?fixed=1` to pin a preview (including the start screen). There are seven main screens, the selection screen and the Grand Final announcement screen.

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

### Proposal rules and qualifiers

The [English competition rules](docs/competition-rules.md) are available locally at **`/rules/`**; [the rule audit](docs/proposal-rule-audit.md) maps every competition clause to the proposal and records its inconsistencies. The Phigros body is authoritative; the obsolete Project Sekai registration screenshots are excluded.

1. Verify event information and the actual song library in **Event & library**. The bundled roster is an example; the official six qualifier charts, 42 regular DE charts and two final charts are prefilled. Add further authorised songs if needed for the full local catalogue used by qualifier tiebreak draws.
2. In **Qualifiers → 比赛方案与抽签编号**, save the complete roster, apply **Auto** (≤20: Plan A; >20: Plan B), and draw unique participant numbers. Changing an already configured roster before play recalculates the plan at the 20-player boundary. Numbers determine batches of at most three and identify entrants throughout the event. Setup is locked after scoring or adjudicated incidents begin.
3. Plan A puts everyone in Round 1. Confirm its top four after all eligible results and ties are resolved; the remaining entrants enter the revival round with independent blank scores. Confirm its top four to create the bracket. First-round qualifiers default to seeds 1–4, revival qualifiers to 5–8; a reviewed ACA manual seed override requires a reason.
4. Plan B uses odd numbers in Group 1 (A) and even numbers in Group 2 (B), with separate three-song sets and top four qualifiers in each. Seeds alternate A1/B1/A2/B2/A3/B3/A4/B4 for later reseeding. The opening matches use **A1–B4, A2–B3, B1–A3 and B2–A4**, as specified by the organiser. Do not combine totals from different song sets. Existing saved brackets retain their recorded opening sources.
5. Select three different songs per round/group, with no overlap between sets. Choose on-stage players or **Next ordered batch**, choose the current song, and show waiting/match. The next ordinary batch starts at song one; a tiebreak batch keeps its separate extra-song context. Empty slots stay empty.
6. After the three-song **Challenge Mode** set, copy the game's displayed **total score** into the player's single total field. It is an integer from **0 to 3,000,000**; zero is valid and blank means unrecorded. Do not enter an average Accuracy or three separate song scores. Both main control and scorekeepers use the same total field.
7. Rank each round/group by that **directly recorded total**, highest first. Equal totals that affect qualification or seed order require the existing random-song tiebreak flow and arbiter confirmation. Challenge tiebreaks compare their single-song displayed scores; another equal score requires another recorded round. Tiebreak scores do not change the original Challenge total. Double Elimination and Grand Final score/ACC rules are separate.
8. The main operator confirms arbiter review before qualification. Proposal events cannot bypass ties using a manual priority or winner selector. Use **裁判工具** for readiness, ten-minute waits, evidence-based single-song rematches and permanent DQ.

After a qualifier tiebreak starts, scorekeepers can enter the active extra-song results but cannot edit the base Challenge total. To correct that total, the main operator saves the edited field, enters an 8–500 character correction reason and confirms invalidating all tiebreaks in that round. The previous total and full tiebreak records are archived privately, and qualification must be checked again. Cancelling or a concurrent update retains the draft and requires a new review. Saving an unchanged total keeps its tiebreaks. An authorised replay clears the recorded Challenge total so the revised game settlement can be recorded; it does not fabricate individual-song results.

Saved qualifiers without the Challenge scoring marker retain their former individual-song score and ACC ranking rules. Before any scoring or competition history, main control can explicitly choose **Qualifier scoring → Challenge Mode total** or apply the official event preset. An event with recorded scores, previous scoring history or qualified/seeded fields cannot switch modes; clearing a displayed result does not erase that history. Restarting or restoring a backup preserves its own scoring mode.

Existing unconfigured schema-1 events retain their legacy two-group scores, manual tie priorities, fixed routes and historical eight-candidate final data. Explicitly apply the proposal plan **before scoring a new event**. Do not replace an existing live `data/` folder during an upgrade. Use Rename player for spelling changes so IDs, round scores and references remain intact.

In legacy roster setup, removing an unscored player also removes that player's readiness checklist while preserving the decision log. A running wait must be cancelled before the player can be removed. Previously saved events keep their existing format during an upgrade; correcting a previously misconfigured plan requires unscored setup or a reviewed return to a pre-play backup.

### Regular double elimination, R1–R5

1. Select a ready match in **Bracket**. Pending matches cannot start until both incoming paths resolve.
2. In **Song selection**, draw six distinct candidates from songs marked eligible for regular draws and not formally selected by another DE match. Candidates, bans and songs not selected for play may reappear in another match.
3. In proposal mode, P1 and P2 each record a ban or explicit **Pass**. A ban can be changed before the final draw. Legacy events retain their required two-ban flow.
4. **Draw 2 match songs** randomly chooses two of the remaining candidates after both decisions. These songs automatically populate the match overlay and scoring fields. Picks lock further bans.
5. Enter both players' two scores and select Song 1 / 2 or Song 2 / 2. The winner is determined by the two-song total.
6. In **Record result**, confirm the result. In proposal mode, equal totals compare mean ACC, then repeated DE-pool tiebreaks if necessary. The arbiter confirms every tiebreak and the final result. Only legacy events retain the referee-winner selector. All base scores are required; partial totals cannot win.
7. The result opens incoming winner/loser paths. The live scene changes to result announcement. Select the next ready match to continue.

**Reset current match** clears candidates, bans, picks and scores only for the unfinished current match. Its durable song-use history stays reserved: resetting, redrawing, restoring a backup or reopening a result does not release previously selected base/tiebreak songs for another match. It preserves entrants, seeding, every other result and durable rematch allowances. Score entries and other match commands carry the displayed match ID; a command for a different selected match is rejected. Switching matches keeps their drafts separate. Unsaved form fields, dropdowns and checkboxes survive live updates and tab changes. If another operator edits the same field, the panel retains the draft and requires an explicit conflict review.

Completed results lock against ordinary editing. To correct one, preview its downstream impact in the result-correction panel, enter a reason, and explicitly confirm any affected selections, scores and results that must be cleared. Reopening retains the chosen match's base songs and scores, invalidates its old tiebreak decision, and includes whole reseeded fields in the downstream review. It selects it as the active match, and clears its dependent matches before the result is confirmed again. An unrelated newer update invalidates the reviewed preview and requires another review. The automatic backup and private correction log retain the previous data. A result belonging to a vacancy lottery with reassigned entrants must instead be corrected by restoring a backup from before that lottery. There is no one-click whole-tournament reset.

### Prepare a DE song list with no cross-match repeats

The organiser confirmed that the restriction applies to **actual base-match and tiebreak songs**, not the six candidate slots. A candidate, banned song or unselected song may appear again; after a song is formally picked for one match, another DE match cannot draw or pick it. GF uses the same cross-match exclusion. Qualifiers keep their existing independent draw rules. Within the same match, the existing redraw and repeated-tiebreak behaviour remains available.

There are **13 regular matches × 2 played songs = 26 distinct played songs**. A 26-song list is insufficient: after the first twelve matches use 24 songs, the final regular match still needs six available candidates. Therefore prepare **at least 30 distinct songs** for the ordinary DE pool: `12 × 2 + 6 = 30`. This minimum assumes no extra consumption through tiebreaks or replaced selections. The supplied **42-song DE list** provides 12 extra choices; repeated ties and reviewed redraws have no fixed limit, so no finite list guarantees every possible event. **Desultory Signals and Petrichor are reserved separately for the fixed Grand Final**, with their regular-draw flag off. These counts exclude the qualifier list.

The control panel shows the deduplicated eligible total, songs formally reserved by DE matches and the globally unused remainder. It also reports the minimum remaining requirement: `2 × unselected regular matches + 4` (zero once all regular matches have selections). A shortage warning asks staff to add songs; a draw with fewer than six available candidates is disabled/rejected, and an exhausted tiebreak pool never silently reuses another match's song.

With at most one fresh tiebreak song per regular match and no replaced selections, the 42-song recommendation covers `12 × (2 + 1) + 6`: the last match has six candidates and can use an unselected candidate for its extra song. More repeated ties or replaced selections can require a larger list.

Identity is song-level: the same ID, or the same normalised title and artist, is treated as one song even when chart difficulty differs. Renaming or deleting a library entry does not erase a recorded selection. Upgrade existing events without replacing `data/`: previous repeated songs remain in historical results, while future draws exclude songs used by other matches. Backups and private correction records preserve prior selections.

### Grand Finals, R6

1. Select **GF** after both bracket champions are known.
2. The official configuration automatically fills **Desultory Signals — IN 17** as Song 1 and **Petrichor — AT 17** as Song 2. Both artworks and titles are already public. There is no ban, candidate draw, audience pick or MC reveal step.
3. Press **宣布决赛曲目** in Song selection, or choose **總決賽曲目公佈** in Broadcast. The separate screen presents both full jackets, titles and difficulties; it follows the same scene transitions and persistent branding as the other screens. Its fixed URL is `/overlay/grand-final-announcement.html`.
4. Switch to the match screen, select Song 1 / 2 or Song 2 / 2 and use the existing 3–2–1 start cue when the players are ready. Both main control and scorekeepers have two base score entries per finalist.
5. Record both scores and original screen ACC for each player, then confirm the result. Two-song totals compare first, followed by mean ACC and the existing recorded tiebreak flow. Results identify **Champion** and **First Runner-up**. A reset or reviewed correction keeps the two fixed base songs.

Saved events without the official configuration retain their previous three-song final: six candidates in proposal mode or eight in legacy mode, two audience picks and a private third MC pick. They keep their reveal and scoring restrictions during restart, export and restore. Apply the new preset before play or start a fresh event to use the fixed two-song final.

### Fourteen-match bracket

| Round | Matches | Incoming / outgoing paths |
| --- | --- | --- |
| R1 | W1, W2, W3, W4 | Plan A: seeds 1–8, 4–5, 2–7, 3–6; Plan B: A1–B4, B2–A4, B1–A3, A2–B3. Winners to W5/W6, losers to L1/L2 |
| R2 | W5, W6; L1, L2 | WB winners to W7; WB losers to L3/L4; LB winners stay in LB |
| R3 | W7; L3, L4 | W7 winner to GF, loser to L6; L3/L4 winners to L5 |
| R4 | L5 | Winner to L6 |
| R5 | L6 | Winner to GF; loser is **Third place** |
| R6 | GF | Champion vs. First Runner-up |

Proposal mode waits for the full field and reseeds R2 WB, R2 LB and R3 LB highest against lowest by the original qualifier seeds. The actual source edges are updated, so public destinations and corrections follow the real opponents. Before a field is complete, the overlay identifies the destination bracket and round with pairing pending. Legacy fixed brackets retain L1 winner/W6 loser in L3 and L2 winner/W5 loser in L4. The progress overlay gives the current round a large, readable panel, with its actual destination matches alongside it and a six-round progress rail above. Winners and advancing players use green, losers transferring to the losers' bracket use amber, and eliminated players use red. Each completed player's route names the destination group, round and match; paired highlights connect the source row to its destination row. Final results also identify the champion, runner-up and third-place finisher. Detailed seeds, losses, advancement paths and adjudication notes remain available in the control panel. Two losses mark elimination.

The focus advances only when **every match in the current round** has finished, including both WB and LB matches in R2/R3. Completed-round results remain visible for **3.4 seconds** after their reveal begins. The old round then slides left, shrinks and fades out over **700 ms**; the next round slides in and expands over **950 ms**, using nonlinear easing. Live state revisions retain the original animation timing. Append `?round=1` through `?round=6` to `/overlay/bracket.html` to keep a particular round visible for historical results; that view still receives live data updates.

In the automatic view, a reviewed result correction cancels the current reveal or round transition, removes outgoing panels and returns focus to the earliest unfinished round, with corrected advancement paths. A fixed historical view stays on its requested round. With Reduce motion enabled, round changes and corrected results apply immediately, without the result hold or animation.

The requested **14-match format has one decisive Grand Final and no bracket reset**. If the WB champion loses GF, they finish as runner-up with one loss. This exception is preserved rather than silently introducing a fifteenth match.

### Vacancies and lottery byes

Use empty manual seed slots to represent absences. In a match with zero or one player, **Record vacant-match bye** advances its available player without inventing a loser or a loss.

For a four-player entry field with exactly three players and one vacancy, open **Vacancy, bye & lottery**. Choose the recorded draw winner or leave the dropdown blank for a random local lottery, then **Draw four-player bye**. The selected entrant advances directly; the other two stay paired in the companion match. Both entry matches must be ready and unscored. Proposal mode can clear already selected but unscored songs only after explicit review; legacy draws must precede song selection. Supported fields are W1/W2, W3/W4, W5/W6, L1/L2 and L3/L4. A single vacancy in a four-player proposal field requires this lottery before a bye. Eligible entrants, chosen player, destination, timestamp and notes are recorded in `drawLog`; the progress overlay marks the draw result. An unrelated player cannot receive the bye.

### Readiness, waiting, DQ and score evidence

The main-only **裁判工具** records device/global-version/headphones/chart/stream-consent checks. Start an absence or chart-unlock wait; its saved deadline is exactly ten minutes. Cancellation records resolution. An expired timer only enables staff review; it never sends an automatic penalty. A DQ permanently removes the entrant from future batches, seeds and WB/LB entries; a normal two-person field forfeits to the opponent, while a three-person four-player field requires its lottery.

For a lost score screen, inspect the livestream recording first. A rematch requires an unintentional departure, all players' agreement and the recorded video check; otherwise record the appropriate ACA decision. Game-error rematches use the other incident reason. One allowance is shared across reasons per qualifier player/round/song, or per DE match/song for both opponents. Only that song's scores/metadata clear; invalidated tiebreak evidence is archived privately. Current unconfirmed tiebreaks have a separate single replay allowance; their replay clears only that extra song, preserving the original totals and earlier confirmed tiebreaks. Resets do not renew an allowance. Readiness, waiting, incident and detailed DQ notes remain staff-only.

## Data, backups and local resources

- Shared state is stored atomically after every successful command in `data/match-state.json`. Restarting the server or refreshing a browser preserves it. Failed and stale commands do not overwrite it.
- Every successful update first creates a private automatic snapshot in `data/backups/`; the latest **500** snapshots are retained. A failed snapshot or official save does not advance the in-memory state. **Event & library** lets paired staff preview an automatic backup and restore it with a reason. Restore saves the current version first, uses a new revision, and updates all controls and overlays. A concurrent update invalidates the restore confirmation. Recent actions and recovery reasons remain in the private audit log.
- Live backup listings are scanned and validated in a worker, with summaries cached by file fingerprint so a large catalogue does not block score requests. Modified, damaged or deleted files are rechecked; a selected restore still undergoes full validation. Lists, previews and restore confirmation distinguish base scores, tiebreak scores and confirmed tiebreak counts for both qualifiers and matches.
- **Export state backup** downloads a staff-only JSON backup for storage elsewhere. To restore an exported file manually: stop the server, preserve the entire current `data/` folder, place the complete backup at `data/match-state.json`, and restart. Keep the PIN and session-key files to preserve paired browser sessions. Backups include unrevealed selections and must remain private.
- Startup fully validates the saved tournament before publishing it. If it is damaged and a valid automatic backup exists, the server preserves the damaged bytes in `data/match-state-damaged-*.json`, restores the latest valid snapshot, and shows a recovery notice to staff. Check the restored scores and actual OBS feeds before proceeding. With no valid backup, startup fails clearly and preserves the original file.
- New events can use `data/match-state.example.json` after preserving the old event and stopping the server. There is deliberately no destructive reset button.
- A second operator's newer revision is detected; stale commands are rejected and current state is sent back. Reconnect or inspect the latest state before retrying an unacknowledged command.
- Add authorised song artwork to `public/assets/song/`, then edit its local `assets/song/file.webp` path in the library. HTTP/CDN artwork paths are rejected. Existing match candidate/pick metadata stays fixed after a draw; library changes affect future draws. A qualifier group's song title, artist, difficulty and level lock once that group starts scoring; create a new library entry for a different chart.
- Song-art placeholders are bundled. Actual event branding is loaded only from the local logos and key-visual files described above. Uploaded skill screenshots were used only for visual analysis and are not shipped as page backgrounds. Saira is a **local implementation candidate**, not a claim about the original game font. Its SIL OFL licence is included. Hong Kong CJK fonts use system fallbacks (`Source Han Sans HC`, `Noto Sans HK`, `PingFang HK`, `Microsoft JhengHei`).
- CSS and scripts are separate local files. `public/assets/ui/phi-ui.css` and the mesh/icons come from the supplied `phigros-web-ui` skill. The broadcast reduces repeated headings, explanatory copy and large score cards while keeping horizontal text, restrained angled surfaces, masked cover changes and reduced-motion support.

### Adding song artwork and preview clips

The organiser's song list has **47 unique jackets** bundled in [`public/assets/song/song-list-2026/`](public/assets/song/song-list-2026/README.md), matching all 49 input lines. These are original 2048×1080 PNGs from Rhythm Archive, verified against the source catalog's SHA-256. Use [`song-map.csv`](public/assets/song/song-list-2026/song-map.csv) to find each song's local artwork path; duplicate input lines share one file. The folder's manifest preserves source URLs and credits.

The control panel's **Event & library → Song library** form accepts a **Local artwork path** and an optional **Music preview path**. Copy artwork into `public/assets/song/` and trimmed **10–15 second** clips into `public/assets/song-preview/`, then fill in their paths relative to `public/`:

```text
Artwork: assets/song/song-01.webp
Preview: assets/song-preview/song-01.mp3
```

Preview paths support MP3, OGG, WAV and M4A with ASCII filenames. Regular double-elimination song selection stays silent while drawing six candidates. Each new ban fades out the previous preview, then fades in and loops that banned song. Drawing the two match songs plays them once in order, switching the jacket and title with the music; audio stops after the second song. A normal state refresh does not restart playback. Redraw, scene exit, tiebreaks and match completion stop it. Grand Final playback is unchanged.

The control panel's embedded program preview is silent. Use one OBS Browser Source for program audio, enable **Control audio via OBS** to mix it, and add `audio=0` to any additional overlay source URLs to avoid duplicate audio. Browsers that block autoplay show an **Enable song previews** button; use OBS **Interact** if needed. The organiser's audio is now bundled as **48 real MP3 previews, covering all 50 charts**, each 10–12 seconds before encoder padding. IN/AT charts of the same song share a file. The two Grand Final assets are prepared without enabling playback on that page. See [preview preparation and playback details](public/assets/song-preview/README.md) and [the cut timestamp table](public/assets/song-preview/preview-map.csv).

Save manually entered media paths **before drawing candidates or selecting match songs**. Existing candidates and match picks retain their saved metadata; editing the library affects future draws. The bundled preview manifest also supplies audio for saved selections whose snapshots have no `previewAudio` field. An explicitly empty field disables that song's preview. Old event files remain compatible, and older clients that omit the field preserve an existing value. After upgrading the server files or importing a manifest, restart the local server and refresh the control panel and OBS Browser Source, preserving the existing `data/` directory.

Song-art switches in both the staff selection panel and the broadcast selection screen take **550 ms**, with nonlinear easing, decoded-image loading and at most two clipped artwork layers.

## Validation and development

The official event configuration has dedicated rules and browser regressions. The unit suite checks the 50-chart catalog, truncation, Plan A/B opening opponents, fixed final scoring, corrections, rematches, persistence and older sealed MC finals. The optional browser check exercises the reviewed preset button, local images, all thirteen ordinary matches, two-song GF score entry, its announcement at desktop/iPad sizes, overlap checks, ordered animations and persistent logos against temporary event data:

```sh
python3 test/fixed-final-browser.py
```

Challenge qualifier regressions also cover direct totals, zero versus unrecorded results, the 3,000,000 boundary, tied totals and single-song tiebreaks, corrections, scorekeeper conflicts, Plan A revival and Plan B groups, scoring-mode locks and preserved historical formats:

```sh
python3 test/challenge-qualifier-browser.py
```

Song preview checks use generated temporary tones to exercise actual Chromium decoding, ban loops and fades, ordered picks, jacket synchronization, silent staff previews, scene cancellation and completed-preview reloads. The preparation checks verify ZIP safety, title matching and real MP3 encoding:

```sh
python3 test/selection-audio-browser.py
python3 test/song-preview-preparation.py
python3 test/bundled-song-previews.py
```

```sh
npm ci
npm test
npm run dev
```

`npm test` uses temporary data and covers group rankings, ties, selection rules, complete bracket progression, podium placements, byes/lotteries, private finals picks, atomic persistence, authenticated HTTP/Socket.IO, disconnection recovery, server restart, local branding lookup, and saved display modes with backwards compatibility for older tournaments. It does not modify the production tournament.

The repair regressions also cover commands aimed at an old match, stable player renaming, locked qualifier chart metadata, reviewed downstream result corrections, snapshot retention, disk failures, damaged-state recovery, authenticated restores and private source-check invalidation.

The scorekeeper server regressions verify independent pairing codes, unchanged existing main-control tokens, role-specific login limits, HTTP and Socket.IO permission isolation, rejected commands without state or backup writes, current-sheet checks, score synchronization, sealed finals picks and persisted codes across restart. Its optional browser regression requires Python Playwright, Pillow and Chromium:

```sh
python3 test/scorekeeper-layout.py
```

It uses two independent scorekeeper sessions and a main controller to check draft/focus preservation, explicit saves, conflicting edits, context changes and new edits during multi-field saves, offline reconnection without replay, the full bracket through Grand Finals, password changes and restart. It also checks score controls and save messages for overlap at 390px, 768px and 1194px widths, and verifies transparent capture-card/handcam windows. Screenshots and the JSON report use `BROADCAST_TEST_OUTPUT` or ignored `test-results/`.

The countdown server regressions use real paired/public Socket.IO clients to check shared timestamps, authorization, duplicate and stale commands, automatic cancellation, refresh/restart behavior, unchanged saved state, and sealed Grand Finals picks. Its optional browser regression requires Python Playwright, Pillow, Chromium and ffmpeg. It checks the real start/cancel controls, number timing and legibility, full-screen coverage, restored transparent captures, synchronized sources, refresh during a cue, reduced motion and responsive controls:

```sh
python3 test/countdown-layout.py
```

Optional browser smoke test, if Python Playwright, Pillow and Chromium are installed:

```sh
python3 test/browser-smoke.py
```

It exercises real controls against temporary data, checks 8 overlay scenes, 1920×1080 / 720p / 540p scaling, iPad landscape/portrait and phone widths, alpha in every capture frame, offline reconnection, no navigation during state updates, local-only requests, keyboard selection and reduced-motion. Screenshots go to ignored `test-results/`. Browser emulation is not a physical iPad or OBS/CEF hardware test; rehearse those devices and actual capture sources before the event.

The song-pool browser regression uses dummy pairing codes and private temporary event data to play all thirteen regular matches from a thirty-song list, check twenty-six distinct selections, exclude used songs from GF controls, preserve reservations after reset and handle stale candidates safely. It also checks pool metrics for overlap and horizontal overflow at 320, 390, 768 and 1280px widths. It requires Python Playwright and Chromium:

```sh
python3 test/song-pool-master.py
```

The motion regression checks all 56 directed page changes frame by frame: logo duration/layering, left-to-right exit/entrance order, right-to-left fade/slide, outgoing snapshot cleanup, element overlap, stage bounds, rapid updates, reduced motion and transparent captures. Cover loading, replacement and keyboard interaction use a separate suite. Both operate on temporary event data:

```sh
python3 test/motion-layout.py
python3 test/background-continuity.py
```

Set `MOTION_TEST_SCOPE=scenes` or `MOTION_TEST_SCOPE=covers` for a focused run. `MOTION_RECORD_PREVIEW=1` records a real browser WebM; outputs use `BROADCAST_TEST_OUTPUT` or `test-results/`.

The aperture regression measures actual compositor PNG alpha by pausing and seeking the browser's native animation effects. Separate real-time traces check score updates and interrupted transitions. It checks right-to-left reveal/cover and left-to-right ordering for every capture-card/handcam window, single/dual switching, rapid scene changes, reduced motion, unchanged background identity/pixels and full-screen countdown coverage:

```sh
python3 test/aperture-motion.py
```

Set `APERTURE_RECORD_PREVIEW=1` to record the browser with a labelled mock OBS source beneath the overlay. Reports, screenshots and the optional MP4 use `BROADCAST_TEST_OUTPUT` or ignored `test-results/`. The mock source is only a test preview; the delivered overlay keeps the real OBS source rectangles transparent.

Proposal regressions cover two-stage qualification, odd/even numbering, independent scores and repeat tiebreaks, reseeding, six-candidate finals, DQ/rematch evidence and scorekeeper permissions. `npm test` includes their domain, persistence and corruption checks. These additional real-browser checks use private fixtures and do not touch live event data:

```sh
python3 test/proposal-master.py
python3 test/proposal-master-extra.py
python3 test/proposal-overlay.py
```

The logo regression checks painted asset pixels and continuous attachment of the branding plane and logo images through bracket switches, revisions and interrupted travel:

```sh
python3 test/logo-continuity.py
```

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
lib/scorekeeper.js        Minimal scoring sheet and score-only command permissions
lib/default-state.js      Event defaults and editable sample roster/song metadata
lib/branding.js           Fixed local logo/key-visual discovery for /api/branding
lib/obs-adapter.js         Optional future OBS WebSocket integration hook
data/                     Local state and pairing files (runtime data ignored by Git)
public/control/           Staff panel, responsive CSS and interactions
public/scorekeeper/       Separate score-only panel and paired browser session
public/overlay/           Seven main documents + song selection + live alias
public/js/                Shared display helpers, sockets and overlay rendering
public/assets/            Local fonts, graphics, mesh and icons
test/                     Isolated rule, integration and optional browser tests
```
