const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const IMAGE_PATH = /^assets\/.+\.(?:png|jpe?g|webp|avif)$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const emptyManifest = () => ({ schemaVersion: 1, images: {}, backgrounds: {} });

function safeImagePath(value, derivative = false) {
  if (typeof value !== 'string' || value.length > 500 || !IMAGE_PATH.test(value) || /[\\%?#\x00-\x1f\x7f]/.test(value)) return false;
  if (value.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return !derivative || value.startsWith('assets/display/');
}

function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function digestFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filename);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Each server owns its cache. Hashing uses bounded asynchronous streams, keeping
// cold-start image verification away from synchronous reads on the event loop.
function createDisplayAssetsReader({ publicDir, manifestPath = path.join(publicDir, 'assets', 'display', 'manifest.json'), concurrency = 3, hashFile = digestFile }) {
  const limit = Math.max(1, Math.min(4, Number.isInteger(concurrency) ? concurrency : 3));
  const cache = new Map(), pending = [];
  let active = 0, inFlight = null;

  function schedule(operation) {
    return new Promise((resolve, reject) => {
      pending.push({ operation, resolve, reject });
      drain();
    });
  }
  function drain() {
    while (active < limit && pending.length) {
      const next = pending.shift();
      active++;
      Promise.resolve().then(next.operation).then(next.resolve, next.reject).finally(() => { active--; drain(); });
    }
  }
  async function fileInfo(filename, assetRoot) {
    const resolved = await fs.promises.realpath(filename);
    if (!inside(assetRoot, resolved)) throw new Error('Asset outside public directory.');
    const stat = await fs.promises.stat(resolved, { bigint: true });
    if (!stat.isFile()) throw new Error('Not an asset file.');
    return { resolved, fingerprint: fingerprint(stat) };
  }
  async function verifiedHash(relative, assetRoot) {
    const filename = path.resolve(publicDir, relative);
    const info = await fileInfo(filename, assetRoot);
    let cached = cache.get(filename);
    if (!cached || cached.resolved !== info.resolved || cached.fingerprint !== info.fingerprint) {
      cached = { ...info };
      cached.promise = schedule(async () => {
        const digest = await hashFile(info.resolved);
        const after = await fileInfo(filename, assetRoot);
        if (after.resolved !== info.resolved || after.fingerprint !== info.fingerprint) throw new Error('Asset changed during verification.');
        return digest;
      });
      cache.set(filename, cached);
      // A replaced manifest must not accumulate an unlimited history of files.
      if (cache.size > 2048) cache.delete(cache.keys().next().value);
    }
    try { return await cached.promise; }
    catch (error) { if (cache.get(filename) === cached) cache.delete(filename); throw error; }
  }
  async function load() {
    const result = emptyManifest();
    let manifest, assetRoot;
    try {
      assetRoot = await fs.promises.realpath(path.join(publicDir, 'assets'));
      const info = await fileInfo(manifestPath, assetRoot);
      const size = (await fs.promises.stat(info.resolved)).size;
      if (size > 2 * 1024 * 1024) return result;
      manifest = JSON.parse(await fs.promises.readFile(info.resolved, 'utf8'));
    } catch { return result; }
    if (!manifest || manifest.schemaVersion !== 1) return result;
    const entries = [];
    for (const group of ['images', 'backgrounds']) {
      const values = manifest[group];
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      for (const [original, derivative] of Object.entries(values).slice(0, 1000)) {
        if (!safeImagePath(original) || !derivative || typeof derivative !== 'object' || Array.isArray(derivative) ||
          !safeImagePath(derivative.path, true) || !SHA256.test(derivative.sourceSha256) || !SHA256.test(derivative.sha256)) continue;
        entries.push((async () => {
          try {
            const [sourceHash, displayHash] = await Promise.all([
              verifiedHash(original, assetRoot), verifiedHash(derivative.path, assetRoot)
            ]);
            if (sourceHash !== derivative.sourceSha256 || displayHash !== derivative.sha256) return;
            const value = { path: derivative.path };
            for (const dimension of ['width', 'height']) if (Number.isInteger(derivative[dimension]) && derivative[dimension] > 0 && derivative[dimension] <= 16384) value[dimension] = derivative[dimension];
            result[group][original] = value;
          } catch { /* Missing, replaced or unreadable assets use their originals. */ }
        })());
      }
    }
    await Promise.all(entries);
    return result;
  }
  return {
    read() {
      if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
      return inFlight;
    }
  };
}

module.exports = { createDisplayAssetsReader };
