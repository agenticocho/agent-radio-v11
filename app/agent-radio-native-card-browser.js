(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.AgentRadioNativeCard=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';


const SCHEMA_VERSION = 'agent-radio-native-card-v1';
const INPUT_SCHEMA = 'radio-analysis-state-v1';
const ALGORITHMS = Object.freeze({
  arousalEstimate: 'radio-rms-complexity-tempo-arousal-v1',
  valenceEstimate: 'radio-consonance-entropy-mode-valence-v1',
  harmonicTensionEstimate: 'radio-entropy-dissonance-complexity-tension-v1',
  flowEstimate: 'radio-arousal-valence-tension-flow-v1',
  transitionSalience: 'radio-rms-modulation-tension-transition-v1',
  fermataCandidate: 'radio-rms-drop-hold-fermata-v1',
  resolutionCandidate: 'radio-tension-arousal-consonance-resolution-v1',
  structuralArc: 'radio-history-arc-v1',
});

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function validateFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new TypeError('frame must be an object');
  if (frame.schemaVersion !== INPUT_SCHEMA) throw new TypeError('frame schemaVersion');
  if (!Number.isFinite(frame.timestampMs)) throw new TypeError('frame timestampMs');
  if (typeof frame.stationId !== 'string' || !frame.stationId) throw new TypeError('frame stationId');
  if (typeof frame.trackKey !== 'string' || !frame.trackKey) throw new TypeError('frame trackKey');
  return frame;
}

function modeBonus(mode) {
  const value = typeof mode === 'string' ? mode.toLowerCase() : '';
  if (value === 'major') return 0.08;
  if (value === 'minor') return -0.04;
  return 0;
}

class NativeCardEngine {
  constructor(options = {}) {
    this.audioSourceId = options.audioSourceId || 'agent-radio-media-element';
    this.maxHistory = options.maxHistory || 60;
    this.reset();
  }

  reset(context = null, reason = 'manual') {
    this.context = context;
    this.history = [];
    this.lastOutput = null;
    this.lastResetReason = reason;
    return this.snapshot();
  }

  snapshot() {
    return this.lastOutput ? JSON.parse(JSON.stringify(this.lastOutput)) : null;
  }

