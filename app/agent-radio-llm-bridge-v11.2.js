/* Agent Radio v10 — Local LLM bridge (Feature 8)
 *
 * Entirely local. Talks ONLY to a local llama-server (llama.cpp) on 127.0.0.1:8080.
 * No cloud LLM, no AgentDJ, no sidecar — this module knows nothing outside the
 * local host.
 *
 * v6: repeat_penalty/frequency_penalty/presence_penalty added to every request;
 *     detectAndTruncateRepetition() truncates verbatim duplicate sentences/lines.
 * v7: detectAndTruncateDegeneration() added; strictFacts clause introduced for narrate.
 * v8: temperature lowered + KIND_CEILINGS + stop sequences for short-copy kinds
 *     to reduce exposure to length-correlated degeneration.
 * v9: STRICT_FACTS_CLAUSE strengthened with verbatim-name reproduction requirement.
 * v10 (27Jul26, session 1): added 'askai' kind (own ceiling/temp/stop-sequences,
 *     added to STRICT_FACTS_KINDS) — the "Ask AI" chat path was previously
 *     misclassified as narrate but also passed an explicit maxTokens:800 that
 *     bypassed every kind's ceiling entirely (a bug discovered across ALL
 *     five HTML call sites, not just this one — all five were fixed to stop
 *     passing an explicit maxTokens so the bridge's ceilings actually apply).
 * v11 (27Jul26, session 2): two targeted STRICT_FACTS_CLAUSE additions —
 *     (a) forward-reference/teaser prohibition (closes the "Pierre d'Guerie" /
 *     "Antoine de la Voura" invented-preview fabrication) and (b) "correct
 *     name, wrong detail" guard (closes Grieg/"Parisian", Rameau/wrong-century).
 *     Live-verified clean on a 9-sample post-fix batch: zero teaser fabrication,
 *     zero correct-name-wrong-detail errors, Khachaturian-style askai fabrication
 *     re-test came back clean.
 * v12 (27Jul26, session 3): fixes for the NEW failure modes surfaced once
 *     fabrication stopped competing for attention — none of these are
 *     fabrication regressions, all are length/degeneration-at-ceiling issues:
 *     (a) detectAndTruncateRepetition() extended with a word/short-phrase
 *         repetition pass — the old version only caught duplicate whole
 *         sentences/lines, so non-consecutive singleton-word drift like
 *         "tonight tonight ... today tomorrow perhaps later" sailed through
 *         untouched. New detectAndTruncateWordRepeat() scans a sliding window
 *         for an immediate word/short-phrase repeat and truncates at the
 *         second occurrence.
 *     (b) new GRACEFUL_COMPLETION_CLAUSE appended (unconditionally, not just
 *         for strictFacts kinds) to narrate/shuffle/summary system prompts,
 *         instructing the model to land its final sentence before the token
 *         ceiling rather than relying solely on the hard cutoff — targets the
 *         Berlioz/Turiña/Saint-Saëns/diary mid-sentence-cutoff pattern at the
 *         prompt level in addition to the existing hard ceiling.
 *     (c) detectAndTruncateDegeneration() tightened: gibberish word-length
 *         floor lowered 4->3 chars and a short-tail scan added that checks the
 *         last clause after the final terminal punctuation for any gibberish
 *         word and trims it off — targets the "babbled a few nonsense words
 *         & cut off" tail pattern (Saint-Saëns / diary summary samples) that
 *         the old streak-of-2 rule sometimes missed right at the very end of
 *         output.
 *     (d) model identification gap closed: probe() now also fetches
 *         GET /v1/models and stores the reported model id/path so every
 *         session self-reports which model served it instead of relying on
 *         terminal scrollback. New api.getModel() / api.onModel() exposed.
 * v13 (27Jul26, session 4): two NEW failure clusters surfaced once samples
 *     spanned non-classical genres and a hype-DJ persona leaning on ALL-CAPS
 *     emphasis:
 *     (a) ALL-CAPS corruption — spelled-out letter runs ("A-M-A-T-E-U-S
 *         M-O-R-Z-L-E-I-N-G") and gibberish all-caps blobs
 *         ("WOLKAWNGAMADEUSMORTZOLYGH...") consistently appeared wherever
 *         the model reached for caps emphasis (PINK FLOYD'S, AGENT RADIO
 *         repeated, WELCOME TO METAL ROCK RADIO). New
 *         CAPS_PROHIBITION_CLAUSE explicitly forbids ALL-CAPS emphasis in
 *         spoken copy (applied to all four kinds), and new
 *         detectAndTruncateCapsCorruption() client-side guard catches and
 *         truncates spelled-out-letter runs and long vowel-less caps blobs
 *         as a deterministic backstop regardless of prompt adherence.
 *     (b) Fact fabrication reappeared specifically on non-classical genres
 *         (composer/title swap on Boito/Mefistofele; Bach hallucinated onto
 *         a Pink Floyd track; invented collaborator/backstory details for
 *         Dead Kennedys and Pragmatix & Flow Theory) even with
 *         STRICT_FACTS_KINDS active — the clause is genre-agnostic in code,
 *         but the model's classical training prior was doing implicit
 *         grounding work that has no equivalent for rock/electronic.
 *         Added optional opts.expectedArtist / opts.expectedTrack to
 *         chat(): when supplied, an anti-swap clause naming the exact
 *         artist/track is injected, and a lightweight post-generation
 *         verifyFacts() check flags (non-blocking, does not alter output)
 *         whether neither expected string appears anywhere in the result —
 *         exposed via api.getLastFactCheck() so the HTML can log/surface
 *         suspected fabrication without the bridge silently rewriting
 *         model output.
 *
 * v14 (27Jul26, session 5): KIND_CEILINGS/KIND_FLOORS raised ~30-40% across
 *     narrate/shuffle/summary/askai (see inline comment at definition) —
 *     truncation, not degeneration or fabrication, was the dominant
 *     complaint this session, and the old ceilings were sized for a
 *     pre-v11-13 risk profile that no longer reflects the guards now in
 *     place. No prompt-clause or guard-function changes this version.
 *
 * v15 (27Jul26, session 6): two targeted fixes from the post-ceiling-raise
 *     batch, both confirmed fabrication/drift rather than truncation:
 *     (a) 'summary' added to STRICT_FACTS_KINDS — the session-recap kind was
 *         never covered by strict-facts at all, which is how it fabricated
 *         "Ö1 Club's telephone dialer," a phrase with no basis in the
 *         actual session's track list, despite the summary prompt's own
 *         separate "use ONLY the tracks listed" instruction in the HTML.
 *         Strict-facts now backstops that instruction at the bridge level.
 *     (b) STRICT_FACTS_CLAUSE extended with two new lines: an explicit
 *         station-name-fidelity instruction (station names were drifting —
 *         "CLASSIC 1" for Klassik 1, "Ethno FM" for Ethio FM — despite
 *         already being included in the general verbatim-names sentence,
 *         so this calls it out on its own for emphasis) and an explicit
 *         thin-metadata anti-fabrication instruction (closes the Ö1 case,
 *         where a bare program title with no artist/album/price data was
 *         still answered with an invented "little-known French singer,"
 *         a fake album title, and a fabricated vinyl price).
 *     NOT touched this version: the forward-reference clause's interaction
 *     with the app's legitimate recentCallbackContext() feature (U2 sample
 *     naming two other real tracks by name) — that's a callback-frequency/
 *     UX tuning question in the HTML's history-folding logic, not a bridge
 *     honesty bug, and is addressed separately in the HTML, not here.
 *     Foreign-name mangling (Albéniz) and invented pseudo-foreign lyrics
 *     (Spring/Butakah Cinta) remain open, tracked as likely model-capability
 *     limits rather than prompt-fixable.
 *
 * v16 (28Jul26, session 7): two fixes targeting the batch right after the
 *     v14 ceiling raise — both confirmed by live samples, prioritized by
 *     cost/confidence (cheap prompt tweak first, contained new guard second):
 *     (a) GRACEFUL_COMPLETION_CLAUSE extended with explicit comparison-
 *         completion guidance — narration kept trailing off mid-comparison
 *         ("perhaps it will be even more tomorrow than.", Wagner/Saxon
 *         samples) independent of ceiling proximity, so this targets the
 *         construction itself rather than length.
 *     (b) new detectAndTruncateRamble() — a direct side effect of the v14
 *         ceiling raise: longer narrations now have room to decay into
 *         grammatically-fine but semantically incoherent run-ons before
 *         hitting the hard stop (Ullien/Ed Baxxter samples). Gibberish-word
 *         detection can't catch this since every word is real; this instead
 *         flags long sentences with high subordinating/coordinating
 *         connector density as likely drift and truncates before the
 *         run-on, wired into cleanOutput() alongside the existing guards.
 *     Not addressed this version: incidental-date conflation (Ozzy '84,
 *     one confirmed instance — held for more evidence) and the station-
 *     transition accuracy dip (flagged as likely a context/cache-priming
 *     issue in the relay/HTML, not a bridge-clause problem — needs
 *     diagnostic logging of the actual first-vs-second-narration prompt
 *     before any fix is attempted).
 *
 * v22 (29Jul26, session 10): (a) server-crash handling — a malformed
 *     generation that llama-server's own parser rejects (common_chat_peg_parse,
 *     raw 500) is now tagged err.code='servererror' (distinct from 'http'/
 *     'network') and retried once with noThink forced before giving up, since
 *     the server is demonstrably up, not down — callers can stop showing a
 *     misleading "not running" message for this failure class.
 *     (b) buildAntiSwapClause() extended to forbid inventing an alias/stage-
 *     name/persona for the artist even under first-person framing.
 *     (c) narrate ceiling raised 440->560 + GRACEFUL_COMPLETION_CLAUSE given an
 *     explicit "treat 2/3 of budget as the real limit" instruction, targeting a
 *     recurring mid-sentence cutoff.
 *
 * v18 (28Jul26, session 9): widened detectAndTruncateRamble() after the
 *     Metallica/Fade-to-Black sample slipped past it entirely — that run-on
 *     leaned on connector words ("but", "though", "anyway", "or maybe")
 *     outside the original v16 wordlist, which had been tuned to one
 *     earlier sample and didn't generalize. Broadened the connector regex
 *     and added a hard 45-word single-sentence length fallback so drift
 *     built from plain coordination (not a specific connector wordlist) is
 *     still caught. Verified against the failing sample (now truncates
 *     cleanly before the drift) and two regression checks (clean narration
 *     and a legitimate ~25-word sentence both still pass through untouched).
 *     Related HTML-side fixes shipped same session, not in this file:
 *     (a) first-person "as the artist" mode prompt strengthened against
 *         inventing specific autobiographical anecdotes (Beethoven/
 *         Aerosmith/Alice in Chains samples fabricated concrete personal
 *         incidents under first-person framing that third-person narration
 *         did not produce) — general expressions of feeling/craft intent
 *         remain allowed, invented concrete stories do not.
 *     (b) first-person prompt now explicitly separates the artist's name
 *         from the track title as two distinct labeled facts, closing an
 *         identity-confusion bug where the model introduced itself using
 *         the track title instead of the artist name ("I'm 'Life Is A
 *         Roller Coaster'" instead of Ronan Keating; "I'm 'Ali-Kin' from
 *         Man in the Box" garbling Alice in Chains).
 *
 * v17 (28Jul26, session 8): two fixes from a batch showing narration quality
 *     holding well but two specific patterns worsening:
 *     (a) new normalizeSustainedCaps() — the v13 caps guard only reacts to
 *         corrupted tokens (spelled-out letters, gibberish blobs); it never
 *         addressed a *sustained* ALL-CAPS delivery register made of
 *         otherwise-real words ("BLACK SABBLETTLE IS CREATING A METALIST
 *         WORLD WHERE SOUND MEANS SURGICAL PRECISION...", "MEGAROCK RADIO
 *         IS PUMPING UP THIS METAL WITH A BANG..."). Individual real words
 *         never trip the v13 gibberish check, so the whole paragraph sailed
 *         through untouched even as the register itself collapsed alongside
 *         nearby actual gibberish ("SABBLETTLE", "RAPTUAIS", "THATKIN'").
 *         Rather than only reacting after gibberish appears, this treats a
 *         run of 4+ consecutive all-caps words as an early-warning signal of
 *         register collapse and recases it to normal sentence case in place
 *         — recovery, not deletion, since the underlying words are real and
 *         the run itself isn't lost information, just a casing problem.
 *         Short caps runs (station names, acronyms) are left untouched.
 *         Runs after detectAndTruncateCapsCorruption() in cleanOutput() so
 *         genuine token-level corruption is still caught/truncated first.
 *     (b) STRICT_FACTS_CLAUSE extended to close a second confirmed instance
 *         of incidental-date/fact conflation (Disturbed's "The Sickness"
 *         narrated with a fabricated "2005" release year alongside
 *         correctly-named real band members) — makes explicit that getting
 *         some facts right (names) doesn't license guessing the rest
 *         (dates, chart data), extending the same principle already applied
 *         to composer nationality/era in v11 to production/release details.
 *
 * Public surface (window.AgentRadioLLM):
 *   probe(force) -> Promise<boolean>   reachability check (GET /health, /v1/models, /)
 *   chat({system,user,kind,maxTokens,temperature,timeout,signal,strictFacts}) -> Promise<string>
 *   status() -> 'connected' | 'offline' | 'unknown'
 *   onStatus(fn) -> subscribe to status changes (fn(status))
 *   getModel() -> string | null        last model id/path reported by /v1/models
 *   onModel(fn) -> subscribe to model-id changes (fn(modelId))
 *   getLastFactCheck() -> {ok,expectedArtist,expectedTrack,text} | null
 *   base -> endpoint base URL
 */
