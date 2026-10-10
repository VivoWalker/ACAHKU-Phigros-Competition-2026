"""Real-browser regression for the staff-triggered full-screen start signal.

Requires Python Playwright, Pillow, Chromium and ffmpeg. Uses a fresh temporary
data directory, random port and fixture-only pairing code. Set
BROADCAST_TEST_OUTPUT to choose screenshots, a short MP4 and the JSON report.
"""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results'))
OUT.mkdir(exist_ok=True, parents=True)
REPORT = {'checks': [], 'timelines': {}, 'pageErrors': [], 'artifacts': []}

TRACE = r"""() => {
  if (window.__countdownTrace) cancelAnimationFrame(window.__countdownTrace.raf);
  const trace = window.__countdownTrace = {frames: [], active: true};
  function frame() {
    if (!trace.active) return;
    const layer = document.querySelector('.match-countdown');
    const number = layer?.querySelector('.countdown-number');
    trace.frames.push({time: performance.timeOrigin + performance.now(),
      label: layer?.hidden ? null : layer?.dataset.countdownPhase || null,
      id: layer?.dataset.countdownId || null,
      opacity: layer ? Number(getComputedStyle(layer).opacity) : 0,
      numberOpacity: number ? Number(getComputedStyle(number).opacity) : 0,
      animations: number?.getAnimations().map(a => ({easing:a.effect.getTiming().easing,
        keyframes:a.effect.getKeyframes().map(k=>k.easing),
        duration:a.effect.getTiming().duration,startTime:a.startTime})) || []});
    trace.raf = requestAnimationFrame(frame);
  }
  trace.raf = requestAnimationFrame(frame);
}"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def idle(page, scene=None):
    page.wait_for_function('''scene => {
      const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
      return mount?.dataset.motionPhase==='idle'&&(!scene||canvas.dataset.renderedScene===scene)
        &&!mount.querySelector('[data-motion-ghost],[data-motion-live],[data-motion-placeholder]')
        &&!mount.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending);
    }''', arg=scene, timeout=15000)


def label(page, value, timeout=6000):
    page.wait_for_function('''value=>{
      const el=document.querySelector('.match-countdown');
      return el&&!el.hidden&&el.dataset.countdownPhase===value;
    }''', arg=value, timeout=timeout)


def hidden(page, timeout=6000):
    page.wait_for_function("document.querySelector('.match-countdown')?.hidden===true", timeout=timeout)


def stop_trace(page):
    return page.evaluate('''()=>{
      window.__countdownTrace.active=false;cancelAnimationFrame(window.__countdownTrace.raf);
      return window.__countdownTrace.frames;
    }''')


def transitions(frames):
    result = []
    for frame in frames:
        if not result or frame['label'] != result[-1]['label']:
            result.append({'label': frame['label'], 'time': frame['time'], 'id': frame['id']})
    return result


def capture_alpha(page, expected):
    png = page.screenshot(omit_background=True)
    image = Image.open(io.BytesIO(png)).convert('RGBA')
    for capture in page.locator('[data-capture]').all():
        box = capture.bounding_box()
        for fx in [.2, .5, .8]:
            for fy in [.2, .5, .8]:
                alpha = image.getpixel((int(box['x']+box['width']*fx), int(box['y']+box['height']*fy)))[3]
                assert alpha == expected, ('Capture alpha', alpha, expected, box)
    return image


def panel_geometry(page, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    page.locator('.countdown-panel').scroll_into_view_if_needed()
    result = page.locator('.countdown-panel').evaluate('''panel=>{
      const rect=el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};
      const nodes=Array.from(panel.querySelectorAll('h2,p,button'));
      return {panel:rect(panel),items:nodes.map(el=>{
        const range=document.createRange();range.selectNodeContents(el);
        const b=range.getBoundingClientRect();
        return {text:el.textContent,box:rect(el),textBox:{x:b.x,y:b.y,w:b.width,h:b.height}};
      }),viewport:innerWidth};
    }''')
    for item in result['items']:
        b = item['box']
        assert b['x'] >= -.1 and b['x']+b['w'] <= width+.1, (width, item, 'Horizontal overflow')
        text = item['textBox']
        assert text['x'] >= b['x']-1 and text['x']+text['w'] <= b['x']+b['w']+1, (width,item,'Clipped text')
    for index, a in enumerate(result['items']):
        for b in result['items'][index+1:]:
            ar, br = a['box'], b['box']
            overlap = min(ar['x']+ar['w'],br['x']+br['w'])-max(ar['x'],br['x']) > .5 and min(ar['y']+ar['h'],br['y']+br['h'])-max(ar['y'],br['y']) > .5
            assert not overlap, (width, a['text'], b['text'], 'Countdown controls overlap')
    return result


def number_geometry(page, expected):
    result=page.locator('.match-countdown').evaluate('''layer=>{
      const box=el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};
      return {label:layer.dataset.countdownPhase,canvas:box(layer),items:Array.from(layer.querySelectorAll(
        '.countdown-eyebrow,.countdown-number,.countdown-caption,.countdown-progress')).map(el=>{
          const range=document.createRange();range.selectNodeContents(el);const b=range.getBoundingClientRect();
          return {selector:el.className,box:box(el),textBox:{x:b.x,y:b.y,w:b.width,h:b.height}};
        })};
    }''')
    assert result['label']==expected,(expected,result)
    canvas=result['canvas']
    for item in result['items']:
        box=item['box']
        assert box['x']>=canvas['x']-.1 and box['x']+box['w']<=canvas['x']+canvas['w']+.1,(expected,item)
        assert box['y']>=canvas['y']-.1 and box['y']+box['h']<=canvas['y']+canvas['h']+.1,(expected,item)
        text=item['textBox']
        if text['w']:
            assert text['x']>=canvas['x']-.1 and text['x']+text['w']<=canvas['x']+canvas['w']+.1,(expected,item,'Text cropped horizontally')
            assert text['y']>=canvas['y']-.1 and text['y']+text['h']<=canvas['y']+canvas['h']+.1,(expected,item,'Text cropped vertically')
    for index,a in enumerate(result['items']):
        for b in result['items'][index+1:]:
            ar,br=a['box'],b['box']
            assert not (min(ar['x']+ar['w'],br['x']+br['w'])>max(ar['x'],br['x'])+.5 and
                        min(ar['y']+ar['h'],br['y']+br['h'])>max(ar['y'],br['y'])+.5),(expected,a,b,'Overlapping countdown content')
    return result


with tempfile.TemporaryDirectory(prefix='acahku-countdown-browser-') as data_dir:
    code = """