  analyze(frameInput) {
    const frame = validateFrame(frameInput);
    const nextContext = {
      stationId: frame.stationId,
      trackKey: frame.trackKey,
      audioSourceId: this.audioSourceId,
    };
    let resetReason = null;
    if (!this.context) {
      this.reset(nextContext, 'initial-context');
      resetReason = 'initial-context';
    } else if (this.context.stationId !== nextContext.stationId) {
      this.reset(nextContext, 'station-change');
      resetReason = 'station-change';
    } else if (this.context.trackKey !== nextContext.trackKey) {
      this.reset(nextContext, 'track-change');
      resetReason = 'track-change';
    }

    const rms = finite(frame.rms);
    const rmsSlope = finite(frame.rmsSlope) ?? 0;
    const complexity = finite(frame.complexity);
    const entropy = finite(frame.harmonicEntropy);
      const entropyNorm = entropy === null ? null : clamp(entropy / Math.log2(14));
    const consonance = finite(frame.consonance);
    const bpm = finite(frame.bpm);
    const bpmConfidence = finite(frame.bpmConfidence);
    const keyConfidence = finite(frame.keyConfidence);
    const modulation = clamp(finite(frame.modulation) ?? 0);

    const coreValid = [rms, complexity, entropy, consonance].every(value => value !== null);
    const tempoValid = bpm !== null && bpmConfidence !== null && bpmConfidence >= 0.5;
    const tonalValid = keyConfidence !== null && keyConfidence >= 0.55 && typeof frame.key === 'string';
    const structuralEligible = coreValid && tempoValid && tonalValid;

    let arousal = null;
    let valence = null;
    let tension = null;
    let flow = null;
    if (coreValid) {
      const rmsNorm = clamp(rms / 0.15);
      const tempoNorm = tempoValid ? clamp((bpm - 40) / 140) : 0.5;
      arousal = clamp(rmsNorm * 0.50 + clamp(complexity) * 0.30 + tempoNorm * 0.20);
      valence = clamp(clamp(consonance) * 0.55 + (1 - entropyNorm) * 0.30 + 0.15 + modeBonus(frame.mode));
      tension = clamp(entropyNorm * 0.55 + (1 - clamp(consonance)) * 0.25 + clamp(complexity) * 0.20);
      const arousalZone = clamp(1 - Math.abs(arousal - 0.5) / 0.5);
      flow = clamp(arousalZone * 0.45 + valence * 0.30 + (1 - tension) * 0.25);
    }

    const confidenceParts = [];
    if (coreValid) confidenceParts.push(1);
    if (bpmConfidence !== null) confidenceParts.push(clamp(bpmConfidence));
    if (keyConfidence !== null) confidenceParts.push(clamp(keyConfidence));
    const estimateConfidence = mean(confidenceParts) ?? 0;

    const previous = this.history.length ? this.history[this.history.length - 1] : null;
    const transitionSalience = coreValid
      ? clamp(clamp(Math.abs(rmsSlope) / 0.02) * 0.5 + modulation * 0.25 + clamp(Math.abs(tension - (previous?.tension ?? tension))) * 0.25)
      : null;

    const point = {
      timestampMs: frame.timestampMs,
      rms, arousal, valence, tension, consonance, entropy,
      confidence: estimateConfidence,
      structuralEligible,
    };
    this.history.push(point);
    if (this.history.length > this.maxHistory) this.history.shift();

    let fermataCandidate = false;
    let resolutionCandidate = false;
    if (structuralEligible && this.history.length >= 12) {
      const recent = this.history.slice(-6);
      const prior = this.history.slice(-12, -6);
      const recentRmsMax = Math.max(...recent.map(item => item.rms));
      const priorRmsMean = mean(prior.map(item => item.rms));
      fermataCandidate = recentRmsMax < 0.003 && priorRmsMean > 0.02;
    }
    if (structuralEligible && this.history.length >= 16) {
      const prior = this.history.slice(-16, -8);
      const recent = this.history.slice(-8);
      const priorTension = mean(prior.map(item => item.tension));
      const recentTension = mean(recent.map(item => item.tension));
      const priorArousal = mean(prior.map(item => item.arousal));
      const recentArousal = mean(recent.map(item => item.arousal));
      const priorConsonance = mean(prior.map(item => item.consonance));
      const recentConsonance = mean(recent.map(item => item.consonance));
      const recentRms = mean(recent.map(item => item.rms));
      resolutionCandidate = recentRms > 0.003 &&
        recentTension <= priorTension - 0.15 &&
        recentArousal <= priorArousal - 0.12 &&
        recentConsonance >= priorConsonance + 0.10;
    }

    let arc = 'intro';
    if (this.history.length >= 10) arc = 'development';
    if (resolutionCandidate) arc = 'resolution';
    else if (arousal !== null && tension !== null && arousal >= 0.72 && tension >= 0.62) arc = 'climax';

    const output = {
      schemaVersion: SCHEMA_VERSION,
      timestampMs: frame.timestampMs,
      context: nextContext,
      resetReason,
      historyFrames: this.history.length,
      capabilities: {
        visualizationOnly: true,
        playbackControl: false,
        injectionControl: false,
        narrationControl: false,
        listenerInference: false,
      },
      eligibility: {
        coreMetrics: coreValid,
        tempo: tempoValid,
        tonal: tonalValid,
        structural: structuralEligible,
      },
      estimates: {
        arousal: { value: arousal, confidence: estimateConfidence, algorithm: ALGORITHMS.arousalEstimate, label: 'audio-derived estimate' },
        valence: { value: valence, confidence: estimateConfidence, algorithm: ALGORITHMS.valenceEstimate, label: 'audio-derived estimate' },
        harmonicTension: { value: tension, confidence: estimateConfidence, algorithm: ALGORITHMS.harmonicTensionEstimate, label: 'audio-derived estimate' },
        flowZone: { value: flow, confidence: estimateConfidence, algorithm: ALGORITHMS.flowEstimate, label: 'audio-derived estimate' },
        transitionSalience: { value: transitionSalience, confidence: estimateConfidence, algorithm: ALGORITHMS.transitionSalience, label: 'audio-derived estimate' },
      },
      structure: {
        arc,
        fermataCandidate,
        resolutionCandidate,
        confidence: structuralEligible ? estimateConfidence : 0,
        algorithms: {
          arc: ALGORITHMS.structuralArc,
          fermata: ALGORITHMS.fermataCandidate,
          resolution: ALGORITHMS.resolutionCandidate,
        },
      },
      native: {
        bpm, bpmConfidence, key: typeof frame.key === 'string' ? frame.key : null,
        mode: typeof frame.mode === 'string' ? frame.mode : null,
        keyConfidence, consonance, complexity, harmonicEntropy: entropy, rms, rmsSlope,
      },
    };
    this.lastOutput = output;
    return this.snapshot();
  }
}

return { SCHEMA_VERSION, INPUT_SCHEMA, ALGORITHMS, NativeCardEngine, validateFrame };

});
