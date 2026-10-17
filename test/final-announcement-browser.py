"""Real Chromium regression for the sequential final reveal and red invasion.

Uses a complete official tournament in a temporary directory, fixture-only
pairing codes and the packaged final previews. No live data or PINs are read.
Requires Python Playwright, Pillow and Chromium. Artifacts are ignored under
test-results/final-announcement or BROADCAST_TEST_OUTPUT.
"""
import importlib.util
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

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/final-announcement'))
REPORT = {'checks': [], 'browser_errors': [], 'geometry': [], 'screenshots': [], 'audio': []}
spec = importlib.util.spec_from_file_location('final_helpers', ROOT / 'test/fixed-final-browser.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
FINAL_IDS = helper.FINAL_IDS

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],file=path.join(dir,'match-state.json');
if(!fs.existsSync(file)){
  const state=require('./lib/default-state').createDefaultState(),T=require('./lib/tournament');
  const act=(type,payload={})=>T.applyAction(state,{type,payload:{matchId:state.tournament.currentMatchId,...payload}});
  act('seed-bracket',{ids:state.qualifier.players.map(p=>p.id),ruleset:'proposal-2026',verified:true});
  for(const matchId of ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']){
    act('select-match',{matchId});act('draw-candidates');
    const match=state.tournament.matches.find(m=>m.id===matchId);
    act('ban-song',{playerIndex:0,songId:match.candidates[0].id});
    act('ban-song',{playerIndex:1,songId:match.candidates[1].id});act('pick-songs');
    for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act('set-match-score',{playerIndex:pi,songIndex:si,score:pi?980000:990000});
    act('record-result',{verified:true});
  }
  act('select-match',{matchId:'GF'});act('set-scene',{scene:'bracket'});
  fs.writeFileSync(file,JSON.stringify(state));
}
const app=require('./server').createBroadcastServer({dataDir:dir,pin:'fixed-final-main-fixture',scorekeeperPin:'fixed-final-score-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""

PROBE = r"""(() => {
  const NativeAudio=window.Audio,probe=window.__finalProbe={media:[],events:[],sockets:[]};
  window.Audio=function(...args){
    const audio=new NativeAudio(...args),index=probe.media.push(audio)-1,play=audio.play;
    audio.__plays=0;
    audio.play=function(...args){audio.__plays++;return play.apply(audio,args)};
    for(const kind of ['play','playing','ended','pause','error'])audio.addEventListener(kind,()=>probe.events.push({kind,index,src:audio.currentSrc||audio.src,time:audio.currentTime,at:Date.now()}));
    return audio;
  };
  window.Audio.prototype=NativeAudio.prototype;
  let factory;
  Object.defineProperty(window,'createBroadcastSocket',{configurable:true,get(){return factory},set(original){
    factory=(...args)=>{const socket=original(...args);probe.sockets.push(socket);return socket};
  }});
})();"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def start_server(directory):
    process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=20):
            helper.stop_server(process)
            raise AssertionError('The temporary final server did not start')
    port = process.stdout.readline().strip()
    if not port.isdigit():
        output, errors = process.communicate(timeout=8)
        raise AssertionError(port + errors + output)
    return process, 'http://127.0.0.1:' + port


def audio(page):
    return page.evaluate('''()=>({status:document.querySelector('#canvas')?.dataset.selectionAudio,
      song:document.querySelector('#canvas')?.dataset.selectionAudioSong,
      items:__finalProbe.media.map((a,index)=>({index,src:a.getAttribute('src'),time:a.currentTime,
        paused:a.paused,volume:a.volume,plays:a.__plays,loop:a.loop,duration:a.duration})),events:__finalProbe.events})''')


def playing(page, song):
    page.wait_for_function('''id=>[...document.querySelectorAll('audio[data-selection-audio]')].some(a=>
      a.dataset.songId===id&&!a.paused&&a.currentTime>.05&&a.volume>.1)''', arg=song, timeout=12000)
    result = audio(page)
    assert not page.locator('audio[data-scene-bgm],audio[data-scene-bgm-retiring]').count(), result
    current = next(a for a in result['items'] if a['src'] and not a['paused'] and '/song-preview/' in a['src'])
    assert not current['loop'], current
    return current


def no_preview(page):
    page.wait_for_function('''()=>__finalProbe.media.filter(a=>!a.matches('[data-scene-bgm],[data-scene-bgm-retiring]'))
      .every(a=>a.paused&&!a.getAttribute('src')&&a.volume===0)''', timeout=6000)


def screenshot(page, name):
    path = OUT / name
    image = page.screenshot(path=str(path), omit_background=True)
    REPORT['screenshots'].append(str(path))
    return Image.open(io.BytesIO(image)).convert('RGBA')


def geometry(page, phase):
    for width, height in [(1920, 1080), (1194, 834), (834, 1194), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        helper.overlay_geometry(page, width, height)
        result = helper.REPORT['geometry'][-1]
        result['phase'] = phase
        REPORT['geometry'].append(result)
    page.set_viewport_size({'width': 1920, 'height': 1080})


def effect(page):
    return page.evaluate('''()=>{const g=document.querySelector('g[data-finale-effects]');return {
      count:document.querySelectorAll('g[data-finale-effects]').length,
      masked:g?.parentElement?.getAttribute('mask'),coverage:Number(g?.dataset.coverage),
      baseline:Number(g?.dataset.edgeBaseline),paths:[...g?.querySelectorAll('path')||[]].map(p=>p.getAttribute('d')),
      infected:document.querySelector('#canvas').classList.contains('finale-infected'),
      active:document.querySelector('#canvas').dataset.finaleActive,
      running:document.querySelector('#canvas').classList.contains('finale-effects-running')};}''')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    process = None
    with tempfile.TemporaryDirectory(prefix='acahku-final-reveal-') as directory, sync_playwright() as pw:
        binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
        browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
            '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'])
        contexts = []

        def new_page(base, path='/overlay/live.html', reduced=False):
            context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce' if reduced else 'no-preference')
            contexts.append(context)
            context.add_init_script(PROBE)
            context.on('page', lambda p: p.on('pageerror', lambda e: REPORT['browser_errors'].append(str(e))))
            page = context.new_page()
            page.goto(base + path)
            page.bring_to_front()
            context.new_cdp_session(page).send('Emulation.setFocusEmulationEnabled', {'enabled': True})
            return page

        try:
            process, base = start_server(directory)
            crew_context = browser.new_context(viewport={'width': 1194, 'height': 834})
            contexts.append(crew_context)
            crew = helper.login(crew_context, base)
            live = new_page(base)
            helper.idle(live, 'bracket')
            live.wait_for_function("document.querySelector('audio[data-scene-bgm]')?.dataset.trackId==='chapter9-ambience'&&!document.querySelector('audio[data-scene-bgm]').paused")
            assert not effect(live)['infected']
            helper.command(crew, 'set-scene', {'scene': 'song-selection'})
            helper.idle(live, 'song-selection')
            assert live.locator('.final-announcement-pending').count() == 1
            assert live.locator('[data-final-song]').count() == 0
            no_preview(live)
            check('the bracket is clean and the selection alias hides both final songs before the dedicated reveal')

            # References must survive every hero and scene replacement.
            helper.command(crew, 'set-scene', {'scene': 'grand-final-announcement'})
            helper.idle(live, 'grand-final-announcement')
            first = playing(live, FINAL_IDS[0])
            assert live.locator('.final-announcement-hero').count() == 1
            assert live.locator('.final-announcement-hero').get_attribute('data-final-song') == FINAL_IDS[0]
            assert 'Petrichor' not in live.locator('#scene').inner_text()
            assert ''.join(live.locator('.final-song-difficulty').inner_text().split()) == 'IN17'
            geometry(live, 'Desultory Signals')
            live.wait_for_function("Number(document.querySelector('#canvas').dataset.finaleCoverage)>.325", timeout=7000)
            first_effect = effect(live)
            assert first_effect['count'] == 1 and first_effect['masked'] == 'url(#capture-mask)'
            assert .325 < first_effect['coverage'] < .34, first_effect
            screenshot(live, 'final-song-01-desultory-signals.png')
            live.wait_for_timeout(250)
            assert effect(live)['paths'] != first_effect['paths'], 'The red edge and pixels must flow and change shape'
            before = playing(live, FINAL_IDS[0])
            helper.command(crew, 'set-event', {'message': 'Temporary fixture: an unrelated event revision.'})
            live.wait_for_timeout(250)
            after = playing(live, FINAL_IDS[0])
            assert before['index'] == after['index'] and before['plays'] == after['plays'] == 1 and after['time'] > before['time']
            check('Desultory Signals IN17 plays once, only its hero appears, red invasion reaches one third and unrelated revisions do not restart audio', first_effect)

            resume_time = after['time']
            live.reload()
            helper.idle(live, 'grand-final-announcement')
            resumed = playing(live, FINAL_IDS[0])
            assert resumed['time'] >= resume_time - .3 and resumed['time'] > 2, (resume_time, resumed)
            check('reloading during the first reveal seeks to the synchronized current position')

            live.wait_for_function("document.querySelector('.final-announcement-hero')?.dataset.finalSong==='competition-2026-gf-02'", timeout=16000)
            helper.idle(live, 'grand-final-announcement')
            second = playing(live, FINAL_IDS[1])
            assert ''.join(live.locator('.final-song-difficulty').inner_text().split()) == 'AT17'
            assert 'Desultory Signals' not in live.locator('#scene').inner_text()
            geometry(live, 'Petrichor')
            live.wait_for_function("Number(document.querySelector('#canvas').dataset.finaleCoverage)>.66", timeout=7000)
            second_effect = effect(live)
            assert .66 <= second_effect['coverage'] <= .667, second_effect
            assert second_effect['baseline'] < first_effect['baseline'] - 300
            screenshot(live, 'final-song-02-petrichor.png')
            check('the cue automatically changes artwork and audio to Petrichor AT17 and grows the changing red pattern to two thirds', second_effect)
            live.wait_for_function("document.querySelector('#canvas').dataset.selectionAudio==='complete'", timeout=15000)
            no_preview(live)
            assert not live.locator('audio[data-scene-bgm],audio[data-scene-bgm-retiring]').count()
            live.reload()
            helper.idle(live, 'grand-final-announcement')
            no_preview(live)
            assert live.locator('[data-final-song]').get_attribute('data-final-song') == FINAL_IDS[1]
            assert not live.locator('audio').count()
            check('the second preview finishes without looping or menu music and a completed-source reload stays silent')

            # A named OBS source may preview its layout without owning audio.
            for path in ['/overlay/live.html?preview=1', '/overlay/live.html?audio=0', '/overlay/grand-final-announcement.html?fixed=1&preview=1']:
                page = new_page(base, path)
                helper.idle(page, 'grand-final-announcement')
                assert not page.evaluate('__finalProbe.media.length'), (path, audio(page))
                page.close()
            check('control previews and explicitly muted sources never create audio decoders')

            helper.command(crew, 'start-final-announcement', {'matchId': 'GF', 'songIndex': 0})
            playing(live, FINAL_IDS[0])
            for event, flag in [('obsSourceVisibleChanged', 'visible'), ('obsSourceActiveChanged', 'active')]:
                live.evaluate('data=>dispatchEvent(new CustomEvent(data.event,{detail:{[data.flag]:false}}))', {'event': event, 'flag': flag})
                no_preview(live)
                stopped = effect(live)
                live.wait_for_timeout(200)
                assert effect(live)['paths'] == stopped['paths'] and stopped['active'] == 'false'
                live.evaluate('data=>dispatchEvent(new CustomEvent(data.event,{detail:{[data.flag]:true}}))', {'event': event, 'flag': flag})
                playing(live, FINAL_IDS[0])
            live.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))")
            no_preview(live)
            stopped = effect(live)
            live.wait_for_timeout(200)
            assert effect(live)['paths'] == stopped['paths']
            live.evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))")
            playing(live, FINAL_IDS[0])
            check('OBS inactive/hidden and document visibility release preview media and stop red animation; reactivation resumes the shared cue')

            live.evaluate("window.__nativeDateNow=Date.now;Date.now=()=>__nativeDateNow()+3600000;__finalProbe.sockets[0].disconnect()")
            no_preview(live)
            assert live.locator('.final-announcement-hero').get_attribute('data-final-song') == FINAL_IDS[0]
            disconnected = effect(live)
            live.wait_for_timeout(200)
            assert effect(live)['paths'] == disconnected['paths'] and effect(live)['active'] == 'false'
            live.evaluate("__finalProbe.sockets[0].connect()")
            playing(live, FINAL_IDS[0])
            assert live.locator('.final-announcement-hero').get_attribute('data-final-song') == FINAL_IDS[0]
            live.evaluate("Date.now=__nativeDateNow;delete window.__nativeDateNow")
            check('a one-hour local clock skew cannot advance the reveal or red coverage during disconnect/reconnect')

            helper.command(crew, 'start-final-announcement', {'matchId': 'GF', 'songIndex': 1})
            playing(live, FINAL_IDS[1])
            assert next(m for m in helper.state(crew)['tournament']['matches'] if m['id'] == 'GF')['currentSong'] == 0
            helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'double-elimination-waiting', 'matchId': 'GF', 'songIndex': 0})
            helper.idle(live, 'double-elimination-waiting')
            no_preview(live)
            live.wait_for_function("document.querySelector('audio[data-scene-bgm]')?.dataset.trackId==='chapter-select'&&!document.querySelector('audio[data-scene-bgm]').paused")
            assert effect(live)['infected']
            screenshot(live, 'final-waiting-infected.png')
            stale = new_page(base, '/overlay/grand-final-announcement.html?fixed=1')
            helper.idle(stale, 'grand-final-announcement')
            assert not stale.evaluate('__finalProbe.media.length'), audio(stale)
            stale.close()
            check('manual replay/skip preserves the match song index, waiting retains red accents, BGM resumes after preview release, and an off-air fixed source stays muted')

            helper.command(crew, 'set-broadcast-display', {'showHandcams': True})
            helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'double-elimination-match', 'matchId': 'GF', 'songIndex': 0})
            helper.idle(live, 'double-elimination-match')
            no_preview(live)
            assert not live.locator('audio').count()
            image = screenshot(live, 'final-match-infected-transparent-cameras.png')
            holes = live.locator('[data-capture]').evaluate_all('''els=>els.map(el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})''')
            assert len(holes) == 4, holes
            samples = [[image.getpixel((int(b['x']+b['w']*f), int(b['y']+b['h']*.5)))[3] for f in [.15, .85]] for b in holes]
            assert all(a == 0 for row in samples for a in row), samples
            assert effect(live)['masked'] == 'url(#capture-mask)' and effect(live)['infected']
            live.wait_for_timeout(200)
            # From this document onward the backdrop and logo nodes remain persistent.
            live.evaluate("window.__persistentFinal={bg:document.querySelector('.broadcast-backdrop'),logos:[...document.querySelectorAll('[data-motion-branding] img')]}")
            helper.command(crew, 'set-scene', {'scene': 'double-elimination-waiting'})
            helper.idle(live, 'double-elimination-waiting')
            assert live.evaluate("__persistentFinal.bg===document.querySelector('.broadcast-backdrop')&&__persistentFinal.logos.every((e,i)=>e===document.querySelectorAll('[data-motion-branding] img')[i]&&e.complete&&Number(getComputedStyle(e).opacity)===1)")
            check('red infection remains clipped out of all four real camera holes, gameplay is silent and backdrop/logos persist across subsequent scenes', {'alpha': samples})

            live.emulate_media(reduced_motion='reduce')
            live.wait_for_function("matchMedia('(prefers-reduced-motion: reduce)').matches&&!document.querySelector('#canvas').classList.contains('finale-effects-running')")
            reduced = effect(live)
            live.wait_for_timeout(250)
            assert effect(live)['paths'] == reduced['paths'] and not reduced['running']
            live.emulate_media(reduced_motion='no-preference')
            live.wait_for_timeout(200)
            assert effect(live)['paths'] != reduced['paths']
            live.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}))")
            assert live.locator('g[data-finale-effects]').count() == 0
            assert live.locator('.selection-audio-prompt').count() == 0
            assert not live.locator('audio').count()
            check('reduced motion freezes the red texture and page disposal removes effect nodes, listeners and every media source')
            REPORT['audio'] = audio(live)
            assert not REPORT['browser_errors'], REPORT['browser_errors']
            REPORT['result'] = 'PASS'
        except Exception as error:
            REPORT['result'] = 'FAIL'
            REPORT['failure'] = str(error)
            if 'live' in locals() and not live.is_closed():
                screenshot(live, 'failure-overlay.png')
                REPORT['audio'] = audio(live)
                REPORT['effect'] = effect(live)
            raise
        finally:
            (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
            for context in contexts:
                context.close()
            if process:
                helper.stop_server(process)
            browser.close()
    print(json.dumps({'result': REPORT['result'], 'checks': len(REPORT['checks']), 'geometry': len(REPORT['geometry']), 'report': str(OUT / 'report.json')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
