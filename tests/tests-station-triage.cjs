'use strict';
// Offline synthetic fixtures only. No application bootstrap, browser or services.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'app/agent-radio-v11.2.html'),'utf8');
const KEY='agentRadioStationTriage.v1';
function between(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,'source boundaries: '+start);
  return html.slice(a,b);
}
const stateCode=between('// BEGIN station triage state:','// END station triage state.');
const uiCode=between('// BEGIN station triage UI:','// END station triage UI.');
const cardCode=between('function cardEl(s){','function renderVisible(){');
const cardsClick=html.split('\n').find(line=>line.startsWith("$('#cards').onclick="));
const bodyClick=html.split('\n').find(line=>line.startsWith("document.body.addEventListener('click',"));
function entry(stationId='a',status='repair-favicon',extra={}){
  return {stationId,status,createdAt:'2025-12-01T00:00:00.000Z',updatedAt:'2025-12-02T00:00:00.000Z',...extra};
}
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function fixture(options={}){
  const data=options.data||new Map();
  if(Object.hasOwn(options,'raw')) data.set(KEY,options.raw);
  const writes=[],calls={select:[],favorite:[],art:0,toast:[]};
  const catalog=Object.freeze(['a','b','c'].map(id=>Object.freeze({
    id,name:'Fixture '+id,genre:'Synthetic',favicon:'fixture-icon',streamUrl:'fixture-stream-'+id,available:id!=='c'
  })));
  let now=Date.parse('2026-01-01T00:00:00.000Z');
  class ClockDate extends Date{static now(){return now;}}
  const ctx=vm.createContext({
    Date:ClockDate,STATIONS:catalog,favorites:new Set(['c','a']),favoriteOrder:Object.freeze(['c','a']),
    recent:Object.freeze([catalog[1]]),current:catalog[0],playing:true,
    localStorage:{
      getItem(key){if(options.readFail) throw new Error('blocked read');return data.get(key)??null;},
      setItem(key,value){if(options.writeFail) throw new Error('blocked write');data.set(key,value);writes.push([key,value]);}
    },
    select(id){calls.select.push(id);},toggleFav(id){calls.favorite.push(id);},
    fetch(){throw new Error('network forbidden');},
    audio:{play(){throw new Error('playback forbidden');},pause(){throw new Error('playback forbidden');}},
    toast(text){calls.toast.push(text);},
    stationColors(){return ['#000','#111'];},artInner(){calls.art++;return '<span>Fixture</span>';},
    locText(){return 'Synthetic location';}
  });
  if(options.absentStorage) delete ctx.localStorage;
  if(options.storageGetterThrows) Object.defineProperty(ctx,'localStorage',{get(){throw new Error('SecurityError');}});
  const run=code=>vm.runInContext(code,ctx,{timeout:1000});
  const plain=code=>JSON.parse(JSON.stringify(run(code)));
  run(stateCode);
  const snapshot=()=>plain('({catalog:STATIONS,favorites:[...favorites],favoriteOrder,recent,current,playing})');
  return {ctx,run,plain,data,writes,calls,catalog,snapshot,options,
    tick(){now+=1000;},flags:()=>plain('triageEntries()'),
    set(id,status,note){return plain(`setStationTriage(${JSON.stringify(id)},${JSON.stringify(status)},${note===undefined?'undefined':JSON.stringify(note)})`);},
    undo:()=>plain('undoStationTriage()')
  };
}
function uiFixture(options={}){
  const f=fixture(options),nodes=new Map(),cardButtons=[];
  let focused=null;
  function node(id){
    if(nodes.has(id)) return nodes.get(id);
    const listeners=new Map();
    const el={id,listeners,value:'',textContent:'',innerHTML:'',disabled:false,isConnected:true,attrs:{},
      addEventListener(type,fn,capture=false){listeners.set(type,{fn,capture});},
      setAttribute(key,value){this.attrs[key]=value;},
      focus(){focused=this;},
      closest(){return null;}
    };
    nodes.set(id,el);return el;
  }
  for(const id of ['cards','stationTriageDialog','stationTriageQueueOpen','stationTriageStation','stationTriageReason',
    'stationTriageNote','stationTriageSave','stationTriageClear','stationTriageUndo','stationTriageFilter',
    'stationTriageQueue','stationTriageCount','stationTriageFeedback','stationTriageForm','stationTriageClose']) node(id);
  const body=node('body'),dialog=node('stationTriageDialog');
  dialog.open=false;dialog.showModal=function(){this.open=true;};
  dialog.close=function(){this.open=false;this.listeners.get('close')?.fn({});};
  for(const s of f.catalog){
    const button=node('review-'+s.id);button.dataset={triageId:s.id};
    button.closest=selector=>selector==='[data-triage-id]'?button:null;
    cardButtons.push(button);
  }
  const document={body,activeElement:cardButtons[0],querySelectorAll(selector){
    assert.equal(selector,'[data-triage-id]');return cardButtons;
  }};
  f.ctx.document=document;
  f.ctx.$=selector=>{assert.ok(selector.startsWith('#'));return node(selector.slice(1));};
  f.run(uiCode+'\n'+cardsClick+'\n'+bodyClick);
  function fire(id,type,extra={}){
    const el=node(id);
    const e={target:el,prevented:false,stopped:false,
      preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra};
    el.listeners.get(type)?.fn(e);
    if(!e.stopped&&type==='click') el.onclick?.(e);
    if(!e.stopped&&type==='click') body.listeners.get('click')?.fn(e);
    return e;
  }
  return {...f,node,dialog,document,cardButtons,fire,focused:()=>focused,
    open(id='a'){document.activeElement=node('review-'+id);return fire('cards','click',{target:node('review-'+id),detail:1});},
    submit(status,note=''){
      node('stationTriageReason').value=status;node('stationTriageNote').value=note;
      return fire('stationTriageForm','submit');
    }
  };
}

