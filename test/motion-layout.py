"""Browser regression for scene motion and song-art replacement.

Requires Playwright, Pillow and Chromium. A scored temporary fixture is created
through tournament commands; the real event state and pairing files are unused.
MOTION_TEST_SCOPE=scenes|covers|all selects a focused suite (default: all).
BROADCAST_TEST_OUTPUT chooses the screenshot/report directory. Set
MOTION_RECORD_PREVIEW=1 to save an actual 720p Playwright recording as a WebM.
"""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results'))
OUT.mkdir(exist_ok=True, parents=True)
SCOPE = os.environ.get('MOTION_TEST_SCOPE', 'all')
assert SCOPE in ['scenes', 'covers', 'all']
SCENES = ['start', 'qualifier-waiting', 'double-elimination-waiting', 'qualifier-match',
          'double-elimination-match', 'result', 'bracket', 'song-selection']

PROBE = r"""() => {
  if (window.__motionProbe?.stop) window.__motionProbe.stop();
  const mount=document.querySelector('#scene'), canvas=document.querySelector('#canvas');
  const keyed=()=>Array.from(mount?.querySelectorAll('[data-motion-key]')||[]).filter(el=>!el.closest('[data-motion-ghost]'));
  const box=el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
  const visible=el=>{
    if(getComputedStyle(el).visibility!=='visible')return false;
    let opacity=1;
    for(let parent=el;parent;parent=parent.parentElement)opacity*=Number(getComputedStyle(parent).opacity);
    const b=el.getBoundingClientRect();return opacity>.01&&b.width>0&&b.height>0;
  };
  const descriptors=()=>Object.fromEntries(keyed().map(el=>[el.dataset.motionKey+'|'+el.localName,{box:box(el),fontSize:parseFloat(getComputedStyle(el).fontSize),visible:visible(el)}]));
  const beforeRefs=new Map(keyed().map(el=>[el.dataset.motionKey+'|'+el.localName,el]));
  const probe={frames:[],phases:[],commits:[],before:descriptors(),active:true};
  if(mount) {
    probe.phases.push(mount.dataset.motionPhase);
    probe.observer=new MutationObserver(records=>{
      for(const record of records) {
        if(record.target===mount&&record.attributeName==='data-motion-phase')probe.phases.push(record.oldValue);
        if(record.target===canvas&&record.attributeName==='data-rendered-scene')probe.commits.push(record.oldValue);
      }
    });
    probe.observer.observe(mount,{attributes:true,attributeOldValue:true,attributeFilter:['data-motion-phase']});
    probe.observer.observe(canvas,{attributes:true,attributeOldValue:true,attributeFilter:['data-rendered-scene']});
  }
  function frame() {
    if(!probe.active)return;
    const roots=mount?[mount]:Array.from(document.querySelectorAll('.cover-window'));
    const animations=roots.flatMap(root=>root.getAnimations({subtree:true})).filter(a=>a.playState==='running'||a.pending).map(a=>({
      key:a.effect.target?.dataset.motionKey||a.effect.target?.dataset.motionFor||'',easing:a.effect.getTiming().easing,
      progress:a.effect.getComputedTiming().progress,frames:a.effect.getKeyframes().map(f=>({easing:f.easing,transform:f.transform,opacity:f.opacity}))
    }));
    const ghosts=Array.from(mount?.querySelectorAll('[data-motion-ghost]')||[]).filter(visible).map(el=>el.dataset.motionGhost);
    const covers=Array.from(document.querySelectorAll('.selection-art,.cover-window')).map(el=>({
      phase:el.dataset.coverMotionPhase||'idle',images:Array.from(el.querySelectorAll('img')).map(i=>({src:i.getAttribute('src'),old:i.hasAttribute('data-motion-cover-old')}))
    }));
    probe.frames.push({phase:mount?.dataset.motionPhase||'control',scene:canvas?.dataset.renderedScene||'',
      keys:mount?descriptors():{},ghosts,animations,covers,maskCount:mount?document.querySelectorAll('[id="capture-mask"]').length:0});
    probe.raf=requestAnimationFrame(frame);
  }
  probe.stop=()=>{
    probe.active=false;cancelAnimationFrame(probe.raf);probe.observer?.disconnect();
    const after=mount?descriptors():{};
    const identities=mount?keyed().filter(el=>beforeRefs.has(el.dataset.motionKey+'|'+el.localName)).map(el=>({
      key:el.dataset.motionKey,tag:el.localName,same:beforeRefs.get(el.dataset.motionKey+'|'+el.localName)===el
    })):[];
    return {frames:probe.frames,phases:[...probe.phases,mount?.dataset.motionPhase||'control'],
      commits:[...probe.commits,canvas?.dataset.renderedScene||''],before:probe.before,after,identities};
  };
  window.__motionProbe=probe;probe.raf=requestAnimationFrame(frame);
}"""


