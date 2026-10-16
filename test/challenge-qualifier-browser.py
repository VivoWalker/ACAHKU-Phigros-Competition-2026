"""Real-browser regression for current-batch Challenge Mode score sheets.

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
        role==='scorekeeper'?'#context-title,#context-description,#draft-notice,form[data-player-key],input[data-score-key],input[data-judgement-key],button[data-save-player],.field-status':
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


def score_form(page, player):
    return page.locator(f'form[data-player-key="{player}"]')


def song_field(page, player, index):
    return score_form(page, player).locator(f'input[data-score-key][data-song-index="{index}"]')


def fill_challenge(page, player, stats, total):
    form = score_form(page, player)
    for index, row in enumerate(stats):
        field = song_field(page, player, index)
        field.fill(str(row['score']))
        wrapper = field.locator('xpath=ancestor::div[@data-field-key]')
        for name in ['perfect', 'good', 'bad', 'miss']:
            wrapper.locator(f'[data-judgement-name="{name}"]').fill(str(row[name]))
    song_field(page, player, 3).fill(str(total))
    return form


def saved_challenge(page, player, stats, total, group='A'):
    wait_total(page, player, total, group)
    page.wait_for_function('''data=>{
      const form=document.querySelector(`form[data-player-key="${data.player}"]`);
      return form&&form.querySelector('[data-save-player]').disabled&&!form.querySelector('.is-dirty');
    }''', arg={'player': player})
    page.wait_for_function('window.__fixtureCommands.every(item=>item.done)')
    current = page.context.request.get(page.url.split('/scorekeeper/')[0] + '/api/state').json()
    row = current['qualifier']['rounds'][group]['results'][player]
    assert row['challengeTotal'] == total and row['songStats'] == stats, row


def hold_score_ack(page):
    page.evaluate('''() => {
      if(!window.__challengeAckHook) {
        window.__challengeAckHook=true;
        const original=io.Socket.prototype.emit;
        io.Socket.prototype.emit=function(event,...args) {
          if(event==='command'&&window.__holdChallengeAck) {
            window.__holdChallengeAck=false;
            const callback=args.pop();
            args.push((...response)=>{window.__releaseChallengeAck=()=>callback(...response)});
          }
          return original.call(this,event,...args);
        };
      }
      window.__releaseChallengeAck=null;
      window.__holdChallengeAck=true;
    }''')


def release_score_ack(page):
    page.wait_for_function('typeof window.__releaseChallengeAck==="function"')
    page.evaluate('window.__releaseChallengeAck()')


def wait_batch(page, players):
    page.wait_for_function('''ids=>JSON.stringify([...document.querySelectorAll('form[data-player-key]')]
      .map(form=>form.dataset.playerKey))===JSON.stringify(ids)''', arg=players)


def exercise_new(browser, base, data_dir):
    main_context, main = login(browser, base)
    score_context, scorer = login(browser, base, 'scorekeeper')
    current = state(main)
    assert current['qualifier']['scoringMode'] == 'challenge-total'
    wait_batch(scorer, ['p1', 'p2', 'p3'])
    assert scorer.locator('input[data-score-key]').count() == 12
    assert scorer.locator('input[data-judgement-key]').count() == 36
    assert scorer.locator('[data-judgement-name="accuracy"]').count() == 0
    assert scorer.locator('input:not(:disabled)[data-score-key]').count() == 0
    assert scorer.locator('.tabs,iframe,[data-scene],[data-command],[data-start-countdown]').count() == 0
    command(main, 'set-qualifier-plan', {'plan': 'A'})
    wait_batch(scorer, ['p1', 'p2', 'p3'])
    scorer.wait_for_function('document.querySelectorAll("input[data-score-key]:not(:disabled)").length===12')
    assert [row['id'] for row in state(scorer, 'scorekeeper')['qualifier']['players']] == ['p1', 'p2', 'p3']
    assert scorer.locator('form[data-player-key="p4"]').count() == 0
    check('scorekeeper shows only the three current players, with three song scores, twelve P/G/B/M counts and one official total each')

    stats = [
        {'score': 998765, 'perfect': 700, 'good': 12, 'bad': 1, 'miss': 0},
        {'score': 987654, 'perfect': 800, 'good': 5, 'bad': 2, 'miss': 1},
        {'score': 976543, 'perfect': 900, 'good': 0, 'bad': 0, 'miss': 3},
    ]
    # The game total is recorded directly, independently of the three entries.
    total = 2950001
    assert total != sum(row['score'] for row in stats)
    form = fill_challenge(scorer, 'p1', stats, total)
    assert not form.locator('[data-save-player]').is_disabled()
    command(main, 'set-event', {'venue': 'Challenge result draft fixture'})
    assert song_field(scorer, 'p1', 0).input_value() == '998765'
    assert state(main)['qualifier']['rounds']['A']['results']['p1']['challengeTotal'] is None
    before, commands_before = state(main)['revision'], scorer.evaluate('window.__fixtureCommands.length')
    form.locator('[data-save-player]').click()
    saved_challenge(scorer, 'p1', stats, total)
    after = state(main)
    assert after['revision'] == before + 1
    commands = scorer.evaluate('window.__fixtureCommands')
    assert len(commands) == commands_before + 1
    assert commands[-1]['action'] == {'type': 'set-qualifier-challenge-result', 'payload': {
        'group': 'A', 'playerId': 'p1', 'total': total, 'songStats': stats}}
    persisted = json.loads((Path(data_dir) / 'match-state.json').read_text())
    assert persisted['qualifier']['rounds']['A']['results']['p1']['songStats'] == stats
    assert persisted['qualifier']['rounds']['A']['results']['p1']['challengeTotal'] == total
    check('one explicit player save atomically persists all three song statistics and the manually entered official total')

    form = score_form(scorer, 'p2')
    song_field(scorer, 'p2', 0).fill('0')
    before = state(main)['revision']
    assert form.locator('[data-save-player]').is_disabled()
    song_field(scorer, 'p2', 0).press('Enter')
    assert state(main)['revision'] == before
    zeros = [dict.fromkeys(['score', 'perfect', 'good', 'bad', 'miss'], 0) for _ in range(3)]
    fill_challenge(scorer, 'p2', zeros, 0)
    for field, invalid in [(song_field(scorer, 'p2', 0), '1.5'),
                           (song_field(scorer, 'p2', 1), '1000001'),
                           (song_field(scorer, 'p2', 3), '3000001'),
                           (form.locator('[data-judgement-name="good"]').nth(1), '-1'),
                           (form.locator('[data-judgement-name="miss"]').nth(2), '')]:
        original = field.input_value()
        field.fill(invalid)
        assert form.locator('[data-save-player]').is_disabled(), invalid
        assert state(main)['revision'] == before
        field.fill(original)
    form.locator('[data-save-player]').click()
    saved_challenge(scorer, 'p2', zeros, 0)
    assert score_form(scorer, 'p2').locator('[data-player-total]').inner_text() == '0'
    check('all sixteen values are required; zero is valid, while decimals, negative counts, missing counts and out-of-range scores cannot save')

    # Incomplete commands must also be rejected by the authenticated server.
    for broken in [stats[:2], [{**stats[0], 'miss': None}, *stats[1:]]]:
        before = state(main)['revision']
        response = raw_command(scorer, 'set-qualifier-challenge-result', {
            'group': 'A', 'playerId': 'p3', 'total': total, 'songStats': broken})
        assert not response['ok'] and state(main)['revision'] == before, response
    response = raw_command(scorer, 'set-qualifier-challenge-result', {
        'group': 'A', 'playerId': 'p4', 'total': total, 'songStats': stats})
    assert not response['ok'] and state(main)['revision'] == before
    check('server rejects incomplete sheets and off-batch players without partially saving a result')

    # Each per-song overlay reads the same persisted evidence entered by scorer.
    overlay = main_context.new_page()
    overlay.goto(base + '/overlay/song-result.html?audio=0')
    for index in range(3):
        command(main, 'set-qualifier-display', {'currentSong': index})
        overlay.wait_for_function('''index=>document.querySelector('.song-result-heading')?.textContent.includes(`SONG ${index+1} / 3`)''', arg=index)
        idle(overlay, 'song-result')
        card = overlay.locator('[data-player-id="p1"]')
        for key, value in stats[index].items():
            assert card.locator(f'[data-stat="{key}"]').inner_text() == f'{value:,}'
        assert overlay.locator('[data-player-id="p2"] [data-stat]').all_inner_texts() == ['0'] * 5
    geometry(overlay, 'challenge-song-result-1920x1080', 1920, 1080, 'overlay')
    check('all three OBS song-result pages display the saved song score and Perfect/Good/Bad/Miss, including zero')

    # Connection loss never sends an incomplete or stale sheet.
    p3_stats = [{**row, 'score': score} for row, score in zip(stats, [970000, 960000, 950000])]
    form = fill_challenge(scorer, 'p3', p3_stats, 2880000)
    score_context.set_offline(True)
    scorer.wait_for_function('document.querySelector("#connection").classList.contains("offline")')
    assert form.locator('[data-save-player]').is_disabled()
    score_context.set_offline(False)
    scorer.wait_for_function('!document.querySelector("#connection").classList.contains("offline")', timeout=15000)
    assert song_field(scorer, 'p3', 2).input_value() == '950000'
    form.locator('[data-save-player]').click()
    saved_challenge(scorer, 'p3', p3_stats, 2880000)
    scorer.reload()
    scorer.wait_for_selector('form[data-player-key="p3"] [data-score-key]')
    scorer.evaluate(COMMANDS, 'scorekeeper')
    assert [song_field(scorer, 'p3', index).input_value() for index in range(4)] == ['970000', '960000', '950000', '2880000']
    assert score_form(scorer, 'p3').locator('[data-judgement-name="perfect"]').evaluate_all('inputs=>inputs.map(input=>input.value)') == ['700', '800', '900']
    check('offline drafts survive reconnect and complete saved sheets rehydrate after reloading the browser')

    # A host edit cannot silently overwrite a scorer's different local draft.
    song_field(scorer, 'p1', 0).fill('998766')
    song_field(scorer, 'p1', 3).fill('2950002')
    changed = [{**stats[0], 'score': 998764}, *stats[1:]]
    command(main, 'set-qualifier-challenge-result', {'group': 'A', 'playerId': 'p1', 'total': 2950000, 'songStats': changed})
    scorer.wait_for_selector('form[data-player-key="p1"] .conflict-actions:not([hidden])')
    form = score_form(scorer, 'p1')
    assert form.locator('[data-save-player]').is_disabled()
    assert song_field(scorer, 'p1', 0).input_value() == '998766'
    assert song_field(scorer, 'p1', 3).input_value() == '2950002'
    while form.locator('.conflict-actions:not([hidden]) [data-keep-draft]').count():
        form.locator('.conflict-actions:not([hidden]) [data-keep-draft]').first.click()
    resolved = [{**stats[0], 'score': 998766}, *stats[1:]]
    before, commands_before = state(main)['revision'], scorer.evaluate('window.__fixtureCommands.length')
    form.locator('[data-save-player]').click()
    saved_challenge(scorer, 'p1', resolved, 2950002)
    assert state(main)['revision'] == before + 1
    assert scorer.evaluate('window.__fixtureCommands.length') == commands_before + 1
    check('concurrent host edits require an explicit conflict decision and the resolved sheet is still one atomic save')

    # A full-sheet save must also protect fields the scorer never touched.
    song_field(scorer, 'p1', 3).fill('2950003')
    host_stats = [{**row} for row in resolved]
    host_stats[1]['good'] = 6
    command(main, 'set-qualifier-challenge-result', {
        'group': 'A', 'playerId': 'p1', 'total': 2950002, 'songStats': host_stats})
    scorer.wait_for_selector('form[data-player-key="p1"] .conflict-actions:not([hidden])')
    form = score_form(scorer, 'p1')
    assert form.locator('[data-save-player]').is_disabled()
    assert form.locator('[data-judgement-name="good"]').nth(1).input_value() == '5'
    form.locator('.conflict-actions:not([hidden]) [data-use-server]').click()
    assert form.locator('[data-judgement-name="good"]').nth(1).input_value() == '6'
    assert song_field(scorer, 'p1', 3).input_value() == '2950003'
    form.locator('[data-save-player]').click()
    saved_challenge(scorer, 'p1', host_stats, 2950003)
    check('editing only the official total still detects concurrent changes to an untouched song judgement and preserves the chosen server value')

    # The server can commit before its acknowledgement arrives. A fresh edit
    # during that wait remains an unsaved sheet until an explicit second save.
    song_field(scorer, 'p3', 2).fill('950111')
    song_field(scorer, 'p3', 3).fill('2880111')
    commands_before = scorer.evaluate('window.__fixtureCommands.length')
    hold_score_ack(scorer)
    score_form(scorer, 'p3').locator('[data-save-player]').click()
    wait_total(scorer, 'p3', 2880111)
    song_field(scorer, 'p3', 2).fill('950222')
    release_score_ack(scorer)
    scorer.wait_for_function('''()=>!document.querySelector('form[data-player-key="p3"] [data-save-player]').disabled''')
    assert song_field(scorer, 'p3', 2).input_value() == '950222'
    assert state(main)['qualifier']['rounds']['A']['results']['p3']['songStats'][2]['score'] == 950111
    assert scorer.evaluate('window.__fixtureCommands.length') == commands_before + 1
    p3_stats[2]['score'] = 950222
    score_form(scorer, 'p3').locator('[data-save-player]').click()
    saved_challenge(scorer, 'p3', p3_stats, 2880111)
    check('a late save acknowledgement cannot discard a newer field edit or automatically submit it')

    # If the host advances the batch before acknowledgement, the committed
    # sheet stays with the original player and no request targets the next one.
    song_field(scorer, 'p3', 0).fill('970456')
    song_field(scorer, 'p3', 3).fill('2880222')
    commands_before = scorer.evaluate('window.__fixtureCommands.length')
    hold_score_ack(scorer)
    score_form(scorer, 'p3').locator('[data-save-player]').click()
    wait_total(scorer, 'p3', 2880222)
    command(main, 'set-qualifier-display', {'players': ['p4', 'p5', 'p6']})
    wait_batch(scorer, ['p4', 'p5', 'p6'])
    release_score_ack(scorer)
    scorer.wait_for_function('window.__fixtureCommands.every(item=>item.done)')
    assert scorer.evaluate('window.__fixtureCommands.length') == commands_before + 1
    assert song_field(scorer, 'p4', 0).input_value() == ''
    assert state(main)['qualifier']['rounds']['A']['results']['p4']['challengeTotal'] is None
    command(main, 'set-qualifier-display', {'players': ['p1', 'p2', 'p3']})
    wait_batch(scorer, ['p1', 'p2', 'p3'])
    p3_stats[0]['score'] = 970456
    assert song_field(scorer, 'p3', 0).input_value() == '970456'
    if not score_form(scorer, 'p3').locator('[data-save-player]').is_disabled():
        score_form(scorer, 'p3').locator('[data-save-player]').click()
    saved_challenge(scorer, 'p3', p3_stats, 2880222)
    check('switching the host batch while a save acknowledgement is pending never sends the sheet to a new player')

    # activePlayers is part of the context even when group and songs stay fixed.
    song_field(scorer, 'p3', 0).fill('970123')
    original_context = state(scorer, 'scorekeeper')['contextKey']
    scorer.evaluate('window.__detachedScoreForm=document.querySelector(\'form[data-player-key="p3"]\')')
    command(main, 'set-qualifier-display', {'players': ['p4', 'p5', 'p6']})
    wait_batch(scorer, ['p4', 'p5', 'p6'])
    assert '970123' in scorer.locator('#draft-notice').inner_text()
    assert scorer.locator('.stale-context').count() == 1
    assert song_field(scorer, 'p4', 0).input_value() == ''
    before = state(main)['revision']
    response = raw_command(scorer, 'set-qualifier-challenge-result', {
        'group': 'A', 'playerId': 'p3', 'total': 2880222, 'songStats': p3_stats}, original_context)
    assert not response['ok'] and response['code'] == 'CONTEXT_CHANGED'
    scorer.evaluate('window.__detachedScoreForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    assert state(main)['revision'] == before
    command(main, 'set-qualifier-display', {'players': []})
    wait_batch(scorer, [])
    assert scorer.locator('.empty-state').is_visible()
    assert scorer.locator('input[data-score-key]').count() == 0
    command(main, 'set-qualifier-display', {'players': ['p3']})
    wait_batch(scorer, ['p3'])
    # This is a different exact batch, so the original draft must stay parked.
    assert song_field(scorer, 'p3', 0).input_value() == '970456'
    assert '970123' in scorer.locator('#draft-notice').inner_text()
    command(main, 'set-qualifier-display', {'players': ['p1', 'p2', 'p3']})
    wait_batch(scorer, ['p1', 'p2', 'p3'])
    assert song_field(scorer, 'p3', 0).input_value() == '970123'
    p3_stats[0]['score'] = 970123
    score_form(scorer, 'p3').locator('[data-save-player]').click()
    saved_challenge(scorer, 'p3', p3_stats, 2880222)
    check('same-group batch changes, empty batches and smaller batches cannot retarget drafts or detached forms')

    for width, height in [(1600, 1000), (1194, 834), (834, 1194), (390, 844)]:
        geometry(scorer, f'challenge-scorekeeper-{width}x{height}', width, height, 'scorekeeper')
    check('desktop, landscape tablet, portrait tablet and phone sheets have no overlapping controls or text and retain 48px touch targets')

    # The existing Challenge tiebreak is intentionally a separate score-only sheet.
    for player, value in [('p4', 2800000), ('p5', 2800000), ('p6', 2700000), ('p7', 2600000), ('p8', 2500000)]:
        command(main, 'set-qualifier-total', {'group': 'A', 'playerId': player, 'total': value})
    command(main, 'draw-qualifier-tiebreak', {'group': 'A', 'playerIds': ['p4', 'p5']})
    wait_batch(scorer, ['p4', 'p5'])
    assert scorer.locator('input[data-score-key]').count() == 2
    assert scorer.locator('input[data-judgement-key]').count() == 0
    for player, value in [('p4', 900000), ('p5', 800000)]:
        form = score_form(scorer, player)
        form.locator('[data-score-key]').fill(str(value))
        form.locator('[data-save-player]').click()
        main.wait_for_function('''async data=>{
          const current=await fetch('/api/state').then(response=>response.json());
          return current.qualifier.rounds.A.tiebreaks[0].scores[data.player]===data.score;
        }''', arg={'player': player, 'score': value})
    command(main, 'confirm-qualifier-tiebreak', {'group': 'A', 'index': 0, 'verified': True})
    assert state(main)['qualifier']['rounds']['A']['results']['p4']['challengeTotal'] == 2800000
    command(main, 'finalize-qualifier-round', {'group': 'A', 'verified': True})
    current = state(main)
    assert current['qualifier']['activeGroup'] == 'B'
    for index, player in enumerate(current['qualifier']['rounds']['B']['playerIds']):
        command(main, 'set-qualifier-total', {'group': 'B', 'playerId': player, 'total': 2400000-index*100000})
    command(main, 'finalize-qualifier-round', {'group': 'B', 'verified': True})
    current = state(main)
    command(main, 'seed-bracket', {'ids': current['qualifier']['rounds']['A']['qualifiedIds'] + current['qualifier']['rounds']['B']['qualifiedIds'], 'verified': True})
    command(main, 'set-stage', {'stage': 'qualifier'})
    scorer.wait_for_function('document.querySelectorAll("input[data-score-key]:not(:disabled)").length===0')
    check('qualifier tiebreak scoring remains score-only and completed qualification locks the result sheets')

    command(main, 'select-match', {'matchId': 'W1'})
    command(main, 'draw-candidates', {'matchId': 'W1'})
    match = next(row for row in state(main)['tournament']['matches'] if row['id'] == 'W1')
    for player_index in range(2):
        command(main, 'ban-song', {'matchId': 'W1', 'playerIndex': player_index, 'songId': match['candidates'][player_index]['id']})
    command(main, 'pick-songs', {'matchId': 'W1'})
    command(main, 'set-stage', {'stage': 'double-elimination'})
    scorer.wait_for_function('document.querySelectorAll("input[data-score-key]").length===4')
    assert scorer.locator('input[data-judgement-name="accuracy"]').count() == 4
    form = score_form(scorer, '0')
    form.locator('input[data-score-key]').first.fill('999999')
    form.locator('input[data-judgement-name="accuracy"]').first.fill('98.7654')
    form.locator('[data-save-player]').click()
    main.wait_for_function('''async()=>{
      const current=await fetch('/api/state').then(response=>response.json());
      const match=current.tournament.matches.find(item=>item.id==='W1');
      return match.scores[0][0]===999999&&match.judgements[0][0].accuracy===98.7654;
    }''')
    check('Double Elimination retains its existing per-song score and Accuracy entry')
    score_context.close()
    main_context.close()


def exercise_plan_b(browser, base):
    main_context, main = login(browser, base)
    score_context, scorer = login(browser, base, 'scorekeeper')
    current = state(main)
    q = current['qualifier']
    assert q['plan'] == 'B'
    a, b = q['rounds']['A']['playerIds'], q['rounds']['B']['playerIds']
    assert len(a) == 11 and len(b) == 10
    wait_batch(scorer, a[:3])
    stats = [dict.fromkeys(['score', 'perfect', 'good', 'bad', 'miss'], 0) for _ in range(3)]
    fill_challenge(scorer, a[1], stats, 2999123)
    old_context = state(scorer, 'scorekeeper')['contextKey']
    command(main, 'set-qualifier-display', {'group': 'B', 'players': b[:3]})
    wait_batch(scorer, b[:3])
    assert '2999123' in scorer.locator('#draft-notice').inner_text()
    assert song_field(scorer, b[0], 3).input_value() == ''
    before = state(main)['revision']
    response = raw_command(scorer, 'set-qualifier-challenge-result', {
        'group': 'A', 'playerId': a[1], 'total': 2999123, 'songStats': stats}, old_context)
    assert not response['ok'] and state(main)['revision'] == before
    form = fill_challenge(scorer, b[0], stats, 2800001)
    form.locator('[data-save-player]').click()
    saved_challenge(scorer, b[0], stats, 2800001, 'B')
    assert state(main)['qualifier']['rounds']['A']['results'][a[1]]['challengeTotal'] is None
    command(main, 'set-qualifier-display', {'group': 'A', 'players': a[:3]})
    wait_batch(scorer, a[:3])
    assert song_field(scorer, a[1], 3).input_value() == '2999123'
    geometry(scorer, 'plan-b-stale-draft-834x1194', 834, 1194, 'scorekeeper')
    check('Plan B groups show only their active batch, retain independent official totals and restore drafts only to their original context')
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
                            exercise_new(browser, base, data_dir)
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
