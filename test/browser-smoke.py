"""Optional real-browser validation. Requires Python Playwright and Chromium.
Runs against a temporary tournament; never changes the production data directory.
"""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
SCENES = ['start', 'qualifier-waiting', 'double-elimination-waiting', 'qualifier-match', 'double-elimination-match', 'result', 'bracket', 'song-selection']

with tempfile.TemporaryDirectory(prefix='acahku-browser-') as data_dir:
    code = """
const {createBroadcastServer}=require('./server');
const s=createBroadcastServer({dataDir:process.argv[1],pin:'browser-fixture-code'});
s.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
"""
    process = subprocess.Popen(['node', '-e', code, data_dir], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        port = int(process.stdout.readline().strip())
        base = f'http://127.0.0.1:{port}'
        with sync_playwright() as p:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            context = browser.new_context(viewport={'width':1194, 'height':834}, has_touch=True)
            errors = []
            requests = []
            context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
            context.on('request', lambda request: requests.append(request.url))
            crew = context.new_page()
            crew.on('dialog', lambda dialog: dialog.accept())
            crew.goto(base + '/control/')
            crew.fill('#pin', 'browser-fixture-code')
            crew.click('#pair-form button')
            crew.wait_for_selector('#workspace:not([hidden])')
            crew.wait_for_selector('#program-preview')
            crew.locator('#program-preview').content_frame.locator('.event-copy').wait_for()
            crew.screenshot(path=str(OUT/'control-landscape.png'), full_page=True)
            live = context.new_page(); navigations = []
            live.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == live.main_frame else None)
            live.goto(base + '/overlay/live.html'); live.wait_for_selector('.event-copy')

            def state():
                return context.request.get(base + '/api/state').json()

            def saved_after(revision):
                crew.wait_for_function('(revision) => fetch("../api/state").then(r=>r.json()).then(s=>s.revision>revision)', arg=revision)

            def fill_score(selector, value):
                revision = state()['revision']; crew.fill(selector, str(value)); crew.press(selector, 'Tab'); saved_after(revision)

            crew.click('.tabs [data-tab="qualifiers"]')
            for group, indices in [('A', range(1,5)), ('B', range(5,9))]:
                if state()['qualifier']['activeGroup'] != group:
                    revision = state()['revision']; crew.click(f'[data-group="{group}"]'); saved_after(revision)
                for index in indices:
                    for song in range(3):
                        fill_score(f'#qs-p{index}-{song}', 980000 - index*1000)
            for slot, id_ in enumerate(['p5','p6','p7']):
                revision = state()['revision']; crew.select_option(f'#active-{slot}', id_); saved_after(revision)
            crew.click('.tabs [data-tab="broadcast"]')
            revision = state()['revision']; crew.click('[data-scene="result"]'); saved_after(revision)
            live.wait_for_selector('.ranking-tables')
            assert state()['stage'] == 'qualifier'
            assert live.locator('.ranking-tables table').count() == 2
            assert live.locator('.ranking-tables tbody tr').count() == 8
            assert '2,937,000' in live.locator('.ranking-tables').inner_text()
            live.set_viewport_size({'width':1920,'height':1080})
            live.screenshot(path=str(OUT/'overlay-qualifier-ranking.png'), omit_background=True)
            crew.click('.tabs [data-tab="qualifiers"]')
            revision = state()['revision']; crew.click('[data-command="qualify"]'); saved_after(revision)
            assert state()['tournament']['seeded']
            crew.click('.tabs [data-tab="songs"]')
            revision = state()['revision']; crew.click('[data-command="draw-candidates"]'); saved_after(revision)
            crew.locator('[data-ban-player="0"]').first.click(); crew.wait_for_function('document.querySelectorAll(".ban-button.active").length === 1')
            crew.locator('[data-ban-player="1"]').nth(1).click(); crew.wait_for_function('document.querySelectorAll(".ban-button.active").length === 2')
            revision = state()['revision']; crew.click('[data-command="pick-songs"]'); saved_after(revision)
            revision = state()['revision']; crew.click('[data-scene="song-selection"]'); saved_after(revision)
            live.wait_for_selector('[data-rendered-scene="song-selection"]')
            m = state()['tournament']['matches'][0]; assert len(m['songs']) == 2
            for song in m['songs']:
                assert song['title'] in live.locator('.selection-detail').inner_text()
            # Forward, reverse and rapid cover selection; newest item wins.
            candidates = crew.locator('.song-preview-button')
            for index in [0, 3, 1, 5, 2]: candidates.nth(index).click()
            expected = m['candidates'][2]['title']
            assert expected in crew.locator('.song-focus-title').inner_text()
            crew.screenshot(path=str(OUT/'song-selection-landscape.png'), full_page=True)
            crew.click('.tabs [data-tab="bracket"]')
            for player in range(2):
                for song in range(2): fill_score(f'#ms-{player}-{song}', 999999 if player == 0 else 950000)
            crew.locator('#result-details summary').click()
            revision = state()['revision']; crew.click('#result-form button[type="submit"]'); saved_after(revision)
            live.wait_for_selector('[data-rendered-scene="result"]')
            assert state()['result']['matchId'] == 'W1'
            assert len(navigations) == 1, 'Live overlay must update without navigating or reloading.'

            # Complete the remaining regular matches using the same Socket.IO commands.
            # Then exercise the special final's actual control forms.
            crew.evaluate('''async () => {
              const socket = io('/control', {forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});
              let state; await new Promise(resolve=>socket.once('state',s=>{state=s;resolve()}));
              socket.on('state',s=>state=s);
              const command=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',
                {expectedRevision:state.revision,action:{type,payload}},r=>r.ok?resolve():reject(new Error(r.error))));
              for(const id of ['W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']) {
                await command('select-match',{matchId:id}); await command('draw-candidates');
                let m=state.tournament.matches.find(m=>m.id===id);
                await command('ban-song',{playerIndex:0,songId:m.candidates[0].id});
                await command('ban-song',{playerIndex:1,songId:m.candidates[1].id}); await command('pick-songs');
                for(let p=0;p<2;p++)for(let s=0;s<2;s++)await command('set-match-score',{playerIndex:p,songIndex:s,score:p?950000:990000});
                await command('record-result');
              }
              await command('select-match',{matchId:'GF'}); socket.close();
            }''')
            crew.click('.tabs [data-tab="songs"]')
            revision = state()['revision']; crew.click('#final-candidates-form button[type="submit"]'); saved_after(revision)
            revision = state()['revision']; crew.click('#final-picks-form button[type="submit"]'); saved_after(revision)
            final = state()['tournament']['matches'][-1]
            assert len(final['songs']) == 3 and final['songs'][2]['hidden']
            assert 'hostPick' not in final
            revision = state()['revision']; crew.click('[data-scene="song-selection"]'); saved_after(revision)
            live.wait_for_selector('[data-rendered-scene="song-selection"]')
            assert 'MC PICK — SEALED' in live.locator('.selection-detail .picks').inner_text()
            revision = state()['revision']; crew.click('[data-reveal-host]'); saved_after(revision)
            crew.click('.tabs [data-tab="bracket"]')
            assert crew.locator('[data-song-progress="2"]').is_enabled()
            for player in range(2):
                for song in range(3): fill_score(f'#ms-{player}-{song}', 990000 if player == 0 else 980000)
            revision = state()['revision']; crew.click('[data-scene="double-elimination-match"]'); saved_after(revision)
            live.wait_for_selector('[data-rendered-scene="double-elimination-match"]')
            assert live.locator('.score-row').count() == 0
            assert live.locator('.player-info').count() == 2
            assert live.locator('.song-band').count() == 1
            assert '2,970,000' in live.locator('.player-total').first.inner_text()
            live.set_viewport_size({'width':1920,'height':1080})
            live.screenshot(path=str(OUT/'grand-finals-match.png'), omit_background=True)
            crew.locator('#result-details summary').click()
            revision = state()['revision']; crew.click('#result-form button[type="submit"]'); saved_after(revision)
            assert state()['result']['totals'][0] == 2970000
            assert 'Champion' in state()['result']['placements'].values()
            assert state()['tournament']['standings'][0]['placement'] == 'Champion'

            overlay = context.new_page(); overlay.set_viewport_size({'width':1920, 'height':1080})
            geometry = {}
            actual_branding = context.request.get(base + '/api/branding').json()
            for scene in SCENES:
                overlay.goto(base + f'/overlay/{scene}.html?fixed=1')
                overlay.wait_for_selector(f'[data-rendered-scene="{scene}"]')
                overlay.evaluate('document.fonts.ready')
                if actual_branding['visual']:
                    overlay.wait_for_selector('[data-branding="visual"]')
                    overlay.wait_for_function('Array.from(document.querySelectorAll(".key-visual img")).every(i=>i.complete&&i.naturalWidth>0)')
                assert overlay.evaluate('getComputedStyle(document.body).backgroundColor') == 'rgba(0, 0, 0, 0)'
                assert overlay.locator('#canvas').evaluate('(e)=>e.offsetWidth===1920&&e.offsetHeight===1080')
                png = overlay.screenshot(path=str(OUT/f'overlay-{scene}.png'), omit_background=True, animations='disabled')
                image = Image.open(io.BytesIO(png)).convert('RGBA')
                assert image.getpixel((0,0))[3] == 0, scene + ' canvas must stay transparent'
                if scene in ['qualifier-match','double-elimination-match']:
                    for el in overlay.locator('[data-capture]').all():
                        box = el.bounding_box()
                        for fraction_x in [.15,.5,.85]:
                            for fraction_y in [.15,.4,.65]:
                                x = int(box['x']+box['width']*fraction_x); y = int(box['y']+box['height']*fraction_y)
                                assert image.getpixel((x,y))[3] == 0, scene + ' capture must stay transparent'
                if scene == 'bracket':
                    assert overlay.locator('.bracket-node').count() == 14
                    boxes = [el.bounding_box() for el in overlay.locator('.bracket-node').all()]
                    geometry['bracket_bottom'] = max(b['y']+b['height'] for b in boxes)
                    assert geometry['bracket_bottom'] < 950, 'Bracket nodes collide with standings or footer'
                for width, height in [(1280,720),(960,540),(390,844)]:
                    overlay.set_viewport_size({'width':width,'height':height})
                    overlay.wait_for_function('Math.abs(document.querySelector("#canvas").getBoundingClientRect().width - Math.min(innerWidth / 1920, innerHeight / 1080) * 1920) < .1')
                    canvas_box = overlay.locator('#canvas').bounding_box()
                    assert abs(canvas_box['width']/canvas_box['height'] - 16/9) < .001
                    assert canvas_box['x'] >= -.1 and canvas_box['x']+canvas_box['width'] <= width+.1
                    if width in [1280,960] and scene == 'double-elimination-match':
                        overlay.screenshot(path=str(OUT/f'match-{height}p.png'), omit_background=True)
                overlay.set_viewport_size({'width':1920,'height':1080})

            # Check the documented capture coordinates, optional cameras and score detail.
            layouts = {
                ('qualifier-match', ''): [(64,300,1088,612),(1200,214,656,369),(1200,630,656,369)],
                ('qualifier-match', '&details=1'): [(64,300,1088,612),(1200,214,656,369),(1200,630,656,369)],
                ('qualifier-match', '&cameras=1&details=1'): [(64,300,576,324),(64,800,240,135),(672,300,576,324),(672,800,240,135),(1280,300,576,324),(1280,800,240,135)],
                ('double-elimination-match', ''): [(64,280,872,490.5),(984,280,872,490.5)],
                ('double-elimination-match', '&details=1'): [(64,280,872,490.5),(984,280,872,490.5)],
                ('double-elimination-match', '&cameras=1&details=1'): [(64,280,872,490.5),(64,846,224,126),(984,280,872,490.5),(1632,846,224,126)]
            }
            for (scene, options), expected in layouts.items():
                overlay.goto(base + f'/overlay/{scene}.html?fixed=1' + options)
                overlay.wait_for_selector(f'[data-rendered-scene="{scene}"]')
                overlay.evaluate('document.fonts.ready')
                captures = overlay.locator('[data-capture]').all()
                assert len(captures) == len(expected)
                expected_scores = (9 if scene == 'qualifier-match' else 6) if options else 0
                assert overlay.locator('.score-row').count() == expected_scores
                png = overlay.screenshot(path=str(OUT/(scene + ('-cameras-details.png' if options else '-minimal.png'))), omit_background=True, animations='disabled')
                image = Image.open(io.BytesIO(png)).convert('RGBA')
                for el, rect in zip(captures, expected):
                    box = el.bounding_box()
                    for key, value in zip(['x','y','width','height'], rect): assert abs(box[key]-value) < .1, (scene,key,box,rect)
                    if el.get_attribute('data-capture') == 'gameplay': assert abs(box['width']/box['height'] - 16/9) < .001
                    for fraction_x in [.1,.5,.9]:
                        for fraction_y in [.1,.5,.9]:
                            assert image.getpixel((int(box['x']+box['width']*fraction_x),int(box['y']+box['height']*fraction_y)))[3] == 0, (scene,options,'opaque capture')
                    # Names and score detail must remain outside capture interiors.
                    for label in overlay.locator('.player-info,.song-band,.song-scores,.player-total').all():
                        text = label.bounding_box()
                        assert text['x']+text['width'] <= box['x'] or text['x'] >= box['x']+box['width'] or text['y']+text['height'] <= box['y'] or text['y'] >= box['y']+box['height'], (scene,options,'label overlaps capture',text,box)

            # Test real local-asset rendering using labelled in-memory fixtures, never fake delivered artwork.
            brand_page = context.new_page()
            brand_page.set_viewport_size({'width':1920,'height':1080})
            brand_page.route('**/api/branding', lambda route: route.fulfill(json={'logo':'assets/event/fixture-logo.svg','visual':'assets/event/fixture-poster.svg'}))
            brand_page.route('**/assets/event/fixture-logo.svg', lambda route: route.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="500" height="150"><rect width="500" height="150" fill="#87dddd"/></svg>'))
            brand_page.route('**/assets/event/fixture-poster.svg', lambda route: route.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="1312" height="1860"><rect width="1312" height="1860" fill="#654064"/></svg>'))
            for scene in ['start','qualifier-waiting','double-elimination-waiting']:
                brand_page.goto(base + f'/overlay/{scene}.html?fixed=1')
                brand_page.wait_for_selector('[data-branding="visual"]')
                brand_page.wait_for_function('Array.from(document.querySelectorAll(".key-visual img,.phigros-logo")).every(i=>i.complete&&i.naturalWidth>0)')
                assert brand_page.locator('.key-visual img').count() == 1
                assert brand_page.locator('.phigros-logo').count() == 1
                assert brand_page.locator('.key-visual img').evaluate('(el)=>getComputedStyle(el).objectFit') == 'contain'
            brand_page.goto(base + '/overlay/qualifier-match.html?fixed=1')
            brand_page.wait_for_selector('[data-branding="visual"]')
            branded_png = Image.open(io.BytesIO(brand_page.screenshot(omit_background=True, animations='disabled'))).convert('RGBA')
            for el in brand_page.locator('[data-capture]').all():
                box = el.bounding_box()
                assert branded_png.getpixel((int(box['x']+box['width']/2),int(box['y']+box['height']/2)))[3] == 0
            brand_page.close()

            for width,height in [(1194,834),(768,1024),(390,844)]:
                crew.set_viewport_size({'width':width,'height':height})
                for tab in ['broadcast','qualifiers','bracket','songs','event']:
                    crew.click(f'.tabs [data-tab="{tab}"]')
                    overflow = crew.evaluate('document.documentElement.scrollWidth > innerWidth')
                    if overflow:
                        boxes = crew.evaluate('Array.from(document.querySelectorAll("#content *")).map(el=>({selector:el.tagName+"."+el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width})).filter(b=>b.right>innerWidth+.5).slice(0,10)')
                        raise AssertionError(f'Overflow {tab} at {width}: {boxes}')
                crew.click('.tabs [data-tab="broadcast"]')
                crew.screenshot(path=str(OUT/f'control-{width}.png'), full_page=True)

            # Browser offline/online: both crew and overlay must recover without refresh.
            context.set_offline(True)
            crew.wait_for_selector('#connection.offline')
            context.set_offline(False)
            crew.wait_for_selector('#connection:not(.offline)', timeout=15000)
            live.wait_for_function('!document.querySelector("#canvas").classList.contains("is-offline")', timeout=15000)
            assert len(navigations) == 1
            crew.emulate_media(reduced_motion='reduce')
            overlay.emulate_media(reduced_motion='reduce')
            crew.click('.tabs [data-tab="songs"]')
            crew.locator('.song-preview-button').nth(4).focus()
            crew.keyboard.press('Enter')
            assert state()['tournament']['matches'][-1]['candidates'][4]['title'] in crew.locator('.song-focus-title').inner_text()
            assert crew.locator('.cover-window img').count() == 1
            assert not errors, errors
            external = [url for url in requests if urlsplit(url).hostname not in ['127.0.0.1', None]]
            assert not external, external
            assert overlay.evaluate('document.fonts.check("16px Saira")')
            print(json.dumps({'result':'PASS','scenes':len(SCENES),'control_viewports':[1194,768,390],'overlay_outputs':['1080p','720p','540p','390px preview'],'realtime_no_reload':True,'reconnect':True,'external_requests':0,'browser_errors':errors,'geometry':geometry}, indent=2))
            browser.close()
    finally:
        process.terminate()
        try: process.wait(timeout=8)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
