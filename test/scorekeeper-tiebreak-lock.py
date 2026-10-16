"""Check tiebreak-only score entry and confirmed-round read-only sheets in Chromium."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'scorekeeper-tiebreak-lock'))
SERVER = r"""
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'tie-lock-main-fixture',scorekeeperPin:'tie-lock-scorer-fixture'});
const command=(type,payload={})=>app.store.commit({type,payload},app.store.state.revision);
command('set-qualifier-scoring-mode',{mode:'legacy-score'});
command('set-qualifier-plan',{plan:'A'});
[990000,980000,970000,900000,900000,800000,700000,600000].forEach((score,index)=>{
  for(let songIndex=0;songIndex<3;songIndex++)command('set-qualifier-score',{group:'A',playerId:'p'+(index+1),songIndex,score,judgements:{accuracy:98}});
});
command('draw-qualifier-tiebreak',{group:'A',playerIds:['p4','p5']});
command('set-qualifier-display',{players:['p4']});
app.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""

OUT.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='scorekeeper-tiebreak-lock-browser-') as data_dir:
    process = subprocess.Popen(['node', '-e', SERVER, data_dir], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        port = process.stdout.readline().strip()
        assert port.isdigit(), 'Temporary fixture server did not start'
        base = 'http://127.0.0.1:' + port
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1194, 'height': 834})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/scorekeeper/')
            page.fill('#pin', 'tie-lock-scorer-fixture')
            page.click('#pair-form button')
            page.wait_for_selector('#workspace:not([hidden])')
            page.wait_for_function('document.querySelectorAll("input[data-score-key]:not(:disabled)").length===2')
            assert page.locator('#context-title').inner_text().endswith('加賽 1')
            assert page.locator('form[data-player-key]').evaluate_all('(forms)=>forms.map(form=>form.dataset.playerKey)') == ['p4','p5']
            assert page.evaluate('''async()=>{
              const response=await fetch('/api/scorekeeper-state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('scorekeeper-token')}});
              const {qualifier}=await response.json();
              return JSON.stringify(qualifier.activePlayers)==='["p4"]'&&
                JSON.stringify(qualifier.players.map(player=>player.id))==='["p4"]'&&
                JSON.stringify(qualifier.tiebreak.players.map(player=>player.id))==='["p4","p5"]';
            }'''), 'Every tiebreak participant must remain scoreable outside the regular live batch'
            for player_id in ['p4', 'p5']:
                form = page.locator('form[data-player-key="' + player_id + '"]')
                form.locator('input[data-score-key]').fill('900000')
                form.locator('input[data-judgement-name=accuracy]').fill('98')
                form.locator('button[data-save-player]').click()
                page.wait_for_function('id=>document.querySelector(`form[data-player-key="${id}"] [data-player-status]`).textContent==="所有分數已同步"', arg=player_id)
            page.evaluate('''async()=>{
              const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'control',pin:'tie-lock-main-fixture'})});
              const {token}=await response.json(),socket=io('/control',{forceNew:true,auth:{token}});
              await new Promise(resolve=>socket.once('state',resolve));
              window.__masterCommand=async(type,payload)=>{
                const state=await fetch('/api/control-state',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
                const response=await new Promise(resolve=>socket.emit('command',{expectedRevision:state.revision,action:{type,payload}},resolve));
                if(!response.ok)throw Error(response.error);return response;
              };
            }''')
            page.evaluate("window.__masterCommand('confirm-qualifier-tiebreak',{group:'A',index:0,verified:true})")
            page.wait_for_function('document.querySelectorAll("input[data-score-key]").length===3 && document.querySelectorAll("input[data-score-key]:not(:disabled)").length===0')
            assert page.locator('form[data-player-key]').evaluate_all('(forms)=>forms.map(form=>form.dataset.playerKey)') == ['p4']
            assert '加賽已確認' in page.locator('#match-notice').inner_text()
            assert '主控' in page.locator('#match-notice').inner_text()
            assert page.locator('input[data-judgement-key]:not(:disabled)').count() == 0
            assert page.locator('button[data-save-player]:not(:disabled)').count() == 0
            for width, height in [(1194, 834), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                overlap = page.evaluate('''()=>{
                  const elements=[...document.querySelectorAll('#match-notice,#score-list .player-card')];
                  return elements.some((a,i)=>elements.slice(i+1).some(b=>{
                    const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();
                    return Math.min(x.right,y.right)>Math.max(x.left,y.left)+.5&&Math.min(x.bottom,y.bottom)>Math.max(x.top,y.top)+.5;
                  }));
                }''')
                assert not overlap, 'Lock notice overlaps a player card'
                page.screenshot(path=str(OUT / f'confirmed-tiebreak-{width}.png'), full_page=True)
            page.evaluate("window.__masterCommand('draw-qualifier-tiebreak',{group:'A',playerIds:['p4','p5']})")
            page.wait_for_function('document.querySelectorAll("input[data-score-key]:not(:disabled)").length===2')
            assert page.locator('#context-title').inner_text().endswith('加賽 2')
            assert page.locator('#match-notice').is_hidden()
            assert not errors, errors
            report = {'result': 'PASS', 'pending_tiebreak_editable': True, 'confirmed_tiebreak_base_read_only': True,
                      'tiebreak_participants_outside_live_batch_editable': True, 'confirmed_batch_player_ids': ['p4'],
                      'master_correction_guidance': True, 'repeat_tiebreak_editable': True,
                      'layout_widths': [1194, 390], 'overlap': False, 'page_errors': errors}
            (OUT / 'report.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report))
            browser.close()
    finally:
        process.terminate()
        process.communicate(timeout=12)
