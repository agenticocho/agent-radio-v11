(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AgentRadioMusicalVocabulary = api;
  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => api.mount());
    } else api.mount();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const INTERVALS = ['P1','m2','M2','m3','M3','P4','TT','P5','m6','M6','m7','M7'];
  const INTERVAL_NAMES = ['unison','minor second','major second','minor third','major third','perfect fourth','tritone','perfect fifth','minor sixth','major sixth','minor seventh','major seventh'];

  function dynamicMark(rms) {
    if (!Number.isFinite(rms) || rms < 0.0003) return null;
    if (rms < 0.001) return 'pp';
    if (rms < 0.003) return 'p';
    if (rms < 0.008) return 'mp';
    if (rms < 0.015) return 'mf';
    if (rms < 0.030) return 'f';
    if (rms < 0.060) return 'ff';
    return 'fff';
  }

  function tempoTerm(bpm) {
    if (!Number.isFinite(bpm) || bpm <= 0) return null;
    if (bpm < 40) return 'Grave';
    if (bpm < 60) return 'Largo';
    if (bpm < 76) return 'Adagio';
    if (bpm < 108) return 'Andante';
    if (bpm < 120) return 'Moderato';
    if (bpm < 156) return 'Allegro';
    if (bpm < 176) return 'Vivace';
    if (bpm < 200) return 'Presto';
    return 'Prestissimo';
  }

  function registerName(centroid) {
    if (!Number.isFinite(centroid)) return null;
    if (centroid < 250) return 'bass';
    if (centroid < 500) return 'tenor';
    if (centroid < 900) return 'alto';
    if (centroid < 1800) return 'soprano';
    return 'treble';
  }

  function intervalInfo(peaks) {
    if (!Array.isArray(peaks) || peaks.length < 2) return null;
    const a = peaks[0]?.midi, b = peaks[1]?.midi;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const semitones = ((Math.round(Math.abs(a - b)) % 12) + 12) % 12;
    return { code: INTERVALS[semitones], name: INTERVAL_NAMES[semitones], semitones };
  }

  function consonanceWord(value) {
    if (!Number.isFinite(value)) return null;
    if (value >= 0.80) return 'consonant';
    if (value >= 0.60) return 'mild tension';
    if (value >= 0.40) return 'dissonant';
    return 'sharp dissonance';
  }

  function textureName(state) {
    const n = Array.isArray(state?.peaks) ? state.peaks.length : 0;
    const cx = state?.complexity;
    if (!n) return null;
    if (n === 1) return 'monophonic';
    if (Number.isFinite(cx) && cx >= 0.55) return 'polyphonic';
    return 'harmonic texture';
  }

  
  function overlayGenreFamily(state){return ['classical','electronic','ambient','jazz','rock','soul','folk','global','spoken'].includes(state?.genreFamily)?state.genreFamily:'other';}
  function stableVariant(state,field,values){if(!Array.isArray(values)||!values.length)return null;const key=String(state?.trackKey||state?.stationId||'agent-radio')+'|'+field;let h=2166136261;for(let i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,16777619);}return values[(h>>>0)%values.length];}
  function spectrumDescriptor(state){const hz=state?.spectralCentroidHz;if(!Number.isFinite(hz))return null;const f=overlayGenreFamily(state),b=hz<500?'low':hz<1200?'mid':'high';const tables={classical:{low:['low-register weight','dark spectral centre'],mid:['middle-register focus','balanced spectral centre'],high:['upper-register sheen','bright spectral centre']},electronic:{low:['dark spectrum','low-frequency weight'],mid:['balanced spectrum','mid-band focus'],high:['bright spectrum','high-frequency sheen']},other:{low:['dark spectrum'],mid:['balanced spectrum'],high:['bright spectrum']}};return stableVariant(state,'spectrum-'+b,tables[f][b]);}
  function textureEvidence(state){const n=Array.isArray(state?.peaks)?state.peaks.length:0,cx=Number.isFinite(state?.complexity)?state.complexity:null,h=Number.isFinite(state?.harmonicEntropy)?Math.max(0,Math.min(1,state.harmonicEntropy/Math.log2(14))):null;if(!n)return {bucket:null,score:null};const peakScore=Math.max(0,Math.min(1,(n-1)/5)),diversity=h??.5,complexity=cx??.5,score=.45*peakScore+.35*diversity+.20*complexity;return {bucket:score>=.72?'dense':score>=.42?'layered':'spare',score};}
  function genreTexture(state){const e=textureEvidence(state);if(!e.bucket)return null;const f=overlayGenreFamily(state),b=e.bucket;const tables={classical:{spare:['single-line focus','open sonority'],layered:['layered sonority','interwoven spectrum'],dense:['dense sonority','full spectral weave']},electronic:{spare:['sparse electronic texture','open electronic bed'],layered:['layered electronic texture','stacked electronic field'],dense:['dense electronic texture','saturated electronic field']},other:{spare:['sparse texture'],layered:['layered texture'],dense:['dense texture']}};return stableVariant(state,'texture-'+b,tables[f][b]);}
  function genreDynamic(state){const rms=state?.rms,slope=state?.rmsSlope;if(!Number.isFinite(rms)||rms<.0003)return null;const m=Number.isFinite(slope)&&slope>.001?'rising':Number.isFinite(slope)&&slope<-.001?'settling':'steady',f=overlayGenreFamily(state);const tables={classical:{rising:['growing contour','dynamic lift'],settling:['receding contour','dynamic release'],steady:['sustained contour','even dynamic plane']},electronic:{rising:['building energy','level rising'],settling:['energy release','level easing'],steady:['steady energy','level holding']},other:{rising:['level rising'],settling:['level easing'],steady:['level holding']}};return stableVariant(state,'dynamic-'+m,tables[f][m]);}
  function genreTempoTerm(state,bpm){if(!Number.isFinite(bpm)||bpm<=0)return null;const f=overlayGenreFamily(state);if(f==='classical')return tempoTerm(bpm);if(f==='electronic')return bpm<75?'slow pulse':bpm<110?'midtempo pulse':bpm<145?'driving pulse':'fast pulse';return bpm<75?'slow pulse':bpm<120?'moderate pulse':'fast pulse';}

