(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.AgentRadioNativeCardBridge=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
let mounted=false;
let engine=null;
let state=null;
let analysisHandler=null;
let resetHandler=null;

function createEvent(name,detail){
  if(typeof root.CustomEvent==='function') return new root.CustomEvent(name,{detail});
  return {type:name,detail};
}
function mount(target=root){
  if(mounted) return false;
  if(!target||typeof target.addEventListener!=='function'||!root.AgentRadioNativeCard) return false;
  engine=new root.AgentRadioNativeCard.NativeCardEngine({audioSourceId:'agent-radio-media-element'});
  analysisHandler=function(event){
    try{
      state=engine.analyze(event&&event.detail);
      if(typeof target.dispatchEvent==='function') target.dispatchEvent(createEvent('agent-radio-native-card',state));
    }catch(error){
      state=null;
      if(typeof target.dispatchEvent==='function') target.dispatchEvent(createEvent('agent-radio-native-card-error',{message:error.message}));
    }
  };
  resetHandler=function(){
    engine.reset(null,'analysis-reset'); state=null;
    if(typeof target.dispatchEvent==='function') target.dispatchEvent(createEvent('agent-radio-native-card-reset',{state:null}));
  };
  target.addEventListener('agent-radio-analysis',analysisHandler);
  target.addEventListener('agent-radio-analysis-reset',resetHandler);
  mounted=true;
  return true;
}
function getState(){return state?JSON.parse(JSON.stringify(state)):null;}
function isMounted(){return mounted;}
return {mount,getState,isMounted};
});
