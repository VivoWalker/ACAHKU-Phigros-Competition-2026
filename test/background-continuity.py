"""Background identity/pixels and transition work, using temporary event data."""
import io,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results'/'background'));OUT.mkdir(parents=True,exist_ok=True)
CODE=re.search(r'    code = """(.*?)"""',(ROOT/'test/motion-layout.py').read_text(),re.S).group(1)
with tempfile.TemporaryDirectory(prefix='acahku-background-') as data:
 proc=subprocess.Popen(['node','-e',CODE,data],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  port=proc.stdout.readline().strip();assert port.isdigit();base='http://127.0.0.1:'+port
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
   context=browser.new_context(viewport={'width':1920,'height':1080});page=context.new_page()
   page.add_init_script('''let motion;Object.defineProperty(window,'BroadcastMotion',{get:()=>motion,set:value=>{
    motion=value;const create=value.createScene;value.createScene=(...args)=>{const c=create(...args),update=c.update;
    c.update=(...args)=>{const t=performance.now(),r=update(...args);(window.__updates??=[]).push(performance.now()-t);return r};return c};}});''')
   page.goto(base+'/overlay/live.html');page.wait_for_selector('[data-branding="visual"]')
   def idle():page.wait_for_function('document.querySelector("#scene").dataset.motionPhase==="idle"')
   page.evaluate('document.fonts.ready');idle()
   page.evaluate('''async()=>{const {token}=await (await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'motion-fixture-code'})})).json();let state;const socket=io('/control',{auth:{token}});await new Promise(r=>socket.once('state',s=>{state=s;r()}));socket.on('state',s=>state=s);window.cmd=scene=>new Promise((resolve,reject)=>socket.emit('command',{expectedRevision:state.revision,action:{type:'set-scene',payload:{scene}}},r=>r.ok?resolve(r):reject(Error(r.error))));
    window.__background=document.querySelector('.broadcast-backdrop');window.__art=__background.querySelector('image');window.__updates=[];
    window.__detached=0;window.__mutations=0;new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)if(n===__background||n.contains?.(__background))window.__detached++;window.__mutations+=records.length}).observe(document.querySelector('#canvas'),{subtree:true,attributes:true,childList:true});
   }''')
   def pixel():return Image.open(io.BytesIO(page.screenshot(clip={'x':1880,'y':1020,'width':8,'height':8},omit_background=True))).convert('RGBA').getpixel((4,4))
   reference=pixel();report={'samples':0,'pixel_changes':[],'identity_losses':0,'transitions':[]}
   for target in ['qualifier-waiting','bracket','song-selection','start','qualifier-match','double-elimination-match','start']:
    page.evaluate('scene=>cmd(scene)',target)
    for delay in [0,100,300,500,900]:
     if delay:page.wait_for_timeout(delay)
     current=pixel();report['samples']+=1
     if max(abs(a-b) for a,b in zip(current,reference))>2:report['pixel_changes'].append({'scene':target,'pixel':current,'reference':reference})
     report['identity_losses']+=int(not page.evaluate('document.querySelector(".broadcast-backdrop")===window.__background&&document.querySelector(".broadcast-backdrop image")===window.__art'))
    idle();report['transitions'].append(target)
   report.update(page.evaluate('({update_ms:__updates,background_detachments:__detached,canvas_mutations:__mutations})'))
   report['max_update_ms']=round(max(report['update_ms']),2)
   (OUT/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
   if os.environ.get('BACKGROUND_BASELINE')!='1':
    assert not report['identity_losses'],report
    assert not report['pixel_changes'],report
    assert not report['background_detachments'],report
   browser.close()
 finally:
  proc.terminate();proc.wait(timeout=10)
