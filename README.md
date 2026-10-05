# ACAHKU Phigros Broadcast

A local tournament server, transparent OBS overlays and an iPad-friendly control panel. HTML, CSS and JavaScript with Express and Socket.IO; no frontend framework, CDN, cloud login or Internet connection is needed while running the show.

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

Initial data contains **sample players and editable sample song metadata**, with no scores or seeded bracket. Verify the official song pool, chart levels and roster before using it for the event. No event poster was included, so the start screen uses the supplied event details and original local geometric artwork.

## Laptop + iPad

1. Connect both devices to the same Wi-Fi or wired LAN. A network with client isolation or a guest Wi-Fi policy can block device-to-device access.
2. Start the server on the laptop. Its terminal prints an `iPad:` address. You can also find the laptop's IPv4 address with `ipconfig` on Windows, `ipconfig getifaddr en0` on macOS Wi-Fi, or `ip -4 addr` on Linux. Use the LAN address, not a VPN or loopback address.
3. On the iPad, open Safari and enter `http://<laptop-LAN-IP>:3000/control/`. Enter the pairing code from the laptop. Use either orientation.
4. If necessary, allow Node.js / TCP port 3000 through the laptop's firewall **on the local network**. Internet port forwarding is unnecessary.
5. Check that the control panel says **Connected to laptop**. Changes save after the server acknowledges them; the footer shows the saved revision. Offline controls reject updates and automatically reconnect. Broadcast overlays keep their last saved frame during disconnection.

The preview inside the control panel counts as one connected overlay. “Overlay connected” means a browser source is receiving state; it does not prove OBS itself is connected. OBS WebSocket integration is reserved in `lib/obs-adapter.js`, and is not enabled in this version.

## OBS setup

1. Add your gameplay capture and webcam sources to an OBS scene.
2. Add a **Browser Source** above those sources. Disable **Local file**, use `http://localhost:3000/overlay/start.html`, and set **Width 1920 / Height 1080**.
3. Keep the Browser Source active. Prefer leaving **Shutdown source when not visible** and **Refresh browser when scene becomes active** unchecked; scene changes arrive over Socket.IO.
4. Use the control panel's **Broadcast** tab to select the on-air screen. The same Browser Source changes scenes immediately without a reload. It does not switch your OBS capture sources or OBS scenes automatically.
5. Align the OBS capture sources below the transparent gameplay and webcam frames. The interface does not capture video itself. Different capture arrangements may use separate OBS scenes; switch those in OBS manually or use the reserved adapter in a later integration.

All overlay documents keep their root and body backgrounds transparent. Opaque or translucent information panels are intentional; gameplay and webcam interiors contain no fill. The canvas is always 1920×1080 and fits smaller viewports with its 16:9 ratio intact.

### Overlay documents

| Screen | Path |
| --- | --- |
| Start screen / default source that follows scene controls | `/overlay/start.html` |
| Qualifier waiting | `/overlay/qualifier-waiting.html` |
| Double elimination waiting | `/overlay/double-elimination-waiting.html` |
| Three-player qualifier match | `/overlay/qualifier-match.html` |
| Two-player double elimination match, including the three-song final | `/overlay/double-elimination-match.html` |
| Result announcement | `/overlay/result.html` |
| Complete bracket progress | `/overlay/bracket.html` |
| Additional requested song-selection screen | `/overlay/song-selection.html` |

`/overlay/live.html` is an alias for the source following the control panel; it is not an extra tournament scene. The start document follows the shared scene by default. Other named documents show their named screen and still update live data. Append `?follow=1` to make any document follow scene controls, or `?fixed=1` to pin a preview (including the start screen). Thus there are seven main screens plus the separately requested selection screen.

Approximate gameplay source rectangles in the 1920×1080 canvas:

| Layout | Gameplay frames (x, y, width, height) |
| --- | --- |
| Three-player qualifier | `(72,160,573,325)`, `(673,160,573,325)`, `(1275,160,573,325)` |
| Two-player match / final | `(100,170,838,385)`, `(982,170,838,385)` |

Webcam frames sit below each player's information. Use OBS's transform and crop controls to fit your capture aspect ratio. The exact rectangles are accessible through `[data-capture]` elements in the overlay if you customise the CSS.

## Staff workflow

### Qualifiers

1. In **Event & library**, verify event name, organiser, date, time, venue and song metadata.
2. In **Qualifiers**, edit the Group A and Group B rosters (one name per line). Names unchanged within a group retain their scores. Renaming a player creates a new player record, so enter final names before scoring.
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