function viewModel(state) {
    if (!state || state.schemaVersion !== 'radio-analysis-state-v1') return null;
    const keyVisible = Number.isFinite(state.keyConfidence) && state.keyConfidence >= 0.55 && state.key && state.mode;
    const bpmVisible = Number.isFinite(state.bpmConfidence) && state.bpmConfidence >= 0.50 && Number.isFinite(state.bpm);
    const familyVisible = Array.isArray(state.tempoFamily) && state.tempoFamily.length > 0 && Number.isFinite(state.tempoFamilyConfidence) && state.tempoFamilyConfidence >= 0.28;
    const iv = intervalInfo(state.peaks);
    return {
      note: state.dominantNote && Number.isInteger(state.dominantOctave) ? `${state.dominantNote}${state.dominantOctave}` : '—',
      frequency: Number.isFinite(state.dominantFrequencyHz) ? `${state.dominantFrequencyHz.toFixed(0)} Hz` : '—',
      key: keyVisible ? `${state.key} ${state.mode}` : 'key gathering…',
      keyConfidence: keyVisible ? state.keyConfidence : null,
      bpm: familyVisible ? (state.tempoFamily.length > 1 ? '≈ ' + state.tempoFamily.map(v=>Math.round(v)).join(' / ') : '≈ ' + Math.round(state.tempoFamily[0])) : (bpmVisible ? String(Math.round(state.bpm)) : null),
      tempo: bpmVisible ? genreTempoTerm(state,state.bpm) : 'tempo gathering',
      dynamic: genreDynamic(state) || 'silence',
      register: spectrumDescriptor(state) || '—',
      interval: iv ? `${iv.code} · ${iv.name}` : '—',
      consonance: consonanceWord(state.consonance) || '—',
      texture: genreTexture(state) || '—',
      complexity: Number.isFinite(state.complexity) ? state.complexity : 0,
      stationId: state.stationId || 'no station',
      genreFamily:overlayGenreFamily(state),trackKey:state.trackKey||null
    };
  }

  function extendedGenreWords(vm,state){if(!vm)return vm;const f=vm.genreFamily,map={rock:{dynamic:'driving force',texture:'weighted texture',register:'spectral attack'},jazz:{dynamic:'rhythmic elasticity',texture:'interwoven phrasing',register:'harmonic color'},ambient:{dynamic:'slow drift',texture:'suspended field',register:'spectral space'},soul:{dynamic:'dynamic lift',texture:'warm groove field',register:'tonal warmth'},folk:{dynamic:'open contour',texture:'intimate texture',register:'open spectrum'},global:{dynamic:'cyclical motion',texture:'ensemble density',register:'pulse spectrum'},spoken:{dynamic:'non-musical source',texture:'interpretation unavailable',register:'speech spectrum'}};return map[f]?{...vm,...map[f]}:vm;}
  let mounted = false;
  let open = false;
  let lastState = null;
  let priorFocus = null;
  let elements = null;
  let heldWords = {}, heldTrack = null; const WORD_HOLD_MS = 6000;
  function holdWord(field,value,state,now=Date.now()){const track=state?.trackKey||state?.stationId||null;if(track!==heldTrack){heldTrack=track;heldWords={};}const prior=heldWords[field];if(!prior||(prior.value!==value&&now-prior.at>=WORD_HOLD_MS))heldWords[field]={value,at:now};return heldWords[field]?.value??value;}

  function styles() {
    return `
#ar-analysis-launch{position:fixed;right:18px;bottom:112px;z-index:900;border:1px solid #2a2e34;background:#121417;color:#c5cad0;border-radius:999px;padding:9px 14px;font:600 12px/1 Inter,system-ui,sans-serif;letter-spacing:.04em;cursor:pointer;box-shadow:0 8px 24px #0008}
#ar-analysis-launch:hover,#ar-analysis-launch:focus-visible{border-color:#2dd4bf;color:#2dd4bf;outline:none}
#ar-analysis-deck{position:fixed;inset:0;z-index:9500;background:#070707;color:#e8e0d0;font-family:"EB Garamond",Georgia,serif;overflow:hidden;opacity:0;pointer-events:none;transition:opacity .35s ease}
#ar-analysis-deck.open{opacity:1;pointer-events:auto}
#ar-analysis-deck .arv-head{position:absolute;left:24px;right:24px;top:18px;display:flex;align-items:center;justify-content:space-between;z-index:3}
#ar-analysis-deck .arv-brand{font:400 12px/1.2 "JetBrains Mono",monospace;color:#5b626b;letter-spacing:.12em;text-transform:uppercase}
#ar-analysis-deck .arv-close{border:1px solid #25282d;background:#101215;color:#aeb4bc;width:38px;height:38px;border-radius:50%;font-size:20px;cursor:pointer}
#ar-analysis-deck .arv-close:hover,#ar-analysis-deck .arv-close:focus-visible{border-color:#2dd4bf;color:#2dd4bf;outline:none}
#ar-analysis-deck .arv-stage{position:absolute;inset:72px 5vw 54px;display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr;gap:20px;align-items:center}
#ar-analysis-deck .arv-cell{min-width:0;text-align:center;opacity:.88;transition:opacity .7s ease,transform .7s cubic-bezier(.16,1,.3,1);transform:translateY(0)}
#ar-analysis-deck .arv-label{font:300 10px/1.2 "JetBrains Mono",monospace;color:#4d535b;letter-spacing:.13em;text-transform:uppercase;margin-bottom:8px}
#ar-analysis-deck .arv-value{font-size:clamp(24px,3.4vw,56px);line-height:1;color:#e8e0d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ar-analysis-deck .arv-value.hero{font-size:clamp(54px,9vw,144px);font-weight:600;color:#f2eee5}
#ar-analysis-deck .arv-value.accent{color:#c8705a;font-style:italic}
#ar-analysis-deck .arv-value.cool{color:#7a9db8}
#ar-analysis-deck .arv-value.green{color:#5a8c6a;font-style:italic}
#ar-analysis-deck .arv-sub{font:300 11px/1.4 "JetBrains Mono",monospace;color:#555c65;margin-top:8px;letter-spacing:.04em}
#ar-analysis-deck .arv-foot{position:absolute;bottom:16px;left:24px;right:24px;display:flex;justify-content:space-between;font:300 10px/1 "JetBrains Mono",monospace;color:#353a40;letter-spacing:.05em}
#ar-analysis-deck .arv-ghost{position:absolute;inset:0;display:grid;place-items:center;font-size:min(42vw,560px);font-weight:700;color:#0f1012;pointer-events:none;user-select:none}
@media(max-width:760px){#ar-analysis-deck .arv-stage{grid-template-columns:1fr 1fr;grid-template-rows:repeat(3,1fr);inset:66px 18px 48px;gap:10px}#ar-analysis-deck .arv-value{font-size:clamp(20px,6vw,38px)}#ar-analysis-deck .arv-value.hero{font-size:clamp(48px,15vw,92px)}}
@media(prefers-reduced-motion:reduce){#ar-analysis-deck{transition:none}#ar-analysis-deck .arv-cell{transition:none}}
`;
  }

  function mount() {
    if (mounted || !root.document) return;
    mounted = true;
    const style = document.createElement('style');
    style.id = 'ar-analysis-styles';
    style.textContent = styles();
    document.head.appendChild(style);

    const launch = document.createElement('button');
    launch.id = 'ar-analysis-launch';
    launch.type = 'button';
    launch.textContent = 'Analysis';
    launch.setAttribute('aria-haspopup', 'dialog');
    launch.setAttribute('aria-controls', 'ar-analysis-deck');

    const deck = document.createElement('section');
    deck.id = 'ar-analysis-deck';
    deck.setAttribute('role', 'dialog');
    deck.setAttribute('aria-modal', 'true');
    deck.setAttribute('aria-label', 'Agent Radio musical vocabulary');
    deck.innerHTML = `
      <div class="arv-ghost" id="arv-ghost">—</div>
      <div class="arv-head"><div class="arv-brand">Agent Radio · Musical Vocabulary</div><button class="arv-close" type="button" aria-label="Close analysis">×</button></div>
      <div class="arv-stage">
        <div class="arv-cell"><div class="arv-label">dominant</div><div class="arv-value hero" id="arv-note">—</div><div class="arv-sub" id="arv-frequency">—</div></div>
        <div class="arv-cell"><div class="arv-label">tonal centre</div><div class="arv-value accent" id="arv-key">key gathering…</div><div class="arv-sub" id="arv-keyconf">confidence —</div></div>
        <div class="arv-cell"><div class="arv-label">interval</div><div class="arv-value cool" id="arv-interval">—</div><div class="arv-sub" id="arv-texture">—</div></div>
        <div class="arv-cell"><div class="arv-label">dynamic</div><div class="arv-value green" id="arv-dynamic">silence</div><div class="arv-sub" id="arv-register">—</div></div>
        <div class="arv-cell"><div class="arv-label">tempo</div><div class="arv-value" id="arv-tempo">tempo gathering…</div><div class="arv-sub" id="arv-bpm">BPM —</div></div>
        <div class="arv-cell"><div class="arv-label">harmony</div><div class="arv-value" id="arv-consonance">—</div><div class="arv-sub" id="arv-complexity">complexity —</div></div>
      </div>
      <div class="arv-foot"><span id="arv-station">no station</span><span>browser-audio estimate · heuristic labels · major/minor only</span></div>`;

    document.body.append(launch, deck);
    elements = {
      launch, deck, close: deck.querySelector('.arv-close'),
      note: deck.querySelector('#arv-note'), ghost: deck.querySelector('#arv-ghost'), frequency: deck.querySelector('#arv-frequency'),
      key: deck.querySelector('#arv-key'), keyconf: deck.querySelector('#arv-keyconf'), interval: deck.querySelector('#arv-interval'),
      texture: deck.querySelector('#arv-texture'), dynamic: deck.querySelector('#arv-dynamic'), register: deck.querySelector('#arv-register'),
      tempo: deck.querySelector('#arv-tempo'), bpm: deck.querySelector('#arv-bpm'), consonance: deck.querySelector('#arv-consonance'),
      complexity: deck.querySelector('#arv-complexity'), station: deck.querySelector('#arv-station')
    };
    launch.addEventListener('click', show);
    elements.close.addEventListener('click', hide);
    root.addEventListener('agent-radio-analysis', event => render(event.detail));
    root.addEventListener('agent-radio-analysis-reset', event => render(event.detail?.state));
    document.addEventListener('keydown', event => { if (open && event.key === 'Escape') hide(); });
    render(root.agentRadioAnalysis?.getState?.() || null);
  }

  function show() {
    if (!elements) return;
    priorFocus = document.activeElement;
    open = true;
    elements.deck.classList.add('open');
    elements.launch.setAttribute('aria-expanded', 'true');
    elements.close.focus();
  }

  function hide() {
    if (!elements) return;
    open = false;
    elements.deck.classList.remove('open');
    elements.launch.setAttribute('aria-expanded', 'false');
    if (priorFocus && typeof priorFocus.focus === 'function') priorFocus.focus();
  }

  function set(el, value) {
    const next = value == null ? '—' : String(value);
    if (el && el.textContent !== next) el.textContent = next;
  }

  function render(state) {
    lastState = state || null;
    if (!elements) return null;
    let vm = extendedGenreWords(viewModel(state),state);
    if(vm)vm={...vm,dynamic:holdWord('dynamic',vm.dynamic,state),register:holdWord('register',vm.register,state),texture:holdWord('texture',vm.texture,state),tempo:holdWord('tempo',vm.tempo,state)};
    if (!vm) {
      set(elements.note, '—'); set(elements.ghost, '—'); set(elements.frequency, '—');
      set(elements.key, 'key gathering…'); set(elements.keyconf, 'confidence —');
      set(elements.interval, '—'); set(elements.texture, '—'); set(elements.dynamic, 'silence');
      set(elements.register, '—'); set(elements.tempo, 'tempo gathering…'); set(elements.bpm, 'BPM —');
      set(elements.consonance, '—'); set(elements.complexity, 'complexity —'); set(elements.station, 'no station');
      return null;
    }
    set(elements.note, vm.note); set(elements.ghost, vm.note === '—' ? '—' : vm.note.replace(/-?\d+$/, ''));
    set(elements.frequency, vm.frequency); set(elements.key, vm.key);
    set(elements.keyconf, vm.keyConfidence == null ? 'confidence —' : `confidence ${Math.round(vm.keyConfidence * 100)}%`);
    set(elements.interval, vm.interval); set(elements.texture, vm.texture);
    set(elements.dynamic, vm.dynamic); set(elements.register, vm.register);
    set(elements.tempo, vm.tempo); set(elements.bpm, vm.bpm == null ? 'BPM —' : `BPM ${vm.bpm}`);
    set(elements.consonance, vm.consonance); set(elements.complexity, `complexity ${Math.round(vm.complexity * 100)}%`);
    set(elements.station, vm.stationId);
    return vm;
  }

  return { dynamicMark, tempoTerm, registerName, intervalInfo, consonanceWord, textureName, textureEvidence, holdWord, extendedGenreWords, viewModel, mount, show, hide, render, get lastState() { return lastState; } };
});
