const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { focusRound, destination, nextMatches, createController } = require('../public/js/bracket-view');
const { expandSongLibrary, finalCandidates } = require('./helpers/song-library');
function command(s,type,payload={}){return applyAction(s,{type,payload:CURRENT_MATCH_ACTIONS.has(type)?{matchId:s.tournament.currentMatchId,...payload}:payload});}
function finish(s,id){command(s,'select-match',{matchId:id});const m=s.tournament.matches.find(m=>m.id===id);
 if(id==='GF'){const ids=finalCandidates(s,8);command(s,'set-final-candidates',{ids});command(s,'set-final-picks',{audienceIds:ids.slice(0,2),hostId:ids[2]});command(s,'reveal-host-song');}
 else{command(s,'draw-candidates');command(s,'ban-song',{playerIndex:0,songId:m.candidates[0].id});command(s,'ban-song',{playerIndex:1,songId:m.candidates[1].id});command(s,'pick-songs');}
 m.scores.forEach((row,pi)=>row.forEach((_,si)=>command(s,'set-match-score',{playerIndex:pi,songIndex:si,score:990000-pi*10000})));
 command(s,'record-result');return m;
}
test('round focus advances only after every match in the current round, including both brackets',()=>{
 const s=expandSongLibrary(createDefaultState());command(s,'seed-bracket',{ids:['p1','p2','p3','p4','p5','p6','p7','p8']});
 assert.equal(focusRound(s),1);for(const id of ['W1','W2','W3']){finish(s,id);assert.equal(focusRound(s),1);}finish(s,'W4');assert.equal(focusRound(s),2);
 for(const id of ['W5','W6','L1']){finish(s,id);assert.equal(focusRound(s),2);}finish(s,'L2');assert.equal(focusRound(s),3);
});
test('winner/loser routes follow actual source edges, including crossovers, elimination and podium',()=>{
 const s=expandSongLibrary(createDefaultState());command(s,'seed-bracket',{ids:['p1','p2','p3','p4','p5','p6','p7','p8']});
 assert.deepEqual(nextMatches(s,1).map(m=>m.id),['W5','W6','L1','L2']);
 for(const m of s.tournament.matches){finish(s,m.id);for(const id of m.players){const route=destination(s,m,id);assert.ok(route);
  if(route.target){const target=s.tournament.matches.find(n=>n.id===route.target);assert.ok(target.players.includes(id));}
  else assert.ok(['eliminated','champion','runner-up'].includes(route.kind));}}
 const w6=s.tournament.matches.find(m=>m.id==='W6');assert.equal(destination(s,w6,w6.loserId).target,'L3');
 const l6=s.tournament.matches.find(m=>m.id==='L6');assert.equal(destination(s,l6,l6.loserId).label,'季軍 · 淘汰');
 const gf=s.tournament.matches.at(-1);assert.equal(destination(s,gf,gf.winnerId).kind,'champion');assert.equal(destination(s,gf,gf.loserId).kind,'runner-up');assert.equal(focusRound(s),6);
});
test('vacancy lottery has no phantom loser or elimination announcement',()=>{
 const s=createDefaultState();command(s,'seed-bracket',{ids:['p1','p2','p3','p4','p5','p6','p7',null]});
 command(s,'lottery-bye',{playerId:'p1'});const m=s.tournament.matches[0];assert.equal(destination(s,m,null),null);assert.equal(destination(s,m,m.winnerId).target,'W5');
});
test('controller keeps R1 focused when a ready R2 match finishes early, including live reentry',t=>{
 const originalMedia=globalThis.matchMedia, originalDocument=globalThis.document;
 globalThis.matchMedia=()=>({matches:false,addEventListener(){}});
 globalThis.document={timeline:{currentTime:0}};
 t.after(()=>{if(originalMedia===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=originalMedia;
  if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;});
 let scheduled;t.mock.method(globalThis,'setTimeout',fn=>{scheduled=fn;return 1;});t.mock.method(globalThis,'clearTimeout',()=>{});
 const mount={querySelector:()=>null,querySelectorAll:()=>[]};
 for(const initiallyActive of [true,false]){
  const s=expandSongLibrary(createDefaultState());command(s,'seed-bracket',{ids:['p1','p2','p3','p4','p5','p6','p7','p8']});
  const controller=createController(mount,()=>{});controller.prepare(s,initiallyActive);
  finish(s,'W1');finish(s,'W2');finish(s,'W5');assert.equal(focusRound(s),1);
  assert.equal(controller.prepare(s,true),1);scheduled();assert.equal(controller.round,1);
  finish(s,'W3');finish(s,'W4');assert.equal(controller.prepare(s,true),1);
  scheduled();assert.equal(controller.round,2);
 }
});

test('disposed bracket controllers remove media-query listeners, hold timers and never render again', t => {
 const originalMedia=globalThis.matchMedia, originalDocument=globalThis.document;
 const listeners=new Set(), timers=new Map();let serial=0, renders=0;
 const media={matches:false,addEventListener:(event,fn)=>listeners.add(fn),removeEventListener:(event,fn)=>listeners.delete(fn)};
 globalThis.matchMedia=()=>media;globalThis.document={timeline:{currentTime:0}};
 t.after(()=>{if(originalMedia===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=originalMedia;
  if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;});
 t.mock.method(globalThis,'setTimeout',fn=>{const id=++serial;timers.set(id,fn);return id;});
 t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 const mount={querySelector:()=>null,querySelectorAll:()=>[]};
 const s=expandSongLibrary(createDefaultState());command(s,'seed-bracket',{ids:['p1','p2','p3','p4','p5','p6','p7','p8']});
 for(let iteration=0;iteration<30;iteration++){
  const controller=createController(mount,()=>renders++);controller.prepare(s,true);
  const finished=structuredClone(s);finished.tournament.matches[0].status='complete';finished.tournament.matches[0].winnerId='p1';
  controller.prepare(finished,true);assert.equal(timers.size,1);assert.equal(listeners.size,1);
  controller.dispose();controller.dispose();assert.equal(timers.size,0);assert.equal(listeners.size,0);
  controller.prepare(finished,true);controller.afterCommit();
 }
 media.matches=true;for(const listener of listeners)listener();assert.equal(renders,0);
});
