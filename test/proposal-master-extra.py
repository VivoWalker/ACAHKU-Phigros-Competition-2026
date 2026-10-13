import os, json,shutil,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent;OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results'/'proposal-control'));OUT.mkdir(parents=True,exist_ok=True)
CODE="""const s=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'master-extra-fixture',scorekeeperPin:'score-extra-fixture'});
require('./test/helpers/song-library').expandSongLibrary(s.store.state);
s.store.write(s.store.state);
s.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>s.close().then(()=>process.exit()));"""
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox']);errors=[];results={}
 for mode in ['plan-B-DQ','proposal-GF6','legacy-GF8']:
  with tempfile.TemporaryDirectory(prefix='master-extra-') as tmp:
   process=subprocess.Popen(['node','-e',CODE,tmp],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   try:
    port=process.stdout.readline().strip();assert port.isdigit(),process.stderr.read();base='http://127.0.0.1:'+port;page=browser.new_page(viewport={'width':1280,'height':900});page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept());page.goto(base+'/control/');page.fill('#pin','master-extra-fixture');page.click('#pair-form button');page.wait_for_selector('#program-preview')
    page.evaluate("""async()=>{const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});await new Promise(resolve=>socket.once('state',s=>{window.__state=s;resolve()}));socket.on('state',s=>window.__state=s);window.__cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:window.__state.revision,action:{type,payload:{matchId:window.__state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(Error(r.error))));} """)
    def st():return page.evaluate('window.__state')
    def command(t,payload={}):return page.evaluate('a=>window.__cmd(a.type,a.payload)',{'type':t,'payload':payload})
    def click(sel):
     r=st()['revision'];page.click(sel)
     try:page.wait_for_function('r=>window.__state.revision>r',arg=r,timeout=10000)
     except Exception:print('FAILED',mode,sel,page.locator('#toast').inner_text(),flush=True);raise
    if mode=='plan-B-DQ':
     page.click('.tabs [data-tab=qualifiers]');page.fill('#competition-roster','\n'.join(['Player '+str(i).zfill(2) for i in range(1,22)]));click('#competition-roster-form button');click('#plan-form button');assert st()['qualifier']['plan']=='B';assert len(st()['qualifier']['rounds']['A']['playerIds'])==11
     assert 'Odd numbers' in page.locator('.page-heading').inner_text();click('[data-group=B]');assert 'Even numbers' in page.locator('.page-heading').inner_text();assert all(p['number']%2==0 for p in st()['qualifier']['players'] if p['id'] in st()['qualifier']['rounds']['B']['playerIds'])
     # Tiebreak-aware active displays and round change draft isolation.
     click('[data-next-batch]');ids=st()['qualifier']['activePlayers'];assert len(ids)==3
     page.fill('#qs-p2-0','123456');click('[data-group=A]');assert not page.locator('#qs-p2-0').count();click('[data-group=B]');assert page.input_value('#qs-p2-0')=='123456';page.fill('#qs-p2-0','');assert not page.locator('.draft-notice').count()
     page.locator('#referee-details').evaluate('(d)=>d.open=true');page.select_option('#dq-player','p2');page.select_option('#dq-reason','headphones');page.fill('#dq-note','Referee confirmed headphones refusal');click('#dq-form button');assert next(p for p in st()['qualifier']['players'] if p['id']=='p2')['disqualification']['reason']=='headphones';assert not page.locator('#active-0 option[value=p2]').count();assert not page.locator('#qs-p2-0').count();page.screenshot(path=str(OUT/'plan-B-referee-DQ.png'),full_page=True)
     results[mode]=True
    else:
     if mode=='proposal-GF6':command('set-qualifier-plan',{'plan':'auto'})
     page.click('.tabs [data-tab=bracket]');page.locator('#seed-details').evaluate('(d)=>d.open=true') if page.locator('#seed-details').count() else None
     for i in range(8):page.select_option('#seed-'+str(i),'p'+str(i+1))
     if mode=='proposal-GF6':page.fill('#seed-note','ACA approved this eight-player fixture seed order.')
     click('#seed-form button')
     while True:
      ready=next(m for m in st()['tournament']['matches'] if m['status'] in ['ready','live']);command('select-match',{'matchId':ready['id']})
      if ready['id']=='GF':break
      command('draw-candidates')
      if mode=='proposal-GF6':
       command('ban-song',{'playerIndex':0,'songId':None,'confirmed':True});command('ban-song',{'playerIndex':1,'songId':None,'confirmed':True})
      else:
       m=next(m for m in st()['tournament']['matches'] if m['id']==ready['id']);command('ban-song',{'playerIndex':0,'songId':m['candidates'][0]['id']});command('ban-song',{'playerIndex':1,'songId':m['candidates'][1]['id']})
      command('pick-songs')
      for pi in range(2):
       for si in range(2):command('set-match-score',{'playerIndex':pi,'songIndex':si,'score':900001-pi})
      command('record-result',{'verified':True})
     page.click('.tabs [data-tab=songs]');count=6 if mode=='proposal-GF6' else 8;assert page.locator('#final-candidates-form select').count()==count;click('#final-candidates-form button');assert len(next(m for m in st()['tournament']['matches'] if m['id']=='GF')['candidates'])==count;click('#final-picks-form button');m=next(m for m in st()['tournament']['matches'] if m['id']=='GF');assert len(m['songs'])==3 and not m['hostRevealed'];click('[data-reveal-host]');assert next(m for m in st()['tournament']['matches'] if m['id']=='GF')['hostRevealed'];page.screenshot(path=str(OUT/(mode+'.png')),full_page=True);results[mode]=True
    page.close()
   finally:process.terminate();process.wait(timeout=15)
 assert not errors,errors
 results.update(result='PASS',browser_errors=errors);(OUT/'extra-report.json').write_text(json.dumps(results,indent=2));print(json.dumps(results));browser.close()
