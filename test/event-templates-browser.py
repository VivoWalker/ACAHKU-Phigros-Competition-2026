"""Real setup, portable template import/export and standard final without effects."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('BROADCAST_TEST_OUTPUT',ROOT/'test-results/event-templates'))
REPORT={'checks':[],'browser_errors':[]}
spec=importlib.util.spec_from_file_location('helpers',ROOT/'test/production-console-browser.py')
P=importlib.util.module_from_spec(spec);spec.loader.exec_module(P);P.REPORT=REPORT
P.SERVER=r"""
const fs=require('node:fs'),path=require('node:path');
if(process.argv[2]==='final')fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(require('./test/helpers/standard-event').toFinal(require('./test/helpers/standard-event').fresh())));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],preset:'standard',pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""
def check(name):
 REPORT['checks'].append(name);print('PASS '+name,flush=True)
def idle(live,scene):
 live.wait_for_function('''scene=>document.querySelector('#canvas')?.dataset.renderedScene===scene&&document.querySelector('#scene')?.dataset.motionPhase==='idle' ''',arg=scene)
def run(browser,fixture):
 with tempfile.TemporaryDirectory(prefix='event-template-ui-') as directory:
  proc,base=P.start_server(directory,fixture);context=None
  try:
   context,main=P.login(browser,base)
   if fixture=='setup':
    main.click('.tabs [data-tab="event"]');main.wait_for_selector('#event-template-form')
    for width,height in [(1440,1000),(800,1000),(390,844)]:
     main.set_viewport_size({'width':width,'height':height})
     assert main.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
     assert main.locator('#event-template-form button[type="submit"]').is_enabled()
     main.screenshot(path=str(OUT/f'setup-{width}.png'),full_page=True)
    template=main.evaluate('''()=>fetch('/api/event-template',{headers:{Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')}}).then(r=>r.json())''')
    template['event']['title']='Imported Community Cup'
    before=P.state(main)['eventId']
    main.set_input_files('#event-template-file',{'name':'community.json','mimeType':'application/json','buffer':json.dumps(template).encode()})
    main.wait_for_function("document.querySelector('#event-title')?.value==='Imported Community Cup'")
    saved=P.state(main);assert saved['eventId']!=before and saved['eventProfile']['presentation']=='standard'
    assert 'tournament' not in template and 'eventId' not in template
    main.locator('#template-final-0').select_option(saved['qualifier']['groups']['A']['songs'][0])
    revision=P.state(main)['revision'];main.click('#event-template-form button[type="submit"]')
    main.wait_for_function('revision=>window.__fixtureState.revision>revision',arg=revision)
    assert P.state(main)['eventProfile']['finalSongs'][0]==saved['qualifier']['groups']['A']['songs'][0]
    configured=main.evaluate('''()=>fetch('/api/event-template',{headers:{Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')}}).then(r=>r.json())''')
    live=context.new_page();live.goto(base+'/overlay/live.html?bgm=0');idle(live,'start')
    assert live.locator('.club-logo').count()==0
    P.command(main,'apply-competition-config',{'confirmed':True})
    live.wait_for_selector('.club-logo')
    P.command(main,'apply-event-template',{'confirmed':True,'template':configured})
    live.wait_for_function('document.querySelectorAll(".club-logo").length===0')
    assert main.locator('.tabs [data-tab="trailer"]').inner_text()=='中場影片'
    P.command(main,'set-qualifier-plan',{'plan':'A'})
    assert main.locator('#event-template-form button[type="submit"]').is_disabled()
    check('template import, UI final-song configuration, fresh event identity, mobile layout and setup lock')
   else:
    live=context.new_page();live.set_viewport_size({'width':1920,'height':1080})
    live.goto(base+'/overlay/live.html?bgm=0');idle(live,'double-elimination-waiting')
    main.set_viewport_size({'width':1440,'height':1000})
    P.command(main,'start-final-announcement',{'matchId':'GF'})
    live.wait_for_selector('[data-final-song]');idle(live,'grand-final-announcement')
    assert 'Custom chart' in live.locator('#scene').inner_text()
    assert not live.locator('#canvas').evaluate("n=>n.classList.contains('finale-infected')||n.classList.contains('finale-sequence-corrupt')")
    assert main.locator('[data-final-sequence-panel]').count()==0
    live.screenshot(path=str(OUT/'standard-final-reveal.png'))
    live.wait_for_function('document.querySelector("[data-final-index]")?.dataset.finalIndex==="1"')
    idle(live,'grand-final-announcement')
    P.click_saved(main,'[data-production-next]');idle(live,'double-elimination-waiting')
    for si in [0,1]:
     for scene in ['double-elimination-match','double-elimination-processing']:
      P.click_saved(main,'[data-production-next]');idle(live,scene)
     for pi in [0,1]:
      P.command(main,'set-match-score',{'matchId':'GF','playerIndex':pi,'songIndex':si,'score':990000 if pi==0 else 980000})
     P.click_saved(main,'[data-production-next]');idle(live,'song-result')
     if si==0:
      P.click_saved(main,'[data-production-next]');idle(live,'double-elimination-waiting')
    assert '核對' in main.locator('[data-production-next]').inner_text()
    assert '確認兩首總分' in main.locator('#result-form').inner_text()
    P.click_saved(main,'[data-production-next]');idle(live,'result')
    final=P.state(main)['tournament']['matches'][-1]
    assert final['status']=='complete' and len(final['songs'])==2 and 'finale' not in final
    live.screenshot(path=str(OUT/'standard-final-result.png'))
    P.command(main,'set-broadcast-cue',{'stage':'double-elimination','scene':'final-standings'})
    idle(live,'final-standings')
    live.reload();idle(live,'final-standings')
    check('custom-ID final: reveal → waiting → both games → processing → verified result → final standings, without PV or effects, including reload')
   assert not REPORT['browser_errors'],REPORT['browser_errors']
  finally:
   if context:context.close()
   P.stop_server(proc)
def main():
 OUT.mkdir(parents=True,exist_ok=True)
 try:
  with sync_playwright() as pw:
   binary=os.environ.get('CHROME_BINARY') or shutil.which('chromium')
   browser=pw.chromium.launch(**({'executable_path':binary} if binary else {}),args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
   try:
    for fixture in ['setup','final']:run(browser,fixture)
   finally:browser.close()
 finally:(OUT/'report.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
