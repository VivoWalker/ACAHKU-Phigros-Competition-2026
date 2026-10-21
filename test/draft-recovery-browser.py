"""Refresh recovery and identity/conflict regression with isolated fixture events.

Requires Python Playwright and Chromium. Never opens production event data or
credentials. Reports use BROADCAST_TEST_OUTPUT or test-results/draft-recovery.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'draft-recovery'))
REPORT = {'checks': [], 'browser_errors': []}
SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const {createDefaultState}=require('./lib/default-state'),{applyAction}=require('./lib/tournament');
const create=()=>{const s=createDefaultState();applyAction(s,{type:'set-qualifier-plan',payload:{plan:'A'}});return s};
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(create()));
const b=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'draft-recovery-main-fixture',scorekeeperPin:'draft-recovery-score-fixture'});
// Test-only event replacement keeps this local server's address and credentials.
b.app.post('/__fixture/new-event',(_req,res)=>{b.store.state=create();b.store.write(b.store.state);res.json({ok:true})});
b.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>b.close().then(()=>process.exit()));
"""


def check(label):
    REPORT['checks'].append(label)


def pair(page, base, role):
    page.goto(f'{base}/{role}/')
    page.fill('#pin', f'draft-recovery-{ "main" if role == "control" else "score" }-fixture')
    page.click('#pair-form button')
    page.wait_for_selector('#workspace', state='visible')
    page.wait_for_function("document.querySelector('#sync-status').textContent.includes('revision') || document.querySelector('#sync-status').textContent.includes('已同步')")


def event_tab(page):
    page.locator('[data-tab="event"]').click()
    page.wait_for_selector('#event-title')


def command(page, action, payload):
    result = page.evaluate(r"""async ({action,payload})=>{
      const token=sessionStorage.getItem('broadcast-token'),s=io('/control',{forceNew:true,auth:{token}});
      const state=await new Promise((resolve,reject)=>{s.once('state',resolve);s.once('connect_error',reject)});
      const result=await new Promise(resolve=>s.emit('command',{expectedRevision:state.revision,action:{type:action,payload}},resolve));
      s.disconnect();return result;
    }""", {'action': action, 'payload': payload})
    assert result['ok'], result


def draft_records(page, role):
    return page.evaluate("role=>{const raw=sessionStorage.getItem('broadcast-drafts:v1:'+role+':'+encodeURIComponent(location.origin));return raw?JSON.parse(raw).records:[]}", role)


def song(page, index):
    return page.locator(f'form[data-player-key="p1"] input[data-score-key][data-song-index="{index}"]')


