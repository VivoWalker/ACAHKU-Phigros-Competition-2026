const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomInt, timingSafeEqual, createHmac } = require('node:crypto');
const { Server } = require('socket.io');
const { StateStore } = require('./lib/store');
const { publicState } = require('./lib/tournament');
const { getBranding } = require('./lib/branding');
const obsAdapter = require('./lib/obs-adapter');
function createBroadcastServer(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const store = new StateStore(dataDir);
  const pinFile = path.join(dataDir, '.control-pin');
  const pin = options.pin || process.env.CONTROL_PIN || (fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8').trim() : String(randomInt(100000, 1000000)));
  if (!options.pin && !process.env.CONTROL_PIN && !fs.existsSync(pinFile)) fs.writeFileSync(pinFile, pin + '\n', { mode: 0o600 });
  const keyFile = path.join(dataDir, '.session-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const sessionKey = fs.readFileSync(keyFile);
  const sign = nonce => createHmac('sha256', sessionKey).update(nonce + ':' + pin).digest('hex');
  const validToken = token => {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return false;
    const [nonce, signature] = token.split('.');
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(nonce), 'hex'));
  };
  const attempts = new Map();
  const app = express(); const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 100000, cors: false });
  app.disable('x-powered-by'); app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); next(); });
  const controls = io.of('/control'); const overlays = io.of('/overlay');
  function connectionStatus() { return { overlays: overlays.sockets.size, controls: controls.sockets.size, obs: 'not-configured', revision: store.state.revision }; }
  function notifyStatus() { controls.emit('connections', connectionStatus()); }
  function authenticated(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!validToken(token)) return res.status(401).json({ error: 'Control pairing required.' }); next();
  }
  app.get('/api/health', (req, res) => res.json({ ok: true, revision: store.state.revision }));
  app.get('/api/state', (req, res) => res.json(publicState(store.state)));
  app.get('/api/branding', (req, res) => res.json(getBranding()));
  app.post('/api/session', (req, res) => {
    const key = req.ip; const now = Date.now(); const failed = (attempts.get(key) || []).filter(t => now - t < 60000);
    if (failed.length >= 10) return res.status(429).json({ error: 'Too many pairing attempts. Wait one minute.' });
    const candidate = String(req.body?.pin || '');
    if (Buffer.byteLength(candidate) !== Buffer.byteLength(pin) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(pin))) {
      failed.push(now); attempts.set(key, failed); return res.status(401).json({ error: 'Incorrect pairing code.' });
    }
    attempts.delete(key); const nonce = randomBytes(32).toString('hex'); res.json({ token: nonce + '.' + sign(nonce) });
  });
  app.get('/api/control-state', authenticated, (req, res) => res.json(store.state));
  app.get('/api/export', authenticated, (req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="match-state-backup.json"'); res.json(store.state); });
  app.get('/', (req, res) => res.redirect('/control/'));
  app.use(express.static(path.join(__dirname, 'public')));
  controls.use((socket, next) => validToken(socket.handshake.auth?.token) ? next() : next(new Error('PAIRING_REQUIRED')));
  controls.on('connection', socket => {
    socket.emit('state', store.state); notifyStatus();
    socket.on('command', (request, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const beforeScene = store.state.scene;
        store.commit(request.action, request.expectedRevision);
        controls.emit('state', store.state); overlays.emit('state', publicState(store.state));
        if (beforeScene !== store.state.scene) obsAdapter.emit('sceneChanged', store.state.scene);
        ack({ ok: true, revision: store.state.revision }); notifyStatus();
      } catch (error) {
        if (error.code === 'STALE') socket.emit('state', store.state);
        ack({ ok: false, error: error.message, code: error.code || 'INVALID' });
      }
    });
    socket.on('disconnect', notifyStatus);
  });
  overlays.on('connection', socket => { socket.emit('state', publicState(store.state)); notifyStatus(); socket.on('disconnect', notifyStatus); });
  app.use((err, req, res, next) => res.status(400).json({ error: 'Invalid request.' }));
  return { app, server, io, store, pin,
    listen(port = 3000, host = '0.0.0.0') { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); }); }); },
    close() { return new Promise(resolve => io.close(() => server.close(() => resolve()))); }
  };
}
if (require.main === module) {
  const broadcast = createBroadcastServer();
  broadcast.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0').then(address => {
    console.log(`ACAHKU broadcast ready on port ${address.port}`);
    console.log(`Control: http://localhost:${address.port}/control/`);
    for (const network of Object.values(os.networkInterfaces())) for (const item of network || []) if (item.family === 'IPv4' && !item.internal) console.log(`iPad: http://${item.address}:${address.port}/control/`);
    console.log(`Control pairing code: ${broadcast.pin}`);
    console.log('Keep this terminal running. State saves locally after every update.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => broadcast.close().then(() => process.exit()));
}
module.exports = { createBroadcastServer };
