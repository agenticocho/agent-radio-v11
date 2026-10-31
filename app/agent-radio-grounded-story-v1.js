(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.AgentRadioGroundedStory=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
const VERSION='grounded-story-output-v2';
function freeze(v){if(!v||typeof v!=='object'||Object.isFrozen(v))return v;Object.keys(v).forEach(k=>freeze(v[k]));return Object.freeze(v);}
function finite(v){return typeof v==='number'&&Number.isFinite(v);}
function words(s){return String(s||'').trim().split(/\s+/).filter(Boolean).length;}
function bounded(text,maxWords=90){const clean=String(text||'').replace(/\s+/g,' ').trim();if(words(clean)<=maxWords&&/[.!?]$/.test(clean))return clean;const sentences=clean.match(/[^.!?]+[.!?]+/g)||[];let out='';for(const sentence of sentences){const next=(out+' '+sentence.trim()).trim();if(words(next)>maxWords)break;out=next;}if(!out)throw Object.assign(new Error('story-not-sentence-safe'),{code:'story-not-sentence-safe'});return out;}
function point(sample){if(!sample)return null;const out={};for(const k of ['arousal','valence','tension','density','consonance','rms','centroid','bpm'])if(finite(sample[k]))out[k]=Number(sample[k].toFixed(4));return Object.keys(out).length?out:null;}
function digest(packet){const m=packet.music||{},s=Array.isArray(m.samples)?m.samples:[],mid=s.length?s[Math.floor((s.length-1)/2)]:null;return {identity:{artist:packet.identity?.artist||null,title:packet.identity?.title||null,station:packet.identity?.station||null,genre:packet.identity?.genre||null},provenance:{samplePolicy:packet.provenance?.samplePolicy||null,interpretation:packet.provenance?.interpretation||null},completion:packet.completion,observedSeconds:m.elapsedSeconds??null,sampleCount:s.length,musicalReadings:{opening:point(s[0]),middle:point(mid),closing:point(s.at(-1)),trajectories:m.trajectories||null,genre:m.genre||null,affectDialect:m.affectDialect||null},narrativeBeats:(m.narrativeBeats||[]).slice(-8).map(x=>({type:x.type,confidence:x.confidence,evidence:x.evidence})),events:(m.events||[]).slice(-10).map(x=>({type:x.type,confidence:x.confidence,evidence:x.evidence})),storySeed:m.storySeed||null};}
function level(v,lo,hi,a,b,c){return !finite(v)?'unresolved':v<lo?a:v>hi?c:b;}
function qualitativePoint(sample){if(!sample)return {energy:'unresolved',color:'unresolved',tension:'unresolved',texture:'unresolved'};return {energy:level(sample.arousal,.35,.65,'quiet','controlled','energized'),color:level(sample.valence,.40,.60,'darker','neutral','brighter'),tension:level(sample.tension,.35,.65,'low','moderate','raised'),texture:level(sample.density,.35,.65,'open','layered','dense')};}
function movement(a,b,field,up,down,hold){const x=a&&a[field],y=b&&b[field];if(!finite(x)||!finite(y))return hold;const d=y-x;return d>.06?up:d<-.06?down:hold;}
function qualitativeDigest(packet){const m=packet.music||{},s=Array.isArray(m.samples)?m.samples:[],first=s[0]||null,mid=s.length?s[Math.floor((s.length-1)/2)]:null,last=s.at(-1)||null,q1=qualitativePoint(first),q2=qualitativePoint(mid),q3=qualitativePoint(last);const e1=`${q1.energy} energy, ${q1.color} color, ${q1.tension} tension, and ${q1.texture} texture`;const phrase=(a,b)=>[movement(a,b,'arousal','energy rises','energy settles','energy holds'),movement(a,b,'valence','color brightens','color darkens','color holds'),movement(a,b,'tension','tension rises','tension eases','tension holds'),movement(a,b,'density','texture grows denser','texture opens','texture holds')].join(', ');return {schemaVersion:'grounded-story-qualitative-v1',identity:{artist:packet.identity?.artist||null,title:packet.identity?.title||null,genre:packet.identity?.genre||null},completion:'final sample is a capture boundary, not an ending',evidence:{E1:`Opening musical state: ${e1}.`,E2:`Middle movement: ${phrase(first,mid)}.`,E3:`Final observed musical state: ${phrase(mid,last)}.`},provenance:{samplePolicy:packet.provenance?.samplePolicy||null,interpretation:'qualitative browser-audio interpretation; no raw measurements supplied'}};}
function eligible(packet){if(!packet||packet.schemaVersion!=='grounded-story-input-v1')return {ok:false,reason:'invalid-input'};if(!packet.identity?.artist||!packet.identity?.title)return {ok:false,reason:'identity-unavailable'};if(!Array.isArray(packet.music?.samples)||packet.music.samples.length===0)return {ok:false,reason:'insufficient-music-samples'};return {ok:true,reason:null};}
function prompts(packet){
  const compiled=digest(packet);
  const identity=compiled&&compiled.identity||packet&&packet.identity||{};
  const artist=String(identity.artist||identity.composer||'').trim();
  const title=String(identity.title||identity.work||'').trim();
  const directions=Object.values(compiled&&compiled.evidence||{}).filter(value=>typeof value==='string'&&value.trim());
  const seed=(artist+'|'+title).split('').reduce((hash,char)=>((hash*33)^char.charCodeAt(0))>>>0,5381);
  const lenses=[
    'a threshold crossed in changing light',
    'a night journey through an unfamiliar landscape',
    'an interior room slowly changing shape',
    'weather gathering, breaking, and clearing',
    'architecture opening into unexpected space',
    'a small human drama told without literal characters'
  ];
  const lens=lenses[seed%lenses.length];
  const identityLine=[artist,title].filter(Boolean).join(' — ');
  const samplePolicy=String(
    packet&&packet.provenance&&packet.provenance.samplePolicy||
    compiled&&compiled.provenance&&compiled.provenance.samplePolicy||
    'unknown'
  );
  return {
    system:'Write one imaginative miniature story inspired by the musical journey. The story foundation is independent of any DJ persona and speaking voice. Use only the supplied verified identity and browser-audio musical evidence. Name the verified artist or composer and title accurately, preferably once, using neutral attribution; never say an artist or composer performs the work unless a verified performer is supplied. Use 3 to 5 complete sentences and 40 to 90 words. Build a clear arc: an immediate opening image, a meaningful turn, and a final image grounded only in the final observed musical state. The final sample is a capture boundary where listening stopped, so never imply that the composition ended, resolved, concluded, finished, fell silent, or reached a last chord. Treat the supplied directions as private stage directions: translate them into imagery, motion, atmosphere, and clearly non-factual metaphor instead of reporting analysis. Do not use the words energy, color, tension, texture, density, arousal, valence, evidence, observed, captured, passage, metric, sample, reading, or analysis. Never invent biography, history, dates, places, quotations, credits, relationships, recording circumstances, inspiration, artistic intent, instruments, performers, or an unsupported climax. Do not mention the station, the prompt, missing data, JSON, or the act of measuring. Write natural spoken prose with varied sentence shapes, no preamble, no sign-off, and no private labels.',
    user:`Source policy: ${samplePolicy}\nVerified identity: ${identityLine||'identified work'}\nPrivate musical directions:\n- ${directions.join('\n- ')}\nOptional imaginative lens: ${lens}\nCreate one self-contained story now.`
  };
}
function storyStructureText(clean,packet){let out=clean;for(const value of [packet?.identity?.artist,packet?.identity?.title]){if(!value)continue;const safe=String(value).replace(/[.!?]/g,'∯');out=out.split(String(value)).join(safe);}return out;}

/* A5.3R13R11R2 — track-bound eligibility and identity conformance. Additive only. */
function r13r11Fold(value){
  return String(value==null?'':value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u2018\u2019\u02bc\u2032]/g,"'")
    .replace(/[\u201c\u201d\u2033]/g,'"')
    .replace(/[\u2010-\u2015\u2212]/g,'-')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}
