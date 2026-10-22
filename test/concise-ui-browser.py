"""Focused usability/layout checks for concise staff panels and every OBS scene.

Uses generated temporary events and fixture pairing codes; no production data.
Requires Python Playwright, Pillow and Chromium. Reports and screenshots use
BROADCAST_TEST_OUTPUT or ignored test-results/concise-ui/.
"""
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/concise-ui'))
REPORT = {'checks': [], 'screenshots': [], 'geometry': [], 'browser_errors': []}
SERVER = r"""
const {createDefaultState}=require('./lib/default-state'),T=require('./lib/tournament');
const initial=createDefaultState();
T.applyAction(initial,{type:'set-qualifier-plan',payload:{plan:'A'}});
for(const p of initial.qualifier.players) T.applyAction(initial,{type:'set-qualifier-challenge-result',payload:{
  group:'A',playerId:p.id,total:2700000-Number(p.id.slice(1)),songStats:Array.from({length:3},()=>({score:900000,perfect:100,good:2,bad:0,miss:0}))}});
const final=createDefaultState(),act=(type,payload={})=>T.applyAction(final,{type,payload:{matchId:final.tournament.currentMatchId,...payload}});
act('seed-bracket',{ids:final.qualifier.players.map(p=>p.id),ruleset:'proposal-2026',verified:true});
let firstResult;
for(const id of ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']){
  act('select-match',{matchId:id});act('draw-candidates');
  const m=final.tournament.matches.find(m=>m.id===id);
  act('ban-song',{playerIndex:0,songId:m.candidates[0].id});
  act('ban-song',{playerIndex:1,songId:m.candidates[1].id});act('pick-songs');
  for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act('set-match-score',{playerIndex:pi,songIndex:si,
    score:id==='W1'?990000:pi?980000:990000,...(id==='W1'?{judgements:{accuracy:pi?98:99}}:{})});
  act('record-result',{verified:true});
  if(id==='W1')firstResult=structuredClone(final.result);
}
const regular=structuredClone(final);regular.tournament.currentMatchId='W1';regular.result=firstResult;
act('select-match',{matchId:'GF'});
for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act('set-match-score',{playerIndex:pi,songIndex:si,score:pi?980000:990000});
act('show-final-two-totals');
const announcement=structuredClone(final);announcement.tournament.matches.find(m=>m.id==='GF').finalAnnouncement={id:require('node:crypto').randomUUID(),startedAt:Date.now()-1000};
const fixtures={qualifier:initial,regular,final,announcement};
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'concise-main-fixture',scorekeeperPin:'concise-score-fixture'});
function load(name){app.store.state=structuredClone(fixtures[name]);app.store.write(app.store.state);}
load('qualifier');
app.app.post('/__fixture/:name',(req,res)=>{if(!fixtures[req.params.name])return res.sendStatus(404);load(req.params.name);res.json({ok:true});});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""

TEXT_GEOMETRY = r"""() => {
  const root=document.querySelector('#scene')||document.querySelector('#content')||document.querySelector('#workspace')||document.body;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),texts=[];
  let node;
  while(node=walker.nextNode()){
    if(!node.textContent.trim()||node.parentElement.closest('svg,script,style,.offline-notice,[aria-hidden=true]'))continue;
    let visible=true;
    for(let p=node.parentElement;p;p=p.parentElement){
      const c=getComputedStyle(p);
      if(c.display==='none'||c.visibility==='hidden'||Number(c.opacity)<.025)visible=false;
      if(p.tagName==='DETAILS'&&!p.open&&!p.querySelector(':scope > summary')?.contains(node.parentElement))visible=false;
    }
    if(!visible)continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const b of range.getClientRects()){
      const r={left:b.left,right:b.right,top:b.top,bottom:b.bottom};
      for(let p=node.parentElement;p&&p!==root;p=p.parentElement){
        const c=getComputedStyle(p),a=p.getBoundingClientRect();
        if(['hidden','clip','auto','scroll'].includes(c.overflowX)){r.left=Math.max(r.left,a.left);r.right=Math.min(r.right,a.right);}
        if(['hidden','clip','auto','scroll'].includes(c.overflowY)){r.top=Math.max(r.top,a.top);r.bottom=Math.min(r.bottom,a.bottom);}
      }
      if(r.right-r.left>1&&r.bottom-r.top>1)texts.push({r,text:node.textContent.trim().slice(0,70),node});
    }
  }
  const overlaps=[];
  for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
    const a=texts[i],b=texts[j];if(a.node===b.node)continue;
    const w=Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left),h=Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top);
    if(w>3&&h>4&&overlaps.length<12)overlaps.push({a:a.text,b:b.text,width:w,height:h});
  }
  return {text_fragments:texts.length,overlaps,width:innerWidth,scroll_width:document.documentElement.scrollWidth};
}"""


def check(label):
    REPORT['checks'].append(label)
    print('PASS ' + label, flush=True)


def screenshot(page, name):
    path = OUT / (name + '.png')
    data = page.screenshot(path=str(path), full_page=not name.startswith('overlay-'), omit_background=True)
    REPORT['screenshots'].append(str(path))
    return data


def geometry(page, name):
    page.evaluate('document.fonts.ready')
    result = page.evaluate(TEXT_GEOMETRY)
    REPORT['geometry'].append({'view': name, **result})
    if result['overlaps'] or result['scroll_width'] > result['width'] + 1:
        screenshot(page, name + '-geometry-failure')
    assert result['scroll_width'] <= result['width'] + 1, (name, 'horizontal page overflow', result)
    assert result['overlaps'] == [], (name, 'overlapping text', result['overlaps'])


def labelled(page, selector):
    assert page.locator(selector).count(), ('missing field', selector)
    assert page.locator(selector).evaluate_all("els=>els.every(el=>el.labels?.length||el.getAttribute('aria-label')||el.getAttribute('aria-labelledby'))"), ('missing field label', selector)


def pair(page, base, role):
    page.goto(base + '/' + role + '/')
    labelled(page, '#pin')
    assert 'Your signal.' not in page.locator('body').inner_text()
    assert 'No cloud account required.' not in page.locator('body').inner_text()
    page.fill('#pin', 'concise-main-fixture' if role == 'control' else 'concise-score-fixture')
    page.click('#pair-form button')
    page.wait_for_selector('#workspace', state='visible')


def tab(page, name):
    page.locator('.tabs [data-tab="' + name + '"]').click()
    page.wait_for_function("name=>document.querySelector('.tabs [data-tab=\"'+name+'\"]').getAttribute('aria-selected')==='true'", arg=name)


def command(page, kind, payload):
    result = page.evaluate(r"""async ({kind,payload})=>{
      const token=sessionStorage.getItem('broadcast-token'),s=io('/control',{forceNew:true,auth:{token}});
      const state=await new Promise((resolve,reject)=>{s.once('state',resolve);s.once('connect_error',reject)});
      const result=await new Promise(resolve=>s.emit('command',{expectedRevision:state.revision,action:{type:kind,payload}},resolve));
      s.disconnect();return result;
    }""", {'kind': kind, 'payload': payload})
    assert result['ok'], result


def load(context, base, name):
    response = context.request.post(base + '/__fixture/' + name)
    assert response.ok, (name, response.status, response.text()[:1000])


def staff_checks(context, base):
    control = context.new_page(); pair(control, base, 'control')
    for width, height in [(1194, 834), (390, 844)]:
        control.set_viewport_size({'width': width, 'height': height})
        for name in ['broadcast', 'qualifiers', 'bracket', 'songs', 'event']:
            tab(control, name)
            assert control.locator('#content h1').count() == 1, (name, 'missing page title')
            if name == 'broadcast':
                assert control.locator('[data-production-next]').is_visible()
                assert control.locator('[data-countdown-status]').count()
                assert control.locator('#program-preview').count() == 1
            if name == 'event':
                labelled(control, '#event-form input, #event-form textarea')
                assert control.locator('#event-form button[type=submit]').is_visible()
            geometry(control, f'control-{name}-{width}')
            screenshot(control, f'control-{name}-{width}')
    control.set_viewport_size({'width': 1194, 'height': 834}); tab(control, 'event')
    control.fill('#event-title', 'Local unsaved title')
    command(control, 'set-event', {'title': 'Server title changed'})
    control.wait_for_selector('[data-draft-resolution=server]')
    assert control.input_value('#event-title') == 'Local unsaved title'
    assert 'Server title changed' in control.locator('.draft-notice').inner_text()
    assert control.locator('[data-draft-resolution=review]').is_visible()
    screenshot(control, 'control-draft-conflict')
    check('all five control tabs retain navigation, labelled forms, preview and conflict decisions at laptop/mobile sizes')

    scorer = context.new_page(); pair(scorer, base, 'scorekeeper')
    for width, height in [(1194, 834), (390, 844)]:
        scorer.set_viewport_size({'width': width, 'height': height})
        labelled(scorer, '#score-list input')
        assert scorer.locator('[data-save-player]').count() == 3
        geometry(scorer, f'scorekeeper-{width}'); screenshot(scorer, f'scorekeeper-{width}')
    first = scorer.locator('form[data-player-key=p1] [data-score-key][data-song-index="0"]')
    first.fill('invalid')
    assert first.get_attribute('aria-invalid') == 'true'
    assert scorer.locator('form[data-player-key=p1] [data-save-player]').is_disabled()
    first.fill('900001')
    command(control, 'set-qualifier-total', {'group': 'A', 'playerId': 'p1', 'total': 2600000})
    scorer.wait_for_selector('form[data-player-key=p1] [data-conflict-actions]:not([hidden])')
    assert scorer.locator('form[data-player-key=p1] [data-save-player]').is_disabled()
    assert scorer.locator('form[data-player-key=p1] [data-keep-draft]:visible').count()
    screenshot(scorer, 'scorekeeper-conflict')
    check('scorekeeper keeps labels, save actions, validation errors and conflicting server values')
    scorer.close(); control.close()


def overlay_checks(context, base):
    views = [('qualifier', scene) for scene in ['start', 'qualifier-waiting', 'qualifier-match', 'qualifier-processing', 'song-result', 'result']]
    views += [('regular', scene) for scene in ['double-elimination-waiting', 'double-elimination-match', 'song-result', 'result', 'bracket', 'song-selection']]
    views += [('announcement', 'grand-final-announcement'), ('final', 'grand-final-totals'), ('final', 'grand-final-video')]
    page = context.new_page(); page.set_viewport_size({'width': 1920, 'height': 1080})
    for fixture, scene in views:
        load(context, base, fixture)
        page.goto(base + '/overlay/' + scene + '.html?fixed=1&cameras=1')
        page.wait_for_function("scene=>document.querySelector('#canvas')?.dataset.renderedScene===scene&&document.querySelector('#scene')?.dataset.motionPhase==='idle'", arg=scene)
        name = f'overlay-{fixture}-{scene}'
        geometry(page, name)
        text = page.locator('#scene').inner_text()
        for removed in ['RESULTS PROCESSING', 'CHALLENGE RESULTS', 'FIRST TWO SONGS · CUMULATIVE SCORES', 'OFFICIAL CHALLENGE TOTAL']:
            assert removed not in text, (name, 'duplicate subtitle', removed)
        image = Image.open(io.BytesIO(screenshot(page, name))).convert('RGBA')
        for box in page.locator('[data-capture]').all():
            rect = box.bounding_box()
            for x in [.2, .5, .8]:
                for y in [.2, .5, .8]:
                    point = (int(rect['x'] + rect['width'] * x), int(rect['y'] + rect['height'] * y))
                    assert image.getpixel(point)[3] == 0, (name, 'capture is no longer transparent', point)
        if scene.endswith('-match'):
            assert page.locator('[data-feed=capture-card]').count() == (3 if fixture == 'qualifier' else 2)
            assert page.locator('.song-band').inner_text().strip()
        if fixture == 'regular' and scene == 'result':
            assert 'ACCURACY' in text, 'retain the reason for a tied-total result'
    page.close()
    check('all thirteen overlay scenes and both result/statistics modes retain data, readable geometry and transparent capture windows')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='broadcast-concise-ui-') as directory:
        process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                assert selector.select(20), 'fixture server did not start'
            port = process.stdout.readline().strip(); assert port.isdigit(), 'fixture startup failed'
            with sync_playwright() as pw:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
                browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
                context = browser.new_context(viewport={'width': 1194, 'height': 834}, reduced_motion='reduce')
                context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
                base = 'http://127.0.0.1:' + port
                staff_checks(context, base); overlay_checks(context, base)
                browser.close()
            assert REPORT['browser_errors'] == [], REPORT['browser_errors']
        finally:
            process.terminate()
            try: process.wait(timeout=8)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=8)
            (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False))
    print(json.dumps(REPORT['checks'], ensure_ascii=False))


if __name__ == '__main__':
    main()
