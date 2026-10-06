"""Reproduce text clipping, glyph-baseline and resize motion regressions.

Run: python3 scripts/motion-regression.py [--scope bugs|smoke|all]
Requires Playwright, Pillow and Chromium (CHROME_BINARY may override the binary).
Only a temporary event store is written. Reports/screenshots default to
/tmp/acahku-motion-regression; --output may select another directory.
--baseline-ref HEAD serves the three overlay assets from that Git revision
without editing the checkout, so a pre-fix revision must fail the bug assertions.
"""
import argparse
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
SCENES = ['start', 'qualifier-waiting', 'qualifier-match',
          'double-elimination-waiting', 'double-elimination-match',
          'result', 'bracket', 'song-selection']
PIN = 'motion-regression-fixture'
FIXTURE = r"""
const s=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'motion-regression-fixture'});
const cmd=(type,payload={})=>s.store.commit({type,payload},s.store.state.revision);
// Accepted input limits, kept entirely inside this throwaway store.
s.store.state.qualifier.players[0].name='W'.repeat(48);
s.store.state.library[0].title='長'.repeat(100);
s.store.write(s.store.state);
for(const player of s.store.state.qualifier.players)for(let i=0;i<3;i++)
 cmd('set-qualifier-score',{playerId:player.id,songIndex:i,score:990000-Number(player.id.slice(1))*1000-i*100});
cmd('qualify');let m=s.store.state.tournament.matches[0];
cmd('draw-candidates',{matchId:m.id});m=s.store.state.tournament.matches.find(match=>match.id===m.id);
cmd('ban-song',{matchId:m.id,playerIndex:0,songId:m.candidates[0].id});
cmd('ban-song',{matchId:m.id,playerIndex:1,songId:m.candidates[1].id});
cmd('pick-songs',{matchId:m.id});
for(let player=0;player<2;player++)for(let i=0;i<2;i++)
 cmd('set-match-score',{matchId:m.id,playerIndex:player,songIndex:i,score:player?980000:990000});
cmd('record-result',{matchId:m.id});cmd('select-match',{matchId:'W2'});
cmd('draw-candidates',{matchId:'W2'});cmd('set-scene',{scene:'start'});
s.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
"""

SNAPSHOT = r"""key=>{
  const el=document.querySelector(`[data-motion-key="${key}"]`);
  if(!el)throw new Error('Missing shared node: '+key);
  const canvas=document.querySelector('#canvas'), origin=canvas.getBoundingClientRect();
  const sx=origin.width/1920,sy=origin.height/1080;
  const box=r=>({x:(r.x-origin.x)/sx,y:(r.y-origin.y)/sy,
    width:r.width/sx,height:r.height/sy,right:(r.right-origin.x)/sx,bottom:(r.bottom-origin.y)/sy});
  const range=document.createRange();range.selectNodeContents(el);
  const glyph=el.localName==='span'?range.getBoundingClientRect():el.getBoundingClientRect();
  let left=glyph.left,right=glyph.right,top=glyph.top,bottom=glyph.bottom,ellipsis=false,clips=[];
  for(let parent=el;parent&&parent!==canvas.parentElement;parent=parent.parentElement){
    const css=getComputedStyle(parent),r=parent.getBoundingClientRect();
    if(css.display==='inline')continue;
    const clipX=['hidden','clip','scroll','auto'].includes(css.overflowX);
    const clipY=['hidden','clip','scroll','auto'].includes(css.overflowY);
    if(clipX){left=Math.max(left,r.left);right=Math.min(right,r.right);}
    if(clipY){top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}
    const inset=css.clipPath.match(/^inset\(([^)]+)\)$/);
    if(inset){
      const raw=inset[1].trim().split(/\s+/),v=raw.length===1?[raw[0],raw[0],raw[0],raw[0]]:
        raw.length===2?[raw[0],raw[1],raw[0],raw[1]]:raw.length===3?[raw[0],raw[1],raw[2],raw[1]]:raw;
      const pixels=(value,axis)=>value.endsWith('%')?parseFloat(value)*axis/100:parseFloat(value)*(axis===r.width?sx:sy);
      top=Math.max(top,r.top+pixels(v[0],r.height));right=Math.min(right,r.right-pixels(v[1],r.width));
      bottom=Math.min(bottom,r.bottom-pixels(v[2],r.height));left=Math.max(left,r.left+pixels(v[3],r.width));
    }
    if(clipX||clipY)clips.push({tag:parent.localName,className:parent.className,
      width:r.width/sx,height:r.height/sy,textOverflow:css.textOverflow});
    ellipsis||=clipX&&css.textOverflow==='ellipsis'&&css.whiteSpace==='nowrap';
  }
  const visible={x:(left-origin.x)/sx,y:(top-origin.y)/sy,
    width:Math.max(0,right-left)/sx,height:Math.max(0,bottom-top)/sy};
  const floated=el.closest('[data-motion-text]'),floatStyle=floated?getComputedStyle(floated):null;
  return {box:box(el.getBoundingClientRect()),glyph:box(glyph),visible,ellipsis,clips,
    floatBox:floated?box(floated.getBoundingClientRect()):null,
    floatStyle:floatStyle?{overflow:floatStyle.overflow,textOverflow:floatStyle.textOverflow,whiteSpace:floatStyle.whiteSpace}:null,
    fontSize:parseFloat(getComputedStyle(el).fontSize),lineHeight:getComputedStyle(el).lineHeight,
    phase:document.querySelector('#scene').dataset.motionPhase};
}"""

