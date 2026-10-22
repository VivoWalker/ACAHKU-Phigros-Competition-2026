'use strict';

// Package audits do not check the Node.js runtime. Keep this security floor
// aligned with package.json, .node-version and the CI baseline.
const MIN_NODE_VERSION = '24.22.1';
const SUPPORTED_NODE_RANGE = '>=24.22.1 <25';

function isSupportedNode(version) {
  if (typeof version !== 'string') return false;
  // Official stable releases only: an RC or a custom build is not evidence
  // that the required stable release's security fixes are present.
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match[0] !== version) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const [major, minor, patch] = parts;
  return major === 24 && (minor > 22 || minor === 22 && patch >= 1);
}

function assertSupportedNode(version = process.versions.node) {
  if (isSupportedNode(version)) return;
  const detected = typeof version === 'string' ? (version.startsWith('v') ? version : 'v' + version) : 'unknown';
  const failure = new Error(`Unsupported Node.js ${detected}. This project requires Node.js ${SUPPORTED_NODE_RANGE} (24 LTS). Upgrade Node.js before installing dependencies or starting the server. npm audit does not check the Node.js runtime.`);
  failure.code = 'UNSUPPORTED_NODE_VERSION';
  throw failure;
}

if (require.main === module) {
  try { assertSupportedNode(); }
  catch (failure) { console.error(failure.message); process.exitCode = 1; }
}

module.exports = { MIN_NODE_VERSION, SUPPORTED_NODE_RANGE, isSupportedNode, assertSupportedNode };
