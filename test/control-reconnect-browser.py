"""Old main-control commands must not survive a connection change.

Uses isolated temporary event data and fixture pairing codes only.
"""
import json, os, selectors, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'control-reconnect'))
OUT.mkdir(parents=True, exist_ok=True)
SERVER="""
const {createBroadcastServer}=require('./server');
const server=createBroadcastServer({dataDir:process.argv[1],pin:'review-fixture-main',scorekeeperPin:'review-fixture-scorer'});
server.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>server.close().then(()=>process.exit()));
"""
with tempfile.TemporaryDirectory(prefix='review-reconnect-') as d:
 p=subprocess.Popen(['node','-e',SERVER,d],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ)
  assert sel.select(15), 'server did not start'
  port=p.stdout.readline().strip();base='http://127.0.0.1:'+port
  with sync_playwright() as pw:
   browser=pw.chromium.launch(executable_path=os.environ.get('CHROME_BINARY') or '/usr/bin/chromium',headless=True,args=['--no-sandbox'])
   page=browser.new_page()
   page.add_init_script("""let factory;Object.defineProperty(window,'createBroadcastSocket',{get(){return factory},set(f){factory=(...args)=>{const s=f(...args);if(args[0]==='/control')window.__control=s;return s}}});""")
   page.goto(base+'/control/')
   page.fill('#pin','review-fixture-main');page.click('#pair-form button');page.wait_for_selector('#program-preview')
   page.evaluate("""() => {
     const s=window.__control,orig=s.emit;window.__commands=[];
     s.emit=function(name,...args){if(name==='command'){
       window.__commands.push(args[0].action.type+':'+args[0].action.payload.scene);
       if(window.__commands.length===1){const cb=args.at(-1);args[args.length-1]=(...values)=>{window.__held=()=>cb(...values)}}
     }return orig.call(this,name,...args)};
     document.querySelector('[data-scene="qualifier-waiting"]').click();
     document.querySelector('[data-scene="result"]').click();
   }""")
   page.wait_for_function('typeof window.__held==="function"')
   page.evaluate('window.__control.disconnect()')
   # Another operator switches the live scene while this panel is disconnected.
   page.evaluate("""async () => {
     const token=sessionStorage.getItem('broadcast-token');const other=io('/control',{forceNew:true,auth:{token}});
     const state=await new Promise(r=>other.once('state',r));
     const result=await new Promise(r=>other.emit('command',{expectedRevision:state.revision,action:{type:'set-scene',payload:{scene:'start'}}},r));
     if(!result.ok)throw Error(JSON.stringify(result));other.disconnect();
   }""")
   page.evaluate('window.__control.connect()');page.wait_for_function('window.__control.connected')
   page.wait_for_timeout(100)
   page.evaluate('window.__held()')
   page.wait_for_timeout(150)
   report=page.evaluate("""async()=>({commands:window.__commands,scene:(await fetch('/api/state').then(r=>r.json())).scene})""")
   assert report['commands']==['set-scene:qualifier-waiting'], report
   assert report['scene']=='start', report
   # A new, deliberate command after synchronization still works.
   page.evaluate("document.querySelector('[data-scene=\"qualifier-waiting\"]').click()")
   page.wait_for_function("async()=> (await fetch('/api/state').then(r=>r.json())).scene==='qualifier-waiting'")
   report['new_command_succeeded']=True
   # Restores wait for the same command queue before starting an HTTP mutation.
   # A connection change must cancel that waiting operation as well.
   requests=[]
   page.on('request',lambda request: requests.append(request.url) if '/api/restore' in request.url else None)
   page.on('dialog',lambda dialog: dialog.accept())
   page.locator('[data-tab="event"]').click()
   page.evaluate('window.__commands=[];window.__held=null')
   page.fill('#event-title','Pending save fixture')
   page.locator('#event-form button[type="submit"]').click()
   page.wait_for_function('typeof window.__held==="function"')
   page.locator('[data-load-backups]').click()
   page.wait_for_function('document.querySelector("#backup-id").options.length>1')
   page.locator('[data-preview-backup]').click()
   page.wait_for_selector('#restore-reason')
   page.fill('#restore-reason','Fixture restore must require a current connection')
   page.evaluate('''() => {document.querySelector('#restore-form').requestSubmit();window.__control.disconnect();window.__control.connect();}'''
   )
   page.wait_for_function('window.__control.connected')
   page.wait_for_timeout(100)
   page.evaluate('window.__held()')
   page.wait_for_timeout(150)
   assert requests==[], requests
   assert page.input_value('#restore-reason')=='Fixture restore must require a current connection'
   report['queued_restore_cancelled']=True
   (OUT/'report.json').write_text(json.dumps(report,indent=2))
   print(json.dumps(report))
   browser.close()
 finally:
  p.terminate()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait()
