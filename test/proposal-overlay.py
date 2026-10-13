"""Proposal-mode OBS text, song context, layering and geometry in a private event.
Requires Playwright and Chromium. BROADCAST_TEST_OUTPUT selects artifacts.
"""
import ast, json, os, selectors, shutil, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results'/'proposal-overlay'));OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'test/transition-choreography.py').read_text())
TEXT_AUDIT=next(ast.literal_eval(node.value) for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='TEXT_AUDIT' for t in node.targets))
SERVER="""const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'proposal-overlay-fixture',scorekeeperPin:'proposal-score-fixture'});
require('./test/helpers/song-library').expandSongLibrary(app.store.state);
app.store.write(app.store.state);
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>app.close().then(()=>process.exit()));"""
report={'checks':[],'browser_errors':[],'viewports':[1920,960]}
with tempfile.TemporaryDirectory(prefix='proposal-overlay-') as directory:
 server=subprocess.Popen(['node','-e',SERVER,directory],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  with selectors.DefaultSelector() as ready:
   ready.register(server.stdout,selectors.EVENT_READ);assert ready.select(12),'Fixture startup timeout'
  port=server.stdout.readline().strip();assert port.isdigit(),port
  base='http://127.0.0.1:'+port
  with sync_playwright() as pw:
   browser=pw.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
   context=browser.new_context(viewport={'width':1920,'height':1080},reduced_motion='reduce')
   crew=context.new_page();crew.goto(base+'/control/');crew.fill('#pin','proposal-overlay-fixture');crew.click('#pair-form button');crew.wait_for_selector('#program-preview')
   crew.evaluate("""async()=>{const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});await new Promise(r=>socket.once('state',s=>{window.__state=s;r()}));socket.on('state',s=>window.__state=s);window.cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:window.__state.revision,action:{type,payload:{matchId:window.__state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(Error(r.error))));}""")
   page=context.new_page();page.on('pageerror',lambda e:report['browser_errors'].append(str(e)));page.goto(base+'/overlay/live.html');page.wait_for_selector('[data-branding=visual]');page.evaluate('document.fonts.ready')
   def command(kind,payload=None):
    ack=crew.evaluate('a=>cmd(a.kind,a.payload)',{'kind':kind,'payload':payload or {}})
    crew.wait_for_function('r=>window.__state.revision>=r',arg=ack['revision'])
    page.wait_for_function('r=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=r',arg=ack['revision']);return ack
   def state():return crew.evaluate('window.__state')
   def audit(label,expect=None):
    page.wait_for_function('document.querySelector("#scene").dataset.motionPhase==="idle"')
    if expect:assert expect in page.locator('#scene').inner_text(),(label,expect)
    for width in [1920,960]:
     page.set_viewport_size({'width':width,'height':round(width*9/16)})
     page.wait_for_function('Math.abs(document.querySelector("#canvas").getBoundingClientRect().width - Math.min(innerWidth, innerHeight*16/9)) < .5')
     text=page.evaluate(TEXT_AUDIT);assert not text['overlaps'],(label,width,text['overlaps'])
     geometry=page.evaluate("""()=>{const logos=[...document.querySelectorAll('[data-motion-branding] img')];const rects=logos.map(e=>e.getBoundingClientRect());const bad=[];for(let i=0;i<rects.length;i++){const a=rects[i];if(a.left<0||a.top<0||a.right>innerWidth+.5||a.bottom>innerHeight+.5)bad.push('logo outside');for(let j=i+1;j<rects.length;j++){const b=rects[j];if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)bad.push('logo overlap');}}return bad}""")
     assert not geometry,(label,width,geometry)
     assert page.locator('[data-motion-branding] img').count()==3
    page.set_viewport_size({'width':1920,'height':1080});page.wait_for_function('Math.abs(document.querySelector("#canvas").getBoundingClientRect().width-1920)<.5');page.screenshot(path=str(OUT/(label+'.png')));report['checks'].append(label)
   command('set-qualifier-plan',{'plan':'auto'})
   for n in range(1,9):
    for si in range(3):command('set-qualifier-score',{'group':'A','playerId':'p'+str(n),'songIndex':si,'score':1000000-(4 if n==5 else n)*1000,'judgements':{'accuracy':99}})
   for scene in ['qualifier-waiting','qualifier-match','result']:
    command('set-scene',{'scene':scene});audit('plan-A-'+scene,'Qualifier Round 1')
   command('draw-qualifier-tiebreak',{'group':'A','playerIds':['p4','p5']})
   for scene in ['qualifier-waiting','qualifier-match']:
    command('set-scene',{'scene':scene});audit('qualifier-tiebreak-'+scene,'TIEBREAK 1')
    assert state()['qualifier']['rounds']['A']['tiebreaks'][-1]['song']['title'] in page.locator('#scene').inner_text()
   for n in [4,5]:command('set-qualifier-tiebreak-score',{'group':'A','index':0,'playerId':'p'+str(n),'score':1000000-n,'judgements':{'accuracy':99}})
   command('confirm-qualifier-tiebreak',{'group':'A','index':0,'verified':True});command('finalize-qualifier-round',{'group':'A','verified':True})
   for scene in ['qualifier-waiting','qualifier-match','result']:
    command('set-scene',{'scene':scene});audit('revival-'+scene,'Revival Round')
   assert all(row['scores']==[None,None,None] for row in state()['qualifier']['rounds']['B']['results'].values())
   for n in range(5,9):
    for si in range(3):command('set-qualifier-score',{'group':'B','playerId':'p'+str(n),'songIndex':si,'score':900000-n*1000,'judgements':{'accuracy':99}})
   command('qualify',{'verified':True})
   def choose(mid):
    command('select-match',{'matchId':mid});command('draw-candidates')
    for pi in [0,1]:command('ban-song',{'playerIndex':pi,'songId':None,'confirmed':True})
    command('pick-songs')
   def fill(tied=False,acc=(99,99)):
    for pi in [0,1]:
     for si in [0,1]:command('set-match-score',{'playerIndex':pi,'songIndex':si,'score':990000 if tied else 990000-pi*1000,'judgements':{'accuracy':acc[pi]}})
   choose('W1');fill(True)
   command('set-scene',{'scene':'song-selection'});audit('ban-pass-selection','PASS')
   command('draw-match-tiebreak')
   for scene in ['double-elimination-waiting','double-elimination-match','song-selection']:
    command('set-scene',{'scene':scene});audit('match-tiebreak-'+scene,'TIEBREAK 1')
    match=state()['tournament']['matches'][0];assert match['tiebreaks'][-1]['song']['title'] in page.locator('#scene').inner_text()
   for pi in [0,1]:command('set-match-tiebreak-score',{'index':0,'playerIndex':pi,'score':980000,'judgements':{'accuracy':98+pi*.1}})
   command('confirm-match-tiebreak',{'index':0,'verified':True});command('record-result',{'verified':True});audit('tiebreak-result','TIEBREAK WINNER')
   previous_page=page;page=context.new_page();page.on('pageerror',lambda e:report['browser_errors'].append(str(e)));page.goto(base+'/overlay/bracket.html?round=2');page.wait_for_selector('[data-branding=visual]');page.evaluate('document.fonts.ready');audit('pending-reseeded-field','種子配對待定');page.close();page=previous_page
   command('rename-player',{'playerId':'p8','name':'Long competitor name for final readability check'})
   audit('long-name-tiebreak-result','TIEBREAK WINNER')
   choose('W2');fill(True,(99,98));command('record-result',{'verified':True});audit('accuracy-result','WIN ON ACCURACY')
   for mid in ['W3','W4']:choose(mid);fill();command('record-result',{'verified':True})
   command('set-scene',{'scene':'bracket'});audit('reseeded-bracket')
   command('set-broadcast-display',{'showHandcams':True});choose('W5');command('set-scene',{'scene':'double-elimination-match'});audit('proposal-dual-match')
   rules=context.new_page();rules.goto(base+'/rules/');assert rules.locator('h1').inner_text()=='ACAHKU Phigros Competition'
   for width in [1280,390]:
    rules.set_viewport_size({'width':width,'height':900});assert rules.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   assert rules.locator('html').get_attribute('lang')=='en';report['checks'].append('English rules desktop/mobile')
   assert not report['browser_errors'],report['browser_errors'];browser.close()
  report['result']='PASS';(OUT/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
 finally:
  server.terminate()
  try:server.communicate(timeout=8)
  except subprocess.TimeoutExpired:server.kill();server.communicate()