TRACE = r"""() => {
  const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
  const nodes=()=>Array.from(mount.querySelectorAll('[data-motion-key]')).filter(e=>!e.closest('[data-motion-ghost]'));
  const ids=new Map(nodes().map(e=>[e.dataset.motionKey+'|'+e.localName,e]));
  const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
  const describe=()=>Object.fromEntries(nodes().map(e=>[e.dataset.motionKey+'|'+e.localName,box(e)]));
  const trace={before:describe(),frames:[],active:true};
  const tick=()=>{
    if(!trace.active)return;
    trace.frames.push({phase:mount.dataset.motionPhase,keys:describe(),
      masks:document.querySelectorAll('[id="capture-mask"]').length,
      animations:mount.getAnimations({subtree:true}).map(a=>({key:a.effect.target?.dataset.motionKey,
        easing:a.effect.getTiming().easing,progress:a.effect.getComputedTiming().progress,
        frames:a.effect.getKeyframes().map(f=>({easing:f.easing}))}))});
    trace.raf=requestAnimationFrame(tick);
  };
  window.__regressionTrace=trace;trace.raf=requestAnimationFrame(tick);
  trace.stop=()=>{trace.active=false;cancelAnimationFrame(trace.raf);return {
    before:trace.before,after:describe(),frames:trace.frames,
    identities:nodes().filter(e=>ids.has(e.dataset.motionKey+'|'+e.localName))
      .map(e=>({key:e.dataset.motionKey,same:ids.get(e.dataset.motionKey+'|'+e.localName)===e}))};};
}"""


def idle(page, scene=None, revision=None):
    page.wait_for_function(r"""({scene,revision})=>{
      const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
      return mount?.dataset.motionPhase==='idle'&&(!scene||canvas.dataset.renderedScene===scene)
        &&(!scene||mount.dataset.motionScene===scene)
        &&(revision==null||Number(canvas.dataset.renderedRevision)>=revision)
        &&!mount.querySelector('[data-motion-ghost],[data-motion-live],[data-motion-placeholder]')
        &&!mount.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending);
    }""", arg={'scene': scene, 'revision': revision}, timeout=15000)


def scale(page, width=1920, height=1080):
    page.set_viewport_size({'width': width, 'height': height})
    page.wait_for_function('width=>Math.abs(document.querySelector("#canvas").getBoundingClientRect().width-width)<.1',
                           arg=width)


def arm_phase(page, phase):
    # Register before the command. Python/CDP must not race the actual 100ms
    # exit or 240ms move window, particularly while other browser suites run.
    page.evaluate(r"""phase=>{
      window.__motionPauseObserver?.disconnect();window.__phasePaused=null;
      const mount=document.querySelector('#scene');
      const pause=()=>{
        if(mount.dataset.motionPhase!==phase)return;
        const animations=mount.getAnimations({subtree:true});
        if(!animations.length)return;
        for(const animation of animations){animation.pause();animation.currentTime=0;}
        window.__pausedMotion=animations;window.__phasePaused=phase;
        window.__motionPauseObserver.disconnect();
      };
      window.__motionPauseObserver=new MutationObserver(pause);
      window.__motionPauseObserver.observe(mount,{attributes:true,attributeFilter:['data-motion-phase']});
      pause();
    }""", phase)


