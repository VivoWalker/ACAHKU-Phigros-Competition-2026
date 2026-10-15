"""Optional Chromium lifecycle/retained-memory regression.

Runs only fixture tournaments in temporary directories. CDP collects JavaScript
garbage before every sample; this measures retained JS, DOM/listener counts and
released component roots, not OBS/native decoder/GPU/operating-system memory.
Requires Python Playwright and Chromium. Reports are ignored under test-results
or written to BROADCAST_TEST_OUTPUT. No production event/PIN files are read.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import statistics
import subprocess
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'memory-lifecycle'))
PIN = 'memory-lifecycle-fixture-only'
REPORT = {'checks': [], 'samples': [], 'browser_errors': [], 'limitations': [
    'Post-GC Chromium JavaScript/DOM observations do not measure native OBS, GPU, image-decoder or OS RAM.',
    'Finite repeated-workload regression can find retention and establish a plateau; it cannot prove the absence of every leak.'
]}

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const state=require('./lib/default-state').createDefaultState(),T=require('./lib/tournament');
const regular=state.library.filter(song=>song.eligible).slice(0,6).map(song=>song.id);
for(const [i,song] of state.library.entries()){
  song.art='assets/song/cover-'+(i%6+1)+'.svg';song.eligible=regular.includes(song.id);
}
const act=(type,payload={})=>T.applyAction(state,{type,payload:{matchId:state.tournament.currentMatchId,...payload}});
act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026',verified:true});
act('set-scene',{scene:'start'});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const broadcast=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'memory-lifecycle-fixture-only',scorekeeperPin:'memory-score-fixture-only'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""

# Counters are primitives and weak references only: instrumentation must not
# itself retain every image/audio/animation under test.
PROBE = r"""(() => {
  const diagnostics=window.__lifecycle={maxAudio:0,maxCovers:0,weakRoots:[],weakAudio:[],weakImages:[],warmups:[],sockets:[],createdAudio:0};
  const NativeAudio=window.Audio;
  window.Audio=function(...args){diagnostics.createdAudio++;const item=new NativeAudio(...args);diagnostics.weakAudio.push(new WeakRef(item));return item};
  window.Audio.prototype=NativeAudio.prototype;
  const NativeImage=window.Image;
  window.Image=function(...args){const item=new NativeImage(...args);diagnostics.weakImages.push(new WeakRef(item));return item};
  window.Image.prototype=NativeImage.prototype;
  diagnostics.intervals=new Set();
  const nativeInterval=window.setInterval,nativeClearInterval=window.clearInterval;
  window.setInterval=(...args)=>{const id=nativeInterval(...args);diagnostics.intervals.add(id);return id};
  window.clearInterval=id=>{diagnostics.intervals.delete(id);return nativeClearInterval(id)};
  let warmup;
  Object.defineProperty(window,'BroadcastMediaWarmup',{configurable:true,get(){return warmup},set(api){
    const original=api.createController;
    api.createController=options=>{
      const controller=original(options);diagnostics.warmups.push(new WeakRef(controller));return controller;
    };warmup=api;
  }});
  let socketFactory;
  Object.defineProperty(window,'createBroadcastSocket',{configurable:true,get(){return socketFactory},set(factory){
    socketFactory=(...args)=>{const socket=factory(...args);diagnostics.sockets.push(new WeakRef(socket));return socket};
  }});
})();"""

CONNECT = r"""async ({token}) => {
  const socket=io('/control',{forceNew:true,auth:{token}});
  await new Promise((resolve,reject)=>{
    socket.once('state',state=>{window.__fixtureState=state;resolve()});
    socket.once('connect_error',reject);
  });
  socket.on('state',state=>window.__fixtureState=state);
  window.__fixtureSocket=socket;
  window.__fixtureCommand=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{
    expectedRevision:window.__fixtureState.revision,action:{type,payload:{
      matchId:window.__fixtureState.tournament.currentMatchId,...payload}}
  },result=>result.ok?resolve(result):reject(new Error(type+': '+result.error))));
}"""

COMPONENT_BATCH = r"""async count => {
  const diagnostics=window.__lifecycle,state=window.__fixtureState;
  const eligibleState={...state,stage:'qualifier',scene:'qualifier-match'};
  const eligible=BroadcastCountdown.context(eligibleState);
  const paths=['/assets/song/cover-1.svg','/assets/song/cover-2.svg'];
  for(let index=0;index<count;index++){
    const canvas=document.createElement('div');
    Object.assign(canvas.style,{position:'absolute',width:'1920px',height:'1080px',left:'-2500px'});
    const mount=document.createElement('div');canvas.append(mount);document.body.append(canvas);
    diagnostics.weakRoots.push(new WeakRef(canvas));
    const motion=BroadcastMotion.createScene(mount,{canvas});
    await motion.update('<div class="selection-art" style="width:500px;height:280px;--cover-edge-offset:70px"><img src="'+paths[0]+'"></div>',{scene:'song-selection'});
    const cover=mount.querySelector('.selection-art');
    await BroadcastMotion.coverSlide(cover,paths[0],{src:paths[1]});
    const bracket=BroadcastBracket.createController(mount,()=>{});
    bracket.prepare(state,true);bracket.afterCommit();
    const layer=BroadcastCountdown.createLayer(canvas);
    const now=Date.now(),client={connected:true,now:()=>now,cue:{id:'lifecycle-'+index,startsAt:now,endsAt:now+3950,context:eligible}};
    for(const elapsed of [0,1100,2100,3050]){
      client.now=()=>now+elapsed;layer.update(client,eligibleState,'qualifier-match');
    }
    client.cue=null;layer.update(client,eligibleState,'qualifier-match');
    client.cue={id:'restart-'+index,startsAt:now,endsAt:now+3950,context:eligible};
    layer.update(client,eligibleState,'qualifier-match');
    const listeners=new Map(),clockSocket={connected:true,
      on(event,callback){listeners.set(event,callback)},off(event){listeners.delete(event)},
      timeout(){return {emit(event,callback){callback(null,{serverNow:Date.now(),sequence:0,cue:null})}}}};
    const clockClient=BroadcastCountdown.createClient(clockSocket,()=>{});clockClient.dispose();
    if(listeners.size)throw new Error('Disposed countdown client retains socket listeners');
    const warmup=BroadcastMediaWarmup.createController({maxDecoded:4,timeoutMs:100});
    const warming=warmup.prepare(paths);warmup.dispose();await warming;
    const song=state.library.find(item=>item.previewAudio);
    const player=BroadcastSelectionAudio.createPlayer({fadeMs:0,now:()=>Date.now()});
    player.update({active:true,songs:[song],cue:{id:'component-'+index,kind:'ban',songIds:[song.id],startedAt:Date.now()}});
    player.dispose();player.dispose();
    layer.dispose();layer.dispose();bracket.dispose();bracket.dispose();motion.dispose();motion.dispose();
    if(canvas.getAnimations({subtree:true}).length)throw new Error('Disposed component retains animation effects');
    if(canvas.querySelector('.match-countdown,[data-motion-content],[data-motion-branding]'))throw new Error('Disposed component retains its owned DOM');
    canvas.remove();
  }
  await new Promise(resolve=>setTimeout(resolve,80));
}"""

DETACHED_BATCH = r"""async count => {
  for(let index=0;index<count;index++){
    const canvas=document.createElement('div'),mount=document.createElement('div');
    canvas.append(mount);document.body.append(canvas);__lifecycle.weakRoots.push(new WeakRef(canvas));
    const scene=BroadcastMotion.createScene(mount,{canvas});
    await scene.update('<p class="empty-copy">Detached scene fixture</p>',{scene:'start'});
    canvas.remove();
  }
  await new Promise(resolve=>setTimeout(resolve,80));
}"""

INTERRUPTION = r"""async () => {
  const canvas=document.createElement('div'),mount=document.createElement('div');
  Object.assign(canvas.style,{position:'absolute',width:'1920px',height:'1080px',left:'-2500px'});
  canvas.append(mount);document.body.append(canvas);__lifecycle.weakRoots.push(new WeakRef(canvas));
  const scene=BroadcastMotion.createScene(mount,{canvas});
  await scene.update('<p class="empty-copy">Before</p>',{scene:'start'});
  const changing=scene.update('<div class="scene-head"><h1>After</h1></div>',{scene:'result'});
  await new Promise(resolve=>setTimeout(resolve,40));
  if(!canvas.getAnimations({subtree:true}).length)throw new Error('Scene interruption fixture did not start real animations');
  scene.dispose();
  await Promise.race([changing,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Interrupted scene promise never settled')),2000))]);
  const state={...__fixtureState,stage:'qualifier',scene:'qualifier-match'},eligible=BroadcastCountdown.context(state);
  const now=Date.now(),client={connected:true,now:()=>now,cue:{id:'interrupted-countdown',startsAt:now,endsAt:now+3950,context:eligible}};
  const layer=BroadcastCountdown.createLayer(canvas);layer.update(client,state,'qualifier-match');
  if(!canvas.getAnimations({subtree:true}).length)throw new Error('Countdown interruption fixture did not start real animations');
  layer.dispose();
  const cover=document.createElement('div');cover.className='selection-art';
  Object.assign(cover.style,{width:'500px',height:'280px'});
  cover.innerHTML='<img src="/assets/song/cover-1.svg">';canvas.append(cover);
  const sliding=BroadcastMotion.coverSlide(cover,'/assets/song/cover-1.svg',{src:'/assets/song/cover-2.svg'});
  const began=performance.now();
  while(cover.dataset.coverMotionPhase!=='move'){
    if(performance.now()-began>2000)throw new Error('Cover interruption fixture did not start real animations');
    await new Promise(requestAnimationFrame);
  }
  BroadcastMotion.disposeCovers(canvas);await sliding;cover.remove();
  if(canvas.getAnimations({subtree:true}).length)throw new Error('Interrupted components retain animation effects');
  canvas.remove();
}"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def start_server(directory):
    process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=15):
            stop_server(process)
            raise AssertionError('Temporary memory fixture server did not start')
    port = process.stdout.readline().strip()
    if not port.isdigit():
        output, errors = process.communicate(timeout=5)
        raise AssertionError('Temporary fixture server did not report its port: ' + errors + output)
    return process, 'http://127.0.0.1:' + port


def stop_server(process):
    process.terminate()
    try:
        process.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=8)


