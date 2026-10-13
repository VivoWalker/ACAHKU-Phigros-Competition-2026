import os, json, shutil, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT/'test-results'/'control-tiebreak-correction'));OUT.mkdir(parents=True,exist_ok=True)
CODE="""const s=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'correction-fixture-main',scorekeeperPin:'correction-fixture-score'});const c=(type,payload={})=>s.store.commit({type,payload},s.store.state.revision);c('set-qualifier-plan',{plan:'A'});[1000,900,800,700,700,600,500,400].forEach((score,i)=>{for(let songIndex=0;songIndex<3;songIndex++)c('set-qualifier-score',{group:'A',playerId:'p'+(i+1),songIndex,score,judgements:{accuracy:99}})});c('draw-qualifier-tiebreak',{group:'A',playerIds:['p4','p5']});s.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>s.close().then(()=>process.exit()));"""
RACE="""(async()=>{const {io}=require('socket.io-client');const url=process.argv[1];const r=await fetch(url+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'correction-fixture-main'})});const {token}=await r.json();const s=io(url+'/control',{auth:{token},forceNew:true,reconnection:false});s.once('state',state=>s.emit('command',{expectedRevision:state.revision,action:{type:'set-event',payload:{venue:'CONCURRENT TEST CHANGE'}}},result=>{s.close();if(!result.ok)throw Error(result.error);console.log(result.revision)}));})().catch(e=>{console.error(e);process.exitCode=1});"""
with tempfile.TemporaryDirectory(prefix='acahku-control-correction-') as tmp:
 process=subprocess.Popen(['node','-e',CODE,tmp],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  port=process.stdout.readline().strip();assert port.isdigit(),process.stderr.read();base='http://127.0.0.1:'+port
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox']);page=browser.new_page(viewport={'width':1280,'height':900});errors=[];dialogs=[];mode=['cancel-prompt'];reason='Referee checked original score image and corrected input.'
   page.on('pageerror',lambda e:errors.append(str(e)))
   def dialog(d):
    dialogs.append({'type':d.type,'message':d.message,'default':d.default_value})
    if d.type=='prompt':
     if mode[0]=='cancel-prompt':d.dismiss()
     else:d.accept('short' if mode[0]=='short-reason' else reason)
    elif d.type=='confirm':
     if mode[0]=='stale':
      r=subprocess.run(['node','-e',RACE,base],cwd=ROOT,check=True,capture_output=True,text=True,timeout=15);assert r.stdout.strip().isdigit()
     if mode[0] in ['cancel-confirm','backup-confirm']:d.dismiss()
     else:d.accept()
    else:raise AssertionError(d.type)
   page.on('dialog',dialog);page.goto(base+'/control/');page.fill('#pin','correction-fixture-main');page.click('#pair-form button');page.wait_for_selector('#program-preview')
   page.evaluate("""async()=>{const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});await new Promise(resolve=>socket.once('state',s=>{window.__state=s;resolve()}));socket.on('state',s=>window.__state=s);window.__cmd=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:window.__state.revision,action:{type,payload}},r=>r.ok?resolve(r):reject(Error(r.error))));}""")
   def st():return page.evaluate('window.__state')
   def command(t,payload={}):
    r=page.evaluate('a=>window.__cmd(a.type,a.payload)',{'type':t,'payload':payload});page.wait_for_function('r=>window.__state.revision>=r',arg=r['revision']);return r
   def submit(prefix, changed=True):
    before=st()['revision'];page.click('form[data-prefix="'+prefix+'"] button[type=submit]');page.wait_for_timeout(200)
    if changed:page.wait_for_function('r=>window.__state.revision>r',arg=before)
   page.click('.tabs [data-tab=qualifiers]');page.locator('#qualifier-tiebreak-details').evaluate('(d)=>d.open=true')
   # Editing a pending extra song uses the ordinary score form without correction prompts.
   page.fill('#ts-qt-p4-0-0','900000');submit('ts-qt-p4-0-0');assert not dialogs
   command('set-qualifier-tiebreak-score',{'group':'A','playerId':'p5','index':0,'score':800000});command('confirm-qualifier-tiebreak',{'group':'A','index':0,'verified':True})
   # A no-op base save neither prompts nor discards confirmed extra-song results.
   submit('qs-p4-0');assert not dialogs;assert st()['qualifier']['rounds']['A']['tiebreaks'][0]['confirmed']
   before=st()['revision'];page.fill('#qs-p4-0','701');page.locator('#toast').evaluate('(el)=>el.className=""')
   mode[0]='cancel-prompt';submit('qs-p4-0',False);assert st()['revision']==before;assert page.input_value('#qs-p4-0')=='701';assert '分数与 ACC 已保存' not in page.locator('#toast').inner_text() or 'visible' not in page.locator('#toast').get_attribute('class')
   mode[0]='short-reason';submit('qs-p4-0',False);assert st()['revision']==before;assert '8–500' in page.locator('#toast').inner_text()
   mode[0]='cancel-confirm';submit('qs-p4-0',False);assert st()['revision']==before;assert len(st()['qualifier']['rounds']['A']['tiebreaks'])==1
   mode[0]='stale';submit('qs-p4-0',False);page.wait_for_function('r=>window.__state.revision>r',arg=before);assert st()['qualifier']['rounds']['A']['results']['p4']['scores'][0]==700;assert len(st()['qualifier']['rounds']['A']['tiebreaks'])==1;assert page.input_value('#qs-p4-0')=='701';assert '版本' in page.locator('#toast').inner_text()
   mode[0]='accept';submit('qs-p4-0');assert not st()['qualifier']['rounds']['A']['tiebreaks'];record=st()['qualifier']['adjudications'][-1];assert record['reason']==reason;assert record['invalidatedTiebreaks'][0]['confirmed'];assert record['previousScore']==700;assert not page.locator('.draft-notice').count();assert dialogs[-2]['default']==reason
   # Backup controls distinguish base scores, extra-song scores and verified extra songs.
   page.click('.tabs [data-tab=event]');page.click('[data-load-backups]');page.wait_for_function('document.querySelectorAll("#backup-id option").length>1');labels=page.locator('#backup-id').inner_text();assert '基础 24 / 加赛 2 分数' in labels and '已确认加赛 1' in labels
   page.click('[data-preview-backup]');page.wait_for_selector('[data-backup-qualifier-counts]');summary=page.locator('[data-backup-qualifier-counts]').inner_text();assert '基础 24 个分数' in summary and '加赛 2 个分数' in summary and '1 场加赛已确认' in summary
   page.fill('#restore-reason','Fixture validation only: cancelled restoration');mode[0]='backup-confirm';page.click('#restore-form button');page.wait_for_timeout(100);assert '基础 24 个分数' in dialogs[-1]['message'] and '加赛 2 个分数' in dialogs[-1]['message'];assert page.input_value('#restore-reason').startswith('Fixture')
   layouts=[]
   for width in [1280,768,390,320]:
    page.set_viewport_size({'width':width,'height':900});page.wait_for_timeout(80)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),width
    checks=page.evaluate("""()=>[...document.querySelectorAll('[data-backup-qualifier-counts],[data-backup-match-counts],#backup-id,#restore-reason')].map(el=>{const r=el.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,viewport:innerWidth}})""");assert all(x['left']>=0 and x['right']<=width+1 for x in checks),checks;layouts.append({'width':width,'checks':checks})
   page.screenshot(path=str(OUT/'mobile-backup-summary.png'),full_page=True);assert not errors,errors
   report={'result':'PASS','browser_errors':errors,'pending_tiebreak_editor_no_correction_dialog':True,'base_noop_preserves_tiebreak_no_dialog':True,'cancel_prompt_keeps_draft':True,'short_reason_rejected':True,'cancel_confirm_keeps_draft':True,'concurrent_change_rejected_no_retry':True,'explicit_correction_archives_confirmed_tiebreak':True,'reason_preserved_on_retry':True,'backup_list_preview_confirmation_disclose_counts':True,'backup_mobile_geometries':layouts,'dialogs':dialogs};(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2));browser.close()
 finally:
  process.terminate();process.wait(timeout=15)
