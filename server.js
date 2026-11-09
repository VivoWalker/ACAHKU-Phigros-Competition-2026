require('./scripts/check-node-version').assertSupportedNode();
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, timingSafeEqual, createHmac } = require('node:crypto');
const { Server } = require('socket.io');
const { StateStore } = require('./lib/store');
const { publicState, resultCorrectionImpact } = require('./lib/tournament');
const { getBranding } = require('./lib/branding');
const { createDisplayAssetsReader } = require('./lib/display-assets');
const { sourceStatus } = require('./lib/broadcast-check');
const obsAdapter = require('./lib/obs-adapter');
const { FILE_NAME: INTERMISSION_FILE, createIntermissionMedia } = require('./lib/intermission-media');
const { createIntermissionPlayback } = require('./lib/intermission-playback');
const { context: countdownContext, DURATION: COUNTDOWN_CUE_DURATION } = require('./public/js/countdown');
const { scorekeeperState, scorekeeperAction, SCORE_ACTIONS } = require('./lib/scorekeeper');
const { hostState, hostAction, HOST_ACTIONS } = require('./lib/host');
const { loadPairingCredentials } = require('./lib/pairing-credentials');
const { PairingAttempts } = require('./lib/pairing-attempts');
const { acquireDataDirectoryLock } = require('./lib/data-directory-lock');
function createBroadcastServer(options = {}) {
  const preset=options.preset || process.env.EVENT_PRESET || 'acahku-2026';
  if (!['standard','acahku-2026'].includes(preset)) throw new Error('Choose standard or acahku-2026 as the event preset.');
  options={...options,preset};
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const dataLock = acquireDataDirectoryLock(dataDir);
  try { return initialiseBroadcastServer(options, dataDir, dataLock); }
  catch (error) { dataLock.release(); throw error; }
}
function initialiseBroadcastServer(options, dataDir, dataLock) {
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const displayAssets = createDisplayAssetsReader({ publicDir });
  const store = new StateStore(dataDir, { createState: options.preset === 'standard' ? require('./lib/default-state').createStandardState : undefined, assertWritable: () => dataLock.assertHeld() });
  const { pin, scorekeeperPin, hostPin, sessionKey } = loadPairingCredentials(dataDir, options);
  const intermissionMedia = createIntermissionMedia(dataDir, { assertWritable: () => dataLock.assertHeld() });
  const sign = nonce => createHmac('sha256', sessionKey).update(nonce + ':' + pin).digest('hex');
  const validToken = token => {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return false;
    const [nonce, signature] = token.split('.');
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(nonce), 'hex'));
  };
  const scorekeeperSign = nonce => createHmac('sha256', sessionKey).update('scorekeeper:' + nonce + ':' + scorekeeperPin).digest('hex');
  const validScorekeeperToken = token => {
    if (typeof token !== 'string' || !/^scorekeeper\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return false;
    const [, nonce, signature] = token.split('.');
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(scorekeeperSign(nonce), 'hex'));
  };
  const attempts = new PairingAttempts();
  const hostSign = nonce => createHmac('sha256', sessionKey).update('host:' + nonce + ':' + hostPin).digest('hex');
  const validHostToken = token => {
    if (typeof token !== 'string' || !/^host\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return false;
    const [, nonce, signature] = token.split('.');
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(hostSign(nonce), 'hex'));
  };
  const app = express(); const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 100000, cors: false });
  // Staff panels send plain JSON; keep request bodies out of native decompressors.
  app.disable('x-powered-by'); app.use(express.json({ limit: '100kb', inflate: false }));
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); next(); });
  const controls = io.of('/control'); const overlays = io.of('/overlay'); const scorekeepers = io.of('/scorekeeper');
  const hosts = io.of('/host');
  const intermissionPlayback = createIntermissionPlayback({ store, onChange: publishState });
  // A start cue belongs to the live connection, never to a saved match or backup.
  let countdownCue = null, countdownTimer = null, countdownSources = null, countdownSequence = 0;
  function clearCountdown() {
    clearTimeout(countdownTimer); countdownTimer = null;
    if (!countdownCue) return;
    countdownCue = null; countdownSources = null; countdownSequence++; publishCountdown();
  }
  function expireCountdown() {
    if (!countdownCue) return;
    // A timer can wake before the wall-clock deadline; keep the shared cue
    // until its timestamp is actually reached.
    const remaining = countdownCue.endsAt - Date.now();
    if (remaining > 0) { countdownTimer = setTimeout(expireCountdown, remaining); return; }
    clearCountdown();
  }
  function countdownMessage() {
    if (countdownCue && Date.now() >= countdownCue.endsAt) clearCountdown();
    return { serverNow: Date.now(), sequence: countdownSequence, cue: countdownCue };
  }
  function publishCountdown() {
    const message = countdownMessage();
    controls.emit('countdown', message); overlays.emit('countdown', message);
  }
  function cancelChangedCountdown() {
    if (countdownCue && (countdownContext(store.state)?.key !== countdownCue.context.key ||
      JSON.stringify(store.state.broadcast?.sourceSlots || null) !== countdownSources)) clearCountdown();
  }
  function controlState() { return { ...store.state, broadcast: { ...store.state.broadcast, sourceStatus: sourceStatus(store.state) } }; }
  function connectionStatus() { return { overlays: overlays.sockets.size, controls: controls.sockets.size, scorekeepers: scorekeepers.sockets.size, hosts: hosts.sockets.size, obs: 'not-configured', revision: store.state.revision }; }
  function notifyStatus() { controls.emit('connections', connectionStatus()); }
  function publishState(beforeScene) {
    intermissionPlayback.sync();
    cancelChangedCountdown();
    controls.emit('state', controlState()); overlays.emit('state', publicState(store.state)); scorekeepers.emit('state', scorekeeperState(store.state));
    hosts.emit('state', hostState(store.state));
    if (beforeScene !== store.state.scene) obsAdapter.emit('sceneChanged', store.state.scene);
    notifyStatus();
  }
  function requestFailure(res, error) { return res.status(error.code === 'STALE' ? 409 : 400).json({ error: error.message, code: error.code || 'INVALID', revision: store.state.revision }); }
  function authenticated(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (validScorekeeperToken(token) || validHostToken(token)) return res.status(403).json({ error: 'This operation requires the main control panel.', code: 'FORBIDDEN' });
    if (!validToken(token)) return res.status(401).json({ error: 'Control pairing required.' }); next();
  }
  function scorekeeperAuthenticated(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (validToken(token) || validHostToken(token)) return res.status(403).json({ error: 'Use the scorekeeper pairing code for this panel.', code: 'FORBIDDEN' });
    if (!validScorekeeperToken(token)) return res.status(401).json({ error: 'Scorekeeper pairing required.' }); next();
  }
  app.post('/api/intermission/video', authenticated, async (req, res) => {
    try { res.json(await intermissionMedia.upload(req)); }
    catch (error) {
      req.resume();
      if (!res.destroyed) res.status(error.status || 400).json({ error: error.message });
    }
  });
  app.get('/media/intermission/:file', (req, res) => {
    if (!INTERMISSION_FILE.test(req.params.file)) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(req.params.file, { root: intermissionMedia.directory, dotfiles: 'deny' }, error => {
      if (!error) return;
      if (res.headersSent) return res.destroy();
      res.sendStatus(error.status || 500);
    });
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, revision: store.state.revision }));
  app.get('/api/state', (req, res) => res.json(publicState(store.state)));
  app.get('/api/branding', (req, res) => res.json(store.state.eventProfile?.branding || getBranding()));
  app.get('/api/event-template/check', authenticated, (req,res)=>{
    const state=store.state, template=require('./lib/event-templates').exportTemplate(state);
    const resources=new Set([...template.library.flatMap(s=>[s.art,s.previewAudio]),...Object.values(template.profile.branding),template.intermission?.videoPath].filter(Boolean));
    const missing=[...resources].filter(file=>!require('node:fs').existsSync(path.join(file.startsWith('assets/')?publicDir:dataDir,file)));
    res.json({regularCharts:require('./public/js/song-pool').distinct(state.library.filter(s=>s.eligible)).length,recommendedMinimum:30,missing});
  });
  app.get('/api/event-template', authenticated, (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="event-template.json"');
    res.json(require('./lib/event-templates').exportTemplate(store.state));
  });
  app.get('/api/display-assets', async (req, res) => res.json(await displayAssets.read()));
  app.post('/api/session', (req, res) => {
    const role = req.body?.role === undefined ? 'control' : req.body.role;
    if (!['control', 'scorekeeper', 'host'].includes(role)) return res.status(400).json({ error: 'Unknown panel role.', code: 'INVALID' });
    const key = role + ':' + req.ip;
    if (attempts.blocked(key)) return res.status(429).json({ error: 'Too many pairing attempts. Wait one minute.' });
    const expectedPin = role === 'control' ? pin : role === 'host' ? hostPin : scorekeeperPin;
    const candidate = String(req.body?.pin || '');
    if (Buffer.byteLength(candidate) !== Buffer.byteLength(expectedPin) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedPin))) {
      attempts.fail(key); return res.status(401).json({ error: 'Incorrect pairing code.' });
    }
    attempts.clear(key); const nonce = randomBytes(32).toString('hex');
    res.json({ token: role === 'control' ? nonce + '.' + sign(nonce) : role === 'host' ? 'host.' + nonce + '.' + hostSign(nonce) : 'scorekeeper.' + nonce + '.' + scorekeeperSign(nonce), role });
  });
  app.get('/api/control-state', authenticated, (req, res) => res.json(controlState()));
  app.get('/api/scorekeeper-state', scorekeeperAuthenticated, (req, res) => res.json(scorekeeperState(store.state)));
  app.get('/api/host-state', (req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (validToken(token) || validScorekeeperToken(token)) return res.status(403).json({ error: 'Host pairing required.', code: 'FORBIDDEN' });
    if (!validHostToken(token)) return res.status(401).json({ error: 'Host pairing required.' });
    res.json(hostState(store.state));
  });
  app.get('/api/export', authenticated, (req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="match-state-backup.json"'); res.json(store.state); });
  app.get('/api/backups', authenticated, async (req, res) => {
    try { res.json({ backups: await store.listBackupsAsync(), recovery: store.state.recovery || null }); }
    catch (error) { requestFailure(res, error); }
  });
  app.get('/api/backups/:id/preview', authenticated, (req, res) => {
    try { res.json(store.previewBackup(req.params.id)); } catch (error) { requestFailure(res, error); }
  });
  app.post('/api/restore', authenticated, (req, res) => {
    try {
      const beforeScene = store.state.scene;
      store.restore(req.body?.backupId, req.body?.expectedRevision, req.body?.reason);
      clearCountdown();
      publishState(beforeScene); res.json({ ok: true, revision: store.state.revision });
    } catch (error) { requestFailure(res, error); }
  });
  app.get('/api/result-correction/:matchId', authenticated, (req, res) => {
    try { res.json({ revision: store.state.revision, impact: resultCorrectionImpact(store.state, req.params.matchId) }); }
    catch (error) { requestFailure(res, error); }
  });
  app.get('/', (req, res) => res.redirect('/control/'));
  app.use(express.static(publicDir, { setHeaders(res, filename) {
    const relative = path.relative(publicDir, filename).split(path.sep).join('/');
    if (relative.startsWith('assets/') && /\.(?:avif|gif|jpe?g|png|svg|webp|woff2?|mp3|ogg|wav|m4a)$/i.test(relative)) {
      // Retain public media bytes/decoders, but revalidate changed local files.
      // API responses and frontend documents keep their no-store policy.
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  } }));
  controls.use((socket, next) => validToken(socket.handshake.auth?.token) ? next() : next(new Error(validScorekeeperToken(socket.handshake.auth?.token) || validHostToken(socket.handshake.auth?.token) ? 'FORBIDDEN' : 'PAIRING_REQUIRED')));
  controls.on('connection', socket => {
    socket.emit('state', controlState()); socket.emit('countdown', countdownMessage()); notifyStatus();
    socket.on('countdown-sync', ack => { if (typeof ack === 'function') ack(countdownMessage()); });
    socket.on('countdown-command', (request, ack) => {
      if (typeof ack !== 'function') return;
      try {
        store.assertRevision(request?.expectedRevision);
        if (!['start', 'cancel'].includes(request?.action)) throw new Error('Unknown countdown command.');
        const context = countdownContext(store.state);
        if (!context) throw new Error('Show a match with the players and selected song before starting the countdown.');
        if (request.contextKey !== context.key) {
          const error = new Error('The match, players, song or broadcast layout changed. Review the current match before starting.');
          error.code = 'CONTEXT_CHANGED'; throw error;
        }
        countdownMessage();
        if (request.action === 'cancel') {
          if (request.cueId !== countdownCue?.id) {
            const error = new Error('The countdown changed. Review the active countdown before cancelling.');
            error.code = 'CUE_CHANGED'; throw error;
          }
          clearCountdown();
        }
        else {
          if (countdownCue) { const error = new Error('A countdown is already running. Cancel it before starting another.'); error.code = 'ALREADY_RUNNING'; throw error; }
          const startsAt = Date.now() + 350;
          countdownCue = { id: randomBytes(16).toString('hex'), startsAt, endsAt: startsAt + COUNTDOWN_CUE_DURATION, context };
          countdownSequence++;
          countdownSources = JSON.stringify(store.state.broadcast?.sourceSlots || null);
          countdownTimer = setTimeout(expireCountdown, countdownCue.endsAt - Date.now());
          publishCountdown();
        }
        ack({ ok: true, revision: store.state.revision });
      } catch (error) {
        if (error.code === 'STALE') socket.emit('state', controlState());
        ack({ ok: false, error: error.message, code: error.code || 'INVALID', revision: store.state.revision });
      }
    });
    socket.on('command', (request, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const beforeScene = store.state.scene;
        store.commit(request.action, request.expectedRevision);
        publishState(beforeScene);
        ack({ ok: true, revision: store.state.revision });
      } catch (error) {
        if (error.code === 'STALE') socket.emit('state', controlState());
        ack({ ok: false, error: error.message, code: error.code || 'INVALID' });
      }
    });
    socket.on('disconnect', notifyStatus);
  });
  overlays.on('connection', socket => {
    socket.emit('state', publicState(store.state)); socket.emit('countdown', countdownMessage()); notifyStatus();
    socket.on('countdown-sync', ack => { if (typeof ack === 'function') ack(countdownMessage()); });
    socket.on('disconnect', notifyStatus);
  });
  scorekeepers.use((socket, next) => validScorekeeperToken(socket.handshake.auth?.token) ? next() : next(new Error(validToken(socket.handshake.auth?.token) || validHostToken(socket.handshake.auth?.token) ? 'FORBIDDEN' : 'PAIRING_REQUIRED')));
  scorekeepers.on('connection', socket => {
    socket.emit('state', scorekeeperState(store.state)); notifyStatus();
    socket.on('command', (request, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (!SCORE_ACTIONS.has(request?.action?.type)) { const error = new Error('Scorekeepers may only enter scores.'); error.code = 'FORBIDDEN'; throw error; }
        store.assertRevision(request.expectedRevision);
        const action = scorekeeperAction(store.state, request), beforeScene = store.state.scene;
        store.commit(action, request.expectedRevision); publishState(beforeScene);
        ack({ ok: true, revision: store.state.revision });
      } catch (error) {
        if (error.code === 'STALE' || error.code === 'CONTEXT_CHANGED') socket.emit('state', scorekeeperState(store.state));
        ack({ ok: false, error: error.message, code: error.code || 'INVALID', revision: store.state.revision });
      }
    });
    socket.on('countdown-command', (request, ack) => {
      if (typeof ack === 'function') ack({ ok: false, code: 'FORBIDDEN', error: 'Only the main control panel may start or cancel a countdown.', revision: store.state.revision });
    });
    socket.on('disconnect', notifyStatus);
  });
  hosts.use((socket, next) => validHostToken(socket.handshake.auth?.token) ? next() : next(new Error(validToken(socket.handshake.auth?.token) || validScorekeeperToken(socket.handshake.auth?.token) ? 'FORBIDDEN' : 'PAIRING_REQUIRED')));
  hosts.on('connection', socket => {
    socket.emit('state', hostState(store.state)); notifyStatus();
    socket.on('command', (request, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (!HOST_ACTIONS.has(request?.action?.type)) { const error = new Error('Hosts may only select songs.'); error.code = 'FORBIDDEN'; throw error; }
        store.assertRevision(request.expectedRevision);
        const action = hostAction(store.state, request), beforeScene = store.state.scene;
        store.commit(action, request.expectedRevision); publishState(beforeScene);
        ack({ ok: true, revision: store.state.revision });
      } catch (error) {
        if (error.code === 'STALE' || error.code === 'CONTEXT_CHANGED') socket.emit('state', hostState(store.state));
        ack({ ok: false, error: error.message, code: error.code || 'INVALID', revision: store.state.revision });
      }
    });
    socket.on('countdown-command', (request, ack) => { if (typeof ack === 'function') ack({ ok: false, code: 'FORBIDDEN', error: 'Only main control may start a countdown.' }); });
    socket.on('disconnect', notifyStatus);
  });
  app.use((err, req, res, next) => res.status(400).json({ error: 'Invalid request.' }));
  let closing = null;
  function close() {
    if (closing) return closing;
    intermissionPlayback.close();
    attempts.close(); intermissionMedia.close(); clearTimeout(countdownTimer); countdownTimer = null; countdownCue = null; countdownSources = null;
    closing = new Promise((resolve, reject) => io.close(() => server.close(() => {
      try { dataLock.release(); resolve(); } catch (error) { reject(error); }
    })));
    return closing;
  }
  intermissionPlayback.sync();
  return { app, server, io, store, pin, scorekeeperPin, hostPin,
    listen(port = 3000, host = '0.0.0.0') {
      if (closing) return Promise.reject(new Error('This broadcast server has closed. Create a new server before listening.'));
      return new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('error', failed); close().then(() => reject(error), () => reject(error)); };
        server.once('error', failed);
        try { server.listen(port, host, () => { server.removeListener('error', failed); resolve(server.address()); }); }
        catch (error) { failed(error); }
      });
    },
    close
  };
}
if (require.main === module) {
  const args=require('node:util').parseArgs({options:{standard:{type:'boolean'},'data-dir':{type:'string'}}}).values;
  const broadcast = createBroadcastServer({...(args.standard?{preset:'standard'}:{}),...(args['data-dir']?{dataDir:path.resolve(args['data-dir'])}:{})});
  broadcast.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0').then(address => {
    console.log(`Phigros broadcast ready on port ${address.port}`);
    console.log(`Control: http://localhost:${address.port}/control/`);
    console.log(`Scorekeeper: http://localhost:${address.port}/scorekeeper/`);
    console.log(`Host: http://localhost:${address.port}/host/`);
    for (const network of Object.values(os.networkInterfaces())) for (const item of network || []) if (item.family === 'IPv4' && !item.internal) {
      console.log(`Main control iPad: http://${item.address}:${address.port}/control/`);
      console.log(`Scorekeeper iPad: http://${item.address}:${address.port}/scorekeeper/`);
      console.log(`Host iPad: http://${item.address}:${address.port}/host/`);
    }
    console.log(`Control pairing code: ${broadcast.pin}`);
    console.log(`Scorekeeper pairing code: ${broadcast.scorekeeperPin}`);
    console.log(`Host pairing code: ${broadcast.hostPin}`);
    console.log('Keep this terminal running. State saves locally after every update.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => broadcast.close().then(() => process.exit()));
}
module.exports = { createBroadcastServer };
