"""Painted-logo continuity for bracket routes, live revisions and round motion.

Uses temporary event data, an ephemeral port and the delivered logo assets.
Native WAAPI effects are paused and sought only for compositor PNG checks;
separate real-time rAF traces test natural geometry/timing and rapid changes.
Requires Playwright, Pillow and Chromium. BROADCAST_TEST_OUTPUT selects output.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'logo-continuity'))
OUT.mkdir(parents=True, exist_ok=True)
SERVER = re.search(r'    code = """(.*?)"""', (ROOT/'test/motion-layout.py').read_text(), re.S).group(1)
KEYS = ['phigros-logo', 'club-soc', 'club-kirameki']
SCOPE=os.environ.get('LOGO_TEST_SCOPE','all');assert SCOPE in ['all','tail']
HEADER_REFERENCES={}
REPORT = {'checks': [], 'pixel_samples': [], 'traces': {}, 'browser_errors': [],
          'source_sha256': hashlib.sha256((ROOT/'public/js/motion.js').read_bytes()).hexdigest(),
          'pixel_method': 'Chromium compositor PNGs compared with opaque interior pixels of original local logo assets'}
READ_LOGOS = r'''() => Array.from(document.querySelectorAll('[data-motion-key]'))
  .filter(el=>['phigros-logo','club-soc','club-kirameki'].includes(el.dataset.motionKey))
  .map(el=>{const b=el.getBoundingClientRect(),css=getComputedStyle(el);return {
    key:el.dataset.motionKey,rect:[b.x,b.y,b.width,b.height],src:el.src,
    opacity:Number(css.opacity),visibility:css.visibility,complete:el.complete,
    naturalWidth:el.naturalWidth,z:Number(css.zIndex),parent:el.parentElement.dataset.motionBranding!==undefined,
    tracks:el.getAnimations().map(a=>({start:a.startTime,current:a.currentTime,duration:a.effect.getTiming().duration,
      easing:a.effect.getTiming().easing,frames:a.effect.getKeyframes()}))}})'''
TRACE = r'''() => {
 window.__logoProbe?.stop();const keys=['phigros-logo','club-soc','club-kirameki'];
 const refs=new Map(Array.from(document.querySelectorAll('[data-motion-key]')).filter(el=>keys.includes(el.dataset.motionKey)).map(el=>[el.dataset.motionKey,el]));
 const plane=document.querySelector('[data-motion-branding]');const probe={frames:[],removed:[],plane_removed:0,src_writes:[],active:true};
 probe.observer=new MutationObserver(records=>{for(const r of records){
  if(r.type==='attributes'&&r.attributeName==='src'&&keys.includes(r.target.dataset.motionKey))probe.src_writes.push({key:r.target.dataset.motionKey,old:r.oldValue,src:r.target.getAttribute('src')});
  for(const n of r.removedNodes){if(n===plane||n.contains?.(plane))probe.plane_removed++;}for(const n of r.removedNodes)for(const [key,el] of refs)if(n===el||n.contains?.(el))probe.removed.push({key,time:document.timeline.currentTime});
 }});probe.observer.observe(document.querySelector('#canvas'),{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['src']});
 function frame(){if(!probe.active)return;probe.frames.push({time:document.timeline.currentTime,phase:document.querySelector('#scene').dataset.motionPhase,
   plane_connected:plane?.isConnected,plane_same:document.querySelector('[data-motion-branding]')===plane,logos:Array.from(refs,([key,el])=>{const b=el.getBoundingClientRect(),css=getComputedStyle(el);return {key,connected:el.isConnected,
     same:document.querySelector(`[data-motion-key="${key}"]`)===el,rect:[b.x,b.y,b.width,b.height],opacity:Number(css.opacity),
     complete:el.complete,z:Number(css.zIndex),tracks:el.getAnimations().map(a=>({start:a.startTime,duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing}))}})});
  probe.raf=requestAnimationFrame(frame)};
 probe.stop=()=>{probe.active=false;cancelAnimationFrame(probe.raf);probe.observer.disconnect();return {frames:probe.frames,removed:probe.removed,src_writes:probe.src_writes,plane_removed:probe.plane_removed}};
 window.__logoProbe=probe;probe.raf=requestAnimationFrame(frame);
}'''


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    (OUT/'bracket-logo-progress.json').write_text(json.dumps(REPORT, indent=2)+'\n')
    print('PASS '+name, flush=True)


def idle(page, scene=None):
    page.wait_for_function('''scene=>document.querySelector('#scene').dataset.motionPhase==='idle'
      &&(!scene||document.querySelector('#canvas').dataset.renderedScene===scene)
      &&!document.querySelector('[data-motion-live],[data-motion-placeholder],[data-motion-exits]')
      &&!document.getAnimations().some(a=>a.playState==='running'||a.pending)''', arg=scene, timeout=18000)


def wait_revision(page, revision):
    page.wait_for_function('r=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=r', arg=revision)


def capture(session, clip):
    png = base64.b64decode(session.send('Page.captureScreenshot', {'format':'png','fromSurface':True,
      'optimizeForSpeed':True,'clip':{**clip,'scale':1}})['data'])
    return Image.open(io.BytesIO(png)).convert('RGBA')


def paint_sample(page, session, label, save=False, exact_header=False):
    # Pause/sought effects keep the native geometry fixed across screenshot IPC.
    logos = page.evaluate(READ_LOGOS)
    assert len(logos)==3, (label,'Missing logo',logos)
    results=[]
    for item in logos:
        x,y,w,h=item['rect'];assert item['complete'] and item['naturalWidth']>0,(label,item)
        assert item['opacity']>=.999 and item['visibility']=='visible',(label,item)
        assert x>=0 and y>=0 and x+w<=1920.1 and y+h<=1080.1,(label,'Logo outside viewport',item)
        left,top=int(x),int(y);width,height=int(w+2),int(h+2)
        actual=capture(session,{'x':left,'y':top,'width':width,'height':height})
        if exact_header:
            if item['key'] in HEADER_REFERENCES:
                reference=HEADER_REFERENCES[item['key']]
                assert actual.size==reference.size,(label,'Header bitmap size changed',item)
                diff=ImageChops.difference(actual.convert('RGB'),reference.convert('RGB'))
                maximum=max(hi for lo,hi in diff.getextrema())
                assert maximum<=2,(label,'Static logo pixels changed during bracket switch',item['key'],maximum)
            else:HEADER_REFERENCES[item['key']]=actual.copy()
        source=Image.open(ROOT/'public'/urlsplit(item['src']).path.lstrip('/')).convert('RGBA')
        ratio=min(w/source.width,h/source.height)
        sw,sh=max(1,round(source.width*ratio)),max(1,round(source.height*ratio))
        expected=source.resize((sw,sh),Image.Resampling.LANCZOS)
        # All current assets use contain. In the hero the Phigros bitmap nearly
        # fills its box; the declared left alignment is retained while travelling.
        css=page.locator(f'[data-motion-key="{item["key"]}"]').evaluate('el=>getComputedStyle(el).objectPosition')
        dx=(w-sw)/2 if not css.startswith('0%') else 0;dy=(h-sh)/2
        points=[]
        for ey in range(2,sh-2,3):
            for ex in range(2,sw-2,3):
                target=expected.getpixel((ex,ey))
                if target[3]<252:continue
                # Interior pixels avoid browser/Pillow resampling edge differences.
                around=[expected.getpixel((ex+ox,ey+oy)) for ox,oy in [(-1,0),(1,0),(0,-1),(0,1)]]
                if any(p[3]<252 or max(abs(p[c]-target[c]) for c in range(3))>30 for p in around):continue
                ax=int(round(x-left+dx+ex));ay=int(round(y-top+dy+ey))
                error=min(max(abs(actual.getpixel((ax+ox,ay+oy))[c]-target[c]) for c in range(3))
                  for ox,oy in [(0,0),(-1,0),(1,0),(0,-1),(0,1)]
                  if 0<=ax+ox<actual.width and 0<=ay+oy<actual.height)
                points.append(error)
        assert len(points)>=12,(label,'Insufficient opaque logo samples',item,len(points))
        fraction=sum(error<=40 for error in points)/len(points)
        result={'key':item['key'],'rect':item['rect'],'opaque_samples':len(points),'painted_match_fraction':round(fraction,4)}
        assert fraction>=.88,(label,'Logo bitmap disappeared or was covered',result)
        results.append(result)
        if save:actual.save(OUT/(label.replace(' ','-')+'-'+item['key']+'.png'))
    REPORT['pixel_samples'].append({'label':label,'logos':results})
    return results


def pause_at(page, time_ms=None):
    return page.evaluate('''time=>{const now=time??document.timeline.currentTime;
      const effects=document.getAnimations().map(a=>({a,start:a.startTime??document.timeline.currentTime}));
      for(const {a,start} of effects){a.pause();a.currentTime=now-start}
      window.__logoPixelEffects=effects;return Array.from(document.querySelectorAll('[data-motion-key]'))
       .filter(el=>['phigros-logo','club-soc','club-kirameki'].includes(el.dataset.motionKey))
       .flatMap(el=>el.getAnimations().map(a=>({key:el.dataset.motionKey,start:effects.find(e=>e.a===a).start,duration:a.effect.getTiming().duration})));}''',time_ms)


def seek(page, time_ms):
    page.evaluate('t=>{for(const {a,start} of __logoPixelEffects)a.currentTime=t-start}',time_ms)


def finish(page):
    page.evaluate('()=>{for(const a of document.getAnimations())try{a.finish()}catch(_){a.cancel()}}')
    idle(page)


def validate_trace(trace,label, static=False, detached_guard=True):
    assert trace['frames'],(label,'No natural animation frames')
    for frame in trace['frames']:
        assert len(frame['logos'])==3 and frame['plane_connected'] and frame['plane_same'],(label,frame)
        for logo in frame['logos']:
            assert logo['connected'] and logo['same'] and logo['complete'],(label,logo)
            assert logo['opacity']>=.999 and logo['z']>=1000,(label,logo)
            assert all(t['duration']==760 and t['easing'].startswith('cubic-bezier') for t in logo['tracks']),(label,logo)
            if static:
                initial=next(n for n in trace['frames'][0]['logos'] if n['key']==logo['key'])
                assert max(abs(a-b) for a,b in zip(logo['rect'],initial['rect']))<.1,(label,'Header logo jumped',initial,logo)
                assert not logo['tracks'],(label,'Unchanged header logo restarted movement',logo)
    if detached_guard:
        assert not trace['plane_removed'],(label,'Persistent branding plane detached',trace['plane_removed'])
        assert not trace['removed'],(label,'Logo detached from its paint layer',trace['removed'][:8])
        assert not trace['src_writes'],(label,'Loaded logo src assigned again',trace['src_writes'][:8])
    REPORT['traces'][label]={'frames':len(trace['frames']),'logo_removals':len(trace['removed']),'src_writes':len(trace['src_writes']),'plane_removals':trace['plane_removed']}


with tempfile.TemporaryDirectory(prefix='acahku-logo-continuity-') as data:
    server=subprocess.Popen(['node','-e',SERVER,data],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        port=server.stdout.readline().strip();assert port.isdigit();base='http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BINARY') or shutil.which('chromium'),args=[
              '--no-sandbox','--disable-background-timer-throttling','--disable-renderer-backgrounding'])
            context=browser.new_context(viewport={'width':1920,'height':1080})
            context.on('page',lambda page:page.on('pageerror',lambda e:REPORT['browser_errors'].append(str(e))))
            crew=context.new_page();crew.goto(base+'/control/')
            crew.evaluate('''async()=>{const {token}=await (await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'motion-fixture-code'})})).json();
              let state;const socket=io('/control',{auth:{token}});await new Promise(r=>socket.once('state',s=>{state=s;r()}));socket.on('state',s=>state=s);
              window.__state=()=>state;window.cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',
               {expectedRevision:state.revision,action:{type,payload:{matchId:state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(Error(r.error))));}''')
            def command(kind,payload=None):return crew.evaluate('a=>cmd(a.kind,a.payload)',{'kind':kind,'payload':payload or {}})
            def switch(scene):
                ack=command('set-scene',{'scene':scene});wait_revision(live,ack['revision']);return ack
            live=context.new_page();live.goto(base+'/overlay/live.html');live.wait_for_selector('[data-branding="visual"]');live.evaluate('document.fonts.ready');idle(live,'start')
            cdp=context.new_cdp_session(live);cdp.send('Emulation.setDefaultBackgroundColorOverride',{'color':{'r':0,'g':0,'b':0,'a':0}})
            if SCOPE=='all':
                paint_sample(live,cdp,'initial hero')
                # Actual native logo travel from the hero into a busy bracket.
                live.evaluate(TRACE);switch('bracket');tracks=pause_at(live)
                assert len(tracks)==3,tracks;start=max(t['start'] for t in tracks)
                for offset in [0,190,380,570,759]:
                    seek(live,start+offset);paint_sample(live,cdp,'hero to bracket '+str(offset),save=offset==380)
                finish(live);trace=live.evaluate('window.__logoProbe.stop()');validate_trace(trace,'hero to bracket')
                check('All three original logo bitmaps remain painted throughout the 760 ms hero-to-bracket movement')
                # Static header positions must remain painted across route changes.
                reference=live.evaluate(READ_LOGOS);paint_sample(live,cdp,'header baseline',exact_header=True)
                for scene in ['qualifier-waiting','bracket','result','bracket']:
                    live.evaluate(TRACE);switch(scene);pause_at(live)
                    for offset in [0,200,700]:
                        seek(live,live.evaluate('document.timeline.currentTime')+offset);paint_sample(live,cdp,'header '+scene+' '+str(offset),exact_header=True)
                    finish(live);trace=live.evaluate('window.__logoProbe.stop()');validate_trace(trace,'static '+scene,static=True)
                check('Bracket entry and exit preserve header logo geometry and loaded bitmap pixels')
                # Native original timetable survives an in-flight state revision.
                switch('start');finish(live);switch('bracket')
                live.wait_for_function("document.querySelector('[data-motion-key=\"phigros-logo\"]').getAnimations().some(a=>a.currentTime>=200&&a.currentTime<=450)")
                before=live.evaluate(READ_LOGOS)
                ack=command('rename-player',{'playerId':'p2','name':'Brackets live revision'});wait_revision(live,ack['revision'])
                after=live.evaluate(READ_LOGOS)
                assert 'Brackets live revision' in live.locator('#scene').inner_text()
                for old,new in zip(before,after):
                    assert old['key']==new['key'] and len(old['tracks'])==len(new['tracks'])==1,('Revision lost a logo track',old,new)
                    assert old['tracks'][0]['start']==new['tracks'][0]['start'],('Revision restarted logo timetable',old,new)
                    assert old['tracks'][0]['frames']==new['tracks'][0]['frames'],('Revision changed original logo trajectory',old,new)
                    assert new['tracks'][0]['current']>=old['tracks'][0]['current'],('Logo trajectory ran backwards',old,new)
                pause_at(live);paint_sample(live,cdp,'after live revision')
                finish(live);check('A real-time revision during hero-to-bracket travel keeps its original native timetable and trajectory')
                # Real time, without screenshot pacing: rapid interruptions while
                # moving into/out of a heavy bracket and updating its status.
                live.evaluate(TRACE)
                for scene,delay in [('start',180),('bracket',180),('start',650),('bracket',100)]:
                    switch(scene);live.wait_for_timeout(delay)
                ack=command('rename-player',{'playerId':'p3','name':'Rapid bracket revision'});wait_revision(live,ack['revision']);idle(live,'bracket');assert 'Rapid bracket revision' in live.locator('#scene').inner_text()
                trace=live.evaluate('window.__logoProbe.stop()');validate_trace(trace,'rapid bracket routes')
                paint_sample(live,cdp,'after rapid routes');check('Natural frames retain painted-logo state through rapid bracket route interruptions')
                # Complete the remainder of R1 through real score commands so the
                # internal bracket-round transition also goes through reconciliation.
            def finish_match(match_id):
                command('select-match',{'matchId':match_id});state=crew.evaluate('__state()');match=next(m for m in state['tournament']['matches'] if m['id']==match_id)
                if not match['songs']:
                    if not match['candidates']:command('draw-candidates');state=crew.evaluate('__state()');match=next(m for m in state['tournament']['matches'] if m['id']==match_id)
                    command('ban-song',{'playerIndex':0,'songId':match['candidates'][0]['id']});command('ban-song',{'playerIndex':1,'songId':match['candidates'][1]['id']});command('pick-songs')
                for player in [0,1]:
                    for song in [0,1]:command('set-match-score',{'playerIndex':player,'songIndex':song,'score':990000-player*10000})
                command('record-result')
            bracket=context.new_page();bracket.goto(base+'/overlay/bracket.html');bracket.wait_for_selector('[data-branding="visual"]');bracket.evaluate('document.fonts.ready');idle(bracket,'bracket')
            bracket_cdp=context.new_cdp_session(bracket);bracket_cdp.send('Emulation.setDefaultBackgroundColorOverride',{'color':{'r':0,'g':0,'b':0,'a':0}})
            bracket.evaluate(TRACE)
            for match_id in ['W2','W3','W4']:finish_match(match_id)
            bracket.wait_for_function('document.querySelector(".bracket-board")?.dataset.bracketPhase==="round-transition"',timeout=10000)
            pause_at(bracket);paint_sample(bracket,bracket_cdp,'bracket round transition',save=True,exact_header=True)
            ack=command('rename-player',{'playerId':'p2','name':'Round transition revision'});wait_revision(bracket,ack['revision']);assert 'Round transition revision' in bracket.locator('#scene').inner_text();pause_at(bracket);paint_sample(bracket,bracket_cdp,'round revision',exact_header=True)
            finish(bracket);trace=bracket.evaluate('window.__logoProbe.stop()');validate_trace(trace,'bracket round updates',static=True)
            assert bracket.locator('.bracket-board').get_attribute('data-focus-round')=='2'
            bracket.close();finish(live)
            check('Result revisions and the R1-to-R2 bracket transition preserve static header logos')
            # Reduced-motion cleanup may not reparent/remove loaded logos.
            live.evaluate(TRACE);switch('start');live.emulate_media(reduced_motion='reduce');idle(live,'start')
            paint_sample(live,cdp,'reduced motion');switch('bracket');idle(live,'bracket');paint_sample(live,cdp,'reduced bracket')
            trace=live.evaluate('window.__logoProbe.stop()');validate_trace(trace,'reduced motion')
            check('Reduced-motion cleanup retains the same logo paint layer')
            assert not REPORT['browser_errors'],REPORT['browser_errors']
            REPORT.update(result='PASS',scope=SCOPE,compositor_logo_samples=sum(len(s['logos']) for s in REPORT['pixel_samples']),
              natural_frames=sum(t['frames'] for t in REPORT['traces'].values()))
            (OUT/'bracket-logo-report.json').write_text(json.dumps(REPORT,indent=2)+'\n');print(json.dumps({k:REPORT[k] for k in ['result','compositor_logo_samples','natural_frames','browser_errors']}),flush=True)
            browser.close()
    finally:
        server.terminate();server.wait(timeout=10)