def idle(page, scene=None, revision=None):
    try:
        page.wait_for_function('''({scene,revision}) => {
      const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
      return mount?.dataset.motionPhase==='idle'&&(!scene||canvas.dataset.renderedScene===scene)
        &&(!scene||mount.dataset.motionScene===scene)
        &&(revision==null||Number(canvas.dataset.renderedRevision)>=revision)
        &&!mount.querySelector('[data-motion-ghost],[data-motion-live],[data-motion-placeholder]')
        &&!mount.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending);
    }''', arg={'scene':scene,'revision':revision}, timeout=15000)
    except Exception:
        print(json.dumps(page.evaluate('''()=>({canvas:{...document.querySelector('#canvas')?.dataset},
          mount:{...document.querySelector('#scene')?.dataset},
          transient:Array.from(document.querySelectorAll('[data-motion-ghost],[data-motion-live],[data-motion-placeholder]')).map(e=>e.outerHTML.slice(0,200)),
          animations:document.querySelector('#scene')?.getAnimations({subtree:true}).map(a=>({state:a.playState,pending:a.pending,key:a.effect.target?.dataset.motionKey}))})'''),indent=2),flush=True)
        raise


def cover_idle(page, selector):
    page.wait_for_function('''selector=>{
      const el=document.querySelector(selector);return el&&el.querySelectorAll('img').length===1
        &&(!el.dataset.coverMotionPhase||el.dataset.coverMotionPhase==='idle')
        &&!el.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending);
    }''', arg=selector, timeout=10000)


def start_trace(page):
    page.evaluate(PROBE)


def stop_trace(page):
    return page.evaluate('window.__motionProbe.stop()')


def validate_trace(trace, label, scene_motion=True):
    assert trace['frames'], (label, 'No animation-frame observations')
    assert all(item['same'] for item in trace['identities']), (label, 'Shared DOM node was replaced', trace['identities'])
    if scene_motion:
        assert {'phigros-logo','club-soc','club-kirameki'} <= {item['key'] for item in trace['identities']}, (label,'Shared branding was not observed')
    observed_animations = 0
    for frame in trace['frames']:
        if scene_motion:
            assert frame['maskCount'] == 1, (label, 'Duplicated capture mask', frame['maskCount'])
            assert not ('exit' in frame['ghosts'] and 'enter' in frame['ghosts']), (label, 'Old and new blocks visible together')
        for animation in frame['animations']:
            observed_animations += 1
            assert animation['easing'] == 'linear', (label, animation)
            assert all(f['easing'] == 'linear' for f in animation['frames']), (label, animation)
        for cover in frame['covers']:
            assert len(cover['images']) <= 2, (label, 'More than two artwork layers', cover)
    if scene_motion:
        # A different key/tag identifies non-shared content. Ghosts carry the
        # old/new block pictures; original shared children retain their identity.
        old_only = set(trace['before']) - set(trace['after'])
        new_only = set(trace['after']) - set(trace['before'])
        for frame in trace['frames']:
            old_visible = 'exit' in frame['ghosts'] or any(frame['keys'].get(key, {}).get('visible') for key in old_only)
            new_visible = 'enter' in frame['ghosts'] or any(frame['keys'].get(key, {}).get('visible') for key in new_only)
            assert not (old_visible and new_visible), (label, 'Non-shared old and new content overlap', frame['phase'])
    return observed_animations