(function () {
  'use strict';

  var BASE = (typeof window !== 'undefined' && window.AGENT_RADIO_LLM_BASE) || 'http://127.0.0.1:8081';
  var PROBE_TIMEOUT = 4000;
  var PROBE_TTL = 5000;

  var DEFAULT_TIMEOUT = 40000;
  var KIND_TIMEOUTS = { narrate: 40000, shuffle: 40000, summary: 50000, askai: 60000, story:120000};
  var _kindTimeouts = KIND_TIMEOUTS;
  var _defaultTimeout = DEFAULT_TIMEOUT;
  var REQUEST_TIMEOUT = DEFAULT_TIMEOUT;
  function effectiveTimeout(opts) {
    var ms = (opts && opts.timeout) ? opts.timeout : _defaultTimeout;
    var kind = opts && opts.kind;
    if (kind && _kindTimeouts[kind]) ms = Math.max(ms, _kindTimeouts[kind]);
    return ms;
  }

  var DEFAULT_MAX_TOKENS = 500;
  // v14 (27Jul26, session 5): narration quality improved substantially once
  // caps-corruption (v13) and most fabrication (v11-v13) were suppressed —
  // truncation itself became the dominant complaint this session, with
  // narration frequently cut off mid-sentence well under the old ceiling
  // (e.g. "The Marshall Tucker Band's Fire on", "La Grosse Métal brings you
  // Shroud's haunting passage on the night of", "Metal Rock" with no track
  // details). The v8-era ceilings were set defensively when degeneration/
  // fabrication were the dominant risk; with those now largely contained by
  // dedicated guards (detectAndTruncateCapsCorruption, detectAndTruncate
  // WordRepeat, detectAndTruncateDegeneration, STRICT_FACTS_CLAUSE), those
  // guards are the real safety net now, not a short ceiling. Raised ~30-40%
  // across short-copy kinds; floors nudged up so short replies have more
  // room to land a complete final clause before the ceiling.
  var KIND_FLOORS = { narrate: 180, shuffle: 170, summary: 220, askai: 700 };
  // v20: narrate ceiling raised 440->560 after a confirmed mid-sentence cutoff
  // recurrence -- pairing GRACEFUL_COMPLETION_CLAUSE with more room to finish.
  var KIND_CEILINGS = { narrate: 560, shuffle: 400, summary: 520, askai: 800 };
  function effectiveMaxTokens(opts) {
    var kind = opts && opts.kind;
    var m = (opts && opts.maxTokens) ? opts.maxTokens : DEFAULT_MAX_TOKENS;
    if (kind && KIND_FLOORS[kind]) m = Math.max(m, KIND_FLOORS[kind]);
    if (kind && KIND_CEILINGS[kind] && !(opts && opts.maxTokens)) {
      m = Math.min(m, KIND_CEILINGS[kind]);
    }
    return m;
  }

  var DEFAULT_REPEAT_PENALTY = 1.15;
  var DEFAULT_FREQUENCY_PENALTY = 0.3;
  var DEFAULT_PRESENCE_PENALTY = 0.3;
  var DEFAULT_REPEAT_LAST_N = 256;

  var DEFAULT_TEMPERATURE = 0.7;
  var KIND_TEMPERATURE = { narrate: 0.55, shuffle: 0.55, summary: 0.55, askai: 0.5 };
  function effectiveTemperature(opts) {
    if (opts && opts.temperature != null) return opts.temperature;
    var kind = opts && opts.kind;
    if (kind && KIND_TEMPERATURE[kind] != null) return KIND_TEMPERATURE[kind];
    return DEFAULT_TEMPERATURE;
  }

  var KIND_STOP_SEQUENCES = {
    narrate: ['\n\n', '\n#', '\n##', '**Reasoning', '**Notes'],
    shuffle: ['\n\n', '\n#', '\n##', '**Reasoning', '**Notes'],
    summary: ['\n\n\n', '\n#', '\n##', '**Reasoning', '**Notes'],
    askai: ['\n\n', '\n#', '\n##', '**Reasoning', '**Notes']
  };
  function effectiveStop(opts) {
    if (opts && Array.isArray(opts.stop)) return opts.stop;
    var kind = opts && opts.kind;
    if (kind && KIND_STOP_SEQUENCES[kind]) return KIND_STOP_SEQUENCES[kind];
    return undefined;
  }

  var STRICT_FACTS_KINDS = { narrate: true, askai: true, summary: true };
  var STRICT_FACTS_CLAUSE =
    'ARTIST NAME ORDER: The supplied display artist is already normalized. Reproduce it exactly and never reverse, rotate, translate, respell, or reorder its tokens.\n' +
    'IMPORTANT: Only state facts explicitly present in the information given to you above. ' +
    'Do NOT invent or guess at song titles, movement names, opus/catalog numbers, dates, locations, ' +
    'label names, production/distribution history, release formats, or biographical details that are ' +
    'not explicitly provided. If you do not have a specific detail, speak generally instead of making ' +
    'one up, or say plainly that you do not have that information. ' +
    'ADDITIONALLY: Reproduce every composer name, artist name, track title, and station name EXACTLY as ' +
    'given, character-for-character, including any accents or diacritics. Never respell, translate, ' +
    'anglicize, or phonetically simplify a name — even if it looks unfamiliar or hard to pronounce. ' +
    'Copy it verbatim. ' +
    'ADDITIONALLY: Do NOT reference, name, or describe any other track, composer, artist, or musical work ' +
    '— past, present, or upcoming — unless it is explicitly given to you in the current prompt. Never say ' +
    'what is "coming up next," "tomorrow," or "later," and never mention a "previous" or "earlier" piece ' +
    'unless it appears in a labeled fact block above. Stay entirely within the current track/station facts given. ' +
    'ADDITIONALLY: When you correctly identify a composer or artist, do not add nationality, birthplace, era, ' +
    'or century unless that specific detail is explicitly provided in the facts above — a correct name does ' +
    'not license guessing biographical specifics, even ones that sound plausible. ' +
    'ADDITIONALLY: The station name given to you above is exact and final — reproduce it precisely, ' +
    'character-for-character, every single time you say it. Do not shorten it, do not swap or drop words ' +
    'within it, and do not substitute a similar-sounding or more familiar-sounding name. ' +
    'ADDITIONALLY: If the information given to you is limited to a bare program title, station name, or ' +
    'generic description with no named artist, composer, album, price, or release date, do NOT invent any ' +
    'of those missing details to fill the gap. Speak only about what is actually given — the station, ' +
    'genre, or program name — and do not manufacture a fictional artist, album title, price, or backstory ' +
    'just because none was provided. ' +
    'ADDITIONALLY: Correctly naming real band members, collaborators, or contributors does NOT make it ' +
    'safe to also state a release year, album name, chart position, or other production detail unless ' +
    'that specific detail is explicitly given above. Getting some facts right does not license guessing ' +
    'the rest — treat every individual date, year, and production detail as needing its own explicit ' +
    'source in the facts given, even in a sentence that is otherwise accurate.';

  // v12: applied unconditionally to short-copy kinds (not gated on strictFacts)
  // — targets mid-sentence cutoffs (Berlioz/Turiña/Saint-Saëns/diary samples)
  // by asking the model to plan for the ceiling itself, as a companion to the
  // existing hard max_tokens cap rather than a replacement for it.
  var GRACEFUL_COMPLETION_KINDS = { narrate: true, shuffle: true, summary: true };
  var GRACEFUL_COMPLETION_CLAUSE =
    'IMPORTANT: You have a strict output budget. Plan your response so it fits comfortably within that ' +
    'budget and ALWAYS ends on a complete sentence with terminal punctuation. Prefer being brief and ' +
    'finishing cleanly over being longer and getting cut off mid-sentence. Never trail off, never leave ' +
    'a sentence unfinished, and do not pad the ending with filler words like "today," "tonight," or ' +
    '"tomorrow" repeated in a row. ' +
    'ADDITIONALLY: Be especially careful with comparative phrasing ("more than," "better than," ' +
    '"even more than," "longer than," etc.) — if you start a comparison, you MUST finish it in the same ' +
    'sentence with a concrete point of comparison. If you are not certain you can complete a comparison ' +
    'cleanly, do not start one at all — use a simple, self-contained statement instead. ' +
    'ADDITIONALLY (v20): Use your full output budget, and when you are near its end stop ' +
    'there — write fewer, shorter sentences rather than starting a sentence you might not have room to ' +
    'finish. If you are already mid-response and are not certain a new sentence will fit completely, ' +
    'stop after the last completed sentence instead of starting another one.';

  // v13: ALL-CAPS emphasis reliably triggered spelled-out-letter runs and
  // gibberish blobs (e.g. "A-M-A-T-E-U-S", "WOLKAWNGAMADEUSMORTZOLYGH...").
  // Applied to every kind — the hype-DJ persona doesn't need literal caps
  // to read as energetic, and this removes a reliable degeneration trigger
  // at the prompt level, backstopped by detectAndTruncateCapsCorruption().
  var CAPS_PROHIBITION_KINDS = { narrate: true, shuffle: true, summary: true, askai: true };
  var CAPS_PROHIBITION_CLAUSE =
    'IMPORTANT: Never write any word or phrase in ALL CAPITAL LETTERS for emphasis, and never spell a ' +
    'word out letter-by-letter (e.g. "A-M-A-D-E-U-S"). Convey energy and excitement through word choice ' +
    'and sentence rhythm only, using normal sentence-case capitalization throughout.';

  // v13: when the caller knows the true artist/track (it always does — the
  // relay already has this before calling narrate/askai), inject an
  // explicit anti-swap clause naming them, closing the Boito/Mefistofele
  // composer<->title swap and reducing invented-collaborator drift on
  // genres the model has a weaker factual prior for than classical.
  function buildAntiSwapClause(expectedArtist, expectedTrack) {
    if (!expectedArtist && !expectedTrack) return '';
    var bits = [];
    if (expectedArtist) bits.push('the artist is exactly "' + expectedArtist + '"');
    if (expectedTrack) bits.push('the track title is exactly "' + expectedTrack + '"');
    return 'IMPORTANT: For this specific track, ' + bits.join(' and ') + '. Do not swap the artist and ' +
      'track title with each other, do not attribute this track to any other artist or composer, and do ' +
      'not invent collaborators, band members, or backstory beyond what is explicitly given above. ' +
      (expectedArtist ? (
      'ADDITIONALLY: Never invent a different name, stage name, alias, nickname, or persona for the ' +
      'artist -- the artist\'s name is "' + expectedArtist + '" and nothing else, in any spelling. ' +
      'Do not introduce, greet as, or refer to "' + expectedArtist + '" using any other invented name ' +
      'under any circumstance, even in a first-person or in-character framing.'
      ) : '');
  }

  var _status = 'unknown';
  var _lastProbe = 0;
  var _probeInFlight = null;
  var _listeners = [];
  var _modelListeners = [];
  var _lastModel = null;
  var _fetch = (typeof fetch !== 'undefined') ? fetch.bind(globalThis) : null;

  function emit() {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](_status); } catch (e) {}
    }
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      try { window.dispatchEvent(new CustomEvent('agentradio-llm-status', { detail: { status: _status } })); } catch (e) {}
    }
  }

  function setStatus(s) { if (s !== _status) { _status = s; emit(); } }

  function emitModel() {
    for (var i = 0; i < _modelListeners.length; i++) {
      try { _modelListeners[i](_lastModel); } catch (e) {}
    }
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      try { window.dispatchEvent(new CustomEvent('agentradio-llm-model', { detail: { model: _lastModel } })); } catch (e) {}
    }
  }

  function setModel(m) { if (m && m !== _lastModel) { _lastModel = m; emitModel(); } }

  function withTimeout(ms) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, ms);
    return {
      signal: ctrl ? ctrl.signal : undefined,
      clear: function () { clearTimeout(timer); },
      timedOut: function () { return timedOut; }
    };
  }

  function stripThink(t) {
    if (!t) return '';
    var s = String(t)
      .replace(/[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think>/gi, '')
      .trim();

    var finalMatch = s.match(/#{1,6}\s*(?:final\s*(?:response|answer|script)|spoken\s*script)\s*:?\s*\n+([\s\S]*?)(?:\n#{1,6}\s|$)/i);
    if (finalMatch && finalMatch[1] && finalMatch[1].trim()) {
      s = finalMatch[1].trim();
    } else {
      var metaCut = s.search(/\n\s*(?:-{3,}|\*{2,}\s*(?:reasoning|notes?|summary|explanation)\b|#{1,6}\s*(?:reasoning|analysis|notes?|summary))/i);
      if (metaCut !== -1) s = s.slice(0, metaCut).trim();
    }

    s = s
      .replace(/^#{1,6}\s*.*$/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/^\*+\s*/gm, '')
      .replace(/^-{3,}\s*$/gm, '')
      .replace(/^Spoken Script:?\s*/gim, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
      .replace(/^"([\s\S]*)"$/, '$1')
      .trim();
    return s;
  }

  function normalizeChunk(c) {
    return String(c || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectAndTruncateRepetition(text) {
    if (!text) return text;
    var chunks = String(text).split(/(?<=[.!?])\s+|\n+/).map(function (c) { return c.trim(); }).filter(Boolean);
    if (chunks.length < 2) return text;

    var seen = [];
    var cutIndex = -1;
    for (var i = 0; i < chunks.length; i++) {
      var norm = normalizeChunk(chunks[i]);
      if (norm.length >= 8) {
        for (var j = 0; j < seen.length; j++) {
          var prev = seen[j];
          var isDup = (norm === prev) ||
            (norm.length > 12 && (prev.indexOf(norm) !== -1 || norm.indexOf(prev) !== -1));
          if (isDup) { cutIndex = i; break; }
        }
        if (cutIndex !== -1) break;
        seen.push(norm);
      }
    }
    if (cutIndex === -1) return text;
    var kept = chunks.slice(0, cutIndex).join(' ').trim();
    return kept || chunks[0];
  }

  // v12: catches non-consecutive singleton-word / short-phrase drift that
  // detectAndTruncateRepetition() can't see because it only compares whole
  // sentences/lines — e.g. "tonight tonight ... today tomorrow perhaps
  // later" where no sentence is a verbatim duplicate of another, but a
  // short window of tokens repeats a word/phrase seen a few tokens earlier.
  // Scans phrase lengths 1-3 words over a sliding lookback window and
  // truncates at the first repeat found.
  var WORD_REPEAT_LOOKBACK = 14; // words to look back for a repeat
  // r14r2: was 3, which flagged ordinary grammar. Measured 19 Sep 2026: of 7 narrations
  // silently discarded, 5 were killed by a repeat of "the", "from", or "and". A 3-char
  // floor makes any sentence over ~30 words nearly certain to trip. Raised to 5 and
  // given an explicit function-word exemption; the guard still catches the drift shapes
  // it was written for ("tonight tonight ... today tomorrow perhaps later").
  var WORD_REPEAT_MIN_LEN = 5;
  var WORD_REPEAT_STOPWORDS = {
    of:1, in:1, on:1, at:1, to:1, a:1, an:1, is:1, it:1, by:1, or:1, as:1, so:1, we:1,
    my:1, me:1, i:1, be:1, no:1, up:1, do:1, he:1, she:1, his:1, her:1, our:1, one:1,
    the:1, and:1, from:1, this:1, that:1, with:1, for:1, but:1, its:1, was:1, are:1,
    you:1, your:1, not:1, all:1, any:1, out:1, now:1, like:1, just:1, our:1, who:1,
    what:1, when:1, been:1, have:1, has:1, had:1, into:1, than:1, then:1, they:1,
    them:1, their:1, there:1, here:1, some:1, more:1, most:1, very:1, over:1, about:1,
    which:1, while:1, because:1, right:1, going:1, really:1, actually:1, honestly:1,
    entire:1, still:1, also:1, even:1, only:1, ever:1, never:1, does:1, did:1, get:1
  };
  function detectAndTruncateWordRepeat(text) {
    if (!text) return text;
    var words = String(text).split(/\s+/).filter(Boolean);
    if (words.length < 6) return text;

    function norm(w) { return w.toLowerCase().replace(/[^a-z0-9']/g, ''); }

    for (var phraseLen = 1; phraseLen <= 3; phraseLen++) {
      for (var i = phraseLen; i < words.length; i++) {
        var cur = words.slice(i, i + phraseLen).map(norm).join(' ');
        if (!cur || cur.replace(/[^a-z0-9]/g, '').length < WORD_REPEAT_MIN_LEN) continue;
        // r15r2: ANY phrase composed entirely of function words is grammar, not
        // degeneration. "of the" appears twice in "The Phantom of the Opera - Music of
        // the Night" and previously truncated that title mid-phrase.
        var curTokens = cur.split(' ');
        var allStop = curTokens.length > 0;
        for (var si = 0; si < curTokens.length; si++) {
          if (!WORD_REPEAT_STOPWORDS[curTokens[si]]) { allStop = false; break; }
        }
        if (allStop) continue;
        var lookStart = Math.max(0, i - WORD_REPEAT_LOOKBACK);
        for (var k = lookStart; k < i; k++) {
          var prior = words.slice(k, k + phraseLen).map(norm).join(' ');
          if (prior && prior === cur) {
            // Found an immediate/near-immediate repeat. Truncate at the
            // start of the repeated occurrence, then back up to the last
            // sentence boundary if one exists nearby to avoid a jagged cut.
            var kept = words.slice(0, i).join(' ');
            var lastPunct = Math.max(kept.lastIndexOf('.'), kept.lastIndexOf('!'), kept.lastIndexOf('?'));
            if (lastPunct > kept.length * 0.4) {
              return kept.slice(0, lastPunct + 1).trim();
            }
            // r14r2: previously returned a fragment with no terminal punctuation, which
            // sentenceSafeOutput() then reduced to '' — a valid 200 became silence.
            // Trim a dangling separator or conjunction and close the sentence instead.
            var frag = kept.trim()
              .replace(/[\s,;:\u2013\u2014-]+$/, '')
              .replace(/\s+\b(?:and|or|but|because|with|from|the|a|an|to|of|for|that|which|while|when)\b$/i, '')
              .trim();
            if (!frag) return text;
            if (!/[.!?][\"'\u201d\u2019)]*$/.test(frag)) frag += '.';
            return frag;
          }
        }
      }
    }
    return text;
  }

  // v13: catches two ALL-CAPS-triggered corruption shapes seen live:
  // (1) spelled-out letter runs: "A-M-A-T-E-U-S M-O-R-Z-L-E-I-N-G ..."
  //     (single letters or letter-groups joined by hyphens/spaces)
  // (2) long vowel-less/garbled ALL-CAPS blobs:
  //     "WOLKAWNGAMADEUSMORTZOLYGH..." — an all-caps token that itself
  //     looks like gibberish, or an unreasonably long all-caps run.
  var CAPS_SPELLOUT_RE = /\b(?:[A-Z]-){2,}[A-Z]\b|\b(?:[A-Z]{1,3}-){3,}[A-Z]{1,3}\b/;
  function looksLikeCapsGibberish(token) {
    var w = token.replace(/[^A-Z]/g, '');
    if (w.length < 6) return false;
    var lower = w.toLowerCase();
    if (!/[aeiouy]/.test(lower)) return true;
    if (/[^aeiouy]{5,}/.test(lower)) return true;
    if (w.length >= 14) return true; // implausibly long single caps token
    return false;
  }
  function detectAndTruncateCapsCorruption(text) {
    if (!text) return text;
    var s = String(text);
    var spellout = s.search(CAPS_SPELLOUT_RE);
    if (spellout !== -1) {
      var kept = s.slice(0, spellout).trim();
      var lastPunct = Math.max(kept.lastIndexOf('.'), kept.lastIndexOf('!'), kept.lastIndexOf('?'));
      if (lastPunct > kept.length * 0.3) return kept.slice(0, lastPunct + 1).trim();
      return kept.trim() || text; // r14r2: never hand back empty
    }
    var tokens = s.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i].replace(/[^A-Za-z]/g, '');
      if (t.length >= 6 && t === t.toUpperCase() && looksLikeCapsGibberish(t)) {
        var kept2 = tokens.slice(0, i).join(' ').trim();
        var lastPunct2 = Math.max(kept2.lastIndexOf('.'), kept2.lastIndexOf('!'), kept2.lastIndexOf('?'));
        if (lastPunct2 > kept2.length * 0.3) return kept2.slice(0, lastPunct2 + 1).trim();
        return kept2.trim() || text; // r14r2: never hand back empty
      }
    }
    return text;
  }

  // v17: the v13 caps guard only catches corrupted tokens (spelled-out
  // letters, gibberish blobs) — it does nothing when the model reverts to a
  // sustained ALL-CAPS delivery register made of otherwise-real words
  // ("EXCLUSIVE RADIO'S BLACK SABBLETTLE IS CREATING A METALIST WORLD WHERE
  // SOUND MEANS SURGICAL PRECISION..."). Individual real words like
  // "SURGICAL" or "PRECISION" never trip looksLikeCapsGibberish, so the v13
  // guard passed the whole paragraph through untouched even though the
  // *register itself* had collapsed. This is a different failure shape from
  // corruption: the words are real, but sustained shouting-case at
  // paragraph length reliably correlates with the same underlying
  // instability that also produces the actually-gibberish tokens nearby
  // ("SABBLETTLE", "RAPTUAIS", "THATKIN'") — so rather than only reacting
  // to the gibberish once it appears, this catches the register collapse
  // itself as an early-warning signal and normalizes it before it has a
  // chance to degrade further.
  //
  // Recovery, not just deletion: unlike the truncation guards, a sustained
  // run of ALL-CAPS *real* words isn't lost information — it's a casing
  // problem, not a content problem. So instead of discarding the run,
  // recase it to normal sentence case and keep going. If a genuine
  // gibberish token turns up inside the run, defer to the truncation logic
  // already in detectAndTruncateCapsCorruption (which runs first in
  // cleanOutput) rather than trying to recase nonsense.
  var CAPS_RUN_THRESHOLD = 4; // consecutive all-caps words (2+ letters) that trip normalization
  // v17 fix: a bare 1-letter word ("A", "I") inside an otherwise-caps run
  // must NOT break the run (it would fragment "...A METALIST WORLD..." into
  // two runs and cause a spurious mid-sentence capital on "Metalist"). Treat
  // single-letter tokens as "neutral" — they extend a run in progress but
  // don't start one on their own — rather than as run-breakers.
  function isAllCapsWord(tok) {
    var letters = tok.replace(/[^A-Za-z]/g, '');
    return letters.length >= 2 && letters === letters.toUpperCase() && /[A-Z]/.test(letters);
  }
  function isNeutralInRun(tok) {
    var letters = tok.replace(/[^A-Za-z]/g, '');
    return letters.length === 1 && letters === letters.toUpperCase();
  }
  function lowerWord(w) {
    return w.replace(/[A-Za-z]+/g, function (m) { return m.toLowerCase(); });
  }
  function normalizeSustainedCaps(text) {
    if (!text) return text;
    var words = String(text).split(/\s+/);
    var out = [];
    var i = 0;
    while (i < words.length) {
      if (isAllCapsWord(words[i])) {
        var runStart = i;
        var runEnd = i;
        var capsCount = 0;
        var j = i;
        while (j < words.length && (isAllCapsWord(words[j]) || isNeutralInRun(words[j]))) {
          if (isAllCapsWord(words[j])) capsCount++;
          runEnd = j + 1;
          j++;
        }
        // Trim trailing neutral tokens that aren't actually followed by
        // another caps word (avoid absorbing a lone capital "I" that starts
        // the NEXT normal-case sentence).
        while (runEnd > runStart && isNeutralInRun(words[runEnd - 1]) && !(runEnd < words.length && isAllCapsWord(words[runEnd]))) runEnd--;
        var run = words.slice(runStart, runEnd);
        if (capsCount >= CAPS_RUN_THRESHOLD) {
          var lowered = run.map(lowerWord);
          var atSentenceStart = (out.length === 0) || /[.!?]$/.test(out[out.length - 1] || '');
          if (atSentenceStart && lowered.length) {
            lowered[0] = lowered[0].charAt(0).toUpperCase() + lowered[0].slice(1);
          }
          out = out.concat(lowered);
        } else {
          out = out.concat(run); // short caps runs (station names, acronyms) left as-is
        }
        i = runEnd;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    return out.join(' ');
  }

  var SPIRAL_WORD_THRESHOLD = 35;

  // v16: catches "rambling but grammatical" decay — a failure mode distinct
  // from gibberish-word degeneration, seen specifically in longer generations
  // that now have more room to run after the v14 ceiling raise (Ullien/Ed
  // Baxxter samples: coherent words, but chained into a run-on sentence that
  // drifts semantically until it stops making sense — "...just so people know
  // they're listening for a moment longer than before when someone else had
  // already taken their spot in another room"). Gibberish-word detection
  // can't catch this since every individual word is real. Heuristic: count
  // chained subordinating/coordinating connectors within a single sentence
  // (comma-joined clauses plus words like "so", "when", "where", "because",
  // "before", "after", "just so", "than") — a sentence stacking too many of
  // these is very likely a run-on that has lost its thread, even though no
  // single word looks wrong. Sentence length alone is not enough (some
  // legitimate narration sentences run long), so this specifically weights
  // *connector density*, which correlates with drift much better than raw
  // length in the observed samples.
  // v18: widened after the Metallica/Fade-to-Black sample slipped through —
  // that run-on leaned on "but", "though", "and", "yeah", "anyway", "or
  // maybe" rather than the original narrower list (so/when/where/because/
  // etc.), which was calibrated to one earlier sample's specific vocabulary
  // and didn't generalize. Broadened the connector list AND added a hard
  // raw-length fallback: a single sentence running 45+ words is treated as
  // inherently suspicious regardless of connector density, since genuine
  // narration sentences essentially never need to run that long — this
  // catches drift built from plain coordination ("...and remember nobody
  // ever sleeps forever no matter how many times...") that no connector
  // wordlist can fully enumerate.
  var RAMBLE_CONNECTOR_RE = /\b(so|when|where|because|before|after|than|while|just so|so that|instead|already|but|though|although|yet|still|anyway|somehow|or maybe|no matter|and remember|and now|and honestly)\b/gi;
  var RAMBLE_CONNECTOR_THRESHOLD = 5;
  var RAMBLE_HARD_LENGTH = 45;
  function detectAndTruncateRamble(text) {
    if (!text) return text;
    var sentences = String(text).split(/(?<=[.!?])\s+/);
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      var wordCount = s.split(/\s+/).filter(Boolean).length;
      if (wordCount < 20) continue; // only flag genuinely long sentences
      if (wordCount >= RAMBLE_HARD_LENGTH) {
        var kept0 = sentences.slice(0, i).join(' ').trim();
        return kept0 || sentences[0];
      }
      var matches = s.match(RAMBLE_CONNECTOR_RE);
      var connectorCount = matches ? matches.length : 0;
      if (connectorCount >= RAMBLE_CONNECTOR_THRESHOLD) {
        var kept = sentences.slice(0, i).join(' ').trim();
        return kept || sentences[0];
      }
    }
    return text;
  }

  function looksLikeGibberish(word) {
    var w = word.replace(/[^a-zA-Z]/g, '');
    if (w.length < 3) return false; // v12: lowered floor 4->3
    var lower = w.toLowerCase();
    if (!/[aeiouy]/.test(lower)) return true;
    if (/[^aeiouy]{5,}/.test(lower)) return true;
    if (w.length <= 5 && /(.)\1{1,}/.test(lower) && /[^aeiouy]{3,}/.test(lower)) return true;
    return false;
  }

  function detectAndTruncateDegeneration(text) {
    if (!text) return text;
    var words = String(text).split(/\s+/);
    if (words.length < 10) return text;

    var wordsSinceBreak = 0;
    var gibberishStreak = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var endsSentence = /[.!?]$/.test(w);

      if (looksLikeGibberish(w)) {
        gibberishStreak++;
        if (gibberishStreak >= 2) {
          return words.slice(0, Math.max(0, i - 1)).join(' ').trim() || words.slice(0, 1).join(' ');
        }
      } else {
        gibberishStreak = 0;
      }

      wordsSinceBreak++;
      if (endsSentence) {
        wordsSinceBreak = 0;
      } else if (wordsSinceBreak > SPIRAL_WORD_THRESHOLD) {
        return words.slice(0, i + 1).join(' ').replace(/[,;]$/, '').trim() + '.';
      }
    }

    // v12: short-tail scan. Even when no streak-of-2 ever triggers, a single
    // gibberish/borderline word right after the last terminal punctuation
    // ("...soul who never." + trailing babble) should still be trimmed —
    // check the final clause (text after the last ./!/?) for any gibberish
    // word and drop it if the clause itself never closes with punctuation.
    var joined = words.join(' ');
    var lastPunctIdx = Math.max(joined.lastIndexOf('.'), joined.lastIndexOf('!'), joined.lastIndexOf('?'));
    if (lastPunctIdx !== -1 && lastPunctIdx < joined.length - 1) {
      var tail = joined.slice(lastPunctIdx + 1).trim();
      if (tail) {
        var tailWords = tail.split(/\s+/).filter(Boolean);
        var hasGibberish = tailWords.some(looksLikeGibberish);
        if (hasGibberish || tailWords.length <= 6) {
          return joined.slice(0, lastPunctIdx + 1).trim();
        }
      }
    }
    return text;
  }

  async function probe(force) {
    if (!_fetch) { setStatus('offline'); return false; }
    if (!force && (Date.now() - _lastProbe) < PROBE_TTL && _status !== 'unknown') {
      return _status === 'connected';
    }
    if (_probeInFlight) return _probeInFlight;
    _lastProbe = Date.now();
    _probeInFlight = (async function () {
      var paths = ['/health', '/v1/models', '/'];
      for (var i = 0; i < paths.length; i++) {
        var t = withTimeout(PROBE_TIMEOUT);
        try {
          var r = await _fetch(BASE + paths[i], { signal: t.signal, cache: 'no-store' });
          t.clear();
          if (r && (r.ok || r.status === 200)) {
            setStatus('connected');
            // v12: opportunistically capture the served model id/path so
            // sessions self-report which model was used instead of relying
            // on terminal scrollback. /v1/models is OpenAI-compatible on
            // llama-server: { data: [ { id: "<path-or-name>" } ] }.
            if (paths[i] === '/v1/models') {
              try {
                var mj = await r.clone().json();
                var mid = mj && mj.data && mj.data[0] && mj.data[0].id;
                if (mid) setModel(String(mid));
              } catch (e2) {}
            } else {
              // Some builds only expose /health; try /v1/models separately
              // so model id is still captured even if /health answered first.
              try {
                var t2 = withTimeout(PROBE_TIMEOUT);
                var r2 = await _fetch(BASE + '/v1/models', { signal: t2.signal, cache: 'no-store' });
                t2.clear();
                if (r2 && r2.ok) {
                  var mj2 = await r2.json();
                  var mid2 = mj2 && mj2.data && mj2.data[0] && mj2.data[0].id;
                  if (mid2) setModel(String(mid2));
                }
              } catch (e3) {}
            }
            return true;
          }
        } catch (e) { t.clear(); }
      }
      setStatus('offline');
      return false;
    })();
    try { return await _probeInFlight; }
    finally { _probeInFlight = null; }
  }

  var NO_THINK_KINDS = { narrate: true, shuffle: true, summary: true, askai: true };

  function outputCompletionIssue(value) {
    var text=String(value||'').trim();
    if(!text) return 'empty';
    if(!/[.!?][\"'”’)]*$/.test(text)) return 'unfinished';
    if(/\b(?:a|an|the|to|of|for|with|and|or|but|because|which|that|who|whose|his|her|its)\s*[.!?][\"'”’)]*$/i.test(text)) return 'dangling-tail';
    var straight=(text.match(/\"/g)||[]).length;
    var curlyOpen=(text.match(/“/g)||[]).length;
    var curlyClose=(text.match(/”/g)||[]).length;
    if(straight%2 || curlyOpen!==curlyClose) return 'unclosed-quote';
    return null;
  }
  function sentenceSafeOutput(value) {
    var raw=String(value||'').replace(/\s+/g,' ').trim();
    if(!raw) return '';
    if(!outputCompletionIssue(raw)) return raw;
    var structure=raw
      .replace(/\b(?:Mr|Mrs|Ms|Dr|St|No|Nr|Op|Vol|Pt|Act|etc)\./gi,function(m){return m.slice(0,-1)+'∯';})
      .replace(/\b([IVXLCDM]+)\.(?=\s+[A-Z])/g,'$1∯')
      .replace(/(\d)\.(\d)/g,'$1∯$2');
    var parts=structure.match(/[^.!?]+[.!?]+[\"'”’)]*/g)||[];
    while(parts.length){
      var candidate=parts.join(' ').replace(/∯/g,'.').replace(/\s+/g,' ').trim();
      if(!outputCompletionIssue(candidate)) return candidate;
      parts.pop();
    }
    // r14r2: exhaustion previously returned '' and the caller showed nothing. An
    // imperfect narration is strictly better radio than silence after a 200.
    return raw;
  }
  function cleanOutput(text,kind) {
    if(kind==='story') return String(text||'').replace(/\s+/g,' ').trim();
    var cleaned=detectAndTruncateDegeneration(detectAndTruncateRamble(normalizeSustainedCaps(detectAndTruncateCapsCorruption(detectAndTruncateWordRepeat(detectAndTruncateRepetition(text))))));
    var out=sentenceSafeOutput(cleaned);
    // r14r2: structural floor. If the cleanup chain empties a non-empty model response,
    // fall back to the sentence-safe original rather than emitting nothing.
    if(!out){
      var original=String(text||'').replace(/\s+/g,' ').trim();
      if(original) out=sentenceSafeOutput(original)||original;
    }
    return out;
  }

  // v13: last fact-check result (non-blocking diagnostic, does not alter
  // output). Exposed via api.getLastFactCheck() so the HTML can log/surface
  // suspected fabrication (e.g. composer/title swap, wrong-artist
  // attribution) without the bridge silently rewriting model output.
  var _lastFactCheck = null;
  function verifyFacts(text, expectedArtist, expectedTrack) {
    if (!expectedArtist && !expectedTrack) { _lastFactCheck = null; return; }
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(); };
    var hay = norm(text);
    var artistOk = !expectedArtist || hay.indexOf(norm(expectedArtist)) !== -1;
    var trackOk = !expectedTrack || hay.indexOf(norm(expectedTrack)) !== -1;
    _lastFactCheck = {
      ok: artistOk && trackOk,
      expectedArtist: expectedArtist || null,
      expectedTrack: expectedTrack || null,
      artistFound: artistOk,
      trackFound: trackOk,
      text: text
    };
  }

  async function chat(opts) {
    opts = opts || {};
    if (!_fetch) { var e0 = new Error('fetch unavailable'); e0.code = 'nofetch'; throw e0; }

    var kind = opts.kind;
    var strictFacts = (opts.strictFacts != null) ? !!opts.strictFacts : !!(kind && STRICT_FACTS_KINDS[kind]);
    var systemContent = opts.system || '';
    if (strictFacts && systemContent) systemContent = systemContent + '\n\n' + STRICT_FACTS_CLAUSE;
    if (systemContent && kind && GRACEFUL_COMPLETION_KINDS[kind]) {
      systemContent = systemContent + '\n\n' + GRACEFUL_COMPLETION_CLAUSE;
    }
    if (systemContent && kind && CAPS_PROHIBITION_KINDS[kind]) {
      systemContent = systemContent + '\n\n' + CAPS_PROHIBITION_CLAUSE;
    }
    var antiSwap = buildAntiSwapClause(opts.expectedArtist, opts.expectedTrack);
    if (systemContent && antiSwap) systemContent = systemContent + '\n\n' + antiSwap;

    var messages = [];
    if (systemContent) messages.push({ role: 'system', content: systemContent });
    messages.push({ role: 'user', content: opts.user || '' });
    var maxTokens = effectiveMaxTokens(opts);
    var temperature = effectiveTemperature(opts);
    var repeatPenalty = (opts.repeatPenalty != null) ? opts.repeatPenalty : DEFAULT_REPEAT_PENALTY;
    var frequencyPenalty = (opts.frequencyPenalty != null) ? opts.frequencyPenalty : DEFAULT_FREQUENCY_PENALTY;
    var presencePenalty = (opts.presencePenalty != null) ? opts.presencePenalty : DEFAULT_PRESENCE_PENALTY;
    var repeatLastN = (opts.repeatLastN != null) ? opts.repeatLastN : DEFAULT_REPEAT_LAST_N;
    var stop = effectiveStop(opts);

    var noThink = !!(kind && NO_THINK_KINDS[kind]) && opts.noThink !== false;
    var t = withTimeout(effectiveTimeout(opts));
    var signal = opts.signal || t.signal;
    function buildBody(mt, disableThink) {
      var body = {
        messages: messages,
        max_tokens: mt,
        temperature: temperature,
        stream: false,
        repeat_penalty: repeatPenalty,
        repetition_penalty: repeatPenalty,
        frequency_penalty: frequencyPenalty,
        presence_penalty: presencePenalty,
        repeat_last_n: repeatLastN,
        repetition_context_size: repeatLastN
      };
      if (stop && stop.length) body.stop = stop;
      if (disableThink) body.chat_template_kwargs = { enable_thinking: false };
      return JSON.stringify(body);
    }

    try {
      var r = await _fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildBody(maxTokens, noThink),
        signal: signal
      });
      if (r && r.status === 404) {
        var prompt = (systemContent ? systemContent + '\n\n' : '') + (opts.user || '');
        var fallbackBody = {
          prompt: prompt,
          n_predict: maxTokens,
          temperature: temperature,
          repeat_penalty: repeatPenalty,
          frequency_penalty: frequencyPenalty,
          presence_penalty: presencePenalty,
          repeat_last_n: repeatLastN,
          stream: false
        };
        if (stop && stop.length) fallbackBody.stop = stop;
        r = await _fetch(BASE + '/completion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fallbackBody),
          signal: signal
        });
        t.clear();
        if (!r || !r.ok) {
          var e1 = new Error('llm http ' + (r && r.status));
          e1.code = (r && r.status === 500) ? 'servererror' : 'http';
          throw e1;
        }
        var jc = await r.json();
        setStatus('connected');
        var outC = stripThink(jc.content || (jc.choices && jc.choices[0] && jc.choices[0].text) || '');
        var cleanedC = cleanOutput(outC,kind);
        verifyFacts(cleanedC, opts.expectedArtist, opts.expectedTrack);
        return cleanedC;
      }
      t.clear();
      if (!r || !r.ok) {
        // v22: llama-server's own response-parser (common_chat_peg_parse) can
        // reject a malformed generation server-side, surfacing as a raw 500 --
        // qualitatively different from the server being unreachable. Retry once
        // with noThink forced (cheap insurance against a single bad decode)
        // before giving up, and tag the eventual failure distinctly so callers
        // don't show a misleading "not running" message for a server that is
        // demonstrably up.
        if (r && r.status === 500 && !noThink) {
          var rRetry = await _fetch(BASE + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: buildBody(maxTokens, true),
            signal: signal
          });
          if (rRetry && rRetry.ok) { r = rRetry; }
          else {
            var eR = new Error('llm http 500 (retry failed)'); eR.code = 'servererror'; throw eR;
          }
        } else {
          var e2 = new Error('llm http ' + (r && r.status));
          e2.code = (r && r.status === 500) ? 'servererror' : 'http';
          throw e2;
        }
      }
      var j = await r.json();
      setStatus('connected');
      var txt = j.choices && j.choices[0] && (j.choices[0].message ? j.choices[0].message.content : j.choices[0].text);
      var out = stripThink(txt || '');
      if (!out && !noThink) {
        var r2 = await _fetch(BASE + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(maxTokens, true),
          signal: signal
        });
        if (r2 && r2.ok) {
          var j2 = await r2.json();
          var txt2 = j2.choices && j2.choices[0] && (j2.choices[0].message ? j2.choices[0].message.content : j2.choices[0].text);
          out = stripThink(txt2 || '');
        }
      }
      var cleaned = cleanOutput(out,kind);
      verifyFacts(cleaned, opts.expectedArtist, opts.expectedTrack);
      return cleaned;
    } catch (err) {
      t.clear();
      if (t.timedOut() || (err && err.name === 'AbortError')) {
        var te = new Error('Local AI timed out'); te.code = 'timeout'; throw te;
      }
      setStatus('offline');
      if (!err.code) err.code = 'network';
      throw err;
    }
  }

  var api = {
    probe: probe,
    chat: chat,
    status: function () { return _status; },
    onStatus: function (fn) { if (typeof fn === 'function') { _listeners.push(fn); } return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); }; },
    getModel: function () { return _lastModel; },
    onModel: function (fn) { if (typeof fn === 'function') { _modelListeners.push(fn); } return function () { _modelListeners = _modelListeners.filter(function (f) { return f !== fn; }); }; },
    getLastFactCheck: function () { return _lastFactCheck; },
    stripThink: stripThink,
    detectAndTruncateRepetition: detectAndTruncateRepetition,
    detectAndTruncateWordRepeat: detectAndTruncateWordRepeat,
    detectAndTruncateCapsCorruption: detectAndTruncateCapsCorruption,
    detectAndTruncateRamble: detectAndTruncateRamble,
    normalizeSustainedCaps: normalizeSustainedCaps,
    detectAndTruncateDegeneration: detectAndTruncateDegeneration,
    outputCompletionIssue: outputCompletionIssue,
    sentenceSafeOutput: sentenceSafeOutput,
    effectiveMaxTokens: effectiveMaxTokens,
    effectiveTemperature: effectiveTemperature,
    effectiveStop: effectiveStop,
    KIND_FLOORS: KIND_FLOORS,
    KIND_CEILINGS: KIND_CEILINGS,
    KIND_TEMPERATURE: KIND_TEMPERATURE,
    KIND_STOP_SEQUENCES: KIND_STOP_SEQUENCES,
    STRICT_FACTS_KINDS: STRICT_FACTS_KINDS,
    GRACEFUL_COMPLETION_KINDS: GRACEFUL_COMPLETION_KINDS,
    CAPS_PROHIBITION_KINDS: CAPS_PROHIBITION_KINDS,
    DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS,
    DEFAULT_TEMPERATURE: DEFAULT_TEMPERATURE,
    effectiveTimeout: effectiveTimeout,
    KIND_TIMEOUTS: KIND_TIMEOUTS,
    DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
    DEFAULT_REPEAT_PENALTY: DEFAULT_REPEAT_PENALTY,
    DEFAULT_FREQUENCY_PENALTY: DEFAULT_FREQUENCY_PENALTY,
    DEFAULT_PRESENCE_PENALTY: DEFAULT_PRESENCE_PENALTY,
    STRICT_FACTS_CLAUSE: STRICT_FACTS_CLAUSE,
    GRACEFUL_COMPLETION_CLAUSE: GRACEFUL_COMPLETION_CLAUSE,
    CAPS_PROHIBITION_CLAUSE: CAPS_PROHIBITION_CLAUSE,
    buildAntiSwapClause: buildAntiSwapClause,
    base: BASE,
    REQUEST_TIMEOUT: REQUEST_TIMEOUT,
    _setFetch: function (fn) { _fetch = fn; },
    _setBase: function (b) { BASE = b; },
    _setKindTimeouts: function (map) {
      if (!map) { _kindTimeouts = KIND_TIMEOUTS; _defaultTimeout = DEFAULT_TIMEOUT; return; }
      _kindTimeouts = { narrate: map.narrate, shuffle: map.shuffle, summary: map.summary, askai: map.askai };
      _defaultTimeout = (map.default != null) ? map.default : DEFAULT_TIMEOUT;
    },
    _reset: function () { _status = 'unknown'; _lastProbe = 0; _probeInFlight = null; _lastModel = null; _kindTimeouts = KIND_TIMEOUTS; _defaultTimeout = DEFAULT_TIMEOUT; }
  };

  if (typeof window !== 'undefined') window.AgentRadioLLM = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
