"""Optional real-browser regression for the official chart list and fixed final.

Requires Python Playwright, Pillow and Chromium. Both the legacy migration and
the complete tournament use temporary data directories and fixture-only codes;
the real tournament data directory is never opened or changed. Screenshots and
the JSON report go to BROADCAST_TEST_OUTPUT or test-results/fixed-final.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

try:
    from PIL import Image
    from playwright.sync_api import sync_playwright
except ImportError as error:
    raise SystemExit("Install Python playwright and Pillow to run fixed-final-browser.py: " + str(error))

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'fixed-final'))
MAIN_PIN = 'fixed-final-main-fixture'
SCORE_PIN = 'fixed-final-score-fixture'
FINAL_IDS = ['competition-2026-gf-01', 'competition-2026-gf-02']
FINAL_TITLES = ['Desultory Signals', 'Petrichor']
REGULAR = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'L1', 'L2', 'W7', 'L3', 'L4', 'L5', 'L6']
REPORT = {'checks': [], 'browser_errors': [], 'geometry': [], 'motion': [], 'screenshots': []}

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1];
if(process.argv[2]==='legacy') {
  const state=require('./test/helpers/legacy-state').createDefaultState();
  fs.writeFileSync(path.join(dir,'match-state.json'),JSON.stringify(state));
}
const broadcast=require('./server').createBroadcastServer({dataDir:dir,
  pin:'fixed-final-main-fixture',scorekeeperPin:'fixed-final-score-fixture'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""

COMMANDS = r"""async () => {
  const token=sessionStorage.getItem('broadcast-token');
  if(!token)throw new Error('The real main-control login did not create its session');
  const socket=io('/control',{forceNew:true,auth:{token}});
  await new Promise((resolve,reject)=>{
    socket.once('state',state=>{window.__fixtureState=state;resolve()});
    socket.once('connect_error',reject);
  });
  socket.on('state',state=>window.__fixtureState=state);
  window.__fixtureCommand=async(type,payload={})=>{
    const current=await fetch('/api/control-state',{
      headers:{Authorization:'Bearer '+token}}).then(response=>response.json());
    const response=await new Promise(resolve=>socket.emit('command',{
      expectedRevision:current.revision,action:{type,payload:{
        matchId:current.tournament.currentMatchId,...payload}}},resolve));
    if(!response.ok)throw new Error(type+': '+response.error);
    return response;
  };
}"""

MOTION_PROBE = r"""() => {
  const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
  const branding=mount.querySelector('[data-motion-branding]');
  const original=[...branding.querySelectorAll('.phigros-logo,.club-logo')];
  const animations=new WeakSet(),records=[],frames=[];
  let active=true;
  const visible=element=>{
    for(let node=element;node&&node!==mount;node=node.parentElement){
      const css=getComputedStyle(node);if(css.visibility==='hidden'||Number(css.opacity)<.025)return false;
    }return true;
  };
  const box=element=>{
    const bounds=element.getBoundingClientRect(),stage=canvas.getBoundingClientRect(),scale=stage.width/1920;
    const result={left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom};
    if(element.dataset.motionEntryRect){
      const fixed=JSON.parse(element.dataset.motionEntryRect);
      result.left=Math.max(result.left,stage.left+fixed.left*scale);
      result.right=Math.min(result.right,stage.left+(fixed.left+fixed.width)*scale);
      result.top=Math.max(result.top,stage.top+fixed.top*scale);
      result.bottom=Math.min(result.bottom,stage.top+(fixed.top+fixed.height)*scale);
    }
    return result;
  };
  const overlaps=[];
  function tick(){
    if(!active)return;
    const logos=original.map(element=>({key:element.dataset.motionKey,connected:element.isConnected,
      complete:element.complete&&element.naturalWidth>0,opacity:Number(getComputedStyle(element).opacity),
      z:Number(getComputedStyle(element).zIndex),box:box(element)}));
    frames.push({same_plane:branding.isConnected&&mount.querySelector('[data-motion-branding]')===branding,logos});
    for(const animation of mount.getAnimations({subtree:true}))if(!animations.has(animation)){
      // The infection's ::after accent animates background-position. It is
      // independent of the Web Animations scene entry/exit tracks below.
      if(animation.animationName==='finale-accent-drift')continue;
      animations.add(animation);
      const target=animation.effect.target,timing=animation.effect.getTiming();
      if(target.dataset.motionEntry||target.dataset.motionExit)records.push({
        key:target.dataset.motionKey||'',song:target.dataset.finalSong||'',
        entry:!!target.dataset.motionEntry,exit:!!target.dataset.motionExit,
        scene:canvas.dataset.renderedScene,order:Number(target.dataset.motionOrder),
        rect:JSON.parse(target.dataset.motionEntryRect||target.dataset.motionExitRect),
        start:animation.startTime,duration:timing.duration,easing:timing.easing,
        keyframes:animation.effect.getKeyframes().map(frame=>({opacity:frame.opacity,transform:frame.transform}))});
    }
    const cards=[...mount.querySelectorAll('[data-final-song]')].filter(element=>
      !element.closest('[data-motion-exits]')&&visible(element));
    for(const card of cards)for(const logo of original){
      const a=box(card),b=box(logo),width=Math.min(a.right,b.right)-Math.max(a.left,b.left),
        height=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
      if(width>1&&height>1&&overlaps.length<8)overlaps.push({card:card.dataset.finalSong,logo:logo.dataset.motionKey,width,height});
    }
    requestAnimationFrame(tick);
  }
  window.__motionTrace={stop(){active=false;return {frames,records,overlaps}}};
  requestAnimationFrame(tick);
}"""

TEXT_AUDIT = r"""() => {
  const root=document.querySelector('#scene'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),texts=[];
  let node;
  while(node=walker.nextNode()){
    if(!node.textContent.trim()||node.parentElement.closest('svg,.phigros-wordmark,.offline-notice'))continue;
    let visible=true;
    for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement){
      const css=getComputedStyle(parent);if(css.visibility==='hidden'||Number(css.opacity)<.025)visible=false;
    }
    if(!visible)continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const b of range.getClientRects()){
      const rect={left:b.left,right:b.right,top:b.top,bottom:b.bottom};
      for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement){
        const css=getComputedStyle(parent),a=parent.getBoundingClientRect();
        if(['hidden','clip','auto','scroll'].includes(css.overflowX)){
          rect.left=Math.max(rect.left,a.left);rect.right=Math.min(rect.right,a.right);
        }
        if(['hidden','clip','auto','scroll'].includes(css.overflowY)){
          rect.top=Math.max(rect.top,a.top);rect.bottom=Math.min(rect.bottom,a.bottom);
        }
      }
      if(rect.right-rect.left>1&&rect.bottom-rect.top>1)texts.push({rect,text:node.textContent.trim().slice(0,60),node});
    }
  }
  const overlaps=[];
  for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
    const a=texts[i],b=texts[j];if(a.node===b.node)continue;
    const width=Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left),
      height=Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top);
    if(width>2&&height>2&&overlaps.length<8)overlaps.push({a:a.text,b:b.text,width,height});
  }
  return {text_fragments:texts.length,overlaps};
}"""


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def start_server(data_dir, fixture='official'):
    process = subprocess.Popen(['node', '-e', SERVER, data_dir, fixture], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=12):
            process.terminate()
            stdout, stderr = process.communicate(timeout=8)
            raise AssertionError('Temporary fixture server did not start: ' + stderr + stdout)
    port = process.stdout.readline().strip()
    assert port.isdigit(), 'Temporary fixture server did not report a port'
    return process, f'http://127.0.0.1:{port}'


def stop_server(process):
    process.terminate()
    try:
        process.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=8)


def login(context, base, role='control'):
    page = context.new_page()
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(base + '/' + role + '/')
    page.fill('#pin', MAIN_PIN if role == 'control' else SCORE_PIN)
    page.click('#pair-form button')
    page.wait_for_selector('#workspace:not([hidden])')
    if role == 'control':
        page.wait_for_selector('#program-preview')
        page.evaluate(COMMANDS)
    return page


def state(page):
    return page.evaluate('''() => fetch('/api/control-state',{
      headers:{Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')}}).then(response=>response.json())''')


def command(page, type_, payload=None):
    response = page.evaluate('data=>window.__fixtureCommand(data.type,data.payload)',
                            {'type': type_, 'payload': payload or {}})
    page.wait_for_function('revision=>window.__fixtureState.revision>=revision', arg=response['revision'])
    return response


def idle(page, scene):
    page.wait_for_function('''scene=>{
      const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
      return mount?.dataset.motionPhase==='idle'&&canvas?.dataset.renderedScene===scene
        &&!mount.querySelector('[data-motion-ghost],[data-motion-live],[data-motion-placeholder],[data-motion-exits]')
        &&!mount.getAnimations({subtree:true}).some(animation=>(animation.playState==='running'||animation.pending)&&animation.effect.getTiming().iterations!==Infinity);
    }''', arg=scene, timeout=20000)


def snapshot(page, name, overlay=False):
    path = OUT / name
    page.screenshot(path=str(path), full_page=not overlay, omit_background=overlay, animations='disabled')
    with Image.open(path) as png:
        assert png.width > 0 and png.height > 0
    REPORT['screenshots'].append(str(path))


def catalog_check(page):
    current = state(page)
    library = current['library']
    assert len(library) == 50
    assert sum(song['eligible'] is True for song in library) == 42
    assert all(isinstance(song['level'], int) for song in library)
    assert [[next(song for song in library if song['id'] == id_)['title'] for id_ in
             current['qualifier']['groups'][group]['songs']] for group in ['A', 'B']] == [
                 ['Secret Illumination', 'On And On!!', '白と黒のバケモノ'],
                 ['INFiNiTE ENERZY -Overdoze-', 'Stasis', 'Re：End of a Dream']]
    assert [(next(song for song in library if song['id'] == id_)['difficulty'],
             next(song for song in library if song['id'] == id_)['level']) for id_ in FINAL_IDS] == [('IN', 17), ('AT', 17)]
    result = page.evaluate('''async library=>{
      const results=[];
      for(let i=0;i<library.length;i+=4)results.push(...await Promise.all(library.slice(i,i+4).map(async song=>{
        const image=new Image();image.src='/'+song.art;
        await image.decode();
        return {id:song.id,path:song.art,width:image.naturalWidth,height:image.naturalHeight};
      })));
      return results;
    }''', library)
    assert len(result) == 50 and all(image['width'] == 2048 and image['height'] == 1080 for image in result)
    REPORT['catalog_images'] = result


def validate_motion(trace, label, require_final_entry=False, require_final_exit=False):
    assert trace['frames'], (label, 'No natural animation frames were observed')
    assert not trace['overlaps'], (label, 'Final cards overlap the top-layer logos', trace['overlaps'])
    for frame in trace['frames']:
        assert frame['same_plane'] and len(frame['logos']) == 3, (label, frame)
        for logo in frame['logos']:
            assert logo['connected'] and logo['complete'] and logo['opacity'] >= .999 and logo['z'] >= 1000, (label, logo)
    for record in trace['records']:
        assert record['duration'] == 560 and record['easing'].startswith('cubic-bezier'), (label, record)
        assert record['keyframes'][-1]['transform'] in (['translateX(-36px)'] if record['exit'] else ['translateX(0px)', 'none']), (label, record)
        assert record['keyframes'][0]['transform'] in (['translateX(0px)', 'none'] if record['exit'] else ['translateX(36px)']), (label, record)
    final_entries = [record for record in trace['records'] if record['entry'] and record['song'] in FINAL_IDS]
    if require_final_entry:
        assert len(final_entries) == 1, (label, 'The current final hero must animate alone', trace['records'])
    final_exits = [record for record in trace['records'] if record['exit'] and record['song'] in FINAL_IDS]
    if require_final_exit:
        assert len(final_exits) == 1, (label, 'The current final hero must leave smoothly', trace['records'])
    groups = {}
    for record in trace['records']:
        groups.setdefault((record['scene'], record['exit'], round(record['start']-record['order']*65, 2)), []).append(record)
    for records in groups.values():
        ordered = sorted(records, key=lambda record: record['order'])
        for left, right in zip(ordered, ordered[1:]):
            assert left['rect']['left'] <= right['rect']['left']+.5 and left['start'] <= right['start']+.5, (label, 'Elements must animate from the left-hand slot first', left, right)
    REPORT['motion'].append({'label': label, 'frames': len(trace['frames']), 'records': trace['records']})


def overlay_geometry(page, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    page.wait_for_function('''()=>Math.abs(document.querySelector('#canvas').getBoundingClientRect().width-
      Math.min(innerWidth/1920,innerHeight/1080)*1920)<.1''')
    result = page.evaluate('''()=>{
      const canvas=document.querySelector('#canvas'),stage=canvas.getBoundingClientRect();
      const rect=element=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};
      return {width:innerWidth,height:innerHeight,scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
        canvas:rect(canvas),cards:[...document.querySelectorAll('[data-final-song]')].map(card=>({
          id:card.dataset.finalSong,box:rect(card),image:rect(card.querySelector('img')),
          title:rect(card.querySelector('h2')),text:card.textContent,
          image_width:card.querySelector('img').naturalWidth,image_height:card.querySelector('img').naturalHeight})),
        logos:[...document.querySelectorAll('[data-motion-branding] .phigros-logo,[data-motion-branding] .club-logo')].map(logo=>({
          key:logo.dataset.motionKey,box:rect(logo),z:Number(getComputedStyle(logo).zIndex)})),
        head:[...document.querySelectorAll('.scene-head,.event-title,.topmeta')].map(element=>({text:element.textContent,box:rect(element)}))};
    }''')
    assert result['scroll'] <= width + 1, (width, height, 'Horizontal overflow', result)
    stage = result['canvas']
    assert abs(stage['w']/stage['h'] - 16/9) < .001
    assert stage['x'] >= -.5 and stage['y'] >= -.5 and stage['x']+stage['w'] <= width+.5 and stage['y']+stage['h'] <= height+.5
    assert len(result['cards']) == 1 and result['cards'][0]['id'] in FINAL_IDS
    elements = [(card['id'], card['box']) for card in result['cards']]
    elements += [(logo['key'], logo['box']) for logo in result['logos']]
    elements += [(element['text'], element['box']) for element in result['head']]
    for name, box in elements:
        assert box['x'] >= stage['x']-.5 and box['y'] >= stage['y']-.5 and box['x']+box['w'] <= stage['x']+stage['w']+.5 and box['y']+box['h'] <= stage['y']+stage['h']+.5, (width, height, name, 'Outside logical canvas')
    for i, (name, a) in enumerate(elements):
        for other_name, b in elements[i+1:]:
            overlap_w = min(a['x']+a['w'], b['x']+b['w'])-max(a['x'], b['x'])
            overlap_h = min(a['y']+a['h'], b['y']+b['h'])-max(a['y'], b['y'])
            assert overlap_w <= .5 or overlap_h <= .5, (width, height, name, other_name, 'Overlap', a, b)
    for card in result['cards']:
        assert (card['image_width'],card['image_height']) in [(1280,675),(2048,1080)]
        a,b=card['image'],card['title']
        assert min(a['x']+a['w'],b['x']+b['w'])-max(a['x'],b['x'])<=.5 or min(a['y']+a['h'],b['y']+b['h'])-max(a['y'],b['y'])<=.5, (card, 'Artwork overlaps song title')
    text = page.evaluate(TEXT_AUDIT)
    assert not text['overlaps'], (width, height, 'Rendered text overlap', text)
    result['text_fragments'] = text['text_fragments']
    REPORT['geometry'].append(result)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
        browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
            '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
        contexts = []

        def new_context(width=1194, height=834):
            context = browser.new_context(viewport={'width': width, 'height': height}, has_touch=True)
            context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
            contexts.append(context)
            return context

        with tempfile.TemporaryDirectory(prefix='acahku-fixed-final-legacy-') as legacy_dir:
            process, base = start_server(legacy_dir, 'legacy')
            try:
                legacy_context = new_context()
                crew = login(legacy_context, base)
                before = state(crew)
                assert len(before['library']) == 12 and 'competitionVersion' not in before['event']
                crew.click('.tabs [data-tab="event"]')
                crew.locator('#competition-preset-details').evaluate('element=>element.open=true')
                assert crew.locator('.preset-song-row').count() == 50
                revision = before['revision']
                crew.click('[data-apply-competition-config]')
                crew.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)
                after = state(crew)
                assert [{k:v for k,v in player.items() if k!='challengeTotal'} for player in after['qualifier']['players']] == before['qualifier']['players']
                assert all(player['challengeTotal'] is None for player in after['qualifier']['players'])
                catalog_check(crew)
                revision = after['revision']
                crew.fill('#event-message', 'Browser fixture: official songs retained after event edit.')
                crew.click('#event-form button[type="submit"]')
                crew.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)
                assert state(crew)['event']['competitionVersion'] == after['event']['competitionVersion']
                snapshot(crew, 'control-official-catalog-migration.png')
                check('an unscored legacy event adopts all 50 official charts through the real confirmed control button and retains them after editing event details')
                legacy_context.close()
            finally:
                stop_server(process)

        with tempfile.TemporaryDirectory(prefix='acahku-fixed-final-browser-') as data_dir:
            process, base = start_server(data_dir)
            try:
                control_context = new_context()
                crew = login(control_context, base)
                catalog_check(crew)
                check('a new event loads 42 DE, 6 qualifier and 2 fixed final charts with integer levels and decoded local jackets')
                command(crew, 'seed-bracket', {'ids': [f'p{i}' for i in range(1, 9)],
                                              'ruleset': 'proposal-2026', 'verified': True,
                                              'note': 'Browser fixture: arbitrator verified all eight seed slots.'})
                for match_id in REGULAR:
                    command(crew, 'select-match', {'matchId': match_id})
                    command(crew, 'draw-candidates')
                    match = next(item for item in state(crew)['tournament']['matches'] if item['id'] == match_id)
                    command(crew, 'ban-song', {'playerIndex': 0, 'songId': match['candidates'][0]['id']})
                    command(crew, 'ban-song', {'playerIndex': 1, 'songId': match['candidates'][1]['id']})
                    command(crew, 'pick-songs')
                    for player_index in range(2):
                        for song_index in range(2):
                            command(crew, 'set-match-score', {'playerIndex': player_index, 'songIndex': song_index,
                                'score': 990000 if player_index == 0 else 980000,
                                'judgements': {'accuracy': 99.1 if player_index == 0 else 98.1}})
                    command(crew, 'record-result', {'verified': True})
                command(crew, 'select-match', {'matchId': 'GF'})
                final = next(item for item in state(crew)['tournament']['matches'] if item['id'] == 'GF')
                assert final['finalMode'] == 'fixed-two'
                assert [song['id'] for song in final['songs']] == FINAL_IDS
                assert final['scores'] == [[None, None], [None, None]]
                assert final['candidates'] == [] and final['hostPick'] is None
                crew.click('.tabs [data-tab="songs"]')
                crew.wait_for_selector('.fixed-final-panel')
                assert crew.locator('.fixed-final-song').count() == 2
                assert crew.locator('#final-candidates-form,#final-picks-form,[data-reveal-host],[data-ban-player],[data-ban-pass]').count() == 0
                snapshot(crew, 'control-grand-final-fixed-songs.png')
                check('after 13 normal matches the final has exactly its two fixed songs and no candidate, ban, audience or MC controls')

                command(crew, 'set-scene', {'scene': 'song-selection'})
                live_context = new_context(1920, 1080)
                live = live_context.new_page()
                live.goto(base + '/overlay/live.html')
                live.wait_for_function('''()=>[...document.querySelectorAll('[data-motion-branding] img')].length===3&&
                  [...document.querySelectorAll('[data-motion-branding] img')].every(image=>image.complete&&image.naturalWidth>0)''')
                idle(live, 'song-selection')
                navigations = []
                live.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == live.main_frame else None)
                live.evaluate(MOTION_PROBE)
                revision = state(crew)['revision']
                crew.locator('[data-final-announcement-index="0"]').first.click()
                crew.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)
                idle(live, 'grand-final-announcement')
                trace = live.evaluate('window.__motionTrace.stop()')
                validate_motion(trace, 'fixed final announcement entrance', require_final_entry=True)
                live.wait_for_function('''()=>[...document.querySelectorAll('[data-final-song] img')].length===1&&
                  [...document.querySelectorAll('[data-final-song] img')].every(image=>image.complete&&[1280,2048].includes(image.naturalWidth))''')
                text = live.locator('#scene').inner_text()
                assert FINAL_TITLES[0] in text and FINAL_TITLES[1] not in text
                assert [''.join(value.split()) for value in live.locator('.final-song-difficulty').all_inner_texts()] == ['IN17']
                assert not any(word in text.upper() for word in ['SEALED', 'AUDIENCE', 'BAN', 'MC PICK'])
                for width, height in [(1920, 1080), (1280, 720), (1194, 834), (834, 1194)]:
                    overlay_geometry(live, width, height)
                    snapshot(live, f'grand-final-announcement-{width}x{height}.png', overlay=True)
                check('the separate final announcement initially reveals only Desultory Signals IN17 with decoded artwork and clear headings and logos at all four viewports')

                live.set_viewport_size({'width': 1920, 'height': 1080})
                live.evaluate(MOTION_PROBE)
                command(crew, 'set-scene', {'scene': 'bracket'})
                idle(live, 'bracket')
                validate_motion(live.evaluate('window.__motionTrace.stop()'), 'fixed final announcement exit', require_final_exit=True)
                live.evaluate(MOTION_PROBE)
                command(crew, 'set-scene', {'scene': 'grand-final-announcement'})
                live.wait_for_function('document.querySelector("#scene").dataset.motionPhase!=="idle"')
                command(crew, 'set-scene', {'scene': 'double-elimination-match'})
                command(crew, 'set-song-progress', {'index': 1})
                command(crew, 'set-scene', {'scene': 'grand-final-announcement'})
                command(crew, 'set-event', {'message': 'Browser fixture rapid update.'})
                idle(live, 'grand-final-announcement')
                validate_motion(live.evaluate('window.__motionTrace.stop()'), 'rapid scene and state updates')
                assert not navigations, navigations
                check('entrance, exit and rapid updates reuse the 560 ms nonlinear left-first animation without reloading or removing logos')

                command(crew, 'set-scene', {'scene': 'double-elimination-match'})
                score_context = new_context()
                scorer = login(score_context, base, 'scorekeeper')
                scorer.wait_for_selector('form[data-player-key]')
                assert scorer.locator('form[data-player-key]').count() == 2
                assert scorer.locator('input[data-score-key]').count() == 4
                assert scorer.locator('.tabs,iframe,[data-scene],[data-command]').count() == 0
                for width, height in [(1194, 834), (834, 1194)]:
                    scorer.set_viewport_size({'width': width, 'height': height})
                    assert scorer.evaluate('Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)<=innerWidth+1')
                    snapshot(scorer, f'grand-final-scorekeeper-{width}x{height}.png')
                for player_index, values in enumerate([[995123, 994321], [980111, 981222]]):
                    form = scorer.locator('form[data-player-key]').nth(player_index)
                    for song_index, value in enumerate(values):
                        form.locator(f'input[data-score-key][data-song-index="{song_index}"]').fill(str(value))
                    form.locator('button[data-save-player]').click()
                    crew.wait_for_function('''data=>window.__fixtureState.tournament.matches.find(match=>match.id==='GF').scores[data.player]
                      .every((score,index)=>score===data.values[index])''', arg={'player': player_index, 'values': values})
                    scorer.wait_for_function('''index=>!Array.from(document.querySelectorAll('form[data-player-key]'))[index]
                      .querySelector('input.is-dirty')''', arg=player_index)
                crew.click('.tabs [data-tab="bracket"]')
                assert crew.locator('.match-song-score').count() == 4
                assert crew.locator('.progress-buttons button').count() == 2
                crew.locator('#result-details').evaluate('element=>element.open=true')
                before = state(crew)['revision']
                crew.click('#result-form button[type="submit"]')
                crew.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=before)
                current = state(crew)
                assert current['result']['matchId'] == 'GF'
                assert current['result']['totals'] == [1989444, 1961333]
                public = control_context.request.get(base + '/api/state').json()
                assert public['tournament']['standings'][0]['placement'] == 'Champion'
                scorer.wait_for_function('document.querySelector("#match-notice").textContent.includes("已鎖定")')
                assert scorer.locator('input[data-score-key]:enabled').count() == 0
                idle(live, 'result')
                snapshot(live, 'grand-final-result.png', overlay=True)
                check('the scorekeeper saves both final songs per player and main control confirms the two-song total and champion')

                # A corrected final can legitimately tie and need an extra
                # song. Its selection view must not revive the legacy sealed
                # audience/MC flow merely because its match identifier is GF.
                command(crew, 'reopen-result', {'matchId': 'GF', 'affectedMatchIds': [],
                    'reason': 'Browser fixture: an arbiter corrected the original final scores.'})
                for player_index in range(2):
                    for song_index in range(2):
                        command(crew, 'set-match-score', {'playerIndex': player_index, 'songIndex': song_index,
                            'score': 990000, 'judgements': {'accuracy': 99}})
                command(crew, 'draw-match-tiebreak')
                command(crew, 'set-scene', {'scene': 'song-selection'})
                idle(live, 'song-selection')
                final = next(item for item in state(crew)['tournament']['matches'] if item['id'] == 'GF')
                assert final['finalMode'] == 'fixed-two' and [song['id'] for song in final['songs']] == FINAL_IDS
                assert len(final['tiebreaks']) == 1
                extra = final['tiebreaks'][0]['song']
                assert live.locator('.candidate-list .candidate').count() == 1
                assert extra['title'] in live.locator('.candidate-list').inner_text()
                assert live.locator('.selection-art img').count() == 1
                live.wait_for_function('''art=>{
                  const image=document.querySelector('.selection-art img');
                  return image?.complete&&[1280,2048].includes(image.naturalWidth)&&
                    new URL(image.src).pathname==='/'+art;
                }''', arg=json.loads((ROOT/'public/assets/display/manifest.json').read_text())['images'].get(extra['art'],{'path':extra['art']})['path'])
                assert live.locator('.selection-art img').get_attribute('alt') == extra['title']
                assert live.locator('.picks span').count() == 2
                labels = live.locator('.selection-state').inner_text().upper()
                assert 'TIEBREAK SONG' in labels
                assert not any(label in labels for label in ['AUDIENCE', 'MC', 'SEALED', 'BAN'])
                assert live.locator('.candidate-status').inner_text() == f"{extra['difficulty']} {extra['level']}"
                scorer.wait_for_function('document.querySelectorAll("input[data-score-key]").length===2')
                assert not navigations, navigations
                snapshot(live, 'grand-final-tiebreak-song-selection.png', overlay=True)
                check('a reopened tied fixed final shows one decoded tiebreak jacket without audience, MC, sealed or ban labels and preserves both base songs')
            except Exception as error:
                REPORT['result'] = 'FAIL'
                REPORT['failure'] = str(error)
                (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
                if 'crew' in locals() and not crew.is_closed():
                    snapshot(crew, 'failure-control.png')
                    (OUT / 'failure-state.json').write_text(json.dumps(state(crew), ensure_ascii=False, indent=2) + '\n')
                if 'live' in locals() and not live.is_closed():
                    snapshot(live, 'failure-overlay.png', overlay=True)
                raise
            finally:
                stop_server(process)
        assert not REPORT['browser_errors'], REPORT['browser_errors']
        REPORT['result'] = 'PASS'
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'result': REPORT['result'], 'checks': REPORT['checks'],
                          'browser_errors': REPORT['browser_errors'], 'report': str(OUT / 'report.json')}, ensure_ascii=False, indent=2))
        browser.close()


if __name__ == '__main__':
    main()