def pause_phase(page, phase):
    try:
        page.wait_for_function('phase=>window.__phasePaused===phase', arg=phase, timeout=15000)
    except Exception as error:
        snapshot = page.evaluate(r"""()=>({phase:document.querySelector('#scene').dataset.motionPhase,
          canvas:{...document.querySelector('#canvas').dataset},paused:window.__phasePaused,
          animations:document.querySelector('#scene').getAnimations({subtree:true}).map(a=>({state:a.playState,pending:a.pending}))})""")
        raise AssertionError(('Requested phase was not captured', phase, snapshot)) from error
    return page.evaluate('window.__pausedMotion.length')


def at_progress(page, progress):
    page.evaluate(r"""async progress=>{
      for(const animation of window.__pausedMotion)
        animation.currentTime=Number(animation.effect.getTiming().duration)*progress;
      // The collision guard updates clips in RAF without changing the linear
      // geometry animation. Give it two frames after a manually scrubbed time.
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    }""", progress)


def finish_paused(page):
    page.evaluate(r"""()=>{
      for(const animation of window.__pausedMotion||[])
        if(animation.playState==='paused'||animation.playState==='running')animation.finish();
      window.__pausedMotion=[];
    }""")


def compare_boxes(a, b, label, limit=1):
    delta = {name: abs(a[name] - b[name]) for name in ['x', 'y', 'width', 'height']}
    assert max(delta.values()) <= limit, (label, 'Endpoint jumps after restoring DOM', delta, a, b)
    return delta


