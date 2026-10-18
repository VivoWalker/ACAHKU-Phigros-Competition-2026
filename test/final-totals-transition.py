"""Frame-by-frame regression for Grand Final song 2 results -> two-song totals.

Uses the existing temporary tournament fixture and dummy pairing code. No real
event data or sessions are read. Requires Python Playwright, Pillow and Chromium.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/final-totals-transition'))
spec = importlib.util.spec_from_file_location('final_sequence', ROOT / 'test/final-sequence-browser.py')
sequence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sequence)
helper = sequence.helper
REPORT = {'checks': [], 'browser_errors': [], 'transitions': []}

PROBE = r"""({outgoingSelector='.song-result-card',incomingSelector='.finale-total-card'}={}) => {
  const mount=document.querySelector('#scene'),canvas=document.querySelector('#canvas');
  const frames=[],records=[],seen=new WeakSet();let active=true;
  const opacity=node=>{let value=1;for(let e=node;e&&e!==mount;e=e.parentElement){
    const css=getComputedStyle(e);if(css.visibility==='hidden'||css.display==='none')return 0;
    value*=Number(css.opacity);}return value;};
  const box=node=>{const b=node.getBoundingClientRect();
    return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
  const logoNodes=[...mount.querySelectorAll('[data-motion-branding] img')];
  function tick(){
    if(!active)return;
    for(const animation of mount.getAnimations({subtree:true}))if(!seen.has(animation)){
      seen.add(animation);if(animation.animationName)continue;const node=animation.effect.target;
      if(node.dataset.motionEntry||node.dataset.motionExit)records.push({
        className:node.className,entry:!!node.dataset.motionEntry,exit:!!node.dataset.motionExit,
        order:Number(node.dataset.motionOrder),start:animation.startTime,
        duration:animation.effect.getTiming().duration,easing:animation.effect.getTiming().easing,
        rect:JSON.parse(node.dataset.motionEntryRect||node.dataset.motionExitRect),
        keyframes:animation.effect.getKeyframes().map(k=>({opacity:k.opacity,transform:k.transform}))});
    }
    const outgoing=[...mount.querySelectorAll('[data-motion-exits]')].flatMap(layer=>[...layer.querySelectorAll(outgoingSelector)])
      .map(node=>({opacity:opacity(node),box:box(node)}));
    const incoming=[...mount.querySelectorAll(incomingSelector)]
      .filter(node=>!node.closest('[data-motion-exits]'))
      .map(node=>({opacity:opacity(node),box:box(node),entry:!!node.dataset.motionEntry}));
    const overlaps=[];
    for(const a of outgoing)for(const b of incoming){
      const width=Math.min(a.box.right,b.box.right)-Math.max(a.box.left,b.box.left),
        height=Math.min(a.box.bottom,b.box.bottom)-Math.max(a.box.top,b.box.top);
      if(a.opacity>.025&&b.opacity>.025&&width>1&&height>1)overlaps.push({width,height,
        outgoingOpacity:a.opacity,incomingOpacity:b.opacity});
    }
    frames.push({time:performance.now(),phase:mount.dataset.motionPhase,
      scene:canvas.dataset.renderedScene,outgoing,incoming,overlaps,
      logos:logoNodes.map(node=>({connected:node.isConnected,opacity:opacity(node)}))});
    requestAnimationFrame(tick);
  }
  window.__totalsTransition={stop(){active=false;return {frames,records};}};
  requestAnimationFrame(tick);
}"""


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def capture(page):
    foreground = Image.open(io.BytesIO(page.screenshot(omit_background=True))).convert('RGBA')
    result = Image.new('RGBA', foreground.size, (0, 0, 0, 255))
    result.alpha_composite(foreground)
    return result.convert('RGB')


def trace_transition(live, crew, label, capture_gif=False, score_update=False):
    live.evaluate(PROBE, {})
    sequence.control_click(crew, '[data-production-next]')
    if score_update:
        live.wait_for_function("()=>document.querySelector('#canvas').dataset.renderedScene==='grand-final-totals'")
        helper.command(crew, 'set-match-score', {'matchId': 'GF', 'playerIndex': 0, 'songIndex': 1,
            'score': 989001, 'judgements': {'accuracy': 99, 'perfect': 980, 'good': 15, 'bad': 3, 'miss': 2}})
    frames = []
    if capture_gif:
        started = time.monotonic()
        for index in range(24):
            delay = started + index * .075 - time.monotonic()
            if delay > 0:
                live.wait_for_timeout(delay * 1000)
            frames.append(capture(live).resize((960, 540)).quantize(colors=128, method=Image.Quantize.FASTOCTREE))
    helper.idle(live, 'grand-final-totals')
    result = live.evaluate('()=>window.__totalsTransition.stop()')
    result['label'] = label
    result['viewport'] = live.viewport_size
    REPORT['transitions'].append(result)
    if frames:
        target = OUT / 'song-two-to-two-song-totals.gif'
        frames[0].save(target, save_all=True, append_images=frames[1:], duration=75, loop=0)
        REPORT['animation'] = str(target)
    live.screenshot(path=str(OUT / (label + '.png')), omit_background=True)
    return result


def trace_departure(live, crew, target):
    selector = '.song-result-card' if target == 'song-result' else '.waiting-song,.waiting-copy h1,.waiting-players>p'
    live.evaluate(PROBE, {'outgoingSelector': '.finale-total-card', 'incomingSelector': selector})
    if target == 'song-result':
        helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': target, 'matchId': 'GF', 'songIndex': 1})
    else:
        sequence.control_click(crew, '[data-production-next]')
    helper.idle(live, target)
    result = live.evaluate('()=>window.__totalsTransition.stop()')
    result['label'] = 'totals-to-' + target
    REPORT['transitions'].append(result)
    assert not any(frame['overlaps'] for frame in result['frames']), result
    exits = [record for record in result['records'] if record['exit'] and 'finale-total-card' in record['className'].split()]
    assert len(exits) == 2, result
    assert all(float(record['keyframes'][-1]['opacity']) == 0 for record in exits), result
    entries = [record for record in result['records'] if record['entry']]
    assert entries and min(record['start'] for record in entries) >= max(record['start'] + record['duration'] for record in exits) - 1, result
    check('both subtotal cards exit before entering ' + target)
    return result


def verify(result, reduced=False):
    assert result['frames'], result
    overlaps = [frame for frame in result['frames'] if frame['overlaps']]
    assert not overlaps, (result['label'], 'outgoing song result overlaps incoming totals', overlaps[:3])
    for frame in result['frames']:
        assert all(logo['connected'] and logo['opacity'] > .999 for logo in frame['logos']), frame
    if reduced:
        assert not result['records'], result
        assert result['frames'][-1]['phase'] == 'idle', result
        return
    entries = [record for record in result['records'] if record['entry']]
    exits = [record for record in result['records'] if record['exit']]
    cards = [record for record in entries if 'finale-total-card' in record['className'].split()]
    card_slots = {(round(record['rect']['left']), round(record['rect']['top'])) for record in cards}
    assert len(card_slots) == 2, (result['label'], 'both total cards must join the entry animation', result['records'])
    result_slots = {(round(record['rect']['left']), round(record['rect']['top'])) for record in exits
                    if 'song-result-card' in record['className'].split()}
    assert len(result_slots) == 2, result
    assert min(record['start'] for record in entries) >= max(record['start'] + record['duration'] for record in exits) - 1, result
    for records in [entries, exits]:
        ordered = sorted(records, key=lambda record: record['order'])
        assert all(a['rect']['left'] <= b['rect']['left'] + .5 for a, b in zip(ordered, ordered[1:])), ordered
        assert all(a['start'] <= b['start'] for a, b in zip(ordered, ordered[1:])), ordered
    for record in cards:
        assert float(record['keyframes'][0]['opacity']) == 0 and float(record['keyframes'][-1]['opacity']) == 1, record
        assert record['easing'].startswith('cubic-bezier'), record
    assert any(frame['outgoing'] and frame['incoming'] and
               all(item['opacity'] <= .025 for item in frame['incoming']) for frame in result['frames']), result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix='acahku-totals-transition-') as directory, sync_playwright() as pw:
            process, base = sequence.start_server(directory)
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
                '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'])
            contexts = []
            try:
                crew_context = browser.new_context(viewport={'width': 1194, 'height': 834})
                contexts.append(crew_context)
                crew = helper.login(crew_context, base)
                for width, height in [(1920, 1080), (1194, 834)]:
                    context = browser.new_context(viewport={'width': width, 'height': height})
                    contexts.append(context)
                    motion_source = os.environ.get('BROADCAST_TEST_MOTION_SOURCE')
                    if motion_source:
                        context.route('**/js/motion.js*', lambda route: route.fulfill(path=motion_source, content_type='application/javascript'))
                    live = context.new_page()
                    live.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error)))
                    live.goto(base + '/overlay/live.html')
                    live.bring_to_front()
                    context.new_cdp_session(live).send('Emulation.setFocusEmulationEnabled', {'enabled': True})
                    helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'song-result', 'matchId': 'GF', 'songIndex': 1})
                    helper.idle(live, 'song-result')
                    result = trace_transition(live, crew, 'totals-' + str(width))
                    if os.environ.get('BROADCAST_TEST_EXPECT_OVERLAP') == '1':
                        assert any(frame['overlaps'] for frame in result['frames']), result
                        check('baseline reproduces visible song-result/totals overlap at ' + str(width))
                        continue
                    verify(result)
                    sequence.subtotal_geometry(live, 'totals-' + str(width))
                    check('song-two results exit before both total cards enter at ' + str(width))
                    live.close()
                if os.environ.get('BROADCAST_TEST_EXPECT_OVERLAP') != '1':
                    # Interrupt an in-progress scene change, return to song 2,
                    # and issue the real totals command again. Retired ghosts
                    # must disappear and both totals cards must settle cleanly.
                    live = contexts[1].new_page()
                    live.goto(base + '/overlay/live.html')
                    helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'song-result', 'matchId': 'GF', 'songIndex': 1})
                    helper.idle(live, 'song-result')
                    helper.command(crew, 'show-final-two-totals', {'matchId': 'GF'})
                    live.wait_for_function("()=>document.querySelector('#canvas').dataset.renderedScene==='grand-final-totals'")
                    helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'song-result', 'matchId': 'GF', 'songIndex': 1})
                    helper.idle(live, 'song-result')
                    verify(trace_transition(live, crew, 'rapid-return'))
                    assert live.locator('[data-motion-exits],[data-motion-entry]').count() == 0
                    check('interrupted return and repeated totals command leave no stale transition layers')
                    trace_departure(live, crew, 'song-result')
                    # Score updates arrive on the same websocket while the
                    # old scene is still exiting; new totals must remain hidden
                    # and continue their entry rather than flashing into view.
                    updated = trace_transition(live, crew, 'live-score-update', score_update=True)
                    verify(updated)
                    assert '1,979,001' in live.locator('[data-finale-subtotal]').first.inner_text()
                    check('score update during subtotal entry keeps both cards on the transition timetable')
                    trace_departure(live, crew, 'double-elimination-waiting')
                    helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'song-result', 'matchId': 'GF', 'songIndex': 1})
                    helper.idle(live, 'song-result')
                    live.set_viewport_size({'width': 640, 'height': 360})
                    verify(trace_transition(live, crew, 'preview-totals', capture_gif=True))
                    live.set_viewport_size({'width': 1920, 'height': 1080})
                    helper.idle(live, 'grand-final-totals')
                    live.screenshot(path=str(OUT / 'totals-fixed.png'), omit_background=True)
                    live.emulate_media(reduced_motion='reduce')
                    helper.command(crew, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'song-result', 'matchId': 'GF', 'songIndex': 1})
                    helper.idle(live, 'song-result')
                    verify(trace_transition(live, crew, 'reduced-motion'), reduced=True)
                    check('reduced-motion switches atomically without overlapping old and new content')
                assert not REPORT['browser_errors'], REPORT['browser_errors']
                check('no browser runtime errors')
            finally:
                for context in contexts:
                    context.close()
                browser.close()
    finally:
        if process:
            helper.stop_server(process)
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
