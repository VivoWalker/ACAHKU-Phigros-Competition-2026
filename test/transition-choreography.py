"""Real-browser overlap, layer and timing checks for every directed scene change.
Temporary tournament only. Set TRANSITION_RECORD=1 to record representative scenes.
"""
import io, json, os, re, shutil, subprocess, tempfile, time
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results'/'choreography'));OUT.mkdir(parents=True,exist_ok=True)
SCENES=['start','qualifier-waiting','double-elimination-waiting','qualifier-match','double-elimination-match','result','bracket','song-selection']
# Reuse the real command-driven fixture shared with cover regressions.
CODE=re.search(r'    code = """(.*?)"""', (ROOT/'test/motion-layout.py').read_text(),re.S).group(1)
CODE=CODE.replace("cmd('set-scene',{scene:'start'});", """if(process.env.TRANSITION_LONG_CONTENT==='1'){
cmd('rename-player',{playerId:'p1',name:'W'.repeat(48)});cmd('rename-player',{playerId:'p2',name:'M'.repeat(48)});
s.store.state.event.title='長'.repeat(120);
for(const song of s.store.state.library)song.title='曲'.repeat(100);
for(const m of s.store.state.tournament.matches)for(const song of [...m.candidates,...m.songs])song.title='曲'.repeat(100);
}
cmd('set-scene',{scene:'start'});""")
PROBE=r'''() => {
 const root=document.querySelector('#scene'), canvas=document.querySelector('#canvas');
 const selectors='.event-title,.topmeta,.event-copy h1,.event-line,.organiser,.key-visual,.waiting-copy>.section-label,.waiting-copy>h1,.waiting-players>p,.waiting-song,.player-name>h2,.player-total,.song-scores,.handcam-label,.song-band,.scene-head,.ranking-tables>section,.footer,.winner-panel,.result-row,.bracket-column,.candidate,.selection-art,.selection-detail>h2,.picks,.selection-state,.empty-copy,[data-capture]';
 const logos=()=>[...root.querySelectorAll('.phigros-logo,.phigros-wordmark,.club-logo')];
 const visible=e=>{let opacity=1;for(let p=e;p&&p!==root;p=p.parentElement){const s=getComputedStyle(p);if(s.visibility==='hidden')return false;opacity*=Number(s.opacity);}return opacity>.025};
 const bounds=e=>{const b=e.getBoundingClientRect();let r={left:b.left,top:b.top,right:b.right,bottom:b.bottom};
  if(e.dataset.motionEntryRect){const f=JSON.parse(e.dataset.motionEntryRect),s=canvas.getBoundingClientRect(),scale=s.width/1920;r.left=Math.max(r.left,s.left+f.left*scale);r.right=Math.min(r.right,s.left+(f.left+f.width)*scale);r.top=Math.max(r.top,s.top+f.top*scale);r.bottom=Math.min(r.bottom,s.top+(f.top+f.height)*scale);}
  return r;};
 const selected=()=>{const all=[...root.querySelectorAll(selectors)];return all.filter(e=>!all.some(p=>p!==e&&p.contains(e)))};
 const trace={frames:0,overlaps:[],timings:[],entries:[],logos:[],outside:[],layerErrors:[],completed:false};
 let active=true;
 const rectOverlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
 function frame(){if(!active)return;trace.frames++;const elements=[...selected(),...logos()].filter(e=>visible(e));
  const boxes=elements.map(e=>({node:e,box:bounds(e),name:e.dataset.motionKey||e.className||e.tagName})).filter(x=>x.box.right-x.box.left>1&&x.box.bottom-x.box.top>1);
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(a.node.contains(b.node)||b.node.contains(a.node))continue;const area=rectOverlap(a.box,b.box);if(area>4&&trace.overlaps.length<30)trace.overlaps.push({scene:canvas.dataset.renderedScene,phase:root.dataset.motionPhase,a:a.name,b:b.name,area,ab:a.box,bb:b.box});}
  const stage=canvas.getBoundingClientRect();for(const {box,name} of boxes)if(box.left<stage.left-2||box.right>stage.right+2||box.top<stage.top-2||box.bottom>stage.bottom+2)if(trace.outside.length<10)trace.outside.push({name,box});
  for(const logo of logos()){if(getComputedStyle(logo).clipPath!=='none'||logo.closest('[data-motion-branding]')&&getComputedStyle(logo.closest('[data-motion-branding]')).clipPath!=='none')trace.layerErrors.push('clipped logo');if(Number(getComputedStyle(logo).zIndex)<1000)trace.layerErrors.push('logo not topmost');}
  for(const a of root.getAnimations({subtree:true})){const target=a.effect.target,t=a.effect.getTiming();if(!trace.timings.some(x=>x.target===target&&x.animation===a)){trace.timings.push({target,animation:a,scene:canvas.dataset.renderedScene,start:a.startTime,key:target.dataset.motionKey||'',entry:target.dataset.motionEntry||'',duration:t.duration,delay:t.delay,easing:t.easing,frames:a.effect.getKeyframes().map(f=>({transform:f.transform,opacity:f.opacity,maskSize:f.maskSize})),order:Number(target.dataset.motionOrder),rect:target.dataset.motionEntryRect?JSON.parse(target.dataset.motionEntryRect):null});}}
  requestAnimationFrame(frame);
 }
 trace.stop=()=>{active=false;return {...trace,timings:trace.timings.map(({target,animation,...rest})=>rest),stop:undefined}};window.__trace=trace;requestAnimationFrame(frame);
}'''
TEXT_AUDIT=r"""()=>{
 const root=document.querySelector('#scene'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),texts=[];let node;
 while(node=walker.nextNode()){
  if(!node.textContent.trim()||node.parentElement.closest('svg,.phigros-wordmark,.offline-notice'))continue;
  let visible=true;for(let p=node.parentElement;p&&p!==root;p=p.parentElement){const css=getComputedStyle(p);if(css.visibility==='hidden'||Number(css.opacity)<.025)visible=false;}
  if(!visible)continue;
  const range=document.createRange();range.selectNodeContents(node);
  for(const b of range.getClientRects()){
   const r={left:b.left,right:b.right,top:b.top,bottom:b.bottom};
   for(let p=node.parentElement;p&&p!==root;p=p.parentElement){const css=getComputedStyle(p),a=p.getBoundingClientRect();if(['hidden','clip','auto','scroll'].includes(css.overflowX)){r.left=Math.max(r.left,a.left);r.right=Math.min(r.right,a.right)}if(['hidden','clip','auto','scroll'].includes(css.overflowY)){r.top=Math.max(r.top,a.top);r.bottom=Math.min(r.bottom,a.bottom)}}
   if(r.right-r.left>1&&r.bottom-r.top>1)texts.push({r,text:node.textContent.trim().slice(0,30),node});
  }
 }
 const overlaps=[];for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){const a=texts[i],b=texts[j];if(a.node===b.node)continue;const w=Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left),h=Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top);if(w>2&&h>2&&overlaps.length<8)overlaps.push({a:a.text,b:b.text,w,h});}
 return {text_fragments:texts.length,overlaps};
}"""
def idle(page,scene=None):
 page.wait_for_function('scene=>document.querySelector("#scene")?.dataset.motionPhase==="idle"&&(!scene||document.querySelector("#canvas").dataset.renderedScene===scene)',arg=scene,timeout=15000)
