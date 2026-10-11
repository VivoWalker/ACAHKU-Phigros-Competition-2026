"""Real compositor regression for OBS HTML capture-aperture transitions.

Uses a temporary event and random port. The actual native animation effects are
paused and sought in 80 ms steps for transparent compositor PNG checks. Separate
real-time traces test score-update continuity and interrupted transitions.
Requires Playwright, Pillow and Chromium. BROADCAST_TEST_OUTPUT selects output.
APERTURE_TEST_SCOPE=tail skips the initial qualifier lifecycle checks while
retaining the initial pixel calibration. final runs viewport/countdown/preview
only. The default all runs the whole suite.
Set APERTURE_RECORD_PREVIEW=1 for a real-browser MP4 with labelled mock OBS
sources beneath the unchanged HTML overlay; ffmpeg is required for that option.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'aperture'))
OUT.mkdir(parents=True, exist_ok=True)
SCOPE=os.environ.get('APERTURE_TEST_SCOPE','all')
assert SCOPE in ['all','tail','final']
REPORT = {'checks': [], 'timelines': {}, 'page_errors': [], 'artifacts': [],
          'scope':SCOPE,
          'source_sha256':{file:hashlib.sha256((ROOT/file).read_bytes()).hexdigest() for file in ['public/js/overlay.js','public/js/motion.js']},
          'pixel_method':'Chromium compositor PNGs; original native WAAPI effects paused and sought in 80 ms steps'}
QUALIFIER_CARDS = [(64, 300, 576, 324), (672, 300, 576, 324), (1280, 300, 576, 324)]
QUALIFIER_HANDCAMS = [(64, 800, 240, 135), (672, 800, 240, 135), (1280, 800, 240, 135)]
DOUBLE_CARDS = [(64, 280, 872, 490.5), (984, 280, 872, 490.5)]
DOUBLE_HANDCAMS = [(64, 846, 224, 126), (1632, 846, 224, 126)]
STEP = 80
PIXEL_CDP = {}

SERVER = """
const s=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'aperture-fixture-code',scorekeeperPin:'aperture-scorekeeper-fixture'});
s.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
"""

TRACE = r"""() => {
  window.__apertureProbe?.stop();
  const canvas=document.querySelector('#canvas'),mount=document.querySelector('#scene');
  const background=document.querySelector('.broadcast-backdrop'),image=background.querySelector('image');
  const probe={frames:[],detached:0,active:true};
  probe.observer=new MutationObserver(records=>{
    for(const record of records)for(const removed of record.removedNodes)
      if(removed===background||removed.contains?.(background))probe.detached++;
  });
  probe.observer.observe(canvas,{childList:true,subtree:true});
  function frame(){
    if(!probe.active)return;
    const rect=el=>{const b=el.getBoundingClientRect();return [b.x,b.y,b.width,b.height]};
    probe.frames.push({time:window.__pixelSeek??document.timeline.currentTime,phase:mount.dataset.motionPhase,
      scene:canvas.dataset.renderedScene,revision:Number(canvas.dataset.renderedRevision),
      background_same:document.querySelector('.broadcast-backdrop')===background,
      image_same:document.querySelector('.broadcast-backdrop image')===image,
      masks:document.querySelectorAll('[id="capture-mask"]').length,
      captures:Array.from(mount.querySelectorAll('[data-capture]'),el=>({kind:el.dataset.capture,rect:rect(el)})),
      apertures:Array.from(background.querySelectorAll('[data-aperture-key]'),el=>({
        attributes:Object.fromEntries(Array.from(el.attributes,attribute=>[attribute.name,attribute.value]))})),
      exit_borders:Array.from(mount.querySelectorAll('[data-motion-exits] [data-capture-key]'),el=>({
        key:el.dataset.captureKey,opacity:Number(getComputedStyle(el).opacity)})),
      animations:document.getAnimations().filter(a=>a.playState!=='finished'||a.pending).map(a=>({
        key:a.effect.target?.dataset?.motionKey||a.effect.target?.dataset?.apertureKey||'',
        duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing})),
      logos:Array.from(mount.querySelectorAll('.phigros-logo,.club-logo')).map(el=>({
        key:el.dataset.motionKey,rect:rect(el),z:Number(getComputedStyle(el).zIndex)}))});
    probe.raf=requestAnimationFrame(frame);
  }
  probe.stop=()=>{probe.active=false;cancelAnimationFrame(probe.raf);probe.observer.disconnect();return {frames:probe.frames,detached:probe.detached}};
  window.__apertureProbe=probe;probe.raf=requestAnimationFrame(frame);
}"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)
    (OUT/'aperture-motion-progress.json').write_text(json.dumps(REPORT,indent=2)+'\n')


