"""Real-browser regression for separate control and scorekeeper workspaces.

Requires Python Playwright, Pillow and Chromium. Uses independent browser
sessions, fixture-only pairing codes and a temporary tournament directory.
Set BROADCAST_TEST_OUTPUT to select screenshots and the JSON report.
"""
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results'))
MAIN_PIN = 'main-browser-fixture'
SCORE_PIN = 'score-browser-fixture'
REPORT = {'checks': [], 'pageErrors': [], 'geometry': {}, 'artifacts': []}
SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],stateFile=path.join(dir,'match-state.json');
if(!fs.existsSync(stateFile)) {
  const state=require('./test/helpers/legacy-state').createDefaultState();
  require('./test/helpers/song-library').expandSongLibrary(state);
  const names=['Hekiru','Sunshine','FIFICO2','zuri','scsfoon2','Ayami','Sapphire','William'];
  state.qualifier.players.forEach((player,index)=>player.name=names[index]);
  state.library[7].title='PRIVATE MC BROWSER FIXTURE';
  state.library[7].eligible=false; // Reserve the sealed MC fixture for the final.
  fs.writeFileSync(stateFile,JSON.stringify(state));
}
const broadcast=require('./server').createBroadcastServer({dataDir:dir,
  pin:'main-browser-fixture',scorekeeperPin:process.argv[3]||'score-browser-fixture'});
