"""Exercise the director's sequential console in a real Chromium browser.

Uses temporary tournaments and fixture-only pairing codes. No live event data
or credentials are opened. Requires Python Playwright and Chromium; screenshots
and the report go to BROADCAST_TEST_OUTPUT or test-results/production-console.
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
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'production-console'))
PIN = 'production-console-main-fixture'
REPORT = {'checks': [], 'geometry': [], 'browser_errors': [], 'screenshots': []}

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],fixture=process.argv[2],file=path.join(dir,'match-state.json');
if(!fs.existsSync(file)) {
  const state=require('./lib/default-state').createDefaultState();
  const Q=require('./public/js/qualifier-rules'),T=require('./lib/tournament');
  const act=(type,payload={})=>T.applyAction(state,{type,payload:
    T.CURRENT_MATCH_ACTIONS.has(type)?{matchId:state.tournament.currentMatchId,...payload}:payload});
  // Keep this visual/workflow regression independent of large media and music.
  state.library.forEach((song,i)=>{song.art='assets/song/cover-'+(i%6+1)+'.svg';song.previewAudio=''});
  act('set-competition-roster',{names:Array.from({length:fixture==='plan-a'?12:21},(_,i)=>'Director player '+String(i+1).padStart(2,'0'))});
  act('set-qualifier-plan',{plan:fixture==='plan-a'?'A':'B'});
  if(!['qualifier','tie','plan-a'].includes(fixture)) {
    for(const group of ['A','B'])for(const player of Q.entries(state,group))
      act('set-qualifier-total',{group,playerId:player.id,total:3000000-player.number*1000});
    act('qualify',{verified:true});
    if(fixture==='final') {
      for(const matchId of ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']) {
        act('select-match',{matchId});act('draw-candidates');
        const match=state.tournament.matches.find(item=>item.id===matchId);
        act('ban-song',{playerIndex:0,songId:match.candidates[0].id});
        act('ban-song',{playerIndex:1,songId:match.candidates[1].id});act('pick-songs');
        for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)
          act('set-match-score',{playerIndex:pi,songIndex:si,score:pi?970000:990000,
            judgements:{accuracy:pi?97:99,perfect:pi?970:990,good:pi?30:10,bad:0,miss:0}});
        act('record-result',{verified:true,note:'Fixture result verified.'});
      }
      act('select-match',{matchId:'GF'});
    }
    act('set-broadcast-cue',{stage:'double-elimination',scene:'double-elimination-waiting',matchId:state.tournament.currentMatchId,songIndex:0});
  } else {
    if(['tie','plan-a'].includes(fixture))for(const [index,player] of Q.entries(state,'A').entries())
      act('set-qualifier-total',{group:'A',playerId:player.id,total:fixture==='tie'&&index<5?2900000:2800000-player.number*1000});
    if(fixture==='tie')act('draw-qualifier-tiebreak',{group:'A',playerIds:Q.entries(state,'A').slice(0,5).map(player=>player.id)});
    act('set-broadcast-cue',{stage:'qualifier',scene:'qualifier-waiting',group:'A',songIndex:0,
      players:Q.entries(state,'A').slice(0,3).map(player=>player.id)});
    if(fixture==='plan-a')act('set-broadcast-cue',{stage:'qualifier',scene:'result',group:'A',songIndex:2,
      players:Q.entries(state,'A').slice(-3).map(player=>player.id)});
  }
  fs.writeFileSync(file,JSON.stringify(state));
}
const app=require('./server').createBroadcastServer({dataDir:dir,
  pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""

COMMANDS = r"""async () => {
  const token=sessionStorage.getItem('broadcast-token');
  const socket=io('/control',{forceNew:true,auth:{token}});
  await new Promise((resolve,reject)=>{socket.once('state',state=>{window.__fixtureState=state;resolve()});socket.once('connect_error',reject)});
  socket.on('state',state=>window.__fixtureState=state);
  window.__fixtureCommand=async(type,payload={})=>{
    const current=await fetch('/api/control-state',{headers:{Authorization:'Bearer '+token}}).then(response=>response.json());
    const result=await new Promise(resolve=>socket.emit('command',{expectedRevision:current.revision,action:{type,payload}},resolve));
    if(!result.ok)throw new Error(type+': '+result.error);
    return result;
  };
  window.__fixturePreview=document.querySelector('#program-preview');
}"""

MATCH_PROBE = r"""(() => {
  const probe=window.__challengeProbe={countdowns:[],media:[],navigations:0};
  const NativeAudio=window.Audio;
  window.Audio=function(...args){
    const audio=new NativeAudio(...args);probe.media.push(audio);
    const play=audio.play;
    audio.play=function(...args){
      if(probe.tracing&&audio.src.includes('/assets/bgm/'))probe.bgmPlays++;
      return play.apply(audio,args);
    };
    return audio;
  };
  window.Audio.prototype=NativeAudio.prototype;
  let factory;
  Object.defineProperty(window,'createBroadcastSocket',{configurable:true,get(){return factory},set(original){
    factory=(...args)=>{const socket=original(...args);socket.on('countdown',packet=>{
      if(packet?.cue)probe.countdowns.push(packet.cue.id);
    });return socket};
  }});
  window.__traceContinuousMatch=()=>{
    const mount=document.querySelector('#scene'),background=document.querySelector('.broadcast-backdrop');
    const mask=background.querySelector('#capture-mask'),holes=[...mask.querySelectorAll('[data-aperture-key]')];
    probe.tracing=true;probe.bgmPlays=0;probe.frames=[];
    function frame(){
      if(!probe.tracing)return;
      const current=[...document.querySelectorAll('[data-aperture-key]')];
      probe.frames.push({scene:document.querySelector('#canvas').dataset.renderedScene,
        sameBackground:document.querySelector('.broadcast-backdrop')===background,
        sameMask:document.querySelector('#capture-mask')===mask,
        open:current.length===holes.length&&current.every((hole,index)=>{
          const css=getComputedStyle(hole),matrix=new DOMMatrixReadOnly(css.transform==='none'?undefined:css.transform);
          return hole===holes[index]&&Number(css.opacity)===1&&matrix.isIdentity&&!hole.dataset.aperturePhase;
        }),countdown:!document.querySelector('.match-countdown').hidden,
        bgm:[...document.querySelectorAll('audio[data-scene-bgm],audio[data-scene-bgm-retiring]')].length});
      probe.frame=requestAnimationFrame(frame);
    }
    probe.frame=requestAnimationFrame(frame);
  };
  window.__stopContinuousMatch=()=>{
    probe.tracing=false;cancelAnimationFrame(probe.frame);
    return {frames:probe.frames,bgmPlays:probe.bgmPlays,countdowns:[...new Set(probe.countdowns)]};
  };
})();"""

GEOMETRY = r"""() => {
  const root=document.querySelector('#content');
  const visible=element=>element.checkVisibility({opacityProperty:true,visibilityProperty:true})&&element.getClientRects().length;
  const all=[...root.querySelectorAll('button,input,select,textarea,label,form,.production-workflow,.production-workflow section,.production-workflow article')].filter(visible);
  const rect=element=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};
  const boxes=all.map(element=>({id:element.id,tag:element.tagName,box:rect(element),
    text:(element.innerText||element.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,90),
    parents:all.flatMap((other,index)=>other!==element&&other.contains(element)?[index]:[])}));
  const ids=[...document.querySelectorAll('[id]')].map(element=>element.id);
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),texts=[];let node;
  while(node=walker.nextNode()){
    if(!node.textContent.trim()||node.parentElement.closest('script,style,svg,option,summary,button')||!visible(node.parentElement))continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const b of range.getClientRects())if(b.width>1&&b.height>1)texts.push({node,text:node.textContent.trim().slice(0,65),box:{x:b.x,y:b.y,w:b.width,h:b.height}});
  }
  const textOverlaps=[];
  for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
    const a=texts[i],b=texts[j];if(a.node===b.node)continue;
    const x=Math.min(a.box.x+a.box.w,b.box.x+b.box.w)-Math.max(a.box.x,b.box.x),
      y=Math.min(a.box.y+a.box.h,b.box.y+b.box.h)-Math.max(a.box.y,b.box.y);
    if(x>2&&y>2&&textOverlaps.length<12)textOverlaps.push({a:a.text,b:b.text,x,y});
  }
  return {width:innerWidth,height:innerHeight,scroll:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth),
    duplicateIds:ids.filter((id,index)=>ids.indexOf(id)!==index),boxes,textOverlaps};
}"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def start_server(data_dir, fixture):
    process = subprocess.Popen(['node', '-e', SERVER, data_dir, fixture], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        assert ready.select(timeout=15), 'Temporary production-console server did not start'
    port = process.stdout.readline().strip()
    if not port.isdigit():
        stdout, stderr = process.communicate(timeout=5)
        raise AssertionError('Temporary production-console server failed: ' + stderr + stdout)
    return process, 'http://127.0.0.1:' + port


def stop_server(process):
    if process is None:
        return
    process.terminate()
    try:
        process.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=8)


