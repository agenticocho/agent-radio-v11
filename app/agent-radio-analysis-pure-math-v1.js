(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AgentRadioPureMath = api;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => api.mount());
    else api.mount();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function ratioApprox(value, maxDenominator = 16) {
    if (!Number.isFinite(value) || value <= 0) return null;
    let best = { n: 1, d: 1, error: Math.abs(value - 1) };
    for (let d = 1; d <= maxDenominator; d++) {
      const n = Math.max(1, Math.round(value * d));
      const error = Math.abs(value - n / d);
      if (error < best.error) best = { n, d, error };
    }
    return best;
  }

  function intervalRatio(peaks) {
    if (!Array.isArray(peaks) || peaks.length < 2) return null;
    const a = peaks[0]?.frequencyHz, b = peaks[1]?.frequencyHz;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
    return ratioApprox(Math.max(a, b) / Math.min(a, b));
  }

  function fourierTerms(peaks, limit = 4) {
    if (!Array.isArray(peaks)) return [];
    return peaks.slice(0, limit).filter(p => Number.isFinite(p.frequencyHz) && Number.isFinite(p.db)).map(p => ({
      frequencyHz: p.frequencyHz,
      amplitude: Math.pow(10, p.db / 20)
    }));
  }

  function normalizedChroma(chroma) {
    if (!Array.isArray(chroma) || chroma.length !== 12) return new Array(12).fill(0);
    const max = Math.max(...chroma, 0);
    return max > 0 ? chroma.map(v => Math.max(0, v / max)) : new Array(12).fill(0);
  }

  function viewModel(state) {
    if (!state || state.schemaVersion !== 'radio-analysis-state-v1') return null;
    const ratio = intervalRatio(state.peaks);
    const keyVisible = Number.isFinite(state.keyConfidence) && state.keyConfidence >= .55 && state.key && state.mode;
    return {
      frequency: Number.isFinite(state.dominantFrequencyHz) ? state.dominantFrequencyHz : null,
      ratio: ratio ? `${ratio.n}:${ratio.d}` : null,
      ratioError: ratio?.error ?? null,
      fourier: fourierTerms(state.peaks),
      centroid: Number.isFinite(state.spectralCentroidHz) ? state.spectralCentroidHz : null,
      chroma: normalizedChroma(state.chroma),
      key: keyVisible ? `${state.key} ${state.mode}` : null,
      keyConfidence: keyVisible ? state.keyConfidence : null,
      consonance: Number.isFinite(state.consonance) ? state.consonance : null,
      harmonicEntropy: Number.isFinite(state.harmonicEntropy) ? state.harmonicEntropy : null,
      complexity: Number.isFinite(state.complexity) ? state.complexity : null,
      stationId: state.stationId || 'no station'
    };
  }

  let mounted = false;
  let active = false;
  let latest = null;
  let els = null;

  function css() {
    return `
#ar-analysis-modes{position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:5;display:flex;gap:4px;padding:3px;border:1px solid #22262b;border-radius:999px;background:#0d0f12}
#ar-analysis-modes button{border:0;border-radius:999px;background:transparent;color:#626a74;padding:7px 12px;font:500 10px/1 "JetBrains Mono",monospace;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
#ar-analysis-modes button.on{background:#1a1e23;color:#d4a84a}
#ar-pure-stage{position:absolute;inset:72px 5vw 54px;display:none;grid-template-columns:1.1fr 1fr 1fr;grid-template-rows:1fr 1fr;gap:18px;align-items:center}
#ar-analysis-deck.math #ar-pure-stage{display:grid}
#ar-analysis-deck.math .arv-stage{display:none}
.arpm-cell{text-align:center;min-width:0}.arpm-label{font:300 10px/1.2 "JetBrains Mono",monospace;color:#454b53;letter-spacing:.13em;text-transform:uppercase;margin-bottom:9px}
.arpm-eq{font-family:"EB Garamond",Georgia,serif;font-size:clamp(23px,3.2vw,52px);line-height:1.1;color:#e8e0d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.arpm-var{color:#7a9db8}.arpm-live{color:#d4a84a}.arpm-violet{color:#8a6fa0}.arpm-green{color:#5a8c6a}.arpm-sub{font:300 10px/1.4 "JetBrains Mono",monospace;color:#4a5058;margin-top:8px}.arpm-bars{height:76px;display:flex;align-items:flex-end;justify-content:center;gap:7px}.arpm-bar{width:12px;min-height:2px;background:#8a6fa0;border-radius:2px 2px 0 0;transition:height .35s ease}.arpm-terms{font:300 12px/1.8 "JetBrains Mono",monospace;color:#59616b}.arpm-terms b{color:#d4a84a;font-weight:400}
@media(max-width:760px){#ar-pure-stage{grid-template-columns:1fr 1fr;grid-template-rows:repeat(3,1fr);inset:72px 15px 48px}.arpm-eq{font-size:clamp(18px,5vw,34px)}}
@media(prefers-reduced-motion:reduce){.arpm-bar{transition:none}}
`;
  }

  function mount() {
    if (mounted || !root.document) return false;
    const deck = document.querySelector('#ar-analysis-deck');
    const musicalStage = deck?.querySelector('.arv-stage');
    if (!deck || !musicalStage) return false;
    mounted = true;

    const style = document.createElement('style');
    style.id = 'ar-pure-math-styles';
    style.textContent = css();
    document.head.appendChild(style);

    const modes = document.createElement('nav');
    modes.id = 'ar-analysis-modes';
    modes.setAttribute('aria-label', 'Analysis view');
    modes.innerHTML = '<button type="button" data-mode="vocab" class="on">Vocabulary</button><button type="button" data-mode="math">Mathematics</button>';
    deck.appendChild(modes);

    const stage = document.createElement('div');
    stage.id = 'ar-pure-stage';
    stage.innerHTML = `
      <div class="arpm-cell"><div class="arpm-label">frequency identity</div><div class="arpm-eq"><span class="arpm-var">f</span> = <span class="arpm-live" id="arpm-f">—</span> Hz</div><div class="arpm-sub" id="arpm-key">key correlation gathering…</div></div>
      <div class="arpm-cell"><div class="arpm-label">interval ratio</div><div class="arpm-eq"><span class="arpm-var">f₂/f₁</span> ≈ <span class="arpm-live" id="arpm-ratio">—</span></div><div class="arpm-sub" id="arpm-ratioerr">—</div></div>
      <div class="arpm-cell"><div class="arpm-label">spectral centroid</div><div class="arpm-eq"><span class="arpm-var">μf</span> = <span class="arpm-live" id="arpm-centroid">—</span></div><div class="arpm-sub">Hz · magnitude weighted</div></div>
      <div class="arpm-cell"><div class="arpm-label">Fourier peaks</div><div class="arpm-terms" id="arpm-fourier">—</div></div>
      <div class="arpm-cell"><div class="arpm-label">chroma distribution</div><div class="arpm-bars" id="arpm-chroma"></div><div class="arpm-sub">C C♯ D D♯ E F F♯ G G♯ A A♯ B</div></div>
      <div class="arpm-cell"><div class="arpm-label">information & harmony</div><div class="arpm-eq"><span class="arpm-green">C</span> = <span class="arpm-live" id="arpm-cons">—</span></div><div class="arpm-sub"><span class="arpm-violet">H</span> <span id="arpm-entropy">—</span> raw bits · complexity <span id="arpm-complexity">—</span></div></div>`;
    deck.appendChild(stage);

    els = {
      deck, modes, vocab: modes.querySelector('[data-mode="vocab"]'), math: modes.querySelector('[data-mode="math"]'),
      f: stage.querySelector('#arpm-f'), key: stage.querySelector('#arpm-key'), ratio: stage.querySelector('#arpm-ratio'),
      ratioerr: stage.querySelector('#arpm-ratioerr'), centroid: stage.querySelector('#arpm-centroid'),
      fourier: stage.querySelector('#arpm-fourier'), chroma: stage.querySelector('#arpm-chroma'), cons: stage.querySelector('#arpm-cons'),
      entropy: stage.querySelector('#arpm-entropy'), complexity: stage.querySelector('#arpm-complexity')
    };
    for (let i = 0; i < 12; i++) {
      const bar = document.createElement('span');
      bar.className = 'arpm-bar';
      bar.setAttribute('aria-hidden', 'true');
      els.chroma.appendChild(bar);
    }
    els.vocab.addEventListener('click', () => setMode('vocab'));
    els.math.addEventListener('click', () => setMode('math'));
    root.addEventListener('agent-radio-analysis', e => render(e.detail));
    root.addEventListener('agent-radio-analysis-reset', e => render(e.detail?.state));
    render(root.agentRadioAnalysis?.getState?.() || null);
    return true;
  }

  function setMode(mode) {
    if (!els) return;
    active = mode === 'math';
    els.deck.classList.toggle('math', active);
    els.vocab.classList.toggle('on', !active);
    els.math.classList.toggle('on', active);
    els.vocab.setAttribute('aria-pressed', String(!active));
    els.math.setAttribute('aria-pressed', String(active));
  }

  function text(el, value) { if (el) el.textContent = value == null ? '—' : String(value); }

  function render(state) {
    latest = state || null;
    if (!els) return null;
    const vm = viewModel(state);
    if (!vm) {
      ['f','ratio','centroid','cons','entropy','complexity'].forEach(k => text(els[k], '—'));
      text(els.key, 'key correlation gathering…'); text(els.ratioerr, '—'); text(els.fourier, '—');
      [...els.chroma.children].forEach(b => b.style.height = '2px');
      return null;
    }
    text(els.f, vm.frequency == null ? '—' : vm.frequency.toFixed(0));
    text(els.key, vm.key ? `${vm.key} · confidence ${Math.round(vm.keyConfidence * 100)}%` : 'key correlation gathering…');
    text(els.ratio, vm.ratio || '—');
    text(els.ratioerr, vm.ratioError == null ? '—' : `approximation error ${vm.ratioError.toFixed(2)}`);
    text(els.centroid, vm.centroid == null ? '—' : vm.centroid.toFixed(0));
    els.fourier.innerHTML = vm.fourier.length ? vm.fourier.map((t, i) => `${i ? ' + ' : ''}<b>${t.amplitude.toFixed(2)}</b>·sin(2π·${t.frequencyHz.toFixed(0)}t)`).join('<br>') : '—';
    [...els.chroma.children].forEach((b, i) => b.style.height = `${Math.max(2, vm.chroma[i] * 72)}px`);
    text(els.cons, vm.consonance == null ? '—' : vm.consonance.toFixed(2));
    text(els.entropy, vm.harmonicEntropy == null ? '—' : vm.harmonicEntropy.toFixed(2));
    text(els.complexity, vm.complexity == null ? '—' : `${Math.round(vm.complexity * 100)}%`);
    return vm;
  }

  return { ratioApprox, intervalRatio, fourierTerms, normalizedChroma, viewModel, mount, setMode, render, get active() { return active; }, get latest() { return latest; } };
});
