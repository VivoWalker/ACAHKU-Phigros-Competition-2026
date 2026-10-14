"""Optional real-browser regression for direct Challenge Mode qualifier totals.

Requires Python Playwright, Pillow and Chromium. Every server uses an isolated
temporary data directory and fixture-only pairing codes. Live event data and
credentials are never opened. Reports/screenshots go to BROADCAST_TEST_OUTPUT
or test-results/challenge-qualifier.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'challenge-qualifier'))
MAIN_PIN = 'challenge-main-browser-fixture'
SCORE_PIN = 'challenge-score-browser-fixture'
REPORT = {'checks': [], 'browser_errors': [], 'geometry': [], 'screenshots': []}

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],fixture=process.argv[2];
if(fixture!=='new') {
  const state=require('./lib/default-state').createDefaultState();
  const act=(type,payload={})=>require('./lib/tournament').applyAction(state,{type,payload});
  if(fixture==='plan-b') {
    act('set-competition-roster',{names:Array.from({length:21},(_,i)=>'Plan B player '+String(i+1).padStart(2,'0'))});
    act('set-qualifier-plan',{plan:'B'});
  } else {
    delete state.qualifier.scoringMode;
    state.qualifier.players.forEach(player=>delete player.challengeTotal);
    if(fixture==='legacy-scored')state.qualifier.players[0].scores=[990000,980000,970000];
  }
  fs.writeFileSync(path.join(dir,'match-state.json'),JSON.stringify(state));
}
const broadcast=require('./server').createBroadcastServer({dataDir:dir,
  pin:'challenge-main-browser-fixture',scorekeeperPin:'challenge-score-browser-fixture'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""

COMMANDS = r"""async role => {
  const token=sessionStorage.getItem(role==='control'?'broadcast-token':'scorekeeper-token');
  if(!token)throw new Error('The real login did not create a session');
  const socket=io('/'+role,{forceNew:true,auth:{token}});
  await new Promise((resolve,reject)=>{
    socket.once('state',state=>{window.__fixtureState=state;resolve()});
    socket.once('connect_error',reject);
  });
  socket.on('state',state=>window.__fixtureState=state);
  window.__fixtureCommand=async(type,payload={},contextKey)=>{
    const current=await fetch('/api/'+role+'-state',{
      headers:{Authorization:'Bearer '+token}}).then(response=>response.json());
    return await new Promise(resolve=>socket.emit('command',{
      expectedRevision:current.revision,
      ...(role==='scorekeeper'?{contextKey:contextKey??current.contextKey}:{}),
      action:{type,payload}},resolve));
  };
  window.__fixtureCommands=[];
  const original=io.Socket.prototype.emit;
  io.Socket.prototype.emit=function(event,...args){
    if(event==='command'){
      const record={action:structuredClone(args[0].action),done:false};
      window.__fixtureCommands.push(record);
      const last=args.length-1,callback=args[last];
      if(typeof callback==='function')args[last]=function(...response){
        record.done=true;record.result=response.find(item=>item&&typeof item.ok==='boolean');
        return callback.apply(this,response);
      };
    }
    return original.call(this,event,...args);
  };
}"""

TEXT_AUDIT = r"""role => {
  const root=document.querySelector('#scene')||document.querySelector('#content')||document.querySelector('#workspace');
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),texts=[];let node;
  while(node=walker.nextNode()){
    if(!node.textContent.trim()||node.parentElement.closest('svg,script,style,.phigros-wordmark,option,.offline-notice'))continue;
    if(role==='control'&&!node.parentElement.closest('.qualifier-scoring-panel,form[data-score-editor="qc"]'))continue;
    if(!node.parentElement.checkVisibility({opacityProperty:true,visibilityProperty:true}))continue;
    let visible=true;
    for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement){
      const css=getComputedStyle(parent);if(css.visibility==='hidden'||css.display==='none'||Number(css.opacity)<.025)visible=false;
    }
    if(!visible)continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const b of range.getClientRects()){
      const rect={left:b.left,right:b.right,top:b.top,bottom:b.bottom};
      for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement){
        const css=getComputedStyle(parent),a=parent.getBoundingClientRect();
        if(['hidden','clip','auto','scroll'].includes(css.overflowX)){
          rect.left=Math.max(rect.left,a.left);rect.right=Math.min(rect.right,a.right);
        }
        if(['hidden','clip','auto','scroll'].includes(css.overflowY)){
          rect.top=Math.max(rect.top,a.top);rect.bottom=Math.min(rect.bottom,a.bottom);
        }
      }
      if(rect.right-rect.left>1&&rect.bottom-rect.top>1)texts.push({rect,text:node.textContent.trim().slice(0,75),node});
    }
  }
  const overlaps=[];
  for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
    const a=texts[i],b=texts[j];if(a.node===b.node)continue;
    const width=Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left),
      height=Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top);
    if(width>2&&height>2&&overlaps.length<12)overlaps.push({a:a.text,b:b.text,width,height});
  }
  return {text_fragments:texts.length,overlaps};
}"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def start_server(data_dir, fixture='new'):
    process = subprocess.Popen(['node', '-e', SERVER, data_dir, fixture], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        assert ready.select(timeout=12), 'Temporary challenge server did not start'
    port = process.stdout.readline().strip()
    assert port.isdigit(), 'Temporary challenge server did not report a port'
    return process, 'http://127.0.0.1:' + port


def stop_server(process):
    process.terminate()
    try:
        process.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=8)