def idle(page, scene=None):
    page.wait_for_function('''scene=>{
      const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
      return mount?.dataset.motionPhase==='idle'&&(!scene||canvas.dataset.renderedScene===scene)
        &&!mount.querySelector('[data-motion-exits],[data-motion-live],[data-motion-placeholder]')
        &&!document.getAnimations().some(a=>a.playState==='running'||a.pending);
    }''', arg=scene, timeout=15000)


def wait_revision(page, revision):
    # Poll independently of RAF so this also works for an inactive observer.
    until = time.monotonic() + 5
    while time.monotonic() < until:
        if page.evaluate('(r)=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=r', revision):
            return
        time.sleep(.01)
    raise AssertionError(('Overlay did not receive revision', revision))


def alpha_samples(image, rectangles, scale=1):
    return [[image.getpixel((int((x+w*fx)*scale), int((y+h*.5)*scale)))[3] for fx in [.15, .5, .85]]
            for x, y, w, h in rectangles]


def snapshot(page, rectangles, time_ms, label=None):
    # Capture the actual compositor surface without screenshot preparations
    # that can finish animations or insert extra animation-frame waits.
    session=PIXEL_CDP.get(id(page))
    if session is None:
        session=page.context.new_cdp_session(page);PIXEL_CDP[id(page)]=session
        session.send('Emulation.setDefaultBackgroundColorOverride',{'color':{'r':0,'g':0,'b':0,'a':0}})
    scale=1 if label else .5
    viewport=page.viewport_size
    png=base64.b64decode(session.send('Page.captureScreenshot',{'format':'png','fromSurface':True,'optimizeForSpeed':True,
        'clip':{'x':0,'y':0,'width':viewport['width'],'height':viewport['height'],'scale':scale}})['data'])
    image = Image.open(io.BytesIO(png)).convert('RGBA')
    if label:
        path = OUT / label
        path.write_bytes(png)
        REPORT['artifacts'].append(path.name)
    return {'t': time_ms, 'alpha': alpha_samples(image, rectangles,scale),
            'background': image.getpixel((int(1884*scale), int(1024*scale)))}, image


def assert_rects(page, cards, cameras):
    actual = page.locator('[data-capture]').evaluate_all('''els=>els.map(el=>{
      const b=el.getBoundingClientRect();return [b.x,b.y,b.width,b.height]})''')
    expected = [rect for pair in zip(cards, cameras or [None]*len(cards)) for rect in pair if rect]
    assert len(actual) == len(expected), (actual, expected)
    for a, b in zip(actual, expected):
        assert max(abs(x-y) for x,y in zip(a,b)) < .1, (a,b)


def validate_trace(trace, label):
    assert trace['frames'], (label, 'No actual animation frames observed')
    assert trace['detached'] == 0, (label, 'Persistent background detached')
    exit_ends={}
    for frame in trace['frames']:
        assert frame['background_same'] and frame['image_same'], (label, 'Background/artwork identity changed')
        assert frame['masks'] == 1, (label, 'Duplicate capture masks')
        for aperture in frame['apertures']:
            attributes=aperture['attributes']
            if 'data-aperture-phase' in attributes:
                assert attributes['data-aperture-phase'] in ['enter','exit'],(label,attributes)
                assert float(attributes['data-aperture-duration'])==560,(label,'Wrong mask duration',attributes)
                assert int(attributes['data-aperture-order'])>=0,(label,attributes)
                if attributes['data-aperture-phase']=='exit':
                    exit_ends[attributes['data-aperture-key']]=float(attributes['data-aperture-start'])+560
        for border in frame['exit_borders']:
            if border['key'] in exit_ends and frame['time']>=exit_ends[border['key']]+1:
                assert border['opacity']<=.025,(label,'Outgoing border flashed back after its effect completed',border,frame['time'])
        for logo in frame['logos']:
            assert logo['z'] >= 1000, (label, 'Logo below content', logo)
        for animation in frame['animations']:
            if animation['key'] in ['phigros-logo', 'club-soc', 'club-kirameki']:
                assert 0 < animation['duration'] < 1000, (label, 'Slow logo transition', animation)
            elif ':' in animation['key']:
                assert animation['duration']==560 and animation['easing'].startswith('cubic-bezier('),(label,'Mask did not use the common nonlinear timing',animation)


