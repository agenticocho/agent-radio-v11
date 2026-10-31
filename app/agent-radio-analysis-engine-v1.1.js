(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AgentRadioAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 'radio-analysis-state-v1';
  const FFT_SIZE = 8192;
  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const MODE_PROFILES = {
    major: [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],
    minor: [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const finiteOrNull = v => Number.isFinite(v) ? v : null;
  const midiFromHz = hz => 69 + 12 * Math.log2(hz / 440);
  const pitchClass = midi => ((Math.round(midi) % 12) + 12) % 12;
  const noteName = midi => NOTE_NAMES[pitchClass(midi)];
  const octave = midi => Math.floor(Math.round(midi) / 12) - 1;

  function createState(meta = {}) {
    return {
      schemaVersion: SCHEMA_VERSION,
      timestampMs: Number.isFinite(meta.timestampMs) ? meta.timestampMs : 0,
      stationId: meta.stationId ?? null,
      trackKey: meta.trackKey ?? null,
      genreFamily: typeof meta.genreFamily === 'string' ? meta.genreFamily : 'unknown',
      genreLabel: typeof meta.genreLabel === 'string' ? meta.genreLabel : null,
      sampleRate: Number.isFinite(meta.sampleRate) ? meta.sampleRate : 48000,
      fftSize: FFT_SIZE,
      rms: 0,
      rmsSlope: 0,
      peak: 0,
      dominantFrequencyHz: null,
      dominantNote: null,
      dominantOctave: null,
      spectralCentroidHz: null,
      zeroCrossingRate: null,
      peaks: [],
      chroma: new Array(12).fill(0),
      key: null,
      mode: null,
      keyConfidence: null,
      bpm: null,
      bpmConfidence: null,
      consonance: null,
      complexity: null,
      harmonicEntropy: null,
      modulation: null,
      longWindow: {
        dfaAlpha: null,
        oneFExponent: null,
        pitchFractalDimension: null,
        observationSeconds: 0,
        confidence: null
      }
    };
  }

  function validateState(s) {
    const errors = [];
    if (!s || typeof s !== 'object') return { ok: false, errors: ['state must be an object'] };
    if (s.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion');
    if (s.fftSize !== FFT_SIZE) errors.push('fftSize');
    if (!Number.isFinite(s.sampleRate) || s.sampleRate <= 0) errors.push('sampleRate');
    if (!Array.isArray(s.peaks)) errors.push('peaks');
    if (!Array.isArray(s.chroma) || s.chroma.length !== 12) errors.push('chroma');
    if (!s.longWindow || typeof s.longWindow !== 'object') errors.push('longWindow');
    for (const k of ['rms','rmsSlope','peak']) {
      if (!Number.isFinite(s[k])) errors.push(k);
    }
    for (const k of ['keyConfidence','bpmConfidence','consonance','complexity']) {
      if (s[k] !== null && (!Number.isFinite(s[k]) || s[k] < 0 || s[k] > 1)) errors.push(k);
    }
    return { ok: errors.length === 0, errors };
  }

  function pearson(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < 12; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      dot += x * y; aa += x * x; bb += y * y;
    }
    return dot / Math.sqrt(aa * bb + 1e-12);
  }

  function detectKeyMode(chroma) {
    const total = chroma.reduce((a, b) => a + b, 0);
    if (total <= 1e-10) return { key: null, mode: null, confidence: null, score: null };
    const ranked = [];
    for (let root = 0; root < 12; root++) {
      for (const [mode, profile] of Object.entries(MODE_PROFILES)) {
        const rotated = new Array(12);
        for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + root) % 12];
        ranked.push({ root, mode, score: pearson(rotated, profile) });
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    const best = ranked[0], second = ranked[1];
    const confidence = clamp((best.score + 1) / 2 * 0.75 + clamp(best.score - second.score, 0, 0.25), 0, 1);
    return { key: NOTE_NAMES[best.root], mode: best.mode, confidence, score: best.score };
  }

  function extractPeaks(frequencyDb, sampleRate, fftSize = FFT_SIZE, opts = {}) {
    const lowHz = opts.lowHz ?? 55;
    const highHz = opts.highHz ?? 4200;
    const thresholdDb = opts.thresholdDb ?? -62;
    const maxPeaks = opts.maxPeaks ?? 6;
    const binHz = sampleRate / fftSize;
    const lo = Math.max(2, Math.floor(lowHz / binHz));
    const hi = Math.min(frequencyDb.length - 2, Math.ceil(highHz / binHz));
    const raw = [];
    for (let k = lo; k <= hi; k++) {
      const beta = frequencyDb[k];
      if (!Number.isFinite(beta) || beta < thresholdDb) continue;
      if (!(beta > frequencyDb[k - 1] && beta >= frequencyDb[k + 1])) continue;
      const alpha = frequencyDb[k - 1], gamma = frequencyDb[k + 1];
      const denom = alpha - 2 * beta + gamma;
      const offset = Math.abs(denom) > 1e-12 ? 0.5 * (alpha - gamma) / denom : 0;
      const hz = (k + clamp(offset, -1, 1)) * binHz;
      const db = beta - 0.25 * (alpha - gamma) * offset;
      const midi = midiFromHz(hz);
      raw.push({ frequencyHz: hz, db, midi, pitchClass: pitchClass(midi) });
    }
    raw.sort((a, b) => b.db - a.db);
    const kept = [];
    for (const p of raw) {
      if (kept.some(q => Math.abs(p.midi - q.midi) < 1.8)) continue;
      kept.push(p);
      if (kept.length === maxPeaks) break;
    }
    return kept;
  }

  function spectralCentroid(frequencyDb, sampleRate, fftSize = FFT_SIZE, lowHz = 55, highHz = 4200) {
    const binHz = sampleRate / fftSize;
    const lo = Math.max(1, Math.floor(lowHz / binHz));
    const hi = Math.min(frequencyDb.length - 1, Math.ceil(highHz / binHz));
    let weighted = 0, total = 0;
    for (let k = lo; k <= hi; k++) {
      const mag = Math.pow(10, frequencyDb[k] / 20);
      if (!Number.isFinite(mag)) continue;
      weighted += k * binHz * mag;
      total += mag;
    }
    return total > 1e-12 ? weighted / total : null;
  }

  function chromaFromPeaks(peaks) {
    const out = new Array(12).fill(0);
    for (const p of peaks) out[p.pitchClass] += Math.pow(10, p.db / 20);
    return out;
  }

  function consonance(peaks) {
    if (peaks.length < 2) return null;
    let sum = 0, count = 0;
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const semis = Math.abs(peaks[i].midi - peaks[j].midi);
        const pc = ((Math.round(semis) % 12) + 12) % 12;
        const weights = [1,.1,.25,.5,.8,.6,.2,1,.65,.75,.5,.4];
        sum += weights[pc]; count++;
      }
    }
    return count ? clamp(sum / count, 0, 1) : null;
  }

  function harmonicEntropy(peaks) {
    if (peaks.length < 3) return null;
    const bins = new Array(14).fill(0);
    let total = 0;
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const ratio = Math.log2(Math.max(peaks[i].frequencyHz, peaks[j].frequencyHz) /
                                Math.min(peaks[i].frequencyHz, peaks[j].frequencyHz));
        bins[Math.min(13, Math.floor(ratio / 0.0833))]++;
        total++;
      }
    }
    if (!total) return null;
    let h = 0;
    for (const n of bins) if (n) { const p = n / total; h -= p * Math.log2(p); }
    return h;
  }

  function timeMetrics(timeDomain) {
    if (!timeDomain || !timeDomain.length) return { rms: 0, peak: 0, zcr: null };
    let sum = 0, peak = 0, crossings = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const v = timeDomain[i];
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
      if (i && ((v >= 0) !== (timeDomain[i - 1] >= 0))) crossings++;
    }
    return { rms: Math.sqrt(sum / timeDomain.length), peak, zcr: crossings / timeDomain.length };
  }


  function normalizeTempoBpm(bpm) {
    if (!Number.isFinite(bpm) || bpm <= 0) return null;
    while (bpm < 50) bpm *= 2;
    while (bpm > 190) bpm /= 2;
    return bpm;
  }
  function median(values) { const a=values.slice().sort((x,y)=>x-y); return a.length?a[Math.floor(a.length/2)]:null; }
  function estimateTempoFromOnsets(onsets, minBpm=50, maxBpm=190) {
    const count=Array.isArray(onsets)?onsets.length:0;
    if(count<7)return {bpm:null,confidence:null,method:'gathering',onsetCount:count,windowSeconds:0,octaveAmbiguous:false,evidenceGate:'onsets'};
    const clean=onsets.filter(Number.isFinite).sort((a,b)=>a-b),intervals=[];
    for(let i=1;i<clean.length;i++){const d=clean[i]-clean[i-1];if(d>=250&&d<=2400)intervals.push(d);}
    const window=Math.max(0,(clean.at(-1)-clean[0])/1000);
    if(intervals.length<6||window<3)return {bpm:null,confidence:null,method:'gathering',onsetCount:clean.length,windowSeconds:window,octaveAmbiguous:false,evidenceGate:intervals.length<6?'intervals':'window'};
    const med=median(intervals),rel=intervals.map(d=>Math.abs(d-med)/med),mad=median(rel),directSupport=rel.filter(e=>e<=.15).length/rel.length;
    if(directSupport<.60||mad>.18)return {bpm:null,confidence:null,method:'gathering',onsetCount:clean.length,windowSeconds:window,octaveAmbiguous:false,evidenceGate:'consistency',directSupport,mad};
    const direct=60000/med,half=med/2,twice=med*2,subdivisionSupport=intervals.filter(d=>Math.abs(d-half)/half<=.12).length/intervals.length,alternateSupport=intervals.filter(d=>Math.abs(d-twice)/twice<=.12).length/intervals.length;
    let bpm=direct,method='direct-median-onsets',octaveAmbiguous=false;
    if(subdivisionSupport>=.35&&direct<95){bpm=direct*2;method='subdivision-supported-double-time';}
    else if(alternateSupport>=.35&&direct>150){bpm=direct/2;method='alternate-supported-half-time';}
    else if((direct<70&&subdivisionSupport>.15)||(direct>150&&alternateSupport>.15))octaveAmbiguous=true;
    bpm=normalizeTempoBpm(bpm);const coverage=Math.min(1,intervals.length/14);let confidence=Math.max(0,1-mad*5)*.58+directSupport*.22+coverage*.14+Math.min(1,window/14)*.06;
    if(octaveAmbiguous)confidence=Math.min(confidence,.49);
    if(confidence<.42)bpm=null;
    return {bpm,confidence:bpm===null?null:Math.min(1,confidence),method:bpm===null?'gathering':method,onsetCount:clean.length,windowSeconds:window,octaveAmbiguous,evidenceGate:bpm===null?'confidence':'passed',directSupport,mad};
  }
  function spectralFlux(currentDb, previousDb) {
    if(!currentDb||!previousDb||currentDb.length!==previousDb.length)return 0;let sum=0,count=0;const hi=Math.min(currentDb.length,720);
    for(let i=8;i<hi;i+=3){const a=Math.pow(10,currentDb[i]/20),b=Math.pow(10,previousDb[i]/20),d=a-b;if(d>0)sum+=d;count++;}return count?sum/count:0;
  }


  function estimateTempoHarmonicAutocorrelation(samples, cadenceMs = 50, minBpm = 50, maxBpm = 190) {
    if(!Array.isArray(samples)||samples.length<160)return {bpm:null,confidence:null,method:'continuous-autocorr-gathering',evidenceGate:'window',windowSeconds:(samples?.length||0)*cadenceMs/1000};
    const x=samples.slice(-600),mean=x.reduce((a,b)=>a+b,0)/x.length,v=x.map(q=>q-mean),energy=v.reduce((a,q)=>a+q*q,0);
    if(energy<1e-12)return {bpm:null,confidence:null,method:'continuous-autocorr-gathering',evidenceGate:'energy',windowSeconds:x.length*cadenceMs/1000};
    function at(pos){const lo=Math.floor(pos),f=pos-lo;if(lo<0||lo+1>=v.length)return 0;return v[lo]*(1-f)+v[lo+1]*f;}
    function corr(lag){let dot=0,a2=0,b2=0,n=0;for(let i=Math.ceil(lag)+1;i<v.length;i++){const a=v[i],b=at(i-lag);dot+=a*b;a2+=a*a;b2+=b*b;n++;}return n?dot/Math.sqrt(a2*b2+1e-20):0;}function integerCorr(lag){lag=Math.max(1,Math.round(lag));if(lag>=x.length-2)return 0;const n=x.length-lag,ma=x.slice(0,n).reduce((a,b)=>a+b,0)/n,mb=x.slice(lag).reduce((a,b)=>a+b,0)/n;let dot=0,a2=0,b2=0;for(let i=0;i<n;i++){const a=x[i]-ma,b=x[i+lag]-mb;dot+=a*b;a2+=a*a;b2+=b*b;}return dot/Math.sqrt(a2*b2+1e-15);}
    const minLag=60000/(maxBpm*cadenceMs),maxLag=60000/(minBpm*cadenceMs),step=.10,candidates=[];
    for(let lag=minLag;lag<=maxLag+1e-9;lag+=step){const fundamental=corr(lag),twice=corr(lag*2),half=lag/2>=2?corr(lag/2):0,family=.70*fundamental+.20*Math.max(0,twice)+.10*Math.max(0,half);candidates.push({lag,fundamental,twice,half,family});}
    candidates.sort((a,b)=>b.family-a.family);const top=candidates[0],related=q=>Math.abs(q.lag-top.lag)<=1.6||Math.abs(q.lag-top.lag*2)<=1.6||Math.abs(q.lag*2-top.lag)<=1.6;
    const neighborhood=candidates.filter(q=>Math.abs(q.lag-top.lag)<=1.25&&q.family>=top.family-Math.max(.025,Math.abs(top.family)*.16));let ws=0,ls=0;for(const q of neighborhood){const w=Math.exp((q.family-top.family)*18);ws+=w;ls+=w*q.lag;}const lag=ws?ls/ws:top.lag;
    const background=candidates.filter(q=>!related(q)).slice(0,12).map(q=>q.family),bg=background.length?background.reduce((a,b)=>a+b,0)/background.length:0,prominence=top.family-bg;
    let rawBpm=normalizeTempoBpm(60000/(lag*cadenceMs));const relatedRaw=rawBpm===null?null:(rawBpm<100?rawBpm*2:rawBpm/2),rawFamily=rawBpm===null?[]:[rawBpm,...(relatedRaw>=50&&relatedRaw<=190?[relatedRaw]:[])].map(v=>Math.round(v*10)/10).filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);let bpm=rawBpm;const confidence=Math.max(0,Math.min(1,top.family*.70+prominence*.62+Math.min(1,x.length/400)*.08));const tempoFamilyConfidence=Math.max(0,Math.min(1,top.family*.78+prominence*.42)),localPeakSharpness=integerCorr(lag)-(integerCorr(lag-1)+integerCorr(lag+1))/2,familyVisible=top.family>=.17&&prominence>=.08&&tempoFamilyConfidence>=.18&&localPeakSharpness>=.08,tempoFamily=familyVisible?rawFamily:[],metricalLevel=tempoFamily.length>1?'ambiguous':'stable';if(top.family<.13||prominence<.022||confidence<.38)bpm=null;
    return {bpm,confidence:bpm===null?null:confidence,method:bpm===null?'continuous-autocorr-gathering':'continuous-harmonic-autocorrelation',evidenceGate:bpm===null?'prominence':'passed',peak:top.fundamental,familyScore:top.family,prominence,lag,integerBestLag:top.lag,neighborhoodCount:neighborhood.length,windowSeconds:x.length*cadenceMs/1000,cadenceMs,tempoFamily,tempoFamilyConfidence,localPeakSharpness,metricalLevel,familyVisible,rawBpm};
  }

  function resolveTempoPresentation(chosen, harmonicTempo, bpm) {
    const harmonicFamily=Array.isArray(harmonicTempo?.tempoFamily)?harmonicTempo.tempoFamily.filter(Number.isFinite):[];
    const chosenFamily=Array.isArray(chosen?.tempoFamily)?chosen.tempoFamily.filter(Number.isFinite):[];
    if(harmonicFamily.length)return {family:harmonicFamily.slice(),confidence:Number.isFinite(harmonicTempo.tempoFamilyConfidence)?harmonicTempo.tempoFamilyConfidence:null,metricalLevel:harmonicTempo.metricalLevel||'ambiguous',sharpness:Number.isFinite(harmonicTempo.localPeakSharpness)?harmonicTempo.localPeakSharpness:null,source:'harmonic-family'};
    if(chosenFamily.length)return {family:chosenFamily.slice(),confidence:Number.isFinite(chosen.tempoFamilyConfidence)?chosen.tempoFamilyConfidence:null,metricalLevel:chosen.metricalLevel||'stable',sharpness:Number.isFinite(chosen.localPeakSharpness)?chosen.localPeakSharpness:null,source:'chosen-family'};
    return {family:Number.isFinite(bpm)?[Math.round(bpm*10)/10]:[],confidence:null,metricalLevel:'stable',sharpness:null,source:Number.isFinite(bpm)?'singular-fallback':'gathering'};
  }

  class AnalysisEngine {
    constructor(options = {}) {
      this.options = {
        chromaDecay: options.chromaDecay ?? 0.96,
        rmsSmoothing: options.rmsSmoothing ?? 0.72,
        complexitySmoothing: options.complexitySmoothing ?? 0.90,
        onsetMultiplier: options.onsetMultiplier ?? 1.4,
        onsetFloor: options.onsetFloor ?? 0.0005
      };
      this.reset(options.meta || {});
    }

    reset(meta = {}) {
      this.state = createState(meta);
      this.chroma = new Array(12).fill(0);
      this.rmsHistory = [];
      this.onsets = [];
      this.onsetArmed = false;
      this.tempoOnsets = [];
      this.fluxHistory = [];
      this.previousFrequencyDb = null;
      this.previousFlux = 0;
      this.previousFluxAt = 0;
      this.lastTempoOnsetAt = 0;
      this.fluxEnvelope50 = [];
      this.lastFluxSampleAt = 0;
      this.lastStableKey = null;
      this.keyCandidate = null;
      this.keyCandidateSince = 0;
      this.startedAt = meta.timestampMs ?? 0;
      return this.snapshot();
    }

    setContext(meta = {}) {
      const stationChanged = meta.stationId !== undefined && meta.stationId !== this.state.stationId;
      const trackChanged = meta.trackKey !== undefined && meta.trackKey !== this.state.trackKey;
      if (stationChanged || trackChanged) return this.reset({
        stationId: meta.stationId ?? null,
        trackKey: meta.trackKey ?? null,
        sampleRate: meta.sampleRate ?? this.state.sampleRate,
        timestampMs: meta.timestampMs ?? Date.now()
      });
      Object.assign(this.state, meta);
      return this.snapshot();
    }

    analyzeFrame(frame) {
      const frequencyDb = frame.frequencyDb;
      const timeDomain = frame.timeDomain;
      const sampleRate = frame.sampleRate ?? this.state.sampleRate;
      const timestampMs = frame.timestampMs ?? Date.now();
      if (!frequencyDb || frequencyDb.length !== FFT_SIZE / 2) {
        throw new Error(`frequencyDb must contain ${FFT_SIZE / 2} bins`);
      }
      if (frame.stationId !== undefined || frame.trackKey !== undefined) {
        const changed = frame.stationId !== undefined && frame.stationId !== this.state.stationId ||
                        frame.trackKey !== undefined && frame.trackKey !== this.state.trackKey;
        if (changed) this.reset({ stationId: frame.stationId ?? null, trackKey: frame.trackKey ?? null,
          sampleRate, timestampMs });
      }

      if(typeof frame.genreFamily==='string')this.state.genreFamily=frame.genreFamily;if(typeof frame.genreLabel==='string'||frame.genreLabel===null)this.state.genreLabel=frame.genreLabel;
      const tm = timeMetrics(timeDomain);
      const previousRms = this.state.rms;
      const rms = this.options.rmsSmoothing * previousRms + (1 - this.options.rmsSmoothing) * tm.rms;
      this.rmsHistory.push(rms);
      if (this.rmsHistory.length > 60) this.rmsHistory.shift();
      const oldRms = this.rmsHistory[Math.max(0, this.rmsHistory.length - 30)] ?? rms;
      const rmsSlope = (rms - oldRms) / Math.max(1, Math.min(30, this.rmsHistory.length));

      const peaks = extractPeaks(frequencyDb, sampleRate);
      const frameChroma = chromaFromPeaks(peaks);
      for (let i = 0; i < 12; i++) this.chroma[i] = this.options.chromaDecay * this.chroma[i] + frameChroma[i];
      const keyResult = detectKeyMode(this.chroma);

      const flux=spectralFlux(frequencyDb,this.previousFrequencyDb);this.previousFrequencyDb=Float32Array.from(frequencyDb);
      if(!this.lastFluxSampleAt||timestampMs-this.lastFluxSampleAt>=45){this.fluxEnvelope50.push(flux);if(this.fluxEnvelope50.length>600)this.fluxEnvelope50.shift();this.lastFluxSampleAt=timestampMs;}
      const harmonicTempo=estimateTempoHarmonicAutocorrelation(this.fluxEnvelope50,50);this.fluxHistory.push(flux);if(this.fluxHistory.length>80)this.fluxHistory.shift();
      const fluxSorted=this.fluxHistory.slice().sort((a,b)=>a-b),fluxMedian=fluxSorted.length?fluxSorted[Math.floor(fluxSorted.length/2)]:0,fluxThreshold=Math.max(fluxMedian*1.65,1e-7);
      if(this.previousFlux>fluxThreshold&&this.previousFlux>flux&&this.previousFluxAt-this.lastTempoOnsetAt>220){this.tempoOnsets.push(this.previousFluxAt);this.lastTempoOnsetAt=this.previousFluxAt;if(this.tempoOnsets.length>40)this.tempoOnsets.shift();}this.previousFlux=flux;this.previousFluxAt=timestampMs;
      const meanRms=this.rmsHistory.reduce((a,b)=>a+b,0)/Math.max(1,this.rmsHistory.length),rmsOnset=rms>meanRms*this.options.onsetMultiplier&&rms>this.options.onsetFloor&&rmsSlope>0;
      if(rmsOnset&&!this.onsetArmed){this.onsets.push(timestampMs);if(this.onsets.length>24)this.onsets.shift();this.onsetArmed=true;}else if(!rmsOnset)this.onsetArmed=false;
      const spectralTempo=estimateTempoFromOnsets(this.tempoOnsets),rmsTempo=estimateTempoFromOnsets(this.onsets),options=[harmonicTempo,spectralTempo,rmsTempo].filter(q=>q.confidence!==null).sort((a,b)=>b.confidence-a.confidence),chosen=options[0]||harmonicTempo;
      const bpm=chosen.bpm,bpmConfidence=chosen.confidence,presentationTempo=resolveTempoPresentation(chosen,harmonicTempo,bpm),tempoDiagnostics={tempoCandidate:bpm,tempoConfidence:bpmConfidence,tempoMethod:chosen.method,selectedMethod:chosen.method,selectedCandidate:bpm,autocorrCandidate:harmonicTempo.bpm,autocorrConfidence:harmonicTempo.confidence,autocorrPeak:harmonicTempo.peak,autocorrFamilyScore:harmonicTempo.familyScore,autocorrProminence:harmonicTempo.prominence,autocorrLocalPeakSharpness:harmonicTempo.localPeakSharpness,autocorrWindowSeconds:harmonicTempo.windowSeconds,autocorrCadenceMs:harmonicTempo.cadenceMs,autocorrEvidenceGate:harmonicTempo.evidenceGate,spectralEvidenceGate:spectralTempo.evidenceGate||spectralTempo.method,rmsEvidenceGate:rmsTempo.evidenceGate||rmsTempo.method,onsetCount:chosen.onsetCount??null,tempoWindowSeconds:chosen.windowSeconds,octaveAmbiguous:chosen.octaveAmbiguous??false,spectralFlux:flux,fluxPeakCount:this.tempoOnsets.length,lastTempoOnsetAt:this.lastTempoOnsetAt};

      let modulation = null;
      const keyId = keyResult.key && keyResult.mode ? `${keyResult.key} ${keyResult.mode}` : null;
      if (keyId && keyResult.confidence >= 0.55) {
        if (keyId !== this.keyCandidate) { this.keyCandidate = keyId; this.keyCandidateSince = timestampMs; }
        if (timestampMs - this.keyCandidateSince >= 2000 && keyId !== this.lastStableKey) {
          if (this.lastStableKey) modulation = { from: this.lastStableKey, to: keyId, detectedAtMs: timestampMs };
          this.lastStableKey = keyId;
        }
      }

      const rawComplexity = clamp((peaks.length / 6) * 0.55 + clamp(rms / 0.08, 0, 1) * 0.45, 0, 1);
      const complexity = this.options.complexitySmoothing * (this.state.complexity ?? 0) +
                         (1 - this.options.complexitySmoothing) * rawComplexity;
      const dom = peaks[0] ?? null;

      Object.assign(this.state, {
        timestampMs, sampleRate, fftSize: FFT_SIZE,
        rms, rmsSlope, peak: tm.peak,
        dominantFrequencyHz: dom ? dom.frequencyHz : null,
        dominantNote: dom ? noteName(dom.midi) : null,
        dominantOctave: dom ? octave(dom.midi) : null,
        spectralCentroidHz: spectralCentroid(frequencyDb, sampleRate),
        zeroCrossingRate: tm.zcr,
        peaks: peaks.map(p => ({
          frequencyHz: p.frequencyHz, db: p.db, midi: p.midi,
          pitchClass: p.pitchClass, note: noteName(p.midi), octave: octave(p.midi)
        })),
        chroma: this.chroma.slice(),
        key: keyResult.confidence >= 0.35 ? keyResult.key : null,
        mode: keyResult.confidence >= 0.35 ? keyResult.mode : null,
        keyConfidence: finiteOrNull(keyResult.confidence),
        bpm: finiteOrNull(bpm),
        bpmConfidence: finiteOrNull(bpmConfidence),
        tempoFamily: presentationTempo.family,
        tempoFamilyConfidence: presentationTempo.confidence,
          tempoLocalPeakSharpness: presentationTempo.sharpness,
        tempoMetricalLevel: presentationTempo.metricalLevel,
        tempoDiagnostics,
        consonance: finiteOrNull(consonance(peaks)),
        complexity,
        harmonicEntropy: finiteOrNull(harmonicEntropy(peaks)),
        modulation
      });
      this.state.longWindow.observationSeconds = this.startedAt ? Math.max(0, (timestampMs - this.startedAt) / 1000) : 0;
      return this.snapshot();
    }

    snapshot() {
      return JSON.parse(JSON.stringify(this.state));
    }
  }

  return {
    SCHEMA_VERSION, FFT_SIZE, NOTE_NAMES, MODE_PROFILES,
    createState, validateState, midiFromHz, noteName, octave,
    detectKeyMode, extractPeaks, spectralCentroid, chromaFromPeaks,
    consonance, harmonicEntropy, timeMetrics, normalizeTempoBpm,
    estimateTempoFromOnsets, estimateTempoHarmonicAutocorrelation, resolveTempoPresentation, spectralFlux, AnalysisEngine
  };
});