def login(browser, base, role='control'):
    context = browser.new_context(viewport={'width': 1194, 'height': 834}, has_touch=True)
    context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
    page = context.new_page()
    page._fixture_dialog_handler = lambda dialog: dialog.accept()
    page.on('dialog', page._fixture_dialog_handler)
    page.goto(base + '/' + role + '/')
    page.fill('#pin', MAIN_PIN if role == 'control' else SCORE_PIN)
    page.click('#pair-form button')
    page.wait_for_selector('#workspace:not([hidden])')
    page.evaluate(COMMANDS, role)
    return context, page


def state(page, role='control'):
    return page.evaluate('''role=>fetch('/api/'+role+'-state',{
      headers:{Authorization:'Bearer '+sessionStorage.getItem(role==='control'?'broadcast-token':'scorekeeper-token')}})
      .then(response=>response.json())''', role)


def raw_command(page, type_, payload=None, context_key=None):
    return page.evaluate('data=>window.__fixtureCommand(data.type,data.payload,data.context)',
                         {'type': type_, 'payload': payload or {}, 'context': context_key})


def command(page, type_, payload=None):
    response = raw_command(page, type_, payload)
    assert response['ok'], (type_, response)
    page.wait_for_function('revision=>window.__fixtureState.revision>=revision', arg=response['revision'])
    return response


def tab(page, name):
    page.click(f'.tabs [data-tab="{name}"]')
    page.wait_for_function('name=>document.querySelector(`.tabs [data-tab="${name}"]`)?.getAttribute("aria-selected")==="true"', arg=name)


def wait_total(page, player, total, group='A'):
    page.wait_for_function('''async data=>{
      const current=await fetch('/api/state').then(response=>response.json());
      const row=current.qualifier.plan?current.qualifier.rounds[data.group].results[data.player]:
        current.qualifier.players.find(player=>player.id===data.player);
      return row?.challengeTotal===data.total;
    }''', arg={'player': player, 'total': total, 'group': group})


