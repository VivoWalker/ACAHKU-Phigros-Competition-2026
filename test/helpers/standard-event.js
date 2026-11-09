'use strict';
const T=require('../../lib/tournament'), Templates=require('../../lib/event-templates');
const act=(s,type,payload={})=>T.applyAction(s,{type,payload:T.CURRENT_MATCH_ACTIONS.has(type)?{matchId:s.tournament.currentMatchId,...payload}:payload});
function fresh(){
 const s=require('../../lib/default-state').createDefaultState(), t=Templates.exportTemplate(s);
 const ids=new Map(t.library.map((song,i)=>[song.id,'shared-chart-'+i]));
 t.library.forEach((song,i)=>{song.id=ids.get(song.id);song.title='Custom chart '+i;if(!t.profile.finalSongs.includes([...ids.keys()][i]))song.art='assets/song/cover-'+(i%4+1)+'.svg';song.previewAudio='';});
 for(const g of ['A','B']){t.qualifierSongs[g]=t.qualifierSongs[g].map(id=>ids.get(id));t.profile.qualifierTiebreakSongs[g]=ids.get(t.profile.qualifierTiebreakSongs[g]);}
 t.profile.finalSongs=t.profile.finalSongs.map(id=>ids.get(id));
 t.event.title='Community Phigros Cup';t.event.organiser='Community';t.event.organiserZH='社群';
 act(s,'apply-event-template',{confirmed:true,template:t});return s;
}
function toFinal(s){
 act(s,'seed-bracket',{ids:s.qualifier.players.map(p=>p.id),ruleset:'proposal-2026',verified:true});
 for(const matchId of ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']){
  act(s,'select-match',{matchId});act(s,'draw-candidates');const m=s.tournament.matches.find(m=>m.id===matchId);
  act(s,'ban-song',{playerIndex:0,songId:m.candidates[0].id});act(s,'ban-song',{playerIndex:1,songId:m.candidates[1].id});act(s,'pick-songs');
  for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act(s,'set-match-score',{playerIndex:pi,songIndex:si,score:pi?970000:990000,judgements:{accuracy:pi?97:99,perfect:pi?970:990,good:pi?30:10,bad:0,miss:0}});
  act(s,'record-result',{verified:true});
 }
 act(s,'select-match',{matchId:'GF'});act(s,'set-broadcast-cue',{stage:'double-elimination',scene:'double-elimination-waiting',matchId:'GF',songIndex:0});return s;
}
module.exports={fresh,toFinal,act};
