const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(require.resolve('@fontsource/saira/package.json'));
const dest = path.join(__dirname, '../public/assets/fonts');
fs.mkdirSync(dest, { recursive: true });
for (const weight of [400, 500, 600, 700]) {
  const file = `saira-latin-${weight}-normal.woff2`;
  fs.copyFileSync(path.join(root, 'files', file), path.join(dest, file));
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dest, 'Saira-LICENSE.txt'));
