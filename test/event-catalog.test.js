const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const config = require('../public/js/competition-config');

const root = path.join(__dirname, '..');
const resolveSongs = ids => ids.map(id => config.library().find(song => song.id === id));
const charts = songs => songs.map(({ title, difficulty, level }) => [title, difficulty, level]);

test('official chart list has six qualifier charts, 42 DE charts and two fixed GF charts', () => {
  const library = config.library();
  assert.equal(library.length, 50);
  assert.equal(new Set(library.map(song => song.id)).size, 50);
  assert.deepEqual(charts(resolveSongs(config.QUALIFIER_SONG_IDS.A)), [
    ['Secret Illumination', 'IN', 14], ['On And On!!', 'IN', 15], ['白と黒のバケモノ', 'IN', 15]
  ]);
  assert.deepEqual(charts(resolveSongs(config.QUALIFIER_SONG_IDS.B)), [
    ['INFiNiTE ENERZY -Overdoze-', 'IN', 14], ['Stasis', 'IN', 15], ['Re：End of a Dream', 'IN', 15]
  ]);
  assert.deepEqual(charts(resolveSongs(config.DOUBLE_ELIMINATION_SONG_IDS)), [
    ['Cthugha', 'AT', 16], ["Rrhar'il", 'IN', 16],
    ['Retribution ~ Cycle of Redemption ~', 'IN', 16], ['Retribution', 'IN', 16],
    ['Chronos Collapse - La Campanella', 'IN', 16], ['QZKago Requiem', 'IN', 16],
    ['Fractured Angel', 'IN', 16], ['Ad astra per aspera', 'IN', 16],
    ['Ark', 'AT', 16], ['彩', 'IN', 16], ['KIZUNA Resolution', 'IN', 16], ['CROSS†SOUL', 'IN', 16],
    ['Indelible Scar', 'AT', 16], ['Lyrith -迷宮リリス-', 'AT', 16], ['Verrückt', 'IN', 16], ['Stardust:RAY', 'IN', 16],
    ['Avataar ~Reincarnation of Kalpa~', 'AT', 16], ['volcanic', 'AT', 16], ['ATHAZA', 'AT', 16],
    ['PRAGMATISM -RESURRECTION-', 'AT', 16], ['夢の降る日に', 'IN', 16], ['Gungnir Fracture', 'IN', 16],
    ['Cuvism³', 'AT', 16], ['Diamond Dust', 'AT', 16], ['Spasmodic', 'AT', 16], ['BANGING STRIKE', 'AT', 16],
    ['sølips', 'AT', 16], ['Entrance to the Chaos', 'IN', 16], ['Exoplanetary Mirage', 'IN', 16],
    ['INFiNiTE ENERZY -Overdoze-', 'AT', 16], ['Der Richter', 'AT', 16], ['Archidoxen', 'AT', 16],
    ['Re：End of a Dream', 'AT', 16], ['玩具狂奏曲 -終焉-', 'AT', 17], ['Hydra', 'AT', 17],
    ['AbsoluTe disoRdeR', 'AT', 17], ['DESTRUCTION 3,2,1', 'AT', 17], ['+ERABY+E CONNEC+10N', 'AT', 17],
    ['祈 -我ら神祖と共に歩む者なり-', 'AT', 17], ['Igallta', 'AT', 17], ['Distorted Fate', 'AT', 17], ['Der Schneid', 'AT', 17]
  ]);
  assert.deepEqual(charts(resolveSongs(config.FINAL_SONG_IDS)), [['Desultory Signals', 'IN', 17], ['Petrichor', 'AT', 17]]);
  assert.deepEqual(library.filter(song => song.eligible).map(song => song.id), [...config.DOUBLE_ELIMINATION_SONG_IDS]);
  for (const song of library) assert.equal(Number.isInteger(song.level), true);
  assert.equal(library.some(song => song.title === '[NWAD]'), false);
});

test('all official charts use an existing local jacket and recorded composer', () => {
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/song/song-list-2026/manifest.json'), 'utf8'));
  const finals = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/song/grand-final-2026/manifest.json'), 'utf8'));
  const assets = new Map([...previous.songs, ...finals.songs].map(song => [song.art, song]));
  for (const song of config.library()) {
    assert.match(song.art, /^assets\/[a-zA-Z0-9_./-]+\.png$/);
    assert.equal(song.art.includes('..'), false);
    assert.equal(fs.statSync(path.join(root, 'public', song.art)).isFile(), true);
    assert.ok(assets.has(song.art), song.title);
    assert.equal(song.artist, assets.get(song.art).artist);
  }
  for (const title of ['INFiNiTE ENERZY -Overdoze-', 'Re：End of a Dream']) {
    const pair = config.library().filter(song => song.title === title);
    assert.equal(pair.length, 2);
    assert.deepEqual(pair.map(song => song.difficulty), ['IN', 'AT']);
    assert.notEqual(pair[0].id, pair[1].id);
    assert.equal(pair[0].art, pair[1].art);
  }
});

test('GF original files match source catalog SHA-256, dimensions and PNG signature', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/song/grand-final-2026/manifest.json'), 'utf8'));
  for (const song of manifest.songs) {
    const bytes = fs.readFileSync(path.join(root, 'public', song.art));
    assert.equal(bytes.length, song.sizeBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), song.sha256);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.readUInt32BE(16), 2048);
    assert.equal(bytes.readUInt32BE(20), 1080);
  }
});

test('browser and Node receive equivalent configuration without sharing mutable state', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/competition-config.js'), 'utf8'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.CompetitionConfig.library())), config.library());
  const first = config.library();
  first[0].title = 'Changed'; first.pop();
  assert.equal(config.library().length, 50);
  assert.equal(config.library()[0].title, 'Secret Illumination');
  assert.equal(Object.isFrozen(config.LIBRARY[0]), true);
  assert.equal(Object.isFrozen(config.QUALIFIER_SONG_IDS.A), true);
});