def fill_total(page, player, value, role='control', group='A'):
    if role == 'control':
        field = page.locator('#qtotal-' + player)
        field.fill(str(value))
        field.locator('xpath=ancestor::form').locator('button[type=submit]').click()
    else:
        form = page.locator(f'form[data-player-key="{player}"]')
        form.locator('[data-score-key]').fill(str(value))
        form.locator('[data-save-player]').click()
    wait_total(page, player, value, group)
    page.wait_for_function('window.__fixtureCommands.every(item=>item.done)')
    if role == 'scorekeeper':
        revision = state(page, 'scorekeeper')['revision']
        page.wait_for_function('revision=>document.querySelector("#sync-status").textContent.endsWith("#"+revision)', arg=revision)


def snapshot(page, name, overlay=False):
    path = OUT / name
    page.screenshot(path=str(path), full_page=not overlay, omit_background=overlay, animations='disabled')
    with Image.open(path) as image:
        assert image.width > 0 and image.height > 0
    REPORT['screenshots'].append(str(path))


def geometry(page, name, width, height, role='control'):
    page.set_viewport_size({'width': width, 'height': height})
    page.wait_for_timeout(150)
    if role == 'overlay':
        page.wait_for_function('''()=>Math.abs(document.querySelector('#canvas').getBoundingClientRect().width-
          Math.min(innerWidth/1920,innerHeight/1080)*1920)<.1''')
    result = page.evaluate('''role=>{
      const visible=element=>{
        if(!element.getClientRects().length)return false;
        for(let item=element;item;item=item.parentElement){const css=getComputedStyle(item);
          if(css.visibility==='hidden'||css.display==='none'||Number(css.opacity)<.025)return false;
        }return true;
      };
      const rect=element=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};
      const selectors=role==='overlay'?'.scene-head,.event-title,.topmeta,.qualifier-player,.qualifier-song,.ranking-tables>section,.phigros-logo,.club-logo':
        role==='scorekeeper'?'#context-title,#context-description,#draft-notice,form[data-player-key],input[data-score-key],button[data-save-player],.field-status':
        '#content .page-heading,#content form[data-score-editor="qc"],#content input[id^="qtotal-"],#content form[data-score-editor="qc"] button[type="submit"],#content .draft-notice';
      const all=[...document.querySelectorAll(selectors)].filter(visible);
      return {width:innerWidth,height:innerHeight,scrollWidth:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth),
        rankCells:[...document.querySelectorAll('.ranking-tables tbody td:first-child')].map(cell=>({
          text:cell.textContent,width:cell.clientWidth,scroll:cell.scrollWidth})),
        elements:all.map(element=>({key:element.id||element.dataset.playerKey||element.dataset.motionKey||element.className,
          tag:element.tagName,box:rect(element),parents:all.map((parent,index)=>parent!==element&&parent.contains(element)?index:-1).filter(index=>index>=0)}))};
    }''', role)
    assert result['scrollWidth'] <= width + 1, (name, 'Horizontal overflow', result)
    assert all(cell['scroll'] <= cell['width'] for cell in result['rankCells']), (name, 'Rank or equal-score marker clipped', result['rankCells'])
    for item in result['elements']:
        box = item['box']
        assert box['x'] >= -.5 and box['x'] + box['w'] <= width + .5, (name, 'Outside viewport', item)
        if item['tag'] in ['INPUT', 'BUTTON']:
            assert box['w'] >= 48 and box['h'] >= 48, (name, 'Touch target smaller than 48px', item)
    for index, a in enumerate(result['elements']):
        for j, b in enumerate(result['elements'][index + 1:], index + 1):
            if index in b['parents'] or j in a['parents']:
                continue
            ar, br = a['box'], b['box']
            width_overlap = min(ar['x'] + ar['w'], br['x'] + br['w']) - max(ar['x'], br['x'])
            height_overlap = min(ar['y'] + ar['h'], br['y'] + br['h']) - max(ar['y'], br['y'])
            assert width_overlap <= .5 or height_overlap <= .5, (name, 'Elements overlap', a, b)
    audit = page.evaluate(TEXT_AUDIT, role)
    snapshot(page, name + '.png', role == 'overlay')
    assert not audit['overlaps'], (name, 'Visible text overlaps', audit)
    result.update({'name': name, 'role': role, 'text_audit': audit})
    REPORT['geometry'].append(result)