**Reset current match** clears candidates, bans, picks and scores only for the unfinished current match. It preserves entrants, seeding and every other result. Completed results lock; there is no one-click whole-tournament reset.

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

L3 pairs the L1 winner with the W6 loser, and L4 pairs the L2 winner with the W5 loser to reduce immediate rematches. The progress overlay shows all fourteen matches, seeds, losses, live/ready states, winner destinations and loser destinations. Two losses mark elimination.

The requested **14-match format has one decisive Grand Final and no bracket reset**. If the WB champion loses GF, they finish as runner-up with one loss. This exception is preserved rather than silently introducing a fifteenth match.

### Vacancies and lottery byes

Use empty manual seed slots to represent absences. In a match with zero or one player, **Record vacant-match bye** advances its available player without inventing a loser or a loss.

For a four-player entry field with exactly three players and one vacancy, open **Vacancy, bye & lottery**. Choose the recorded draw winner or leave the dropdown blank for a random local lottery, then **Draw four-player bye**. The selected entrant advances directly; the other two stay paired in the companion match. Both entry matches must be ready and unscored. Supported fields are W1/W2, W3/W4, and L1/L2. Eligible entrants, chosen player, destination, timestamp and notes are recorded in `drawLog`; the progress overlay marks the draw result. An unrelated player cannot receive the bye.

## Data, backups and local resources

- Shared state is stored atomically after every successful command in `data/match-state.json`. Restarting the server or refreshing a browser preserves it. Failed and stale commands do not overwrite it.
- **Export state backup** in Event & library downloads a staff-only JSON backup. Keep backups before confirming important results. To restore: stop the server, preserve the current JSON separately, place the backup at `data/match-state.json`, and restart. Keep the same PIN and session-key files to preserve paired browser sessions. Backups are private staff data; they include unrevealed selections.
- New events can use `data/match-state.example.json` after preserving the old event and stopping the server. There is deliberately no destructive reset button.
- A second operator's newer revision is detected; stale commands are rejected and current state is sent back. Reconnect or inspect the latest state before retrying an unacknowledged command.
- Add authorised song artwork to `public/assets/song/`, then edit its local `assets/song/file.webp` path in the library. HTTP/CDN artwork paths are rejected. Existing match candidate/pick metadata stays fixed after a draw; library changes affect future draws.
- Original geometric artwork is bundled. Uploaded skill screenshots were used only for visual analysis and are not shipped as page backgrounds. Saira is a **local implementation candidate**, not a claim about the original game font. Its SIL OFL licence is included. Hong Kong CJK fonts use system fallbacks (`Source Han Sans HC`, `Noto Sans HK`, `PingFang HK`, `Microsoft JhengHei`).
- CSS and scripts are separate local files. `public/assets/ui/phi-ui.css` and the mesh/icons come from the supplied `phigros-web-ui` skill. The implementation keeps horizontal text, 15° surfaces, height-based cuts, masked cover changes and reduced-motion support.

## Validation and development

```sh
npm ci
npm test
npm run dev
```

`npm test` uses temporary data and covers group rankings, ties, selection rules, complete bracket progression, podium placements, byes/lotteries, private finals picks, atomic persistence, authenticated HTTP/Socket.IO, disconnection recovery and server restart. It does not modify the production tournament.

Optional browser smoke test, if Python Playwright, Pillow and Chromium are installed:

```sh
python3 test/browser-smoke.py
```

It exercises real controls against temporary data, checks 8 overlay scenes, 1920×1080 / 720p / 540p scaling, iPad landscape/portrait and phone widths, alpha in every capture frame, offline reconnection, no navigation during state updates, local-only requests, keyboard selection and reduced-motion. Screenshots go to ignored `test-results/`. Browser emulation is not a physical iPad or OBS/CEF hardware test; rehearse those devices and actual capture sources before the event.

## Project files

```text
server.js                 LAN server, pairing, public/private sockets and HTTP
lib/tournament.js         Rules, 14-match graph, scoring, lotteries, public redaction
lib/store.js              Revision checks and atomic JSON persistence
lib/default-state.js      Event defaults and editable sample roster/song metadata
lib/obs-adapter.js         Optional future OBS WebSocket integration hook
data/                     Local state and pairing files (runtime data ignored by Git)
public/control/           Staff panel, responsive CSS and interactions
public/overlay/           Seven main documents + song selection + live alias
public/js/                Shared display helpers, sockets and overlay rendering
public/assets/            Local fonts, graphics, mesh and icons
test/                     Isolated rule, integration and optional browser tests
```
