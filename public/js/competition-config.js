/* Official ACAHKU Phigros Competition 2026 chart list.
 * Levels are truncated integers from the organiser's published list.
 * Jackets and composers are documented in the adjacent asset manifests.
 * Qualifier/GF charts stay outside the Double Elimination random pool.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompetitionConfig = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'competition-2026-20261014';
  const LIBRARY = Object.freeze(
[
  {
    "id": "competition-2026-q1-01",
    "title": "Secret Illumination",
    "artist": "Yooh",
    "difficulty": "IN",
    "level": 14,
    "art": "assets/song/song-list-2026/01-secret-illumination.png",
    "eligible": false
  },
  {
    "id": "competition-2026-q1-02",
    "title": "On And On!!",
    "artist": "ETIA. feat. Jenga",
    "difficulty": "IN",
    "level": 15,
    "art": "assets/song/song-list-2026/02-on-and-on.png",
    "eligible": false
  },
  {
    "id": "competition-2026-q1-03",
    "title": "白と黒のバケモノ",
    "artist": "テヅカ",
    "difficulty": "IN",
    "level": 15,
    "art": "assets/song/song-list-2026/03-song.png",
    "eligible": false
  },
  {
    "id": "competition-2026-q2-01",
    "title": "INFiNiTE ENERZY -Overdoze-",
    "artist": "Reku Mochizuki",
    "difficulty": "IN",
    "level": 14,
    "art": "assets/song/song-list-2026/04-infinite-enerzy-overdoze.png",
    "eligible": false
  },
  {
    "id": "competition-2026-q2-02",
    "title": "Stasis",
    "artist": "Maozon",
    "difficulty": "IN",
    "level": 15,
    "art": "assets/song/song-list-2026/05-stasis.png",
    "eligible": false
  },
  {
    "id": "competition-2026-q2-03",
    "title": "Re：End of a Dream",
    "artist": "uma vs. モリモリあつし",
    "difficulty": "IN",
    "level": 15,
    "art": "assets/song/song-list-2026/06-re-end-of-a-dream.png",
    "eligible": false
  },
  {
    "id": "competition-2026-de-01",
    "title": "Cthugha",
    "artist": "USAO",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/23-cthugha.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-02",
    "title": "Rrhar'il",
    "artist": "Team Grimoire",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/26-rrhar-il.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-03",
    "title": "Retribution ~ Cycle of Redemption ~",
    "artist": "Ardolf vs. Daily天利",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/28-retribution-cycle-of-redemption.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-04",
    "title": "Retribution",
    "artist": "nm-y & Kry.exe",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/29-retribution.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-05",
    "title": "Chronos Collapse - La Campanella",
    "artist": "SunsetRay",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/30-chronos-collapse-la-campanella.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-06",
    "title": "QZKago Requiem",
    "artist": "t+pazolite",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/33-qzkago-requiem.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-07",
    "title": "Fractured Angel",
    "artist": "DJ Raisei",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/34-fractured-angel.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-08",
    "title": "Ad astra per aspera",
    "artist": "Rabbit House",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/37-ad-astra-per-aspera.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-09",
    "title": "Ark",
    "artist": "kanoryo",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/10-ark.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-10",
    "title": "彩",
    "artist": "MisoilePunch♪",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/38-song.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-11",
    "title": "KIZUNA Resolution",
    "artist": "TAG",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/39-kizuna-resolution.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-12",
    "title": "CROSS†SOUL",
    "artist": "HyuN feat. Syepias",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/41-crosssoul.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-13",
    "title": "Indelible Scar",
    "artist": "Noah",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/12-indelible-scar.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-14",
    "title": "Lyrith -迷宮リリス-",
    "artist": "ユメミド",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/27-lyrith.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-15",
    "title": "Verrückt",
    "artist": "Raimukun",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/42-verruckt.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-16",
    "title": "Stardust:RAY",
    "artist": "kanone vs. BlackY",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/43-stardust-ray.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-17",
    "title": "Avataar ~Reincarnation of Kalpa~",
    "artist": "Scarlette a.k.a CrYmson",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/07-avataar-reincarnation-of-kalpa.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-18",
    "title": "volcanic",
    "artist": "DETRO a.k.a. ルゼ",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/09-volcanic.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-19",
    "title": "ATHAZA",
    "artist": "LeaF",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/18-athaza.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-20",
    "title": "PRAGMATISM -RESURRECTION-",
    "artist": "Laur",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/20-pragmatism-resurrection.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-21",
    "title": "夢の降る日に",
    "artist": "seatrus",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/44-song.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-22",
    "title": "Gungnir Fracture",
    "artist": "Kry.exe",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/45-gungnir-fracture.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-23",
    "title": "Cuvism³",
    "artist": "Fl00t vs Halv",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/08-cuvism3.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-24",
    "title": "Diamond Dust",
    "artist": "Masahiro “Godspeed” Aoki",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/11-diamond-dust.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-25",
    "title": "Spasmodic",
    "artist": "姜米條☆颶風 ~ ♫元力上人♫",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/14-spasmodic.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-26",
    "title": "BANGING STRIKE",
    "artist": "Dew Pleiades",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/19-banging-strike.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-27",
    "title": "sølips",
    "artist": "rintaro soma",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/21-solips.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-28",
    "title": "Entrance to the Chaos",
    "artist": "打打だいず vs. siromaru",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/46-entrance-to-the-chaos.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-29",
    "title": "Exoplanetary Mirage",
    "artist": "Camellia",
    "difficulty": "IN",
    "level": 16,
    "art": "assets/song/song-list-2026/47-exoplanetary-mirage.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-30",
    "title": "INFiNiTE ENERZY -Overdoze-",
    "artist": "Reku Mochizuki",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/04-infinite-enerzy-overdoze.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-31",
    "title": "Der Richter",
    "artist": "Ωμεγα",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/15-der-richter.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-32",
    "title": "Archidoxen",
    "artist": "Se_IRA",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/16-archidoxen.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-33",
    "title": "Re：End of a Dream",
    "artist": "uma vs. モリモリあつし",
    "difficulty": "AT",
    "level": 16,
    "art": "assets/song/song-list-2026/06-re-end-of-a-dream.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-34",
    "title": "玩具狂奏曲 -終焉-",
    "artist": "きくお",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/22-song.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-35",
    "title": "Hydra",
    "artist": "James Landino X Akira Complex",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/13-hydra.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-36",
    "title": "AbsoluTe disoRdeR",
    "artist": "Acute Disarray",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/35-absolute-disorder.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-37",
    "title": "DESTRUCTION 3,2,1",
    "artist": "Normal1zer vs. Broken Nerdz",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/31-destruction-3-2-1.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-38",
    "title": "+ERABY+E CONNEC+10N",
    "artist": "かめりあ",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/36-eraby-e-connec-10n.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-39",
    "title": "祈 -我ら神祖と共に歩む者なり-",
    "artist": "光吉猛修 VS 穴山大輔 VS Kai VS 水野健治 VS 大国奏音",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/40-song.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-40",
    "title": "Igallta",
    "artist": "Se-U-Ra",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/25-igallta.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-41",
    "title": "Distorted Fate",
    "artist": "Sakuzyo",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/32-distorted-fate.png",
    "eligible": true
  },
  {
    "id": "competition-2026-de-42",
    "title": "Der Schneid",
    "artist": "Ωμεγα",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/song-list-2026/24-der-schneid.png",
    "eligible": true
  },
  {
    "id": "competition-2026-gf-01",
    "title": "Desultory Signals",
    "artist": "technoplanet",
    "difficulty": "IN",
    "level": 17,
    "art": "assets/song/grand-final-2026/desultory-signals.png",
    "eligible": false
  },
  {
    "id": "competition-2026-gf-02",
    "title": "Petrichor",
    "artist": "void (Mournfinale)",
    "difficulty": "AT",
    "level": 17,
    "art": "assets/song/grand-final-2026/petrichor.png",
    "eligible": false
  }
]
    .map(song => Object.freeze(song)));
  const QUALIFIER_SONG_IDS = Object.freeze({
    A: Object.freeze(["competition-2026-q1-01", "competition-2026-q1-02", "competition-2026-q1-03"]),
    B: Object.freeze(["competition-2026-q2-01", "competition-2026-q2-02", "competition-2026-q2-03"])
  });
  const DOUBLE_ELIMINATION_SONG_IDS = Object.freeze(["competition-2026-de-01", "competition-2026-de-02", "competition-2026-de-03", "competition-2026-de-04", "competition-2026-de-05", "competition-2026-de-06", "competition-2026-de-07", "competition-2026-de-08", "competition-2026-de-09", "competition-2026-de-10", "competition-2026-de-11", "competition-2026-de-12", "competition-2026-de-13", "competition-2026-de-14", "competition-2026-de-15", "competition-2026-de-16", "competition-2026-de-17", "competition-2026-de-18", "competition-2026-de-19", "competition-2026-de-20", "competition-2026-de-21", "competition-2026-de-22", "competition-2026-de-23", "competition-2026-de-24", "competition-2026-de-25", "competition-2026-de-26", "competition-2026-de-27", "competition-2026-de-28", "competition-2026-de-29", "competition-2026-de-30", "competition-2026-de-31", "competition-2026-de-32", "competition-2026-de-33", "competition-2026-de-34", "competition-2026-de-35", "competition-2026-de-36", "competition-2026-de-37", "competition-2026-de-38", "competition-2026-de-39", "competition-2026-de-40", "competition-2026-de-41", "competition-2026-de-42"]);
  const FINAL_SONG_IDS = Object.freeze(["competition-2026-gf-01", "competition-2026-gf-02"]);
  function library() { return LIBRARY.map(song => ({ ...song })); }
  return Object.freeze({ VERSION, LIBRARY, library, QUALIFIER_SONG_IDS, DOUBLE_ELIMINATION_SONG_IDS, FINAL_SONG_IDS });
});
