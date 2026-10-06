"""Check nonlinear same-scene motion and logo-only cross-scene transitions.

Run: python3 scripts/motion-regression.py [--scope bugs|smoke|painting|all]
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
import time
from urllib.parse import urlsplit

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent.parent
SCENES = ['start', 'qualifier-waiting', 'qualifier-match',
          'double-elimination-waiting', 'double-elimination-match',
          'result', 'bracket', 'song-selection']
PIN = 'motion-regression-fixture'
LOGOS = {'phigros-logo', 'phigros-wordmark', 'club-soc', 'club-kirameki'}
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
cmd('draw-candidates',{matchId:'W2'});m=s.store.state.tournament.matches.find(match=>match.id==='W2');
cmd('ban-song',{matchId:'W2',playerIndex:0,songId:m.candidates[0].id});
cmd('ban-song',{matchId:'W2',playerIndex:1,songId:m.candidates[1].id});
cmd('pick-songs',{matchId:'W2'});cmd('set-scene',{scene:'start'});
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
      animations:mount.getAnimations({subtree:true}).map(a=>({key:a.effect.target?.dataset.motionKey||a.effect.target?.dataset.motionFor,
        easing:a.effect.getTiming().easing,duration:a.effect.getTiming().duration,progress:a.effect.getComputedTiming().progress,
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
    # Register before the command, without racing the start of real movement.
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
      // The collision guard updates clips in RAF without changing the eased
      // geometry animation. Give it two frames after a manually scrubbed time.
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    }""", progress)


def finish_paused(page):
    page.evaluate(r"""()=>{
      for(const animation of window.__pausedMotion||[])
        if(animation.playState==='paused'||animation.playState==='running')animation.finish();
      window.__pausedMotion=[];
    }""")