def validate_pixels(samples, rectangles, entering, label, unchanged=()):
    expected_before, expected_after = (255, 0) if entering else (0, 255)
    assert samples, label
    background = samples[0]['background']
    for sample in samples:
        assert max(abs(a-b) for a,b in zip(sample['background'], background)) <= 2, (label, 'Background flashed', sample)
    starts = []
    for index, rect in enumerate(rectangles):
        series = [sample['alpha'][index] for sample in samples]
        if index in unchanged:
            assert all(all(alpha == 0 for alpha in row) for row in series), (label, 'Existing capture popped closed', index, series)
            continue
        assert series[0] == [expected_before]*3, (label, 'Aperture popped at the DOM commit', index, series[0])
        assert series[-1] == [expected_after]*3, (label, 'Aperture did not reach exact settled transparency', index, series[-1])
        assert any(any(0 < alpha < 255 for alpha in row) for row in series), (label, 'No compositor alpha fade', index, series)
        for a, b in zip(series, series[1:]):
            delta = [y-x for x,y in zip(a,b)]
            assert all(d <= 3 for d in delta) if entering else all(d >= -3 for d in delta), (label, 'Mask reversed/flashed', index, a,b)
        # Both operations sweep from right to left: right becomes transparent
        # first on entry, and opaque first on exit. Feather pixels allow 3/255.
        assert all(row[0]+3 >= row[1] and row[1]+3 >= row[2] for row in series) if entering else all(
            row[0] <= row[1]+3 and row[1] <= row[2]+3 for row in series), (label, 'Wrong wipe direction', index, series)
        starts.append((rect[0], rect[1], next(sample['t'] for sample,row in zip(samples,series) if row != [expected_before]*3)))
    starts.sort()
    assert all(a[2] <= b[2] for a,b in zip(starts, starts[1:])), (label, 'Capture windows did not animate left first', starts)
    return starts


