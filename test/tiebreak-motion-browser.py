"""Trace real tiebreak transitions, including outgoing text and VS fades."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/tiebreak-motion'))
REPORT = {'checks': [], 'transitions': [], 'failures': [], 'browser_errors': []}
spec = importlib.util.spec_from_file_location('production_helpers', ROOT / 'test/production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.REPORT = REPORT
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const {state}=require('./scripts/manual-save-loader').loadManualSave(process.argv[2]);
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""
PROBE = r"""(() => {
  const selectors={title:'.waiting-song h2',chart:'.waiting-chart',versus:'.tiebreak-versus'};
  const sample=node=>{
    const box=node.getBoundingClientRect(),parent=node.parentElement.getBoundingClientRect(),css=getComputedStyle(node);
    const scale=document.querySelector('#canvas').getBoundingClientRect().width/1920;
    return {top:box.top/scale,left:box.left/scale,width:box.width/scale,height:box.height/scale,
      offsetY:(box.top-parent.top)/scale,offsetX:(box.left-parent.left)/scale,opacity:Number(css.opacity),
      animations:node.getAnimations().map(animation=>({time:animation.currentTime,
        frames:animation.effect.getKeyframes().map(frame=>({opacity:frame.opacity,transform:frame.transform}))}))};
  };
  window.__startTieTrace=()=>{
    const trace={source:{},frames:[]};
    for(const [key,selector] of Object.entries(selectors)){
      const node=document.querySelector('#scene '+selector);if(node)trace.source[key]=sample(node);
    }
    window.__tieTrace=trace;
    function frame(){
      const current={scene:document.querySelector('#canvas').dataset.renderedScene,phase:document.querySelector('#scene').dataset.motionPhase,exit:{},live:{}};
      for(const [key,selector] of Object.entries(selectors))for(const node of document.querySelectorAll('#scene '+selector)){
        current[node.closest('[data-motion-exits]')?'exit':'live'][key]=sample(node);
      }
      trace.frames.push(current);trace.raf=requestAnimationFrame(frame);
    }
    frame();
  };
  window.__stopTieTrace=()=>{cancelAnimationFrame(window.__tieTrace.raf);delete window.__tieTrace.raf;return window.__tieTrace;};
})();"""


def idle(page, scene):
    page.wait_for_function('''scene=>document.querySelector('#canvas')?.dataset.renderedScene===scene
      &&document.querySelector('#scene')?.dataset.motionPhase==='idle' ''', arg=scene)


def check(condition, description):
    REPORT['checks' if condition else 'failures'].append(description)
    print(('PASS ' if condition else 'FAIL ') + description, flush=True)


def transition(main, live, scene, label, reduced=False):
    live.evaluate('window.__startTieTrace()')
    P.click_saved(main, '[data-production-next]')
    idle(live, scene)
    trace = live.evaluate('window.__stopTieTrace()')
    trace['label'] = label
    REPORT['transitions'].append(trace)
    for key in ['title', 'chart']:
        if key not in trace['source']:
            continue
        samples = [frame['exit'][key] for frame in trace['frames'] if key in frame['exit']]
        if reduced:
            check(not samples, label + ': reduced motion has no outgoing ' + key)
            continue
        check(bool(samples), label + ': captured outgoing ' + key)
        if samples:
            original = trace['source'][key]
            drift = max(abs(sample['offsetY'] - original['offsetY']) for sample in samples)
            check(drift < .5, f'{label}: outgoing {key} keeps its vertical position (drift {drift:.2f}px)')
            check(max(abs(sample['height'] - original['height']) for sample in samples) < .5,
                  label + ': outgoing ' + key + ' keeps its height')
    versus_side = 'exit' if 'versus' in trace['source'] else 'live' if scene.endswith('announcement') else None
    if versus_side and not reduced:
        samples = [frame[versus_side]['versus'] for frame in trace['frames'] if 'versus' in frame[versus_side]]
        direction = 'fade-out' if versus_side == 'exit' else 'fade-in'
        animated = [sample for sample in samples if sample['animations']]
        check(bool(animated), label + ': VS has a ' + direction + ' animation')
        check(any(.05 < sample['opacity'] < .95 for sample in samples), label + ': VS visibly interpolates opacity')
        if animated:
            endpoints = animated[0]['animations'][0]['frames']
            check([float(frame['opacity']) for frame in endpoints] == ([1, 0] if versus_side == 'exit' else [0, 1]),
                  label + ': VS fades in the correct direction')
    if reduced:
        check(not live.evaluate('document.querySelector("#scene").getAnimations({subtree:true}).length'),
              label + ': reduced motion settles without animations')
    check(live.locator('[data-motion-exits]').count() == 0, label + ': outgoing layers are cleaned up')


def run(browser, fixture, size, reduced=False):
    with tempfile.TemporaryDirectory(prefix='tiebreak-motion-') as directory:
        process, base = P.start_server(directory, fixture)
        context = None
        try:
            context, main = P.login(browser, base)
            live = context.new_page()
            live.set_viewport_size({'width': size[0], 'height': size[1]})
            if reduced:
                live.emulate_media(reduced_motion='reduce')
            live.add_init_script(PROBE)
            live.goto(base + '/overlay/live.html?bgm=0')
            prefix = 'double-elimination' if fixture == 'D14' else 'qualifier'
            idle(live, prefix + '-waiting')
            label = f'{fixture} {size[0]}x{size[1]}' + (' reduced' if reduced else '')
            sealed_title = live.locator('.waiting-song h2').inner_text()
            check('待公布' in sealed_title, label + ': song remains sealed before reveal')
            initial_title_top = live.locator('.waiting-song h2').bounding_box()['y']
            transition(main, live, prefix + '-tiebreak-announcement', label + ' sealed → reveal', reduced)
            check(live.locator('.tiebreak-versus').inner_text() == 'VS', label + ': reveal includes VS')
            song = live.locator('.selection-focus-card h2').inner_text()
            transition(main, live, prefix + '-waiting', label + ' reveal → named waiting', reduced)
            check(live.locator('.waiting-song h2').inner_text() == song, label + ': named waiting keeps revealed song')
            check(live.locator('.waiting-chart').count() == 1, label + ': named waiting includes difficulty')
            live.screenshot(path=str(OUT / f'{fixture}-{size[0]}-named-waiting.png'))
            transition(main, live, prefix + '-match', label + ' named waiting → match', reduced)
            check(live.locator('[data-capture="gameplay"]').count() == 2, label + ': match has two gameplay apertures')
            REPORT.setdefault('settled_geometry', []).append({'label': label, 'sealed_title_top': initial_title_top})
            if fixture == 'D14' and not reduced:
                cue = {'stage': prefix, 'matchId': P.state(main)['tournament']['currentMatchId'], 'songIndex': 0}
                P.command(main, 'set-broadcast-cue', {**cue, 'scene': prefix + '-waiting'})
                idle(live, prefix + '-waiting')
                P.command(main, 'set-broadcast-cue', {**cue, 'scene': prefix + '-tiebreak-announcement'})
                live.wait_for_function('document.querySelector("#scene").dataset.motionPhase !== "idle"')
                P.command(main, 'set-broadcast-cue', {**cue, 'scene': prefix + '-waiting'})
                P.command(main, 'set-broadcast-cue', {**cue, 'scene': prefix + '-match'})
                idle(live, prefix + '-match')
                check(live.locator('.tiebreak-versus,[data-motion-exits]').count() == 0,
                      label + ': rapid switches discard stale VS and outgoing layers')
                check(live.locator('[data-capture="gameplay"]').count() == 2,
                      label + ': rapid switches finish on the requested match')
        finally:
            if context:
                context.close()
            P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as pw:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}),
                                         args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            try:
                for fixture, size, reduced in [('Q07', (1920, 1080), False), ('Q10', (960, 540), False),
                                                ('D14', (1280, 720), False), ('D14', (1280, 720), True)]:
                    run(browser, fixture, size, reduced)
                assert not REPORT['browser_errors'], REPORT['browser_errors']
                assert not REPORT['failures'], REPORT['failures']
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
