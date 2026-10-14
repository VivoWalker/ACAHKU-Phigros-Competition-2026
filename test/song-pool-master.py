import os, json, shutil, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent; OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results'/'song-pool-control')); OUT.mkdir(parents=True,exist_ok=True)
CODE="""const fs=require('node:fs'),path=require('node:path');const {createDefaultState}=require('./test/helpers/legacy-state');const s=createDefaultState();s.library=Array.from({length:Number(process.argv[2])},(_,i)=>({id:'song-'+(i+1),title:'Fixture track '+(i+1),artist:'Fixture artist',difficulty:'IN',level:15,art:'assets/song/cover-1.svg',eligible:true}));s.library.push({...s.library[0],id:'alias-chart',difficulty:'HD'});s.library.push(...Array.from({length:6},(_,i)=>({id:'final-'+(i+1),title:'Final fixture track '+(i+1),artist:'Fixture artist',difficulty:'IN',level:16,art:'assets/song/cover-2.svg',eligible:false})));if(process.argv[3]==='stale'){const t=require('./lib/tournament');s.tournament=t.createBracket(s.qualifier.players.map(p=>p.id),{ruleset:'proposal-2026'});s.stage='double-elimination';for(const m of s.tournament.matches.filter(m=>['W1','W2','W3'].includes(m.id)))m.candidates=s.library.slice(0,6).map(x=>({...x}));for(const [id,index] of [['W2',0],['W3',2]]){const m=s.tournament.matches.find(m=>m.id===id);m.songs=m.candidates.slice(index,index+2);m.bansConfirmed=[true,true];}const first=s.tournament.matches.find(m=>m.id==='W1');first.bans=['song-5','song-6'];first.bansConfirmed=[true,true];t.resolveBracket(s);}fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(s));const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'pool-ui-dummy-main',scorekeeperPin:'pool-ui-dummy-scorer'});app.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>app.close().then(()=>process.exit()));"""
errors=[];results={}
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
 for mode,count in [('shortage',6),('full-bracket',30),('stale',6)]:
  with tempfile.TemporaryDirectory(prefix='pool-ui-') as tmp:
   process=subprocess.Popen(['node','-e',CODE,tmp,str(count),mode],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   try:
    port=process.stdout.readline().strip();assert port.isdigit(),process.stderr.read();page=browser.new_page(viewport={'width':1280,'height':900});page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept());page.goto('http://127.0.0.1:'+port+'/control/');page.fill('#pin','pool-ui-dummy-main');page.click('#pair-form button');page.wait_for_selector('#program-preview')
    page.evaluate("""async()=>{const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});await new Promise(resolve=>socket.once('state',s=>{window.__state=s;resolve()}));socket.on('state',s=>window.__state=s);window.__cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:window.__state.revision,action:{type,payload:{matchId:window.__state.tournament.currentMatchId,...payload}}},r=>r.ok?resolve(r):reject(Error(r.error))));} """)
    def st():return page.evaluate('window.__state')
    def command(t,payload={}):
     r=page.evaluate('a=>window.__cmd(a.type,a.payload)',{'type':t,'payload':payload});page.wait_for_function('r=>window.__state.revision>=r',arg=r['revision']);return r
    def click(sel):
     r=st()['revision'];page.click(sel);page.wait_for_function('r=>window.__state.revision>r',arg=r,timeout=10000)
    def current():return next(m for m in st()['tournament']['matches'] if m['id']==st()['tournament']['currentMatchId'])
    if mode!='stale':command('seed-bracket',{'ids':['p'+str(i) for i in range(1,9)],'ruleset':'proposal-2026'})
    page.click('.tabs [data-tab=songs]');page.wait_for_selector('.song-pool-status');assert page.locator('.song-pool-metrics strong').all_text_contents()==([str(count),'4','2'] if mode=='stale' else [str(count),'0',str(count)])
    assert '30 首' in page.locator('.song-pool-status').inner_text() and '42 首' in page.locator('.song-pool-status').inner_text()
    if mode=='shortage':
     click('[data-command=draw-candidates]');click('[data-ban-pass="0"]');click('[data-ban-pass="1"]');click('[data-command=pick-songs]');used=[s['id'] for s in current()['songs']]
     command('select-match',{'matchId':'W2'});assert page.locator('[data-command=draw-candidates]').is_disabled();assert '不足 6 首候選' in page.locator('.song-pool-status').inner_text()
     page.screenshot(path=str(OUT/'shortage-desktop.png'),full_page=True)
     command('select-match',{'matchId':'W1'});command('reset-current-match');command('select-match',{'matchId':'W2'});assert page.locator('[data-command=draw-candidates]').is_disabled()
     for w in [1280,768,390,320]:
      page.set_viewport_size({'width':w,'height':900});page.wait_for_timeout(180);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),w
      boxes=page.locator('.song-pool-metrics>div').evaluate_all('(els)=>els.map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom}})');assert all(not(a['x']<b['right'] and b['x']<a['right'] and a['y']<b['bottom'] and b['y']<a['bottom']) for i,a in enumerate(boxes) for b in boxes[i+1:]),boxes
     page.screenshot(path=str(OUT/'shortage-mobile.png'),full_page=True);results['shortage_disabled_after_reset']=True;results['dedup_chart_identity']=True;results['responsive_metrics_no_overlap']=[1280,768,390,320]
    elif mode=='stale':
     assert page.locator('.candidate-row.unavailable').count()==4
     assert page.locator('[data-command=pick-songs]').is_disabled()
     assert page.locator('[data-ban-song="song-1"][data-ban-player="0"]').is_disabled()
     assert '禁選後不足 2 首' in page.locator('#content').inner_text()
     click('[data-ban-pass="0"]');click('[data-ban-pass="1"]');assert page.locator('[data-command=pick-songs]').is_enabled();click('[data-command=pick-songs]');assert {song['id'] for song in current()['songs']}=={'song-5','song-6'}
     results['stale_candidates_marked_used']=True;results['stale_ban_and_insufficient_picks_disabled']=True;results['stale_pick_filters_only_used_songs']=True
     page.screenshot(path=str(OUT/'stale-candidates.png'),full_page=True)
     for w in [1280,768,390,320]:
      page.set_viewport_size({'width':w,'height':900});page.wait_for_timeout(180);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),w
      overlaps=page.locator('.candidate-row').evaluate_all('''els=>els.map(el=>{const b=el.querySelector('.ban-actions').getBoundingClientRect();return [...el.querySelectorAll('.song-info,.song-use-label,.song-preview-button')].some(node=>{const a=node.getBoundingClientRect();return a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom})}).filter(Boolean)''');assert not overlaps,{'viewport':w,'candidate_overlaps':overlaps}
     results['used_candidate_labels_no_overlap']=[1280,768,390,320]
     page.screenshot(path=str(OUT/'stale-candidates-mobile.png'),full_page=True)
    else:
     played=[]
     for n in range(13):
      ready=next(m for m in st()['tournament']['matches'] if m['status'] in ['ready','live'] and m['id']!='GF');command('select-match',{'matchId':ready['id']});click('[data-command=draw-candidates]');assert len(current()['candidates'])==6
      click('[data-ban-pass="0"]');click('[data-ban-pass="1"]');click('[data-command=pick-songs]');chosen=[s['id'] for s in current()['songs']];assert len(set(played+chosen))==len(played)+2;played+=chosen
      for pi in range(2):
       for si in range(2):command('set-match-score',{'playerIndex':pi,'songIndex':si,'score':990000-pi})
      command('record-result',{'verified':True})
     assert len(set(played))==26
     command('select-match',{'matchId':'GF'});page.wait_for_selector('#final-candidates-form');assert page.locator('#final-candidates-form select').count()==6
     ids=page.locator('#final-candidate-0 option').evaluate_all('(els)=>els.map(e=>e.value).filter(Boolean)');assert not set(ids)&set(played);assert len(ids)==10
     for i in range(6):page.select_option('#final-candidate-'+str(i),'final-'+str(i+1))
     click('#final-candidates-form button');click('#final-picks-form button');assert len(current()['songs'])==3
     page.screenshot(path=str(OUT/'gf-available-only.png'),full_page=True)
     page.click('.tabs [data-tab=event]');assert page.locator('.song-pool-metrics strong').all_text_contents()==['30','26','4'];results['thirteen_matches_thirty_song_minimum']=True;results['gf_dropdown_excludes_played']=True;results['gf_separate_pool']=True
    page.close()
   finally:process.terminate();process.wait(timeout=15)
 browser.close()
assert not errors,errors
results.update(result='PASS',browser_errors=errors);(OUT/'report.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
