"""Frame-level selection transitions, redraw stability and full-card BAN styling.

Temporary tournaments, bundled SVG covers and fixture pairing codes only.
Set SELECTION_MOTION_VIDEO=1 to retain a 720p recording beside the report.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/selection-motion'))
REPORT = {'checks': [], 'traces': {}, 'screenshots': [], 'browser_errors': []}
spec = importlib.util.spec_from_file_location('de_flow', ROOT / 'test/double-elimination-flow-browser.py')
D = importlib.util.module_from_spec(spec)
spec.loader.exec_module(D)
P = D.P
P.OUT, P.REPORT = OUT, REPORT
# A deterministic six-song inventory keeps redraws reproducible and uses the
# four valid bundled jackets without loading the live event directory.
P.SERVER = P.SERVER.replace("act('seed-bracket'", "delete state.event.competitionVersion;\n"
    "for(const song of state.library)song.eligible=/^competition-2026-de-0[1-6]$/.test(song.id);\n"
    "act('seed-bracket'", 1).replace("act('draw-candidates');", '')

PROBE = r"""() => {
  const layer=document.querySelector('.selection-ambience');
  const trace={frames:[],active:true};
  const opacity=node=>node?Number(getComputedStyle(node).opacity):1;
  function frame(){
    if(!trace.active)return;
    const content=document.querySelector('[data-motion-content]'),list=content?.querySelector('.candidate-list');
    const cards=[...content?.querySelectorAll('.candidate')||[]];
    const rect=list?.getBoundingClientRect();
    trace.frames.push({at:performance.now(),scene:document.querySelector('#canvas')?.dataset.renderedScene,
      background:opacity(layer),sameLayer:layer===document.querySelector('.selection-ambience'),
      images:[...layer.querySelectorAll('img')].map(img=>({src:img.getAttribute('src'),opacity:opacity(img),ready:img.complete&&img.naturalWidth>0})),
      list:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height,opacity:opacity(list)}:null,
      cards:cards.map(card=>opacity(card)*opacity(list)),
      cardAnimations:list?.getAnimations({subtree:true}).filter(a=>a.pending||a.playState==='running').length||0,
      exitBans:[...document.querySelectorAll('[data-motion-exits] .candidate.banned')].map(card=>getComputedStyle(card,'::before').backgroundColor)
    });
    trace.raf=requestAnimationFrame(frame);
  }
  trace.stop=()=>{trace.active=false;cancelAnimationFrame(trace.raf);return trace.frames;};
  window.__selectionMotionTrace=trace;trace.raf=requestAnimationFrame(frame);
}"""


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def match_command(page, action, payload=None):
    return P.command(page, action, {'matchId': D.current(page)['id'], **(payload or {})})


def stop_probe(page, name):
    frames = page.evaluate('()=>window.__selectionMotionTrace.stop()')
    REPORT['traces'][name] = frames
    assert frames and all(frame['sameLayer'] for frame in frames), (name, 'background replaced')
    assert max(len(frame['images']) for frame in frames) <= 2, (name, 'unbounded image layers')
    assert all(any(image['ready'] for image in frame['images']) for frame in frames if frame['background'] > .08), (name, 'empty visible background')
    return frames


def background(page, visible):
    page.wait_for_function('''visible=>{
      const layer=document.querySelector('.selection-ambience');
      const opacity=Number(getComputedStyle(layer).opacity);
      return visible?opacity>.999&&layer.querySelector('.selection-ambience-art')?.dataset.coverMotionPhase==='idle'
        &&!document.querySelector('.selection-art[data-cover-motion-phase]:not([data-cover-motion-phase="idle"])'):opacity<.001;
    }''', arg=visible)


def smooth(frames):
    values = [frame['background'] for frame in frames]
    assert sum(.02 < value < .98 for value in values) >= 3, values
    assert max(abs(a - b) for a, b in zip(values, values[1:])) < .65, values


def stable(frames):
    visible = [frame for frame in frames if frame['cards']]
    assert visible, 'No candidate frames recorded'
    assert all(all(value > .99 for value in frame['cards']) for frame in visible), 'Redraw replayed a card reveal'
    assert all(frame['cardAnimations'] == 0 for frame in visible), 'Redraw animated the list again'
    heights = [frame['list']['height'] for frame in frames if frame['list']]
    assert max(heights) - min(heights) < 1, heights


def red(value):
    import re
    channels = list(map(float, re.findall(r'[\d.]+', value)))
    return channels[0] > channels[1] * 2 and channels[0] > channels[2] * 1.5 and (len(channels) < 4 or channels[3] == 1)


def ban_colours(main, live, song_id):
    for row in [main.locator(f'.candidate-row[data-focus-song="{song_id}"]'),
                live.locator(f'[data-motion-content] [data-motion-key="candidate-{song_id}"]')]:
        colours = row.evaluate('''row=>({body:getComputedStyle(row,'::before').backgroundColor,
          tile:getComputedStyle(row.querySelector('.song-difficulty'),'::before').backgroundColor,
          ink:getComputedStyle(row.querySelector('.song-difficulty b')).color})''')
        assert red(colours['body']) and red(colours['tile']), colours
        assert colours['ink'] == 'rgb(255, 255, 255)', colours


def screenshot(page, name):
    file = OUT / (name + '.png')
    page.screenshot(path=str(file), animations='disabled')
    REPORT['screenshots'].append(str(file))


def capture_alpha(main, live):
    P.command(main, 'set-scene', {'scene': 'double-elimination-match'})
    live.wait_for_function('''()=>{
      const rects=[...document.querySelectorAll('.broadcast-backdrop [data-aperture-key]')];
      return document.querySelector('#canvas')?.dataset.renderedScene==='double-elimination-match'
        &&rects.length&&rects.every(rect=>rect.getAnimations().length);
    }''')
    points = live.evaluate('''()=>{
      const canvas=document.querySelector('#canvas').getBoundingClientRect(),scale=canvas.width/1920;
      const rects=[...document.querySelectorAll('.broadcast-backdrop [data-aperture-key]')];
      // The outgoing cards must not paint over the pixels being compared.
      for(const animation of document.querySelector('#canvas').getAnimations({subtree:true}))
        if(!rects.includes(animation.effect.target))animation.finish();
      return rects.map(rect=>{
        for(const animation of rect.getAnimations()){
          animation.pause();animation.currentTime=animation.effect.getTiming().duration*.5;
        }
        const [x,y,w,h]=JSON.parse(rect.dataset.apertureRect);
        return [Math.round(canvas.x+(x+w*.75)*scale),Math.round(canvas.y+(y+h*.5)*scale)];
      });
    }''')
    # Force the menu visible to exercise an interrupted fade while captures
    # open. Both images must have the same alpha, including partial reveals.
    style = live.add_style_tag(content='.selection-ambience{opacity:1!important;transition:none!important}')
    shown = Image.open(io.BytesIO(live.screenshot(omit_background=True))).convert('RGBA')
    style.evaluate("node=>node.textContent='.selection-ambience{opacity:0!important;transition:none!important}'")
    hidden = Image.open(io.BytesIO(live.screenshot(omit_background=True))).convert('RGBA')
    for point in points:
        on, off = shown.getpixel(tuple(point))[3], hidden.getpixel(tuple(point))[3]
        REPORT.setdefault('capture_alpha', []).append({'point': point, 'shown': on, 'hidden': off})
        assert 5 < off < 250 and abs(on - off) <= 1, (point, on, off)
    style.evaluate('node=>node.remove()')
    live.evaluate("()=>document.querySelector('#canvas').getAnimations({subtree:true}).forEach(animation=>animation.finish())")
    D.idle(live, 'double-elimination-match')
    background(live, False)


def run(browser, directory):
    process, base = P.start_server(directory, 'regular')
    main_context = live_context = video = None
    try:
        main_context, main = P.login(browser, base)
        P.command(main, 'set-scene', {'scene': 'start'})
        options = {'viewport': {'width': 1920, 'height': 1080}, 'reduced_motion': 'no-preference'}
        if os.environ.get('SELECTION_MOTION_VIDEO') == '1':
            options.update(record_video_dir=str(OUT / 'recording'), record_video_size={'width': 1280, 'height': 720})
        live_context = browser.new_context(**options)
        live_context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
        live = live_context.new_page()
        video = live.video
        live.goto(base + '/overlay/live.html?preview=1&bgm=0')
        D.idle(live, 'start')
        background(live, False)
        live.evaluate(PROBE)
        P.command(main, 'set-scene', {'scene': 'song-selection'})
        D.idle(live, 'song-selection')
        background(live, True)
        smooth(stop_probe(live, 'enter-selection'))
        check('scene entry fades a persistent decoded background instead of replacing it in one frame')

        live.evaluate('window.__selectionCatalog=document.querySelector("[data-motion-key=selection-catalog]")')
        live.evaluate(PROBE)
        for _ in range(3):
            match_command(main, 'draw-candidates')
            live.wait_for_timeout(70)
        D.idle(live, 'song-selection')
        background(live, True)
        stable(stop_probe(live, 'rapid-redraw'))
        assert live.evaluate('window.__selectionCatalog===document.querySelector("[data-motion-key=selection-catalog]")')
        check('first draw and rapid redraws keep every card visible and the catalogue/footer positions fixed')

        match = D.current(main)
        first = match['candidates'][0]
        second = next(song for song in match['candidates'][1:] if song['art'] != first['art'])
        match_command(main, 'ban-song', {'playerIndex': 0, 'songId': first['id']})
        ban_colours(main, live, first['id'])
        match_command(main, 'ban-song', {'playerIndex': 1, 'songId': second['id']})
        live.wait_for_function('''title=>document.querySelector('.selection-focus-card h2')?.textContent===title''', arg=second['title'])
        live.evaluate(PROBE)
        for index in range(3):
            P.command(main, 'set-event', {'venue': 'Unrelated update ' + str(index)})
            live.wait_for_timeout(70)
        background(live, True)
        frames = stop_probe(live, 'jacket-blend')
        stable(frames)
        assert all(frame['background'] > .999 for frame in frames)
        assert live.locator('.selection-ambience-art>img:not([data-motion-cover-old])').get_attribute('src') == live.locator('.selection-art>img:not([data-motion-cover-old])').get_attribute('src')
        ban_colours(main, live, first['id'])
        ban_colours(main, live, second['id'])
        screenshot(live, 'selection-full-red-bans')
        main.click('.tabs [data-tab="songs"]')
        main.set_viewport_size({'width': 1440, 'height': 1000})
        main.locator('.song-grid').screenshot(path=str(OUT / 'control-full-red-bans.png'), animations='disabled')
        check('jacket blends survive state updates; focused/unfocused BAN rows and their difficulty tiles are fully red in OBS and control')

        live.evaluate(PROBE)
        P.command(main, 'set-scene', {'scene': 'start'})
        P.command(main, 'set-event', {'venue': 'State update during selection exit'})
        D.idle(live, 'start')
        background(live, False)
        frames = stop_probe(live, 'leave-selection')
        smooth(frames)
        ghost_colours = [colour for frame in frames for colour in frame['exitBans']]
        assert ghost_colours and all(red(colour) for colour in ghost_colours), ghost_colours
        check('scene exit keeps BAN snapshots red and state updates cannot reopen the outgoing background')

        for scene in ['song-selection', 'start', 'song-selection']:
            P.command(main, 'set-scene', {'scene': scene})
            live.wait_for_timeout(70)
        D.idle(live, 'song-selection')
        background(live, True)
        live.set_viewport_size({'width': 1280, 'height': 720})
        live.evaluate(PROBE)
        match_command(main, 'draw-candidates')
        revision = P.state(main)['revision']
        live.wait_for_function('revision=>Number(document.querySelector("#canvas")?.dataset.renderedRevision)>=revision', arg=revision)
        D.idle(live, 'song-selection')
        background(live, True)
        live.wait_for_function('()=>window.__selectionMotionTrace.frames.length>=3')
        stable(stop_probe(live, 'scaled-redraw'))
        capture_alpha(main, live)
        check('even an interrupted menu fade preserves the exact alpha of partially revealed OBS captures')
        live.emulate_media(reduced_motion='reduce')
        for scene in ['start', 'song-selection']:
            P.command(main, 'set-scene', {'scene': scene})
            D.idle(live, scene)
            background(live, scene == 'song-selection')
        assert live.evaluate('''()=>!document.querySelector('#canvas').getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending)''')
        assert D.current(main)['currentSong'] == 0
        check('rapid scene reversals, scaled redraw and reduced motion settle on the newest scene without advancing scores')
        assert not REPORT['browser_errors'], REPORT['browser_errors']
    finally:
        if live_context:
            live_context.close()
        if video:
            video.save_as(str(OUT / 'selection-transitions.webm'))
        if main_context:
            main_context.close()
        P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='selection-motion-') as directory, sync_playwright() as playwright:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            try:
                run(browser, directory)
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