test('missing preference is empty and makes no writes',()=>{
  const f=fixture();assert.deepEqual(f.flags(),[]);assert.equal(f.writes.length,0);
});
test('add and replace preserve creation time and update only the triage key',()=>{
  const f=fixture();assert.equal(f.set('a','repair-favicon','  local note  ').ok,true);
  const first=f.flags()[0];assert.equal(first.note,'local note');f.tick();
  f.set('a','repair-genre');const next=f.flags()[0];
  assert.equal(next.createdAt,first.createdAt);assert.ok(next.updatedAt>first.updatedAt);
  assert.equal(next.status,'repair-genre');assert.equal('note' in next,false);
  assert.ok(f.writes.every(([key])=>key===KEY));
  assert.deepEqual(Object.keys(next).sort(),['createdAt','stationId','status','updatedAt']);
});
test('clear and undo restore the previous flag, including note and timestamps',()=>{
  const f=fixture();f.set('a','inoperative','listener observation');const before=f.flags();
  f.set('a',null);assert.deepEqual(f.flags(),[]);assert.equal(f.undo().ok,true);
  assert.deepEqual(f.flags(),before);assert.equal(f.undo().ok,false);
});
test('undo supports both creation and replacement, one action deep',()=>{
  const f=fixture();f.set('a','repair-genre');f.undo();assert.deepEqual(f.flags(),[]);
  f.set('a','repair-favicon');const before=f.flags();f.set('a','not-for-me');
  f.undo();assert.deepEqual(f.flags(),before);assert.equal(f.undo().ok,false);
});
test('no-op clear or identical flag does not consume undo or write',()=>{
  const f=fixture();f.set('a','repair-favicon');const count=f.writes.length;
  f.set('b',null);f.set('a','repair-favicon');
  assert.equal(f.writes.length,count);f.undo();assert.deepEqual(f.flags(),[]);
});
test('valid optional notes normalize and respect the concise limit',()=>{
  for(const note of [undefined,'','   ','  valid note  ','x'.repeat(160),'<text> & "quoted"']){
    const f=fixture();assert.equal(f.set('a','repair-genre',note).ok,true);
    assert.equal(f.flags()[0].note,(note||'').trim()||undefined);
  }
});
test('invalid submitted notes are rejected without writes',()=>{
  for(const note of [null,42,true,{},[], 'x'.repeat(161),'two\nlines','tab\tnote','bad\u0000note','bad\u007fnote']){
    const f=fixture();assert.equal(f.set('a','repair-genre',note).ok,false);
    assert.deepEqual(f.flags(),[]);assert.equal(f.writes.length,0);
  }
});
test('invalid persisted notes are omitted while valid status remains recoverable',()=>{
  for(const note of [null,42,{},[], 'x'.repeat(161),'two\nlines']){
    const f=fixture({raw:JSON.stringify([entry('a','repair-genre',{note})])});
    assert.equal(f.flags()[0].status,'repair-genre');assert.equal('note' in f.flags()[0],false);
  }
});
test('malformed JSON, wrong root types, and malformed entries safely load empty',()=>{
  for(const raw of ['{','null','42','true','"text"','{}','[null,1,"a",[],{},true]']){
    const f=fixture({raw});assert.deepEqual(f.flags(),[]);assert.equal(f.writes.length,0);
  }
});
test('unavailable and throwing storage leave normal catalog state intact',()=>{
  for(const opts of [{readFail:true,writeFail:true},{absentStorage:true},{storageGetterThrows:true}]){
    const f=fixture(opts),before=f.snapshot();
    assert.deepEqual(f.flags(),[]);assert.equal(f.set('a','inoperative').ok,false);
    assert.deepEqual(f.snapshot(),before);
  }
});
test('write failures preserve flags and undo; recovery can save the original undo',()=>{
  const f=fixture();f.set('a','repair-favicon');f.set('a','repair-genre');const before=f.flags();
  f.options.writeFail=true;
  assert.equal(f.set('a',null).ok,false);assert.deepEqual(f.flags(),before);
  assert.equal(f.undo().ok,false);assert.deepEqual(f.flags(),before);
  f.options.writeFail=false;assert.equal(f.undo().ok,true);assert.equal(f.flags()[0].status,'repair-favicon');
});
test('stale/unknown station IDs are hidden from queue and pruned only on successful save',()=>{
  const f=fixture({raw:JSON.stringify([entry('stale'),entry('a')])});
  assert.equal(f.run("triageFor('stale')"),null);assert.deepEqual(f.flags().map(x=>x.stationId),['a']);
  assert.equal(f.set('stale','inoperative').ok,false);
  assert.equal(f.set(null,'inoperative').ok,false);assert.equal(f.set(1,'inoperative').ok,false);
  f.set('b','repair-genre');assert.deepEqual(JSON.parse(f.data.get(KEY)).map(x=>x.stationId),['a','b']);
});
test('pre-catalog empty state does not erase loaded flags',()=>{
  const f=fixture({raw:JSON.stringify([entry()])});f.run('const savedCatalog=STATIONS;STATIONS=[];');
  assert.deepEqual(f.flags(),[]);f.run('STATIONS=savedCatalog;');assert.equal(f.flags().length,1);
  assert.equal(f.writes.length,0);
});
test('duplicates choose newest updated timestamp, then later entry on ties',()=>{
  const newest='2025-12-05T00:00:00.000Z';
  const f=fixture({raw:JSON.stringify([
    entry('a','repair-favicon',{updatedAt:newest}),entry('a','inoperative'),
    entry('a','repair-genre',{updatedAt:newest})
  ])});
  assert.equal(f.flags().length,1);assert.equal(f.flags()[0].status,'repair-genre');
});
test('unknown statuses, invalid IDs and invalid/reversed timestamps are rejected',()=>{
  const records=[entry('a','delete'),entry('a',null),entry(1),entry(''),
    entry('a','repair-genre',{createdAt:'invalid'}),entry('a','repair-genre',{updatedAt:'2025-01-01T00:00:00.000Z'})];
  const f=fixture({raw:JSON.stringify(records)});assert.deepEqual(f.flags(),[]);
  assert.equal(f.set('a','delete').ok,false);assert.equal(f.set('a','').ok,false);
});
test('reload retains only permitted schema fields; undo is session-only',()=>{
  const f=fixture({raw:JSON.stringify([entry('a','repair-favicon',{note:'safe',extra:'discard',genre:'discard'})])});
  f.set('b','repair-genre');
  const reloaded=fixture({data:new Map(f.data)});assert.deepEqual(reloaded.flags(),f.flags());
  assert.deepEqual(Object.keys(reloaded.flags()[0]).sort(),['createdAt','note','stationId','status','updatedAt']);
  assert.equal(reloaded.undo().ok,false);
});
test('all five statuses, clear and undo preserve catalog, metadata, favorites/order, history and playback',()=>{
  const f=fixture(),before=f.snapshot(),refs=[f.ctx.STATIONS,f.ctx.favorites,f.ctx.favoriteOrder,f.ctx.recent,f.ctx.current];
  for(const status of ['repair-favicon','repair-genre','inoperative','hide-local','not-for-me']){
    f.set('b',status);assert.deepEqual(f.snapshot(),before);
  }
  f.set('b',null);f.undo();assert.deepEqual(f.snapshot(),before);
  assert.deepEqual([f.ctx.STATIONS,f.ctx.favorites,f.ctx.favoriteOrder,f.ctx.recent,f.ctx.current],refs);
  assert.deepEqual(f.calls,{select:[],favorite:[],art:0,toast:[]});
});
test('review queue is catalog-ordered, status-filtered, and hides no stations',()=>{
  const f=fixture();f.set('c','hide-local');f.set('a','not-for-me');f.set('b','repair-favicon');
  assert.deepEqual(f.flags().map(x=>x.stationId),['a','b','c']);
  assert.deepEqual(f.plain("triageEntries('hide-local')").map(x=>x.stationId),['c']);
  assert.equal(f.ctx.STATIONS.length,3);
});
test('pointer Review opens editing without selecting, favoriting or playing',()=>{
  const f=uiFixture(),before=f.snapshot(),e=f.open('b');
  assert.equal(f.node('cards').listeners.get('click').capture,true);
  assert.equal(e.prevented,true);assert.equal(e.stopped,true);assert.equal(f.dialog.open,true);
  assert.equal(f.focused(),f.node('stationTriageReason'));assert.match(f.node('stationTriageStation').textContent,/Fixture b/);
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.calls.select,[]);assert.deepEqual(f.calls.favorite,[]);
});
test('ordinary card and favorite actions still pass through unchanged',()=>{
  const f=uiFixture();
  const card={dataset:{id:'a'},closest(sel){return sel==='[data-id]'?card:null;}};
  f.fire('cards','click',{target:card});
  const heart={dataset:{fav:'b'},closest(sel){return sel==='[data-fav]'?heart:null;}};
  f.fire('cards','click',{target:heart});
  assert.deepEqual(f.calls.select,['a']);assert.deepEqual(f.calls.favorite,['b']);
});
test('native form submission saves; clear and undo update existing card labels without artwork work',()=>{
  const f=uiFixture();f.open('a');const original=f.node('review-a');
  assert.equal(f.submit('repair-genre','a local note').prevented,true);
  assert.equal(f.node('review-a'),original);assert.equal(original.textContent,'repair-genre');
  assert.match(original.attrs['aria-label'],/repair-genre/);assert.match(f.node('stationTriageFeedback').textContent,/saved/);
  f.fire('stationTriageClear','click');assert.deepEqual(f.flags(),[]);assert.equal(original.textContent,'Review station');
  f.fire('stationTriageUndo','click');assert.equal(original.textContent,'repair-genre');
  assert.equal(f.calls.art,0);assert.deepEqual(f.calls.select,[]);assert.deepEqual(f.calls.favorite,[]);
});
test('invalid notes and failed saves keep drafts available with accessible error feedback',()=>{
  const f=uiFixture();f.open('a');f.submit('repair-favicon','bad\nnote');
  assert.equal(f.node('stationTriageNote').value,'bad\nnote');
  assert.match(f.node('stationTriageFeedback').textContent,/single-line/);
  f.options.writeFail=true;f.submit('repair-genre','keep draft');
  assert.equal(f.node('stationTriageNote').value,'keep draft');
  assert.match(f.node('stationTriageFeedback').textContent,/storage unavailable/);assert.deepEqual(f.flags(),[]);
});
test('sidebar queue/filter/edit controls reveal flags without playback and safely escape notes',()=>{
  const f=uiFixture();f.set('a','repair-favicon','<img onerror="bad">');f.set('c','inoperative');
  f.fire('stationTriageQueueOpen','click');assert.equal(f.node('stationTriageSave').disabled,true);
  assert.match(f.node('stationTriageQueue').innerHTML,/&lt;img onerror=&quot;bad&quot;&gt;/);
  f.node('stationTriageFilter').value='inoperative';f.fire('stationTriageFilter','change');
  assert.match(f.node('stationTriageQueue').innerHTML,/Fixture c/);
  assert.doesNotMatch(f.node('stationTriageQueue').innerHTML,/Fixture a/);
  const target={dataset:{triageEdit:'c'},closest(selector){return selector==='[data-triage-edit]'?target:null;}};
  f.fire('stationTriageQueue','click',{target});assert.equal(f.node('stationTriageReason').value,'inoperative');
  assert.equal(f.node('stationTriageSave').disabled,false);assert.deepEqual(f.calls.select,[]);
});
test('native keyboard activation, Escape-close contract, labels and focus return are preserved',()=>{
  const f=uiFixture();f.open('a');f.submit('not-for-me');
  // A native dialog's Escape behavior dispatches close; no cancel prevention is installed.
  f.dialog.close();assert.equal(f.focused(),f.node('review-a'));
  assert.match(html,/<dialog id="stationTriageDialog" aria-labelledby="stationTriageTitle" aria-describedby="stationTriageHelp">/);
  assert.match(html,/id="stationTriageSave" type="submit"/);
  assert.match(html,/id="stationTriageFeedback" role="status" aria-live="polite"/);
  assert.match(html,/id="stationTriageNote" type="text" maxlength="160"/);
  for(const id of ['stationTriageReason','stationTriageNote','stationTriageFilter']) assert.ok(html.includes('for="'+id+'"'));
  assert.doesNotMatch(uiCode,/addEventListener\(['"](?:keydown|keyup|cancel)/);
  f.open('a');f.fire('stationTriageClose','click');assert.equal(f.dialog.open,false);
});
test('unsupported native dialog does not throw or affect normal catalog',()=>{
  const f=uiFixture(),before=f.snapshot();f.dialog.showModal=undefined;
  f.fire('stationTriageQueueOpen','click');assert.deepEqual(f.snapshot(),before);
  assert.match(f.calls.toast[0],/does not support/);
});
test('card construction exposes selected status without exposing notes in markup attributes',()=>{
  const f=uiFixture();f.set('a','hide-local','private local note');f.run(cardCode);
  const markup=f.run('cardEl(STATIONS[0])');
  assert.match(markup,/data-triage-id="a"/);assert.match(markup,/hide-local/);
  assert.doesNotMatch(markup,/private local note/);
  assert.match(markup,/data-fav="a"/);assert.match(markup,/class="card/);
});
test('triage source has no catalog/favorites/history mutation or service/playback calls',()=>{
  assert.doesNotMatch(stateCode+uiCode,/\b(?:fetch|select|toggleFav|saveFav|reorderFavorite|renderVisible|renderLists|bindArt|playCurrent)\s*\(/);
  assert.doesNotMatch(stateCode+uiCode,/(?:favorites|recent|STATIONS)\.(?:add|delete|clear|push|splice|sort|reverse)\(/);
  assert.doesNotMatch(stateCode+uiCode,/\b(?:favorites|favoriteOrder|recent|current|playing|STATIONS)\s*=/);
  assert.match(html,/These flags never test, change, or hide stations/);
  assert.match(html,/Inoperative is an observation, not a verified outage/);
});
test('all inline scripts compile without starting the application',()=>{
  let count=0;
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
    new vm.Script(match[2],{filename:'agent-radio-inline-'+(++count)+'.js'});
  }
  console.log('compiled '+count+' inline script blocks (count reported, not asserted)');
});
test('existing Favorites ordering suite passes unchanged',()=>{
  require('./tests-favorites-order.cjs');
});
test('existing layout and tab contracts pass with baseline source-location adapter',()=>{
  // Those unmodified tests expect sibling app files. Supply app/ as __dirname
  // in memory, matching the admitted repository layout without copying files.
  for(const name of ['tests-layout-contract.cjs','tests-tab-exclusive.cjs']){
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,name),'utf8'),
      {require,__dirname:path.join(root,'app'),console},{filename:name,timeout:1000});
  }
});
console.log(`ALL ${passed} STATION TRIAGE TEST GROUPS PASSED`);
