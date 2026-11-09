'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fresh,toFinal,act}=require('./helpers/standard-event'),E=require('../lib/event-templates');
const {validateState:validate}=require('../lib/state-validation'),T=require('../lib/tournament');
const Sequence=require('../public/js/final-sequence'),Announcement=require('../public/js/final-announcement'),Videos=require('../public/js/broadcast-videos');
test('a reusable template contains configuration without scores, identities or playback state; imports are independent',()=>{
 const s=fresh(),t=E.exportTemplate(s);assert.equal(s.event.competitionVersion,undefined);assert.equal(t.eventId,undefined);
 assert.equal(t.qualifier,undefined);assert.equal(t.tournament,undefined);assert.equal(t.profile.presentation,'standard');
 const dest=require('../lib/default-state').createDefaultState();act(dest,'apply-event-template',{confirmed:true,template:t});validate(dest);
 assert.notEqual(s.eventId,dest.eventId);assert.deepEqual(dest.eventProfile,s.eventProfile);assert.equal(Videos.intermission(dest.broadcast.intermission).videoPath,'');
 assert.equal(require('../lib/default-state').createStandardState().eventProfile.presentation,'standard');
});
test('invalid template paths, fields, references and snapshots fail atomically',()=>{
 for(const change of [t=>t.profile.finalSongs=['missing','other'],t=>t.profile.branding.logo='assets/../secret.svg',t=>t.library[0].art='https://example.com/a.png',t=>t.scores=[],t=>t.library[0].score=999,t=>t.profile.presentation='arbitrary']){
  const s=fresh(),before=structuredClone(s),t=E.exportTemplate(s);change(t);
  assert.throws(()=>act(s,'apply-event-template',{confirmed:true,template:t}));assert.deepEqual(s,before);
 }
});
test('profile settings freeze when qualifiers are configured and restored profiles cannot forge finale modes',()=>{
 const s=fresh();act(s,'set-qualifier-plan',{plan:'A'});const t=E.exportTemplate(s),before=structuredClone(s);
 assert.throws(()=>act(s,'apply-event-template',{confirmed:true,template:t}),/locked/);assert.deepEqual(s,before);
 assert.throws(()=>act(s,'apply-competition-config',{confirmed:true}),/locked/);
 const other=fresh();act(other,'seed-bracket',{ids:other.qualifier.players.map(p=>p.id),ruleset:'proposal-2026',verified:true});
 other.tournament.matches.at(-1).presentation='acahku-2026';assert.throws(()=>validate(other),/standard final/);
});
test('custom qualifier tiebreaks are resolved from the event snapshot and hidden until announcement',()=>{
 const s=fresh(),Q=require('../public/js/qualifier-rules');act(s,'set-competition-roster',{names:Array.from({length:12},(_,i)=>'Player '+i)});act(s,'set-qualifier-plan',{plan:'A'});
 Q.entries(s,'A').forEach((p,i)=>act(s,'set-qualifier-total',{group:'A',playerId:p.id,total:i<3?3000000-i*10000:i<5?2800000:2500000-i*1000}));
 act(s,'draw-qualifier-tiebreak',{group:'A',playerIds:Q.entries(s,'A').slice(3,5).map(p=>p.id)});validate(s);
 const tie=Q.activeTiebreak(s,'A');assert.equal(tie.song.id,s.eventProfile.qualifierTiebreakSongs.A);
 assert.equal(T.publicState(s).eventProfile.qualifierTiebreakSongs,undefined);assert.ok(!T.publicState(s).library.some(x=>x.id===tie.song.id));
});
test('standard finals reveal custom songs and finish on two scores without a video or effect sequence',()=>{
 const s=toFinal(fresh()),m=s.tournament.matches.at(-1);validate(s);assert.equal(m.songs.length,2);assert.ok(Announcement.isFixed(m));assert.ok(!Sequence.isEnabled(m));
 act(s,'start-final-announcement');validate(s);assert.deepEqual(Announcement.audioCue(m).songIds,s.eventProfile.finalSongs);
 for(const type of ['show-final-two-totals','configure-final-finale','start-final-finale','play-final-finale-video','set-final-finale-effect'])assert.throws(()=>act(s,type),/standard final/);
 for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act(s,'set-match-score',{playerIndex:pi,songIndex:si,score:pi?900000:980000});
 act(s,'record-result',{verified:true});validate(s);assert.equal(m.status,'complete');assert.equal(s.result.winnerId,m.players[0]);
 const restored=JSON.parse(JSON.stringify(s));validate(restored);assert.equal(restored.tournament.matches.at(-1).presentation,'standard');
});
test('standard startup and template export enforce panel roles and preserve existing saved events',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'event-template-api-'));let app;
 try{
  app=require('../server').createBroadcastServer({dataDir:dir,preset:'standard',pin:'template-main',scorekeeperPin:'template-score',hostPin:'template-host'});const a=await app.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+a.port;
  for(const [role,pin,expected] of [['control','template-main',200],['scorekeeper','template-score',403],['host','template-host',403]]){
   const session=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,pin})}).then(r=>r.json());
   const r=await fetch(base+'/api/event-template',{headers:{Authorization:'Bearer '+session.token}});assert.equal(r.status,expected);
   if(expected===200){const t=await r.json();assert.equal(t.profile.presentation,'standard');assert.equal(t.eventId,undefined);}
  }
  assert.equal((await fetch(base+'/api/branding').then(r=>r.json())).socLogo,null);
  const id=app.store.state.eventId;await app.close();app=null;
  app=require('../server').createBroadcastServer({dataDir:dir,preset:'acahku-2026',pin:'template-main'});assert.equal(app.store.state.eventId,id);assert.ok(app.store.state.eventProfile);
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('standard finals still resolve equal-score and equal-accuracy matches through a confirmed tiebreak',()=>{
 const s=toFinal(fresh()),m=s.tournament.matches.at(-1);
 for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act(s,'set-match-score',{playerIndex:pi,songIndex:si,score:980000,judgements:{accuracy:99}});
 act(s,'draw-match-tiebreak');validate(s);
 for(let pi=0;pi<2;pi++)act(s,'set-match-tiebreak-score',{index:0,playerIndex:pi,score:pi?990000:980000});
 act(s,'confirm-match-tiebreak',{index:0,verified:true});act(s,'record-result',{verified:true});validate(s);
 assert.equal(m.winnerId,m.players[1]);assert.equal(m.songs.length,2);
});
test('templates retain custom intermission settings without cues; selecting ACAHKU restores its bundled media',()=>{
 const s=fresh();act(s,'configure-intermission',{videoPath:'assets/intermission/community.mp4',resumeTime:'14:00'});
 const t=E.exportTemplate(s);assert.equal(t.intermission.cue,undefined);assert.equal(t.intermission.videoPath,'assets/intermission/community.mp4');
 const other=require('../lib/default-state').createDefaultState();act(other,'apply-event-template',{confirmed:true,template:t});validate(other);
 assert.equal(Videos.intermission(other.broadcast.intermission).videoPath,'assets/intermission/community.mp4');
 act(other,'apply-competition-config',{confirmed:true});validate(other);assert.equal(other.eventProfile,undefined);
 assert.equal(Videos.intermission(other.broadcast.intermission).videoPath,Videos.clips.arcaea.videoPath);
});