def idle(page, scene):
    page.wait_for_function('''scene=>{
      const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
      return mount?.dataset.motionPhase==='idle'&&canvas?.dataset.renderedScene===scene
        &&!mount.querySelector('[data-motion-ghost],[data-motion-live],[data-motion-placeholder],[data-motion-exits]')
        &&!mount.getAnimations({subtree:true}).some(animation=>animation.playState==='running'||animation.pending);
    }''', arg=scene, timeout=20000)


def exercise_new(browser, base):
    main_context, main = login(browser, base)
    score_context, scorer = login(browser, base, 'scorekeeper')
    overlay = main_context.new_page()
    overlay.goto(base + '/overlay/qualifier-match.html')
    idle(overlay, 'qualifier-match')
    current = state(main)
    assert current['qualifier']['scoringMode'] == 'challenge-total'
    assert scorer.locator('form[data-player-key]').count() == 4
    assert scorer.locator('input[data-score-key]').count() == 4
    assert scorer.locator('input[data-judgement-key]').count() == 0
    assert scorer.locator('.tabs,iframe,[data-scene],[data-command],[data-start-countdown]').count() == 0
    tab(main, 'qualifiers')
    assert scorer.locator('input[data-score-key]:not(:disabled)').count() == 0
    assert main.locator('input[id^="qtotal-"]:not(:disabled)').count() == 0
    before = state(main)['revision']
    response = raw_command(main, 'set-qualifier-total', {'group': 'A', 'playerId': 'p1', 'total': 1})
    assert not response['ok'] and state(main)['revision'] == before
    main.select_option('#qualifier-plan', 'auto')
    main.locator('#plan-form button[type=submit]').click()
    main.wait_for_function('''async()=>{
      const current=await fetch('/api/state').then(response=>response.json());return current.qualifier.plan==='A';
    }''')
    main.wait_for_selector('#qtotal-p1')
    scorer.wait_for_function('document.querySelectorAll("input[data-score-key]").length===8')
    assert main.locator('form[data-score-editor="qc"]').count() == 8
    assert main.locator('input[id^="qs-"],input[data-judgement-name]').count() == 0
    check('new qualifiers give each player one direct three-song total and no Accuracy calculation')

    fill_total(main, 'p1', 0)
    fill_total(scorer, 'p2', 3000000, 'scorekeeper')
    main.fill('#qtotal-p3', '2987654')
    command(main, 'set-event', {'venue': 'Challenge draft fixture'})
    assert main.input_value('#qtotal-p3') == '2987654'
    assert state(main)['qualifier']['rounds']['A']['results']['p3']['challengeTotal'] is None
    main.locator('form[data-score-editor="qc"][data-entity="p3"] button[type=submit]').click()
    wait_total(main, 'p3', 2987654)
    for player, value in [('p4', 2900000), ('p5', 2900000), ('p6', 2800000), ('p7', 2700000), ('p8', 2600000)]:
        command(main, 'set-qualifier-total', {'group': 'A', 'playerId': player, 'total': value})
    public = main_context.request.get(base + '/api/state').json()
    ranks = public['qualifier']['rankings']['A']
    assert [row['id'] for row in ranks] == ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p1']
    assert ranks[-1]['total'] == 0 and ranks[-1]['complete'] is True
    assert all(row['accuracy'] is None for row in ranks)
    idle(overlay, 'qualifier-match')
    assert '3,000,000' in overlay.locator('#scene').inner_text()
    assert '2,987,654' in overlay.locator('#scene').inner_text()
    check('0, 3,000,000 and an intermediate integer synchronize across main, scorer and OBS', ranks)

    # Browser validation and the actual server both reject malformed totals;
    # none of these rejected requests advances the persisted revision.
    form = scorer.locator('form[data-player-key="p1"]')
    before = state(main)['revision']
    for text in ['1.5', '-1', '3000001']:
        form.locator('[data-score-key]').fill(text)
        assert form.locator('[data-save-player]').is_disabled(), text
        assert state(main)['revision'] == before
        response = raw_command(main, 'set-qualifier-total', {'group': 'A', 'playerId': 'p1', 'total': float(text)})
        assert not response['ok'] and state(main)['revision'] == before, response
    response = raw_command(main, 'set-qualifier-score', {'group': 'A', 'playerId': 'p1', 'songIndex': 0, 'score': 1})
    assert not response['ok'] and state(main)['revision'] == before
    form.locator('[data-score-key]').fill('0')
    assert form.locator('[data-save-player]').is_disabled(), 'Returning to the saved value should clear its draft'
    scorer.wait_for_function('document.querySelectorAll(".conflict-actions:not([hidden])").length===0')
    check('decimal, negative, out-of-range and individual-song qualifier submissions are rejected without writes')

    # An offline scorekeeper retains its own text and cannot save until the
    # synchronized connection is back. Context changes cannot retarget it.
    form = scorer.locator('form[data-player-key="p6"]')
    form.locator('[data-score-key]').fill('2800123')
    score_context.set_offline(True)
    scorer.wait_for_function('document.querySelector("#connection").classList.contains("offline")')
    assert form.locator('[data-save-player]').is_disabled()
    score_context.set_offline(False)
    scorer.wait_for_function('!document.querySelector("#connection").classList.contains("offline")', timeout=15000)
    assert form.locator('[data-score-key]').input_value() == '2800123'
    form.locator('[data-save-player]').click()
    wait_total(scorer, 'p6', 2800123)
    scorer.wait_for_function('''()=>document.querySelector('form[data-player-key="p6"] [data-player-total]')?.textContent==='2,800,123'
      &&document.querySelector('form[data-player-key="p6"] [data-save-player]')?.disabled''')
    old_context = state(scorer, 'scorekeeper')['contextKey']
    command(main, 'set-stage', {'stage': 'double-elimination'})
    scorer.wait_for_function('document.querySelectorAll("form[data-player-key]").length===0')
    before = state(main)['revision']
    response = raw_command(scorer, 'set-qualifier-total', {'group': 'A', 'playerId': 'p6', 'total': 1}, old_context)
    assert not response['ok'] and state(main)['revision'] == before
    command(main, 'set-stage', {'stage': 'qualifier'})
    scorer.wait_for_selector('form[data-player-key="p6"] input[data-score-key]')
    check('scorekeeper reconnect preserves a draft and stale contexts cannot submit to a different stage')

    for role, page in [('main', main), ('scorekeeper', scorer)]:
        for width, height in [(1194, 834), (834, 1194)]:
            geometry(page, f'{role}-{width}x{height}', width, height, 'control' if role == 'main' else 'scorekeeper')
    for width, height in [(1920, 1080), (1280, 720)]:
        geometry(overlay, f'qualifier-match-{width}x{height}', width, height, 'overlay')
    ranking = main_context.new_page()
    ranking.goto(base + '/overlay/result.html')
    idle(ranking, 'result')
    assert 'CHALLENGE' in ranking.locator('#scene').inner_text().upper()
    assert '課題總分' in ranking.locator('.ranking-tables thead').first.inner_text()
    assert '3,000,000' in ranking.locator('.ranking-tables').inner_text()
    assert 'ACC' not in ranking.locator('.ranking-tables').inner_text().upper()
    for width, height in [(1920, 1080), (1280, 720)]:
        geometry(ranking, f'qualifier-ranking-{width}x{height}', width, height, 'overlay')
    check('main/scorer tablet layouts and OBS match/ranking totals have no overlapping controls, text or logos')

    command(main, 'draw-qualifier-tiebreak', {'group': 'A', 'playerIds': ['p4', 'p5']})
    scorer.wait_for_function('document.querySelectorAll("form[data-player-key]").length===2')
    assert scorer.locator('input[data-score-key]').count() == 2
    assert scorer.locator('input[data-judgement-key]').count() == 0
    for player, score in [('p4', 900000), ('p5', 800000)]:
        form = scorer.locator(f'form[data-player-key="{player}"]')
        form.locator('[data-score-key]').fill(str(score))
        form.locator('[data-save-player]').click()
        main.wait_for_function('''async data=>{
          const current=await fetch('/api/state').then(response=>response.json());
          return current.qualifier.rounds.A.tiebreaks[0].scores[data.player]===data.score;
        }''', arg={'player': player, 'score': score})
    command(main, 'confirm-qualifier-tiebreak', {'group': 'A', 'index': 0, 'verified': True})
    ranks = main_context.request.get(base + '/api/state').json()['qualifier']['rankings']['A']
    assert not next(row for row in ranks if row['id'] == 'p4')['tied']
    assert next(row for row in ranks if row['id'] == 'p4')['total'] == 2900000
    assert next(row for row in ranks if row['id'] == 'p5')['total'] == 2900000
    check('equal game totals use a confirmed additional-song score without changing their base totals')

    # Correcting a base total must explicitly explain and archive the extra
    # song. Cancelled and too-short explanations preserve the pending draft.
    main.set_viewport_size({'width': 1194, 'height': 834})
    main.remove_listener('dialog', main._fixture_dialog_handler)
    dialog_mode = ['cancel']
    dialogs = []
    reason = 'Referee checked the original Challenge Mode results and corrected the total.'

    def handle_dialog(dialog):
        dialogs.append({'type': dialog.type, 'message': dialog.message})
        if dialog.type == 'prompt':
            if dialog_mode[0] == 'cancel':
                dialog.dismiss()
            else:
                dialog.accept('short' if dialog_mode[0] == 'short' else reason)
        else:
            dialog.accept()

    main.on('dialog', handle_dialog)
    main.fill('#qtotal-p4', '2900123')
    before = state(main)['revision']
    main.locator('form[data-score-editor="qc"][data-entity="p4"] button[type=submit]').click()
    main.wait_for_timeout(150)
    assert state(main)['revision'] == before and main.input_value('#qtotal-p4') == '2900123'
    dialog_mode[0] = 'short'
    main.locator('form[data-score-editor="qc"][data-entity="p4"] button[type=submit]').click()
    main.wait_for_timeout(150)
    assert state(main)['revision'] == before
    dialog_mode[0] = 'accept'
    main.locator('form[data-score-editor="qc"][data-entity="p4"] button[type=submit]').click()
    wait_total(main, 'p4', 2900123)
    current = state(main)
    assert not current['qualifier']['rounds']['A']['tiebreaks']
    adjudication = current['qualifier']['adjudications'][-1]
    assert adjudication['previousChallengeTotal'] == 2900000
    assert adjudication['note'] == reason and adjudication['invalidatedTiebreaks'][0]['confirmed'] is True
    check('main-control base correction requires a reason and preserves the invalidated tiebreak in its audit record', dialogs)

    command(main, 'finalize-qualifier-round', {'group': 'A', 'verified': True})
    current = state(main)
    assert current['qualifier']['rounds']['A']['qualifiedIds'] == ['p2', 'p3', 'p4', 'p5']
    assert current['qualifier']['activeGroup'] == 'B'
    assert set(current['qualifier']['rounds']['B']['playerIds']) == {'p1', 'p6', 'p7', 'p8'}
    assert all(row['challengeTotal'] is None for row in current['qualifier']['rounds']['B']['results'].values())
    for player, total in [('p1', 2400000), ('p6', 2300000), ('p7', 2200000), ('p8', 2100000)]:
        command(main, 'set-qualifier-total', {'group': 'B', 'playerId': player, 'total': total})
    assert state(main)['qualifier']['rounds']['A']['results']['p1']['challengeTotal'] == 0
    command(main, 'finalize-qualifier-round', {'group': 'B', 'verified': True})
    current = state(main)
    seed_ids = current['qualifier']['rounds']['A']['qualifiedIds'] + current['qualifier']['rounds']['B']['qualifiedIds']
    command(main, 'seed-bracket', {'ids': seed_ids, 'verified': True})
    command(main, 'set-stage', {'stage': 'qualifier'})
    scorer.wait_for_selector('form[data-player-key="p1"] input[data-score-key]')
    assert scorer.locator('input[data-score-key]:not(:disabled)').count() == 0
    before = state(main)['revision']
    response = raw_command(main, 'set-qualifier-total', {'group': 'B', 'playerId': 'p1', 'total': 1})
    assert not response['ok'] and state(main)['revision'] == before
    check('Plan A advances the first four, records independent revival totals, then locks scores after qualification/seeding')

    command(main, 'select-match', {'matchId': 'W1'})
    command(main, 'draw-candidates', {'matchId': 'W1'})
    match = next(row for row in state(main)['tournament']['matches'] if row['id'] == 'W1')
    for player_index in range(2):
        command(main, 'ban-song', {'matchId': 'W1', 'playerIndex': player_index, 'songId': match['candidates'][player_index]['id']})
    command(main, 'pick-songs', {'matchId': 'W1'})
    command(main, 'set-stage', {'stage': 'double-elimination'})
    scorer.wait_for_function('document.querySelectorAll("input[data-score-key]").length===4')
    assert scorer.locator('input[data-judgement-name="accuracy"]').count() == 4
    form = scorer.locator('form[data-player-key="0"]')
    form.locator('input[data-score-key]').first.fill('999999')
    form.locator('input[data-judgement-name="accuracy"]').first.fill('98.7654')
    form.locator('[data-save-player]').click()
    main.wait_for_function('''async()=>{
      const state=await fetch('/api/state').then(response=>response.json());
      const match=state.tournament.matches.find(item=>item.id==='W1');
      return match.scores[0][0]===999999&&match.judgements[0][0].accuracy===98.7654;
    }''')
    # The final cannot be selected until its feeder matches have finished.
    # Verify its scorekeeper projection once without replaying 13 matches or
    # altering the server's bracket dependencies just to reach its UI.
    projection = subprocess.run(['node', '-e', r"""
      let data='';process.stdin.on('data',chunk=>data+=chunk);
      process.stdin.on('end',()=>{
        const state=JSON.parse(data);state.stage='double-elimination';state.tournament.currentMatchId='GF';
        const view=require('./lib/scorekeeper').scorekeeperState(state).match;
        console.log(JSON.stringify({mode:view.finalMode,songs:view.songs,
          rows:view.players.map(player=>({scores:player.scores,judgements:player.judgements,
            hasChallengeTotal:Object.hasOwn(player,'challengeTotal')}))}));
      });
    """], cwd=ROOT, input=json.dumps(state(main)), capture_output=True, text=True, check=True, timeout=8)
    final = json.loads(projection.stdout)
    assert final['mode'] == 'fixed-two' and len(final['songs']) == 2
    assert all(len(row['scores']) == 2 and len(row['judgements']) == 2 and not row['hasChallengeTotal'] for row in final['rows'])
    check('DE UI and the fixed two-song Grand Final projection retain ordinary per-song scores and Accuracy', final)
    score_context.close()
    main_context.close()