def login(browser, base):
    context = browser.new_context(viewport={'width': 1194, 'height': 834}, has_touch=True)
    context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
    page = context.new_page()
    page._production_dialog_handler = lambda dialog: dialog.accept()
    page.on('dialog', page._production_dialog_handler)
    page.goto(base + '/control/')
    page.fill('#pin', PIN)
    page.click('#pair-form button')
    page.wait_for_selector('#workspace:not([hidden])')
    page.wait_for_selector('.production-workflow')
    page.evaluate(COMMANDS)
    return context, page


def state(page):
    return page.evaluate("""()=>fetch('/api/control-state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')}}).then(response=>response.json())""")


def settled(page, revision):
    page.wait_for_function('revision=>window.__fixtureState.revision>=revision', arg=revision)
    page.wait_for_function("revision=>document.querySelector('#sync-status')?.textContent.endsWith('revision '+revision)", arg=revision)


def command(page, type_, payload=None):
    response = page.evaluate('data=>window.__fixtureCommand(data.type,data.payload)', {'type': type_, 'payload': payload or {}})
    settled(page, response['revision'])
    return response


def click_saved(page, selector):
    revision = state(page)['revision']
    page.locator(selector).click()
    page.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)
    settled(page, state(page)['revision'])
    assert_console(page)