function r13r11Anchor(folded){
  const parts=folded.split(' ').filter(Boolean);
  if(parts.length<=8) return null;
  const anchor=[];
  for(const part of parts){
    anchor.push(part);
    if(anchor.length>=4 && anchor.join(' ').length>=12) break;
  }
  const out=anchor.join(' ');
  return out.length>=12?out:null;
}
function r13r11IdentityPresent(text,value){
  const haystack=r13r11Fold(text), needle=r13r11Fold(value);
  if(!needle) return true;
  if(haystack.indexOf(needle)!==-1) return true;
  const anchor=r13r11Anchor(needle);
  return anchor?haystack.indexOf(anchor)!==-1:false;
}
function r13r11LooksLikeUrl(folded){
  if(!folded) return false;
  if(/^(https?:\/\/)?(www\.)/.test(folded)) return true;
  if(/\.(ch|com|net|org|fm|de|io|co|uk|at|eu|tv|radio)(\/|$)/.test(folded)) return true;
  return false;
}
function r13r11IdentityIssue(packet){
  const identity=(packet&&packet.identity)||{};
  const artist=r13r11Fold(identity.artist), title=r13r11Fold(identity.title), station=r13r11Fold(identity.station);
  if(!artist||!title) return null;
  if(r13r11LooksLikeUrl(title)||r13r11LooksLikeUrl(artist)) return 'station-identification-not-track';
  if(artist===title) return 'station-identification-not-track';
  if(station&&(station.indexOf(artist)!==-1||artist.indexOf(station)!==-1)) return 'station-identification-not-track';
  if(station&&(station.indexOf(title)!==-1||title.indexOf(station)!==-1)) return 'station-identification-not-track';
  return null;
}
function r13r11Bind(packet){
  const key=packet&&packet.trackKey?String(packet.trackKey):'';
  const music=(packet&&packet.music)||{};
  const samples=Array.isArray(music.samples)?music.samples.slice():[];
  if(!samples.length) return {issue:'analysis-samples-absent'};
  const keyed=[], unkeyed=[];
  for(const sample of samples){
    const sampleKey=sample&&sample.trackKey?String(sample.trackKey):'';
    if(!sampleKey) unkeyed.push(sample);
    else if(key&&sampleKey===key) keyed.push(sample);
    else return {issue:'analysis-track-key-mismatch'};
  }
  if(keyed.length>=6) return {issue:null,mode:'track-key',samples:keyed};
  const startedAt=Date.parse((packet&&packet.startedAt)||'');
  const endedAt=Date.parse((packet&&packet.endedAt)||'');
  const hasWindow=isFinite(startedAt)&&isFinite(endedAt)&&endedAt>startedAt;
  const hasStamps=samples.some(function(sample){return isFinite(Number(sample&&sample.t));});
  if(hasWindow&&hasStamps){
    const tolerance=2500;
    const inWindow=samples.filter(function(sample){
      const t=Number(sample&&sample.t);
      return isFinite(t)&&t>=(startedAt-tolerance)&&t<=(endedAt+tolerance);
    }).sort(function(a,b){return Number(a.t)-Number(b.t);});
    if(inWindow.length<6) return {issue:'analysis-window-unbound'};
    return {issue:null,mode:'capture-window',samples:inWindow};
  }
  if(hasStamps&&!hasWindow) return {issue:'analysis-window-undeclared'};
  return {issue:null,mode:'unverified-attachment',samples:samples};
}
function r13r11Retry(issue,packet){
  const identity=(packet&&packet.identity)||{};
  const artist=String(identity.artist||'').trim();
  const title=String(identity.title||'').trim();
  let out=' RETRY REQUIREMENT: Your previous response failed the contract. Return 3 to 5 complete sentences totaling 40 to 90 words. Finish every sentence with punctuation.';
  out+=' The specific rejection reason was: '+String(issue||'unknown')+'.';
  if(issue==='missing-artist') out+=' You omitted the verified artist. Write the artist name exactly as: '+artist+'.';
  if(issue==='missing-title') out+=' You omitted the verified title. Write the title exactly as: '+title+'.';
  if(issue==='too-long') out+=' Your previous answer exceeded 90 words. Stay at or under 90 words.';
  if(issue==='too-short') out+=' Your previous answer was under 40 words. Write at least 40 words.';
  if(issue==='wrong-sentence-count') out+=' Use between three and five sentences.';
  if(issue==='unfinished') out+=' Finish the final sentence with terminal punctuation.';
  if(issue==='false-ending') out+=' Do not imply the work ended, resolved, concluded, finished, fell silent, or reached a last chord. The final sample is only where listening stopped.';
  if(issue==='technical-language') out+=' Remove every analysis word and every number.';
  if(issue==='station-leak') out+=' Never mention the station.';
  if(artist) out+=' Always include the verified artist exactly as '+artist+'.';
  if(title) out+=' Always include the verified title exactly as '+title+'.';
  out+=' Move from the opening direction through the middle movement to a final image grounded in the final observed musical state.';
  out+=' Never mention the station or add an unsupported climax, peak, instrument, performer, intent, history, or external fact.';
  out+=' Never expose private labels or use forbidden analysis words. Prose only.';
  return out;
}