def idle(page, scene):
    page.wait_for_function('''scene=>{
      const mount=document.querySelector('#scene');
      return mount?.dataset.motionPhase==='idle'&&document.querySelector('#canvas')?.dataset.renderedScene===scene
        &&!mount.querySelector('[data-motion-ghost],[data-motion-live],[data-motion-placeholder],[data-motion-exits]')
        &&!mount.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending);
    }''', arg=scene, timeout=15000)


def command(page, action, payload=None):
    return page.evaluate('a=>window.__fixtureCommand(a.type,a.payload)', {'type': action, 'payload': payload or {}})


def scene(page, name):
    command(page, 'set-scene', {'scene': name})
    idle(page, name)


def bounded(page):
    value = page.evaluate('''()=>{
      const audio=document.querySelectorAll('audio[data-selection-audio],audio[data-selection-audio-prepared],audio[data-selection-audio-retiring]').length;
      const covers=Math.max(0,...[...document.querySelectorAll('.selection-art,.cover-window')].map(node=>node.querySelectorAll('img').length));
      __lifecycle.maxAudio=Math.max(__lifecycle.maxAudio,audio);__lifecycle.maxCovers=Math.max(__lifecycle.maxCovers,covers);
      const warmups=__lifecycle.warmups.map(ref=>ref.deref()).filter(Boolean).map(item=>item.status());
      return {audio,covers,warmups};
    }''')
    assert value['audio'] <= 3, value
    assert value['covers'] <= 2, value
    assert all(item['ready'] + item['loading'] <= 12 and item['loading'] <= 2 for item in value['warmups']), value


