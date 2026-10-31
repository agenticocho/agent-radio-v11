(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.AgentRadioNarrationTelemetry = api;
    root.__agentRadioNarrationTelemetry = function () { return api.snapshot(); };
    root.__agentRadioNarrationTelemetrySummary = function () { return api.summary(); };
    root.__agentRadioNarrationEvidenceReady = function () {
      var duck = typeof root.__agentRadioDuckState === 'function' ? root.__agentRadioDuckState() : null;
      return api.readiness(duck);
    };
    root.__agentRadioDownloadNarrationEvidence = function (options) {
      var readiness = root.__agentRadioNarrationEvidenceReady();
      var override = !!(options && options.override === true);
      if (!readiness.ready && !override) {
        return { downloaded: false, reason: 'not_ready', readiness: readiness };
      }
      var payload = {
        schemaVersion: api.schemaVersion,
        capturedAt: new Date().toISOString(),
        url: root.location ? root.location.href : null,
        readiness: readiness,
        diagnosticOverride: override,
        guard: root.AgentRadioNarrationOutputGuard ? root.AgentRadioNarrationOutputGuard.detect("I'm sorry but I cannot fulfill that request because there isn't enough information provided, so let me know how exactly.") : null,
        duck: typeof root.__agentRadioDuckState === 'function' ? root.__agentRadioDuckState() : null,
        runs: api.snapshot(),
        summary: api.summary()
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'agent-radio-a5.1r8-telemetry-' + Date.now() + '.json';
      a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return { downloaded: true, diagnosticOverride: override, readiness: readiness, fileName: a.download, runCount: payload.runs.length, capturedAt: payload.capturedAt };
    };
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var SCHEMA_VERSION = 1;
  var MAX_RUNS = 100;
  var MAX_EVENTS_PER_RUN = 80;
  var runs = [];
  var byId = new Map();
  var seq = 0;
  var ttsSeq = 0;
  var lastTtsTerminalMono = null;
  var lastTtsOutcome = null;
  var ttsStates = new Map();
  var recentTtsMs = 120000;
  var TERMINAL_AUDIO_EVENTS = { audioEnded: true, audioError: true, audioAborted: true };
  var perf = (typeof performance !== 'undefined' && performance.now)
    ? performance : { now: function () { return Date.now(); } };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function words(s) { var m = String(s || '').trim().match(/\S+/g); return m ? m.length : 0; }
  function safeValue(v) {
    if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') return v.slice(0, 240);
    return undefined;
  }
  function sanitize(data) {
    var out = {};
    if (!data || typeof data !== 'object') return out;
    Object.keys(data).forEach(function (key) {
      if (/^(text|prompt|system|user|content|narration)$/i.test(key)) return;
      var value = safeValue(data[key]);
      if (value !== undefined) out[key] = value;
    });
    return out;
  }
  function makeId() {
    seq += 1;
    var rand = '';
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        var a = new Uint32Array(2); crypto.getRandomValues(a);
        rand = a[0].toString(36) + a[1].toString(36);
      }
    } catch (e) {}
    if (!rand) rand = Math.random().toString(36).slice(2, 12);
    return 'nr-' + Date.now().toString(36) + '-' + seq.toString(36) + '-' + rand;
  }
  function trim() {
    while (runs.length > MAX_RUNS) {
      var removed = runs.shift();
      byId.delete(removed.runId);
    }
  }
  function start(meta) {
    var mono = perf.now();
    var clean = sanitize(meta);
    var run = Object.assign({
      schemaVersion: SCHEMA_VERSION,
      runId: makeId(),
      kind: 'narrate',
      startedAtEpochMs: Date.now(),
      startedAtMonotonic: mono,
      terminalOutcome: null,
      terminalCount: 0,
      events: []
    }, clean);
    runs.push(run); byId.set(run.runId, run); trim();
    mark(run.runId, 'requested', clean);
    return run.runId;
  }
  function mark(runId, event, data) {
    var run = byId.get(runId);
    if (!run || !event) return false;
    event = String(event);
    if (TERMINAL_AUDIO_EVENTS[event]) {
      for (var i = 0; i < run.events.length; i++) {
        if (TERMINAL_AUDIO_EVENTS[run.events[i].event]) return false;
      }
    }
    var clean = sanitize(data);
    var state = ttsStates.get(runId);
    if (state && state.cancelReason && TERMINAL_AUDIO_EVENTS[event]) clean.cancelReason = state.cancelReason;
    var ev = Object.assign({
      event: event,
      atMs: Math.max(0, perf.now() - run.startedAtMonotonic)
    }, clean);
    run.events.push(ev);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN);
    return true;
  }
  function terminal(runId, outcome, data) {
    var run = byId.get(runId);
    if (!run || run.terminalOutcome !== null) return false;
    run.terminalOutcome = String(outcome || 'failed');
    run.terminalCount = 1;
    run.endedAtEpochMs = Date.now();
    var clean = sanitize(data);
    var state = ttsStates.get(runId);
    if (state && state.cancelReason && (run.terminalOutcome === 'aborted' || run.terminalOutcome === 'cancelled')) clean.cancelReason = state.cancelReason;
    mark(runId, 'terminal', Object.assign({ outcome: run.terminalOutcome }, clean));
    return true;
  }
  function textStats(text) { return { textChars: String(text || '').length, textWords: words(text) }; }
  function probeStart(runId) { return mark(runId, 'ttsProbeStart'); }
  function probeEnd(runId, ok, data) {
    return mark(runId, 'ttsProbeEnd', Object.assign({ ok: !!ok }, sanitize(data)));
  }
  function ttsRequest(runId) {
    var now = perf.now();
    ttsSeq += 1;
    var gap = lastTtsTerminalMono == null ? null : Math.max(0, now - lastTtsTerminalMono);
    var condition = 'idle';
    if (ttsSeq === 1) condition = 'first_in_page';
    else if (gap != null && gap <= recentTtsMs && lastTtsOutcome === 'complete') condition = 'recent_after_complete';
    else if (gap != null && gap <= recentTtsMs && (lastTtsOutcome === 'abort' || lastTtsOutcome === 'error')) condition = 'recent_after_abort';
    var data = { ttsSequence: ttsSeq, ttsCondition: condition };
    if (gap != null) data.msSincePriorTtsTerminal = gap;
    if (lastTtsOutcome != null) data.priorTtsOutcome = lastTtsOutcome;
    ttsStates.set(runId, { outcome: null });
    mark(runId, 'ttsRequestStart', data);
    return data;
  }
  function ttsFinish(runId, outcome, data) {
    var state = ttsStates.get(runId);
    if (!state || state.outcome !== null) return false;
    state.outcome = String(outcome || 'error');
    var clean = sanitize(data);
    state.cancelReason = clean.cancelReason || (state.outcome === 'abort' ? 'aborted' : state.outcome === 'error' ? 'error' : null);
    lastTtsTerminalMono = perf.now();
    lastTtsOutcome = state.outcome;
    if (state.cancelReason) clean.cancelReason = state.cancelReason;
    mark(runId, 'ttsFinish', Object.assign({ ttsOutcome: state.outcome }, clean));
    return true;
  }
  function ttsComplete(runId, data) {
    mark(runId, 'ttsComplete', data || {});
    return ttsFinish(runId, 'complete', data || {});
  }
  function snapshot() { return clone(runs); }
  function readiness(duckState) {
    var activeRunIds = [];
    for (var i = 0; i < runs.length; i++) if (runs[i].terminalOutcome === null) activeRunIds.push(runs[i].runId);
    var tokens = duckState && Array.isArray(duckState.tokens) ? duckState.tokens : [];
    return {
      ready: activeRunIds.length === 0 && tokens.length === 0,
      runCount: runs.length,
      activeRunIds: activeRunIds,
      activeDuckTokens: tokens.length,
      duckTokens: clone(tokens)
    };
  }
  function eventAt(run, name) {
    for (var i = 0; i < run.events.length; i++) if (run.events[i].event === name) return run.events[i].atMs;
    return null;
  }
  function summary() {
    return runs.map(function (run) {
      var requested = eventAt(run, 'requested') || 0;
      var llmStart = eventAt(run, 'llmGenerationStart');
      var llmEnd = eventAt(run, 'llmGenerationEnd');
      var textVisible = eventAt(run, 'textVisible');
      var ttsStart = eventAt(run, 'ttsRequestStart');
      var response = eventAt(run, 'ttsResponse');
      var blob = eventAt(run, 'ttsBlobReady');
      var play = eventAt(run, 'audioPlayRequested');
      var audio = eventAt(run, 'audioStarted');
      var terminalAt = eventAt(run, 'terminal');
      function delta(a, b) { return a == null || b == null ? null : Math.max(0, b - a); }
      return {
        runId: run.runId, kind: run.kind, auto: run.auto,
        outcome: run.terminalOutcome, terminalCount: run.terminalCount,
        llmMs: delta(llmStart, llmEnd), textVisibleMs: delta(requested, textVisible),
        ttsHeadersMs: delta(ttsStart, response), ttsBlobMs: delta(response, blob),
        browserStartMs: delta(play, audio), speechStartMs: delta(requested, audio),
        totalMs: delta(requested, terminalAt)
      };
    });
  }
  function resetForTests() { runs = []; byId = new Map(); seq = 0; ttsSeq = 0; lastTtsTerminalMono = null; lastTtsOutcome = null; ttsStates = new Map(); recentTtsMs = 120000; }
  function setTtsRecencyMsForTests(ms) { recentTtsMs = Number(ms); }
  return {
    schemaVersion: SCHEMA_VERSION,
    start: start, mark: mark, terminal: terminal, textStats: textStats,
    probeStart: probeStart, probeEnd: probeEnd,
    ttsRequest: ttsRequest, ttsFinish: ttsFinish, ttsComplete: ttsComplete,
    snapshot: snapshot, readiness: readiness, summary: summary,
    _resetForTests: resetForTests,
    _setTtsRecencyMsForTests: setTtsRecencyMsForTests
  };
});