function completionIssue(text,packet=null){const clean=String(text||'').replace(/\s+/g,' ').trim(),wc=words(clean);if(!clean)return 'empty';if(/\d+\.\d+|\b(?:arousal|valence|sample|confidence|metric|measurement|captured|passage)\b/i.test(clean))return 'technical-language';if(/\b(?:end|ending|ends|ended|conclusion|conclude|concludes|concluded|finish|finishes|finished|finishing|close|closes|closed|closing|resolve|resolves|resolved|resolution)\b|last\s+chord|fell\s+silent|falls\s+silent|into\s+silence/i.test(clean))return 'false-ending';if(!/[.!?]$/.test(clean))return 'unfinished';if(wc<40)return 'too-short';if(wc>90)return 'too-long';const structure=storyStructureText(clean,packet),sentences=(structure.match(/[^.!?]+[.!?]+/g)||[]).length;if(sentences<3||sentences>5)return 'wrong-sentence-count';const artist=String(packet&&packet.identity&&packet.identity.artist||'').trim();const title=String(packet&&packet.identity&&packet.identity.title||'').trim();if(artist&&!r13r11IdentityPresent(clean,artist))return 'missing-artist';if(title&&!r13r11IdentityPresent(clean,title))return 'missing-title';const station=String(packet&&packet.identity&&packet.identity.station||'').trim();if(station&&station.length>2&&clean.toLowerCase().indexOf(station.toLowerCase())!==-1)return 'station-leak';return null;}