def validate(trace,label):
 assert not trace['overlaps'],(label,'overlaps',trace['overlaps'][:3])
 assert not trace['outside'],(label,'outside',trace['outside'])
 assert not trace['layerErrors'],(label,trace['layerErrors'])
 for a in trace['timings']:
  assert a['easing'].startswith('cubic-bezier'),(label,a)
  if a['key'] in ['phigros-logo','phigros-wordmark','club-soc','club-kirameki']:
   assert 0<a['duration']<1000,(label,a)
  if a['entry']:
   assert a['frames'][0]['opacity']=='0' and '36px' in a['frames'][0]['transform'],(label,a)
   assert a['frames'][-1]['maskSize']=='100% 100%',(label,a)
 entries=[a for a in trace['timings'] if a['entry']]
 groups={}
 for a in entries:groups.setdefault((a['scene'],round(a['start']-a['order']*65,2)),[]).append(a)
 for items in groups.values():
  byorder=sorted(items,key=lambda a:a['order'])
  for a,b in zip(byorder,byorder[1:]):
   assert a['rect']['left']<=b['rect']['left']+.5,(label,'not left-to-right',a,b)
   assert a['start']<=b['start']+.5,(label,'not staggered',a,b)
 return len(entries)
with tempfile.TemporaryDirectory(prefix='acahku-choreography-') as data:
 process=subprocess.Popen(['node','-e',CODE,data],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  port=process.stdout.readline().strip();assert port.isdigit(),process.stderr.read();base='http://127.0.0.1:'+port
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
   options={'viewport':{'width':1920,'height':1080}}
   if os.environ.get('TRANSITION_RECORD')=='1':options.update(record_video_dir=str(OUT/'video'),record_video_size={'width':1280,'height':720})
   context=browser.new_context(**options);errors=[];context.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))))
   driver=context.new_page();driver.goto(base+'/control/')
   driver.evaluate('''async()=>{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'motion-fixture-code'})});const {token}=await r.json();const socket=io('/control',{auth:{token}});let state;await new Promise(resolve=>socket.once('state',s=>{state=s;resolve()}));socket.on('state',s=>state=s);window.cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:state.revision,action:{type,payload:{matchId:state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(Error(r.error))));}''')
   def command(type,payload={}):return driver.evaluate('a=>window.cmd(a.type,a.payload)',{'type':type,'payload':payload})
   page=context.new_page();page.goto(base+'/overlay/live.html');page.wait_for_selector('[data-branding="visual"]');page.evaluate('document.fonts.ready');idle(page)
   report={'pairs':0,'frames':0,'entrances':0,'viewports':[]}
   def check(target,label=None):
    page.evaluate(PROBE);command('set-scene',{'scene':target});idle(page,target);trace=page.evaluate('window.__trace.stop()');report['frames']+=trace['frames'];report['entrances']+=validate(trace,label or target);audit=page.evaluate(TEXT_AUDIT);assert not audit['overlaps'],(label or target,'text overlaps',audit);return trace
   if os.environ.get('TRANSITION_RECORD')=='1':
    page.add_style_tag(content='html{background:#101218!important}')
    frames=[]
    for target in ['qualifier-waiting','start','qualifier-match','start','double-elimination-match','bracket','song-selection','start']:
     page.evaluate(PROBE);command('set-scene',{'scene':target})
     began=time.monotonic()
     for seconds in [0,.2,.45,.75,1.,1.4,2.]:
      remaining=seconds-(time.monotonic()-began)
      if remaining>0:page.wait_for_timeout(remaining*1000)
      path=OUT/f'{target}-{len(frames):03}.jpg';page.screenshot(path=str(path));frames.append((target,path))
     idle(page,target);trace=page.evaluate('window.__trace.stop()')
     report['frames']+=trace['frames'];report['entrances']+=validate(trace,target);report['pairs']+=1
     audit=page.evaluate(TEXT_AUDIT);assert not audit['overlaps'],(target,'text overlaps',audit)
    video=page.video;context.close();shutil.copyfile(video.path(),OUT/'transition-preview.webm')
    sheet=Image.new('RGB',(320*7,202*8),'#24232e');draw=ImageDraw.Draw(sheet)
    for i,(name,path) in enumerate(frames):
     img=Image.open(path);img.thumbnail((320,180));x,y=(i%7)*320,(i//7)*202;sheet.paste(img,(x,y));draw.text((x+4,y+183),name,fill='white')
    sheet.save(OUT/'contact-sheet.jpg')
   else:
    adjacency={s:[t for t in SCENES if t!=s] for s in SCENES};stack=['start'];walk=[]
    while stack:
     if adjacency[stack[-1]]:stack.append(adjacency[stack[-1]].pop())
     else:walk.append(stack.pop())
    walk=walk[::-1]
    if os.environ.get('TRANSITION_CHECK_MODE')=='smoke':walk=['start']+SCENES[1:]+['start']
    for source,target in zip(walk,walk[1:]):check(target,source+' -> '+target);report['pairs']+=1
    for width,height in ([(960,540)] if os.environ.get('TRANSITION_CHECK_MODE')=='smoke' else [(1280,720),(960,540),(390,844)]):
     page.set_viewport_size({'width':width,'height':height})
     for target in SCENES:check(target,f'{width} {target}')
     report['viewports'].append(width)
    page.set_viewport_size({'width':1920,'height':1080})
    for scene in ['qualifier-match','double-elimination-match']:
     check(scene)
     for dual in [True,False]:
      page.evaluate(PROBE);command('set-broadcast-display',{'showHandcams':dual});idle(page);validate(page.evaluate('window.__trace.stop()'),f'{scene} dual={dual}')
      image=Image.open(io.BytesIO(page.screenshot(omit_background=True))).convert('RGBA')
      for frame in page.locator('[data-capture]').all():
       b=frame.bounding_box();assert image.getpixel((int(b['x']+b['width']/2),int(b['y']+b['height']/2)))[3]==0
    match=next(m for m in context.request.get(base+'/api/state').json()['tournament']['matches'] if m['id']=='W2')
    command('ban-song',{'playerIndex':0,'songId':match['candidates'][0]['id']});command('ban-song',{'playerIndex':1,'songId':match['candidates'][1]['id']});command('pick-songs')
    check('start');command('set-scene',{'scene':'double-elimination-match'});page.wait_for_timeout(200)
    revision=command('set-match-score',{'playerIndex':0,'songIndex':0,'score':999876})['revision']
    page.wait_for_function('r=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=r',arg=revision,timeout=1000)
    idle(page);assert '999,876' in page.locator('.player-total').first.inner_text()
    page.evaluate(PROBE)
    for target in ['start','bracket','start','qualifier-match']:command('set-scene',{'scene':target});page.wait_for_timeout(80)
    idle(page,'qualifier-match');validate(page.evaluate('window.__trace.stop()'),'rapid switching');assert page.locator('[data-motion-live],[data-motion-placeholder],[data-motion-entry]').count()==0
    command('set-scene',{'scene':'start'});page.wait_for_timeout(100);page.emulate_media(reduced_motion='reduce');idle(page,'start')
    assert page.locator('[data-motion-live],[data-motion-placeholder],[data-motion-entry]').count()==0
    assert not page.evaluate('document.querySelector("#scene").getAnimations({subtree:true}).some(a=>a.playState==="running")')
    page.emulate_media(reduced_motion='no-preference')
    for match_id in [m['id'] for m in context.request.get(base+'/api/state').json()['tournament']['matches'] if m['status']!='complete']:
     command('select-match',{'matchId':match_id})
     if match_id=='GF':
      command('set-final-candidates',{'ids':['song-'+str(i) for i in range(1,9)]})
      command('set-final-picks',{'audienceIds':['song-1','song-2'],'hostId':'song-3'})
      idle(page);check('song-selection','GF sealed picks')
      command('reveal-host-song');idle(page);check('start');check('song-selection','GF revealed picks')
      check('double-elimination-match','GF match');break
     m=next(m for m in context.request.get(base+'/api/state').json()['tournament']['matches'] if m['id']==match_id)
     if not m['songs']:
      if not m['candidates']:command('draw-candidates');m=next(m for m in context.request.get(base+'/api/state').json()['tournament']['matches'] if m['id']==match_id)
      command('ban-song',{'playerIndex':0,'songId':m['candidates'][0]['id']});command('ban-song',{'playerIndex':1,'songId':m['candidates'][1]['id']});command('pick-songs')
     for pi in [0,1]:
      for si in [0,1]:command('set-match-score',{'playerIndex':pi,'songIndex':si,'score':990000-pi*10000})
     command('record-result')
    report.update(live_score=True,rapid_latest=True,reduced_motion=True,transparent_captures=True,grand_final=True)
   assert not errors,errors;report.update(result='PASS',browser_errors=errors)
   (OUT/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report));browser.close()
 finally:
  process.terminate()
  try:process.wait(timeout=8)
  except subprocess.TimeoutExpired:process.kill();process.wait()