def intersection(a, b):
    left, top = max(a['x'], b['x']), max(a['y'], b['y'])
    width = max(0, min(a['x'] + a['width'], b['x'] + b['width']) - left)
    height = max(0, min(a['y'] + a['height'], b['y'] + b['height']) - top)
    return {'x': left, 'y': top, 'width': width, 'height': height, 'area': width * height}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scope', choices=['bugs', 'smoke', 'all'], default='all')
    parser.add_argument('--output', type=Path, default=Path(tempfile.gettempdir()) / 'acahku-motion-regression')
    parser.add_argument('--baseline-ref', help='Serve pre-fix motion/overlay/CSS from this Git revision')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    assets, baseline_commit = {}, None
    if args.baseline_ref:
        baseline_commit = subprocess.check_output(['git', 'rev-parse', '--verify', args.baseline_ref + '^{commit}'], cwd=ROOT).decode().strip()
        for path in ['public/js/motion.js', 'public/js/overlay.js', 'public/overlay/common.css']:
            assets['/' + path.removeprefix('public/')] = subprocess.check_output(
                ['git', 'show', f'{baseline_commit}:{path}'], cwd=ROOT).decode()
    report = {'scope': args.scope, 'baseline_ref': args.baseline_ref, 'baseline_commit': baseline_commit,
              'checks': {}, 'failures': []}
    errors, requests = [], []
    with tempfile.TemporaryDirectory(prefix='acahku-motion-regression-') as data_dir:
        process = subprocess.Popen(['node', '-e', FIXTURE, data_dir], cwd=ROOT,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            port = process.stdout.readline().strip()
            if not port.isdigit():
                raise RuntimeError('Temporary fixture server failed: ' + process.stderr.read())
            base = 'http://127.0.0.1:' + port
            with sync_playwright() as p:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
                browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
                context = browser.new_context(viewport={'width': 1920, 'height': 1080})
                context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
                context.on('request', lambda request: requests.append(request.url))
                if assets:
                    def old_asset(route):
                        path = urlsplit(route.request.url).path
                        if path in assets:
                            route.fulfill(body=assets[path], content_type='text/css' if path.endswith('.css') else 'text/javascript')
                        else:
                            route.continue_()
                    context.route('**/*', old_asset)
                # Observe delivery before asking reduced motion to flush the
                # queue. This leaves the real Socket.IO instance/API intact.
                socket_source = (ROOT / 'public/js/socket.js').read_text() + r"""
                  const originalSocket=window.createBroadcastSocket;
                  window.createBroadcastSocket=function(...args){
                    const socket=originalSocket.apply(this,args);
                    if(args[0]==='/overlay')socket.on('state',state=>window.__receivedOverlayRevision=state.revision);
                    return socket;
                  };
                """
                context.route('**/js/socket.js', lambda route: route.fulfill(body=socket_source, content_type='text/javascript'))
                crew = context.new_page(); crew.goto(base + '/control/')
                token = context.request.post(base + '/api/session', data={'pin': PIN}).json()['token']
                crew.evaluate(r"""async token=>{
                  const socket=io('/control',{forceNew:true,auth:{token}});let state;
                  await new Promise((resolve,reject)=>{
                    socket.once('state',s=>{state=s;resolve()});socket.once('connect_error',reject);
                  });socket.on('state',s=>state=s);
                  window.__fixtureCommand=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',
                    {expectedRevision:state.revision,action:{type,payload}},r=>r.ok?resolve(r):reject(new Error(r.error))));
                }""", token)
                live = context.new_page(); live.goto(base + '/overlay/live.html')
                live.wait_for_selector('[data-branding="visual"]'); live.evaluate('document.fonts.ready'); idle(live, 'start')
                live.wait_for_function('Array.from(document.querySelectorAll("img")).every(i=>i.complete&&i.naturalWidth>0)')

                def command(type_, payload=None):
                    return crew.evaluate('a=>window.__fixtureCommand(a.type,a.payload)',
                                         {'type': type_, 'payload': payload or {}})

                def scene(target):
                    return command('set-scene', {'scene': target})['revision']

                def prepare(target):
                    live.emulate_media(reduced_motion='reduce'); scale(live)
                    revision = scene(target); idle(live, target, revision)
                    live.emulate_media(reduced_motion='no-preference')

                def check(name, callback):
                    try:
                        report['checks'][name] = {'result': 'PASS', **(callback() or {})}
                    except Exception as error:
                        message = str(error)
                        report['checks'][name] = {'result': 'FAIL', 'error': message}
                        report['failures'].append(name)
                        live.screenshot(path=str(args.output / (name + '-failure.png')), omit_background=True)
                        print(name + ': FAIL ' + message, flush=True)
                    finally:
                        # A failed endpoint assertion may leave manually paused
                        # animations. Restore them before running another check.
                        live.evaluate('window.__motionPauseObserver?.disconnect()'); finish_paused(live)
                        live.emulate_media(reduced_motion='reduce'); idle(live)
                        live.emulate_media(reduced_motion='no-preference')

                if args.scope in ['bugs', 'all']:
                    def short_glyph_path():
                        # Derive both layouts from the actual renderer/CSS, then
                        # substitute a short name only inside this isolated DOM.
                        # The tournament fixture and its 48-character test name
                        # stay unchanged; neither text wrapping nor a clip guard
                        # can conceal the normal-to-px line-height regression.
                        def markup():
                            return live.evaluate(r"""()=>{
                              const clone=document.querySelector('#scene').cloneNode(true);
                              const name=clone.querySelector('[data-motion-key=player-p1]');
                              if(!name)throw new Error('Actual scene lacks Player 01 shared node');
                              name.textContent='Player 01';return clone.innerHTML;
                            }""")

                        prepare('double-elimination-match'); prepare('result')
                        assert live.locator('.winner-panel [data-motion-key=player-p1]').count() == 1
                        result_html = markup()
                        prepare('qualifier-waiting'); waiting_html = markup()
                        typography = context.new_page()
                        try:
                            # Keep a local origin for font requests before replacing
                            # this page with the real styles and standalone engine.
                            typography.goto(base + '/api/health')
                            typography.set_content(f"""<!doctype html><html><head>
                              <link rel='stylesheet' href='{base}/overlay/common.css'>
                              </head><body><main id='canvas' class='phi-app'><div id='scene'></div></main>
                              <script src='{base}/js/motion.js'></script></body></html>""")
                            typography.evaluate(r"""()=>{
                              const canvas=document.querySelector('#canvas');
                              window.__typographyController=BroadcastMotion.createScene(document.querySelector('#scene'),{canvas});
                              window.__typographyScene=(html,scene)=>window.__typographyController.update(html,{scene,onCommit(){
                                canvas.dataset.renderedScene=scene;canvas.dataset.renderedRevision='0';}});
                            }""")

                            def short_prepare(html, target):
                                typography.emulate_media(reduced_motion='reduce')
                                typography.evaluate('a=>window.__typographyScene(a.html,a.scene)', {'html': html, 'scene': target})
                                typography.evaluate('document.fonts.ready'); idle(typography, target)
                                assert typography.locator('[data-motion-key=player-p1]').inner_text() == 'Player 01'
                                typography.emulate_media(reduced_motion='no-preference')

                            observations = []
                            for source, target, source_html, target_html in [
                                ('result', 'qualifier-waiting', result_html, waiting_html),
                                ('qualifier-waiting', 'result', waiting_html, result_html),
                            ]:
                                short_prepare(target_html, target); after = typography.evaluate(SNAPSHOT, 'player-p1')
                                short_prepare(source_html, source); before = typography.evaluate(SNAPSHOT, 'player-p1')
                                assert {before['fontSize'], after['fontSize']} == {90, 54}, (source, before, after)
                                typography.evaluate('window.__shortPlayer=document.querySelector("[data-motion-key=player-p1]")')
                                arm_phase(typography, 'move')
                                typography.evaluate('a=>{window.__typographyScene(a.html,a.scene);}', {'html': target_html, 'scene': target})
                                assert pause_phase(typography, 'move') > 0
                                samples = []
                                for progress in [0, .25, .5, .625, .75, .999999]:
                                    at_progress(typography, progress)
                                    glyph = typography.evaluate(SNAPSHOT, 'player-p1')['glyph']
                                    expected = {axis: before['glyph'][axis] + (after['glyph'][axis] - before['glyph'][axis]) * progress for axis in ['x', 'y']}
                                    errors_xy = {axis: abs(glyph[axis] - expected[axis]) for axis in ['x', 'y']}
                                    # Saira's fractional font-size metrics quantize
                                    # by about 1.26px, so use the scene suite's 2px
                                    # trajectory tolerance, with stricter endpoints.
                                    assert max(errors_xy.values()) < 2, ('Short glyph path is not linear', source, target, progress, errors_xy, glyph, expected)
                                    samples.append({'progress': progress, 'glyph_xy': {axis: glyph[axis] for axis in ['x', 'y']},
                                                    'expected_xy': expected, 'errors_xy': errors_xy})
                                endpoint = typography.evaluate(SNAPSHOT, 'player-p1')['glyph']
                                finish_paused(typography); idle(typography, target)
                                endpoint_delta = compare_boxes(endpoint, typography.evaluate(SNAPSHOT, 'player-p1')['glyph'], 'Short-name endpoint')
                                assert typography.evaluate('window.__shortPlayer===document.querySelector("[data-motion-key=player-p1]")')
                                observations.append({'source': source, 'target': target, 'before_font': before['fontSize'], 'after_font': after['fontSize'],
                                                     'before_line_height': before['lineHeight'], 'after_line_height': after['lineHeight'],
                                                     'maximum_glyph_xy_error': max(max(sample['errors_xy'].values()) for sample in samples),
                                                     'samples': samples, 'endpoint_delta': endpoint_delta})
                            return {'name': 'Player 01', 'directions': observations}
                        except Exception:
                            typography.screenshot(path=str(args.output / 'short-glyph-path-failure.png'), omit_background=True)
                            raise
                        finally:
                            typography.close()

                    def glyph_endpoint():
                        prepare('qualifier-waiting'); arm_phase(live, 'move'); revision = scene('qualifier-match')
                        assert pause_phase(live, 'move') > 0
                        at_progress(live, .999999)
                        endpoint = live.evaluate(SNAPSHOT, 'player-p2')
                        finish_paused(live); idle(live, 'qualifier-match', revision)
                        resting = live.evaluate(SNAPSHOT, 'player-p2')
                        return {'glyph_endpoint_delta': compare_boxes(endpoint['glyph'], resting['glyph'], 'Player 02 glyph')}

                    def waiting_safe_area():
                        prepare('qualifier-waiting')
                        geometry = live.evaluate(r"""()=>{
                          const copy=document.querySelector('.waiting-copy').getBoundingClientRect();
                          const canvas=document.querySelector('#canvas').getBoundingClientRect(),s=canvas.height/1080;
                          const title=document.querySelector('.waiting-song h2');
                          return {top:(copy.top-canvas.top)/s,bottom:(copy.bottom-canvas.top)/s,
                            songHeight:title.getBoundingClientRect().height/s,titleLength:title.textContent.length};
                        }""")
                        assert geometry['titleLength'] == 100, geometry
                        assert 0 <= geometry['top'] < geometry['bottom'] <= 1080, ('Waiting copy leaves 1080 canvas', geometry)
                        return geometry

                    def long_text_clipping():
                        prepare('qualifier-waiting')
                        source = live.evaluate(SNAPSHOT, 'player-p1')['visible']['width']
                        song_source = live.evaluate(SNAPSHOT, 'song-song-1')['visible']['width']
                        arm_phase(live, 'move')
                        revision = scene('qualifier-match'); assert pause_phase(live, 'move') > 0
                        targets = live.evaluate(r"""()=>({name:document.querySelector('.qualifier .player-1 h2').getBoundingClientRect().width,
                          song:document.querySelector('.song-band h2').getBoundingClientRect().width})""")
                        observations = []
                        for progress in [0, .25, .5, .75, .999999]:
                            at_progress(live, progress)
                            name = live.evaluate(SNAPSHOT, 'player-p1')
                            song = live.evaluate(SNAPSHOT, 'song-song-1')
                            allowed_name = source + (targets['name'] - source) * progress
                            assert name['visible']['width'] <= allowed_name + 2, ('Long name loses its animated clip', progress, allowed_name, name)
                            assert name['floatBox'] and name['floatBox']['width'] <= allowed_name + 2, ('Text float escapes its clip width', progress, name)
                            assert name['floatStyle'] == {'overflow': 'hidden', 'textOverflow': 'ellipsis', 'whiteSpace': 'nowrap'}, name
                            assert name['ellipsis'], ('Long name loses ellipsis during movement', progress, name)
                            assert song['visible']['width'] <= max(song_source, targets['song']) + 2, ('Long song loses its visible clip', progress, song)
                            others = {key: live.evaluate(SNAPSHOT, key)['visible'] for key in ['player-p2', 'player-p3']}
                            overlaps = {key: intersection(name['visible'], rect) for key, rect in others.items()}
                            assert all(rect['width'] <= 1 or rect['height'] <= 1 for rect in overlaps.values()), ('Long name covers another player', progress, overlaps)
                            observations.append({'progress': progress, 'name_visible_width': name['visible']['width'],
                                                 'name_allowed_width': allowed_name, 'name_float_width': name['floatBox']['width'],
                                                 'song_visible_width': song['visible']['width'],
                                                 'player_visible_rects': {'player-p1': name['visible'], **others},
                                                 'player_intersections': overlaps})
                            if progress == .5:
                                live.screenshot(path=str(args.output / 'long-text-moving.png'), omit_background=True)
                            if progress == .75:
                                live.screenshot(path=str(args.output / 'long-text-moving-75.png'), omit_background=True)
                        endpoint = live.evaluate(SNAPSHOT, 'player-p1')
                        finish_paused(live); idle(live, 'qualifier-match', revision)
                        resting = live.evaluate(SNAPSHOT, 'player-p1')
                        assert resting['ellipsis'] and resting['visible']['width'] <= targets['name'] + 1, resting
                        compare_boxes(endpoint['visible'], resting['visible'], 'Long name visible bounds')
                        live.screenshot(path=str(args.output / 'long-text-idle.png'), omit_background=True)
                        forward_width = resting['visible']['width']
                        # The same clipped node returns to a vertically stacked
                        # list. Check the path in both directions, not just idle.
                        source = forward_width; arm_phase(live, 'move'); revision = scene('qualifier-waiting')
                        assert pause_phase(live, 'move') > 0
                        target_width = live.locator('.waiting-players p').first.bounding_box()['width']
                        reverse = []
                        for progress in [0, .25, .5, .75, .999999]:
                            at_progress(live, progress)
                            name = live.evaluate(SNAPSHOT, 'player-p1')
                            allowed = source + (target_width - source) * progress
                            assert name['visible']['width'] <= allowed + 2 and name['ellipsis'], ('Reverse long-name clip', progress, name)
                            others = {key: live.evaluate(SNAPSHOT, key)['visible'] for key in ['player-p2', 'player-p3']}
                            overlaps = {key: intersection(name['visible'], rect) for key, rect in others.items()}
                            assert all(rect['width'] <= 1 or rect['height'] <= 1 for rect in overlaps.values()), ('Reverse long name covers another player', progress, overlaps)
                            reverse.append({'progress': progress, 'name_visible_width': name['visible']['width'],
                                            'player_visible_rects': {'player-p1': name['visible'], **others}, 'player_intersections': overlaps})
                            if progress == .75:
                                live.screenshot(path=str(args.output / 'long-text-reverse-75.png'), omit_background=True)
                        endpoint = live.evaluate(SNAPSHOT, 'player-p1')
                        finish_paused(live); idle(live, 'qualifier-waiting', revision)
                        compare_boxes(endpoint['visible'], live.evaluate(SNAPSHOT, 'player-p1')['visible'], 'Reverse long-name visible bounds')
                        return {'samples': observations, 'reverse_samples': reverse, 'resting_name_visible_width': forward_width}

                    def cancel_guard():
                        prepare('qualifier-waiting')
                        live.evaluate('window.__sharedPlayer=document.querySelector("[data-motion-key=player-p1]")')
                        arm_phase(live, 'move')
                        scene('qualifier-match'); assert pause_phase(live, 'move') > 0
                        at_progress(live, .75)
                        revision = crew.evaluate(r"""async()=>{
                          let result;for(const scene of ['start','bracket','qualifier-waiting'])
                            result=await window.__fixtureCommand('set-scene',{scene});return result.revision;
                        }""")
                        live.wait_for_function('revision=>window.__receivedOverlayRevision>=revision', arg=revision)
                        live.emulate_media(reduced_motion='reduce'); idle(live, 'qualifier-waiting', revision)
                        live.evaluate('async()=>{for(let i=0;i<3;i++)await new Promise(requestAnimationFrame)}')
                        result = live.evaluate(r"""()=>{
                          const node=document.querySelector('[data-motion-key=player-p1]'),mount=document.querySelector('#scene');
                          return {sameNode:node===window.__sharedPlayer,phase:mount.dataset.motionPhase,
                            temporaryNodes:mount.querySelectorAll('[data-motion-text],[data-motion-live],[data-motion-placeholder],[data-motion-ghost]').length,
                            runningAnimations:mount.getAnimations({subtree:true}).filter(a=>a.playState==='running'||a.pending).length,
                            maxWidth:node.style.getPropertyValue('max-width'),clipPath:node.style.getPropertyValue('clip-path')};
                        }""")
                        assert result == {'sameNode': True, 'phase': 'idle', 'temporaryNodes': 0, 'runningAnimations': 0,
                                          'maxWidth': '', 'clipPath': ''}, ('Cancelled guard leaves a stale node/style/layer', result)
                        return result

                    def resize_during_exit():
                        prepare('start'); arm_phase(live, 'exit'); revision = scene('qualifier-waiting')
                        assert pause_phase(live, 'exit') > 0
                        scale(live, 960, 540); arm_phase(live, 'move'); finish_paused(live)
                        assert pause_phase(live, 'move') > 0
                        at_progress(live, .999999)
                        endpoint = live.evaluate(SNAPSHOT, 'event-art')['box']
                        finish_paused(live); idle(live, 'qualifier-waiting', revision)
                        resting = live.evaluate(SNAPSHOT, 'event-art')['box']
                        return {'viewport': [960, 540], 'logical_endpoint_delta': compare_boxes(endpoint, resting, 'Resized event artwork'),
                                'resting_logical_box': resting}

                    check('short-glyph-linear-path', short_glyph_path)
                    check('glyph-baseline', glyph_endpoint)
                    check('waiting-safe-area', waiting_safe_area)
                    check('long-text-clipping', long_text_clipping)
                    check('guard-cancel-cleanup', cancel_guard)
                    check('exit-resize', resize_during_exit)

                if args.scope in ['smoke', 'all']:
                    def scene_smoke():
                        prepare('start'); samples = animations = 0
                        for target in SCENES[1:] + ['start']:
                            live.evaluate(TRACE); revision = scene(target); idle(live, target, revision)
                            trace = live.evaluate('window.__regressionTrace.stop()')
                            assert trace['frames'], ('No frames observed', target)
                            assert all(item['same'] for item in trace['identities']), ('Shared DOM was replaced', target, trace['identities'])
                            assert {'phigros-logo', 'club-soc', 'club-kirameki'} <= {item['key'] for item in trace['identities']}, target
                            for frame in trace['frames']:
                                assert frame['masks'] == 1, ('Duplicate capture mask', target, frame['masks'])
                                for animation in frame['animations']:
                                    animations += 1
                                    assert animation['easing'] == 'linear' and all(f['easing'] == 'linear' for f in animation['frames']), animation
                                    key = animation['key']
                                    descriptor = key + ('|figure' if key == 'event-art' else '|img') if key else ''
                                    progress = animation['progress']
                                    if key not in ['phigros-logo', 'club-soc', 'club-kirameki', 'event-art'] or progress is None or not .15 < progress < .85:
                                        continue
                                    if not all(descriptor in d for d in [trace['before'], trace['after'], frame['keys']]):
                                        continue
                                    a, b, actual = trace['before'][descriptor], trace['after'][descriptor], frame['keys'][descriptor]
                                    for name in ['x', 'y', 'width', 'height']:
                                        expected = a[name] + (b[name] - a[name]) * progress
                                        assert abs(actual[name] - expected) < 2, (target, key, name, actual[name], expected)
                                    samples += 1
                        assert animations > 0 and samples > 0
                        return {'scene_transitions': 8, 'linear_animation_observations': animations, 'linear_geometry_samples': samples}

                    def transparent_sources():
                        holes = context.new_page(); holes.emulate_media(reduced_motion='reduce'); samples = 0
                        try:
                            for target in ['qualifier-match', 'double-elimination-match']:
                                for cameras in [0, 1]:
                                    holes.goto(base + f'/overlay/{target}.html?fixed=1&cameras={cameras}')
                                    holes.wait_for_selector('[data-branding="visual"]'); idle(holes, target)
                                    for width, height in [(1920, 1080), (1280, 720), (960, 540)]:
                                        scale(holes, width, height)
                                        screenshot = Image.open(io.BytesIO(holes.screenshot(omit_background=True))).convert('RGBA')
                                        assert screenshot.getpixel((0, 0))[3] == 0
                                        expected = (3 if target == 'qualifier-match' else 2) * (1 + cameras)
                                        captures = holes.locator('[data-capture]').all()
                                        assert len(captures) == expected, (target, cameras, len(captures))
                                        for capture in captures:
                                            box = capture.bounding_box()
                                            for fx in [.1, .5, .9]:
                                                for fy in [.1, .5, .9]:
                                                    point = (int(box['x'] + box['width'] * fx), int(box['y'] + box['height'] * fy))
                                                    assert screenshot.getpixel(point)[3] == 0, (target, cameras, width, point)
                                                    samples += 1
                        finally:
                            holes.close()
                        return {'alpha_samples': samples, 'viewports': [[1920, 1080], [1280, 720], [960, 540]]}

                    check('eight-scene-smoke', scene_smoke)
                    check('transparent-captures', transparent_sources)

                external = [url for url in requests if urlsplit(url).hostname not in ['127.0.0.1', None]]
                if errors or external:
                    report['failures'].append('browser-runtime')
                report.update(browser_errors=errors, external_requests=external,
                              result='FAIL' if report['failures'] else 'PASS')
                name = 'baseline-report.json' if args.baseline_ref else 'report.json'
                (args.output / name).write_text(json.dumps(report, indent=2) + '\n')
                print(json.dumps(report, indent=2), flush=True)
                browser.close()
        finally:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
    return 1 if report['failures'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
