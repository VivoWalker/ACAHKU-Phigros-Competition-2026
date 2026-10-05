const fs = require('node:fs');
const path = require('node:path');

const eventAssetsDir = path.join(__dirname, '..', 'public', 'assets', 'event');
const logoCandidates = ['phigros-logo.webp', 'phigros-logo.png', 'Site-logo.webp', 'Site-logo.png'];
const visualCandidates = ['key-visual.png', 'key-visual.webp', 'key-visual.jpg', 'key-visual.jpeg', 'PhigrosComp Poster (A5 size).jpg'];
const socLogoCandidates = ['soc-logo.png', 'soc-logo.webp'];
const kiramekiLogoCandidates = ['kirameki-logo.png', 'kirameki-logo.webp'];

function findAsset(directory, candidates) {
  for (const filename of candidates) {
    try {
      if (fs.statSync(path.join(directory, filename)).isFile()) return `assets/event/${filename}`;
    } catch {
      // Missing or unreadable files cannot be used by the browser source.
    }
  }
  return null;
}

function getBranding(directory = eventAssetsDir) {
  return {
    logo: findAsset(directory, logoCandidates),
    visual: findAsset(directory, visualCandidates),
    socLogo: findAsset(directory, socLogoCandidates),
    kiramekiLogo: findAsset(directory, kiramekiLogoCandidates)
  };
}

module.exports = { getBranding };