/* A5.3R13R12R2 — deterministic identity shell, verified packet fields only. */
function r13r12IdentityShell(text,packet){
  const raw=String(text||'').replace(/\s+/g,' ').trim();
  const rawIssue=completionIssue(raw,packet);
  if(rawIssue!=='missing-artist'&&rawIssue!=='missing-title'){
    return {text:raw,issue:rawIssue,applied:false,reason:null,prefixWords:0};
  }
  const identity=(packet&&packet.identity)||{};
  const artist=String(identity.artist||'').trim();
  const title=String(identity.title||'').trim();
  if(!artist||!title){
    return {text:raw,issue:rawIssue,applied:false,reason:'identity-shell-fields-missing',prefixWords:0};
  }
  const artistPresent=r13r11IdentityPresent(raw,artist);
  const titlePresent=r13r11IdentityPresent(raw,title);
  if(artistPresent||titlePresent){
    return {text:raw,issue:rawIssue,applied:false,reason:'partial-or-conflicting-identity',prefixWords:0};
  }
  const prefix='From '+artist+', “'+title+'” sets the scene: ';
  const conformed=prefix+raw;
  return {text:conformed,issue:completionIssue(conformed,packet),applied:true,reason:rawIssue,prefixWords:words(prefix)};
}

async function generate(packet,options={}){const gate=eligible(packet);if(!gate.ok)return freeze({schemaVersion:VERSION,status:'insufficient',trackKey:packet?.trackKey||null,reason:gate.reason,text:null,generatedAt:null,provenance:{inputSchemaVersion:packet?.schemaVersion||null,packetId:packet?.packetId||null}});const r13r11Identity=r13r11IdentityIssue(packet);if(r13r11Identity)return freeze({schemaVersion:VERSION,status:'insufficient',trackKey:packet?.trackKey||null,reason:r13r11Identity,text:null,generatedAt:null,provenance:{inputSchemaVersion:packet?.schemaVersion||null,packetId:packet?.packetId||null,evidenceBinding:null}});const r13r11Binding=r13r11Bind(packet);if(r13r11Binding.issue)return freeze({schemaVersion:VERSION,status:'insufficient',trackKey:packet?.trackKey||null,reason:r13r11Binding.issue,text:null,generatedAt:null,provenance:{inputSchemaVersion:packet?.schemaVersion||null,packetId:packet?.packetId||null,evidenceBinding:null}});const work=Object.assign({},packet,{music:Object.assign({},packet.music,{samples:r13r11Binding.samples})});const llm=options.llm;if(!llm||typeof llm.chat!=='function')throw Object.assign(new Error('llm-unavailable'),{code:'llm-unavailable'});const p=prompts(work);let text='',firstFailure=null,attemptCount=0,identityShellApplied=false,identityShellReason=null,identityShellPrefixWords=0;for(let attempt=1;attempt<=2;attempt++){attemptCount=attempt;const retry=attempt===2;const system=retry?p.system+r13r11Retry(firstFailure,work):p.system;text=await llm.chat({system,user:p.user,kind:'story',strictFacts:true,expectedArtist:packet.identity.artist,expectedTrack:packet.identity.title,maxTokens:retry?260:180,temperature:retry?0.1:0.25});const r13r12Conformed=r13r12IdentityShell(text,work);text=r13r12Conformed.text;identityShellApplied=r13r12Conformed.applied;identityShellReason=r13r12Conformed.reason;identityShellPrefixWords=r13r12Conformed.prefixWords;const issue=r13r12Conformed.issue;if(!issue)break;if(attempt===1){firstFailure=issue;continue;}throw Object.assign(new Error('story-incomplete-after-retry'),{code:'story-incomplete-after-retry',firstFailure,secondFailure:issue});}const guard=options.guard;if(guard&&typeof guard.detect==='function'){const verdict=guard.detect(text);if(verdict?.rejected)throw Object.assign(new Error('story-output-rejected'),{code:'story-output-rejected',verdict});}return freeze({schemaVersion:VERSION,status:'generated',trackKey:packet.trackKey,text,generatedAt:new Date().toISOString(),provenance:{inputSchemaVersion:packet.schemaVersion,packetId:packet.packetId,generator:'local-llm',evidenceBinding:r13r11Binding.mode,boundSampleCount:r13r11Binding.samples.length,identityShellApplied,identityShellReason,identityShellPrefixWords,model:typeof llm.getModel==='function'?llm.getModel():null,personaApplied:false,voiceApplied:false,samplePolicy:packet.provenance?.samplePolicy||null,interpretation:packet.provenance?.interpretation||null,attemptCount,firstFailure}});}
return {VERSION,eligible,digest,qualitativeDigest,prompts,completionIssue,bounded,generate};
});

// R13R10: the legacy static-contract tokens were removed with the literal
// prefix rule. The public contract is now 3-5 sentences, 40-90 words, natural
// prose, with the final sample treated as a capture boundary and never as an
// ending. Private labels are never emitted into spoken output.
