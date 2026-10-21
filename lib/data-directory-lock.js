const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const CLAIM = /^([1-9]\d*)-[a-f0-9]{32}\.lock$/;

function lockError(message) {
  const error = new Error(message);
  error.code = 'DATA_DIRECTORY_IN_USE';
  return error;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function acquireDataDirectoryLock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  // Resolve directory aliases so two paths to the same event share one registry.
  const root = fs.realpathSync(directory), registry = path.join(root, '.server-lock');
  fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
  const name = `${process.pid}-${randomBytes(16).toString('hex')}.lock`, claim = path.join(registry, name);
  fs.closeSync(fs.openSync(claim, 'wx', 0o600));
  let released = false;
  const onExit = () => { try { release(); } catch { /* A dead process's claim can be removed on restart. */ } };
  function release() {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    try { fs.unlinkSync(claim); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    // Every contender publishes its own claim before checking. Two concurrent
    // contenders can both decline, but cannot both overlook one another and win.
    // Never unlink a shared lock path: racing stale-lock cleanup could otherwise
    // remove a newly acquired live lock. Each owner only removes its unique file.
    for (const entry of fs.readdirSync(registry)) {
      if (entry === name) continue;
      const match = CLAIM.exec(entry);
      if (!match) throw lockError('The event data directory has an unrecognised server lock. Stop other broadcast servers and inspect data/.server-lock before restarting.');
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || processExists(pid))
        throw lockError('Another broadcast server is using this event data directory. Stop that server before starting another, even on a different port.');
      // This filename belongs only to the now-dead process; a new owner uses a
      // different random name. PID reuse fails closed rather than stealing it.
      try { fs.unlinkSync(path.join(registry, entry)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    process.once('exit', onExit);
    return {
      release,
      assertHeld() {
        if (released || !fs.existsSync(claim)) throw lockError('This broadcast server no longer owns the event data directory. Restart it before saving.');
      }
    };
  } catch (error) { release(); throw error; }
}

module.exports = { acquireDataDirectoryLock };
