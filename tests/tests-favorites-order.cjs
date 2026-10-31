'use strict';
// Offline only: compile inline scripts and execute extracted favorite code in a
// Node VM with synthetic storage/DOM fixtures. Never bootstrap the application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname,'../app/agent-radio-v11.2.html'),'utf8');
const ORDER = 'agentRadioFavoriteOrder.v1', MEMBERS = 'agentRadioFavorites';
function between(start,end){
  const a=html.indexOf(start), b=html.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a,`source boundaries: ${start}`);
  return html.slice(a,b);
}
const stateCode = between('let STATIONS = [];','const $ = s => document.querySelector(s)');
const saveCode = between('function saveFav(){','function locText(s)');
const renderCode = between('function renderLists(){','// BEGIN sidebar favorite reorder events:');
const eventsCode = between('function initFavoriteReorder(){','// END sidebar favorite reorder events.');
const bodyClick = html.split('\n').find(line=>line.startsWith("document.body.addEventListener('click',"));
assert.ok(bodyClick);
let passed=0;
function test(name,fn){ fn(); passed++; console.log('PASS '+name); }
function fixture(options={}){
  const data = options.data || new Map([[MEMBERS,JSON.stringify(options.members || ['c','a','b'])]]);
  if(Object.hasOwn(options,'raw')) data.set(ORDER,options.raw);
  const writes=[], calls={visible:0,current:0,art:0,selected:[]};
  const storage={
    getItem(key){ if(options.readFail==='all' || options.readFail===key) throw new Error('blocked read'); return data.get(key) ?? null; },
    setItem(key,value){ if(options.writeFail==='all' || options.writeFail===key) throw new Error('blocked write'); writes.push([key,value]); data.set(key,value); }
  };
  const catalog=Object.freeze(['a','b','c','d'].map(id=>Object.freeze({id,name:'Fixture '+id,genre:'Synthetic'})));
  const ctx=vm.createContext({
    localStorage:storage,catalog,
    renderLists(){}, renderVisible(){calls.visible++;}, updateCurrent(){calls.current++;},
    select(id){calls.selected.push(id);},
    fetch(){throw new Error('network forbidden');},
    stationColors(){return ['#000','#111'];}, artInner(){return '<span>F</span>';},
    bindArt(){calls.art++;},
    esc(value){return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  });
  if(options.absentStorage) delete ctx.localStorage;
  if(options.storageGetterThrows) Object.defineProperty(ctx,'localStorage',{get(){throw new Error('SecurityError');}});
  const run=code=>vm.runInContext(code,ctx,{timeout:1000});
  run(stateCode+'\nSTATIONS=catalog; current=STATIONS[0];\n'+saveCode);
  return {
    ctx,run,data,writes,calls,catalog,
    ids:()=>Array.from(run('favoriteSidebarIds()')),
    members:()=>Array.from(run('[...favorites]')),
    move:(a,b,after=false)=>run(`reorderFavorite(${JSON.stringify(a)},${JSON.stringify(b)},${after})`)
  };
}
function domFixture(options={}){
  const f=fixture(options), rows=[], listeners=new Map(), bodyListeners=new Map();
  let clock=1000, focused=null;
  const status={textContent:''}, recent={innerHTML:'unchanged'};
  const list={
    innerHTML:'',
    contains(node){return rows.includes(node) || !!(node && rows.includes(node.row));},
    querySelectorAll(selector){assert.equal(selector,'.favorite-row');return rows.slice();},
    appendChild(row){assert.ok(rows.includes(row));rows.splice(rows.indexOf(row),1);rows.push(row);},
    addEventListener(type,fn,capture=false){listeners.set(type,{fn,capture});}
  };
  for(const id of f.ids()){
    const classes=new Set();
    const row={
      dataset:{favoriteId:id},
      classList:{add(x){classes.add(x);},remove(x){classes.delete(x);},contains(x){return classes.has(x);}},
      closest(selector){return selector==='.favorite-row'?row:null;},
      getBoundingClientRect(){return {top:rows.indexOf(row)*40,height:40};},
      querySelector(selector){assert.equal(selector,'.favorite-drag');return handle;}
    };
    const handle={
      row,
      closest(selector){return selector==='.favorite-drag'?handle:selector==='.favorite-row'?row:null;},
      focus(opts){assert.equal(opts.preventScroll,true);focused=handle;}
    };
    const button={
      row,dataset:{id},
      closest(selector){return selector==='.station-row'?button:selector==='.favorite-row'?row:null;}
    };
    row.handle=handle;row.button=button;rows.push(row);
  }
  f.ctx.$=selector=>{
    if(selector==='#favoriteList') return list;
    if(selector==='#recentList') return recent;
    if(selector==='#favoriteOrderStatus') return status;
    throw new Error('unexpected DOM access: '+selector);
  };
  f.ctx.Date={now:()=>clock};
  f.ctx.document={body:{addEventListener(type,fn){bodyListeners.set(type,fn);}}};
  f.run(eventsCode+'\ninitFavoriteReorder();\n'+bodyClick);
  const row=id=>rows.find(x=>x.dataset.favoriteId===id);
  const fire=(type,target,extra={})=>{
    const e={target,detail:0,clientY:0,relatedTarget:null,prevented:false,stopped:false,
      preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra};
    listeners.get(type)?.fn(e);
    if(!e.stopped) bodyListeners.get(type)?.(e);
    return e;
  };
  const transfer=()=>({values:[],setData(...args){this.values.push(args);}});
  const drag=(source,target,after=false)=>{
    const dt=transfer();
    fire('dragstart',row(source).handle,{dataTransfer:dt});
    const y=row(target).getBoundingClientRect().top+(after?39:1);
    const over=fire('dragover',row(target).button,{dataTransfer:dt,clientY:y});
    const drop=fire('drop',row(target).button,{dataTransfer:dt,clientY:y});
    fire('dragend',row(source).handle);
    return {dt,over,drop};
  };
  return {...f,rows,row,list,status,recent,listeners,fire,drag,transfer,
    domIds:()=>rows.map(x=>x.dataset.favoriteId),focused:()=>focused,
    advance(ms){clock+=ms;}
  };
}

test('all inline scripts compile without execution',()=>{
  let count=0;
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
    new vm.Script(match[2],{filename:`agent-radio-inline-${++count}.js`});
  }
  assert.ok(count>0);
  console.log(`  compiled ${count} inline scripts; application not started`);
});
test('stable initial catalog order, independent of favorite insertion order',()=>{
  const f=fixture();assert.deepEqual(f.members(),['c','a','b']);
  assert.deepEqual(f.ids(),['a','b','c']);assert.deepEqual(f.ids(),['a','b','c']);assert.equal(f.writes.length,0);
});
test('reorder before and after, preserving membership, current station and frozen catalog',()=>{
  const f=fixture(), before=f.members(), membershipData=f.data.get(MEMBERS);
  assert.equal(f.move('c','a'),true);assert.deepEqual(f.ids(),['c','a','b']);
  assert.equal(f.move('c','b',true),true);assert.deepEqual(f.ids(),['a','b','c']);
  assert.deepEqual(f.members(),before);assert.equal(f.data.get(MEMBERS),membershipData);
  assert.ok(f.writes.every(([key])=>key===ORDER));
  assert.equal(f.run('current===STATIONS[0]'),true);assert.equal(f.run('STATIONS===catalog'),true);
  assert.deepEqual(f.calls,{visible:0,current:0,art:0,selected:[]});
});
test('persistence round-trip into a fresh page/restart context',()=>{
  const f=fixture();f.move('c','a');
  assert.deepEqual(JSON.parse(f.data.get(ORDER)),['c','a','b']);
  const reloaded=fixture({data:new Map(f.data)});
  assert.deepEqual(reloaded.ids(),['c','a','b']);assert.deepEqual(reloaded.members(),f.members());
});
test('new favorite appends to saved order even when earlier in catalog',()=>{
  const f=fixture({members:['a','c'],raw:'["c","a"]'});
  f.run("toggleFav('b')");
  assert.deepEqual(f.ids(),['c','a','b']);assert.deepEqual(JSON.parse(f.data.get(ORDER)),['c','a','b']);
});
test('removed favorite alone is eliminated from saved order',()=>{
  const f=fixture({raw:'["c","a","b"]'});f.run("toggleFav('a')");
  assert.deepEqual(f.ids(),['c','b']);assert.deepEqual(JSON.parse(f.data.get(ORDER)),['c','b']);
});
test('removed and re-added favorite goes to the end',()=>{
  const f=fixture({raw:'["c","a","b"]'});f.run("toggleFav('a');toggleFav('a')");
  assert.deepEqual(f.ids(),['c','b','a']);
});
test('without saved order, membership changes retain catalog-order convention',()=>{
  const f=fixture({members:['c']});f.run("toggleFav('a')");
  assert.deepEqual(f.ids(),['a','c']);assert.equal(f.data.has(ORDER),false);
});
test('duplicate saved IDs are ignored',()=>{
  assert.deepEqual(fixture({raw:'["c","c","a","a","b"]'}).ids(),['c','a','b']);
});
test('stale, unknown, and non-favorite saved IDs are ignored',()=>{
  assert.deepEqual(fixture({raw:'["missing","d","c","unknown","a"]'}).ids(),['c','a','b']);
});
test('malformed saved IDs are ignored without coercion',()=>{
  assert.deepEqual(fixture({raw:'[null,1,true,{},["a"],"","c","a"]'}).ids(),['c','a','b']);
});
test('missing favorites stay visible and append deterministically',()=>{
  assert.deepEqual(fixture({raw:'["c"]'}).ids(),['c','a','b']);
});
test('malformed persistence payloads use safe deterministic fallback',()=>{
  for(const raw of ['{','{}','null','true','42','"c"','']){
    const f=fixture({raw});assert.deepEqual(f.ids(),['a','b','c']);assert.equal(f.writes.length,0);
  }
});
test('ordering read exception falls back while existing favorites remain usable',()=>{
  const f=fixture({raw:'["c","a","b"]',readFail:ORDER});
  assert.deepEqual(f.ids(),['a','b','c']);assert.deepEqual(f.members(),['c','a','b']);
});
test('ordering write exception restores catalog fallback without membership changes',()=>{
  const f=fixture({raw:'["c","a","b"]',writeFail:ORDER}), before=f.members();
  assert.equal(f.move('b','c'),false);assert.deepEqual(f.ids(),['a','b','c']);
  assert.deepEqual(f.members(),before);assert.equal(f.data.get(ORDER),'["c","a","b"]');
});
test('blocked, unavailable, and throwing storage cannot break favorite helpers',()=>{
  for(const opts of [{readFail:'all',writeFail:'all'},{absentStorage:true},{storageGetterThrows:true}]){
    const f=fixture(opts);assert.deepEqual(f.ids(),[]);f.run("toggleFav('a');toggleFav('c')");
    assert.deepEqual(f.ids(),['a','c']);assert.equal(f.move('c','a'),false);
    assert.deepEqual(f.ids(),['a','c']);assert.equal(f.calls.current,2);
  }
});
test('malformed membership is safely loaded; valid membership schema remains unchanged',()=>{
  for(const raw of ['{','{}','null','"abc"','[null,1,{}]']){
    const f=fixture({data:new Map([[MEMBERS,raw]])});assert.deepEqual(f.members(),[]);
  }
  const f=fixture();f.run("toggleFav('d')");
  assert.deepEqual(JSON.parse(f.data.get(MEMBERS)),['c','a','b','d']);
});
test('membership-write exception still renders and updates in-memory favorites',()=>{
  const f=fixture({writeFail:MEMBERS,raw:'["c","a","b"]'});f.run("toggleFav('a')");
  assert.deepEqual(f.ids(),['c','b']);assert.equal(f.calls.visible,1);assert.equal(f.calls.current,1);
});
test('empty pre-catalog render does not discard saved ordering',()=>{
  const f=fixture({raw:'["c","a","b"]'});f.run('STATIONS=[]');
  assert.deepEqual(f.ids(),[]);f.run('STATIONS=catalog');
  assert.deepEqual(f.ids(),['c','a','b']);assert.equal(f.writes.length,0);
});
test('invalid, self, and no-op moves never write or change membership',()=>{
  const f=fixture(), before=f.members();
  for(const [a,b,after] of [['d','a',false],['a','unknown',false],['a','a',false],['a','b',false],[null,'b',false]]){
    assert.equal(f.move(a,b,after),false);
  }
  assert.deepEqual(f.members(),before);assert.equal(f.writes.length,0);
});
test('empty/single favorite and last removal have safe persisted behavior',()=>{
  assert.deepEqual(fixture({members:[]}).ids(),[]);
  const f=fixture({members:['a'],raw:'["a"]'});assert.equal(f.move('a','a'),false);
  f.run("toggleFav('a')");assert.deepEqual(f.ids(),[]);assert.equal(f.data.get(ORDER),'[]');
});
test('render uses sibling buttons, escaped accessible labels, and unchanged recent order',()=>{
  const f=domFixture({raw:'["c","a","b"]'});
  f.run("STATIONS=catalog.map(s=>({...s,name:'Fixture \"quoted\" & <name>'}));recent=[STATIONS[1],STATIONS[0]];");
  f.run(renderCode+'\nrenderLists();');
  const markup=f.list.innerHTML;
  assert.deepEqual([...markup.matchAll(/data-favorite-id="([^"]+)"/g)].map(x=>x[1]),['c','a','b']);
  assert.match(markup,/<\/button><button type="button" class="favorite-drag" draggable="true"/);
  assert.match(markup,/aria-label="Reorder Fixture &quot;quoted&quot; &amp; &lt;name&gt;\. Drag, or use Arrow Up and Arrow Down\."/);
  assert.deepEqual([...f.recent.innerHTML.matchAll(/data-id="([^"]+)"/g)].map(x=>x[1]),['b','a']);
  assert.doesNotMatch(f.recent.innerHTML,/favorite-drag/);
  f.run('favorites.clear();renderLists();');assert.match(f.list.innerHTML,/No favorites yet/);
});
test('pointer drag down and up moves existing nodes only, with insertion feedback',()=>{
  const f=domFixture(), originalRows=f.rows.slice(), members=f.members();
  const first=f.drag('a','c',true);
  assert.equal(first.dt.effectAllowed,'move');assert.equal(first.dt.dropEffect,'move');
  assert.equal(first.over.prevented,true);assert.equal(first.drop.prevented,true);
  assert.deepEqual(f.domIds(),['b','c','a']);assert.deepEqual(f.ids(),f.domIds());
  f.drag('a','b');assert.deepEqual(f.domIds(),['a','b','c']);
  assert.ok(f.rows.every(row=>originalRows.includes(row)));
  assert.ok(f.rows.every(row=>!row.dataset.dropPosition && !row.classList.contains('favorite-dragging')));
  assert.deepEqual(f.members(),members);assert.deepEqual(f.calls,{visible:0,current:0,art:0,selected:[]});
  assert.equal(f.recent.innerHTML,'unchanged');
});
test('drag marker clears on leaving the list; canceled drag never writes',()=>{
  const f=domFixture(), dt=f.transfer();
  f.fire('dragstart',f.row('a').handle,{dataTransfer:dt});
  f.fire('dragover',f.row('c'),{dataTransfer:dt,clientY:119});
  assert.equal(f.row('c').dataset.dropPosition,'after');
  f.fire('dragleave',f.row('c'),{relatedTarget:null});assert.equal(f.row('c').dataset.dropPosition,undefined);
  f.fire('dragend',f.row('a').handle);assert.equal(f.writes.length,0);assert.deepEqual(f.ids(),['a','b','c']);
});
test('external drops and non-handle/image drags cannot reorder favorites',()=>{
  const f=domFixture(), dt=f.transfer();
  assert.equal(f.fire('dragstart',f.row('a').button,{dataTransfer:dt}).prevented,true);
  assert.equal(f.fire('dragover',f.row('b'),{dataTransfer:dt}).prevented,false);
  f.fire('drop',f.row('b'),{dataTransfer:dt});assert.equal(f.writes.length,0);
  assert.deepEqual(f.calls.selected,[]);
});
test('missing/throwing drag transfer fails safely',()=>{
  const f=domFixture();
  for(const dataTransfer of [null,{setData(){throw new Error('blocked transfer');}}]){
    assert.equal(f.fire('dragstart',f.row('a').handle,{dataTransfer}).prevented,true);
    f.fire('drop',f.row('b'));assert.equal(f.writes.length,0);
  }
});
test('favorite removed during drag cannot be reordered back into membership',()=>{
  const f=domFixture();f.fire('dragstart',f.row('a').handle,{dataTransfer:f.transfer()});
  f.run("favorites.delete('a')");f.fire('drop',f.row('b'));f.fire('dragend',f.row('a').handle);
  assert.equal(f.writes.length,0);assert.deepEqual(f.ids(),['b','c']);
});
test('handle clicks and post-drag pointer click cannot select or play a station',()=>{
  const f=domFixture();assert.equal(f.listeners.get('click').capture,true);
  assert.equal(f.fire('click',f.row('a').handle,{detail:1}).stopped,true);
  f.drag('a','c',true);
  assert.equal(f.fire('click',f.row('c').button,{detail:1}).stopped,true);
  assert.deepEqual(f.calls.selected,[]);
  f.advance(251);f.fire('click',f.row('c').button,{detail:1});
  assert.deepEqual(f.calls.selected,['c']);
});
test('ordinary pointer/tap and keyboard station activation remain available',()=>{
  const f=domFixture();f.fire('click',f.row('a').button,{detail:1});
  f.drag('a','c',true);f.fire('click',f.row('b').button,{detail:0});
  assert.deepEqual(f.calls.selected,['a','b']);
  assert.equal(f.fire('keydown',f.row('b').button,{key:'ArrowDown'}).prevented,false);
});
test('keyboard handle reordering persists, restores focus, announces, and respects edges',()=>{
  const f=domFixture();
  f.fire('keydown',f.row('a').handle,{key:'ArrowDown'});assert.deepEqual(f.domIds(),['b','a','c']);
  assert.equal(f.focused(),f.row('a').handle);assert.equal(f.status.textContent,'Favorites order saved.');
  f.fire('keydown',f.row('a').handle,{key:'ArrowUp'});assert.deepEqual(f.domIds(),['a','b','c']);
  const count=f.writes.length;
  f.fire('keydown',f.row('a').handle,{key:'ArrowUp'});
  f.fire('keydown',f.row('c').handle,{key:'ArrowDown'});assert.equal(f.writes.length,count);
  for(const key of ['Tab','Enter',' ']) assert.equal(f.fire('keydown',f.row('a').handle,{key}).prevented,false);
  assert.deepEqual(f.calls.selected,[]);
});
test('DOM order falls back safely when saving a drag fails',()=>{
  const f=domFixture({raw:'["c","a","b"]',writeFail:ORDER});
  f.drag('b','c');assert.deepEqual(f.domIds(),['a','b','c']);
  assert.match(f.status.textContent,/Order not saved/);assert.deepEqual(f.calls.selected,[]);
});
test('source contracts keep order controls isolated from catalog, transport and networking',()=>{
  assert.match(html,/favorites = loadFavorites\(\)/);
  assert.match(html,/initFavoriteReorder\(\);\nlet _searchTimer/);
  assert.match(html,/<div id="favoriteOrderStatus" role="status" aria-live="polite">/);
  assert.match(html,/#favoriteList \.favorite-drag:focus-visible/);
  assert.doesNotMatch(eventsCode,/\b(?:fetch|select|toggleFav|saveFav|renderLists|bindArt|playCurrent)\s*\(|touch-action|pointerdown|touchstart/);
  assert.doesNotMatch(eventsCode,/favorites\.(?:add|delete|clear)\(/);
  assert.match(html,/function favStations\(\)\{ return STATIONS\.filter\(s=>favorites\.has\(s\.id\)\); \}/);
  assert.match(html,/\$\('#cards'\)\.onclick=e=>\{let f=e\.target\.closest\('\[data-fav\]'\);/);
});
console.log(`ALL ${passed} FAVORITES ORDER TESTS PASSED`);