def fill_result(page):
    for index in range(3):
        song(page, index).fill(str(900000 + index))
        wrapper = song(page, index).locator('xpath=ancestor::div[@data-field-key]')
        for name, value in [('perfect', 100), ('good', 2), ('bad', 0), ('miss', 0)]:
            wrapper.locator(f'[data-judgement-name="{name}"]').fill(str(value))
    song(page, 3).fill('2700003')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='broadcast-draft-recovery-') as directory:
        process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
            assert selector.select(20), 'Fixture server did not start'
            port = process.stdout.readline().strip(); base = 'http://127.0.0.1:' + port
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path=os.environ.get('CHROME_BINARY') or shutil.which('chromium'), headless=True, args=['--no-sandbox'])
                context = browser.new_context()
                context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
                control = context.new_page(); pair(control, base, 'control'); event_tab(control)
                control.fill('#event-title', 'Recovered local title')
                assert len(draft_records(control, 'control')) == 1
                control.reload(); event_tab(control)
                assert control.input_value('#event-title') == 'Recovered local title'
                assert '已恢復' in control.locator('.draft-notice').inner_text()
                assert control.evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.event.title)") != 'Recovered local title'
                check('main-control reload restores a draft without submitting it')
                command(control, 'set-event', {'title': 'Other operator title'})
                control.reload(); event_tab(control)
                assert control.input_value('#event-title') == 'Recovered local title'
                assert 'Other operator title' in control.locator('.draft-notice').inner_text()
                control.locator('[data-draft-resolution="server"]').click()
                assert draft_records(control, 'control') == []
                check('main-control recovered draft detects a changed server value and can be discarded')
                control.fill('#event-title', 'Deliberately saved title'); control.locator('#event-form button[type="submit"]').click()
                control.wait_for_function("!document.querySelector('.draft-notice')")
                assert draft_records(control, 'control') == []
                control.reload(); event_tab(control)
                assert control.input_value('#event-title') == 'Deliberately saved title'
                check('acknowledged main-control save removes persisted drafts')
                # A damaged scope inside otherwise valid JSON must not break rendering.
                identity = control.evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.eventId)")
                auth = control.evaluate("sessionStorage.getItem('broadcast-token')")
                malformed = context.new_page()
                malformed.add_init_script("""(() => {
                  const scope='score-entry:bad';
                  sessionStorage.setItem('broadcast-token',TOKEN);
                  sessionStorage.setItem('broadcast-drafts:v1:control:'+encodeURIComponent(location.origin),JSON.stringify({version:1,role:'control',origin:location.origin,identity:IDENTITY,updatedAt:Date.now(),records:[{key:scope+'|field',scope,id:'field',label:'damaged',numeric:false,base:'',value:'12',reader:{kind:'form',scope,id:'field'}}]}));
                  window.__injectedScope=JSON.parse(sessionStorage.getItem('broadcast-drafts:v1:control:'+encodeURIComponent(location.origin))).records[0].scope;
                })();""".replace('TOKEN', json.dumps(auth)).replace('IDENTITY', json.dumps(identity)))
                malformed.goto(base+'/control/'); malformed.wait_for_selector('#program-preview')
                assert malformed.evaluate('window.__injectedScope') == 'score-entry:bad'
                event_tab(malformed)
                assert draft_records(malformed, 'control') == []
                malformed.close()
                check('malformed recovered control scope is discarded safely')
                scorer = context.new_page(); pair(scorer, base, 'scorekeeper'); fill_result(scorer)
                assert len(draft_records(scorer, 'scorekeeper')) == 4
                scorer.reload(); scorer.wait_for_selector('form[data-player-key="p1"]')
                assert [song(scorer, i).input_value() for i in range(4)] == ['900000', '900001', '900002', '2700003']
                assert '已恢復' in scorer.locator('#draft-notice').inner_text()
                assert scorer.evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.qualifier.players.find(p=>p.id==='p1').challengeTotal)") is None
                check('scorekeeper reload restores all sixteen values without submitting')
                command(control, 'set-qualifier-total', {'group': 'A', 'playerId': 'p1', 'total': 2600000})
                scorer.reload(); scorer.wait_for_selector('.is-conflict')
                assert song(scorer, 3).input_value() == '2700003'
                assert scorer.locator('form[data-player-key="p1"] [data-save-player]').is_disabled()
                # Keep the total after reviewing the saved value, then explicitly save.
                scorer.locator('form[data-player-key="p1"] [data-song-index="3"]').locator('xpath=ancestor::div[@data-field-key]').locator('[data-keep-draft]').click()
                scorer.locator('form[data-player-key="p1"] [data-save-player]').click()
                scorer.wait_for_function("!document.querySelector('form[data-player-key=\\\"p1\\\"] .is-dirty')")
                assert draft_records(scorer, 'scorekeeper') == []
                check('recovered scorekeeper conflict requires review and deliberate save clears storage')
                # Simulate a save whose acknowledgement was lost: authoritative matching
                # server values should clear the recovered sheet after reload.
                song(scorer, 0).fill('800000')
                records = draft_records(scorer, 'scorekeeper')
                assert len(records) == 4
                stats = [{'score': 800000 if i == 0 else 900000+i, 'perfect': 100, 'good': 2, 'bad': 0, 'miss': 0} for i in range(3)]
                command(control, 'set-qualifier-challenge-result', {'group': 'A', 'playerId': 'p1', 'total': 2700003, 'songStats': stats})
                scorer.reload(); scorer.wait_for_selector('form[data-player-key="p1"]')
                assert draft_records(scorer, 'scorekeeper') == []
                assert not scorer.locator('form[data-player-key="p1"] .is-dirty').count()
                check('unconfirmed scorekeeper save is reconciled with authoritative server data')
                # Leave drafts in both roles, replace with a distinct event at the same
                # origin and with identical display metadata, and keep existing tokens.
                control.fill('#event-title', 'Old event draft'); song(scorer, 0).fill('700000')
                assert draft_records(control, 'control') and draft_records(scorer, 'scorekeeper')
                control.evaluate("fetch('/__fixture/new-event',{method:'POST'})")
                control.reload(); event_tab(control); scorer.reload(); scorer.wait_for_selector('form[data-player-key="p1"]')
                assert control.input_value('#event-title') != 'Old event draft'
                assert song(scorer, 0).input_value() == ''
                assert draft_records(control, 'control') == draft_records(scorer, 'scorekeeper') == []
                check('a new event at the same origin never restores either role old drafts')
                # Denied storage must keep the normal in-memory editing flow usable.
                denied = browser.new_context()
                denied.add_init_script("Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('denied','SecurityError')}})")
                page = denied.new_page(); page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error)))
                pair(page, base, 'control'); event_tab(page); page.fill('#event-title', 'Memory-only draft')
                assert '未提交草稿' in page.locator('.draft-notice').inner_text()
                check('denied browser storage degrades to in-memory staff editing')
                denied.close(); browser.close()
            assert REPORT['browser_errors'] == [], REPORT['browser_errors']
        finally:
            process.terminate()
            try: process.wait(timeout=8)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=8)
            (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False))
    print(json.dumps(REPORT, ensure_ascii=False))


if __name__ == '__main__':
    main()