def validate_linear_paths(trace, label):
    count = 0
    for descriptor in set(trace['before']) & set(trace['after']):
        key, tag = descriptor.split('|')
        if key not in ['phigros-logo', 'club-soc', 'club-kirameki', 'event-art'] and not key.startswith(('player-','song-')):
            continue
        before, after = trace['before'][descriptor]['box'], trace['after'][descriptor]['box']
        if max(abs(before[name] - after[name]) for name in ['x', 'y', 'width', 'height']) < 2:
            continue
        for frame in trace['frames']:
            if descriptor not in frame['keys']:
                continue
            animation = next((a for a in frame['animations'] if a['key'] == key and a['progress'] is not None and .15 < a['progress'] < .85), None)
            if not animation:
                continue
            progress = animation['progress']
            actual = frame['keys'][descriptor]['box']
            for name in ['x', 'y', 'width', 'height']:
                expected = before[name] + (after[name] - before[name]) * progress
                assert abs(actual[name] - expected) < 2, (label, key, name, progress, actual[name], expected)
            if tag == 'span':
                before_font,after_font=trace['before'][descriptor]['fontSize'],trace['after'][descriptor]['fontSize']
                expected_font=before_font+(after_font-before_font)*progress
                assert abs(frame['keys'][descriptor]['fontSize']-expected_font)<.2,(label,key,'font size',progress)
            count += 1
    return count


def validate_cover_no_flashback(trace, latest_src):
    arrived = False
    for frame in trace['frames']:
        for cover in frame['covers']:
            current = next((image['src'] for image in cover['images'] if not image['old']), None)
            if current == latest_src:
                arrived = True
            if arrived:
                assert current == latest_src, ('Repeated state flashed an older bitmap', latest_src, current)
    assert arrived, ('No frame observed the requested bitmap', latest_src)


def directed_scene_walk():
    # Eulerian walk visits each ordered pair once, avoiding extra reset motions.
    adjacency = {scene: [other for other in SCENES if other != scene] for scene in SCENES}
    stack, path = ['start'], []
    while stack:
        if adjacency[stack[-1]]:
            stack.append(adjacency[stack[-1]].pop())
        else:
            path.append(stack.pop())
    walk = list(reversed(path))
    assert len(walk) == 57 and len(set(zip(walk, walk[1:]))) == 56
    return walk


