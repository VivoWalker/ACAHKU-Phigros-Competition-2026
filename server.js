const express = require('express');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, timingSafeEqual, createHmac } = require('node:crypto');
const { Server } = require('socket.io');
const { StateStore } = require('./lib/store');
const { publicState, resultCorrectionImpact } = require('./lib/tournament');
const { getBranding } = require('./lib/branding');
const { sourceStatus } = require('./lib/broadcast-check');
const obsAdapter = require('./lib/obs-adapter');
const { context: countdownContext } = require('./public/js/countdown');
const { scorekeeperState, scorekeeperAction, SCORE_ACTIONS } = require('./lib/scorekeeper');
const { loadPairingCredentials } = require('./lib/pairing-credentials');
function createBroadcastServer(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const store = new StateStore(dataDir);
  const { pin, scorekeeperPin, sessionKey } = loadPairingCredentials(dataDir, options);
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
  const attempts = new Map();
  const app = express(); const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 100000, cors: false });
  app.disable('x-powered-by'); app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); next(); });
  const controls = io.of('/control'); const overlays = io.of('/overlay'); const scorekeepers = io.of('/scorekeeper');
  // A start cue belongs to the live connection, never to a saved match or backup.
  let countdownCue = null, countdownTimer = null, countdownSources = null, countdownSequence = 0;
  function clearCountdown() {
    clearTimeout(countdownTimer); countdownTimer = null;
    if (!countdownCue) return;
    countdownCue = null; countdownSources = null; countdownSequence++; publishCountdown();
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
  function connectionStatus() { return { overlays: overlays.sockets.size, controls: controls.sockets.size, scorekeepers: scorekeepers.sockets.size, obs: 'not-configured', revision: store.state.revision }; }
  function notifyStatus() { controls.emit('connections', connectionStatus()); }
  function publishState(beforeScene) {
    cancelChangedCountdown();
    controls.emit('state', controlState()); overlays.emit('state', publicState(store.state)); scorekeepers.emit('state', scorekeeperState(store.state));
    if (beforeScene !== store.state.scene) obsAdapter.emit('sceneChanged', store.state.scene);
    notifyStatus();
  }
  function requestFailure(res, error) { return res.status(error.code === 'STALE' ? 409 : 400).json({ error: error.message, code: error.code || 'INVALID', revision: store.state.revision }); }
  function authenticated(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (validScorekeeperToken(token)) return res.status(403).json({ error: 'This operation requires the main control panel.', code: 'FORBIDDEN' });
    if (!validToken(token)) return res.status(401).json({ error: 'Control pairing required.' }); next();
  }
  function scorekeeperAuthenticated(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (validToken(token)) return res.status(403).json({ error: 'Use the scorekeeper pairing code for this panel.', code: 'FORBIDDEN' });
    if (!validScorekeeperToken(token)) return res.status(401).json({ error: 'Scorekeeper pairing required.' }); next();
  }
  app.get('/api/health', (req, res) => res.json({ ok: true, revision: store.state.revision }));
  app.get('/api/state', (req, res) => res.json(publicState(store.state)));
  app.get('/api/branding', (req, res) => res.json(getBranding()));
  app.post('/api/session', (req, res) => {
    const role = req.body?.role === undefined ? 'control' : req.body.role;
    if (!['control', 'scorekeeper'].includes(role)) return res.status(400).json({ error: 'Unknown panel role.', code: 'INVALID' });
    const key = role + ':' + req.ip; const now = Date.now(); const failed = (attempts.get(key) || []).filter(t => now - t < 60000);
    if (failed.length >= 10) return res.status(429).json({ error: 'Too many pairing attempts. Wait one minute.' });
    const expectedPin = role === 'control' ? pin : scorekeeperPin;
    const candidate = String(req.body?.pin || '');
    if (Buffer.byteLength(candidate) !== Buffer.byteLength(expectedPin) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedPin))) {
      failed.push(now); attempts.set(key, failed); return res.status(401).json({ error: 'Incorrect pairing code.' });
    }
    attempts.delete(key); const nonce = randomBytes(32).toString('hex');
    res.json({ token: role === 'control' ? nonce + '.' + sign(nonce) : 'scorekeeper.' + nonce + '.' + scorekeeperSign(nonce), role });
  });
  app.get('/api/control-state', authenticated, (req, res) => res.json(controlState()));
  app.get('/api/scorekeeper-state', scorekeeperAuthenticated, (req, res) => res.json(scorekeeperState(store.state)));
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
  app.use(express.static(path.join(__dirname, 'public')));
  controls.use((socket, next) => validToken(socket.handshake.auth?.token) ? next() : next(new Error(validScorekeeperToken(socket.handshake.auth?.token) ? 'FORBIDDEN' : 'PAIRING_REQUIRED')));
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
          countdownCue = { id: randomBytes(16).toString('hex'), startsAt, endsAt: startsAt + 3950, context };
          countdownSequence++;
          countdownSources = JSON.stringify(store.state.broadcast?.sourceSlots || null);
          countdownTimer = setTimeout(clearCountdown, countdownCue.endsAt - Date.now());
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
  scorekeepers.use((socket, next) => validScorekeeperToken(socket.handshake.auth?.token) ? next() : next(new Error(validToken(socket.handshake.auth?.token) ? 'FORBIDDEN' : 'PAIRING_REQUIRED')));
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
  app.use((err, req, res, next) => res.status(400).json({ error: 'Invalid request.' }));
  return { app, server, io, store, pin, scorekeeperPin,
    listen(port = 3000, host = '0.0.0.0') { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); }); }); },
    close() { clearTimeout(countdownTimer); countdownTimer = null; countdownCue = null; countdownSources = null; return new Promise(resolve => io.close(() => server.close(() => resolve()))); }
  };
}
if (require.main === module) {
  const broadcast = createBroadcastServer();
  broadcast.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0').then(address => {
    console.log(`ACAHKU broadcast ready on port ${address.port}`);
    console.log(`Control: http://localhost:${address.port}/control/`);
    console.log(`Scorekeeper: http://localhost:${address.port}/scorekeeper/`);
    for (const network of Object.values(os.networkInterfaces())) for (const item of network || []) if (item.family === 'IPv4' && !item.internal) {
      console.log(`Main control iPad: http://${item.address}:${address.port}/control/`);
      console.log(`Scorekeeper iPad: http://${item.address}:${address.port}/scorekeeper/`);
    }
    console.log(`Control pairing code: ${broadcast.pin}`);
    console.log(`Scorekeeper pairing code: ${broadcast.scorekeeperPin}`);
    console.log('Keep this terminal running. State saves locally after every update.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => broadcast.close().then(() => process.exit()));
}
module.exports = { createBroadcastServer };