def phase(page, value):
    page.wait_for_selector(f'.production-workflow[data-phase="{value}"]')
    assert_console(page)


def assert_console(page):
    assert page.locator('.tabs [data-tab="broadcast"]').get_attribute('aria-selected') == 'true'
    assert page.locator('#production-context').count() == 1
    assert page.evaluate('window.__fixturePreview===document.querySelector("#program-preview")'), 'Program iframe was replaced during a console update'


def next_step(page, next_phase):
    click_saved(page, '[data-production-next]')
    phase(page, next_phase)


def geometry(page, label):
    original = page.viewport_size
    page.wait_for_function("""()=>!document.querySelector('#content').getAnimations({subtree:true}).some(animation=>
      animation.effect?.getTiming().iterations!==Infinity&&(animation.playState==='running'||animation.pending))""")
    for width, height in [(1194, 834), (768, 1024), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(150)
        result = page.evaluate(GEOMETRY)
        result['name'] = f'{label}-{width}'
        REPORT['geometry'].append(result)
        path = OUT / (result['name'] + '.png')
        page.screenshot(path=str(path), full_page=True, animations='disabled')
        REPORT['screenshots'].append(str(path))
        assert not result['duplicateIds'], (label, width, 'Duplicate IDs', result['duplicateIds'])
        assert result['scroll'] <= width + 1, (label, width, 'Horizontal overflow', result['scroll'])
        assert not result['textOverlaps'], (label, width, 'Visible text overlaps', result['textOverlaps'])
        for index, a in enumerate(result['boxes']):
            box = a['box']
            assert box['w'] > 0 and box['h'] > 0, (label, a)
            assert box['x'] >= -1 and box['x'] + box['w'] <= width + 1, (label, width, 'Control outside viewport', a)
            # Parent/child fields intentionally share a box. Sibling controls,
            # their labels and separate score forms must occupy distinct space.
            for other_index, b in enumerate(result['boxes'][:index]):
                if other_index in a['parents'] or index in b['parents']:
                    continue
                if a['tag'] not in ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'FORM'] or b['tag'] not in ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'FORM']:
                    continue
                other = b['box']
                overlap_x = min(box['x'] + box['w'], other['x'] + other['w']) - max(box['x'], other['x'])
                overlap_y = min(box['y'] + box['h'], other['y'] + other['h']) - max(box['y'], other['y'])
                assert overlap_x <= 1 or overlap_y <= 1, (label, width, 'Controls overlap', a, b)
    page.set_viewport_size(original)