def exercise_plan_b(browser, base):
    main_context, main = login(browser, base)
    score_context, scorer = login(browser, base, 'scorekeeper')
    tab(main, 'qualifiers')
    current = state(main)
    q = current['qualifier']
    assert q['plan'] == 'B'
    a, b = q['rounds']['A']['playerIds'], q['rounds']['B']['playerIds']
    assert len(a) == 11 and len(b) == 10
    fill_total(main, a[0], 2999999)
    form = scorer.locator(f'form[data-player-key="{a[1]}"]')
    form.locator('[data-score-key]').fill('2999123')
    old_context = state(scorer, 'scorekeeper')['contextKey']
    command(main, 'set-qualifier-display', {'group': 'B'})
    scorer.wait_for_function('document.querySelectorAll("form[data-player-key]").length===10')
    assert '2999123' in scorer.locator('#draft-notice').inner_text()
    assert scorer.locator(f'form[data-player-key="{b[0]}"] [data-score-key]').input_value() == ''
    before = state(main)['revision']
    response = raw_command(scorer, 'set-qualifier-total', {'group': 'A', 'playerId': a[1], 'total': 2999123}, old_context)
    assert not response['ok'] and state(main)['revision'] == before
    fill_total(scorer, b[0], 2800001, 'scorekeeper', 'B')
    current = state(main)
    assert current['qualifier']['rounds']['A']['results'][a[0]]['challengeTotal'] == 2999999
    assert current['qualifier']['rounds']['A']['results'][a[1]]['challengeTotal'] is None
    assert current['qualifier']['rounds']['B']['results'][b[0]]['challengeTotal'] == 2800001
    command(main, 'set-qualifier-display', {'group': 'A'})
    scorer.wait_for_function('document.querySelectorAll("form[data-player-key]").length===11')
    assert scorer.locator(f'form[data-player-key="{a[1]}"] [data-score-key]').input_value() == '2999123'
    geometry(scorer, 'plan-b-stale-draft-834x1194', 834, 1194, 'scorekeeper')
    check('Plan B odd/even groups retain independent totals and scorekeeper drafts stay with the original group')
    score_context.close()
    main_context.close()