def cycle(page, index, real_audio=True):
    scene(page, 'song-selection')
    command(page, 'draw-candidates')
    page.wait_for_function("document.querySelectorAll('.candidate').length===6")
    ids = page.evaluate('''()=>__fixtureState.tournament.matches.find(m=>m.id===__fixtureState.tournament.currentMatchId).candidates.map(s=>s.id)''')
    command(page, 'ban-song', {'playerIndex': 0, 'songId': ids[0]})
    if real_audio:
        page.wait_for_function("(()=>{const audio=document.querySelector('audio[data-selection-audio]');return audio&&!audio.paused&&audio.readyState>=2})()", timeout=5000)
    bounded(page)
    command(page, 'ban-song', {'playerIndex': 1, 'songId': ids[1]})
    bounded(page)
    command(page, 'pick-songs')
    bounded(page)
    for name in ['double-elimination-waiting', 'double-elimination-match', 'song-result', 'bracket', 'qualifier-waiting', 'qualifier-match', 'start']:
        scene(page, name)
        bounded(page)
    page.wait_for_function("document.querySelectorAll('audio[data-selection-audio],audio[data-selection-audio-prepared],audio[data-selection-audio-retiring]').length===0", timeout=5000)


def sample(page, cdp, name, cycles):
    page.evaluate('performance.clearResourceTimings()')
    # Two event-loop turns let promises cancelled by disposal release closures.
    page.wait_for_timeout(100)
    for _ in range(2):
        cdp.send('HeapProfiler.collectGarbage')
        page.wait_for_timeout(40)
    heap = cdp.send('Runtime.getHeapUsage')
    dom = cdp.send('Memory.getDOMCounters')
    resources = page.evaluate('''()=>{
      for(const key of ['weakRoots','weakAudio','weakImages','warmups','sockets'])
        __lifecycle[key]=__lifecycle[key].filter(ref=>ref.deref());
      return {
      transient:document.querySelectorAll('[data-motion-ghost],[data-motion-live],[data-motion-placeholder],[data-motion-exits],[data-motion-cover-old],[data-bracket-ghost]').length,
      audio:document.querySelectorAll('audio').length,
      animations:document.getAnimations().filter(a=>a.playState==='running'||a.pending).length,
      weakRoots:__lifecycle.weakRoots.filter(ref=>ref.deref()).length,
      survivingAudio:__lifecycle.weakAudio.filter(ref=>ref.deref()).length,
      survivingImages:__lifecycle.weakImages.filter(ref=>ref.deref()).length,
      connectedSockets:__lifecycle.sockets.filter(ref=>ref.deref()?.connected).length,
      intervals:__lifecycle.intervals.size,
      mediaCreated:__lifecycle.createdAudio
    }}''')
    result = {'name': name, 'cycles': cycles, 'heapBytes': heap['usedSize'], 'embedderHeapBytes': heap.get('embedderHeapUsedSize'),
              **dom, **resources, 'elapsedSeconds': round(time.monotonic() - STARTED, 2)}
    REPORT['samples'].append(result)
    print('SAMPLE ' + json.dumps(result), flush=True)
    assert resources['transient'] == resources['audio'] == resources['animations'] == resources['weakRoots'] == 0, result
    return result


