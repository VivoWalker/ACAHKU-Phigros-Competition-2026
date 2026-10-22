"""Real-browser coverage for the round-based DE difficulty draw.

Uses official metadata with synthetic players and dummy PINs in temporary
tournaments. No live tournament data or credentials are read or changed.
Requires Python Playwright and Chromium. Outputs screenshots and a JSON report.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'difficulty-draw'))
REPORT = {'checks': [], 'geometry': [], 'browser_errors': [], 'screenshots': []}

spec = importlib.util.spec_from_file_location('production_console_browser', ROOT / 'test' / 'production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.OUT, P.REPORT = OUT, REPORT

# CJK fallback font Range rectangles can extend above/below their CSS line
# boxes even when adjacent blocks do not intersect. Library titles also sit
# directly in a container around their metadata, so its parent rectangle
# intentionally contains that metadata. Exclude that container relation;
# otherwise count collisions when both Range and element boxes intersect.
# Control rectangles are checked independently, including every form label.
GEOMETRY = P.GEOMETRY.replace(
    'if(x>2&&y>2&&textOverlaps.length<12)',
    '''if(x>2&&y>2&&textOverlaps.length<12&&(()=>{
      const aa=a.node.parentElement.getBoundingClientRect(),bb=b.node.parentElement.getBoundingClientRect();
      const library=a.node.parentElement.closest('.library-row');
      if(library&&library===b.node.parentElement.closest('.library-row')&&
        (a.node.parentElement.contains(b.node.parentElement)||b.node.parentElement.contains(a.node.parentElement)))return false;
      return Math.min(aa.right,bb.right)-Math.max(aa.left,bb.left)>1
        &&Math.min(aa.bottom,bb.bottom)-Math.max(aa.top,bb.top)>1;
    })())''')
GEOMETRY = GEOMETRY.replace(
    'const visible=element=>element.checkVisibility({opacityProperty:true,visibilityProperty:true})&&element.getClientRects().length;',
    '''const visible=element=>{
      if(!element.checkVisibility({opacityProperty:true,visibilityProperty:true})||!element.getClientRects().length)return false;
      const r=element.getBoundingClientRect();
      // Rows outside the scrollable song-library viewport are clipped, not
      // controls painted over the operations panel underneath that viewport.
      for(let parent=element.parentElement;parent;parent=parent.parentElement){
        const style=getComputedStyle(parent),clip=parent.getBoundingClientRect();
        if(/auto|scroll|hidden|clip/.test(style.overflowX)&&(r.right<=clip.left||r.left>=clip.right))return false;
        if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.bottom<=clip.top||r.top>=clip.bottom))return false;
      }
      return true;
    };''')

P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],fixture=process.argv[2],file=path.join(dir,'match-state.json');
if(!fs.existsSync(file)) {
  const state=require('./lib/default-state').createDefaultState();
  const T=require('./lib/tournament');
  const act=(type,payload={})=>T.applyAction(state,{type,payload:
    T.CURRENT_MATCH_ACTIONS.has(type)?{matchId:state.tournament.currentMatchId,...payload}:payload});
  // Preserve the organiser's exact chart constants. Media is intentionally
  // small and local, so this fixture tests the console rather than decoding.
  state.library.forEach((song,index)=>{song.art='assets/song/cover-'+(index%6+1)+'.svg';song.previewAudio=''});
  act('set-competition-roster',{names:Array.from({length:8},(_,index)=>'Gradient fixture '+(index+1))});
  act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026'});
  if(fixture==='r5') {
    for(const matchId of ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5']) {
      act('select-match',{matchId});act('draw-candidates');
      const match=state.tournament.matches.find(item=>item.id===matchId);
      act('ban-song',{playerIndex:0,songId:match.candidates[0].id});
      act('ban-song',{playerIndex:1,songId:match.candidates[1].id});act('pick-songs');
      for(let playerIndex=0;playerIndex<2;playerIndex++)for(let songIndex=0;songIndex<2;songIndex++)
        act('set-match-score',{playerIndex,songIndex,score:playerIndex?980000:990000,
          judgements:{accuracy:playerIndex?98:99,perfect:990,good:10,bad:0,miss:0}});
      act('record-result',{verified:true,note:'Temporary gradient fixture verified.'});
    }
    act('select-match',{matchId:'L6'});
  }
  act('set-broadcast-cue',{stage:'double-elimination',scene:'double-elimination-waiting',
    matchId:state.tournament.currentMatchId,songIndex:0});
  fs.writeFileSync(file,JSON.stringify(state));
}
const app=require('./server').createBroadcastServer({dataDir:dir,
  pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def current(page):
    state = P.state(page)
    return next(match for match in state['tournament']['matches'] if match['id'] == state['tournament']['currentMatchId'])


def saved_click(page, selector):
    revision = P.state(page)['revision']
    page.locator(selector).click()
    page.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)
    P.settled(page, P.state(page)['revision'])


def geometry(page, label):
    original = page.viewport_size
    page.wait_for_function("""()=>!document.querySelector('#content').getAnimations({subtree:true}).some(animation=>
      animation.effect?.getTiming().iterations!==Infinity&&(animation.playState==='running'||animation.pending))""")
    for width, height in [(1920, 1080), (1194, 834), (768, 1024), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(150)
        result = page.evaluate(GEOMETRY)
        result['name'] = f'{label}-{width}'
        REPORT['geometry'].append(result)
        screenshot = OUT / (result['name'] + '.png')
        page.screenshot(path=str(screenshot), full_page=True, animations='disabled')
        REPORT['screenshots'].append(str(screenshot))
        assert not result['duplicateIds'], (label, width, result['duplicateIds'])
        assert result['scroll'] <= width + 1, (label, width, 'Horizontal overflow', result['scroll'])
        assert not result['textOverlaps'], (label, width, 'Text overlaps', result['textOverlaps'])
        for index, a in enumerate(result['boxes']):
            box = a['box']
            assert box['w'] > 0 and box['h'] > 0, (label, width, a)
            assert box['x'] >= -1 and box['x'] + box['w'] <= width + 1, (label, width, 'Outside viewport', a)
            for other_index, b in enumerate(result['boxes'][:index]):
                if other_index in a['parents'] or index in b['parents']:
                    continue
                if a['tag'] not in ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'FORM'] or b['tag'] not in ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'FORM']:
                    continue
                other = b['box']
                x = min(box['x'] + box['w'], other['x'] + other['w']) - max(box['x'], other['x'])
                y = min(box['y'] + box['h'], other['y'] + other['h']) - max(box['y'], other['y'])
                assert x <= 1 or y <= 1, (label, width, 'Controls overlap', a, b)
    page.set_viewport_size(original)


def idle_overlay(page):
    page.wait_for_function("""()=>document.querySelector('#canvas')?.dataset.renderedScene==='song-selection'
      &&document.querySelector('#scene')?.dataset.motionPhase==='idle'
      &&!document.querySelector('#scene').getAnimations({subtree:true}).some(animation=>animation.playState==='running'||animation.pending)""")


def assert_summary(page):
    match = current(page)
    constants = [song['constant'] for song in match['candidates']]
    low = sum(value <= 16.5 for value in constants)
    mid = sum(16.5 < value < 16.9 for value in constants)
    high = sum(value >= 16.9 for value in constants)
    text = page.locator('[data-draw-difficulty-summary]').inner_text()
    assert f'低 {low}／中 {mid}／高 {high}' in text, (match['id'], text, constants)
    assert f'{sum(constants) / 6:.2f}' in text, (text, constants)
    return {'match': match['id'], 'round': match['round'], 'counts': [low, mid, high],
            'mean': sum(constants) / 6, 'songs': [{'title': song['title'], 'constant': song['constant'],
                'difficulty': song['difficulty'], 'level': song['level']} for song in match['candidates']]}


def draw_and_ban(page, overlay):
    P.next_step(page, 'selection')
    match = current(page)
    notice = page.locator('.round-difficulty-notice').inner_text()
    assert f'R{match["round"]}' in notice
    if page.locator('[data-command="draw-candidates"]').count():
        saved_click(page, '[data-command="draw-candidates"]')
    match = current(page)
    assert len(match['candidates']) == 6
    assert len({song['id'] for song in match['candidates']}) == 6
    summary = assert_summary(page)
    geometry(page, f'r{match["round"]}-production-selection')
    idle_overlay(overlay)
    assert overlay.locator('.candidate').count() == 6
    displayed = overlay.locator('.candidate-status').all_inner_texts()
    assert displayed == [f'{song["difficulty"]} {int(song["constant"])}' for song in match['candidates']], displayed
    assert all(float(song['level']).is_integer() for song in match['candidates'])
    for player in [0, 1]:
        saved_click(page, f'[data-ban-player="{player}"][data-ban-song="{match["candidates"][player]["id"]}"]')
    saved_click(page, '[data-command="pick-songs"]')
    picked = current(page)
    assert len(picked['songs']) == 2
    assert not {song['id'] for song in picked['songs']} & set(picked['bans'])
    idle_overlay(overlay)
    assert overlay.locator('.candidate.picked').count() == 2
    check(f'R{match["round"]} live console applies the announced gradient and retains bans, picks and integer broadcast levels', summary)
    return summary


def run_r1(browser, directory):
    process, base = P.start_server(str(directory), 'r1')
    context = None
    try:
        context, page = P.login(browser, base)
        geometry(page, 'r1-waiting')
        overlay = context.new_page()
        overlay.set_viewport_size({'width': 1920, 'height': 1080})
        overlay.goto(base + '/overlay/live.html')
        summary = draw_and_ban(page, overlay)
        assert summary['counts'][0] >= 3 and summary['counts'][2] <= 1
        page.locator('.tabs [data-tab="songs"]').click()
        page.wait_for_selector('[data-draw-difficulty-summary]')
        assert_summary(page)
        geometry(page, 'r1-song-selection-notice')
        check('the standalone song-selection tab reports the same actual candidate counts and average')

        page.locator('.tabs [data-tab="event"]').click()
        page.locator('[data-edit-song="competition-2026-de-01"]').click()
        assert page.input_value('#song-constant') == '16.1'
        page.fill('#song-constant', '16.2')
        P.command(page, 'set-event', {'venue': 'Temporary unrelated update keeps decimal draft'})
        assert page.input_value('#song-constant') == '16.2', 'Unrelated update discarded chart-constant draft'
        geometry(page, 'chart-constant-editor')
        saved_click(page, '#song-form button[type="submit"]')
        edited = next(song for song in P.state(page)['library'] if song['id'] == 'competition-2026-de-01')
        assert edited['constant'] == 16.2 and edited['level'] == 16
        check('decimal chart constants can be edited without changing the broadcast integer or losing an unsaved draft')

        context.close()
        context = None
        P.stop_server(process)
        process, base = P.start_server(str(directory), 'r1')
        context, page = P.login(browser, base)
        assert next(song for song in P.state(page)['library'] if song['id'] == 'competition-2026-de-01')['constant'] == 16.2
        check('a server restart preserves saved chart constants')

        # Use another ready match, so failed drawing does not rely on an already
        # committed selection. The deliberately incomplete custom chart must
        # fail closed rather than silently bypassing the official gradient.
        P.command(page, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'double-elimination-waiting', 'matchId': 'W2', 'songIndex': 0})
        page.locator('.tabs [data-tab="event"]').click()
        page.locator('[data-new-song]').click()
        page.fill('#song-title', 'Missing constant browser fixture')
        page.fill('#song-artist', 'Synthetic test artist')
        page.select_option('#song-difficulty', 'AT')
        page.fill('#song-level', '17')
        assert page.input_value('#song-constant') == ''
        saved_click(page, '#song-form button[type="submit"]')
        added = next(song for song in P.state(page)['library'] if song['title'] == 'Missing constant browser fixture')
        assert added.get('constant') is None
        page.locator('.tabs [data-tab="songs"]').click()
        previous = P.state(page)
        page.locator('[data-command="draw-candidates"]').click()
        page.wait_for_function("()=>document.querySelector('#toast').textContent.includes('Missing or invalid chart constant')")
        assert P.state(page)['revision'] == previous['revision']
        assert current(page)['candidates'] == []
        check('an eligible custom song without an original constant shows a clear error and leaves saved state unchanged')
    finally:
        if context:
            context.close()
        P.stop_server(process)


def run_r5(browser, directory):
    process, base = P.start_server(str(directory), 'r5')
    context = None
    try:
        context, page = P.login(browser, base)
        match = current(page)
        assert match['id'] == 'L6' and match['round'] == 5
        assert sum(item['status'] == 'complete' for item in P.state(page)['tournament']['matches']) == 12
        overlay = context.new_page()
        overlay.set_viewport_size({'width': 1920, 'height': 1080})
        overlay.goto(base + '/overlay/live.html')
        summary = draw_and_ban(page, overlay)
        assert summary['counts'] == [0, 0, 6]
        assert all(song['constant'] >= 16.9 for song in summary['songs'])
        previous_ids = {song['id'] for item in P.state(page)['tournament']['matches'] if item['id'] != 'L6' for song in item['songs']}
        assert not previous_ids & {song['id'] for song in current(page)['songs']}
        page.locator('.tabs [data-tab="songs"]').click()
        assert_summary(page)
        geometry(page, 'r5-song-selection-notice')
        check('R5 still offers six high charts after twelve completed matches and does not repeat official match songs')
    finally:
        if context:
            context.close()
        P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='acahku-difficulty-browser-') as temporary:
            with sync_playwright() as playwright:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
                browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
                try:
                    for name, exercise in [('r1', run_r1), ('r5', run_r5)]:
                        directory = Path(temporary) / name
                        directory.mkdir()
                        exercise(browser, directory)
                    assert not REPORT['browser_errors'], REPORT['browser_errors']
                    check('responsive gradient notices and chart-constant fields have no duplicate IDs, overlaps, overflow or browser errors', len(REPORT['geometry']))
                    REPORT['result'] = 'passed'
                finally:
                    browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
