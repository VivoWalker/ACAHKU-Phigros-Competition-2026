#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline/promises');
const { listManualSaves, loadManualSave } = require('./manual-save-loader');

function parseArgs(args) {
  const options = { port: 3001, host: '0.0.0.0', json: false, list: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list' || arg === '--json' || arg === '--help') options[arg.slice(2)] = true;
    else if (['--case', '--port', '--host'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Provide a value for ' + arg + '.');
      options[arg.slice(2)] = arg === '--port' ? Number(value) : value;
    } else throw new Error('Unknown option: ' + arg);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error('Port must be an integer from 0 to 65535.');
  if (!['0.0.0.0', '127.0.0.1', 'localhost'].includes(options.host))
    throw new Error('Host must be 0.0.0.0, 127.0.0.1 or localhost.');
  return options;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('npm run test:manual -- --case Q05 [--port 3001] [--host 127.0.0.1]');
    console.log('npm run test:manual -- --list\nOmit --case for the interactive menu.');
    return;
  }
  const entries = listManualSaves();
  if (options.list || !options.case) {
    if (options.json && options.list) { console.log(JSON.stringify(entries)); return; }
    if (options.json && !options.case) throw new Error('--json requires --case or --list.');
    entries.forEach((entry, i) => console.log(String(i + 1).padStart(2) + '. ' + entry.id + '  ' + entry.title));
    if (options.list) return;
    if (!process.stdin.isTTY) throw new Error('Choose a save with --case Q05.');
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { options.case = await prompt.question('\n输入编号或案例 ID：'); }
    finally { prompt.close(); }
  }
  const { entry, state } = loadManualSave(options.case);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-manual-'));
  let broadcast, stopping;
  const stop = () => {
    if (!stopping) stopping = (async () => {
      try { if (broadcast) await broadcast.close(); }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    })();
    return stopping;
  };
  try {
    fs.writeFileSync(path.join(directory, 'match-state.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    broadcast = require('../server').createBroadcastServer({ dataDir: directory, pin: 'test-main', scorekeeperPin: 'test-score' });
    const address = await broadcast.listen(options.port, options.host);
    // Publish readiness only after a caller can safely stop the test server.
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      stop().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
    });
    const base = 'http://localhost:' + address.port;
    const ready = { caseId: entry.id, port: address.port, dataDir: directory,
      controlUrl: base + '/control/', scorekeeperUrl: base + '/scorekeeper/', overlayUrl: base + '/overlay/live.html' };
    if (options.json) console.log(JSON.stringify(ready));
    else {
      console.log('\n' + entry.id + ' · ' + entry.title);
      console.log('主控：' + ready.controlUrl + '    测试配对码：test-main');
      console.log('记分员：' + ready.scorekeeperUrl + '    测试配对码：test-score');
      console.log('OBS：' + ready.overlayUrl + '    1920×1080');
      if (options.host === '0.0.0.0') {
        for (const network of Object.values(os.networkInterfaces())) for (const item of network || []) {
          if (item.family === 'IPv4' && !item.internal) console.log('局域网：http://' + item.address + ':' + address.port + '/control/');
        }
      }
      console.log('\n操作：'); entry.steps.forEach((step, i) => console.log((i + 1) + '. ' + step));
      console.log('\n预期：'); entry.expected.forEach(value => console.log('· ' + value));
      console.log('\n临时测试赛事。按 Ctrl+C 结束，再加载下一个存档。');
    }
    return { ...ready, broadcast, stop };
  } catch (error) { await stop(); throw error; }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parseArgs };
