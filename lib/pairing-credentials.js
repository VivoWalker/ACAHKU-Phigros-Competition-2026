const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomInt } = require('node:crypto');

function atomicPrivateWrite(file, value) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function configuredPin(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} pairing code must be nonempty text.`);
  return value;
}

function loadPairingCredentials(dataDir, options = {}) {
  const mainFile = path.join(dataDir, '.control-pin');
  const suppliedMain = configuredPin(options.pin !== undefined ? options.pin : process.env.CONTROL_PIN, 'Main control');
  let pin = suppliedMain;
  if (pin === undefined) {
    if (fs.existsSync(mainFile)) {
      pin = fs.readFileSync(mainFile, 'utf8').trim();
      if (!pin) throw new Error('The saved main-control pairing code is empty. Restore .control-pin or set CONTROL_PIN before starting the server.');
    } else {
      pin = String(randomInt(100000, 1000000));
      atomicPrivateWrite(mainFile, pin + '\n');
    }
  }

  const scorerFile = path.join(dataDir, '.scorekeeper-pin');
  const suppliedScorer = configuredPin(options.scorekeeperPin !== undefined ? options.scorekeeperPin : process.env.SCOREKEEPER_PIN, 'Scorekeeper');
  let scorekeeperPin = suppliedScorer;
  if (suppliedScorer === pin) throw new Error('Control and scorekeeper pairing codes must be different.');
  if (scorekeeperPin === undefined && fs.existsSync(scorerFile)) scorekeeperPin = fs.readFileSync(scorerFile, 'utf8').trim();
  if (!scorekeeperPin || scorekeeperPin === pin) {
    do { scorekeeperPin = String(randomInt(100000, 1000000)); } while (scorekeeperPin === pin);
    atomicPrivateWrite(scorerFile, scorekeeperPin + '\n');
  }

  const keyFile = path.join(dataDir, '.session-key');
  if (!fs.existsSync(keyFile)) atomicPrivateWrite(keyFile, randomBytes(32));
  const sessionKey = fs.readFileSync(keyFile);
  if (sessionKey.length !== 32) throw new Error('The saved session key is damaged. Restore the 32-byte .session-key before starting the server.');
  return { pin, scorekeeperPin, sessionKey };
}

module.exports = { loadPairingCredentials };
