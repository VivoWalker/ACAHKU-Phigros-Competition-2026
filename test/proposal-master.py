import os, json, shutil, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent;OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results'/'proposal-control'));OUT.mkdir(parents=True,exist_ok=True)
CODE="""const s=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'master-ui-fixture',scorekeeperPin:'score-ui-fixture'});s.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>s.close().then(()=>process.exit()));"""
with tempfile.TemporaryDirectory(prefix='proposal-master-ui-') as tmp:
 process=subprocess.Popen(['node','-e',CODE,tmp],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  port=process.stdout.readline().strip();assert port.isdigit(),process.stderr.read();base='http://127.0.0.1:'+port
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox']);page=browser.new_page(viewport={'width':1280,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept());page.goto(base+'/control/');page.fill('#pin','master-ui-fixture');page.click('#pair-form button');page.wait_for_selector('#program-preview')
   page.evaluate("""async()=>{const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});await new Promise(resolve=>socket.once('state',s=>{window.__state=s;resolve()}));socket.on('state',s=>window.__state=s);window.__cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:window.__state.revision,action:{type,payload:{matchId:window.__state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(Error(r.error))));} """)
   def command(t,payload={}):
    r=page.evaluate('a=>window.__cmd(a.type,a.payload)',{'type':t,'payload':payload});page.wait_for_function('r=>window.__state.revision>=r',arg=r['revision']);return r
   def st():return page.evaluate('window.__state')
   def click(selector):
    before=st()['revision'];page.click(selector)
    try:page.wait_for_function('r=>window.__state.revision>r',arg=before,timeout=8000)
    except Exception:
     print('FAILED',selector,page.locator('#toast').inner_text(),flush=True);(OUT/'failure-state.json').write_text(json.dumps(st(),indent=2));page.screenshot(path=str(OUT/'failure.png'),full_page=True);raise
   def save(prefix,score,accuracy=None,counters=False):
    page.fill('#'+prefix,str(score))
    if accuracy is not None:
     page.locator('#judgements-'+prefix).evaluate('(d)=>d.open=true');page.fill('#'+prefix+'-accuracy',str(accuracy))
    if counters:
     for key,value in [('perfect',890),('good',10),('bad',1),('miss',0)]:page.fill('#'+prefix+'-'+key,str(value))
    click('form[data-prefix="'+prefix+'"] button[type=submit]')
   page.click('.tabs [data-tab="qualifiers"]');click('#plan-form button');assert st()['qualifier']['plan']=='A'
   # Number controls and sequential batches.
   page.locator('#plan-details').evaluate('(d)=>d.open=true');click('[data-draw-numbers]');page.fill('#number-p1','64');click('form[data-number-player=p1] button');assert next(p['number'] for p in st()['qualifier']['players'] if p['id']=='p1')==64
   active=st()['qualifier']['activePlayers'];click('[data-next-batch]');assert st()['qualifier']['activePlayers']!=active
   # Original ACC/counters atomic save; conflicting two-operator draft stays visible.
   save('qs-p1-0',999001,99.1234,True);assert st()['qualifier']['rounds']['A']['results']['p1']['judgements'][0]['miss']==0
   page.fill('#qs-p1-0','999002');command('set-qualifier-score',{'group':'A','playerId':'p1','songIndex':0,'score':999003,'judgements':{'accuracy':99.9}});assert page.locator('.draft-notice').inner_text().startswith('编辑冲突');assert page.input_value('#qs-p1-0')=='999002';page.click('[data-draft-resolution=server]')
   # Tie at the qualification cutoff, repeat once, then separate by ACC.
   scores={'p1':990000,'p2':980000,'p3':970000,'p4':900000,'p5':900000,'p6':800000,'p7':700000,'p8':600000}
   for id,value in scores.items():
    for i in range(3):command('set-qualifier-score',{'group':'A','playerId':id,'songIndex':i,'score':value,'judgements':{'accuracy':98}})
   page.locator('#qualifier-tiebreak-details').evaluate('(d)=>d.open=true');click('[data-draw-qualifier-tie]')
   page.locator('#referee-details').evaluate('(d)=>d.open=true');page.select_option('#rematch-player','p4');page.fill('#rematch-note','Referee verified an extra-song game error.');assert page.locator('#rematch-form').get_attribute('data-tiebreak-index')=='0';click('#rematch-form button');assert st()['qualifier']['incidents'][-1]['tiebreakIndex']==0
   for id in ['p4','p5']:save('ts-qt-'+id+'-0-0',900000,98)
   page.fill('#ts-qt-p4-0-0','900001');page.click('[data-confirm-qualifier-tie="0"]');page.wait_for_timeout(150);assert not st()['qualifier']['rounds']['A']['tiebreaks'][0]['confirmed'];assert '草稿' in page.locator('#toast').inner_text();page.fill('#ts-qt-p4-0-0','900000')
   click('[data-confirm-qualifier-tie="0"]');click('[data-draw-qualifier-tie]')
   save('ts-qt-p4-0-1',900000,99);save('ts-qt-p5-0-1',900000,98);click('[data-confirm-qualifier-tie="1"]')
   page.screenshot(path=str(OUT/'qualifiers-round-1.png'),full_page=True);click('[data-finalize-round=A]');assert st()['qualifier']['activeGroup']=='B';assert set(st()['qualifier']['rounds']['B']['playerIds'])=={'p5','p6','p7','p8'}
   for id in ['p5','p6','p7','p8']:
    for i in range(3):command('set-qualifier-score',{'group':'B','playerId':id,'songIndex':i,'score':900000-int(id[1:])*1000,'judgements':{'accuracy':97}})
   click('[data-command=qualify]');assert st()['tournament']['ruleset']=='proposal-2026';assert st()['tournament']['seeds'][:4]==['p1','p2','p3','p4']
   # Ban Pass and match tiebreaks.
   page.click('.tabs [data-tab=songs]');click('[data-command=draw-candidates]');click('[data-ban-pass="0"]');click('[data-ban-pass="1"]');assert st()['tournament']['matches'][0]['bansConfirmed']==[True,True];click('[data-command=pick-songs]')
   page.click('.tabs [data-tab=bracket]')
   for pi in range(2):
    for si in range(2):save(f'ms-W1-{pi}-{si}',900000,98)
   page.locator('#match-tiebreak-details').evaluate('(d)=>d.open=true');click('[data-command=draw-match-tiebreak]');page.locator('#referee-details').evaluate('(d)=>d.open=true');page.fill('#rematch-note','Referee verified an extra-song game error.');assert page.locator('#rematch-form').get_attribute('data-tiebreak-index')=='0';click('#rematch-form button');assert st()['tournament']['matches'][0]['rematches'][-1]['tiebreakIndex']==0;save('ts-mt-W1-0-0',900000,98);save('ts-mt-W1-1-0',900000,98);click('[data-confirm-match-tie="0"]');click('[data-command=draw-match-tiebreak]');save('ts-mt-W1-0-1',900000,99);save('ts-mt-W1-1-1',900000,98);click('[data-confirm-match-tie="1"]')
   page.locator('#result-details').evaluate('(d)=>d.open=true');click('#result-form button');assert st()['tournament']['matches'][0]['status']=='complete';page.screenshot(path=str(OUT/'bracket.png'),full_page=True)
   # Readiness and wait/cancel operator controls.
   command('select-match',{'matchId':'W2'});page.locator('#referee-details').evaluate('(d)=>d.open=true');page.select_option('#readiness-player','p4')
   for key in ['device','globalVersion','headphones','charts','streamConsent']:page.check('#ready-'+key)
   click('#readiness-form button');assert st()['qualifier']['readiness']['p4']['charts'];page.select_option('#wait-player','p4');click('#wait-form button');assert 'p4' in st()['qualifier']['waits'];click('[data-cancel-wait=p4]');assert 'p4' not in st()['qualifier']['waits']
   page.screenshot(path=str(OUT/'referee.png'),full_page=True)
   # Current editable match game-error rematch; two-player shared quota visible copy.
   command('draw-candidates');m=next(m for m in st()['tournament']['matches'] if m['id']=='W2');command('ban-song',{'playerIndex':0,'songId':m['candidates'][0]['id']});command('ban-song',{'playerIndex':1,'songId':m['candidates'][1]['id']});command('pick-songs');command('set-match-score',{'playerIndex':0,'songIndex':0,'score':990000,'judgements':{'accuracy':99}})
   page.fill('#rematch-note','Device error verified by referee');click('#rematch-form button');m=next(m for m in st()['tournament']['matches'] if m['id']=='W2');assert m['scores'][0][0] is None and len(m['rematches'])==1
   # All tabs at narrow size and expand optional editors: no document horizontal overflow.
   page.set_viewport_size({'width':390,'height':844})
   for tab in ['qualifiers','bracket','songs','event','broadcast']:
    page.click('.tabs [data-tab='+tab+']');page.wait_for_timeout(200);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),tab
   page.click('.tabs [data-tab=bracket]');page.locator('#referee-details').evaluate('(d)=>d.open=true');page.screenshot(path=str(OUT/'mobile-referee.png'),full_page=True)
   assert not errors,errors
   (OUT/'report.json').write_text(json.dumps({'result':'PASS','browser_errors':errors,'plan_A':True,'numbers_batches':True,'judgements_atomic':True,'concurrent_draft':True,'qualifier_repeat_tie':True,'match_repeat_tie':True,'ban_pass':True,'readiness_wait':True,'rematch':True,'mobile_tabs':5,'tiebreak_rematches':True,'unsaved_scores_block_confirmation':True},indent=2))
   print((OUT/'report.json').read_text());browser.close()
 finally:
  process.terminate();process.wait(timeout=15)