with tempfile.TemporaryDirectory(prefix='acahku-motion-') as data_dir:
    code = """
const s=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'motion-fixture-code'});
const cmd=(type,payload={})=>s.store.commit({type,payload:{matchId:s.store.state.tournament.currentMatchId,...payload}},s.store.state.revision);
for(const player of s.store.state.qualifier.players)for(let i=0;i<3;i++)
 cmd('set-qualifier-score',{playerId:player.id,songIndex:i,score:990000-Number(player.id.slice(1))*1000-i*100});
cmd('qualify');cmd('draw-candidates');let m=s.store.state.tournament.matches[0];
cmd('ban-song',{playerIndex:0,songId:m.candidates[0].id});cmd('ban-song',{playerIndex:1,songId:m.candidates[1].id});cmd('pick-songs');
for(let player=0;player<2;player++)for(let i=0;i<2;i++)cmd('set-match-score',{playerIndex:player,songIndex:i,score:player?980000:990000});
cmd('record-result');cmd('select-match',{matchId:'W2'});cmd('draw-candidates');
// A reproducible pool with four distinct delivered local artworks. The live
// interaction still uses actual ban/pick/score commands in this temporary data.
s.store.state.tournament.matches.find(m=>m.id==='W2').candidates=s.store.state.library.slice(0,6).map(song=>({...song}));
cmd('set-scene',{scene:'start'});
s.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
"""
    process = subprocess.Popen(['node', '-e', code, data_dir], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        port = process.stdout.readline().strip()
        assert port.isdigit(), 'Temporary fixture server did not start'
        base = 'http://127.0.0.1:' + port
        with sync_playwright() as p:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1920, 'height': 1080})
            errors, requests = [], []
            context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
            context.on('request', lambda request: requests.append(request.url))
            crew = context.new_page(); crew.set_viewport_size({'width': 1194, 'height': 834})
            crew.on('dialog', lambda dialog: dialog.accept())
            crew.goto(base + '/control/')
            crew.fill('#pin', 'motion-fixture-code'); crew.click('#pair-form button')
            crew.wait_for_selector('#program-preview')
            crew.evaluate('''async()=>{
              const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});
              let state;await new Promise(resolve=>socket.once('state',s=>{state=s;resolve()}));
              socket.on('state',s=>state=s);
              window.__fixtureCommand=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',
                {expectedRevision:state.revision,action:{type,payload:{matchId:state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(new Error(r.error))));
            }''')

            def command(type_, payload=None):
                return crew.evaluate('(a)=>window.__fixtureCommand(a.type,a.payload)', {'type': type_, 'payload': payload or {}})

            def state():
                return context.request.get(base + '/api/state').json()

            def set_scene(scene):
                return command('set-scene', {'scene': scene})['revision']

            live = context.new_page(); live.goto(base + '/overlay/live.html')
            live.wait_for_selector('[data-branding="visual"]'); live.evaluate('document.fonts.ready'); idle(live, 'start')
            live.wait_for_function('Array.from(document.querySelectorAll("img")).every(i=>i.complete&&i.naturalWidth>0)')
            preview_frame = next(frame for frame in crew.frames if '/overlay/live.html' in frame.url)
            preview_navigations, live_navigations = [], []
            crew.on('framenavigated', lambda frame: preview_navigations.append(frame.url) if frame == preview_frame else None)
            live.on('framenavigated', lambda frame: live_navigations.append(frame.url) if frame == live.main_frame else None)
            crew.evaluate('document.querySelector("#program-preview").dataset.motionTestStable="yes"')
            report = {'scope': SCOPE, 'scene_pairs': 0, 'animation_frame_observations': 0,
                      'linear_animation_observations': 0, 'linear_geometry_samples': 0}

            def checked_cover_trace(trace,label,scene_motion=True):
                report['linear_animation_observations']+=validate_trace(trace,label,scene_motion)
                report['animation_frame_observations']+=len(trace['frames'])

            if SCOPE in ['scenes', 'all']:
                walk = directed_scene_walk()
                for before, target in zip(walk, walk[1:]):
                    start_trace(live); revision=set_scene(target); idle(live, target, revision)
                    trace = stop_trace(live)
                    label = before + ' → ' + target
                    report['linear_animation_observations'] += validate_trace(trace, label)
                    report['animation_frame_observations'] += len(trace['frames'])
                    report['linear_geometry_samples'] += validate_linear_paths(trace, label)
                    report['scene_pairs'] += 1
                assert report['scene_pairs'] == 56 and report['linear_geometry_samples'] > 0
                assert not preview_navigations and not live_navigations
                assert crew.evaluate('document.querySelector("#program-preview").dataset.motionTestStable') == 'yes'

                # Each requested scene arrives while the first transition is in
                # flight. Only that active transition and the newest pending one
                # may become visible; intermediate queued scenes are obsolete.
                start_trace(live); set_scene('qualifier-waiting')
                live.wait_for_function('document.querySelector("#scene").dataset.motionPhase!=="idle"')
                requested = ['bracket', 'song-selection', 'qualifier-match', 'result', 'double-elimination-match', 'start']
                revision=crew.evaluate('''async scenes=>{let result;for(const scene of scenes)result=await window.__fixtureCommand('set-scene',{scene});return result.revision}''', requested)
                idle(live, 'start', revision); trace = stop_trace(live)
                validate_trace(trace, 'rapid scene requests')
                commits = set(trace['commits']) - {None, ''}
                assert commits <= {'start', 'qualifier-waiting'}, ('Obsolete pending scene was shown', commits)
                report['rapid_latest_scene'] = True

            if SCOPE in ['covers', 'all']:
                revision=set_scene('song-selection'); idle(live, 'song-selection', revision)
                crew.click('.tabs [data-tab="songs"]'); crew.wait_for_selector('.song-preview-button')
                candidates = next(m for m in state()['tournament']['matches'] if m['id'] == 'W2')['candidates']
                forward = next(i for i in range(1, len(candidates)) if candidates[i]['art'] != candidates[0]['art'])
                direction_results = []
                for index, expected_sign in [(forward, 1), (0, -1)]:
                    start_trace(crew)
                    button = crew.locator(f'.song-preview-button[data-focus-song="{candidates[index]["id"]}"]')
                    button.focus(); crew.keyboard.press('Enter'); cover_idle(crew, '.cover-window')
                    trace = stop_trace(crew); checked_cover_trace(trace, 'keyboard cover direction', False)
                    transforms = [f['transform'] for frame in trace['frames'] for animation in frame['animations'] for f in animation['frames'] if f.get('transform')]
                    assert any(f'translateY({expected_sign * 100}%)' == transform for transform in transforms), (index, transforms)
                    assert crew.evaluate('document.activeElement.dataset.focusSong') == candidates[index]['id']
                    direction_results.append(expected_sign)

                start_trace(crew)
                indices = [forward, 0, len(candidates)-1, 1, forward, len(candidates)-1]
                crew.evaluate('''ids=>{for(const id of ids)document.querySelector(`.song-preview-button[data-focus-song="${id}"]`).click()}''', [candidates[i]['id'] for i in indices])
                cover_idle(crew, '.cover-window'); trace = stop_trace(crew)
                checked_cover_trace(trace, 'rapid control artwork', False)
                latest = candidates[indices[-1]]
                assert crew.locator('.cover-window img').get_attribute('src') == '../' + latest['art']
                assert latest['title'] in crew.locator('.song-focus-title h2').inner_text()

                # Repeated focus and state updates during a movement must reuse
                # the same artwork window and animations, including keyboard focus.
                crew.evaluate('''()=>{
                  window.__coverAnimate=Element.prototype.animate;window.__coverAnimationCalls=0;
                  Element.prototype.animate=function(...args){if(this.closest('.cover-window'))window.__coverAnimationCalls++;return window.__coverAnimate.apply(this,args)};
                  window.__coverWindow=document.querySelector('.cover-window');
                }''')
                start_trace(crew)
                button=crew.locator(f'.song-preview-button[data-focus-song="{candidates[0]["id"]}"]')
                button.focus();crew.keyboard.press('Enter')
                crew.wait_for_function('document.querySelector(".cover-window").dataset.coverMotionPhase==="move"')
                button.click();set_scene('song-selection');cover_idle(crew,'.cover-window')
                trace=stop_trace(crew);checked_cover_trace(trace,'control state during cover motion',False)
                validate_cover_no_flashback(trace,'../'+candidates[0]['art'])
                assert crew.evaluate('window.__coverWindow===document.querySelector(".cover-window")')
                assert crew.evaluate('window.__coverAnimationCalls')==2, 'Repeated state restarted the cover movement'
                assert crew.evaluate('document.activeElement.dataset.focusSong')==candidates[0]['id']
                crew.evaluate('()=>{Element.prototype.animate=window.__coverAnimate;}')

                start_trace(live)
                ban_indices = [i for i in range(len(candidates)) if candidates[i]['art'] != candidates[0]['art']]
                sequence = (ban_indices + [0] + ban_indices)[-6:]
                revision=crew.evaluate('''async ids=>{let result;for(const songId of ids)result=await window.__fixtureCommand('ban-song',{playerIndex:0,songId});return result.revision}''', [candidates[i]['id'] for i in sequence])
                idle(live, 'song-selection',revision); cover_idle(live, '.selection-art'); trace = stop_trace(live)
                checked_cover_trace(trace, 'rapid broadcast bans')
                latest = candidates[sequence[-1]]
                assert live.locator('.selection-art img').get_attribute('src') == '/' + latest['art']
                assert live.locator('.selection-detail h2').inner_text() == latest['title']
                # Delay real image decoding to exercise state arriving while a
                # requested artwork is still loading, with no external requests.
                live.evaluate('''()=>{window.__imageDecode=HTMLImageElement.prototype.decode;
                  HTMLImageElement.prototype.decode=function(){return window.__imageDecode.call(this).then(()=>new Promise(resolve=>setTimeout(resolve,150)))};}''')
                target=next(song for song in candidates if sum(c['art']==song['art'] for c in candidates)==1 and song['art']!=latest['art'])
                start_trace(live);command('ban-song',{'playerIndex':0,'songId':target['id']})
                live.wait_for_function('document.querySelector(".selection-art").dataset.coverMotionPhase==="loading"')
                revision=set_scene('song-selection');idle(live,'song-selection',revision);cover_idle(live,'.selection-art')
                trace=stop_trace(live);checked_cover_trace(trace,'duplicate state during artwork decoding')
                validate_cover_no_flashback(trace,'/'+target['art'])
                live.evaluate('()=>{HTMLImageElement.prototype.decode=window.__imageDecode;}')
                banned = target['id']
                other = next(c for c in candidates if c['id'] != banned)
                command('ban-song', {'playerIndex': 1, 'songId': other['id']})
                start_trace(live);command('pick-songs')
                live.wait_for_function('document.querySelector(".selection-art").dataset.coverMotionPhase==="move"')
                revision=command('set-match-score',{'playerIndex':0,'songIndex':0,'score':999100})['revision']
                idle(live,'song-selection',revision);cover_idle(live,'.selection-art');trace=stop_trace(live)
                checked_cover_trace(trace,'score update during artwork movement')
                latest=next(m for m in state()['tournament']['matches'] if m['id']=='W2')['songs'][0]
                validate_cover_no_flashback(trace,'/'+latest['art'])
                assert live.locator('.selection-detail h2').inner_text()==latest['title']
                start_trace(live)
                revision=crew.evaluate('''async()=>{let result;for(const index of [1,0,1,0,1])result=await window.__fixtureCommand('set-song-progress',{index});return result.revision}''')
                idle(live, 'song-selection',revision); cover_idle(live, '.selection-art'); trace = stop_trace(live)
                checked_cover_trace(trace, 'rapid current-song changes')
                latest = next(m for m in state()['tournament']['matches'] if m['id'] == 'W2')['songs'][1]
                assert live.locator('.selection-art img').get_attribute('src') == '/' + latest['art']
                assert live.locator('.selection-detail h2').inner_text() == latest['title']
                revision=set_scene('double-elimination-match'); idle(live, 'double-elimination-match',revision)
                start_trace(live); revision=command('set-match-score', {'playerIndex': 0, 'songIndex': 0, 'score': 999201})['revision']; idle(live, 'double-elimination-match',revision)
                trace = stop_trace(live); checked_cover_trace(trace, 'same-scene score update')
                assert not ({'exit', 'enter'} & set(trace['phases'])), 'A score update caused a whole-scene exit/enter'
                assert '999,201' in live.locator('.player-total').first.inner_text()
                report.update(cover_directions=direction_results, rapid_cover_latest=True,
                              keyboard_focus_retained=True, maximum_cover_layers=2,
                              duplicate_state_during_decode=True,score_during_cover_motion=True,
                              control_cover_identity=True,duplicate_cover_motion_not_restarted=True)

            # Reduced motion bypasses transitions and clears any active ghosts.
            live.emulate_media(reduced_motion='reduce'); crew.emulate_media(reduced_motion='reduce')
            set_scene('qualifier-waiting'); idle(live, 'qualifier-waiting')
            start_trace(live); set_scene('start'); idle(live, 'start'); trace = stop_trace(live)
            assert not any(frame['animations'] or frame['ghosts'] for frame in trace['frames'])
            assert not ({'exit', 'move', 'enter'} & set(trace['phases'])), trace['phases']
            report['reduced_motion_immediate'] = True

            # The same source holes remain transparent after movement at every
            # supported broadcast scale, including both handcam variants.
            holes = context.new_page(); holes.emulate_media(reduced_motion='reduce')
            samples = 0
            for scene in ['qualifier-match', 'double-elimination-match']:
                for cameras in [0, 1]:
                    holes.goto(base + f'/overlay/{scene}.html?fixed=1&cameras={cameras}')
                    holes.wait_for_selector('[data-branding="visual"]'); idle(holes, scene)
                    for width, height in [(1920,1080),(1280,720),(960,540)]:
                        holes.set_viewport_size({'width':width,'height':height})
                        holes.wait_for_function('(width)=>Math.abs(document.querySelector("#canvas").getBoundingClientRect().width-width)<.1', arg=width)
                        image = Image.open(io.BytesIO(holes.screenshot(omit_background=True))).convert('RGBA')
                        assert image.getpixel((0,0))[3] == 0
                        for capture in holes.locator('[data-capture]').all():
                            box = capture.bounding_box()
                            for fx in [.1,.5,.9]:
                                for fy in [.1,.5,.9]:
                                    point = (int(box['x']+box['width']*fx),int(box['y']+box['height']*fy))
                                    assert image.getpixel(point)[3] == 0, (scene,cameras,width,point)
                                    samples += 1
            report['scaled_transparent_samples'] = samples
            if os.environ.get('MOTION_RECORD_PREVIEW') == '1':
                video_context = browser.new_context(viewport={'width':1280,'height':720},
                                                    record_video_dir=str(OUT/'motion-video-raw'),
                                                    record_video_size={'width':1280,'height':720})
                video = video_context.new_page(); video.goto(base+'/overlay/live.html')
                video.wait_for_selector('[data-branding="visual"]'); idle(video)
                for scene in ['start','qualifier-waiting','qualifier-match','double-elimination-waiting','double-elimination-match','bracket','song-selection','start']:
                    set_scene(scene); idle(video,scene)
                    video.wait_for_timeout(200)
                recording = video.video
                video_context.close()
                shutil.copy2(recording.path(), OUT/'motion-preview.webm')
                report['actual_video'] = str(OUT/'motion-preview.webm')
            assert not errors, errors
            external = [url for url in requests if urlsplit(url).hostname not in ['127.0.0.1',None]]
            assert not external, external
            report.update(result='PASS', browser_errors=errors, external_requests=0)
            (OUT/f'motion-layout-{SCOPE}-report.json').write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report,indent=2))
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()
