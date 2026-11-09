'use strict';
const Config = require('../public/js/competition-config');
const { randomUUID } = require('node:crypto');
const Q = require('../public/js/qualifier-rules');
const Intermission = require('../public/js/intermission');
const Pool = require('../public/js/song-pool');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const image = value => value === null || typeof value === 'string' && value.length <= 180 &&
  /^assets\/[a-zA-Z0-9_./-]+\.(png|jpg|jpeg|webp|svg)$/i.test(value) && !value.includes('..') && value.split('/').every(p => p && p !== '.');
function editable(state) {
  return !state.qualifier.plan && !Q.hasScores(state) && !state.qualifier.scoringStarted && !state.result && !state.tournament.seeded &&
    !state.tournament.matches.length && !state.tournament.seeds.length && !state.tournament.drawLog.length &&
    !Object.keys(state.tournament.songHistory || {}).length && !state.correctionLog?.length &&
    !state.qualifier.players.some(p => p.judgements?.some(Boolean) || p.tiePriority !== null);
}
function validateProfile(profile, library) {
  assert(profile && typeof profile === 'object' && !Array.isArray(profile) && profile.schemaVersion === 1 && profile.presentation === 'standard', 'Unsupported event template version or presentation.');
  assert(Object.keys(profile).every(k => ['schemaVersion','presentation','finalSongs','qualifierTiebreakSongs','branding'].includes(k)), 'Unknown event profile field.');
  const byId = new Map(library.map(s => [s.id, s]));
  assert(Array.isArray(profile.finalSongs) && profile.finalSongs.length === 2 && new Set(profile.finalSongs).size === 2, 'Choose two different final songs.');
  const finals = profile.finalSongs.map(id => byId.get(id));
  assert(finals.every(s => s && !s.eligible) && !Pool.sameSong(...finals), 'Final songs must be different library songs outside the regular draw pool.');
  assert(profile.qualifierTiebreakSongs && Object.keys(profile.qualifierTiebreakSongs).sort().join() === 'A,B', 'Configure both qualifier tiebreak songs.');
  for (const id of Object.values(profile.qualifierTiebreakSongs)) assert(byId.has(id) && !byId.get(id).eligible, 'Qualifier tiebreak songs must be library songs outside the regular draw pool.');
  assert(profile.branding && Object.keys(profile.branding).sort().join() === 'kiramekiLogo,logo,socLogo,visual' && Object.values(profile.branding).every(image), 'Branding must use local assets image paths or null.');
  return profile;
}
function exportTemplate(state) {
  const library = structuredClone(state.library);
  const ties = state.eventProfile?.qualifierTiebreakSongs || Object.fromEntries(Object.entries(Config.QUALIFIER_TIEBREAK_SONGS).map(([g,s]) => {
    if (!library.some(item => item.id === s.id)) library.push({...s}); return [g,s.id];
  }));
  return { schemaVersion: 1, event: Object.fromEntries(['title','organiser','organiserZH','date','time','venue','message'].map(k => [k,state.event[k]])),
    library, qualifierSongs: Object.fromEntries(['A','B'].map(g => [g,[...state.qualifier.groups[g].songs]])),
    intermission: state.eventProfile ? Object.fromEntries(Object.entries(state.broadcast?.intermission || {}).filter(([k])=>['videoPath','videoDuration','resumeTime'].includes(k))) : {videoPath:'',resumeTime:''},
    profile: structuredClone(state.eventProfile || { schemaVersion:1,presentation:'standard',finalSongs:[...Config.FINAL_SONG_IDS],qualifierTiebreakSongs:ties,
      branding:{logo:'assets/event/phigros-logo.webp',visual:null,socLogo:null,kiramekiLogo:null} }) };
}
function applyTemplate(state, template) {
  assert(editable(state), 'Event templates are locked after qualifier setup, scoring or bracket history. Create a fresh event to use another template.');
  assert(template && typeof template === 'object' && !Array.isArray(template) && template.schemaVersion === 1 &&
    Object.keys(template).every(k => ['schemaVersion','event','library','qualifierSongs','profile','intermission'].includes(k)), 'Invalid event template. Import a template, not a match-state backup.');
  assert(Array.isArray(template.library) && template.library.length > 0 && template.library.length <= 500, 'Provide a song library of 1–500 charts.');
  assert(template.event && Object.keys(template.event).sort().join() === 'date,message,organiser,organiserZH,time,title,venue', 'Provide event information without saved competition state.');
  assert(template.library.every(s => s && typeof s === 'object' && Object.keys(s).every(k => ['id','title','artist','difficulty','level','constant','art','previewAudio','eligible'].includes(k))), 'Unknown song fields in template.');
  validateProfile(template.profile, template.library);
  for (const g of ['A','B']) assert(Array.isArray(template.qualifierSongs?.[g]) && template.qualifierSongs[g].length === 3 && new Set(template.qualifierSongs[g]).size === 3 &&
    template.qualifierSongs[g].every(id => template.library.some(s => s.id === id)), 'Choose three different library songs for each qualifier round.');
  const intermission = { ...Intermission.defaults(), ...(template.intermission || {}), useBundledVideo:false };
  assert(!template.intermission || Object.keys(template.intermission).every(k=>['videoPath','resumeTime','videoDuration'].includes(k)), 'Do not include playback cues in a template.');
  Intermission.validate(intermission);
  state.eventId = randomUUID();
  state.event = structuredClone(template.event); state.eventProfile = structuredClone(template.profile);
  state.library = structuredClone(template.library);
  state.qualifier.groups = Object.fromEntries(['A','B'].map(g => [g,{songs:[...template.qualifierSongs[g]]}]));
  state.qualifier.currentSong = 0; state.scene = 'start'; state.stage = 'qualifier';
  // A reusable template never enables the bundled competition announcement.
  state.broadcast ||= {}; state.broadcast.intermission = intermission;
}
module.exports = { editable, validateProfile, exportTemplate, applyTemplate };