def plateau(samples, label):
    # All samples represent the same idle scene after a warmed finite asset set.
    # Allow sub-megabyte engine/JIT variance, but reject retained DOM/listeners
    # and an increasing last-batch heap rather than merely imposing a huge cap.
    first, last = samples[0], samples[-1]
    for field in ['documents', 'nodes', 'jsEventListeners']:
        assert last[field] <= first[field] + (2 if field == 'nodes' else 0), (label, field, samples)
    heaps = [item['heapBytes'] for item in samples]
    heap_budget = max(512 * 1024, first['heapBytes'] * .08)
    assert max(heaps) - min(heaps) <= heap_budget, (label, 'Retained heap did not plateau', heaps, heap_budget)
    assert heaps[-1] - heaps[-2] <= 192 * 1024, (label, 'Last equal-work batch retained too much JS', heaps)
    check(label + ' reaches a post-GC heap/DOM/listener plateau', {
        'heapRangeBytes': max(heaps) - min(heaps), 'heapRangeBudgetBytes': round(heap_budget),
        'lastBatchGrowthBytes': heaps[-1] - heaps[-2], 'sampleCount': len(samples),
        'medianHeapBytes': round(statistics.median(heaps))})


def panel_lifecycle(browser, base, role):
    context = browser.new_context(viewport={'width': 1194, 'height': 900}, reduced_motion='reduce')
    context.add_init_script(PROBE)
    panel = context.new_page()
    panel.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error)))
    panel.goto(base + '/' + role + '/')
    panel.fill('#pin', PIN if role == 'control' else 'memory-score-fixture-only')
    panel.click('#pair-form button')
    panel.wait_for_selector('#workspace:not([hidden])')
    if role == 'control':
        panel.click('[data-tab="event"]')
        field = panel.locator('#event-message')
        value = 'Unsaved director lifecycle fixture'
    else:
        field = panel.locator('[data-score-key]:not([disabled])').first
        value = '987654'
    field.fill(value)
    cdp = context.new_cdp_session(panel)
    before = sample(panel, cdp, role + '-before-pagehide', 0)
    panel.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
    panel.wait_for_timeout(100)
    assert field.input_value() == value, (role, 'BFCache pagehide lost an unsaved draft')
    assert panel.evaluate('__lifecycle.sockets.some(ref=>ref.deref()?.connected)'), role
    check(role + ' preserves its unsaved draft and socket for persisted BFCache pagehide')
    panel.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}))")
    panel.wait_for_timeout(200)
    after = sample(panel, cdp, role + '-after-pagehide', 1)
    assert after['connectedSockets'] == after['intervals'] == 0, (role, after)
    assert after['jsEventListeners'] < before['jsEventListeners'], (role, before, after)
    check(role + ' releases its sockets, periodic timers and owned DOM listeners on final pagehide', {
        'listenersBefore': before['jsEventListeners'], 'listenersAfter': after['jsEventListeners']})
    context.close()


