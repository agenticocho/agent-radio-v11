(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.AgentRadioNativeCardUI=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
let mounted=false,nativeState=null,analysisState=null,els=null;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const fmt = (value, digits = 2)=>finite(value)?value.toFixed(digits):'—';
function nativeVm(state){
  if(!state||state.schemaVersion!=='agent-radio-native-card-v1')return null;
  return {arc:state.structure.arc,fermata:!!state.structure.fermataCandidate,resolution:!!state.structure.resolutionCandidate,
    arousal:fmt(state.estimates.arousal.value),valence:fmt(state.estimates.valence.value),
    tension:fmt(state.estimates.harmonicTension.value),flow:fmt(state.estimates.flowZone.value),
    confidence:fmt(state.structure.confidence),label:'browser-audio heuristic estimates'};
}
function analysisVm(state){
  if(!state||state.schemaVersion!=='radio-analysis-state-v1')return null;
  const key=finite(state.keyConfidence)&&state.keyConfidence>=.55&&state.key?`${state.key} ${state.mode||''}`.trim():'—';
  const family=Array.isArray(state.tempoFamily)&&finite(state.tempoFamilyConfidence)&&state.tempoFamilyConfidence>=.28?state.tempoFamily.filter(finite).slice().sort((a,b)=>a-b):[];
  const tempo=family.length>1?'≈'+family.map(Math.round).join('/'):family.length===1?Math.round(family[0])+' BPM':finite(state.bpmConfidence)&&state.bpmConfidence>=.5&&finite(state.bpm)?Math.round(state.bpm)+' BPM':null;
  return {key,tempo,consonance:fmt(state.consonance),complexity:fmt(state.complexity),entropy:fmt(state.harmonicEntropy),label:'Agent Radio native analysis'};
}
function field(label,value,active=false){return `<div class="ar-hi-field"><span>${label}</span><b class="${active?'active':''}">${value}</b></div>`;}
function renderNative(){const vm=nativeVm(nativeState);if(!els)return;els.native.innerHTML=vm?
  field('Arc',vm.arc)+field('Fermata candidate',vm.fermata?'YES':'no',vm.fermata)+field('Resolution candidate',vm.resolution?'YES':'no',vm.resolution)+field('Arousal estimate',vm.arousal)+field('Valence estimate',vm.valence)+field('Harmonic tension',vm.tension)+field('Flow zone',vm.flow)+field('Evidence', vm.confidence)+`<div class="ar-hi-note">${vm.label} · visualization only</div>`:
  '<div class="ar-hi-empty">Awaiting analysis for the current track.</div>';}
function renderAnalysis(){const vm=analysisVm(analysisState);if(!els)return;els.analysis.innerHTML=vm?
  field('Tonal centre',vm.key)+field('Tempo',vm.tempo||'—')+field('Consonance',vm.consonance)+field('Complexity',vm.complexity)+field('Entropy (bits)', vm.entropy)+`<div class="ar-hi-note">${vm.label}</div>`:
  '<div class="ar-hi-empty">Analysis gathering…</div>';}
function setTab(tab){if(!els)return;const analysis=tab==='analysis';els.panel.dataset.tab=tab;els.native.hidden=analysis;els.analysis.hidden=!analysis;els.native.style.display=analysis?'none':'grid';els.analysis.style.display=analysis?'grid':'none';els.tabNative.classList.toggle('on',!analysis);els.tabAnalysis.classList.toggle('on',analysis);els.tabNative.setAttribute('aria-selected',String(!analysis));els.tabAnalysis.setAttribute('aria-selected',String(analysis));}
function expandAnalysis(){
  if(root.AgentRadioVocabulary&&typeof root.AgentRadioVocabulary.show==='function'){root.AgentRadioVocabulary.show();return;}
  const button=root.document&&root.document.getElementById('ar-analysis-launch');if(button)button.click();
}
function mount(doc=root.document,target=root){
  if(mounted||!doc||!doc.body||typeof target.addEventListener!=='function')return false;
  const hero=doc.querySelector('section.hero');if(!hero)return false;mounted=true;
  const style=doc.createElement('style');style.id='ar-hero-insight-style';style.textContent=`
  section.hero{display:grid!important;grid-template-columns:auto minmax(210px,1fr) minmax(300px,390px);align-items:center;gap:14px;min-height:132px}
  #ar-hero-insight{align-self:stretch;min-width:0;border-left:1px solid rgba(255,255,255,.08);padding-left:14px;display:flex;flex-direction:column;justify-content:center}
  #ar-hero-insight [hidden]{display:none!important}.ar-hi-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.ar-hi-tools{display:flex;align-items:center;gap:6px}.ar-hi-demo{display:none;color:#d6a84a;border:1px solid rgba(214,168,74,.35);background:rgba(214,168,74,.08);border-radius:999px;padding:4px 7px;font:600 8px/1 system-ui;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}.ar-hi-tabs{display:flex;gap:3px;padding:2px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.06);border-radius:999px}
  .ar-hi-tabs button,.ar-hi-expand{border:0;background:transparent;color:#7d858f;font:600 9px/1 system-ui;text-transform:uppercase;letter-spacing:.07em;padding:6px 9px;border-radius:999px;cursor:pointer}.ar-hi-tabs button.on{background:#20252b;color:#d9dee4}.ar-hi-expand{border:1px solid rgba(255,255,255,.08);font-size:13px;padding:5px 8px}.ar-hi-expand:hover{color:#5bd4c7}
  .ar-hi-body{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.ar-hi-field{min-width:0;border:1px solid rgba(255,255,255,.06);background:rgba(8,11,14,.26);border-radius:6px;padding:6px}.ar-hi-field span{display:block;color:#69717b;font:500 8px/1.2 system-ui;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ar-hi-field b{display:block;margin-top:4px;color:#d8dde3;font:600 12px/1.1 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ar-hi-field b.active{color:#d6a84d}.ar-hi-note,.ar-hi-empty{grid-column:1/-1;color:#69717b;font:9px/1.3 system-ui;margin-top:2px}.ar-hi-empty{padding:18px 4px}
  #ar-analysis-launch{display:none!important}
  @media(max-width:1180px){section.hero{grid-template-columns:auto minmax(180px,1fr)}#ar-hero-insight{grid-column:1/-1;border-left:0;border-top:1px solid rgba(255,255,255,.08);padding:10px 0 0}.ar-hi-body{grid-template-columns:repeat(4,minmax(0,1fr))}}
  @media(max-width:760px){section.hero{display:flex!important;flex-wrap:wrap}#ar-hero-insight{flex:1 0 100%}.ar-hi-body{grid-template-columns:repeat(2,minmax(0,1fr))}.ar-hi-field:nth-of-type(n+7){display:none}}
  @media(prefers-reduced-motion:reduce){#ar-hero-insight *{transition:none!important}}
  `;doc.head.appendChild(style);
  const panel=doc.createElement('section');panel.id='ar-hero-insight';panel.setAttribute('aria-label','Now playing insights');panel.dataset.tab='native';panel.innerHTML=`<div class="ar-hi-head"><div class="ar-hi-tabs" role="tablist"><button type="button" class="on" role="tab" aria-selected="true">Native Card</button><button type="button" role="tab" aria-selected="false">Analysis</button></div><div class="ar-hi-tools"><span class="ar-hi-demo" id="ar-native-demo-phase" aria-live="polite">Demo</span><button type="button" class="ar-hi-expand" title="Open full-screen Analysis" aria-label="Open full-screen Analysis">↗</button></div></div><div class="ar-hi-body" data-panel="native"></div><div class="ar-hi-body" data-panel="analysis" hidden></div>`;
  hero.appendChild(panel);els={panel,native:panel.querySelector('[data-panel="native"]'),analysis:panel.querySelector('[data-panel="analysis"]'),tabNative:panel.querySelectorAll('[role="tab"]')[0],tabAnalysis:panel.querySelectorAll('[role="tab"]')[1],expand:panel.querySelector('.ar-hi-expand')};
  els.tabNative.addEventListener('click',()=>setTab('native'));els.tabAnalysis.addEventListener('click',()=>setTab('analysis'));els.expand.addEventListener('click',expandAnalysis);
  target.addEventListener('agent-radio-native-card',event=>{nativeState=event.detail;renderNative();});
  target.addEventListener('agent-radio-native-card-reset',()=>{nativeState=null;renderNative();});
  target.addEventListener('agent-radio-analysis',event=>{analysisState=event.detail;renderAnalysis();});
  target.addEventListener('agent-radio-analysis-reset',()=>{analysisState=null;renderAnalysis();});
  renderNative();renderAnalysis();setTab('native');const demo=new URLSearchParams(root.location&&root.location.search||'').get('nativeCardDemo')==='1';const chip=panel.querySelector('#ar-native-demo-phase');if(chip)chip.style.display=demo?'inline-block':'none';return true;
}
return {mount,nativeVm,analysisVm,setTab,expandAnalysis};
});