def exercise_legacy(browser, base, scored=False):
    context, main = login(browser, base)
    tab(main, 'qualifiers')
    main.wait_for_selector('input[id^="qs-"]')
    assert main.locator('form[data-score-editor="qc"]').count() == 0
    current = state(main)
    assert not current['qualifier'].get('scoringMode')
    if scored:
        assert current['qualifier']['players'][0]['scores'] == [990000, 980000, 970000]
        button = main.locator('[data-qualifier-challenge]')
        assert button.count() == 0 or button.is_disabled()
        response = raw_command(main, 'set-qualifier-scoring-mode', {'mode': 'challenge-total'})
        assert not response['ok']
        assert state(main)['revision'] == current['revision']
        assert state(main)['qualifier']['players'][0]['scores'] == [990000, 980000, 970000]
        check('recorded legacy events retain their original scores and cannot destructively switch to Challenge Mode')
    else:
        main.click('[data-qualifier-challenge]')
        main.wait_for_selector('#qtotal-p1')
        assert state(main)['qualifier']['scoringMode'] == 'challenge-total'
        assert main.locator('form[data-score-editor="qc"]').count() == 4
        check('an unscored legacy event can explicitly switch to Challenge Mode through main control')
    context.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
        browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
            '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
        try:
            for fixture in ['new', 'plan-b', 'legacy', 'legacy-scored']:
                with tempfile.TemporaryDirectory(prefix='acahku-challenge-' + fixture + '-') as data_dir:
                    process, base = start_server(data_dir, fixture)
                    try:
                        if fixture == 'new':
                            exercise_new(browser, base)
                        elif fixture == 'plan-b':
                            exercise_plan_b(browser, base)
                        else:
                            exercise_legacy(browser, base, fixture == 'legacy-scored')
                    finally:
                        stop_server(process)
            assert not REPORT['browser_errors'], REPORT['browser_errors']
            REPORT['result'] = 'PASS'
            check('all independent browser sessions completed without JavaScript errors')
        finally:
            browser.close()
            (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
