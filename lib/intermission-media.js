const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_BYTES = 250 * 1024 * 1024;
const FILE_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(mp4|webm)$/i;
function failure(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function createIntermissionMedia(dataDir, { maxBytes = MAX_BYTES, assertWritable = () => {} } = {}) {
  const directory = path.resolve(dataDir, 'media', 'intermission');
  let closed = false;
  const uploads = new Set();
  return {
    directory,
    close() { closed = true; for (const source of uploads) source.destroy(failure('Server is closing.', 503)); },
    async upload(request) {
      if (closed) throw failure('Server is closing.', 503);
      const type = (request.headers['content-type'] || '').toLowerCase();
      const extension = ({ 'video/mp4': 'mp4', 'video/webm': 'webm' })[type];
      if (!extension || !['identity', undefined].includes(request.headers['content-encoding']))
        throw failure('請上傳未壓縮的 MP4 或 WebM 影片。', 415);
      if (Number(request.headers['content-length']) > maxBytes) throw failure('影片上限為 250 MB。', 413);
      assertWritable();
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      if (closed) throw failure('Server is closing.', 503);
      const name = `${randomUUID()}.${extension}`, temporary = path.join(directory, name + '.tmp');
      let size = 0, header = Buffer.alloc(0);
      const source = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) return callback(failure('影片上限為 250 MB。', 413));
        if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
        callback(null, chunk);
      } });
      const aborted = () => source.destroy(failure('Upload interrupted.'));
      uploads.add(source);
      request.once('aborted', aborted); request.once('error', aborted);
      try {
        // Keep IncomingMessage outside pipeline so a size error can still return
        // a useful HTTP response instead of destroying the response socket.
        const saved = pipeline(source, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true }));
        request.pipe(source);
        await saved;
        const recognised = extension === 'mp4' ? header.length >= 12 && header.toString('ascii', 4, 8) === 'ftyp'
          : header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        if (!recognised) throw failure('影片格式與檔案內容不符，請使用 MP4 或 WebM。', 415);
        if (closed) throw failure('Server is closing.', 503);
        assertWritable();
        await fs.promises.rename(temporary, path.join(directory, name));
        return { videoPath: `media/intermission/${name}`, bytes: size };
      } finally {
        request.unpipe(source); request.removeListener('aborted', aborted); request.removeListener('error', aborted);
        uploads.delete(source);
        if (!request.complete) request.resume();
        await fs.promises.rm(temporary, { force: true });
      }
    }
  };
}
module.exports = { MAX_BYTES, FILE_NAME, createIntermissionMedia };