def save_q_stats(page, group, player_id, song, score):
    prefix = f'qstat-{group}-{player_id}-{song}'
    form = page.locator(f'form[data-score-editor="qd"][data-entity="{player_id}"][data-song-index="{song}"]')
    page.locator('#' + prefix).fill(str(score))
    for key, value in [('perfect', 980), ('good', 19), ('bad', 1), ('miss', 0)]:
        page.locator('#' + prefix + '-' + key).fill(str(value))
    click_saved(page, f'form[data-score-editor="qd"][data-entity="{player_id}"][data-song-index="{song}"] button[type="submit"]')
    row = state(page)['qualifier']['rounds'][group]['results'][player_id]
    assert row['songStats'][song] == {'score': score, 'perfect': 980, 'good': 19, 'bad': 1, 'miss': 0}
    assert row['challengeTotal'] is None, 'Display statistics changed the official Challenge Mode total'
    assert form.count() == 1


def match_idle(page):
    page.wait_for_function("""()=>{
      const canvas=document.querySelector('#canvas'),mount=document.querySelector('#scene');
      return canvas?.dataset.renderedScene==='qualifier-match'&&mount?.dataset.motionPhase==='idle'
        &&!document.querySelector('.match-countdown:not([hidden])')
        &&!mount.getAnimations({subtree:true}).some(animation=>animation.playState==='running'||animation.pending);
    }""")


def assert_open_capture_pixels(page, label):
    captures=page.locator('[data-capture]').all()
    assert len(captures)==6, (label, 'Three capture cards and three handcams must remain open')
    png=page.screenshot(omit_background=True)
    image=Image.open(io.BytesIO(png)).convert('RGBA')
    for capture in captures:
        box=capture.bounding_box()
        for x_fraction in [.15,.5,.85]:
            for y_fraction in [.15,.5,.85]:
                x=int(box['x']+box['width']*x_fraction)
                y=int(box['y']+box['height']*y_fraction)
                assert image.getpixel((x,y))[3]==0, (label,'Capture aperture flashed closed',x,y)


