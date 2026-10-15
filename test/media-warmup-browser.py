"""Optional Chromium regression and cold-load observations for broadcast media.

Requires Python Playwright, Pillow and Chromium. All event state and pairing
codes are fixtures in temporary directories. Never opens production event data.
Runs the optimized build by default; --baseline serves the pre-change frontend
files through browser routes for the same fixtures. Frame gaps are observations,
not performance thresholds for the user's OBS hardware. Local reports/screenshots
are written to BROADCAST_TEST_OUTPUT or ignored test-results/media-warmup.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'media-warmup'))
spec = importlib.util.spec_from_file_location('warmup_helpers', ROOT / 'test/fixed-final-browser.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],state=require('./lib/default-state').createDefaultState();
const act=(type,payload={})=>require('./lib/tournament').applyAction(state,{type,payload:{matchId:state.tournament.currentMatchId,...payload}});
act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026',verified:true});
act('set-scene',{scene:'start'});
fs.writeFileSync(path.join(dir,'match-state.json'),JSON.stringify(state));
const broadcast=require('./server').createBroadcastServer({dataDir:dir,pin:'fixed-final-main-fixture',scorekeeperPin:'fixed-final-score-fixture'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""

PROBE = r"""(() => {
  const probe=window.__warmupProbe={statuses:[],decodes:[],commits:[],frames:[],media:[]};
  let lastFrame;
  function frame(time){if(lastFrame)probe.frames.push(time-lastFrame);lastFrame=time;requestAnimationFrame(frame)}
  requestAnimationFrame(frame);
  const nativeDecode=HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode=function(...args){
    const src=this.src,started=performance.now();
    return nativeDecode.apply(this,args).then(result=>{probe.decodes.push({src,ok:true,started,finished:performance.now()});return result},error=>{
      probe.decodes.push({src,ok:false,started,finished:performance.now()});throw error});
  };
  const NativeAudio=window.Audio;
  window.Audio=function(...args){const audio=new NativeAudio(...args);probe.media.push(audio);return audio};
  window.Audio.prototype=NativeAudio.prototype;
  let warmupApi;
  Object.defineProperty(window,'BroadcastMediaWarmup',{configurable:true,get(){return warmupApi},set(api){
    const create=api.createController;
    api.createController=options=>{
      const original=options?.onStatus;
      const controller=create({...options,onStatus(status){probe.statuses.push({...status,at:performance.now()});original?.(status)}});
      window.__fixtureWarmup=controller;return controller;
    };warmupApi=api;
  }});
  let motionApi;
  Object.defineProperty(window,'BroadcastMotion',{configurable:true,get(){return motionApi},set(api){
    const create=api.createScene;
    api.createScene=(...args)=>{
      const controller=create(...args),update=controller.update;
      controller.update=(html,options={})=>update(html,{...options,onCommit(info){
        probe.commits.push({at:performance.now(),scene:options.scene,fonts:document.fonts.status,
          warmup:window.__fixtureWarmup?.status(),saira:[400,500,600,700].map(weight=>document.fonts.check(weight+' 32px Saira'))});
        options.onCommit?.(info);
      }});return controller;
    };motionApi=api;
  }});
})();"""


def start_server(directory):
    process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=15):
            helper.stop_server(process)
            raise AssertionError('Temporary warmup fixture server did not start')
    port = process.stdout.readline().strip()
    assert port.isdigit(), 'Temporary fixture server did not report its port'
    return process, 'http://127.0.0.1:' + port


def resources(page):
    return page.evaluate('''()=>performance.getEntriesByType('resource').filter(item=>
      /\\.(png|webp|jpg|woff2?|mp3)(\\?|$)/i.test(item.name)).map(item=>({
      name:item.name.replace(location.origin,''),transfer:item.transferSize,bytes:item.decodedBodySize,duration:item.duration}))''')


def current_match(crew):
    state = helper.state(crew)
    return next(match for match in state['tournament']['matches'] if match['id'] == state['tournament']['currentMatchId'])


def inspect_geometry(page, scene, report):
    for width, height in [(1920, 1080), (1280, 720), (1194, 834), (834, 1194)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(80)
        boxes = page.evaluate('''()=>[...document.querySelectorAll('[data-motion-branding] img,.event-copy h1,.organiser,.scene-head,.selection,[data-final-song]')]
          .filter(element=>element.checkVisibility({opacityProperty:true,visibilityProperty:true})).map(element=>{
          const box=element.getBoundingClientRect();return {name:element.dataset.finalSong||element.className,
            x:box.x,y:box.y,w:box.width,h:box.height}})''')
        assert len([box for box in boxes if 'club-logo' in box['name']]) == 2, (scene, boxes)
        for index, a in enumerate(boxes):
            for b in boxes[index+1:]:
                overlap_w = min(a['x']+a['w'], b['x']+b['w'])-max(a['x'], b['x'])
                overlap_h = min(a['y']+a['h'], b['y']+b['h'])-max(a['y'], b['y'])
                assert overlap_w <= .5 or overlap_h <= .5, (scene, width, height, a, b)
        report['geometry'].append({'scene': scene, 'width': width, 'height': height, 'boxes': boxes})
    page.set_viewport_size({'width': 1920, 'height': 1080})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--baseline-ref', default='528916d', help='Git revision before display asset and warmup changes')
    args = parser.parse_args()
    label = 'baseline' if args.baseline else 'after'
    report = {'checks': [], 'browser_errors': [], 'external_requests': [], 'requests': [],
              'resources': [], 'frames': [], 'geometry': [], 'warmup': {}}
    OUT.mkdir(parents=True, exist_ok=True)
    tracked = {}
    if args.baseline:
        for path in ['public/js/overlay.js', 'public/js/motion.js', 'public/js/selection-audio.js',
                     'public/overlay/common.css'] + [str(path.relative_to(ROOT)) for path in (ROOT/'public/overlay').glob('*.html')]:
            tracked['/' + path.removeprefix('public/')] = subprocess.check_output(['git', 'show', args.baseline_ref + ':' + path], cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix='acahku-warmup-browser-') as directory, sync_playwright() as playwright:
        process, base = start_server(directory)
        browser = playwright.chromium.launch(executable_path=shutil.which('chromium') or shutil.which('chromium-browser'),
            headless=True,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required',
              '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'])
        context = browser.new_context(viewport={'width':1920,'height':1080},device_scale_factor=1)
        context.add_init_script(PROBE)
        def route(request):
            path = urlparse(request.request.url).path
            if not request.request.url.startswith(base):
                report['external_requests'].append(request.request.url)
                request.abort()
            elif path in tracked:
                content = 'text/javascript' if path.endswith('.js') else 'text/css' if path.endswith('.css') else 'text/html'
                request.fulfill(body=tracked[path], content_type=content)
            else:
                request.continue_()
        context.route('**/*',route)
        context.on('request',lambda request:report['requests'].append(urlparse(request.url).path))
        page = context.new_page()
        page.on('pageerror',lambda error:report['browser_errors'].append(str(error)))
        try:
            crew = helper.login(context,base)
            page.goto(base+'/overlay/live.html?audio=0')
            page.bring_to_front()
            helper.idle(page,'start')
            if not args.baseline:
                page.wait_for_function('window.__fixtureWarmup?.status().fonts === "ready"',timeout=15000)
                boot = page.evaluate('window.__warmupProbe.commits[0]')
                assert boot['fonts'] == 'loaded' and all(boot['saira']), boot
                report['checks'].append('Saira fonts are loaded before the first scene commits')
            for scene in ['start','double-elimination-waiting']:
                helper.command(crew,'set-scene',{'scene':scene})
                helper.idle(page,scene)
                page.screenshot(path=str(OUT/(label+'-'+scene+'.png')),omit_background=True,animations='disabled')
                report['resources'].append({'scene':scene,'items':resources(page),
                                           'svg_blur':page.locator('feGaussianBlur').count()})
                inspect_geometry(page,scene,report)
            helper.command(crew,'set-scene',{'scene':'song-selection'})
            helper.command(crew,'draw-candidates')
            helper.idle(page,'song-selection')
            candidates = current_match(crew)['candidates']
            assert len(candidates) == 6
            if not args.baseline:
                page.wait_for_function('window.__fixtureWarmup.status().targetPending===0',timeout=15000)
                decoded = page.evaluate('window.__warmupProbe.decodes.filter(item=>item.ok).map(item=>new URL(item.src).pathname)')
                mapping = page.evaluate('fetch("/api/display-assets").then(response=>response.json())')
                for song in candidates:
                    display = mapping['images'].get(song['art'],{}).get('path',song['art'])
                    assert '/' + display in decoded, (song['title'],display,decoded)
                assert not page.evaluate('window.__warmupProbe.media.length')
                assert not [request for request in report['requests'] if request.endswith('.mp3')]
                report['checks'].append('all six candidate jackets decode before banning, without loading or creating audio')
            page.screenshot(path=str(OUT/(label+'-song-selection.png')),omit_background=True,animations='disabled')
            report['resources'].append({'scene':'song-selection','items':resources(page),
                                       'svg_blur':page.locator('feGaussianBlur').count()})
            inspect_geometry(page,'song-selection',report)
            helper.command(crew,'set-scene',{'scene':'grand-final-announcement'})
            helper.idle(page,'grand-final-announcement')
            page.screenshot(path=str(OUT/(label+'-grand-final-announcement.png')),omit_background=True,animations='disabled')
            report['resources'].append({'scene':'grand-final-announcement','items':resources(page),
                                       'svg_blur':page.locator('feGaussianBlur').count()})
            inspect_geometry(page,'grand-final-announcement',report)
            if not args.baseline:
                assert not page.evaluate('window.__warmupProbe.media.length')
                assert page.locator('feGaussianBlur').count() == 0
                report['checks'].append('pre-blurred backdrop removes the live SVG Gaussian filter; final remains silent')
            for scene in ['start','double-elimination-waiting','song-selection','bracket','start']:
                page.evaluate('window.__warmupProbe.frames=[]')
                helper.command(crew,'set-scene',{'scene':scene})
                helper.idle(page,scene)
                intervals=sorted(page.evaluate('window.__warmupProbe.frames'))
                report['frames'].append({'scene':scene,'count':len(intervals),'max_ms':max(intervals),
                    'p95_ms':intervals[int((len(intervals)-1)*.95)],'over_50_ms':sum(value>50 for value in intervals)})
            for scene in ['song-selection','bracket','grand-final-announcement','double-elimination-waiting']:
                helper.command(crew,'set-scene',{'scene':scene})
            helper.idle(page,'double-elimination-waiting')
            assert page.locator('[data-final-song],.selection').count() == 0
            assert page.locator('[data-motion-branding] .club-logo').count() == 2
            report['checks'].append('rapid scene changes commit only the latest scene with both persistent club logos')
            if not args.baseline:
                statuses = page.evaluate('window.__warmupProbe.statuses')
                assert statuses and all(item['loading']<=2 and item['ready']+item['loading']<=12 for item in statuses), statuses
                report['warmup']={'max_loading':max(item['loading'] for item in statuses),
                                 'max_retained':max(item['ready']+item['loading'] for item in statuses),
                                 'final':page.evaluate('window.__fixtureWarmup.status()')}
                report['checks'].append('decoded-image cache remains within twelve images and two concurrent loads')
            assert not report['external_requests'],report['external_requests']
            assert not report['browser_errors'],report['browser_errors']
            report['checks'].append('four-size start, waiting, selection and final layouts keep logos and content separate')
            if not args.baseline:
                fallback_context = browser.new_context(viewport={'width':1920,'height':1080})
                fallback_context.add_init_script(PROBE)
                fallback_context.route('**/api/display-assets', lambda route: route.fulfill(status=503, body='unavailable'))
                fallback_context.route('**/*.woff2', lambda route: route.abort())
                fallback_page = fallback_context.new_page()
                fallback_page.on('pageerror',lambda error:report['browser_errors'].append(str(error)))
                fallback_page.goto(base+'/overlay/start.html?fixed=1&audio=0')
                helper.idle(fallback_page,'start')
                assert fallback_page.locator('#canvas').get_attribute('data-display-assets') == 'fallback'
                assert fallback_page.locator('feGaussianBlur').count() == 1
                assert '/assets/event/' in fallback_page.locator('.phigros-logo').get_attribute('src')
                assert fallback_page.evaluate('window.__fixtureWarmup.status().fonts') == 'failed'
                assert not fallback_page.evaluate('window.__warmupProbe.media.length')
                assert not report['browser_errors'],report['browser_errors']
                fallback_context.close()
                report['checks'].append('unavailable display mapping and failed fonts fall back to original art without blocking startup')
            (OUT/(label+'-report.json')).write_text(json.dumps(report,indent=2))
            print(json.dumps({'result':'PASS','mode':label,'checks':report['checks'],
                'warmup':report['warmup'],'frames':report['frames'],'report':str(OUT/(label+'-report.json'))},indent=2))
        finally:
            browser.close()
            helper.stop_server(process)


if __name__ == '__main__':
    main()
