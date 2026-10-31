(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.AgentRadioNarrativeFoundation=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='agent-radio-narrative-foundation-v1';
const clamp=(v,l=0,h=1)=>Math.max(l,Math.min(h,v));
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const FAMILY_RULES=[
 ['classical',/(classical|klassik|baroque|orchestr|opera|choral|chamber|symphon|concerto|requiem|sonata|mozart|bach|beethoven)/i],
 ['electronic',/(deep[ -]?house|electronica|electronic|techno|trance|edm|dance|drum.?and.?bass|dnb|house)/i],
 ['ambient',/(ambient|drone|meditat|soundscape|new age|sleep|chillout|chill[ -]?out)/i],
 ['jazz',/(jazz|bebop|bop|fusion|swing|big band|blues)/i],
 ['rock',/(rock|metal|punk|grunge|alternative|hardcore|prog)/i],
 ['soul',/(soul|funk|r&b|rhythm and blues|gospel|motown)/i],
 ['folk',/(folk|country|bluegrass|americana|acoustic|roots)/i],
 ['global',/(latin|reggae|afrobeat|african|indian|celtic|world|bossa|samba|flamenco|caribbean)/i],
 ['spoken',/(news|talk|podcast|spoken|politic|religious speech|sermon)/i]
];
function classifyGenre(station={}){
 const fields=[['catalog-exact',station.genre],['raw-genre',station.genreRaw],['name-derived',station.name],['network-derived',station.network],['id-derived',station.id]];
 for(const t of Array.isArray(station.tags)?station.tags:[])fields.push(['tag-derived',t]);
 for(const t of Array.isArray(station.tagsRaw)?station.tagsRaw:[])fields.push(['raw-tag-derived',t]);
 if(station.classical||station.metadata?.classical)return {family:'classical',confidence:1,provenance:'catalog-classical-flag',evidence:['classical=true']};
 for(const [prov,value] of fields){if(!value)continue;for(const [family,re] of FAMILY_RULES)if(re.test(String(value)))return {family,confidence:prov==='catalog-exact'||prov==='raw-genre'?.95:.82,provenance:prov,evidence:[String(value)]};}
 return {family:'other',confidence:.25,provenance:'fallback',evidence:[]};
}
const DIALECT={
 classical:{rise:['gathering','ascending'],fall:['receding','releasing'],bright:['luminous','opening'],dark:['shadowed','veiled'],steady:['sustained','poised']},
 electronic:{rise:['building','charging'],fall:['releasing','cooling'],bright:['radiant','shimmering'],dark:['submerged','nocturnal'],steady:['locked','suspended']},
 ambient:{rise:['emerging','blooming'],fall:['dissolving','drifting'],bright:['weightless','lucent'],dark:['distant','dusky'],steady:['hovering','still']},
 jazz:{rise:['pressing','leaning'],fall:['relaxing','laying back'],bright:['open','playful'],dark:['smoky','searching'],steady:['swinging','poised']},
 rock:{rise:['surging','driving'],fall:['receding','breaking open'],bright:['exultant','open'],dark:['brooding','weighted'],steady:['restrained','driving']},
 soul:{rise:['lifting','warming'],fall:['settling','easing'],bright:['radiant','tender'],dark:['yearning','deep'],steady:['grounded','flowing']},
 folk:{rise:['gathering','lifting'],fall:['settling','returning'],bright:['open','sunlit'],dark:['weathered','wistful'],steady:['plainspoken','rooted']},
 global:{rise:['gathering','accelerating'],fall:['releasing','circling down'],bright:['vivid','open'],dark:['earthbound','shadowed'],steady:['cyclical','grounded']},
 other:{rise:['rising'],fall:['settling'],bright:['brightening'],dark:['darkening'],steady:['holding']}
};
function affectDialect(family,trajectory,stateKey='default'){
 const d=DIALECT[family]||DIALECT.other,map={arousal_rising:'rise',arousal_settling:'fall',valence_brightening:'bright',valence_darkening:'dark',holding:'steady'},key=map[trajectory]||'steady',a=d[key];let h=2166136261;for(const c of String(stateKey)+'|'+family+'|'+key){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return {canonical:trajectory||'holding',word:a[(h>>>0)%a.length],family,provenance:'genre-conditioned-musical-affect'};
}
class TemporalBuffer{
 constructor({windowSeconds=120,sampleIntervalSeconds=2}={}){this.windowSeconds=windowSeconds;this.max=Math.ceil(windowSeconds/sampleIntervalSeconds)+2;this.samples=[];this.context=null;}
 reset(context=null){this.samples=[];this.context=context;}
 push(frame){if(!frame||!finite(frame.t))throw new TypeError('frame.t');const key=frame.trackKey||frame.stationId||null;if(this.context!==key)this.reset(key);this.samples.push({...frame});const cutoff=frame.t-this.windowSeconds*1000;this.samples=this.samples.filter(x=>x.t>=cutoff).slice(-this.max);return this.snapshot();}
 values(field,seconds=this.windowSeconds){const end=this.samples.at(-1)?.t??0,cut=end-seconds*1000;return this.samples.filter(x=>x.t>=cut&&finite(x[field])).map(x=>({t:x.t,v:x[field]}));}
 slope(field,seconds=12){const a=this.values(field,seconds);if(a.length<3)return null;const t0=a[0].t,x=a.map(q=>(q.t-t0)/1000),y=a.map(q=>q.v),mx=x.reduce((p,q)=>p+q,0)/x.length,my=y.reduce((p,q)=>p+q,0)/y.length;let n=0,d=0;for(let i=0;i<x.length;i++){n+=(x[i]-mx)*(y[i]-my);d+=(x[i]-mx)**2;}return d?n/d:null;}
 mean(field,seconds=12){const a=this.values(field,seconds);return a.length?a.reduce((p,q)=>p+q.v,0)/a.length:null;}
 snapshot(){return this.samples.map(x=>({...x}));}
}
function event(type,confidence,evidence,t){return {type,confidence:clamp(confidence),evidence,t};}
function deriveEvents(buffer){const s=buffer.samples,last=s.at(-1);if(!last||s.length<3)return [];
 const ar=buffer.slope('arousal'),va=buffer.slope('valence'),te=buffer.slope('tension'),de=buffer.slope('density'),co=buffer.slope('consonance'),r=buffer.mean('rms',8),out=[];
 if(ar!=null&&de!=null&&ar>.008&&de>.006)out.push(event('ascent',.55+Math.min(.4,ar*12+de*10),['arousal-rise','density-rise'],last.t));
 if(te!=null&&te>.006&&last.resolution!==true)out.push(event('suspension',.58+Math.min(.35,te*15),['tension-rise','no-resolution'],last.t));
 if(ar!=null&&ar<-.01&&te!=null&&te<-.006)out.push(event('release',.62+Math.min(.3,-ar*8-te*12),['arousal-fall','tension-fall'],last.t));
 if(r!=null&&r>.12&&finite(last.arousal)&&last.arousal>.72)out.push(event('climax',.65+Math.min(.3,(r-.12)*2+(last.arousal-.72)),['energy-high','arousal-high'],last.t));
 if(va!=null&&va>.008&&co!=null&&co>.005)out.push(event('arrival',.55+Math.min(.35,va*10+co*10),['valence-rise','consonance-rise'],last.t));
 if(Math.abs(ar??1)<.003&&Math.abs(te??1)<.003&&s.length>=6)out.push(event('continuance',.55,['sustained-state'],last.t));
 return out.sort((a,b)=>b.confidence-a.confidence);
}
class EventLedger{
 constructor({cooldownSeconds=10,maxEvents=64}={}){this.cooldown=cooldownSeconds*1000;this.max=maxEvents;this.events=[];}
 ingest(events){for(const e of events){const prior=[...this.events].reverse().find(x=>x.type===e.type);if(prior&&e.t-prior.t<this.cooldown)continue;this.events.push({...e});}this.events=this.events.slice(-this.max);return this.snapshot();}
 snapshot(){return this.events.map(x=>({...x,evidence:[...x.evidence]}));}
 seed(limit=8){const names=this.events.slice(-limit).map(e=>e.type);return names.length?names.join(' → '):'opening → listening';}
}
function normalizeIdentityPart(value){
 const raw=String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\(\[\{].*?[\)\]\}]/g,' ').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
 return /^(unknown|untitled|n a|na|none|null|live|radio|stream|now playing)$/.test(raw)?'':raw;
}
function readPath(o,path){let v=o;for(const k of path.split('.')){if(v==null)return '';v=v[k];}return typeof v==='string'||typeof v==='number'?v:'';}
function firstPath(o,paths){for(const p of paths){const v=normalizeIdentityPart(readPath(o,p));if(v)return v;}return '';}
function trackIdentity(input={}){
 const station=firstPath(input,['stationId','station.id','station.uuid','stationName','station.name','station','context.stationId','context.stationName']);
 const direct=firstPath(input,['trackKey','track.key','track.id','currentTrack.key','nowPlaying.trackKey','metadata.trackKey']);
 const artist=firstPath(input,['track.artist','currentTrack.artist','nowPlaying.artist','metadata.artist','trackArtist','artist']);
 const title=firstPath(input,['track.title','currentTrack.title','nowPlaying.title','metadata.title','trackTitle','songTitle','song','title']);
 const valid=!!direct||!!(artist&&title);
 return {station,artist,title,track:direct||(`${artist}|${title}`),source:direct?'canonical-track-key':(artist&&title?'artist-title-fallback':'none'),valid,key:valid?`${station}|${direct||(`${artist}|${title}`)}`:''};
}
class TrackBoundary{
 constructor({confirmations=2}={}){this.confirmations=Math.max(2,confirmations);this.station='';this.active='';this.pending='';this.count=0;}
 reset(){this.station='';this.active='';this.pending='';this.count=0;}
 observe(input={}){
  const id=trackIdentity(input),stationChanged=!!(id.station&&this.station&&id.station!==this.station);
  if(id.station)this.station=id.station;
  if(stationChanged){this.pending='';this.count=0;this.active=id.valid?id.key:'';return {changed:true,reason:'station',key:this.active||this.station,identity:id};}
  if(!id.valid)return {changed:false,reason:'invalid-metadata',key:this.active||this.station,identity:id};
  if(!this.active){this.active=id.key;this.pending='';this.count=0;return {changed:false,reason:'initial-track',key:this.active,identity:id};}
  if(id.key===this.active){this.pending='';this.count=0;return {changed:false,reason:'same-track',key:this.active,identity:id};}
  if(id.source==='canonical-track-key'){this.active=id.key;this.pending='';this.count=0;return {changed:true,reason:'track',key:this.active,identity:id};}
  if(id.key!==this.pending){this.pending=id.key;this.count=1;return {changed:false,reason:'track-pending',key:this.active,identity:id};}
  this.count++;
  if(this.count<this.confirmations)return {changed:false,reason:'track-pending',key:this.active,identity:id};
  this.active=id.key;this.pending='';this.count=0;return {changed:true,reason:'track',key:this.active,identity:id};
 }
}
class BeatConsolidator{
 constructor({minConfidence=.68,globalSpacingSeconds=16,typeCooldownSeconds=20,maxBeats=24}={}){this.min=minConfidence;this.spacing=globalSpacingSeconds*1000;this.typeCooldown=typeCooldownSeconds*1000;this.max=maxBeats;this.candidates=0;this.beats=[];this.context=null;}
 reset(context=null){this.candidates=0;this.beats=[];this.context=context;}
 ingest(events,{context=null,elapsedSeconds=0}={}){if(context!==this.context)this.reset(context);this.candidates+=events.length;if(!this.beats.length&&elapsedSeconds>=6)this.beats.push({type:'opening',confidence:1,evidence:['stable-initialization'],t:(events[0]?.t||Date.now())-this.spacing});for(const e of events.sort((a,b)=>b.confidence-a.confidence)){if(e.confidence<this.min)continue;const last=this.beats.at(-1);if(last?.type===e.type){if(e.confidence>last.confidence){last.confidence=e.confidence;last.evidence=[...e.evidence];last.t=e.t;}continue;}const same=[...this.beats].reverse().find(x=>x.type===e.type);if(same&&e.t-same.t<this.typeCooldown)continue;if(last&&e.t-last.t<this.spacing){if(e.confidence>last.confidence+.12&&last.type!=='opening')this.beats[this.beats.length-1]={...e,evidence:[...e.evidence]};continue;}this.beats.push({...e,evidence:[...e.evidence]});}this.beats=this.beats.slice(-this.max);return this.snapshot();}
 transformedReturn(){if(this.beats.length<5)return false;const first=this.beats.slice(0,-2).find(x=>x.type!=='opening'),last=this.beats.at(-1);return !!first&&!!last&&first.type===last.type&&last.t-first.t>=45000;}
 snapshot(){const a=this.beats.map(x=>({...x,evidence:[...x.evidence]}));if(this.transformedReturn()&&!a.some(x=>x.type==='transformed return'))a.push({type:'transformed return',confidence:.72,evidence:['earlier-beat-revisited','elapsed-contrast'],t:a.at(-1).t});return a;}
 seed(limit=8){const a=this.snapshot().slice(-limit).map(x=>x.type);return a.length?a.join(' → '):'opening → listening';}
}
function narrativeState({classification,buffer,ledger}){const last=buffer.samples.at(-1)||null;return {schema:'music-narrative-state-v1',genre:classification,elapsedSeconds:last&&buffer.samples[0]?(last.t-buffer.samples[0].t)/1000:0,measurements:last,trajectories:{arousal:buffer.slope('arousal'),valence:buffer.slope('valence'),tension:buffer.slope('tension'),density:buffer.slope('density')},events:ledger.snapshot(),storySeed:ledger.seed()};}
return {VERSION,FAMILY_RULES,classifyGenre,affectDialect,TemporalBuffer,deriveEvents,EventLedger,normalizeIdentityPart,trackIdentity,TrackBoundary,BeatConsolidator,narrativeState};
});