def eased_progress(page, key):
    return page.evaluate(r"""key=>{
      const animation=window.__pausedMotion.find(a=>(a.effect.target?.dataset.motionKey||a.effect.target?.dataset.motionFor)===key);
      if(!animation)throw new Error('No paused motion for '+key);
      const timing=animation.effect.getTiming();
      if(!String(timing.easing).startsWith('cubic-bezier(')||timing.duration<2000||timing.duration>3000)
        throw new Error('Expected nonlinear 2–3s motion: '+JSON.stringify(timing));
      return animation.effect.getComputedTiming().progress;
    }""",key)


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
    parser.add_argument('--scope', choices=['bugs', 'smoke', 'painting', 'all'], default='all')
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
                    {expectedRevision:state.revision,action:{type,payload:{matchId:state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(new Error(r.error))));
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
                              window.__typographyScene=(html,scene)=>window.__typographyController.update(html,{scene:'typography',onCommit(){
                                canvas.dataset.renderedScene='typography';canvas.dataset.renderedRevision='0';}});
                            }""")

                            def short_prepare(html, target):
                                typography.emulate_media(reduced_motion='reduce')
                                typography.evaluate('a=>window.__typographyScene(a.html,a.scene)', {'html': html, 'scene': target})
                                typography.evaluate('document.fonts.ready'); idle(typography, 'typography')
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
                                    fraction=eased_progress(typography,'player-p1')
                                    expected = {axis: before['glyph'][axis] + (after['glyph'][axis] - before['glyph'][axis]) * fraction for axis in ['x', 'y']}
                                    errors_xy = {axis: abs(glyph[axis] - expected[axis]) for axis in ['x', 'y']}
                                    # Saira's fractional font-size metrics quantize
                                    # by about 1.26px, so use the scene suite's 2px
                                    # trajectory tolerance, with stricter endpoints.
                                    assert max(errors_xy.values()) < 2, ('Short glyph path does not follow easing', source, target, progress, errors_xy, glyph, expected)
                                    samples.append({'time_fraction': progress, 'eased_fraction': fraction, 'glyph_xy': {axis: glyph[axis] for axis in ['x', 'y']},
                                                    'expected_xy': expected, 'errors_xy': errors_xy})
                                endpoint = typography.evaluate(SNAPSHOT, 'player-p1')['glyph']
                                finish_paused(typography); idle(typography, 'typography')
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

                    def cross_scene_logos_only():
                        prepare('start');live.evaluate(TRACE);arm_phase(live,'move')
                        revision=scene('qualifier-waiting');assert pause_phase(live,'move')>0
                        assert live.locator('.waiting-copy').count()==1
                        assert int(live.locator('#canvas').get_attribute('data-rendered-revision'))>=revision
                        keys=live.evaluate("window.__pausedMotion.map(a=>a.effect.target.dataset.motionKey||a.effect.target.dataset.motionFor)")
                        assert set(keys)<=LOGOS and set(keys),('Unexpected cross-scene animated targets',keys)
                        before=live.evaluate(SNAPSHOT,'phigros-logo')['box']
                        # Non-logo content is already the destination and does not
                        # drift throughout the logo movement.
                        name=live.evaluate(SNAPSHOT,'player-p1')
                        samples=[]
                        for progress in [0,.1,.25,.5,.75,.9,.999999]:
                            at_progress(live,progress);fraction=eased_progress(live,'phigros-logo')
                            assert live.evaluate("document.querySelectorAll('[data-motion-ghost]').length")==0
                            compare_boxes(name['glyph'],live.evaluate(SNAPSHOT,'player-p1')['glyph'],'Cross-scene text remains still')
                            samples.append({'time_fraction':progress,'eased_fraction':fraction,'logo_box':live.evaluate(SNAPSHOT,'phigros-logo')['box']})
                        assert abs(samples[2]['eased_fraction']-.25)>.05 and abs(samples[4]['eased_fraction']-.75)>.05,samples
                        endpoint=samples[-1]['logo_box'];finish_paused(live);idle(live,'qualifier-waiting',revision)
                        compare_boxes(endpoint,live.evaluate(SNAPSHOT,'phigros-logo')['box'],'Logo endpoint')
                        trace=live.evaluate('window.__regressionTrace.stop()')
                        assert all(item['same'] for item in trace['identities']),trace['identities']
                        return {'animated_keys':keys,'samples':samples,'content_rendered_during_motion':True}

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

                    def same_scene_long_text():
                        # Reuse actual waiting/match HTML in one fixture scene.
                        # Actual cross-scene names swap immediately; this fixture
                        # still exercises the same-scene engine's clip guard.
                        layouts=[]
                        for target in ['qualifier-waiting','qualifier-match']:
                            prepare(target);layouts.append(live.locator('#scene').inner_html())
                        specimen=context.new_page()
                        try:
                            specimen.goto(base+'/api/health')
                            specimen.set_content(f"""<!doctype html><html><head><link rel='stylesheet' href='{base}/overlay/common.css'></head>
                              <body><main id='canvas' class='phi-app'><div id='scene'></div></main><script src='{base}/js/motion.js'></script></body></html>""")
                            specimen.evaluate(r"""()=>{
                              const canvas=document.querySelector('#canvas');
                              window.__clipController=BroadcastMotion.createScene(document.querySelector('#scene'),{canvas});
                              window.__clipScene=html=>window.__clipController.update(html,{scene:'clip',onCommit(){canvas.dataset.renderedScene='clip'}});
                            }""")
                            def mount(html):
                                specimen.emulate_media(reduced_motion='reduce');specimen.evaluate('html=>window.__clipScene(html)',html)
                                specimen.evaluate('document.fonts.ready');idle(specimen,'clip')
                                specimen.emulate_media(reduced_motion='no-preference')
                            observations=[]
                            for source,target in [(layouts[0],layouts[1]),(layouts[1],layouts[0])]:
                                mount(target);after=specimen.evaluate(SNAPSHOT,'player-p1')
                                mount(source);before=specimen.evaluate(SNAPSHOT,'player-p1')
                                arm_phase(specimen,'move');specimen.evaluate('html=>{window.__clipScene(html)}',target)
                                assert pause_phase(specimen,'move')>0
                                samples=[]
                                for progress in [0,.1,.25,.5,.75,.9,.999999]:
                                    at_progress(specimen,progress);fraction=eased_progress(specimen,'player-p1')
                                    name=specimen.evaluate(SNAPSHOT,'player-p1')
                                    allowed=before['visible']['width']+(after['visible']['width']-before['visible']['width'])*fraction
                                    assert name['ellipsis'] and name['floatBox'],('Long name loses clip during same-scene change',name)
                                    assert name['visible']['width']<=allowed+2,('Name escapes eased visible bounds',progress,fraction,allowed,name)
                                    others={key:specimen.evaluate(SNAPSHOT,key)['visible'] for key in ['player-p2','player-p3']}
                                    overlaps={key:intersection(name['visible'],rect) for key,rect in others.items()}
                                    assert all(rect['width']<=1 or rect['height']<=1 for rect in overlaps.values()),('Name overlaps other player',progress,overlaps)
                                    samples.append({'time_fraction':progress,'eased_fraction':fraction,'name':name['visible'],'intersections':overlaps})
                                    if progress==.5:specimen.screenshot(path=str(args.output/'long-text-moving.png'),omit_background=True)
                                endpoint=specimen.evaluate(SNAPSHOT,'player-p1');finish_paused(specimen);idle(specimen,'clip')
                                resting=specimen.evaluate(SNAPSHOT,'player-p1')
                                compare_boxes(endpoint['glyph'],resting['glyph'],'Same-scene glyph endpoint')
                                compare_boxes(endpoint['visible'],resting['visible'],'Same-scene clip endpoint')
                                observations.append({'samples':samples,'endpoint':resting['visible']})
                            specimen.screenshot(path=str(args.output/'long-text-idle.png'),omit_background=True)
                            return {'directions':observations}
                        finally:specimen.close()

                    def interrupt_and_reduce():
                        prepare('start')
                        live.evaluate("window.__sharedPlayer=document.querySelector('[data-motion-key=phigros-logo]')")
                        arm_phase(live,'move');scene('double-elimination-match')
                        assert pause_phase(live,'move')>0;at_progress(live,.35)
                        previous_time=live.evaluate("window.__pausedMotion.find(a=>a.effect.target.dataset.motionKey==='phigros-logo').currentTime")
                        sent_at=time.monotonic();revision=command('set-match-score',{'playerIndex':0,'songIndex':0,'score':999765})['revision']
                        live.wait_for_function('revision=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=revision',arg=revision,timeout=1000)
                        latency=(time.monotonic()-sent_at)*1000
                        assert latency<1000,('Latest score waits for previous animation',latency)
                        assert '999,765' in live.locator('.player-total').first.inner_text()
                        resumed_time=live.evaluate("document.querySelector('#scene').getAnimations({subtree:true}).find(a=>a.effect.target.dataset.motionKey==='phigros-logo').currentTime")
                        assert resumed_time>=previous_time-5,('Score restarted logo timeline',previous_time,resumed_time)
                        revision=crew.evaluate(r"""async()=>{
                          let result;for(const scene of ['start','bracket','qualifier-waiting'])
                            result=await window.__fixtureCommand('set-scene',{scene});return result.revision;
                        }""")
                        live.wait_for_function('revision=>window.__receivedOverlayRevision>=revision',arg=revision)
                        live.emulate_media(reduced_motion='reduce');idle(live,'qualifier-waiting',revision)
                        live.evaluate('async()=>{for(let i=0;i<3;i++)await new Promise(requestAnimationFrame)}')
                        result=live.evaluate(r"""()=>{
                          const node=document.querySelector('[data-motion-key=phigros-logo]'),mount=document.querySelector('#scene');
                          return {sameNode:node===window.__sharedPlayer,phase:mount.dataset.motionPhase,
                            temporaryNodes:mount.querySelectorAll('[data-motion-text],[data-motion-live],[data-motion-placeholder],[data-motion-ghost]').length,
                            runningAnimations:mount.getAnimations({subtree:true}).filter(a=>a.playState==='running'||a.pending).length,
                            maxWidth:node.style.getPropertyValue('max-width'),clipPath:node.style.getPropertyValue('clip-path')};
                        }""")
                        assert result=={'sameNode':True,'phase':'idle','temporaryNodes':0,'runningAnimations':0,'maxWidth':'','clipPath':''},result
                        return {**result,'score_delivery_ms':round(latency,2),'logo_time_before_ms':previous_time,'logo_time_after_ms':resumed_time}

                    def resize_during_motion():
                        prepare('start');arm_phase(live,'move');revision=scene('qualifier-waiting')
                        assert pause_phase(live,'move')>0;at_progress(live,.4)
                        scale(live,960,540);at_progress(live,.999999)
                        endpoint=live.evaluate(SNAPSHOT,'phigros-logo')['box']
                        finish_paused(live);idle(live,'qualifier-waiting',revision)
                        resting=live.evaluate(SNAPSHOT,'phigros-logo')['box']
                        return {'viewport':[960,540],'logical_endpoint_delta':compare_boxes(endpoint,resting,'Resized logo'),'resting_logical_box':resting}

                    def transparent_during_logo_motion():
                        observations=[]
                        for target in ['qualifier-match','double-elimination-match']:
                            for cameras in [False,True]:
                                prepare('start');command('set-broadcast-display',{'showHandcams':cameras});idle(live,'start')
                                arm_phase(live,'move');revision=scene(target);assert pause_phase(live,'move')>0
                                for progress in [0,.1,.25,.5,.75,.9,.999999]:
                                    at_progress(live,progress)
                                    image=Image.open(io.BytesIO(live.screenshot(omit_background=True))).convert('RGBA')
                                    for capture in live.locator('[data-capture]').all():
                                        box=capture.bounding_box()
                                        interior=(int(box['x'])+2,int(box['y'])+2,int(box['x']+box['width'])-2,int(box['y']+box['height'])-2)
                                        alpha=image.crop(interior).getchannel('A').getextrema()
                                        assert alpha==(0,0),('Moving logo occludes capture',target,cameras,progress,capture.get_attribute('data-capture'),box,alpha)
                                    observations.append({'scene':target,'dual':cameras,'time_fraction':progress,'transparent_slots':live.locator('[data-capture]').count()})
                                finish_paused(live);idle(live,target,revision)
                        return {'full_capture_interior_samples':observations}

                    check('short-glyph-eased-path',short_glyph_path)
                    check('cross-scene-logos-only',cross_scene_logos_only)
                    check('waiting-safe-area',waiting_safe_area)
                    check('same-scene-long-text',same_scene_long_text)
                    check('interrupt-and-reduce',interrupt_and_reduce)
                    check('motion-resize',resize_during_motion)
                    check('transparent-during-logo-motion',transparent_during_logo_motion)

                if args.scope in ['painting','all']:
                    def foreground_painting():
                        observations=[]
                        for source,target in [('start','qualifier-waiting'),('start','qualifier-match'),('qualifier-waiting','start')]:
                            prepare(source);arm_phase(live,'move');revision=scene(target)
                            assert pause_phase(live,'move')>0
                            for progress in [.25,.5,.75]:
                                at_progress(live,progress)
                                boxes=live.evaluate(r"""()=>{
                                  const selectors=['.event-title','.event-copy h1','.event-line','.organiser',
                                    '.waiting-copy h1','.waiting-players p','.player-name h2'];
                                  const canvas=document.querySelector('#canvas').getBoundingClientRect(),scale=canvas.width/1920;
                                  return selectors.flatMap(selector=>Array.from(document.querySelectorAll(selector)).flatMap(el=>{
                                    const range=document.createRange();range.selectNodeContents(el);
                                    return Array.from(range.getClientRects()).filter(rect=>rect.width>0&&rect.height>0).map(rect=>{
                                      let left=rect.left,right=rect.right,top=rect.top,bottom=rect.bottom;
                                      for(let parent=el;parent&&parent.id!=='canvas';parent=parent.parentElement){
                                        const style=getComputedStyle(parent),clip=parent.getBoundingClientRect();
                                        if(['hidden','clip','scroll','auto'].includes(style.overflowX)){left=Math.max(left,clip.left);right=Math.min(right,clip.right);}
                                        if(['hidden','clip','scroll','auto'].includes(style.overflowY)){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
                                      }
                                      return {selector,left:left-2*scale,top:top-2*scale,right:right+2*scale,bottom:bottom+2*scale};
                                    }).filter(rect=>rect.right>rect.left&&rect.bottom>rect.top);
                                  }));
                                }""")
                                assert boxes,('No foreground glyph areas',source,target)
                                assert live.locator('[data-motion-branding]').count()==1,'Separate branding layer missing'
                                shown=Image.open(io.BytesIO(live.screenshot(omit_background=True))).convert('RGBA')
                                # Floated images carry explicit visible styles;
                                # opacity hides the whole layer including children.
                                live.evaluate("document.querySelector('[data-motion-branding]').style.opacity='0'")
                                try:hidden=Image.open(io.BytesIO(live.screenshot(omit_background=True))).convert('RGBA')
                                finally:live.evaluate("document.querySelector('[data-motion-branding]').style.removeProperty('opacity')")
                                for box in boxes:
                                    crop=(max(0,int(box['left'])),max(0,int(box['top'])),min(shown.width,int(box['right'])),min(shown.height,int(box['bottom'])))
                                    difference=ImageChops.difference(shown.crop(crop),hidden.crop(crop))
                                    assert all(extrema==(0,0) for extrema in difference.getextrema()),('Logo alters foreground glyph area',source,target,progress,box,difference.getextrema())
                                observations.append({'source':source,'target':target,'time_fraction':progress,'unchanged_text_regions':len(boxes)})
                            finish_paused(live);idle(live,target,revision)
                        return {'pixel_comparisons':observations}
                    check('foreground-painting',foreground_painting)

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
                                    assert animation['easing'].startswith('cubic-bezier(') and 2000<=animation['duration']<=3000 and all(f['easing']=='linear' for f in animation['frames']),animation
                                    assert animation['key'] in LOGOS,('Non-logo cross-scene motion',animation)
                                    key = animation['key']
                                    descriptor = key + ('|figure' if key == 'event-art' else '|img') if key else ''
                                    progress = animation['progress']
                                    if key not in LOGOS or progress is None or not .15 < progress < .85:
                                        continue
                                    if not all(descriptor in d for d in [trace['before'], trace['after'], frame['keys']]):
                                        continue
                                    a, b, actual = trace['before'][descriptor], trace['after'][descriptor], frame['keys'][descriptor]
                                    for name in ['x', 'y', 'width', 'height']:
                                        expected = a[name] + (b[name] - a[name]) * progress
                                        assert abs(actual[name] - expected) < 2, (target, key, name, actual[name], expected)
                                    samples += 1
                        assert animations > 0 and samples > 0
                        return {'scene_transitions': 8, 'nonlinear_animation_observations': animations, 'eased_geometry_samples': samples}

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