broadcast.listen(Number(process.argv[2])||0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def server_start(data_dir, port=0, score_pin=SCORE_PIN):
    process = subprocess.Popen(['node', '-e', SERVER, data_dir, str(port), score_pin], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        assert ready.select(timeout=12), 'Temporary scorekeeper server did not start within 12 seconds'
    bound = process.stdout.readline().strip()
    assert bound.isdigit(), 'Temporary scorekeeper server did not start'
    return process, int(bound)


def server_stop(process):
    if process is None:
        return
    process.terminate()
    try:
        process.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=8)


def record_commands(page):
    page.evaluate('''() => {
      window.__scoreCommands=[];
      const original=io.Socket.prototype.emit;
      io.Socket.prototype.emit=function(event,...args) {
        if(event==='command') {
          window.__scoreSocket=this;
          const record={request:structuredClone(args[0]),done:false};
          window.__scoreCommands.push(record);
          const index=args.length-1,callback=args[index];
          if(typeof callback==='function') args[index]=function(...response) {
            record.done=true;
            record.result=response.find(value=>value&&typeof value.ok==='boolean')||null;
            return callback.apply(this,response);
          };
        }
        return original.call(this,event,...args);
      };
    }''')


def wait_commands(page):
    page.wait_for_function('window.__scoreCommands.every(record=>record.done)', timeout=12000)


def hold_next_score_ack(page):
    """Delay one actual server acknowledgement, without delaying its state update."""
    page.evaluate('''() => {
      if(!window.__ackHoldInstalled) {
        window.__ackHoldInstalled=true;
        const original=io.Socket.prototype.emit;
        io.Socket.prototype.emit=function(event,...args) {
          if(event==='command'&&window.__holdNextScoreAck) {
            window.__holdNextScoreAck=false;
            const callback=args.pop();
            args.push((...response)=>{window.__releaseScoreAck=()=>callback(...response)});
          }
          return original.call(this,event,...args);
        };
      }
      window.__releaseScoreAck=null;
      window.__holdNextScoreAck=true;
    }''')


def release_score_ack(page):
    page.wait_for_function('typeof window.__releaseScoreAck==="function"', timeout=4000)
    page.evaluate('window.__releaseScoreAck()')


def tab(page, name):
    page.locator(f'.tabs [data-tab="{name}"]').click()
    page.wait_for_function('name=>document.querySelector(`.tabs [data-tab="${name}"]`)?.getAttribute("aria-selected")==="true"', arg=name)


def idle_overlay(page, scene):
    page.wait_for_function('''scene=>{
      const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
      return mount?.dataset.motionPhase==='idle'&&canvas?.dataset.renderedScene===scene
        &&!mount.querySelector('[data-motion-ghost],[data-motion-live],[data-motion-placeholder]')
        &&!mount.getAnimations({subtree:true}).some(animation=>animation.playState==='running'||animation.pending);
    }''', arg=scene, timeout=20000)


def geometry(page, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    result = page.evaluate('''() => {
      const rect=element=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};
      const visible=element=>element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden';
      const forms=Array.from(document.querySelectorAll('form[data-player-key]')).filter(visible);
      const targets=Array.from(document.querySelectorAll('#context-title,#context-description,#toast,form[data-player-key] h2,form[data-player-key] h3,input[data-score-key],button[data-save-player]')).filter(visible);
      return {viewport:innerWidth,scrollWidth:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth),
        forms:forms.map(form=>({key:form.dataset.playerKey,box:rect(form)})),
        controls:targets.map(element=>({tag:element.tagName,key:element.dataset.scoreKey||element.dataset.savePlayer||element.id,
          text:element.tagName==='INPUT'?'':element.textContent,box:rect(element),
          ancestor:targets.filter(other=>other!==element&&other.contains(element)).map(other=>other.id||other.dataset.savePlayer||other.dataset.scoreKey||other.tagName)}))};
    }''')
    assert result['scrollWidth'] <= width + 1, (width, result['scrollWidth'], 'Horizontal page overflow')
    for item in result['controls']:
        box = item['box']
        assert box['x'] >= -.5 and box['x'] + box['w'] <= width + .5, (width, item, 'Control beyond viewport')
        if item['tag'] in ['INPUT', 'BUTTON']:
            assert box['w'] >= 48 and box['h'] >= 48, (width, item, 'Touch target under 48px')
    for index, a in enumerate(result['forms']):
        for b in result['forms'][index + 1:]:
            ar, br = a['box'], b['box']
            assert not (min(ar['x']+ar['w'], br['x']+br['w']) > max(ar['x'], br['x'])+.5 and
                        min(ar['y']+ar['h'], br['y']+br['h']) > max(ar['y'], br['y'])+.5), (width, a, b, 'Player cards overlap')
    for index, a in enumerate(result['controls']):
        for b in result['controls'][index + 1:]:
            if a['key'] in b['ancestor'] or b['key'] in a['ancestor']:
                continue
            ar, br = a['box'], b['box']
            assert not (min(ar['x']+ar['w'], br['x']+br['w']) > max(ar['x'], br['x'])+.5 and
                        min(ar['y']+ar['h'], br['y']+br['h']) > max(ar['y'], br['y'])+.5), (width, a, b, 'Score controls overlap')
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    process = None
    with tempfile.TemporaryDirectory(prefix='acahku-scorekeeper-browser-') as data_dir:
        try:
            process, port = server_start(data_dir)
            base = f'http://127.0.0.1:{port}'
            with sync_playwright() as p:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
                browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
                    '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
                contexts = [browser.new_context(viewport={'width':1194, 'height':834}, has_touch=True) for _ in range(3)]
                for context in contexts:
                    context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['pageErrors'].append(str(error))))
                crew, a, b = [context.new_page() for context in contexts]
                crew.on('dialog', lambda dialog: dialog.accept())
                crew.goto(base + '/control/')
                crew.fill('#pin', SCORE_PIN); crew.click('#pair-form button')
                crew.wait_for_function('document.querySelector("#pair-error")?.textContent.trim().length>0')
                assert not crew.locator('#workspace').is_visible(), 'Scorekeeper pairing code entered the main control room'
                crew.fill('#pin', MAIN_PIN); crew.click('#pair-form button')
                crew.wait_for_selector('#program-preview')
                for page in [a, b]:
                    page.goto(base + '/scorekeeper/')
                    page.fill('#pin', MAIN_PIN); page.click('#pair-form button')
                    page.wait_for_function('document.querySelector("#pair-error")?.textContent.trim().length>0')
                    assert not page.locator('#workspace').is_visible(), 'Main control code entered the scorekeeper panel'
                    page.fill('#pin', SCORE_PIN); page.click('#pair-form button')
                    page.wait_for_selector('#workspace:not([hidden])')
                    page.wait_for_selector('form[data-player-key] input[data-score-key]')
                    record_commands(page)
                check('different pairing codes select separate main-control and scorekeeper workspaces')

                assert crew.locator('.tabs [data-tab]').count() >= 5
                assert crew.locator('#program-preview').count() == 1
                assert crew.locator('[data-start-countdown]').count() == 1
                for page in [a, b]:
                    assert page.locator('.tabs,iframe,[data-scene],[data-command],[data-start-countdown],[data-tab],select,textarea').count() == 0
                    assert page.evaluate('sessionStorage.getItem("scorekeeper-token")!==null && sessionStorage.getItem("broadcast-token")===null')
                    assert page.locator('form[data-player-key]').evaluate_all('(forms)=>forms.map(form=>form.dataset.playerKey)') == ['p1','p2','p3']
                    assert page.locator('input[data-score-key]').count() == 9
                assert crew.evaluate('sessionStorage.getItem("broadcast-token")!==null && sessionStorage.getItem("scorekeeper-token")===null')
                roles = crew.evaluate('''async()=>{
                  const headers={Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')};
                  return (await fetch('/api/scorekeeper-state',{headers})).status;
                }''')
                assert roles == 403
                assert a.evaluate('''async()=>{
                  const headers={Authorization:'Bearer '+sessionStorage.getItem('scorekeeper-token')};
                  return (await fetch('/api/control-state',{headers})).status;
                }''') == 403
                check('main control retains its tabs and preview while scorekeepers receive only score entry')

                crew.evaluate('''async()=>{
                  const token=sessionStorage.getItem('broadcast-token');
                  const socket=io('/control',{forceNew:true,auth:{token}});
                  await new Promise(resolve=>socket.once('state',resolve));
                  window.__fixtureCommand=async(type,payload={})=>{
                    const current=await fetch('/api/control-state',{headers:{Authorization:'Bearer '+token}}).then(response=>response.json());
                    const data={expectedRevision:current.revision,action:{type,payload:{matchId:current.tournament.currentMatchId,...payload}}};
                    const response=await new Promise(resolve=>socket.emit('command',data,resolve));
                    if(!response.ok)throw new Error(response.error);
                    return response;
                  };
                }''')

                def command(type_, payload=None):
                    return crew.evaluate('data=>window.__fixtureCommand(data.type,data.payload)', {'type':type_, 'payload':payload or {}})

                def state():
                    return contexts[0].request.get(base + '/api/state').json()

                def private_state():
                    return crew.evaluate('''()=>fetch('/api/control-state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')}}).then(response=>response.json())''')

                def score(group_player, song=0, match_id=None):
                    current = state()
                    if match_id:
                        return next(match for match in current['tournament']['matches'] if match['id'] == match_id)['scores'][group_player][song]
                    return next(player for player in current['qualifier']['players'] if player['id'] == group_player)['scores'][song]

                def wait_score(player, song, value, match_id=None):
                    crew.wait_for_function('''async data=>{
                      const state=await fetch('/api/state').then(response=>response.json());
                      const scores=data.match?state.tournament.matches.find(match=>match.id===data.match).scores[data.player]:
                        state.qualifier.players.find(player=>player.id===data.player).scores;
                      return scores[data.song]===data.value;
                    }''', arg={'player':player, 'song':song, 'value':value, 'match':match_id})

                def form(page, index=0):
                    return page.locator('form[data-player-key]').nth(index)

                def field(page, player_index=0, song=0):
                    return form(page, player_index).locator(f'input[data-score-key][data-song-index="{song}"]')

                def save(page, player_index=0):
                    form(page, player_index).locator('button[data-save-player]').click()
                    page.wait_for_function('index=>Array.from(document.querySelectorAll("form[data-player-key]"))[index].querySelectorAll("input.is-dirty").length===0', arg=player_index)
                    wait_commands(page)

                command('set-scene', {'scene':'qualifier-match'})
                overlay_context = browser.new_context(viewport={'width':1920, 'height':1080})
                overlay_context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['pageErrors'].append(str(error))))
                overlay = overlay_context.new_page(); overlay.goto(base + '/overlay/live.html?details=1')
                idle_overlay(overlay, 'qualifier-match')

                for song_index, value in enumerate([986432, 992111, 979876]):
                    field(a, 0, song_index).fill(str(value))
                field(a, 1, 0).fill('975321')
                field(a, 1, 1).focus()
                active = a.evaluate('document.activeElement?.dataset.scoreKey')
                revision = state()['revision']
                command('set-broadcast-display', {'showHandcams':True})
                a.wait_for_function('revision=>document.querySelector("#sync-status")?.textContent.includes(String(revision))', arg=revision+1)
                assert [field(a, 0, index).input_value() for index in range(3)] == ['986432','992111','979876']
                assert field(a, 1, 0).input_value() == '975321'
                assert a.evaluate('document.activeElement?.dataset.scoreKey') == active
                assert score('p1') is None and score('p2') is None, 'Unsubmitted score draft was saved on blur or synchronization'
                save(a, 0)
                for index, value in enumerate([986432,992111,979876]):
                    wait_score('p1', index, value)
                assert field(a, 1, 0).input_value() == '975321' and score('p2') is None
                b.wait_for_function('''()=>Array.from(document.querySelectorAll('form[data-player-key]'))[0].querySelector('[data-song-index="0"]').value==='986432' ''')
                tab(crew, 'qualifiers'); crew.wait_for_function('document.querySelector("#qs-p1-0")?.value==="986432"')
                overlay.wait_for_function('document.querySelector("#scene")?.textContent.includes("986,432")')
                check('multi-field drafts survive remote updates and explicit player save reaches main control, both scorers and OBS')

                field(a, 0, 0).fill('0'); field(a, 0, 0).press('Enter'); wait_commands(a); wait_score('p1', 0, 0)
                assert field(a, 0, 0).input_value() == '0'
                field(a, 0, 0).fill(''); field(a, 0, 0).press('Enter'); wait_commands(a); wait_score('p1', 0, None)
                assert field(a, 0, 0).input_value() == ''
                check('Enter explicitly saves the player and distinguishes a zero score from an empty score')

                field(a, 0, 0).fill('943333')
                field(b, 0, 0).fill('944444'); save(b, 0); wait_score('p1', 0, 944444)
                a.wait_for_selector('[data-use-server]')
                assert field(a, 0, 0).input_value() == '943333'
                if not form(a, 0).locator('[data-save-player]').is_disabled():
                    save(a, 0)
                assert score('p1') == 944444, 'Unresolved conflict overwrote the other scorekeeper'
                a.locator('[data-use-server]').first.click()
                assert field(a, 0, 0).input_value() == '944444'
                field(a, 0, 0).fill('945555')
                field(b, 0, 0).fill('946666'); save(b, 0); wait_score('p1', 0, 946666)
                a.wait_for_selector('[data-keep-draft]'); a.locator('[data-keep-draft]').first.click()
                save(a, 0); wait_score('p1', 0, 945555)
                check('same-field edits require an explicit server-or-draft conflict decision')

                # A real first score commits while its acknowledgement is held.
                # Switching context must stop the rest of that player's batch.
                field(a, 0, 0).fill('950111'); field(a, 0, 1).fill('950222')
                count_before = a.evaluate('window.__scoreCommands.length')
                second_before = score('p1', 1)
                hold_next_score_ack(a)
                form(a, 0).locator('button[data-save-player]').click()
                wait_score('p1', 0, 950111)
                command('set-qualifier-display', {'group':'B','players':['p5','p6','p7']})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("B")')
                release_score_ack(a)
                a.wait_for_function('document.querySelector("#toast")?.textContent.includes("原場次草稿")')
                assert score('p1', 1) == second_before
                assert a.evaluate('window.__scoreCommands.length') == count_before + 1
                command('set-qualifier-display', {'group':'A','players':['p1','p2','p3']})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("A")')
                assert field(a, 0, 1).input_value() == '950222'
                save(a, 0); wait_score('p1', 1, 950222)
                check('a main-control context change during a multi-field save stops the remaining score commands')

                # Editing a later field during the same batch must leave the
                # new draft for an explicit second save, rather than sending it.
                field(a, 0, 0).fill('950333'); field(a, 0, 1).fill('950444')
                count_before = a.evaluate('window.__scoreCommands.length')
                hold_next_score_ack(a)
                form(a, 0).locator('button[data-save-player]').click()
                wait_score('p1', 0, 950333)
                field(a, 0, 1).fill('950555')
                release_score_ack(a)
                a.wait_for_function('document.querySelector("#toast")?.textContent.includes("草稿在保存期間有變動")')
                assert score('p1', 1) == 950222
                assert field(a, 0, 1).input_value() == '950555'
                assert a.evaluate('window.__scoreCommands.length') == count_before + 1
                save(a, 0); wait_score('p1', 1, 950555)
                check('editing an unsent field during a save retains the new draft until the scorekeeper saves again')

                field(a, 0, 2).fill('971234')
                a.evaluate('window.__oldScoreForm=document.querySelector("form[data-player-key]")')
                command('set-qualifier-display', {'group':'B','players':['p5','p6','p7']})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("B")')
                assert a.locator('form[data-player-key]').evaluate_all('(forms)=>forms.map(form=>form.dataset.playerKey)') == ['p5','p6','p7']
                assert a.locator('input[data-score-key]').count() == 9
                assert not any(field(a, index, 2).input_value() == '971234' for index in range(3))
                assert a.evaluate('document.activeElement?.dataset.scoreKey') is None
                before = [player['scores'] for player in state()['qualifier']['players']]
                a.evaluate('window.__oldScoreForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
                assert [player['scores'] for player in state()['qualifier']['players']] == before
                field(a, 0, 0).fill('934567'); save(a, 0); wait_score('p5', 0, 934567)
                command('set-qualifier-display', {'group':'A','players':['p1','p2','p3']})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("A")')
                assert field(a, 0, 2).input_value() == '971234'
                save(a, 0); wait_score('p1', 2, 971234)
                save(a, 1); wait_score('p2', 0, 975321)
                check('switching qualifier groups preserves old drafts without moving them into another player or group')

                REPORT['geometry']['qualifier'] = {}
                for width, height in [(390,844),(768,1024),(1194,834)]:
                    REPORT['geometry']['qualifier'][str(width)] = geometry(a, width, height)
                a.set_viewport_size({'width':1194,'height':834})
                a.screenshot(path=str(OUT / 'scorekeeper-qualifier.png'), full_page=True)
                a.set_viewport_size({'width':390,'height':844})
                a.screenshot(path=str(OUT / 'scorekeeper-mobile.png'), full_page=True)
                a.set_viewport_size({'width':1194,'height':834})
                check('qualifier score entry fits 390px phones and 768px/1194px tablets with at least 48px touch controls')

                command('seed-bracket', {'ids':[player['id'] for player in state()['qualifier']['players']]})
                def prepare_match(match_id):
                    command('select-match', {'matchId':match_id})
                    current = next(match for match in private_state()['tournament']['matches'] if match['id'] == match_id)
                    if not current['songs']:
                        command('draw-candidates', {'matchId':match_id})
                        current = next(match for match in private_state()['tournament']['matches'] if match['id'] == match_id)
                        command('ban-song', {'matchId':match_id, 'playerIndex':0, 'songId':current['candidates'][0]['id']})
                        command('ban-song', {'matchId':match_id, 'playerIndex':1, 'songId':current['candidates'][1]['id']})
                        command('pick-songs', {'matchId':match_id})
                prepare_match('W1'); prepare_match('W2'); command('select-match', {'matchId':'W1'})
                command('set-scene', {'scene':'double-elimination-match'})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("W1")')
                assert a.locator('form[data-player-key]').count() == 2
                assert a.locator('input[data-score-key]').count() == 4
                field(a, 0, 1).fill('983456')
                command('select-match', {'matchId':'W2'})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("W2")')
                assert all(field(a, index, 1).input_value() == '' for index in range(2))
                field(a, 0, 0).fill('981234'); save(a, 0); wait_score(0, 0, 981234, 'W2')
                command('select-match', {'matchId':'W1'})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("W1")')
                assert field(a, 0, 1).input_value() == '983456'
                field(a, 0, 0).fill('989123'); save(a, 0); wait_score(0, 0, 989123, 'W1'); wait_score(0, 1, 983456, 'W1')
                field(a, 1, 0).fill('978654'); field(a, 1, 1).fill('975432'); save(a, 1); wait_score(1, 1, 975432, 'W1')
                check('double-elimination sheets expose two players/two songs and keep drafts bound to the original match')

                tab(crew, 'bracket'); crew.wait_for_selector('#ms-W1-1-0')
                crew.fill('#ms-W1-1-0', '979999'); crew.press('#ms-W1-1-0', 'Tab'); wait_score(1, 0, 979999, 'W1')
                a.wait_for_function("""Array.from(document.querySelectorAll('form[data-player-key]'))[1].querySelector('[data-song-index="0"]').value==='979999'""")
                idle_overlay(overlay, 'double-elimination-match')
                overlay.wait_for_function('document.querySelector("#scene")?.textContent.includes("979,999")')
                assert overlay.locator('.match-countdown').is_hidden()
                image = Image.open(io.BytesIO(overlay.screenshot(omit_background=True))).convert('RGBA')
                for capture in overlay.locator('[data-capture]').all():
                    box = capture.bounding_box()
                    assert image.getpixel((int(box['x']+box['width']/2),int(box['y']+box['height']/2)))[3] == 0
                assert overlay.locator('[data-capture]').count() == 4, 'Two players no longer have separate capture and handcam windows'
                REPORT['geometry']['match'] = {}
                for width, height in [(390,844),(768,1024),(1194,834)]:
                    REPORT['geometry']['match'][str(width)] = geometry(a, width, height)
                a.set_viewport_size({'width':1194,'height':834}); a.screenshot(path=str(OUT / 'scorekeeper-match.png'), full_page=True)
                check('main-controller score editing remains available and OBS keeps its transparent dual-camera layout')

                field(a, 0, 0).fill('991234')
                contexts[1].set_offline(True)
                a.evaluate('window.__scoreSocket.io.engine.close()')
                a.wait_for_function('document.querySelector("#connection")?.textContent.match(/OFFLINE|離線|斷線|中斷|DISCONNECTED/i)')
                assert form(a, 0).locator('[data-save-player]').is_disabled()
                assert field(a, 0, 0).input_value() == '991234'
                assert score(0, 0, 'W1') == 989123
                contexts[1].set_offline(False)
                a.wait_for_function('document.querySelector("#connection")?.textContent.match(/ONLINE|已連線|連線正常|CONNECTED/i)')
                assert field(a, 0, 0).input_value() == '991234'
                assert score(0, 0, 'W1') == 989123, 'Reconnect silently submitted an offline draft'
                save(a, 0); wait_score(0, 0, 991234, 'W1')
                check('disconnect disables submission and reconnect retains drafts without buffering a hidden score write')

                # Advance every previous match through the ordinary public
                # tournament commands, preserving the actual Grand Finals rules.
                for match_id in ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']:
                    prepare_match(match_id)
                    for player_index in [0,1]:
                        for song_index in [0,1]:
                            command('set-match-score', {'matchId':match_id,'playerIndex':player_index,'songIndex':song_index,
                                'score':991000-song_index*500 if player_index == 0 else 972000-song_index*500})
                    command('record-result', {'matchId':match_id})
                command('select-match', {'matchId':'GF'})
                current=private_state()
                used={song['id'] for match in current['tournament']['matches'] if match['id']!='GF' for song in match['songs']}
                ids=[song['id'] for song in current['library'] if song['id'] not in used and song['id']!='song-8'][:7]+['song-8']
                assert len(ids)==8 and 'song-8' not in used
                command('set-final-candidates', {'matchId':'GF','ids':ids})
                command('set-final-picks', {'matchId':'GF','audienceIds':ids[:2],'hostId':'song-8'})
                command('set-scene', {'scene':'double-elimination-match'})
                a.wait_for_function('document.querySelector("#context-title")?.textContent.includes("GF")')
                assert a.locator('input[data-score-key]').count() == 6
                for player_index in [0,1]:
                    assert field(a, player_index, 2).is_disabled()
                assert 'PRIVATE MC BROWSER FIXTURE' not in a.locator('body').inner_text()
                assert a.evaluate('''async()=>{
                  const state=await fetch('/api/scorekeeper-state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('scorekeeper-token')}}).then(response=>response.json());
                  return !JSON.stringify(state).includes('PRIVATE MC BROWSER FIXTURE')&&!('hostPick' in state.match);
                }''')
                command('reveal-host-song', {'matchId':'GF'})
                a.wait_for_function("""!Array.from(document.querySelectorAll('form[data-player-key]'))[0].querySelector('[data-song-index="2"]').disabled""")
                assert 'PRIVATE MC BROWSER FIXTURE' in a.locator('body').inner_text()
                field(a, 0, 2).fill('995432'); save(a, 0); wait_score(0, 2, 995432, 'GF')
                REPORT['geometry']['final'] = geometry(a,390,844)
                check('Grand Finals third-song score is disabled and its selection stays private until the main controller reveals it')

                expected_revision = state()['revision']
                server_stop(process); process = None
                process, restarted = server_start(data_dir, port)
                assert restarted == port
                a.wait_for_function('''async expected=>{
                  const response=await fetch('/api/scorekeeper-state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('scorekeeper-token')}});
                  if(!response.ok)return false;const state=await response.json();
                  return state.revision===expected&&state.match.id==='GF'&&state.match.players[0].scores[2]===995432;
                }''', arg=expected_revision, timeout=20000)
                a.reload(); a.wait_for_selector('#workspace:not([hidden])')
                assert field(a, 0, 2).input_value() == '995432'
                assert score(0,0,'W1') == 991000
                check('both role sessions and saved tournament scores survive a fixture server restart')

                server_stop(process); process = None
                rotated_pin = 'rotated-score-browser-fixture'
                process, restarted = server_start(data_dir, port, rotated_pin)
                assert restarted == port
                a.wait_for_selector('#pairing:not([hidden])', timeout=20000)
                assert a.locator('#workspace').is_hidden()
                assert a.evaluate('sessionStorage.getItem("scorekeeper-token")') is None
                assert '重新' in a.locator('#pair-error').inner_text()
                assert crew.evaluate('''async()=> (await fetch('/api/control-state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')}})).status''') == 200
                a.fill('#pin', SCORE_PIN); a.click('#pair-form button')
                a.wait_for_function('document.querySelector("#pair-error")?.textContent.includes("不正確")')
                a.fill('#pin', rotated_pin); a.click('#pair-form button')
                a.wait_for_selector('#workspace:not([hidden])')
                assert field(a, 0, 2).input_value() == '995432'
                check('changing only the scorekeeper password returns old sessions to login while preserving main control and scores')

                assert not REPORT['pageErrors'], REPORT['pageErrors']
                check('main control, scorekeepers and OBS have no uncaught JavaScript errors')
                REPORT['ok'] = True
                REPORT['artifacts'] = ['scorekeeper-qualifier.png','scorekeeper-match.png','scorekeeper-mobile.png']
                browser.close()
        finally:
            server_stop(process)
            (OUT / 'scorekeeper-layout-report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