def exercise_qualifier(browser, base):
    context, page = login(browser, base)
    phase(page, 'waiting')
    current = state(page)
    players = current['qualifier']['activePlayers']
    assert len(players) == 3
    command(page, 'set-qualifier-display', {'group': 'A', 'players': [], 'currentSong': 0})
    assert page.locator('[data-production-next]').is_disabled(), 'An empty Challenge batch must not silently select the first three players'
    command(page, 'set-scene', {'scene': 'song-result'})
    phase(page, 'set-result')
    assert page.locator('.production-player-set-summary').count() == 0, 'An empty result must not display another batch’s scores'
    command(page, 'set-broadcast-cue', {'stage': 'qualifier', 'scene': 'qualifier-waiting', 'group': 'A', 'players': players, 'songIndex': 0})
    phase(page, 'waiting')
    check('empty Challenge batches keep their preparation disabled and never display another batch’s results')
    geometry(page, 'qualifier-waiting')
    command(page,'set-broadcast-display',{'showHandcams':True})
    next_step(page,'match')
    assert state(page)['qualifier']['currentSong']==0
    live=context.new_page()
    live.set_viewport_size({'width':1920,'height':1080})
    live.add_init_script(MATCH_PROBE)
    navigations=[]
    live.on('framenavigated',lambda frame:navigations.append(frame.url) if frame==live.main_frame else None)
    live.goto(base+'/overlay/live.html')
    match_idle(live)
    # The Challenge set gets one start cue only. Advancing songs must never
    # insert another full-screen cover, countdown, waiting scene, or BGM.
    page.locator('[data-start-countdown]').click()
    live.wait_for_selector('.match-countdown:not([hidden])')
    live.wait_for_selector('.match-countdown[hidden]',state='attached',timeout=10000)
    match_idle(live)
    first_countdowns=live.evaluate('[...new Set(__challengeProbe.countdowns)]')
    assert len(first_countdowns)==1
    live.evaluate('__traceContinuousMatch()')
    for song in range(3):
        current=state(page)
        assert current['scene']=='qualifier-match' and current['qualifier']['currentSong']==song
        assert page.locator('.production-challenge-progress [aria-current="step"]').get_attribute('data-song-index')==str(song)
        assert page.locator('form[data-score-editor="qd"],form[data-score-editor="qc"]').count()==0
        if song:
            countdown=page.locator('[data-start-countdown]')
            assert countdown.count()==0 or countdown.is_disabled(), 'A continuous Challenge song offered another countdown'
        geometry(page,'qualifier-continuous-song-'+str(song+1))
        assert_open_capture_pixels(live,'song-'+str(song+1)+'-settled')
        if song<2:
            next_step(page,'match')
            revision=state(page)['revision']
            live.wait_for_function('revision=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=revision',arg=revision)
            for delay in [0,80,180,350]:
                live.wait_for_timeout(delay)
                assert_open_capture_pixels(live,'song-'+str(song+2)+'-after-'+str(delay)+'ms')
    trace=live.evaluate('__stopContinuousMatch()')
    REPORT['continuous_match']=trace
    assert len(trace['frames'])>30
    assert all(frame['scene']=='qualifier-match' and frame['sameBackground'] and frame['sameMask'] and frame['open']
               and not frame['countdown'] and frame['bgm']==0 for frame in trace['frames']), trace
    assert trace['bgmPlays']==0 and trace['countdowns']==first_countdowns
    assert len(navigations)==1, 'Continuous songs navigated or reloaded the live overlay'
    check('three Challenge songs share stable transparent capture apertures, one countdown, no BGM, and one live page',len(trace['frames']))
    live.close()

    next_step(page,'set-result')
    assert state(page)['scene']=='song-result' and state(page)['qualifier']['currentSong']==2
    summaries=page.locator('.production-player-set-summary')
    assert summaries.count()==3
    assert page.locator('.production-player-set-summary [data-set-song-index]').count()==9
    assert page.locator('form[data-score-editor="qd"]').count()==9
    assert page.locator('form[data-score-editor="qc"]').count()==3
    geometry(page,'qualifier-three-song-summary')
    page.locator('.production-set-corrections').evaluate_all('details=>details.forEach(detail=>detail.open=true)')
    prefix=f'qstat-A-{players[0]}-0'
    page.locator('#'+prefix).fill('987654')
    command(page,'set-event',{'venue':'Unrelated update preserves director drafts'})
    assert page.input_value('#'+prefix)=='987654'
    revision=state(page)['revision']
    page.locator('[data-production-next]').click()
    page.wait_for_timeout(250)
    assert state(page)['revision']==revision, 'Next silently discarded an unfinished complete-sheet draft'
    phase(page,'set-result')
    check('unfinished three-song statistics survive unrelated updates and prevent an accidental ranking cue')
    for index,player_id in enumerate(players):
        for song in range(3):
            save_q_stats(page,'A',player_id,song,990000-index*1000-song*100)
        page.locator('#qtotal-'+player_id).fill(str(2990000-index*1000))
        click_saved(page,f'form[data-score-editor="qc"][data-entity="{player_id}"] button[type="submit"]')
        summary=page.locator(f'.production-player-set-summary[data-player-id="{player_id}"]')
        assert summary.locator('[data-challenge-total]').inner_text()==f'{2990000-index*1000:,}'
        for song in range(3):
            row=summary.locator(f'[data-set-song-index="{song}"]')
            assert row.locator('td').all_inner_texts()==[f'{990000-index*1000-song*100:,}','980','19','1','0']
    geometry(page,'qualifier-three-song-corrections')
    next_step(page,'ranking')
    assert page.locator('#production-rankings').count() == 1
    assert state(page)['scene'] == 'result'
    geometry(page, 'qualifier-ranking')
    check('Challenge progresses preparation → Song 1 → Song 2 → Song 3 → complete three-song statistics → ranking without leaving Broadcast', players)
    click_saved(page, '[data-production-batch]')
    phase(page, 'waiting')
    following = state(page)['qualifier']['activePlayers']
    assert len(following) == 3 and set(following).isdisjoint(players)
    assert state(page)['qualifier']['currentSong'] == 0
    # Review rankings again before choosing the next group. Neither action
    # requires leaving the director console or visiting qualifier settings.
    ranking = page.locator('[data-production-cue]').filter(has_text='目前晉級排名')
    revision = state(page)['revision']
    ranking.click()
    page.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)
    settled(page, state(page)['revision'])
    phase(page, 'ranking')
    click_saved(page, '[data-production-group="B"]')
    phase(page, 'waiting')
    current = state(page)
    assert current['qualifier']['activeGroup'] == 'B' and current['qualifier']['currentSong'] == 0
    assert set(current['qualifier']['activePlayers']).isdisjoint(players + following)
    check('next onstage batch and next qualifier group start at Song 1 from the same tab')
    page.reload()
    page.wait_for_selector('.production-workflow')
    page.evaluate(COMMANDS)
    phase(page, 'waiting')
    assert state(page)['qualifier']['activeGroup'] == 'B'
    check('refresh restores the server-backed qualifier cue and group')
    context.close()
    return current