STARTED = time.monotonic()
OUT.mkdir(parents=True, exist_ok=True)
try:
    with tempfile.TemporaryDirectory(prefix='acahku-memory-browser-') as directory:
        process, base = start_server(directory)
        try:
            with sync_playwright() as playwright:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
                browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
                    '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'])
                context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce')
                context.add_init_script(PROBE)
                page = context.new_page()
                page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error)))
                page.goto(base + '/overlay/live.html')
                idle(page, 'start')
                token = context.request.post(base + '/api/session', data={'pin': PIN}).json()['token']
                page.evaluate(CONNECT, {'token': token})
                cdp = context.new_cdp_session(page)
                cdp.send('HeapProfiler.enable')
                cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
                warm_cycles, batch_cycles = 8, 20
                for index in range(warm_cycles):
                    cycle(page, index)
                live_samples = [sample(page, cdp, 'live-warm-baseline', warm_cycles)]
                for batch in range(3):
                    for index in range(batch_cycles):
                        cycle(page, index)
                    live_samples.append(sample(page, cdp, 'live-batch-' + str(batch + 1), warm_cycles + batch_cycles * (batch + 1)))
                plateau(live_samples, str(batch_cycles * 3) + ' regular scene/selection cycles')
                check('actual selection media, cover layers and decoded-image caches stay bounded', page.evaluate('''()=>({maxAudio:__lifecycle.maxAudio,maxCovers:__lifecycle.maxCovers,mediaCreated:__lifecycle.createdAudio})'''))

                page.evaluate(COMPONENT_BATCH, 12)
                component_samples = [sample(page, cdp, 'components-warm-baseline', 12)]
                for batch in range(3):
                    page.evaluate(COMPONENT_BATCH, 30)
                    component_samples.append(sample(page, cdp, 'components-batch-' + str(batch + 1), 12 + 30 * (batch + 1)))
                plateau(component_samples, 'Ninety component create/restart/cancel/dispose cycles')
                check('disposed component roots are collectable; no retained countdown/cover/scene DOM or animations')
                page.evaluate(DETACHED_BATCH, 30)
                sample(page, cdp, 'automatically-disposed-detached-scenes', 30)
                check('thirty detached scene mounts are automatically disposed and become collectable while the live scene remains connected')

                # Real animation paths, including an interrupted active countdown,
                # are exercised separately from the fast repeated reduced mode.
                page.emulate_media(reduced_motion='no-preference')
                for name in ['qualifier-match', 'bracket', 'start']:
                    scene(page, name)
                page.evaluate(INTERRUPTION)
                page.emulate_media(reduced_motion='reduce')
                sample(page, cdp, 'after-real-animation-transitions', 3)
                check('normal-motion transitions and active scene/countdown interruption settle without leftover animations or unresolved promises')

                scene(page, 'double-elimination-match')
                for role in ['control', 'scorekeeper']:
                    panel_lifecycle(browser, base, role)
                scene(page, 'start')

                # The fixture command socket is test-owned; close it before the
                # application pagehide teardown so remaining sockets are app-owned.
                page.evaluate('''()=>{__fixtureSocket.disconnect();delete window.__fixtureCommand;delete window.__fixtureSocket;delete window.__fixtureState;dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}))}''')
                page.wait_for_timeout(400)
                closed = sample(page, cdp, 'overlay-pagehide-disposed', 1)
                assert closed['connectedSockets'] == closed['intervals'] == 0, closed
                assert not page.locator('.match-countdown,[data-motion-content],[data-motion-branding]').count()
                check('pagehide disconnects application sockets and disposes countdown, motion and media controllers')
                assert not REPORT['browser_errors'], REPORT['browser_errors']
                browser.close()
        finally:
            stop_server(process)
finally:
    REPORT['durationSeconds'] = round(time.monotonic() - STARTED, 2)
    (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2), encoding='utf-8')
    print('REPORT ' + str(OUT / 'report.json'), flush=True)