const s=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'countdown-browser-fixture'});
s.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
"""
    process = subprocess.Popen(['node','-e',code,data_dir],cwd=ROOT,
                               stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    browsers = []
    try:
        port = process.stdout.readline().strip()
        assert port.isdigit(), 'Temporary fixture server did not start'
        base = 'http://127.0.0.1:' + port
        with sync_playwright() as p:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            def new_browser():
                result=p.chromium.launch(**({'executable_path':binary} if binary else {}),args=[
                    '--no-sandbox','--disable-background-timer-throttling','--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling'])
                browsers.append(result)
                return result

            browser=new_browser()
            context = browser.new_context(viewport={'width':1920,'height':1080})
            context.on('page',lambda page:page.on('pageerror',lambda error:REPORT['pageErrors'].append(str(error))))
            crew = context.new_page(); crew.set_viewport_size({'width':1194,'height':834})
            crew.on('dialog',lambda dialog:dialog.accept())
            crew.goto(base+'/control/');crew.fill('#pin','countdown-browser-fixture');crew.click('#pair-form button')
            crew.wait_for_selector('#program-preview');crew.wait_for_selector('.countdown-panel')
            assert crew.locator('[data-start-countdown]').is_disabled(), 'Non-match scene cannot start a countdown'
            crew.evaluate('''async()=>{
              const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});
              let state;await new Promise(resolve=>socket.once('state',s=>{state=s;resolve()}));
              socket.on('state',s=>state=s);
              window.__fixtureCommand=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',
                {expectedRevision:state.revision,action:{type,payload:{matchId:state.tournament.currentMatchId,...payload}}},
                r=>r.ok?resolve(r):reject(new Error(r.error))));
              window.__fixtureCue=()=>new Promise(resolve=>socket.emit('countdown-sync',resolve));
            }''')

            def command(type_, payload=None):
                return crew.evaluate('(a)=>window.__fixtureCommand(a.type,a.payload)',{'type':type_,'payload':payload or {}})

            def state():
                return context.request.get(base+'/api/state').json()

            def cue():
                return crew.evaluate('window.__fixtureCue()')['cue']

            def start():
                crew.wait_for_function("!document.querySelector('[data-start-countdown]').disabled")
                crew.click('[data-start-countdown]')
                crew.wait_for_function("document.querySelector('[data-start-countdown]').disabled && !document.querySelector('[data-cancel-countdown]').disabled")
                result = cue()
                assert result, 'UI start did not produce a cue'
                return result

            crew.click('[data-scene="qualifier-match"]')
            crew.wait_for_function("!document.querySelector('[data-start-countdown]').disabled")
            # Separate browser processes model separate active OBS sources;
            # Chromium otherwise throttles hidden browser tabs to one frame/sec.
            def observer():
                browser_context=new_browser().new_context(viewport={'width':1920,'height':1080})
                browser_context.on('page',lambda page:page.on('pageerror',lambda error:REPORT['pageErrors'].append(str(error))))
                return browser_context.new_page()

            live=observer();live.goto(base+'/overlay/live.html')
            fixed=observer();fixed.goto(base+'/overlay/qualifier-match.html?fixed=1')
            fixed.add_init_script('Date.now = () => performance.timeOrigin + performance.now() + 3600000')
            fixed.reload()
            standby=observer();standby.goto(base+'/overlay/start.html?fixed=1')
            preview=crew.query_selector('#program-preview').content_frame()
            sources=[live,fixed,preview]
            for page in [crew,live,fixed,standby]:
                page.context.new_cdp_session(page).send('Emulation.setFocusEmulationEnabled',{'enabled':True})
            for page in sources:idle(page,'qualifier-match');hidden(page)
            idle(standby,'start')
            assert live.locator('[data-capture]').count()==3
            capture_alpha(live,0)
            check('staff UI requires a prepared match; qualifier starts with three transparent capture slots')

            geometries={}
            for width,height in [(1194,834),(768,1024),(390,844)]:
                geometries[str(width)]=panel_geometry(crew,width,height)
            # Keep the embedded program preview inside the viewport. Chromium
            # throttles offscreen iframe animation frames even when the parent
            # document is visible; OBS renders the active browser source.
            crew.set_viewport_size({'width':1194,'height':1800})
            crew.evaluate('scrollTo(0,0)')
            check('countdown controls fit tablet and phone without overlapping or clipping',geometries)

            for page in sources:page.evaluate(TRACE)
            first=start()
            for page in sources:label(page,'3')
            ids=[page.locator('.match-countdown').get_attribute('data-countdown-id') for page in sources]
            assert ids==[first['id']]*3, ('Every source must use the same cue',ids)
            hidden(standby)
            assert crew.locator('[data-start-countdown]').is_disabled()
            # Do not take expensive 1920px screenshots during the timing trace:
            # rasterizing several blurred backdrop surfaces can delay the test
            # driver itself, while the browser continues its real clock.
            label(live,'START')
            for page in sources:hidden(page)
            traces=[stop_trace(page) for page in sources]
            timelines=[transitions(trace) for trace in traces]
            REPORT['firstCue']=first
            REPORT['rawTimelines']=timelines
            REPORT['frameCounts']=[len(trace) for trace in traces]
            for name,timeline,trace in zip(['live','clock-offset fixed','control preview'],timelines,traces):
                phases=[step for step in timeline if step['label'] is not None]
                assert [step['label'] for step in phases]==['3','2','1','START'],(name,timeline)
                assert all(step['id']==first['id'] for step in phases),(name,'Timeline was restarted')
                end=next(step['time'] for step in timeline if step['label'] is None and step['time']>phases[-1]['time'])
                for step,expected in zip(phases[1:],[1000,2000,3000]):
                    assert abs(step['time']-first['startsAt']-expected)<130,(name,step,first)
                assert abs(end-first['endsAt'])<130,(name,'Wrong end time',end,first['endsAt'])
                fades=[f for f in trace if f['label']=='START' and .01<f['opacity']<.99]
                assert fades and min(f['time'] for f in fades)>=first['startsAt']+3600,(name,'Missing or premature curtain fade')
                assert all(any(easing.startswith('cubic-bezier(') for easing in a['keyframes'])
                    for f in trace for a in f['animations']), 'Number entry and exit must use nonlinear easing'
                for index,value in enumerate(['3','2','1']):
                    middle=[f for f in trace if f['label']==value and
                        300<=f['time']-first['startsAt']-index*1000<=750]
                    assert middle and min(f['numberOpacity'] for f in middle)>.95,(name,value,'Digit fades too early')
                REPORT['timelines'][name]=timeline
            for phase_name in ['2','1','START']:
                measured=[next(t['time'] for t in line if t['label']==phase_name) for line in timelines]
                assert max(measured)-min(measured)<100,(phase_name,'Sources visibly drift',measured)
            check('3 sources share one timeline despite a wrong local clock; real phases and fade end on schedule')

            cover_cue=start();label(live,'3')
            command('set-qualifier-score',{'playerId':'p1','songIndex':0,'score':985432})
            assert cue()['id']==cover_cue['id'], 'A score update changed the countdown cue'
            image=capture_alpha(live,255)
            for point in [(0,0),(1919,0),(0,1079),(1919,1079)]:
                assert image.getpixel(point)[3]==255, ('Countdown fails to cover a canvas corner',point)
            branding=live.locator('.club-logos').bounding_box()
            assert branding, 'Actual club logos must be present for the cover check'
            # The opaque curtain must paint above the branding stacking layers.
            layer=live.locator('.match-countdown').evaluate('''el=>({z:Number(getComputedStyle(el).zIndex),
              box:el.getBoundingClientRect().toJSON(),background:getComputedStyle(el).backgroundImage})''')
            assert layer['z']>max(live.locator('.club-logo').evaluate_all('els=>els.map(el=>Number(getComputedStyle(el).zIndex)||0)'))
            assert layer['box']['width']==1920 and layer['box']['height']==1080
            bx,by=int(branding['x']+branding['width']/2),int(branding['y']+branding['height']/2)
            assert image.getpixel((bx,by))[3]==255
            for page in sources:hidden(page)
            idle(live,'qualifier-match');capture_alpha(live,0)
            check('full-screen opaque curtain covers captures and logos, then restores transparent captures')
            check('score updates preserve the active countdown and unchanged cue identifier')

            second=start();label(live,'2')
            fixed.reload();label(fixed,'2')
            assert fixed.locator('.match-countdown').get_attribute('data-countdown-id')==second['id']
            crew.click('[data-cancel-countdown]')
            for page in sources:hidden(page)
            assert cue() is None
            check('mid-countdown reload resumes the current digit; UI cancellation removes every source')

            start();label(live,'3')
            command('set-qualifier-display',{'currentSong':1})
            for page in sources:hidden(page)
            check('switching the current qualifier song immediately cancels its start signal')
            start();label(live,'3')
            command('set-qualifier-display',{'players':['p1','p3']})
            for page in sources:hidden(page)
            check('switching on-stage players cancels the start signal')
            command('set-qualifier-display',{'players':['p1','p2','p3']})
            command('set-broadcast-display',{'showHandcams':True})
            idle(live,'qualifier-match');assert live.locator('[data-capture]').count()==6
            start();label(live,'3')
            command('set-scene',{'scene':'qualifier-waiting'})
            for page in sources:hidden(page)
            assert crew.locator('[data-start-countdown]').is_disabled()
            check('dual gameplay/handcam layout supports countdown; leaving the match cancels it')

            # Prepare an actual elimination match using normal tournament commands.
            command('seed-bracket',{'ids':[player['id'] for player in state()['qualifier']['players']]})
            command('draw-candidates',{'matchId':'W1'})
            match=next(m for m in state()['tournament']['matches'] if m['id']=='W1')
            for player_index in [0,1]:
                command('ban-song',{'matchId':'W1','playerIndex':player_index,'songId':match['candidates'][player_index]['id']})
            command('pick-songs',{'matchId':'W1'})
            command('set-scene',{'scene':'double-elimination-match'})
            for page in [live,preview]:idle(page,'double-elimination-match')
            assert live.locator('[data-capture]').count()==4
            reduced_context=new_browser().new_context(viewport={'width':1280,'height':720},reduced_motion='reduce')
            reduced_context.on('page',lambda page:page.on('pageerror',lambda error:REPORT['pageErrors'].append(str(error))))
            reduced=reduced_context.new_page();reduced.goto(base+'/overlay/live.html');idle(reduced,'double-elimination-match')
            reduced.evaluate(TRACE)
            final_cue=start()
            for page in [live,preview,reduced]:label(page,'3')
            hidden(fixed)
            for width,height in [(1280,720),(960,540),(390,844)]:
                reduced.set_viewport_size({'width':width,'height':height})
                reduced.wait_for_function('''()=>{
                  const b=document.querySelector('#canvas').getBoundingClientRect();
                  return Math.abs(b.width-Math.min(innerWidth/1920,innerHeight/1080)*1920)<.1;
                }''')
                box=reduced.locator('.match-countdown').bounding_box()
                assert abs(box['width']/box['height']-16/9)<.001
                assert box['x']>=-.1 and box['x']+box['width']<=width+.1
                assert box['y']>=-.1 and box['y']+box['height']<=height+.1
            for value in ['2','1','START']:label(reduced,value)
            hidden(reduced)
            reduced_trace=stop_trace(reduced)
            assert [t['label'] for t in transitions(reduced_trace) if t['label'] is not None]==['3','2','1','START']
            assert not any(f['animations'] for f in reduced_trace), 'Reduced motion retained decorative number animations'
            live.reload();idle(live,'double-elimination-match');hidden(live)
            capture_alpha(live,0)
            check('elimination dual layout, fixed-scene filtering, reduced motion and scaled canvases work')
            check('refresh after expiry never replays the completed countdown')
            reduced_context.close()

            # Record the real result independently of assertions and save clear
            # 1920px images of the fully opaque 3 and START phases.
            recording=new_browser().new_context(viewport={'width':1920,'height':1080},
                record_video_dir=str(OUT/'countdown-video'),record_video_size={'width':1920,'height':1080})
            recorded=recording.new_page();recorded.goto(base+'/overlay/live.html');idle(recorded,'double-elimination-match')
            video=recorded.video
            start();label(recorded,'3');recorded.wait_for_timeout(650)
            REPORT['countdownGeometry']={'3':number_geometry(recorded,'3')}
            recorded.screenshot(path=str(OUT/'match-countdown-3.png'),omit_background=True)
            digit_image=Image.open(OUT/'match-countdown-3.png').convert('RGB')
            digit_pixels=digit_image.crop((600,300,1320,730)).tobytes()
            bright_pixels=sum(1 for r,g,b in zip(digit_pixels[0::3],digit_pixels[1::3],digit_pixels[2::3])
                if r>220 and g>220 and b>220)
            assert bright_pixels>1000, 'Delivered 3 screenshot does not visibly contain the digit'
            label(recorded,'START');recorded.wait_for_timeout(300)
            REPORT['countdownGeometry']['START']=number_geometry(recorded,'START')
            recorded.screenshot(path=str(OUT/'match-countdown-start.png'),omit_background=True)
            hidden(recorded);recorded.wait_for_timeout(500)
            recording.close()
            video_path=video.path()
            subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(video_path),
                '-an','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',
                str(OUT/'match-countdown-preview.mp4')],check=True)
            REPORT['artifacts']=['match-countdown-3.png','match-countdown-start.png','match-countdown-preview.mp4']
            check('delivered screenshots and MP4 show the real full-screen animation')
            assert not REPORT['pageErrors'], REPORT['pageErrors']
            check('all real browser pages run without uncaught JavaScript errors')
            REPORT['ok']=True
            for active_browser in browsers:active_browser.close()
            browsers=[]
    finally:
        for active_browser in browsers:
            try:active_browser.close()
            except Exception:pass  # Playwright's context manager already closes it on failure.
        process.terminate()
        try:process.communicate(timeout=8)
        except subprocess.TimeoutExpired:process.kill();process.communicate()
        (OUT/'countdown-layout-report.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2)+'\n')
