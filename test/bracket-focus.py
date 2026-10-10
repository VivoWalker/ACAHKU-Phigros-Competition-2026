"""Command-driven round focus, outcome routing, correction and motion regression."""
import json,os,re,shutil,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results'/'bracket-focus'));OUT.mkdir(parents=True,exist_ok=True)
CODE=re.search(r'    code = """(.*?)"""',(ROOT/'test/motion-layout.py').read_text(),re.S).group(1)
AUDIT=re.search(r'TEXT_AUDIT=r"""(.*?)"""',(ROOT/'test/transition-choreography.py').read_text(),re.S).group(1)
with tempfile.TemporaryDirectory(prefix='acahku-focus-') as data:
 proc=subprocess.Popen(['node','-e',CODE,data],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  port=proc.stdout.readline().strip();assert port.isdigit();base='http://127.0.0.1:'+port
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
   options={'viewport':{'width':1920,'height':1080}}
   if os.environ.get('BRACKET_RECORD')=='1':options.update(record_video_dir=str(OUT/'video'),record_video_size={'width':1280,'height':720})
   context=browser.new_context(**options);errors=[];context.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))))
   page=context.new_page();page.goto(base+'/overlay/bracket.html');page.wait_for_selector('.bracket-board');page.evaluate('document.fonts.ready')
   page.evaluate('''async()=>{const {token}=await (await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'motion-fixture-code'})})).json();let state;const socket=io('/control',{auth:{token}});await new Promise(r=>socket.once('state',s=>{state=s;r()}));socket.on('state',s=>state=s);window.cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:state.revision,action:{type,payload:{matchId:state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(Error(r.error))));}''')
   def command(kind,payload={}):return page.evaluate('a=>cmd(a.kind,a.payload)',{'kind':kind,'payload':payload})
   def state():return context.request.get(base+'/api/state').json()
   def idle():page.wait_for_function('document.querySelector("#scene").dataset.motionPhase==="idle"&&document.querySelector(".bracket-board")?.dataset.bracketPhase==="idle"',timeout=16000)
   def audit(label):
    result=page.evaluate(AUDIT);page.screenshot(path=str(OUT/'latest.png'));assert not result['overlaps'],(label,result)
    assert page.locator('[data-bracket-ghost]').count()==0,label
   def finish(match_id):
    command('select-match',{'matchId':match_id});m=next(m for m in state()['tournament']['matches'] if m['id']==match_id)
    if match_id=='GF':
     command('set-final-candidates',{'ids':['song-'+str(i) for i in range(1,9)]});command('set-final-picks',{'audienceIds':['song-1','song-2'],'hostId':'song-3'});command('reveal-host-song')
    elif not m['songs']:
     if not m['candidates']:command('draw-candidates');m=next(m for m in state()['tournament']['matches'] if m['id']==match_id)
     command('ban-song',{'playerIndex':0,'songId':m['candidates'][0]['id']});command('ban-song',{'playerIndex':1,'songId':m['candidates'][1]['id']});command('pick-songs')
    for pi in [0,1]:
     for si in range(3 if match_id=='GF' else 2):command('set-match-score',{'playerIndex':pi,'songIndex':si,'score':990000-pi*10000})
    command('record-result');return next(m for m in state()['tournament']['matches'] if m['id']==match_id)
   live=context.new_page();live.goto(base+'/overlay/live.html');live.wait_for_selector('[data-branding="visual"]')
   idle();audit('initial');page.screenshot(path=str(OUT/'round-1.png'))
   assert page.locator('.focus-card').count()==4 and page.locator('.destination-card').count()==4
   assert page.locator('.focus-card .player-line strong').first.evaluate('e=>parseFloat(getComputedStyle(e).fontSize)')>=40
   page.evaluate('''()=>{window.__focusTrace={animations:[],overlaps:[],frames:0};const trace=__focusTrace,seen=new WeakSet();
    const visible=e=>{let opacity=1;for(let n=e;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity>.025};
    function frame(){trace.frames++;const board=document.querySelector('.bracket-board');if(board){const stage=board.getBoundingClientRect();const panels=[...board.querySelectorAll('.bracket-focus,.bracket-destinations')].filter(visible).map(e=>{const b=e.getBoundingClientRect();return {l:Math.max(b.left,stage.left),r:Math.min(b.right,stage.right),t:Math.max(b.top,stage.top),b:Math.min(b.bottom,stage.bottom)}});
     for(let i=0;i<panels.length;i++)for(let j=i+1;j<panels.length;j++){const a=panels[i],b=panels[j];if(Math.min(a.r,b.r)-Math.max(a.l,b.l)>2&&Math.min(a.b,b.b)-Math.max(a.t,b.t)>2&&trace.overlaps.length<8)trace.overlaps.push({a,b})}
     for(const a of board.getAnimations({subtree:true})){if(!seen.has(a)){seen.add(a);trace.animations.push({target:a.effect.target.className,duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing,frames:a.effect.getKeyframes().map(f=>({opacity:f.opacity,transform:f.transform,backgroundColor:f.backgroundColor}))})}}}window.__focusRaf=requestAnimationFrame(frame)}requestAnimationFrame(frame);
   }''')
   for match_id in ['W2','W5','W3']:
    finish(match_id);page.wait_for_timeout(450);assert page.locator('.bracket-board').get_attribute('data-focus-round')=='1'
    if match_id=='W5':
     page.wait_for_timeout(3600);assert page.locator('.bracket-board').get_attribute('data-focus-round')=='1';continue
    assert '晉級 勝者組' in page.locator(f'.focus-card[data-match="{match_id}"] .bracket-player.win').inner_text()
    assert '轉入 敗者組' in page.locator(f'.focus-card[data-match="{match_id}"] .bracket-player.loss').inner_text()
   finish('W4');page.wait_for_timeout(650);page.screenshot(path=str(OUT/'round-1-results.png'))
   assert page.locator('.bracket-board').get_attribute('data-focus-round')=='1'
   live.wait_for_selector('.result-row.result-win');assert '晉級' in live.locator('.result-row.result-win').inner_text()
   command('set-scene',{'scene':'bracket'})
   live.wait_for_selector('.bracket-board');assert live.locator('.bracket-board').get_attribute('data-focus-round')=='1'
   page.wait_for_function('document.querySelector(".bracket-board").dataset.focusRound==="2"',timeout=10000)
   command('set-event',{'message':'round-transition-update'});idle();audit('round 2');page.screenshot(path=str(OUT/'round-2.png'))
   assert page.locator('.focus-card').count()==4 and page.locator('.focus-card[data-match="L1"]').count()==1
   live.wait_for_function('document.querySelector(".bracket-board").dataset.focusRound==="2"',timeout=10000)
   command('set-scene',{'scene':'start'});live.wait_for_function('document.querySelector("#canvas").dataset.renderedScene==="start"');assert live.locator('[data-bracket-ghost]').count()==0
   for r,ids in [(2,['W6','L1','L2']),(3,['W7','L3','L4']),(4,['L5']),(5,['L6']),(6,['GF'])]:
    for match_id in ids:
     finish(match_id);page.wait_for_timeout(100);assert page.locator('.bracket-board').get_attribute('data-focus-round')==str(r)
     if match_id.startswith('L'):assert '淘汰' in page.locator(f'.focus-card[data-match="{match_id}"] .bracket-player.eliminated').inner_text()
    if r<6:page.wait_for_function('r=>document.querySelector(".bracket-board").dataset.focusRound===String(r)',arg=r+1,timeout=10000)
    idle();audit('after round '+str(r));page.screenshot(path=str(OUT/f'round-{min(6,r+1)}.png'))
   assert '冠軍' in page.locator('.bracket-player.champion').inner_text() and '亞軍' in page.locator('.bracket-player.runner-up').inner_text()
   trace=page.evaluate('()=>{cancelAnimationFrame(__focusRaf);return __focusTrace}');assert not trace['overlaps'],trace['overlaps']
   assert any(a['duration']==950 and any('scale(0.86)' in (f.get('transform') or '') or 'scale(.86)' in (f.get('transform') or '') for f in a['frames']) for a in trace['animations']),trace['animations'][-10:]
   assert all(a['easing'].startswith('cubic-bezier') for a in trace['animations'])
   command('reopen-result',{'matchId':'W1','reason':'browser correction test','confirmClear':True,'affectedMatchIds':['W5','L1','W7','L3','L4','L5','L6','GF']})
   idle();assert page.locator('.bracket-board').get_attribute('data-focus-round')=='1';audit('correction')
   command('rename-player',{'playerId':'p1','name':'W'*48});command('rename-player',{'playerId':'p2','name':'長'*48});idle()
   for width,height in [(1280,720),(960,540),(390,844)]:page.set_viewport_size({'width':width,'height':height});audit(str(width))
   page.set_viewport_size({'width':1920,'height':1080});finish('W1');page.wait_for_timeout(150);page.emulate_media(reduced_motion='reduce');idle()
   assert page.locator('.bracket-board').get_attribute('data-focus-round')=='2'
   history=context.new_page();history.goto(base+'/overlay/bracket.html?round=1');history.wait_for_selector('.bracket-board[data-focus-round="1"]');history.close()
   assert not page.evaluate('document.querySelector(".bracket-board").getAnimations({subtree:true}).some(a=>a.playState==="running")')
   assert not errors,errors
   report={'result':'PASS','completed_matches':14,'rounds':6,'frames':trace['frames'],'nonlinear_animations':len(trace['animations']),'panel_overlaps':0,'correction':True,'long_names':True,'reduced_motion':True,'live_reentry':True,'history_round':True,'out_of_order':True,'browser_errors':errors}
   (OUT/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
   if os.environ.get('BRACKET_RECORD')=='1':video=page.video;context.close();shutil.copyfile(video.path(),OUT/'bracket-focus.webm')
   browser.close()
 finally:
  proc.terminate();proc.wait(timeout=10)