def save_match_score(page, match_id, player, song, value):
    prefix = f'ms-{match_id}-{player}-{song}'
    page.locator('#' + prefix).fill(str(value))
    details = page.locator('#judgements-' + prefix)
    if details.get_attribute('open') is None:
        details.locator('summary').click()
    for key, number in [('accuracy', 99 - player), ('perfect', 990 - 10 * player), ('good', 10 + 10 * player), ('bad', 0), ('miss', 0)]:
        page.locator('#' + prefix + '-' + key).fill(str(number))
    click_saved(page, f'form[data-score-editor="m"][data-player-index="{player}"][data-song-index="{song}"] button[type="submit"]')


def exercise_concurrent_draft_and_qualification(browser, base):
    context, page = login(browser, base)
    current = state(page)
    group, players = current['qualifier']['activeGroup'], current['qualifier']['activePlayers']
    assert group == 'B'
    cue = {'stage': 'qualifier', 'scene': 'song-result', 'group': group, 'players': players, 'songIndex': 2}
    command(page, 'set-broadcast-cue', cue)
    phase(page,'set-result')
    player = players[0]
    prefix = f'qstat-{group}-{player}-0'
    page.locator(f'#production-set-corrections-{player}').evaluate('details=>details.open=true')
    page.locator('#' + prefix).fill('998765')
    for key, value in [('perfect', 998), ('good', 2), ('bad', 0), ('miss', 0)]:
        page.locator('#' + prefix + '-' + key).fill(str(value))
    next_players=current['qualifier']['rounds'][group]['playerIds'][3:6]
    assert set(next_players).isdisjoint(players)
    command(page, 'set-broadcast-cue', {**cue, 'players':next_players})
    drawer = page.locator('.production-draft-editors')
    assert drawer.count() == 1 and drawer.get_attribute('open') is not None
    assert drawer.locator('#' + prefix).input_value() == '998765'
    click_saved(page, f'.production-draft-editors form[data-score-editor="qd"][data-entity="{player}"] button[type="submit"]')
    current = state(page)
    assert current['qualifier']['activePlayers']==next_players and current['qualifier']['currentSong']==2 and current['scene']=='song-result'
    assert current['qualifier']['rounds'][group]['results'][player]['songStats'][0]['score'] == 998765
    assert page.locator('.production-draft-editors').count() == 0
    check('a concurrent batch change retains an editable prior complete-sheet draft without changing the live cue')

    player=next_players[0]
    page.locator(f'#production-set-corrections-{player}').evaluate('details=>details.open=true')
    discard_prefix = f'qstat-{group}-{player}-2'
    page.locator('#' + discard_prefix).fill('123456')
    revision = state(page)['revision']
    page.evaluate("""()=>{window.__productionConfirm=window.confirm;
      window.confirm=message=>{window.__discardPrompt=message;return false}}""")
    page.locator('[data-discard-drafts]').click()
    assert page.input_value('#' + discard_prefix) == '123456'
    assert '放棄所有' in page.evaluate('window.__discardPrompt')
    page.evaluate('window.confirm=window.__productionConfirm')
    page.locator('[data-discard-drafts]').click()
    page.wait_for_function('prefix=>document.getElementById(prefix).value===\'\'', arg=discard_prefix)
    assert page.input_value('#' + discard_prefix) == ''
    assert page.locator('.draft-notice').count() == 0
    assert state(page)['revision'] == revision
    check('discarding an unsaved draft requires an explicit confirmation and never changes saved scores')

    for qualifier_group in ['A', 'B']:
        current = state(page)
        for player_id in current['qualifier']['rounds'][qualifier_group]['playerIds']:
            entrant = next(item for item in current['qualifier']['players'] if item['id'] == player_id)
            command(page, 'set-qualifier-total', {'group': qualifier_group, 'playerId': player_id, 'total': 3000000 - entrant['number'] * 1000})
    current = state(page)
    command(page, 'set-broadcast-cue', {**cue, 'scene': 'result', 'songIndex': 2,
                                      'players': current['qualifier']['rounds']['B']['playerIds'][-3:]})
    phase(page, 'ranking')
    next_step(page, 'waiting')
    current = state(page)
    assert current['stage'] == 'double-elimination' and current['tournament']['seeded']
    assert current['scene'] == 'double-elimination-waiting' and current['tournament']['currentMatchId'] == 'W1'
    check('the final Plan B ranking confirms qualification and enters W1 waiting from the same console')
    context.close()


