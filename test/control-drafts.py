"""Two-operator control-room draft and score-identity regression.

Requires Python Playwright and Chromium. Uses an isolated temporary tournament
and fixture pairing code; never reads or edits the live competition data.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results'))
PIN = 'draft-regression-fixture'

SERVER = """
const fs=require('node:fs'),path=require('node:path');
const {createDefaultState}=require('./lib/default-state');
const {applyAction}=require('./lib/tournament');
const {createBroadcastServer}=require('./server');
const dir=process.argv[1],state=createDefaultState();
const act=(type,payload={})=>applyAction(state,{type,payload});
act('seed-bracket',{ids:state.qualifier.players.map(p=>p.id)});
for(const matchId of ['W1','W2']) {
  act('select-match',{matchId});act('draw-candidates',{matchId});
  const match=state.tournament.matches.find(m=>m.id===matchId);
  act('ban-song',{matchId,playerIndex:0,songId:match.candidates[0].id});
  act('ban-song',{matchId,playerIndex:1,songId:match.candidates[1].id});act('pick-songs',{matchId});
}
act('select-match',{matchId:'W1'});
fs.writeFileSync(path.join(dir,'match-state.json'),JSON.stringify(state));
const broadcast=createBroadcastServer({dataDir:dir,pin:'draft-regression-fixture'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""


def stop_server(process):
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=8)


def command_log(page):
    """Observe real command acknowledgements without logging pairing tokens."""
    page.evaluate('''() => {
      window.__draftCommands = [];
      const original = io.Socket.prototype.emit;
      io.Socket.prototype.emit = function(event, ...args) {
        if (event === 'command') {
          const request = args[0];
          const record = {action:structuredClone(request.action), revision:request.expectedRevision, done:false};
          window.__draftCommands.push(record);
          const last = args.length - 1, callback = args[last];
          if (typeof callback === 'function') args[last] = function(...response) {
            record.done = true;
            const result = response.find(value => value && typeof value.ok === 'boolean');
            record.result = result || {ok:false,error:'No command acknowledgement'};
            return callback.apply(this, response);
          };
        }
        return original.call(this, event, ...args);
      };
    }''')


def tab(page, name):
    page.locator(f'.tabs [data-tab="{name}"]').click()
    page.wait_for_function('name => document.querySelector(`.tabs [data-tab="${name}"]`).getAttribute("aria-selected") === "true"', arg=name)


def wait_commands(page):
    page.wait_for_function('window.__draftCommands.every(command => command.done)')


def wait_score(page, match_id, player, song, value):
    page.wait_for_function('''async ({id,player,song,value}) => {
      const state=await fetch('../api/state').then(response=>response.json());
      return state.tournament.matches.find(match=>match.id===id).scores[player][song]===value;
    }''', arg={'id': match_id, 'player': player, 'song': song, 'value': value})


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'cross_match': {}, 'event_drafts': {}, 'library_drafts': {}, 'conflicts': {}, 'queued_scores': {}}
    with tempfile.TemporaryDirectory(prefix='acahku-control-drafts-') as data_dir:
        process = subprocess.Popen(['node', '-e', SERVER, data_dir], cwd=ROOT,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                assert ready.select(timeout=12), 'Temporary draft server did not start within 12 seconds.'
            port = process.stdout.readline().strip()
            assert port.isdigit(), 'Temporary draft server failed: ' + process.stderr.read()
            base = f'http://127.0.0.1:{port}'
            with sync_playwright() as p:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
                browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
                errors, requests, dialogs = [], [], []
                contexts, pages = [], []
                for _ in range(2):
                    context = browser.new_context(viewport={'width': 1194, 'height': 834}, has_touch=True)
                    context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
                    context.on('request', lambda request: requests.append(request.url))
                    page = context.new_page()
                    def accept_dialog(dialog):
                        dialogs.append(dialog.message)
                        dialog.accept()
                    page.on('dialog', accept_dialog)
                    page.goto(base + '/control/')
                    page.fill('#pin', PIN)
                    page.click('#pair-form button')
                    page.wait_for_selector('#workspace:not([hidden])')
                    command_log(page)
                    contexts.append(context)
                    pages.append(page)
                a, b = pages

                def state():
                    return contexts[0].request.get(base + '/api/state').json()

                def score(match_id, player=0, song=0):
                    return next(match for match in state()['tournament']['matches'] if match['id'] == match_id)['scores'][player][song]

                def private_state():
                    return a.evaluate('fetch("/api/control-state", {headers:{Authorization:"Bearer "+sessionStorage.getItem("broadcast-token")}}).then(response=>response.json())')

                def wait_status(page, match_id, status):
                    page.wait_for_function('''async ({id,status}) => {
                      const state=await fetch('../api/state').then(response=>response.json());
                      return state.tournament.matches.find(match=>match.id===id).status===status;
                    }''', arg={'id': match_id, 'status': status})

                def toggle_view(page):
                    tab(page, 'broadcast')
                    value = 'false' if state()['broadcast']['showHandcams'] else 'true'
                    page.click(f'[data-broadcast-handcams="{value}"]')
                    page.wait_for_function('value => document.querySelector(`[data-broadcast-handcams="${value}"]`).getAttribute("aria-pressed") === "true"', arg=value)
                    wait_commands(page)

                def wait_push(page, revision):
                    page.wait_for_function('revision => document.querySelector("#sync-status").textContent.includes(`revision ${revision}`)', arg=revision)

                # A's half-entered W1 score must never become the W2 score field.
                for page in pages:
                    tab(page, 'bracket')
                    page.wait_for_selector('#ms-W1-0-0')
                a.fill('#ms-W1-0-0', '999')
                b.click('[data-match="W2"]')
                a.wait_for_selector('#ms-W2-0-0')
                assert a.input_value('#ms-W2-0-0') == '', 'W1 draft leaked into W2.'
                assert a.evaluate('document.activeElement?.id') != 'ms-W2-0-0', 'Remote match switch moved editing focus into another match.'
                a.locator('#ms-W2-0-0').press_sequentially('888')
                a.press('#ms-W2-0-0', 'Tab')
                wait_score(a, 'W2', 0, 0, 888)
                wait_commands(a)
                assert score('W1') is None, 'Leaving the old W1 field silently saved its draft.'
                a.click('[data-match="W1"]')
                a.wait_for_selector('#ms-W1-0-0')
                assert a.input_value('#ms-W1-0-0') == '999', 'Switching back discarded W1 draft.'
                # Re-focusing a restored draft does not itself generate a native
                # change event; make an intentional edit before committing it.
                a.fill('#ms-W1-0-0', '1000')
                a.press('#ms-W1-0-0', 'Tab')
                wait_score(a, 'W1', 0, 0, 1000)
                wait_commands(a)
                assert score('W2') == 888
                score_commands = a.evaluate('window.__draftCommands.filter(command=>command.action.type==="set-match-score")')
                assert all(command['action']['payload'].get('matchId') in ['W1', 'W2'] for command in score_commands), 'Score commands do not identify the edited match.'
                report['cross_match'] = {'restored_local_draft': '999', 'W1': score('W1'), 'W2': score('W2'), 'scoped_commands': len(score_commands)}

                # Keep entire forms, including inactive inputs, selects and checkboxes.
                tab(a, 'event')
                a.fill('#event-title', 'Local draft title')
                a.fill('#event-venue', 'Local draft venue UG302')
                a.fill('#song-title', 'Draft AT exclusive')
                a.fill('#song-artist', 'Regression fixture')
                a.fill('#song-level', '17.6')
                a.fill('#song-preview-audio', 'assets/song-preview/prepared.mp3')
                a.select_option('#song-difficulty', 'AT')
                a.uncheck('#song-eligible')
                a.focus('#song-difficulty')
                tab(b, 'broadcast')
                b.click('[data-broadcast-handcams="true"]')
                b.wait_for_function('document.querySelector("[data-broadcast-handcams=true]").getAttribute("aria-pressed") === "true"')
                wait_commands(b)
                wait_push(a, state()['revision'])
                assert a.input_value('#event-title') == 'Local draft title'
                assert a.input_value('#event-venue') == 'Local draft venue UG302'
                assert a.input_value('#song-difficulty') == 'AT'
                assert not a.is_checked('#song-eligible')
                assert a.evaluate('document.activeElement?.id') == 'song-difficulty', 'Synchronized state discarded SELECT focus.'
                for name in ['bracket', 'songs', 'event']:
                    tab(a, name)
                assert a.input_value('#event-title') == 'Local draft title'
                assert a.input_value('#event-venue') == 'Local draft venue UG302'
                assert a.input_value('#song-title') == 'Draft AT exclusive'
                assert a.input_value('#song-artist') == 'Regression fixture'
                assert a.input_value('#song-difficulty') == 'AT'
                assert a.input_value('#song-level') == '17.6'
                assert a.input_value('#song-preview-audio') == 'assets/song-preview/prepared.mp3'
                assert not a.is_checked('#song-eligible')
                a.click('#event-form button[type="submit"]')
                a.wait_for_function('fetch("../api/state").then(response=>response.json()).then(state=>state.event.title === "Local draft title" && state.event.venue === "Local draft venue UG302")')
                wait_commands(a)
                assert a.input_value('#song-difficulty') == 'AT' and not a.is_checked('#song-eligible')
                assert a.input_value('#song-preview-audio') == 'assets/song-preview/prepared.mp3'
                a.click('#song-form button[type="submit"]')
                a.wait_for_function('fetch("../api/state").then(response=>response.json()).then(state=>state.library.some(song=>song.title === "Draft AT exclusive" && song.difficulty === "AT" && song.level === 17.6 && song.eligible === false))')
                assert next(song for song in state()['library'] if song['title']=='Draft AT exclusive')['previewAudio']=='assets/song-preview/prepared.mp3'
                assert not any('/assets/song-preview/' in url for url in requests), 'Reserved audio field caused an audio request'
                wait_commands(a)
                report['event_drafts'] = {'title': state()['event']['title'], 'venue': state()['event']['venue']}
                saved_song = next(song for song in state()['library'] if song['title'] == 'Draft AT exclusive')
                report['library_drafts'] = {key: saved_song[key] for key in ['title', 'difficulty', 'level', 'eligible']}

                # A's old draft must survive a conflicting B save, without replacing B.
                for page in pages:
                    tab(page, 'bracket')
                    page.wait_for_selector('#ms-W1-0-0')
                a.fill('#ms-W1-0-0', '333')
                b.fill('#ms-W1-0-0', '444')
                b.press('#ms-W1-0-0', 'Tab')
                wait_score(b, 'W1', 0, 0, 444)
                wait_commands(b)
                a.wait_for_function('''() => /conflict|衝突|冲突|another operator|另一|changed by/i.test(
                  document.querySelector('#toast')?.textContent + ' ' + document.querySelector('#content')?.textContent)''')
                assert a.input_value('#ms-W1-0-0') == '333', 'Conflicting remote save discarded the local draft.'
                conflict_text = a.locator('.draft-notice').inner_text()
                assert '服务器：444' in conflict_text and '保留草稿：333' in conflict_text, conflict_text
                # Continue editing after the remote push to exercise the actual
                # guarded change handler, rather than blurring an unchanged value.
                a.fill('#ms-W1-0-0', '3335')
                a.press('#ms-W1-0-0', 'Tab')
                wait_commands(a)
                assert score('W1') == 444, 'Unresolved local draft silently replaced the other operator score.'
                assert a.input_value('#ms-W1-0-0') == '3335', 'Rejected conflict discarded the local draft.'
                a.screenshot(path=str(OUT / 'control-draft-conflict.png'), full_page=True)
                report['conflicts'] = {'retained_local_draft': a.input_value('#ms-W1-0-0'), 'saved_remote_score': score('W1')}

                # Queue independent edits in one event-loop turn, before acknowledgements.
                offset = b.evaluate('window.__draftCommands.length')
                b.evaluate('''() => {
                  for (const [id,value] of [['ms-W1-0-1','101001'],['ms-W1-1-0','202002'],['ms-W1-1-1','303003']]) {
                    const input=document.getElementById(id);
                    input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
                    input.dispatchEvent(new Event('change',{bubbles:true}));
                  }
                }''')
                for player, song, value in [(0, 1, 101001), (1, 0, 202002), (1, 1, 303003)]:
                    wait_score(b, 'W1', player, song, value)
                wait_commands(b)
                queued = b.evaluate('offset => window.__draftCommands.slice(offset)', offset)
                assert len(queued) == 3 and all(command['result']['ok'] for command in queued), ('Queued edits failed', queued)
                assert len({command['revision'] for command in queued}) == 3, 'Queued commands reused an obsolete revision.'
                report['queued_scores'] = {'scores': [score('W1', 0, 1), score('W1', 1, 0), score('W1', 1, 1)], 'acknowledgements': len(queued)}

                # Both conflict choices must be explicit: reviewing preserves
                # the draft without saving, and accepting the server discards it.
                a.locator('.draft-notice [data-draft-resolution="review"]').click()
                assert a.input_value('#ms-W1-0-0') == '3335'
                assert score('W1') == 444, 'Reviewing a draft silently submitted it.'
                a.fill('#ms-W1-0-0', '334')
                a.press('#ms-W1-0-0', 'Tab')
                wait_score(a, 'W1', 0, 0, 334)
                wait_commands(a)
                b.wait_for_function('document.querySelector("#ms-W1-0-0").value === "334"')
                a.fill('#ms-W1-0-0', '555')
                b.fill('#ms-W1-0-0', '666')
                b.press('#ms-W1-0-0', 'Tab')
                wait_score(b, 'W1', 0, 0, 666)
                wait_commands(b)
                a.locator('.draft-notice [data-draft-resolution="server"]').wait_for()
                a.locator('.draft-notice [data-draft-resolution="server"]').click()
                assert a.input_value('#ms-W1-0-0') == '666'
                assert score('W1') == 666
                report['conflicts']['explicit_review_save'] = 334
                report['conflicts']['accepted_server_score'] = 666

                # A concrete result confirmation must name the match, both
                # totals and its winner before advancing the bracket.
                w1 = next(match for match in state()['tournament']['matches'] if match['id'] == 'W1')
                totals = [sum(values) for values in w1['scores']]
                winner = w1['players'][totals.index(max(totals))]
                winner_name = next(player['name'] for player in state()['qualifier']['players'] if player['id'] == winner)
                a.click('#result-details summary')
                a.fill('#result-note', 'Verified actual score totals')
                a.click('#result-form button[type="submit"]')
                wait_status(a, 'W1', 'complete')
                wait_commands(a)
                result_dialog = dialogs[-1]
                assert 'W1' in result_dialog and winner_name in result_dialog and '获胜者' in result_dialog, result_dialog
                assert all(f'{total:,}' in result_dialog for total in totals), result_dialog
                report['result_confirmation'] = {'matchId': 'W1', 'totals': totals, 'winnerId': winner}

                # Rename an existing seeded competitor through the stable-ID
                # form, retaining every reference and previously saved score.
                player_id = w1['players'][0]
                before_rename = state()
                tab(a, 'qualifiers')
                a.click('#rename-details summary')
                a.fill(f'#rename-name-{player_id}', '回归测试选手')
                a.click(f'#rename-form-{player_id} button[type="submit"]')
                a.wait_for_function('id => fetch("../api/state").then(response=>response.json()).then(state=>state.qualifier.players.find(player=>player.id===id).name==="回归测试选手")', arg=player_id)
                wait_commands(a)
                after_rename = state()
                assert after_rename['tournament']['seeds'] == before_rename['tournament']['seeds']
                assert next(match for match in after_rename['tournament']['matches'] if match['id'] == 'W1')['scores'] == w1['scores']
                report['stable_rename'] = {'playerId': player_id, 'name': '回归测试选手', 'scores_preserved': True}

                # Create a real started downstream match so the correction
                # preview includes data that will be explicitly cleared.
                tab(b, 'bracket')
                b.click('[data-match="W2"]')
                b.wait_for_selector('#ms-W2-0-0')
                for player, song, value in [(0, 0, 500000), (0, 1, 500001), (1, 0, 300000), (1, 1, 300001)]:
                    b.fill(f'#ms-W2-{player}-{song}', str(value))
                    b.press(f'#ms-W2-{player}-{song}', 'Tab')
                    wait_score(b, 'W2', player, song, value)
                wait_commands(b)
                if not b.locator('#result-details').evaluate('element=>element.open'):
                    b.click('#result-details summary')
                b.click('#result-form button[type="submit"]')
                wait_status(b, 'W2', 'complete')
                wait_commands(b)
                b.click('[data-match="W5"]')
                tab(b, 'songs')
                b.click('[data-command="draw-candidates"]')
                b.wait_for_selector('[data-ban-player="0"]')
                wait_commands(b)
                b.locator('[data-ban-player="0"]').nth(0).click()
                wait_commands(b)
                b.locator('[data-ban-player="1"]').nth(1).click()
                wait_commands(b)
                b.click('[data-command="pick-songs"]')
                wait_commands(b)
                tab(b, 'bracket')
                b.fill('#ms-W5-0-0', '12345')
                b.press('#ms-W5-0-0', 'Tab')
                wait_score(b, 'W5', 0, 0, 12345)
                wait_commands(b)

                # Preview revisions are immutable: a later score invalidates
                # the confirmation while leaving its reason and checkbox.
                tab(a, 'event')
                a.select_option('#correction-match', 'W1')
                a.click('[data-preview-correction]')
                a.wait_for_selector('#correction-confirm-clear')
                a.fill('#correction-reason', '裁判复核：修正 W1 原赛果')
                a.check('#correction-confirm-clear')
                b.fill('#ms-W5-0-0', '23456')
                b.press('#ms-W5-0-0', 'Tab')
                wait_score(b, 'W5', 0, 0, 23456)
                wait_commands(b)
                a.wait_for_selector('#correction-form button[type="submit"][disabled]')
                assert '预览已过期' in a.locator('.operations-panel').inner_text()
                assert a.input_value('#correction-reason') == '裁判复核：修正 W1 原赛果'
                assert a.is_checked('#correction-confirm-clear')
                for name in ['bracket', 'event']:
                    tab(a, name)
                assert a.input_value('#correction-reason') == '裁判复核：修正 W1 原赛果'
                assert a.is_checked('#correction-confirm-clear')
                a.click('[data-preview-correction]')
                a.wait_for_selector('#correction-form button[type="submit"]:not([disabled])')
                # Delay only this already-created websocket command, modeling
                # a packet in flight while the second operator saves a score.
                a.evaluate('''() => {
                  const original=io.Socket.prototype.emit;
                  let held=false;
                  io.Socket.prototype.emit=function(event,...args) {
                    if (!held && event==='command' && args[0]?.action.type==='reopen-result') {
                      held=true;window.__heldReopen=()=>original.call(this,event,...args);return this;
                    }
                    return original.call(this,event,...args);
                  };
                }''')
                a.click('#correction-form button[type="submit"]')
                a.wait_for_function('typeof window.__heldReopen === "function"')
                b.fill('#ms-W5-0-0', '34567')
                b.press('#ms-W5-0-0', 'Tab')
                wait_score(b, 'W5', 0, 0, 34567)
                wait_commands(b)
                a.evaluate('window.__heldReopen()')
                a.wait_for_function('window.__draftCommands.some(command=>command.action.type==="reopen-result" && command.done && command.result.code==="STALE")')
                assert a.input_value('#correction-reason') == '裁判复核：修正 W1 原赛果'
                assert a.is_checked('#correction-confirm-clear')
                assert score('W5') == 34567, 'Stale correction cleared the new downstream score.'
                assert '编辑冲突' in a.locator('#toast').inner_text()
                a.click('[data-preview-correction]')
                a.wait_for_selector('#correction-form button[type="submit"]:not([disabled])')
                for width in [390, 768, 1194]:
                    a.set_viewport_size({'width': width, 'height': 834})
                    assert a.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), ('correction-form', width)
                    if width == 390:
                        a.locator('.operations-panel').screenshot(path=str(OUT / 'control-correction-390.png'))
                correction_revision = state()['revision']
                a.click('#correction-form button[type="submit"]')
                a.wait_for_function('fetch("../api/state").then(response=>response.json()).then(state=>state.tournament.matches.find(match=>match.id==="W1").status!=="complete")')
                wait_commands(a)
                correction_command = a.evaluate('window.__draftCommands.filter(command=>command.action.type==="reopen-result").at(-1)')
                assert correction_command['revision'] == correction_revision and correction_command['result']['ok']
                assert correction_command['action']['payload']['confirmClear'] is True
                corrected = state()
                reopened = next(match for match in corrected['tournament']['matches'] if match['id'] == 'W1')
                downstream = next(match for match in corrected['tournament']['matches'] if match['id'] == 'W5')
                assert reopened['scores'] == w1['scores'], 'Correction erased the scores being corrected.'
                assert downstream['songs'] == [] and all(value is None for row in downstream['scores'] for value in row)
                report['correction'] = {'stale_preview_blocked': True, 'reason_and_checkbox_preserved': True,
                                        'preview_revision': correction_revision, 'affected': correction_command['action']['payload']['affectedMatchIds'], 'downstream_cleared': True, 'in_flight_stale_rejected': True}

                # A restore replaces the whole event only after a fresh
                # concrete summary; another device's update expires it.
                a.click('[data-load-backups]')
                a.wait_for_function('document.querySelector("#backup-id").options.length > 1')
                a.click('[data-preview-backup]')
                a.wait_for_selector('#restore-form')
                selected_backup = a.input_value('#backup-id')
                a.fill('#restore-reason', '回归测试：恢复纠错前版本')
                toggle_view(b)
                a.wait_for_selector('#restore-form button[type="submit"][disabled]')
                assert a.input_value('#restore-reason') == '回归测试：恢复纠错前版本'
                a.click('[data-preview-backup]')
                a.wait_for_selector('#restore-form button[type="submit"]:not([disabled])')
                # Pause an already-sent restore POST and advance the event on
                # B. The server must reject its captured revision with 409.
                def delay_restore(route):
                    toggle_view(b)
                    route.continue_()
                a.route('**/api/restore', delay_restore, times=1)
                with a.expect_response(lambda response: response.url.endswith('/api/restore')) as stale_restore:
                    a.click('#restore-form button[type="submit"]')
                assert stale_restore.value.status == 409 and stale_restore.value.json()['code'] == 'STALE'
                assert a.input_value('#restore-reason') == '回归测试：恢复纠错前版本'
                assert next(match for match in state()['tournament']['matches'] if match['id'] == 'W1')['status'] != 'complete'
                a.click('[data-preview-backup]')
                a.wait_for_selector('#restore-form button[type="submit"]:not([disabled])')
                for width in [390, 768, 1194]:
                    a.set_viewport_size({'width': width, 'height': 834})
                    assert a.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), ('restore-form', width)
                restore_revision = state()['revision']
                with a.expect_request(lambda request: request.url.endswith('/api/restore') and request.method == 'POST') as restore_request:
                    a.click('#restore-form button[type="submit"]')
                restore_body = restore_request.value.post_data_json
                assert restore_body['expectedRevision'] == restore_revision and restore_body['backupId'] == selected_backup
                a.wait_for_function('fetch("../api/state").then(response=>response.json()).then(state=>state.tournament.matches.find(match=>match.id==="W1").status==="complete")')
                a.wait_for_function('fetch("/api/control-state",{headers:{Authorization:"Bearer "+sessionStorage.getItem("broadcast-token")}}).then(response=>response.json()).then(state=>state.auditLog.at(-1).type==="restore-backup")')
                assert score('W5') == 34567
                a.wait_for_function('document.querySelector("#audit-details").textContent.includes("恢复备份")')
                assert a.locator('.audit-list > li').count() <= 10
                report['restore'] = {'stale_preview_blocked': True, 'reason_preserved': True, 'request_revision': restore_revision, 'saved_downstream_score_restored': score('W5'), 'in_flight_stale_rejected': True}

                # Source names are staff notes. Confirmation cannot happen
                # while unsaved notes exist, and mode changes invalidate it.
                tab(a, 'broadcast')
                if state()['broadcast']['showHandcams'] is not True:
                    toggle_view(a)
                a.evaluate('window.__savedPreviewWindow=document.querySelector("#program-preview").contentWindow;window.__savedPreviewDocument=window.__savedPreviewWindow.document')
                for index in range(2):
                    a.fill(f'#source-capture-{index}', f'采集卡 {index + 1}')
                    a.fill(f'#source-handcam-{index}', f'手元 {index + 1}')
                assert a.locator('[data-confirm-sources]').is_disabled(), 'Unsaved source names could be confirmed.'
                a.click('#source-form button[type="submit"]')
                a.wait_for_function('document.querySelector("[data-confirm-sources]").disabled===false')
                wait_commands(a)
                a.click('[data-confirm-sources]')
                a.wait_for_selector('.source-check-status[data-confirmed="true"]')
                wait_commands(a)
                assert private_state()['broadcast']['sourceStatus']['confirmed'] is True
                assert '人工' in a.locator('.source-check-status').inner_text()
                toggle_view(b)
                a.wait_for_selector('.source-check-status[data-confirmed="false"]')
                assert a.evaluate('document.querySelector("#program-preview").contentWindow===window.__savedPreviewWindow && document.querySelector("#program-preview").contentWindow.document===window.__savedPreviewDocument'), 'Broadcast source/status updates reloaded the preview iframe.'
                report['manual_sources'] = {'confirmed_then_invalidated': True, 'iframe_preserved': True, 'unsaved_confirmation_disabled': True}
                a.locator('.broadcast-sources-panel').screenshot(path=str(OUT / 'control-sources-1194.png'))

                # Newly added recovery/source/rename panels remain inside the
                # viewport on phones and tablets, including their real forms.
                responsive = []
                for width in [390, 768, 1194]:
                    a.set_viewport_size({'width': width, 'height': 834})
                    for name in ['broadcast', 'event', 'qualifiers']:
                        tab(a, name)
                        dimensions = a.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})')
                        assert dimensions['scrollWidth'] <= dimensions['width'] + 1, (width, name, dimensions)
                        responsive.append({'width': width, 'tab': name, 'scrollWidth': dimensions['scrollWidth']})
                    if width == 390:
                        tab(a, 'event')
                        a.screenshot(path=str(OUT / 'control-operations-390.png'), full_page=True)
                report['responsive'] = responsive

                failures = [command for page in pages for command in page.evaluate('window.__draftCommands')
                            if command.get('result', {}).get('ok') is False]
                stales = [command for command in failures if command.get('result', {}).get('code') == 'STALE']
                assert len(stales) == 1 and stales[0]['action']['type'] == 'reopen-result', failures
                assert not errors, errors
                external = [url for url in requests if urlsplit(url).netloc and urlsplit(url).netloc != urlsplit(base).netloc]
                assert not external, external
                report['browser_errors'] = errors
                report['external_requests'] = external
                report['server_revision'] = state()['revision']
                (OUT / 'control-drafts.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                print(json.dumps(report, ensure_ascii=False))
                browser.close()
        finally:
            stop_server(process)


if __name__ == '__main__':
    main()
