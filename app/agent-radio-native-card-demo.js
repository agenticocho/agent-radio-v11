(function(root){
'use strict';
if(!root.location||new URLSearchParams(root.location.search).get('nativeCardDemo')!=='1')return;
let timestamp=Date.now();
const phases=[];
function add(count,values,label){for(let i=0;i<count;i++)phases.push({values,label});}
add(16,{rms:.04,bpm:100,consonance:.70,complexity:.40,harmonicEntropy:.30,modulation:.10},'development');
add(12,{rms:.15,bpm:165,consonance:.20,complexity:.90,harmonicEntropy:.85,modulation:.40},'climax');
add(6,{rms:.05,bpm:100,consonance:.65,complexity:.45,harmonicEntropy:.35,modulation:.10},'pre-fermata');
add(6,{rms:.001,bpm:100,consonance:.70,complexity:.30,harmonicEntropy:.25,modulation:.05},'fermata');
add(8,{rms:.08,bpm:140,consonance:.20,complexity:.80,harmonicEntropy:.80,modulation:.35},'tension');
add(8,{rms:.02,bpm:90,consonance:.85,complexity:.25,harmonicEntropy:.15,modulation:.05},'resolution');
let index=0,priorRms=.04,cycle=0;
function dispatch(){
  if(index>=phases.length){
    cycle++;index=0;priorRms=.04;
    root.dispatchEvent(new CustomEvent('agent-radio-analysis-reset',{detail:{state:null}}));
  }
  const phase=phases[index++];timestamp+=250;
  const v=phase.values;
  root.dispatchEvent(new CustomEvent('agent-radio-analysis',{detail:{
    schemaVersion:'radio-analysis-state-v1',timestampMs:timestamp,
    stationId:'native-card-demo',trackKey:'synthetic-cycle-'+cycle,
    rms:v.rms,rmsSlope:v.rms-priorRms,bpm:v.bpm,bpmConfidence:.95,
    key:'D',mode:'minor',keyConfidence:.92,consonance:v.consonance,
    complexity:v.complexity,harmonicEntropy:v.harmonicEntropy,modulation:v.modulation,
  }}));
  priorRms=v.rms;
  const badge=root.document&&root.document.getElementById('ar-native-demo-phase');
  if(badge)badge.textContent='Synthetic phase: '+phase.label;
}
root.addEventListener('DOMContentLoaded',()=>{
  const badge=root.document.getElementById('ar-native-demo-phase');
  if(badge){badge.style.display='inline-block';badge.textContent='Demo · starting';}
  setInterval(dispatch,250);
});
})(window);
