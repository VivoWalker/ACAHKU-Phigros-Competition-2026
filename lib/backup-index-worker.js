const { parentPort, workerData } = require('node:worker_threads');
const { scanBackups } = require('./backup-index');

// Disk reads, JSON parsing and full tournament validation stay outside the server thread.
parentPort.postMessage(scanBackups(workerData.dir, new Map(workerData.cache)));
