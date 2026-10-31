(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentRadioAnalysisProvenance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const VERSION = 'agent-radio-analysis-provenance-v1';

  function createController(options) {
    options = options || {};
    const active = new Map();
    let state = 'track';
    let generation = 0;
    let heldFrames = 0;
    let lastReason = 'initial';
    let context = { stationId: null, trackKey: null };
    const listeners = new Set();

    function snapshot() {
      return {
        schemaVersion: VERSION,
        provenance: state,
        canCommit: state === 'track',
        active: Array.from(active.entries()).map(function (entry) {
          return { token: entry[0], owner: entry[1] };
        }),
        generation: generation,
        heldFrames: heldFrames,
        reason: lastReason,
        stationId: context.stationId,
        trackKey: context.trackKey
      };
    }

    function emit(reason) {
      lastReason = reason || lastReason;
      const value = snapshot();
      listeners.forEach(function (listener) {
        try { listener(value); } catch (_) {}
      });
      if (options.onchange) options.onchange(value);
      return value;
    }

    function begin(token, owner) {
      if (token === null || token === undefined) return snapshot();
      active.set(token, String(owner || 'unknown'));
      generation += 1;
      state = 'narration';
      return emit('duck-begin');
    }

    function end(token) {
      if (token === null || token === undefined || !active.has(token)) return null;
      active.delete(token);
      generation += 1;
      if (active.size) {
        state = 'narration';
        emit('duck-end-overlap');
        return null;
      }
      state = 'recovery';
      const ticket = generation;
      emit('duck-end-recovery');
      return ticket;
    }

    function complete(ticket) {
      if (ticket === null || ticket === undefined) return false;
      if (ticket !== generation || active.size || state !== 'recovery') return false;
      state = 'track';
      generation += 1;
      emit('volume-restored');
      return true;
    }

    function canCommit() { return state === 'track'; }

    function noteHeldFrame(extra) {
      heldFrames += 1;
      const value = snapshot();
      if (extra && typeof extra === 'object') {
        Object.keys(extra).forEach(function (key) { value[key] = extra[key]; });
      }
      return value;
    }

    function setContext(detail) {
      detail = detail || {};
      context = {
        stationId: detail.stationId == null ? context.stationId : detail.stationId,
        trackKey: detail.trackKey == null ? null : detail.trackKey
      };
      return emit('track-context');
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }

    return {
      begin: begin,
      end: end,
      complete: complete,
      canCommit: canCommit,
      noteHeldFrame: noteHeldFrame,
      setContext: setContext,
      snapshot: snapshot,
      subscribe: subscribe
    };
  }

  const controller = createController();

  function dispatch(value) {
    if (!root || typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent('agent-radio-analysis-provenance', { detail: value }));
  }

  controller.subscribe(dispatch);

  if (root && typeof root.addEventListener === 'function') {
    root.addEventListener('agent-radio-track-context', function (event) {
      controller.setContext(event && event.detail);
    });
  }

  function mountHeldIndicator(doc) {
    if (!doc || doc.getElementById('agent-radio-analysis-held')) return;
    const style = doc.createElement('style');
    style.id = 'agent-radio-analysis-held-style';
    style.textContent = '#agent-radio-analysis-held{position:fixed;left:50%;top:74px;transform:translateX(-50%);z-index:9999;padding:7px 12px;border:1px solid #7d6330;border-radius:999px;background:rgba(8,8,10,.92);color:#d6a84d;font:600 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;pointer-events:none}#agent-radio-analysis-held[hidden]{display:none}';
    doc.head.appendChild(style);
    const el = doc.createElement('div');
    el.id = 'agent-radio-analysis-held';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.textContent = 'DJ VOICE — ANALYSIS HELD';
    doc.body.appendChild(el);
    controller.subscribe(function (value) {
      el.hidden = value.provenance === 'track';
      el.dataset.provenance = value.provenance;
      el.title = value.provenance === 'recovery' ? 'Music volume restoring; analysis remains held.' : 'DJ voice active; music analysis is held.';
    });
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', function () { mountHeldIndicator(root.document); }, { once: true });
    } else {
      mountHeldIndicator(root.document);
    }
  }

  return {
    VERSION: VERSION,
    createController: createController,
    begin: controller.begin,
    end: controller.end,
    complete: controller.complete,
    canCommit: controller.canCommit,
    noteHeldFrame: controller.noteHeldFrame,
    setContext: controller.setContext,
    snapshot: controller.snapshot,
    subscribe: controller.subscribe
  };
});