def composite_sheet(frames, labels):
    width, height = 640, 360
    sheet = Image.new('RGB', (width*3, (height+36)*2), '#17141d')
    draw = ImageDraw.Draw(sheet)
    for index, (frame, label) in enumerate(zip(frames, labels)):
        tile = Image.new('RGBA', frame.size)
        checker = ImageDraw.Draw(tile)
        for y in range(0, frame.height, 40):
            for x in range(0, frame.width, 40):
                checker.rectangle((x,y,x+39,y+39), fill=('#708899' if (x//40+y//40)%2 else '#4c6577'))
        tile.alpha_composite(frame)
        x, y = (index%3)*width, (index//3)*(height+36)
        sheet.paste(tile.convert('RGB').resize((width,height)), (x,y+36))
        draw.text((x+14,y+10), label, fill='#ffffff')
    path = OUT/'aperture-mask-contact-sheet.jpg'
    sheet.save(path, quality=92)
    REPORT['artifacts'].append(path.name)


def record_preview(browser, base, command):
    command('set-scene',{'scene':'qualifier-waiting'})
    command('set-broadcast-display',{'showHandcams':False})
    with tempfile.TemporaryDirectory(prefix='acahku-aperture-video-') as video_dir:
        recording = browser.new_context(viewport={'width':1920,'height':1080},
            record_video_dir=video_dir,record_video_size={'width':1920,'height':1080})
        preview=recording.new_page();preview.goto(base+'/overlay/live.html')
        preview.wait_for_selector('[data-branding="visual"]');preview.evaluate('document.fonts.ready');idle(preview,'qualifier-waiting')
        # Test-only mock OBS inputs sit beneath the real untouched SVG/HTML.
        # They demonstrate the visible composite; production bundles never
        # contain this DOM or these labels.
        preview.evaluate('''rects=>{
          const underlay=document.createElement('div');underlay.dataset.mockObs='true';
          Object.assign(underlay.style,{position:'absolute',inset:'0',zIndex:'0'});
          rects.forEach((rect,index)=>{
            const box=document.createElement('section');const [left,top,width,height]=rect;
            const camera=index>=3;box.textContent=`MOCK OBS ${camera?'HANDCAM':'CAPTURE CARD'} · PLAYER ${index%3+1}`;
            Object.assign(box.style,{position:'absolute',left:left+'px',top:top+'px',width:width+'px',height:height+'px',
              background:camera?'repeating-linear-gradient(135deg,#214841,#214841 30px,#18332f 30px,#18332f 60px)':
                'repeating-linear-gradient(135deg,#20466a,#20466a 50px,#172e47 50px,#172e47 100px)',
              color:'#fff',display:'grid',placeItems:'center',font:'700 '+(camera?15:23)+'px sans-serif',textAlign:'center'});
            underlay.append(box);
          });
          const canvas=document.querySelector('#canvas');canvas.style.zIndex='1';canvas.before(underlay);
        }''', QUALIFIER_CARDS+QUALIFIER_HANDCAMS)
        preview.wait_for_timeout(500)
        ack=command('set-scene',{'scene':'qualifier-match'});wait_revision(preview,ack['revision']);idle(preview,'qualifier-match');preview.wait_for_timeout(700)
        ack=command('set-broadcast-display',{'showHandcams':True});wait_revision(preview,ack['revision']);idle(preview,'qualifier-match');preview.wait_for_timeout(700)
        ack=command('set-broadcast-display',{'showHandcams':False});wait_revision(preview,ack['revision']);idle(preview,'qualifier-match');preview.wait_for_timeout(500)
        ack=command('set-scene',{'scene':'qualifier-waiting'});wait_revision(preview,ack['revision']);idle(preview,'qualifier-waiting');preview.wait_for_timeout(700)
        video=preview.video;recording.close();source=Path(video.path())
        target=OUT/'aperture-mask-preview.mp4'
        subprocess.run([shutil.which('ffmpeg') or 'ffmpeg','-y','-loglevel','error','-i',str(source),
            '-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',str(target)],check=True)
        REPORT['artifacts'].append(target.name)


with tempfile.TemporaryDirectory(prefix='acahku-aperture-') as data_dir:
    process = subprocess.Popen(['node','-e',SERVER,data_dir], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        port = process.stdout.readline().strip()
        assert port.isdigit(), 'Temporary aperture fixture server did not start'
        base = 'http://127.0.0.1:' + port
        with sync_playwright() as p:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path':binary} if binary else {}),args=[
                '--no-sandbox','--disable-background-timer-throttling','--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows'])
            context = browser.new_context(viewport={'width':1920,'height':1080})
            context.on('page',lambda page:page.on('pageerror',lambda error:REPORT['page_errors'].append(str(error))))
            crew = context.new_page();crew.goto(base+'/control/')
            crew.evaluate('''async()=>{
              const {token}=await (await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'aperture-fixture-code'})})).json();
              const socket=io('/control',{forceNew:true,auth:{token}});let state;
              await new Promise(r=>socket.once('state',s=>{state=s;r()}));socket.on('state',s=>state=s);
              window.__state=()=>state;
              window.__command=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',
                {expectedRevision:state.revision,action:{type,payload:{matchId:state.tournament.currentMatchId,...payload}}},
                r=>r.ok?resolve(r):reject(Error(r.error))));
              window.__countdown=action=>new Promise((resolve,reject)=>socket.emit('countdown-command',{
                action,expectedRevision:state.revision,contextKey:BroadcastCountdown.context(state).key},
                r=>r.ok?resolve(r):reject(Error(r.error))));
            }''')

            def command(type_, payload=None):
                return crew.evaluate('(a)=>__command(a.type,a.payload)',{'type':type_,'payload':payload or {}})

            live = context.new_page();live.goto(base+'/overlay/live.html')
            live.wait_for_selector('[data-branding="visual"]');live.evaluate('document.fonts.ready');idle(live,'start')
            assert live.evaluate('getComputedStyle(document.body).backgroundColor') == 'rgba(0, 0, 0, 0)'
            contact_frames, contact_labels = [], []

            def step(amount=STEP):
                time.sleep(amount/1000)

            def transition(label, type_, payload, rectangles, entering, unchanged=()):
                live.evaluate(TRACE)
                samples=[snapshot(live,rectangles,0)[0]]
                start = live.evaluate('document.timeline.currentTime')
                ack = command(type_,payload);wait_revision(live,ack['revision'])
                image = None
                duration=live.evaluate('''base=>{
                  window.__pixelAnimations=document.getAnimations().map(animation=>{
                    const start=animation.startTime??document.timeline.currentTime;
                    const duration=Number(animation.effect.getTiming().duration);
                    animation.pause();animation.currentTime=base-start;
                    return {animation,start,duration};
                  });window.__pixelSeek=base;
                  return Math.max(...__pixelAnimations.map(a=>a.start+a.duration-base),0);
                }''', start)
                chosen = 0
                for tick in range(1,int(duration/STEP)+3):
                    now=tick*STEP
                    live.evaluate('''time=>{window.__pixelSeek=time;for(const a of __pixelAnimations)a.animation.currentTime=time-a.start}''',start+now)
                    sample,image = snapshot(live,rectangles,round(now))
                    samples.append(sample)
                    intermediate = any(any(20<a<235 for a in row) for row in sample['alpha'])
                    appearance=1-sum(a for row in sample['alpha'] for a in row)/(255*len(rectangles)*3)
                    if intermediate and chosen < 3 and appearance >= [.1,.4,.7][chosen] and label == 'qualifier dual entry':
                        contact_frames.append(image.copy());contact_labels.append(f'Entry +{round(now)} ms (checkerboard = OBS below HTML)');chosen += 1
                trace = live.evaluate('window.__apertureProbe.stop()')
                validate_trace(trace,label)
                REPORT['timelines'][label]={'samples':samples,'frames':len(trace['frames'])}
                starts = validate_pixels(samples,rectangles,entering,label,unchanged)
                live.evaluate('''()=>{delete window.__pixelSeek;for(const a of __pixelAnimations)a.animation.finish();delete window.__pixelAnimations}''')
                idle(live)
                REPORT['timelines'][label]={'samples':samples,'window_starts':starts,'frames':len(trace['frames'])}
                check(label+' paints a right-to-left alpha wipe, staggered left first',{'samples':len(samples),'frame_observations':len(trace['frames'])})
                return image

            def assert_hidden_abort(label, rectangles, expected):
                samples=[]
                start=live.evaluate('document.timeline.currentTime')
                for tick in range(121):
                    elapsed=live.evaluate('document.timeline.currentTime')-start
                    sample,_=snapshot(live,rectangles,round(elapsed));samples.append(sample)
                    assert all(wanted is None or actual==wanted for actual,wanted in zip(sample['alpha'],expected)),(label,'Aborted unopened aperture flashed visible',sample,expected)
                    if live.evaluate('document.querySelector("#scene").dataset.motionPhase==="idle"'):break
                    step()
                else:raise AssertionError((label,'Aborted transition did not settle'))
                REPORT['timelines'][label]={'samples':samples,'frames':0}
                check(label+' never exposes an aborted, unopened source')

            if SCOPE!='final':
                command('set-broadcast-display',{'showHandcams':True})
                transition('qualifier dual entry','set-scene',{'scene':'qualifier-match'},QUALIFIER_CARDS+QUALIFIER_HANDCAMS,True)
                assert_rects(live,QUALIFIER_CARDS,QUALIFIER_HANDCAMS)
                snapshot(live,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0,'aperture-qualifier-dual.png')
                if SCOPE=='all':
                    transition('qualifier dual exit','set-scene',{'scene':'qualifier-waiting'},QUALIFIER_CARDS+QUALIFIER_HANDCAMS,False)
                    ack=command('set-scene',{'scene':'qualifier-match'});wait_revision(live,ack['revision'])
                    ack=command('set-scene',{'scene':'start'});wait_revision(live,ack['revision'])
                    assert_hidden_abort('match entry aborted before reveal',QUALIFIER_CARDS+QUALIFIER_HANDCAMS,[[255,255,255]]*6)
                    transition('qualifier dual reentry','set-scene',{'scene':'qualifier-match'},QUALIFIER_CARDS+QUALIFIER_HANDCAMS,True)
                    command('set-scene',{'scene':'qualifier-waiting'});idle(live,'qualifier-waiting')
                    live.evaluate(TRACE)
                    command('set-scene',{'scene':'qualifier-match'})
                    live.wait_for_function('''()=>document.getAnimations().some(a=>a.effect.target?.dataset?.aperturePhase==='enter'&&a.effect.getComputedTiming().progress>.1&&a.effect.getComputedTiming().progress<.65)''')
                    before=live.evaluate('''()=>({time:document.timeline.currentTime,tracks:Array.from(document.querySelectorAll('[data-aperture-key]'),el=>({...el.dataset}))})''')
                    ack=command('set-qualifier-score',{'playerId':'p1','songIndex':0,'score':987654});wait_revision(live,ack['revision'])
                    after=live.evaluate('''()=>({time:document.timeline.currentTime,tracks:Array.from(document.querySelectorAll('[data-aperture-key]'),el=>({...el.dataset}))})''')
                    checked=0
                    for previous,current in zip(before['tracks'],after['tracks']):
                        if 'apertureStart' in current:
                            for key in ['apertureKey','apertureStart','apertureDuration','apertureOrder']:
                                assert previous[key]==current[key],('Midway score revision changed mask schedule',key,previous,current)
                            checked+=1
                        else:assert after['time']>=float(previous['apertureStart'])+560,('Mask ended early after score update',previous,after)
                    assert checked>0,'No active aperture was observed after the score update'
                    idle(live,'qualifier-match');trace=live.evaluate('window.__apertureProbe.stop()');validate_trace(trace,'natural score update')
                    REPORT['score_update_mask_attributes']={'before':before,'after':after}
                    check('real-time score revision preserves original active mask start times and does not restart reveal')
                    transition('qualifier handcam close','set-broadcast-display',{'showHandcams':False},QUALIFIER_CARDS+QUALIFIER_HANDCAMS,False,unchanged=(0,1,2))
                    assert_rects(live,QUALIFIER_CARDS,[])
                    ack=command('set-broadcast-display',{'showHandcams':True});wait_revision(live,ack['revision'])
                    ack=command('set-broadcast-display',{'showHandcams':False});wait_revision(live,ack['revision'])
                    # Observe after the abort has actually reached the overlay. A
                    # future-started window may begin during the command's network
                    # round trip; it is then a partial exit, not an unopened aperture.
                    unopened=live.evaluate('''rects=>rects.filter(rect=>{
                      const el=Array.from(document.querySelectorAll('[data-aperture-key]')).find(el=>el.dataset.apertureKey===rect.join(':'));
                      return !el||Number(getComputedStyle(el).opacity)===0;
                    }).map(rect=>rect[0])''',QUALIFIER_HANDCAMS)
                    REPORT['aborted_handcam_unopened_x']=unopened
                    assert_hidden_abort('dual mode aborted before handcam reveal',QUALIFIER_CARDS+QUALIFIER_HANDCAMS,[[0,0,0]]*3+[[255,255,255] if r[0] in unopened else None for r in QUALIFIER_HANDCAMS])
                else:
                    ack=command('set-broadcast-display',{'showHandcams':False});wait_revision(live,ack['revision']);idle(live,'qualifier-match')
                command('set-broadcast-display',{'showHandcams':True})
                live.wait_for_function('''()=>document.getAnimations().some(a=>a.effect.target?.dataset?.aperturePhase==='enter'&&JSON.parse(a.effect.target.dataset.apertureRect)[1]===800&&a.effect.getComputedTiming().progress>.2&&a.effect.getComputedTiming().progress<.65)''')
                command('set-broadcast-display',{'showHandcams':False})
                ack=command('set-broadcast-display',{'showHandcams':True});wait_revision(live,ack['revision'])
                toggle_tracks=live.evaluate('''()=>document.getAnimations().map(a=>a.effect.target).filter(el=>el?.dataset?.aperturePhase).map(el=>({...el.dataset}))''')
                outgoing=[float(a['apertureStart'])+560 for a in toggle_tracks if a['aperturePhase']=='exit']
                incoming=[float(a['apertureStart']) for a in toggle_tracks if a['aperturePhase']=='enter' and json.loads(a['apertureRect'])[1]==800]
                assert outgoing and len(incoming)==3,(outgoing,incoming,toggle_tracks)
                assert min(incoming)>=max(outgoing)-.5,('Reintroduced handcam reused a stale reveal start',toggle_tracks)
                idle(live,'qualifier-match')
                settled,_=snapshot(live,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0)
                assert settled['alpha']==[[0,0,0]]*6,settled
                assert live.locator('.broadcast-backdrop [data-aperture-key]').count()==6
                check('rapid single/dual/single/dual starts recreated handcams after the outgoing masks have closed')
                command('set-broadcast-display',{'showHandcams':False});idle(live,'qualifier-match')
                transition('qualifier handcam reveal','set-broadcast-display',{'showHandcams':True},QUALIFIER_CARDS+QUALIFIER_HANDCAMS,True,unchanged=(0,1,2))
                assert_rects(live,QUALIFIER_CARDS,QUALIFIER_HANDCAMS)

                # Create a playable match through production tournament actions.
                command('seed-bracket',{'ids':['p1','p5','p2','p6','p3','p7','p4','p8']})
                command('draw-candidates')
                candidates=crew.evaluate('__state().tournament.matches[0].candidates.map(s=>s.id)')
                command('ban-song',{'playerIndex':0,'songId':candidates[0]})
                command('ban-song',{'playerIndex':1,'songId':candidates[1]})
                command('pick-songs')
                transition('qualifier exit before double','set-scene',{'scene':'double-elimination-waiting'},QUALIFIER_CARDS+QUALIFIER_HANDCAMS,False)
                transition('double dual entry','set-scene',{'scene':'double-elimination-match'},DOUBLE_CARDS+DOUBLE_HANDCAMS,True)
                assert_rects(live,DOUBLE_CARDS,DOUBLE_HANDCAMS)
                snapshot(live,DOUBLE_CARDS+DOUBLE_HANDCAMS,0,'aperture-double-dual.png')
                transition('double handcam close','set-broadcast-display',{'showHandcams':False},DOUBLE_CARDS+DOUBLE_HANDCAMS,False,unchanged=(0,1))
                assert_rects(live,DOUBLE_CARDS,[])
                transition('double handcam reveal','set-broadcast-display',{'showHandcams':True},DOUBLE_CARDS+DOUBLE_HANDCAMS,True,unchanged=(0,1))
                assert_rects(live,DOUBLE_CARDS,DOUBLE_HANDCAMS)

                # Reverse a partially closing set, then supersede it with another
                # route. Final target holes must be exact, with no orphan cutouts.
                live.evaluate(TRACE)
                ack=command('set-scene',{'scene':'double-elimination-waiting'});wait_revision(live,ack['revision'])
                for _ in range(5):step()
                before,_=snapshot(live,DOUBLE_CARDS+DOUBLE_HANDCAMS,200)
                ack=command('set-scene',{'scene':'double-elimination-match'});wait_revision(live,ack['revision'])
                after,_=snapshot(live,DOUBLE_CARDS+DOUBLE_HANDCAMS,200)
                # An outgoing track keeps covering in its original direction while
                # the replacement waits. It must not suddenly reopen all sources.
                assert all(b>=a-3 for old,new in zip(before['alpha'],after['alpha']) for a,b in zip(old,new)),('Rapid route reversal reopened an outgoing hole',before,after)
                for _ in range(4):step()
                ack=command('set-scene',{'scene':'qualifier-match'});wait_revision(live,ack['revision'])
                for _ in range(120):
                    step()
                    if live.evaluate('document.querySelector("#scene").dataset.motionPhase==="idle"'):break
                trace=live.evaluate('window.__apertureProbe.stop()');validate_trace(trace,'rapid routes')
                final,_=snapshot(live,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0)
                assert all(row==[0,0,0] for row in final['alpha']),final
                assert_rects(live,QUALIFIER_CARDS,QUALIFIER_HANDCAMS)
                assert live.locator('.broadcast-backdrop [data-aperture-key]').count() == 6, 'Stale outgoing cutouts survived'
                check('rapid route reversals preserve current pixel alpha and settle only the final six holes')

                # Finish a currently running transition on an actual media-query
                # change, then exercise both a new scene and same-scene toggle.
                ack=command('set-scene',{'scene':'qualifier-waiting'});wait_revision(live,ack['revision']);step(160)
                live.emulate_media(reduced_motion='reduce');step(40)
                closed,_=snapshot(live,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0)
                assert all(row==[255,255,255] for row in closed['alpha']),closed
                ack=command('set-scene',{'scene':'qualifier-match'});wait_revision(live,ack['revision']);step(40)
                opened,_=snapshot(live,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0)
                assert all(row==[0,0,0] for row in opened['alpha']),opened
                ack=command('set-broadcast-display',{'showHandcams':False});wait_revision(live,ack['revision']);step(40)
                mixed,_=snapshot(live,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0)
                assert mixed['alpha'] == [[0,0,0]]*3+[[255,255,255]]*3,mixed
                assert live.evaluate('document.querySelector("#scene").dataset.motionPhase') == 'idle'
                check('reduced motion commits exact masks immediately, including preference changes midflight')

            else:
                command('set-broadcast-display',{'showHandcams':True})
                ack=command('set-scene',{'scene':'qualifier-match'});wait_revision(live,ack['revision']);idle(live,'qualifier-match')
            # Normal real-time fixed sources still have transparent document
            # backgrounds and the countdown remains opaque above every source.
            fixed=context.new_page();fixed.goto(base+'/overlay/qualifier-match.html?fixed=1&cameras=1')
            fixed.evaluate('document.fonts.ready');idle(fixed,'qualifier-match')
            assert_rects(fixed,QUALIFIER_CARDS,QUALIFIER_HANDCAMS)
            settled,_=snapshot(fixed,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0)
            assert all(row==[0,0,0] for row in settled['alpha']),settled
            assert fixed.evaluate('getComputedStyle(document.body).backgroundColor') == 'rgba(0, 0, 0, 0)'
            for width,height in [(1280,720),(960,540)]:
                fixed.set_viewport_size({'width':width,'height':height})
                fixed.wait_for_timeout(40)
                png=fixed.screenshot(omit_background=True)
                scaled=Image.open(io.BytesIO(png)).convert('RGBA')
                for capture in fixed.locator('[data-capture]').all():
                    b=capture.bounding_box()
                    assert scaled.getpixel((int(b['x']+b['width']*.5),int(b['y']+b['height']*.5)))[3]==0,(width,b)
                assert scaled.getpixel((width-24,height-24))[3]==255,(width,'Background opacity')
            fixed.set_viewport_size({'width':1920,'height':1080})
            check('settled capture geometry stays transparent at 1080p, 720p and 540p')
            command('set-broadcast-display',{'showHandcams':True})
            crew.evaluate('__countdown("start")')
            fixed.wait_for_function('document.querySelector(".match-countdown").dataset.countdownPhase==="3"',timeout=6000)
            countdown,image=snapshot(fixed,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0,'aperture-countdown-covered.png')
            assert all(row==[255,255,255] for row in countdown['alpha']),countdown
            logo_points=[]
            for logo in fixed.locator('.phigros-logo,.club-logo').all():
                box=logo.bounding_box()
                logo_points.append((int(box['x']+box['width']/2),int(box['y']+box['height']/2)))
            # The countdown intentionally ignores pointer events, so hit-tests
            # see the underlying logos. Painted RGB must instead stay identical
            # when those underlying logos are hidden during the opaque cue.
            fixed.evaluate('''()=>document.querySelectorAll('.phigros-logo,.club-logo').forEach(el=>el.style.visibility='hidden')''')
            _,without_logos=snapshot(fixed,QUALIFIER_CARDS+QUALIFIER_HANDCAMS,0,'aperture-countdown-logo-probe.png')
            for point in logo_points:
                assert image.getpixel(point)==without_logos.getpixel(point),('Logo painted above countdown',point,image.getpixel(point),without_logos.getpixel(point))
            fixed.evaluate('''()=>document.querySelectorAll('.phigros-logo,.club-logo').forEach(el=>el.style.removeProperty('visibility'))''')
            check('fixed dual source remains calibrated and transparent; fullscreen countdown covers captures and logos')

            if contact_frames:
                contact_frames += [Image.open(OUT/'aperture-qualifier-dual.png').convert('RGBA')]
                contact_labels += ['Settled: exact transparent source apertures']
                composite_sheet(contact_frames,contact_labels)
            if os.environ.get('APERTURE_RECORD_PREVIEW')=='1':record_preview(browser,base,command)
            assert not REPORT['page_errors'],REPORT['page_errors']
            REPORT['result']='PASS'
            (OUT/'aperture-motion-report.json').write_text(json.dumps(REPORT,indent=2)+'\n')
            print(json.dumps({'result':'PASS','checks':len(REPORT['checks']),'pixel_samples':sum(len(t['samples'])*len(t['samples'][0]['alpha'])*3 for t in REPORT['timelines'].values()),'artifacts':REPORT['artifacts']},indent=2),flush=True)
            browser.close()
    finally:
        process.terminate()
        try:process.wait(timeout=8)
        except subprocess.TimeoutExpired:process.kill();process.wait()