def exercise_tie_batch(browser, base):
    context, page = login(browser, base)
    current = state(page)
    tie = current['qualifier']['rounds']['A']['tiebreaks'][-1]
    assert len(tie['playerIds']) == 5
    choices = page.locator('.production-roster select').first.locator('option').evaluate_all('options=>options.map(option=>option.value).filter(Boolean)')
    assert set(choices) == set(tie['playerIds']), 'Untied entrants leaked into the onstage tie batches'
    first_batch = current['qualifier']['activePlayers']
    next_step(page, 'match')
    next_step(page, 'song-result')
    next_step(page, 'waiting')
    current = state(page)
    following = current['qualifier']['activePlayers']
    assert len(following) == 2 and set(first_batch).isdisjoint(following)
    assert set(first_batch + following) == set(tie['playerIds'])
    next_step(page, 'match')
    next_step(page, 'song-result')
    for index, player_id in enumerate(tie['playerIds']):
        command(page, 'set-qualifier-tiebreak-score', {'group': 'A', 'playerId': player_id, 'index': 0, 'score': 999000 - index * 1000})
    next_step(page, 'ranking')
    assert state(page)['qualifier']['rounds']['A']['tiebreaks'][-1]['confirmed']
    assert '下一組' in page.locator('[data-production-next]').inner_text(), 'A completed base round must not replay already scored batches after its tie'
    next_step(page, 'waiting')
    assert state(page)['qualifier']['activeGroup'] == 'B'
    check('a five-player qualifier tie advances only tied entrants, returns to ranking, and starts the next group without replaying completed batches')
    context.close()


def exercise_plan_a(browser, base):
    context, page = login(browser, base)
    phase(page, 'ranking')
    original = state(page)['qualifier']['rounds']['A']['results']
    next_step(page, 'waiting')
    current = state(page)
    assert current['qualifier']['activeGroup'] == 'B' and current['qualifier']['rounds']['A']['locked']
    assert current['qualifier']['rounds']['A']['results'] == original
    assert len(current['qualifier']['activePlayers']) == 3 and current['qualifier']['currentSong'] == 0
    assert all(result['challengeTotal'] is None for result in current['qualifier']['rounds']['B']['results'].values())
    check('Plan A verifies and preserves Round 1 before starting an independent revival round from the same console')
    context.close()


def exercise_elimination(browser, base):
    context, page = login(browser, base)
    phase(page, 'waiting')
    assert state(page)['tournament']['currentMatchId'] == 'W1'
    assert not state(page)['tournament']['matches'][0]['songs']
    next_step(page, 'selection')
    assert state(page)['scene'] == 'song-selection'
    if page.locator('[data-command="draw-candidates"]').count():
        click_saved(page, '[data-command="draw-candidates"]')
    match = state(page)['tournament']['matches'][0]
    assert len(match['candidates']) == 6
    click_saved(page, f'[data-ban-player="0"][data-ban-song="{match["candidates"][0]["id"]}"]')
    click_saved(page, f'[data-ban-player="1"][data-ban-song="{match["candidates"][1]["id"]}"]')
    click_saved(page, '[data-command="pick-songs"]')
    assert len(state(page)['tournament']['matches'][0]['songs']) == 2
    geometry(page, 'elimination-selection')
    next_step(page, 'waiting')
    for song in range(2):
        assert state(page)['tournament']['matches'][0]['currentSong'] == song
        next_step(page, 'match')
        assert state(page)['scene'] == 'double-elimination-match'
        next_step(page, 'song-result')
        assert page.locator('.production-stats form[data-score-editor="m"]').count() == 2
        for player in range(2):
            save_match_score(page, 'W1', player, song, 990000 - player * 10000 - song * 100)
        geometry(page, 'elimination-song-' + str(song + 1) + '-statistics')
        if song == 0:
            next_step(page, 'waiting')
    assert page.locator('#result-form').count() == 1
    page.locator('#result-note').fill('Director checked both original result screens.')
    click_saved(page, '#result-form button[type="submit"]')
    phase(page, 'round-result')
    current = state(page)
    assert current['result']['matchId'] == 'W1'
    assert current['tournament']['matches'][0]['status'] == 'complete'
    geometry(page, 'elimination-round-result')
    next_step(page, 'bracket')
    assert state(page)['scene'] == 'bracket'
    next_step(page, 'waiting')
    current = state(page)
    assert current['tournament']['currentMatchId'] == 'W2'
    assert current['scene'] == 'double-elimination-waiting'
    assert current['result']['matchId'] == 'W1', 'Advancing the director cue should preserve the confirmed result'
    check('W1 progresses waiting → six-candidate bans → two songs and statistics → confirmed result → bracket → W2')
    context.close()


def exercise_final(browser, base):
    context, page = login(browser, base)
    phase(page, 'waiting')
    match = next(item for item in state(page)['tournament']['matches'] if item['id'] == 'GF')
    assert match['finalMode'] == 'fixed-two' and len(match['songs']) == 2
    assert page.locator('[data-ban-song],[data-ban-pass],[data-command="draw-candidates"]').count() == 0
    revision = state(page)['revision']
    page.locator('[data-production-cue]').filter(has_text='公布總決賽曲目').click()
    page.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)
    settled(page, state(page)['revision'])
    phase(page, 'selection')
    assert state(page)['scene'] == 'grand-final-announcement'
    assert page.locator('[data-ban-song],[data-ban-pass],[data-command="draw-candidates"]').count() == 0
    assert 'Desultory Signals' in page.locator('#production-context').inner_text()
    assert 'Petrichor' in page.locator('#production-context').inner_text()
    geometry(page, 'fixed-final-announcement')
    next_step(page, 'waiting')
    assert next(item for item in state(page)['tournament']['matches'] if item['id'] == 'GF')['currentSong'] == 0
    check('fixed Grand Final announces its two songs directly and never exposes a ban step')
    context.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='acahku-production-console-') as temporary:
        with sync_playwright() as playwright:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            try:
                for fixture, exercise in [('qualifier', exercise_qualifier), ('elimination', exercise_elimination), ('final', exercise_final), ('tie', exercise_tie_batch), ('plan-a', exercise_plan_a)]:
                    data_dir = Path(temporary) / fixture
                    data_dir.mkdir()
                    process = None
                    try:
                        process, base = start_server(str(data_dir), fixture)
                        saved = exercise(browser, base)
                        if fixture == 'qualifier':
                            stop_server(process)
                            process, base = start_server(str(data_dir), fixture)
                            context, page = login(browser, base)
                            phase(page, 'waiting')
                            current = state(page)
                            assert current['qualifier']['activeGroup'] == saved['qualifier']['activeGroup']
                            assert current['qualifier']['activePlayers'] == saved['qualifier']['activePlayers']
                            assert current['qualifier']['currentSong'] == 0
                            check('server restart preserves the selected qualifier batch, song and waiting scene')
                            context.close()
                            exercise_concurrent_draft_and_qualification(browser, base)
                    finally:
                        stop_server(process)
                assert not REPORT['browser_errors'], REPORT['browser_errors']
                check('responsive console has no duplicate IDs, horizontal overflow, overlapping controls or browser errors', len(REPORT['geometry']))
            finally:
                browser.close()
                (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
