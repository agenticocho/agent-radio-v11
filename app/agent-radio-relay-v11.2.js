#!/usr/bin/env node
/**
 * Agent Radio v10 — Metadata + Stream Relay + Favicon Proxy (companion for agent-radio-v10.html)
 * Built: 21 Jul 2026  ·  Project: Agent Radio (standalone)
 *
 * Standalone, zero-dependency Node HTTP server bound to 127.0.0.1:4200.
 * It is a purpose-built relay for the Agent Radio player: it does raw
 * current-track extraction (ICY + official JSON), CORS mediation, request
 * throttling, short-TTL caching, AND a registered-station-only audio stream
 * proxy (NEW in v5) so the browser receives clean same-origin audio/mpeg or
 * audio/aac — fixing the v4 playback failures caused by redirects, CORS,
 * mixed-content and error-page responses. Enrichment (MusicBrainz / Cover
 * Art Archive) is performed browser-side by the HTML; the relay never touches
 * those services and never records audio.
 *
 * Routes
 *   GET  /                                → agent-radio-v6.html (player UI)
 *   GET  /radio  /radio/  /agent-radio-v6.html → player UI
 *   GET  /catalog.json                     → full deduplicated accepted catalog (NEW v6)
 *   GET  /stream/<stationId>             → audio stream proxy (NEW v5)
 *   GET  /health                          → relay health (used by the player)
 *   GET  /radio/now-playing?stationId=<id>   → normalized current-track (§5.2)
 *   GET  /radio/diagnostics?stationId=<id>   → non-secret diagnostics (§6.8)
 *   POST /radio/register-stations         → register catalog from the player (§6.2)
 *
 * Stream proxy security (NEW v5)
 *   - Only streams URLs registered for a known station id (no arbitrary URLs).
 *   - http:/https: only; private/loopback/link-local/ULA hosts rejected on EVERY redirect hop.
 *   - Follows redirects (cap 6) and resolves .m3u/.pls playlists to a direct audio URL.
 *   - Does NOT request ICY metadata on the playback stream (metadata blocks corrupt browser audio);
 *     metadata is fetched separately via /radio/now-playing.
 *   - Preserves upstream Content-Type (or infers from registered codec). Never hardcodes blindly.
 *   - Aborts upstream on client close so station switching leaks no connections.
 *   - Separate concurrency cap for long-lived audio streams (does not starve metadata fetches).
 *   - No audio is written to disk or retained beyond the live pipe.
 *
 * Security (§6.4 / §14)
 *   - Bound to 127.0.0.1; registration accepts localhost requests only.
 *   - Upstream connects only to URLs registered for known station IDs.
 *   - http:/https: only; private/loopback/link-local/ULU hosts rejected.
 *   - Redirects capped (3) and re-validated; non-http(s) redirects refused.
 *   - Bytes read before metadata discovery are capped; audio is discarded.
 *   - Simultaneous upstream connections are capped (semaphore).
 *   - No audio is written to disk or retained in memory beyond the metadata.
 *   - Diagnostics expose no tokens, headers, or stack traces.
 */
'use strict';
const { normalizeParsedMetadata } = require('./agent-radio-artist-identity-v1.cjs');
function finalizeResponseIdentity(base) {
  const normalized = normalizeParsedMetadata(base);
  normalized.artist = normalized.displayArtist;
  normalized.composer = normalized.displayComposer;
  return normalized;
}

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const url   = require('url');
const dns   = require('dns');
const { execFile } = require('child_process');
const crypto = require('crypto');
const AGENT_RADIO_AUTH_HELPER = process.env.AGENT_RADIO_AUTH_HELPER || '';
const AGENT_RADIO_AUTH_ACTIONS = new Set(['manual-narrate', 'session-summary']);
const AGENT_RADIO_AUTH_GRANTS = new Map();
const AGENT_RADIO_AUTH_TTL_MS = 60_000;
let agentRadioAuthPromptActive = false;

// ── Runtime controller broker (AR-DJ-RUNTIME-04 repair) ──────────────────────
// The relay is a REQUESTER/broker only. It never holds runtime lifecycle
// authority, never loads the controller in-process, and never spawns it: it
// writes ONE fixed-schema request ({ nonce, verb }) to a fixed private request
// location and awaits a fixed-schema response at a fixed private response
// location with a bounded timeout. The on-demand, launchd-supervised,
// single-instance controller is activated by that location (see the controller
// plist); it owns native authorization and the one fixed runtime target.
const AGENT_RADIO_RUNTIME_VERBS = Object.freeze({
  '/runtime-controller/status': 'status',
  '/runtime-controller/request-stop': 'requestStop',
  '/runtime-controller/request-start': 'requestStart',
});
const AGENT_RADIO_RUNTIME_NONCES = new Map();
const AGENT_RADIO_RUNTIME_NONCE_TTL_MS = 30_000;
const AGENT_RADIO_RUNTIME_BODY_CAP = 4096;
const AGENT_RADIO_RUNTIME_WAIT_MS = Number(process.env.AGENT_RADIO_RUNTIME_WAIT_MS) || 300000;
let agentRadioRuntimeControllerBusy = false;

// Fixed private request/response locations (implementation constants, never
// browser-supplied). Defaults live under the private state dir, not /tmp.
function agentRadioRuntimeRequestDir() {
  return process.env.AGENT_RADIO_RUNTIME_REQUEST_DIR ||
    path.join(os.homedir(), '.local', 'state', 'agent-radio', 'runtime-controller', 'requests');
}
function agentRadioRuntimeResponseDir() {
  return process.env.AGENT_RADIO_RUNTIME_RESPONSE_DIR ||
    path.join(os.homedir(), '.local', 'state', 'agent-radio', 'runtime-controller', 'responses');
}

function agentRadioRuntimeReply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function agentRadioRuntimePruneNonces() {
  const now = Date.now();
  for (const [nonce, expiresAt] of AGENT_RADIO_RUNTIME_NONCES) {
    if (expiresAt <= now) AGENT_RADIO_RUNTIME_NONCES.delete(nonce);
  }
}

function agentRadioRuntimeEnsureDirs() {
  try {
    // Explicit private mode 0700 on the request/response directories; do not
    // rely on the ambient umask.
    fs.mkdirSync(agentRadioRuntimeRequestDir(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(agentRadioRuntimeResponseDir(), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(agentRadioRuntimeRequestDir(), 0o700); } catch (_) {}
    try { fs.chmodSync(agentRadioRuntimeResponseDir(), 0o700); } catch (_) {}
    return true;
  } catch (_) { return false; }
}

// Write exactly one fixed-schema request carrying only a correlation nonce and
// one allowlisted verb. Atomic temp-then-rename so launchd never sees a partial
// file.
function agentRadioRuntimeSubmitRequest(verb) {
  return new Promise(resolve => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const reqPath = path.join(agentRadioRuntimeRequestDir(), 'req-' + nonce + '.json');
    const tmpPath = reqPath + '.tmp';
    // Explicit private file mode 0600 (temp and final), not ambient umask.
    fs.writeFile(tmpPath, JSON.stringify({ nonce, verb }), { flag: 'wx', mode: 0o600 }, err => {
      if (err) return resolve({ ok: false, error: 'request_write_failed', nonce });
      try { fs.chmodSync(tmpPath, 0o600); } catch (_) {}
      fs.rename(tmpPath, reqPath, rerr => {
        if (rerr) { try { fs.unlinkSync(tmpPath); } catch (_) {} return resolve({ ok: false, error: 'request_write_failed', nonce }); }
        try { fs.chmodSync(reqPath, 0o600); } catch (_) {}
        resolve({ ok: true, nonce });
      });
    });
  });
}

// Await a response whose correlation nonce matches. Stale/mismatched responses
// are ignored (never consumed as this request's answer). Bounded timeout.
function agentRadioRuntimeAwaitResponse(nonce) {
  const deadline = Date.now() + AGENT_RADIO_RUNTIME_WAIT_MS;
  const respPath = path.join(agentRadioRuntimeResponseDir(), 'resp-' + nonce + '.json');
  return new Promise(resolve => {
    const tick = () => {
      if (Date.now() >= deadline) return resolve({ ok: false, error: 'runtime_controller_timeout' });
      fs.readFile(respPath, 'utf8', (err, data) => {
        if (err) return setTimeout(tick, 50);
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { return setTimeout(tick, 50); }
        if (!parsed || typeof parsed !== 'object' || parsed.nonce !== nonce) {
          return setTimeout(tick, 50); // stale/mismatched: keep waiting
        }
        try { fs.unlink(respPath, () => {}); } catch (_) {}
        resolve({ ok: true, result: parsed.result });
      });
    };
    tick();
  });
}

async function agentRadioHandleRuntimeController(req, res, route) {
  if (req.method !== 'POST') {
    return agentRadioRuntimeReply(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  if (!isLocalhostReq(req) || !agentRadioAuthSameOrigin(req)) {
    return agentRadioRuntimeReply(res, 403, { ok: false, error: 'same_origin_required' });
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return agentRadioRuntimeReply(res, 415, { ok: false, error: 'application_json_required' });
  }
  let body;
  try { body = await agentRadioAuthReadJSON(req, AGENT_RADIO_RUNTIME_BODY_CAP); }
  catch (error) { return agentRadioRuntimeReply(res, 400, { ok: false, error: error.message }); }

  // Reject any caller-supplied field: no label, path, command, PID, port,
  // model, or environment value is ever accepted. The body must be empty.
  if (Object.keys(body).length !== 0) {
    return agentRadioRuntimeReply(res, 400, { ok: false, error: 'unexpected_fields' });
  }

  if (route === '/runtime-controller/nonce') {
    agentRadioRuntimePruneNonces();
    const nonce = crypto.randomBytes(24).toString('hex');
    AGENT_RADIO_RUNTIME_NONCES.set(nonce, Date.now() + AGENT_RADIO_RUNTIME_NONCE_TTL_MS);
    return agentRadioRuntimeReply(res, 200, { ok: true, nonce, expiresInSeconds: 30, singleUse: true });
  }

  const verb = AGENT_RADIO_RUNTIME_VERBS[route];
  if (!verb) return agentRadioRuntimeReply(res, 404, { ok: false, error: 'not-found' });

  // State-changing routes require a single-use nonce on a custom header, which
  // forces a CORS preflight and defeats simple cross-origin forms and replay.
  if (verb !== 'status') {
    const nonce = String(req.headers['x-agent-radio-runtime-nonce'] || '');
    agentRadioRuntimePruneNonces();
    const expiresAt = AGENT_RADIO_RUNTIME_NONCES.get(nonce);
    if (!nonce || !expiresAt) return agentRadioRuntimeReply(res, 403, { ok: false, error: 'missing_or_invalid_nonce' });
    AGENT_RADIO_RUNTIME_NONCES.delete(nonce); // single-use: consume before acting
    if (expiresAt <= Date.now()) return agentRadioRuntimeReply(res, 410, { ok: false, error: 'nonce_expired' });
  }

  // Serialize activation at the broker, mirroring the controller's own
  // single-instance guarantee.
  if (agentRadioRuntimeControllerBusy) {
    return agentRadioRuntimeReply(res, 409, { ok: false, error: 'controller_busy' });
  }
  agentRadioRuntimeControllerBusy = true;
  try {
    if (!agentRadioRuntimeEnsureDirs()) {
      return agentRadioRuntimeReply(res, 503, { ok: false, error: 'runtime_controller_unavailable' });
    }
    const submit = await agentRadioRuntimeSubmitRequest(verb);
    if (!submit.ok) {
      return agentRadioRuntimeReply(res, 503, { ok: false, error: submit.error });
    }
    const response = await agentRadioRuntimeAwaitResponse(submit.nonce);
    if (!response.ok) {
      return agentRadioRuntimeReply(res, 504, { ok: false, error: response.error });
    }
    return agentRadioRuntimeReply(res, 200, response.result);
  } finally {
    agentRadioRuntimeControllerBusy = false;
  }
}

function agentRadioAuthReply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function agentRadioAuthSameOrigin(req) {
  const host = String(req.headers.host || '');
  if (!/^127\.0\.0\.1:\d+$/.test(host)) return false;
  return String(req.headers.origin || '') === `http://${host}`;
}

function agentRadioAuthReadJSON(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('body_too_large'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid_json');
        resolve(value);
      } catch (_) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', () => reject(new Error('request_error')));
  });
}

function agentRadioAuthValidChallenge(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function agentRadioRunAuthHelper(action) {
  return new Promise(resolve => {
    if (!AGENT_RADIO_AUTH_HELPER || !path.isAbsolute(AGENT_RADIO_AUTH_HELPER)) {
      return resolve({ ok: false, status: 503, error: 'native_auth_unavailable' });
    }
    try {
      fs.accessSync(AGENT_RADIO_AUTH_HELPER, fs.constants.X_OK);
    } catch (_) {
      return resolve({ ok: false, status: 503, error: 'native_auth_unavailable' });
    }
    execFile(AGENT_RADIO_AUTH_HELPER, [action], {
      timeout: 125000,
      windowsHide: true,
      maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() }
    }, error => {
      if (!error) return resolve({ ok: true });
      if (error.code === 2) return resolve({ ok: false, status: 403, error: 'native_auth_denied' });
      resolve({ ok: false, status: 503, error: 'native_auth_unavailable' });
    });
  });
}

function agentRadioAuthPrune() {
  const now = Date.now();
  for (const [token, record] of AGENT_RADIO_AUTH_GRANTS) {
    if (record.expiresAt <= now) AGENT_RADIO_AUTH_GRANTS.delete(token);
  }
}

async function agentRadioHandleNativeAuth(req, res, route) {
  if (!isLocalhostReq(req) || !agentRadioAuthSameOrigin(req)) {
    return agentRadioAuthReply(res, 403, { ok: false, error: 'same_origin_required' });
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return agentRadioAuthReply(res, 415, { ok: false, error: 'application_json_required' });
  }
  let body;
  try { body = await agentRadioAuthReadJSON(req); }
  catch (error) { return agentRadioAuthReply(res, 400, { ok: false, error: error.message }); }

  const action = body.action;
  const challenge = body.challenge;
  if (!AGENT_RADIO_AUTH_ACTIONS.has(action) || !agentRadioAuthValidChallenge(challenge)) {
    return agentRadioAuthReply(res, 400, { ok: false, error: 'invalid_action_or_challenge' });
  }
  agentRadioAuthPrune();

  if (route === '/native-auth/authorize') {
    if (agentRadioAuthPromptActive) {
      return agentRadioAuthReply(res, 409, { ok: false, error: 'native_auth_prompt_active' });
    }
    agentRadioAuthPromptActive = true;
    let result;
    try { result = await agentRadioRunAuthHelper(action); }
    finally { agentRadioAuthPromptActive = false; }
    if (!result.ok) return agentRadioAuthReply(res, result.status, { ok: false, error: result.error });
    const grant = crypto.randomBytes(32).toString('hex');
    AGENT_RADIO_AUTH_GRANTS.set(grant, { action, challenge, expiresAt: Date.now() + AGENT_RADIO_AUTH_TTL_MS });
    return agentRadioAuthReply(res, 200, { ok: true, action, grant, expiresInSeconds: 60, singleUse: true });
  }

  const grant = typeof body.grant === 'string' ? body.grant : '';
  const record = AGENT_RADIO_AUTH_GRANTS.get(grant);
  if (!record) return agentRadioAuthReply(res, 403, { ok: false, error: 'no_active_grant' });
  AGENT_RADIO_AUTH_GRANTS.delete(grant);
  if (record.expiresAt <= Date.now()) {
    return agentRadioAuthReply(res, 410, { ok: false, error: 'grant_expired' });
  }
  if (record.action !== action || record.challenge !== challenge) {
    return agentRadioAuthReply(res, 403, { ok: false, error: 'action_challenge_or_grant_mismatch' });
  }
  return agentRadioAuthReply(res, 200, { ok: true, action, consumed: true, singleUseEnforced: true, grantInvalidated: true });
}

const { resolveLocation } = require('./centroids.js');   // v7: embedded country/region centroid tables (no external API)
let Database = null;
try { Database = require('better-sqlite3'); } catch (e) { /* optional dep: enrich route degrades to no-data if missing */ }

const PORT        = Number(process.env.AGENT_RADIO_PORT) || 4211;
const HOST        = '127.0.0.1';
const UA          = 'AgentRadio/10.0 (Jarvis; local)';
const HTML_FILE=path.join(__dirname,'agent-radio-v11.2.html');
const STREAM_UA   = 'AgentRadio/10.0 (stream proxy; local)';

// ── Link-out-only services ───────────────────────────────────────────────────
// Some providers do not permit third-party clients at all. SomaFM is one: their ToS
// (updated 4 Sep 2026, restated 30 Sep 2026) says "We can't grant permission for
// third-party SomaFM clients or applications, even noncommercial ones", that they are
// "not approving new third-party clients", and that their exceptions are for
// "general-purpose radio tuner applications that predate this policy". Presenting as one of
// those clients would be claiming an exception we do not have, so this station does not
// proxy them -- it links out to the player they publish themselves.
//
// Keyed on the upstream HOST, not on station id: ids come from third-party catalogues and
// are not stable, while the host is the party whose terms apply.
const LINK_OUT_HOSTS = Object.freeze([
  { match: /(^|\.)somafm\.com$/i, service: 'SomaFM', url: 'https://somafm.com/' },
]);

function linkOutForStream(streamUrl) {
  let host;
  try { host = new URL(String(streamUrl || '')).hostname; } catch { return null; }
  if (!host) return null;
  for (const rule of LINK_OUT_HOSTS) {
    if (rule.match.test(host)) return rule;
  }
  return null;
}
// Catalog: prefer the v10 favicon-backfilled catalog, then the canonical filename.
const CATALOG_FILE   = [
  path.join(__dirname, 'agent-radio-stations-v11.2-projected.json'),
  path.join(__dirname, 'agent-radio-stations.json'),
].find(f => fs.existsSync(f)) || path.join(__dirname, 'agent-radio-stations.json');
const PROBE_FILE      = path.join(__dirname, 'v9_probe_results.json');
const MAX_STREAM_REDIRECTS  = 6;
const MAX_STREAM_CONCURRENT = 6;   // long-lived audio streams (separate from metadata cap)
const STREAM_CONNECT_TIMEOUT_MS = 10000;
const STREAM_IDLE_TIMEOUT_MS   = 30000;   // no bytes for this long → abort

const UPSTREAM_TIMEOUT_MS = Number(process.env.AGENT_RADIO_UPSTREAM_TIMEOUT) || 12000;   // connect + overall read for one extraction
const HARD_BYTE_CAP       = 1_500_000;  // never read more than 1.5 MB looking for metadata
const MAX_REDIRECTS       = 3;
const MAX_CONCURRENT      = 8;       // simultaneous upstream fetches
const REG_PAYLOAD_CAP     = 2_000_000; // 2 MB registration body cap
const STALE_GRACE_MS      = 5 * 60 * 1000;  // serve last value marked stale for 5 min
const MIN_CACHE_TTL_S     = 8;
const MAX_CACHE_TTL_S     = 45;

// Test mode: permits loopback mock upstreams so the hardening suite can drive
// the relay end-to-end. OFF in production (production fetches real public
// streams only, enforced by the SSRF guard below).
const TEST_MODE = process.env.AGENT_RADIO_TEST === '1';

// ── Registered station catalog (keyed by station id) ──────────────────────────
/** @type {Map<string, {id,name,streamUrl,metadata}>} */
const REGISTRY = new Map();

// ── Per-station cache (§6.7) ──────────────────────────────────────────────────
/** @type {Map<string, {value, fetchedAt, expiresAt, inFlight, lastError, failures, lastAttemptAt, lastSuccessAt}>} */
const CACHE = new Map();

// ── Concurrency semaphore ─────────────────────────────────────────────────────
let _active = 0;
const _waiters = [];
function acquire() {
  if (_active < MAX_CONCURRENT) { _active++; return Promise.resolve(); }
  return new Promise(res => _waiters.push(res));
}
function release() {
  if (_waiters.length) { _waiters.shift()(); }
  else { _active = Math.max(0, _active - 1); }
}

// ── Catalog load + auto-register (NEW v6) ─────────────────────────────────────
// Full deduplicated accepted catalog served at GET /catalog.json. Every station
// is auto-registered so /stream/:id and /radio/now-playing work without the
// player POSTing a registration. The 15-station hard-coded subset is gone.
/** @type {Array<object>} rich catalog records (served at /catalog.json) */
let CATALOG = [];
const CATALOG_STATS = { file: null, totalRecords: 0, dedupAccepted: 0, plottable: 0, unavailable: 0, hls: 0, probeMerged: false };

function parseCheckedAt(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return isFinite(t) ? t : 0;
}

// Derive a metadata strategy from the catalog fields so /radio/now-playing can
// extract ICY/JSON per station without the player configuring each one.
function deriveMetadata(rec) {
  const codec = (rec.codec || '').toUpperCase();
  const st = (rec.stream_type || '').toLowerCase();
  const ms = (rec.metadata_support || '').toLowerCase();
  const classical = /classical|classic|orchestr|symphon/i.test(rec.genre || '');
  let strategy = 'icy';            // icecast / direct MP3/AAC expose ICY by default
  let endpoint = null;
  if (ms === 'none') strategy = 'none';
  else if (ms === 'json' && rec.metadata_endpoint) { strategy = 'json'; endpoint = rec.metadata_endpoint; }
  else if (ms === 'orb' && rec.metadata_endpoint) { strategy = 'orb'; endpoint = rec.metadata_endpoint; }
  else if (st === 'hls' || codec === 'HLS') strategy = 'none';   // HLS byte-proxy can't read ICY
  return { strategy, endpoint, classical, enabled: strategy !== 'none' };
}

function loadCatalog() {
  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    CATALOG_STATS.file = CATALOG_FILE;
  } catch (e) {
    console.error(`[agent-radio] catalog load failed (${CATALOG_FILE}): ${e.message}`);
    CATALOG = [];
    return;
  }
  CATALOG_STATS.totalRecords = Array.isArray(records) ? records.length : 0;
  if (!Array.isArray(records)) records = [];

  // Dedup by station_uuid (keep most recently checked_at). Records without a uuid
  // are kept individually (defensive — never silently dropped for lacking a uuid).
  const byUuid = new Map();
  const noUuid = [];
  // A5.3R22: each drop below was a bare continue - no log, no counter. In A5.3R18, 67 records
  // carried a verification_status this gate rejects; they loaded into the catalog and never
  // rendered, and the station list showed 20 of 87 with no error anywhere. The drops are
  // unchanged. They are now counted, and the tally is published on /health as catalog.dropped,
  // so the next occurrence is one glance instead of a two-hour hunt.
  const dropped = { byStatus: 0, noStreamUrl: 0, badId: 0, notPublicUrl: 0, total: 0 };
  const _drop = (reason) => { dropped[reason]++; dropped.total++; };
  for (const r of records) {
    if (r.verification_status && r.verification_status !== 'accepted' && r.verification_status !== 'verified') { _drop('byStatus'); continue; }
    if (!r.stream_url || typeof r.stream_url !== 'string') { _drop('noStreamUrl'); continue; }
    if (!isValidStationId(r.id)) { _drop('badId'); continue; }
    try { assertPublicUrl(r.stream_url); } catch { _drop('notPublicUrl'); continue; }
    if (r.station_uuid) {
      const prev = byUuid.get(r.station_uuid);
      if (!prev || parseCheckedAt(r.checked_at) >= parseCheckedAt(prev.checked_at)) byUuid.set(r.station_uuid, r);
    } else noUuid.push(r);
  }
  const deduped = [...byUuid.values(), ...noUuid];
  CATALOG_STATS.dropped = dropped;   // A5.3R22

  // Merge probe results (v6_probe_results.json) for honest availability flags.
  let probe = null;
  try {
    if (fs.existsSync(PROBE_FILE)) {
      probe = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')).stations || {};
      CATALOG_STATS.probeMerged = true;
    }
  } catch { /* probe optional */ }

  CATALOG = [];
  for (const r of deduped) {
    const md = deriveMetadata(r);
    const p = probe && probe[r.id];
    let available = true, unavailableReason = null;
    if (p) {
      if (p.status === 'playable') { available = true; }
      else { available = false; unavailableReason = p.reason || 'unavailable'; if (p.isHls) CATALOG_STATS.hls++; }
    }
    const lat = r.latitude, lon = r.longitude;
    const hasCoords = (lat !== null && lat !== undefined) && (lon !== null && lon !== undefined);
    // v7 tiered map resolution: exact → region → country centroid. Adds resolved
    // coordinates for stations without exact lat/lon so they still plot. Original
    // latitude/longitude are preserved; resolvedLat/resolvedLon + locationTier are
    // additive. tier='exact' uses the real coords; region/country are approximate.
    const resolved = resolveLocation(r);
    if (resolved.tier !== 'unknown') CATALOG_STATS.plottable++;
    if (!available) CATALOG_STATS.unavailable++;

    REGISTRY.set(r.id, {
      id: r.id,
      name: r.name || r.id,
      streamUrl: r.stream_url,
      favicon: r.favicon || null,
      codec: r.codec || null,
      available,
      unavailableReason,
      metadata: { ...md, pollSeconds: 20, parser: 'auto' },
    });
    CATALOG.push({
      id: r.id, name: r.name || r.id, network: r.network || null, homepage: r.homepage || null,
      streamUrl: r.stream_url, favicon: r.favicon || null, genre: r.taxonomy?.genreParent || r.genre || null,
      genreRaw: r.taxonomy?.genreRaw ?? r.genre ?? null,
      tags: Array.isArray(r.tags) ? r.tags : [],
      tagsRaw: Array.isArray(r.taxonomy?.tagsRaw) ? r.taxonomy.tagsRaw : (Array.isArray(r.tags) ? r.tags : []),
      taxonomy: r.taxonomy || null, country: r.country || null, countryCode: r.country_code || null,
      region: r.region || null, city: r.city || null, latitude: lat ?? null, longitude: lon ?? null,
      resolvedLat: resolved.lat, resolvedLon: resolved.lon, locationTier: resolved.tier,
      locationPrecision: r.location_precision || null, languages: Array.isArray(r.languages) ? r.languages : [],
      codec: r.codec || null, bitrateKbps: r.bitrate_kbps ?? null, streamType: r.stream_type || null,
      playbackMode: r.playback_mode || null, corsStatus: r.cors_status || null, popularity: r.popularity ?? null,
      available, unavailableReason, classical: md.classical, stationUuid: r.station_uuid || null,
    });
  }
  CATALOG_STATS.dedupAccepted = CATALOG.length;
}
loadCatalog();   // run at module load so REGISTRY is populated before listen
function nowIso() { return new Date().toISOString(); }
function isLocalhostReq(req) {
  const a = req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function isValidStationId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,79}$/i.test(id);
}
function isPrivateIp(ip) {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;  // link-local
    if (a === 0) return true;
    if (a >= 224) return true;                // multicast/reserved
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80')) return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local
  return false;
}
function assertPublicUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error('invalid url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('unsupported scheme (http/https only)');
  if (parsed.username || parsed.password)
    throw new Error('credentials in url not allowed');
  return parsed;
}
async function assertPublicHost(parsed) {
  // In test mode, loopback mock upstreams are allowed (hardening suite only).
  if (TEST_MODE) return;
  // Reject literal private IPs in the hostname.
  const host = parsed.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIp(host))
    throw new Error('private/loopback host not allowed');
  if (/^\[?[0-9a-f:]+\]?$/i.test(host) && isPrivateIp(host.replace(/^\[|\]$/g, '')))
    throw new Error('private/loopback host not allowed');
  if (/(^|\.)localhost$/i.test(host))
    throw new Error('localhost host not allowed');
  // Resolve and reject any private resolved address.
  await new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) return reject(new Error('dns lookup failed'));
      for (const a of addrs) {
        if (isPrivateIp(a.address)) return reject(new Error('host resolves to private network'));
      }
      resolve();
    });
  });
}

// ── Safe dot-path accessor (never eval) (§6.5) ────────────────────────────────
function safeGet(obj, dotPath) {
  if (obj == null || !dotPath) return undefined;
  return dotPath.split('.').reduce((acc, k) => {
    if (acc == null) return undefined;
    const m = k.match(/^([^\[\]]+)\[(\d+)\]$/);
    if (m) return Array.isArray(acc[m[1]]) ? acc[m[1]][parseInt(m[2], 10)] : undefined;
    const arrAll = k.match(/^([^\[\]]+)\[(\d+)\]$/);
    if (arrAll) return acc[arrAll[1]]?.[parseInt(arrAll[2], 10)];
    return acc[k];
  }, obj);
}

function decodeEntities(s) {
  if (s == null) return null;
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function normStr(s) {
  if (s == null) return null;
  let v = decodeEntities(s);
  try { v = v.normalize('NFC'); } catch {}
  v = v.replace(/\s+/g, ' ').trim();
  v = v.replace(/\s*-\s*\d+\s*kbps\b/gi, '').replace(/\s*\[\s*\d+\s*kbps\s*\]/gi, '');
  return v || null;
}

// ── Parsers (ported from the player; relay populates structured fields) ───────
const PROGRAM_PATTERNS = [
  /^bbc\s+world\s+service$/i, /^the\s+news$/i, /^\s*news\s*$/i,
  /sign\s+off/i, /station\s+ident/i, /^advert/i,
];
function looksLikeProgram(raw) { return PROGRAM_PATTERNS.some(p => p.test(raw)); }

const SHOW_PREFIX_RE = /(?:jazz|show|program|programme|morning|afternoon|evening|night|session|mix|hour|morgen|ettermiddag|kveld|natt)/i;

function parseShowPrefixed(raw) {
  const n = normStr(raw);
  if (!n) return null;
  const idx = n.indexOf(':');
  if (idx < 2 || idx > 64 || idx >= n.length - 1) return null;
  const show = n.slice(0, idx).trim();
  const payload = n.slice(idx + 1).trim();
  if (!show || !payload || !SHOW_PREFIX_RE.test(show)) return null;
  const letters = (payload.match(/\p{L}/gu) || []).length;
  const words = payload.split(/\s+/).filter(Boolean);
  if (payload.length < 4 || letters < 3 || words.length < 2) {
    return {show, artist: null, title: payload, parser: 'show-prefix-transient', isMusic: false};
  }
  let artist = null;
  let title = payload;
  const comma = payload.lastIndexOf(',');
  if (comma > 1 && comma < payload.length - 2) {
    const possibleTitle = payload.slice(0, comma).trim();
    const possibleArtist = payload.slice(comma + 1).trim();
    if (possibleTitle.length >= 2 && possibleArtist.length >= 3) {
      title = possibleTitle;
      artist = possibleArtist;
    }
  }
  return {show, artist, title, parser: artist ? 'show-prefix-title-artist' : 'show-prefix-title', isMusic: true};
}

function parseStandard(raw) {
  const n = normStr(raw);
  if (!n) return { artist: null, title: null, parser: 'empty', isMusic: false };
  if (looksLikeProgram(n)) return { artist: null, title: n, parser: 'program', isMusic: false };
  const seps = [' \u2013 ', ' \u2014 ', ' - ', ' | '];
  for (const sep of seps) {
    const idx = n.indexOf(sep);
    if (idx > 0 && idx < n.length - sep.length) {
      const left = n.slice(0, idx).trim();
      const right = n.slice(idx + sep.length).trim();
      if (left && right) return { artist: left, title: right, parser: 'artist-dash-title', isMusic: true };
    }
  }
  return { artist: null, title: n, parser: 'title-only', isMusic: true };
}

function parseClassical(raw) {
  const n = normStr(raw);
  if (!n) return null;
  let m;
  if ((m = n.match(/^(.+?):\s*(.+?)\s*[\u2013\u2014-]\s*(.+)$/)) ||
      (m = n.match(/^(.+?)\s*[\u2013\u2014-]\s*(.+?):\s*(.+)$/))) {
    return { composer: m[1].trim(), work: m[2].trim(), movement: m[3].trim() };
  }
  if ((m = n.match(/^(.+?):\s*(.+)$/))) {
    return { composer: m[1].trim(), work: m[2].trim(), movement: null };
  }
  return null;
}

// ICY StreamTitle= metadata has no standardized charset. Historically Latin-1/
// Windows-1252, but most modern Icecast/Shoutcast sources (especially European
// classical stations broadcasting composer names with diacritics) send UTF-8.
// Blindly decoding as latin1 corrupts UTF-8 text into mojibake. Decode as UTF-8
// first; if that yields replacement characters (invalid UTF-8 byte sequence),
// fall back to latin1 which can represent any byte sequence losslessly.
function decodeIcyMetaBytes(bytes) {
  const asUtf8 = bytes.toString('utf8');
  if (asUtf8.indexOf('\uFFFD') === -1) return asUtf8;
  return bytes.toString('latin1');
}

function parseStreamTitle(meta) {
  // StreamTitle='...';StreamUrl='...';
  const m = meta.match(/StreamTitle='([^']*)'/);
  if (!m) return null;
  return m[1] || null;
}

// ── ICY extraction (§6.4) ─────────────────────────────────────────────────────
function fetchIcy(streamUrl) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try {
      parsed = assertPublicUrl(streamUrl);
      await assertPublicHost(parsed);
    } catch (e) { return reject(e); }

    const attempt = (u, redirectsLeft) => {
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Icy-MetaData': '1', 'User-Agent': UA, 'Accept': 'audio/*' },
        timeout: UPSTREAM_TIMEOUT_MS,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          let next;
          try { next = new URL(res.headers.location, u.toString()); } catch { return reject(new Error('bad redirect target')); }
          if (next.protocol !== 'http:' && next.protocol !== 'https:')
            return reject(new Error('redirect to non-http(s) refused'));
          return attempt(next, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`upstream ${res.statusCode}`)); }

        const metaint = parseInt(res.headers['icy-metaint'], 10);
        const icyName = normStr(res.headers['icy-name']) || null;
        if (!metaint || !isFinite(metaint) || metaint <= 0 || metaint > 1_000_000) {
          res.resume();
          return resolve({ raw: null, icyName, noMeta: true });
        }

        let buf = Buffer.alloc(0);
        let totalRead = 0, done = false;
        const finish = (val) => { if (done) return; done = true; res.destroy(); resolve(val); };

        res.on('data', (chunk) => {
          if (done) return;
          totalRead += chunk.length;
          if (totalRead > HARD_BYTE_CAP) { finish({ raw: null, icyName, noMeta: true }); return; }
          buf = Buffer.concat([buf, chunk]);
          // Need: metaint audio bytes + 1 length byte + (len*16) metadata bytes
          if (buf.length >= metaint + 1) {
            const lenByte = buf[metaint];
            const metaBytes = lenByte * 16;
            if (buf.length >= metaint + 1 + metaBytes) {
              const metaRaw = buf.subarray(metaint + 1, metaint + 1 + metaBytes);
              const meta = decodeIcyMetaBytes(metaRaw);
              const title = parseStreamTitle(meta);
              finish({ raw: normStr(title), icyName, noMeta: !title });
            }
          }
        });
        res.on('error', (e) => { if (!done) reject(e); });
        res.on('end', () => { if (!done) finish({ raw: null, icyName, noMeta: true }); });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
      req.end();
    };
    attempt(parsed, MAX_REDIRECTS);
  });
}

// ── Official JSON strategy (§6.5) ─────────────────────────────────────────────
function fetchJsonMeta(endpoint, paths) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try {
      parsed = assertPublicUrl(endpoint);
      await assertPublicHost(parsed);
    } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: UPSTREAM_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if ((parsed = safeRedirect(res.headers.location, parsed))) return fetchJsonMetaRef(res, parsed, paths, resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`json upstream ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1_500_000) res.destroy(); });
      res.on('end', () => {
        try { resolve(applyJsonPaths(JSON.parse(body), paths)); }
        catch (e) { reject(new Error('json parse failed')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('json timeout')); });
    req.end();
  });
}
function safeRedirect(loc, base) {
  try { const n = new URL(loc, base.toString()); return (n.protocol === 'http:' || n.protocol === 'https:') ? n : null; }
  catch { return null; }
}
function fetchJsonMetaRef(res, parsed, paths, resolve, reject) {
  res.resume();
  // Follow a single redirect for JSON endpoints (rare).
  const lib = parsed.protocol === 'https:' ? https : http;
  const req = lib.request({
    method: 'GET', hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: UPSTREAM_TIMEOUT_MS,
  }, (r2) => {
    if (r2.statusCode !== 200) { r2.resume(); return reject(new Error(`json upstream ${r2.statusCode}`)); }
    let body = ''; r2.setEncoding('utf8');
    r2.on('data', (c) => { body += c; if (body.length > 1_500_000) r2.destroy(); });
    r2.on('end', () => { try { resolve(applyJsonPaths(JSON.parse(body), paths)); } catch { reject(new Error('json parse failed')); } });
    r2.on('error', reject);
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(new Error('json timeout')); });
  req.end();
}
function applyJsonPaths(data, p) {
  const artist  = normStr(safeGet(data, p.artistPath));
  const title   = normStr(safeGet(data, p.titlePath));
  const album   = normStr(safeGet(data, p.albumPath));
  let artwork = safeGet(data, p.artworkPath) || null;
  if (artwork && typeof artwork === 'string') {
    // BBC image URLs carry a {recipe} size token (e.g. .../ic/{recipe}/p0x.jpg).
    artwork = artwork.replace(/\{recipe\}/g, '320x320');
  }
  const year    = safeGet(data, p.yearPath) || null;
  const raw = [artist, title].filter(Boolean).join(' - ') || title || artist || null;
  return { raw, artist, title, album, artwork, year };
}

// ── Build the §5.2 normalized response ────────────────────────────────────────
function buildResponse(station, extracted, strategy, error) {
  const receivedAt = nowIso();
  const ttl = clampTtl(station.metadata?.pollSeconds);
  const base = {
    ok: true,
    stationId: station.id,
    strategy,
    raw: null, artist: null, title: null, album: null, year: null, artwork: null,
    composer: null, work: null, movement: null,
    conductor: null, ensemble: null, soloists: [],
    program: null, isMusic: true,
    receivedAt, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    sourceUrl: station.metadata?.endpoint || station.streamUrl,
    error: error || null,
  };
  if (!extracted || (!extracted.raw && !extracted.title && !extracted.artist)) {
    base.error = base.error || 'metadata-unavailable';
    return finalizeResponseIdentity(base);
  }
  const raw = extracted.raw || [extracted.artist, extracted.title].filter(Boolean).join(' - ');
  base.raw = raw;
  // Official JSON provides structured fields directly.
  if (extracted.title || extracted.artist || extracted.album || extracted.artwork) {
    base.artist  = extracted.artist || null;
    base.title   = extracted.title || null;
    base.album   = extracted.album || null;
    base.artwork = extracted.artwork || null;
    base.year    = extracted.year ? String(extracted.year).slice(0, 4) : null;
    // For classical JSON stations (e.g. BBC Radio 3), map artist→composer,
    // title→work so the player can render the classical layout.
    if (station.metadata?.classical) {
      base.composer = extracted.artist || null;
      base.work     = extracted.title || null;
    }
    base.isMusic = true;
    return finalizeResponseIdentity(base);
  }
  // ICY raw → parse.
  // Some ICY stations prepend a stable show title to a changing song payload.
  const showTrack = parseShowPrefixed(raw);
  if (showTrack) {
    base.show = showTrack.show;
    base.program = showTrack.show;
    base.artist = showTrack.artist;
    base.title = showTrack.title;
    base.isMusic = showTrack.isMusic;
    base.parser = showTrack.parser;
    return finalizeResponseIdentity(base);
  }

  if (station.metadata?.classical) {
    const cp = parseClassical(raw);
    if (cp) {
      base.composer = cp.composer; base.work = cp.work; base.movement = cp.movement;
      base.artist = cp.composer; base.title = cp.work || cp.movement;
      base.isMusic = true;
      return finalizeResponseIdentity(base);
    }
  }
  const sp = parseStandard(raw);
  if (sp.isMusic === false) {
    base.title = sp.title; base.isMusic = false; base.program = sp.title;
    return finalizeResponseIdentity(base);
  }
  base.artist = sp.artist; base.title = sp.title; base.isMusic = true;
  return finalizeResponseIdentity(base);
}
function clampTtl(s) {
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return 20;
  return Math.max(MIN_CACHE_TTL_S, Math.min(MAX_CACHE_TTL_S, n));
}


// ── A5.3R23: onlineradiobox ('orb') metadata strategy ─────────────────────────
// For stations whose stream carries no ICY StreamTitle and whose Icecast status page
// carries no title either. onlineradiobox publishes a per-station playlist page whose
// first row is labelled "Live". We read that row and hand the raw string to
// buildResponse, which already knows how to parse "Artist - Title" for ICY stations.
// No new parsing semantics are introduced here.
const ORB_TTL_FLOOR_S = 30;   // the page updates about once a minute; do not hammer it

// mobile's nowplaying.js decodes entities with document.createElement('textarea').
// There is no DOM in Node, so decode the entities ORB actually emits.
const ORB_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d', eacute: '\u00e9', uuml: '\u00fc', ouml: '\u00f6',
  auml: '\u00e4', szlig: '\u00df' };
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X'
        ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = ORB_ENTITIES[g.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function orbCellText(htmlFrag) {
  return decodeEntities(String(htmlFrag || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// The Live row is sometimes an ad slate or a station ident rather than a track. Mobile's
// sane() rejects only an exact self-title (slugify(t) === slugify(name)); these get past it.
// Observed live on this catalog: "181.FM - THIS STATION WILL CONTINUE AFTER THIS BREAK",
// "Listen.FM - Listen.FM", and via ICY on Big R Radio, "We'll Be Right Back After This Message".
const ORB_BUMPER_RE = new RegExp([
  'this station will continue', 'after (this|the) break', "we'?ll be right back",
  'right back after', 'commercial break', 'advertisement', '^ *ad(vert)? *$',
  'station ident', 'brought to you by', 'you are listening to', 'unknown artist',
].join('|'), 'i');

function orbSane(track, stationName) {
  let t = String(track || '').trim();
  if (t.length < 2 || t.length > 160) return '';
  if (/^https?:/i.test(t) || /\.(mp3|aac|ogg|m3u8?|pls)\b/i.test(t)) return '';
  if (/^(unknown|unspecified|no ?title|n\/?a|-)$/i.test(t)) return '';
  if (ORB_BUMPER_RE.test(t)) return '';
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const n = norm(stationName);
  if (n && norm(t) === n) return '';
  // "<station name> - <anything>" is the station talking about itself, not a track.
  if (n && norm(t).indexOf(n) === 0 && norm(t).length > n.length) return '';
  // "X - X" duplicate-cell rows (e.g. Listen.FM - Listen.FM).
  const halves = t.split(/\s+[-\u2013\u2014]\s+/);
  if (halves.length === 2 && norm(halves[0]) && norm(halves[0]) === norm(halves[1])) return '';
  return t;
}

function parseOrbHtml(doc, stationName) {
  const rows = String(doc || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
  if (!rows) return null;
  let fallback = '';
  for (const row of rows) {
    const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi);
    if (!cells || cells.length < 2) continue;
    const when = orbCellText(cells[0]);
    const what = orbCellText(cells.slice(1).join(' '));
    if (!what) continue;
    if (/^live$/i.test(when)) {
      const t = orbSane(what, stationName);
      if (t) return { raw: t, artist: null, title: null, album: null, artwork: null, year: null };
      return null;   // the Live row exists but is an ad slate: report nothing, not the slate
    }
    if (!fallback && /^\d{1,2}:\d{2}/.test(when)) fallback = orbSane(what, stationName);
  }
  return fallback
    ? { raw: fallback, artist: null, title: null, album: null, artwork: null, year: null }
    : null;
}

function fetchOrb(endpoint, stationName) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try {
      parsed = assertPublicUrl(endpoint);
      await assertPublicHost(parsed);
    } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET', hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml',
                 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: UPSTREAM_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`orb upstream ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 900_000) res.destroy(); });
      res.on('end', () => {
        const out = parseOrbHtml(body, stationName);
        if (!out) return reject(new Error('orb no live row'));
        resolve(out);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('orb timeout')); });
    req.end();
  });
}

// ── now-playing with cache + coalescing (§6.7) ────────────────────────────────
async function getNowPlaying(stationId, opts) {
  const force = !!(opts && opts.force);
  const station = REGISTRY.get(stationId);
  if (!station) return { httpStatus: 404, body: { ok: false, error: 'unknown-station', stationId } };

  const meta = station.metadata || {};
  const entry = CACHE.get(stationId) || {
    value: null, fetchedAt: 0, expiresAt: 0, inFlight: null,
    lastError: null, failures: 0, lastAttemptAt: 0, lastSuccessAt: 0,
  };

  const now = Date.now();
  // Fresh cache? (manual retry passes force=1 to bypass this short-TTL cache)
  if (!force && entry.value && entry.expiresAt > now) {
    return { httpStatus: 200, body: entry.value };
  }
  // Coalesce in-flight.
  if (entry.inFlight) {
    try { return { httpStatus: 200, body: await entry.inFlight }; }
    catch { /* fall through to our own attempt */ }
  }

  const ttl = clampTtl(meta.pollSeconds);
  const effective = (meta.strategy === 'auto')
    ? (meta.endpoint ? 'json' : 'icy')
    : (meta.strategy || 'icy');

  entry.inFlight = (async () => {
    await acquire();
    try {
      entry.lastAttemptAt = now;
      let extracted = null, err = null;
      if (meta.enabled === false) {
        err = 'metadata-disabled';
      } else if (effective === 'none') {
        err = 'metadata-unavailable';
      } else if (effective === 'json' && meta.endpoint) {
        try { extracted = await fetchJsonMeta(meta.endpoint, meta); }
        catch (e) { err = 'json-fetch-failed: ' + e.message; }
      } else if (effective === 'icy' || effective === 'hls') {
        try { extracted = await fetchIcy(station.streamUrl); }
        catch (e) { err = 'icy-fetch-failed: ' + e.message; }
      } else if (effective === 'orb' && meta.endpoint) {
        try { extracted = await fetchOrb(meta.endpoint, station.name); }
        catch (e) { err = 'orb-fetch-failed: ' + e.message; }
      } else {
        err = 'unsupported-strategy';
      }

      const value = buildResponse(station, extracted, effective, err);
      entry.value = value;
      entry.fetchedAt = now;
      entry.expiresAt = now + ttl * 1000;
      entry.lastSuccessAt = err ? entry.lastSuccessAt : now;
      entry.failures = err ? entry.failures + 1 : 0;
      entry.lastError = err || null;
      // Stale flag on degraded value with prior success.
      if (err && entry.value && now - entry.fetchedAt === 0) {
        // keep value but mark error (already in value.error)
      }
      CACHE.set(stationId, entry);
      return value;
    } finally {
      entry.inFlight = null;
      release();
    }
  })();

  try {
    const value = await entry.inFlight;
    return { httpStatus: 200, body: value };
  } catch (e) {
    // Should not reach (errors captured in value), but guard anyway.
    entry.failures++; entry.lastError = String(e.message || e);
    if (entry.value && now - entry.fetchedAt < STALE_GRACE_MS) {
      const stale = { ...entry.value, stale: true, error: entry.lastError };
      return { httpStatus: 200, body: stale };
    }
    return { httpStatus: 200, body: buildResponse(station, null, effective, String(e.message || e)) };
  }
}

// ── Diagnostics (§6.8) — no secrets ───────────────────────────────────────────
function getDiagnostics(stationId) {
  const station = REGISTRY.get(stationId);
  if (!station) return { httpStatus: 404, body: { ok: false, error: 'unknown-station', stationId } };
  const entry = CACHE.get(stationId);
  const meta = station.metadata || {};
  const effective = (meta.strategy === 'auto') ? (meta.endpoint ? 'json' : 'icy') : (meta.strategy || 'icy');
  return {
    httpStatus: 200,
    body: {
      ok: true,
      stationId,
      configuredStrategy: meta.strategy || 'auto',
      effectiveStrategy: effective,
      lastSuccessAt: entry?.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null,
      lastAttemptAt: entry?.lastAttemptAt ? new Date(entry.lastAttemptAt).toISOString() : null,
      cacheAgeMs: entry?.fetchedAt ? Date.now() - entry.fetchedAt : null,
      cacheTtlMs: entry?.expiresAt ? entry.expiresAt - Date.now() : null,
      consecutiveFailures: entry?.failures || 0,
      lastError: entry?.lastError || null,
      rawTitlePresent: !!(entry?.value && (entry.value.raw || entry.value.title)),
      registered: true,
      pollSeconds: clampTtl(meta.pollSeconds),
      upstream: meta.endpoint || station.streamUrl,
    },
  };
}

// ── Registration (§6.2) ───────────────────────────────────────────────────────
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > cap) { req.destroy(); return reject(new Error('payload too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
async function registerStations(req) {
  if (!isLocalhostReq(req)) return { httpStatus: 403, body: { ok: false, error: 'localhost-only' } };
  let payload;
  try { payload = JSON.parse(await readBody(req, REG_PAYLOAD_CAP)); }
  catch { return { httpStatus: 400, body: { ok: false, error: 'invalid-json' } }; }
  const list = Array.isArray(payload) ? payload : payload.stations;
  if (!Array.isArray(list)) return { httpStatus: 400, body: { ok: false, error: 'stations must be an array' } };
  if (list.length > 2000) return { httpStatus: 400, body: { ok: false, error: 'too many stations' } };

  let accepted = 0, rejected = 0; const rej = [];
  for (const s of list) {
    if (!s || !isValidStationId(s.id) || typeof s.streamUrl !== 'string') { rejected++; rej.push({ id: s?.id, reason: 'bad id or streamUrl' }); continue; }
    try { assertPublicUrl(s.streamUrl); } catch (e) { rejected++; rej.push({ id: s.id, reason: e.message }); continue; }
    // Host resolution check is deferred to extraction to keep registration fast,
    // but scheme/path validation is enforced here. No filesystem paths accepted.
    REGISTRY.set(s.id, {
      id: s.id,
      name: typeof s.name === 'string' ? s.name : s.id,
      streamUrl: s.streamUrl,
      favicon: typeof s.favicon === 'string' ? s.favicon : null,
      metadata: {
        strategy: s.metadata?.strategy || 'auto',
        endpoint: typeof s.metadata?.endpoint === 'string' ? s.metadata.endpoint : null,
        pollSeconds: Number(s.metadata?.pollSeconds) || 20,
        parser: s.metadata?.parser || 'auto',
        artistPath: s.metadata?.artistPath || null,
        titlePath: s.metadata?.titlePath || null,
        albumPath: s.metadata?.albumPath || null,
        artworkPath: s.metadata?.artworkPath || null,
        yearPath: s.metadata?.yearPath || null,
        classical: !!s.metadata?.classical,
        enabled: s.metadata?.enabled !== false,
      },
    });
    accepted++;
  }
  return { httpStatus: 200, body: { ok: true, accepted, rejected, rejectedDetails: rej.slice(0, 50), registered: REGISTRY.size } };
}

// ── Static HTML serving ───────────────────────────────────────────────────────
function serveHtml(res) {
  fs.readFile(HTML_FILE, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('agent-radio-v6.html not found next to the relay.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

// ── Stream proxy (NEW v5) ─────────────────────────────────────────────────────
// Registered-station-only audio pipe. Resolves redirects + .m3u/.pls, re-runs
// SSRF on every hop, does NOT request ICY metadata (would corrupt playback),
// preserves upstream Content-Type, and aborts upstream on client close.
let _streamsActive = 0;
const _streamWaiters = [];
function acquireStream() {
  if (_streamsActive < MAX_STREAM_CONCURRENT) { _streamsActive++; return Promise.resolve(); }
  return new Promise(res => _streamWaiters.push(res));
}
function releaseStream() {
  if (_streamWaiters.length) _streamWaiters.shift()();
  else _streamsActive = Math.max(0, _streamsActive - 1);
}

// Map a registered codec to a sane Content-Type when upstream omits one.
function codecContentType(station, upstreamCt) {
  const ct = (upstreamCt || '').toLowerCase();
  if (ct.includes('audio') || ct.includes('mpeg') || ct.includes('aac') || ct.includes('octet-stream')) {
    return upstreamCt;
  }
  const codec = (station && station.codec || '').toUpperCase();
  if (codec === 'AAC') return 'audio/aac';
  if (codec === 'OGG') return 'audio/ogg';
  return 'audio/mpeg';
}

// Hop-by-hop / unsafe headers we must not forward from the upstream.
const HOP_BY_HOP = new Set([
  'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer',
  'transfer-encoding','upgrade','host','content-length',  // we don't know length for live streams
  'icy-metaint','icy-metadata','icy-br','icy-name','icy-genre','icy-url','icy-pub','icy-description',
]);

// Open an upstream connection (GET) with SSRF validation on this exact URL.
// Returns {req, res, parsedUrl} or throws. Does NOT send Icy-MetaData.
function openUpstream(targetUrl, browserHeaders) {
  const parsed = assertPublicUrl(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': STREAM_UA,
    'Accept': 'audio/*',
    // Deliberately omit Icy-MetaData so the server returns clean audio bytes.
  };
  if (browserHeaders.range) headers['Range'] = browserHeaders.range;
  return new Promise((resolve, reject) => {
    const req = lib.request(parsed, { method: 'GET', headers }, (res) => resolve({ req, res, parsed }));
    req.on('error', reject);
    req.setTimeout(STREAM_CONNECT_TIMEOUT_MS, () => req.destroy(new Error('upstream connect timeout')));
    req.end();
  });
}

// Follow redirects + resolve playlists to a direct audio URL. SSRF per hop.
async function resolveAudioUrl(startUrl, depth = 0) {
  if (depth > MAX_STREAM_REDIRECTS) throw new Error('too many redirects');
  const parsed = assertPublicUrl(startUrl);
  await assertPublicHost(parsed);
  const lib = parsed.protocol === 'https:' ? https : http;
  const probe = await new Promise((resolve, reject) => {
    const req = lib.request(parsed, {
      method: 'GET',
      headers: { 'User-Agent': STREAM_UA, 'Accept': 'audio/*', 'Range': 'bytes=0-131071' },
    }, (res) => resolve(res));
    req.on('error', reject);
    req.setTimeout(STREAM_CONNECT_TIMEOUT_MS, () => req.destroy(new Error('upstream connect timeout')));
    req.end();
  });
  // Redirect?
  if (probe.statusCode >= 300 && probe.statusCode < 400 && probe.headers.location) {
    probe.resume();
    return resolveAudioUrl(new URL(probe.headers.location, startUrl).href, depth + 1);
  }
  const ct = (probe.headers['content-type'] || '').toLowerCase();
  const isPlaylist = ct.includes('mpegurl') || ct.includes('m3u') || ct.includes('scpls') ||
                     /\.m3u8?$/.test(parsed.pathname) || /\.pls$/.test(parsed.pathname);
  if (isPlaylist) {
    const body = await new Promise((res, rej) => { let b=''; probe.on('data',c=>b+=c); probe.on('end',()=>res(b)); probe.on('error',rej); });
    // True HLS (.m3u8 with segment refs) cannot be byte-proxied — it needs segment
    // fetching + demuxing. Detect and reject so the UI can label it unavailable.
    if (/^#EXTM3U/mi.test(body) && (/^#EXTINF/mi.test(body) || /\.ts(\?|$)/i.test(body) || /\.m3u8/i.test(body)) ) {
      throw new Error('HLS playlist not supported by byte proxy');
    }
    const m = body.match(/https?:\/\/[^\s"'>,]+/i);
    if (!m) throw new Error('playlist had no stream url');
    return resolveAudioUrl(m[0], depth + 1);
  }
  // Direct audio: return the URL we just probed (resume the probe response).
  probe.resume();
  return { url: startUrl, contentType: probe.headers['content-type'] || '' };
}

async function serveStream(req, res, stationId) {
  if (!isValidStationId(stationId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: false, error: 'invalid-station-id' }));
  }
  const station = REGISTRY.get(stationId);
  if (!station || !station.streamUrl) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: false, error: 'station-not-registered' }));
  }
  // Honesty guard: stations the probe found unplayable (real HLS, dead, geo-blocked)
  // are surfaced as unavailable rather than silently hanging the audio element.
  if (station.available === false) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: false, error: 'station-unavailable', detail: station.unavailableReason || 'unavailable' }));
  }
  // Policy refusal, not a failure. This is a 403 with the reason and the alternative named,
  // so a client that ignores the /catalog annotation still gets an actionable answer instead
  // of a 5xx it would report as a broken stream.
  const linkOut = linkOutForStream(station.streamUrl);
  if (linkOut) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({
      ok: false,
      error: 'link-out-only',
      service: linkOut.service,
      linkOut: linkOut.url,
      detail: linkOut.service + ' does not permit third-party clients; play it on their own player',
    }));
  }
  await acquireStream();
  let upstreamReq = null;
  let idleTimer = null;
  let released = false;
  const cleanup = () => {
    if (released) return; released = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (upstreamReq) try { upstreamReq.destroy(); } catch {}
    releaseStream();
  };
  // Abort upstream when the browser closes the connection (station switch / pause).
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  let resolved;
  try {
    resolved = await resolveAudioUrl(station.streamUrl);
  } catch (e) {
    cleanup();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: false, error: 'upstream-unreachable', detail: e.message }));
  }
  // Now open the real playback connection (no ICY metadata requested).
  let upstreamRes;
  try {
    const r = await openUpstream(resolved.url, { range: req.headers.range });
    upstreamReq = r.req; upstreamRes = r.res;
  } catch (e) {
    cleanup();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: false, error: 'upstream-connect-failed', detail: e.message }));
  }
  const status = upstreamRes.statusCode === 200 || upstreamRes.statusCode === 206 ? upstreamRes.statusCode : 502;
  if (status === 502) { upstreamRes.resume(); cleanup(); res.writeHead(502, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ ok: false, error: 'upstream-status', detail: String(upstreamRes.statusCode) })); }
  // Forward safe headers only.
  const outHeaders = {
    'Content-Type': codecContentType(station, upstreamRes.headers['content-type']),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': req.headers.origin || '*',
  };
  if (upstreamRes.headers['content-range']) outHeaders['Content-Range'] = upstreamRes.headers['content-range'];
  res.writeHead(status, outHeaders);
  // Idle watchdog: if upstream stalls, abort so the browser retries instead of hanging.
  const resetIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { try { upstreamReq.destroy(new Error('idle')); } catch {} }, STREAM_IDLE_TIMEOUT_MS); };
  resetIdle();
  upstreamRes.on('data', (chunk) => { resetIdle(); res.write(chunk); });
  upstreamRes.on('end', () => { if (idleTimer) clearTimeout(idleTimer); try { res.end(); } catch {} cleanup(); });
  upstreamRes.on('error', () => { try { res.destroy(); } catch {} cleanup(); });
}

// ── Favicon proxy (NEW v7) ───────────────────────────────────────────────────
// GET /favicon/:stationId  → fetches the station's favicon upstream with browser-
// like headers (UA + Referer = favicon origin), SSRF-guarded exactly like /stream,
// 7s timeout, 512KB cap, image content-type enforced, 24h positive cache + short
// negative cache. Honesty: 404 (no favicon / unknown station), 415 (non-image),
// 502 (upstream failure). The browser <img> points here so we get correct headers
// and one retry, instead of raw cross-origin favicon URLs that fail silently.
const FAVICON_TTL_MS      = 24 * 60 * 60 * 1000;   // positive cache: 24h
const FAVICON_NEG_TTL_MS  = 60 * 1000;             // negative cache: 60s
const FAVICON_TIMEOUT_MS  = 7000;                  // per upstream attempt
const FAVICON_BYTE_CAP    = 512 * 1024;            // 512 KB (favicons are tiny)
const FAVICON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const faviconCache = new Map();   // stationId -> {body:Buffer|null, ct:string|null, ts:number, neg:boolean, reason?:string}
function faviconFallbackSvg(reg) {
  const words = String(reg && reg.name || reg && reg.id || 'AR').trim().split(/\s+/);
  let label = '';
  for (const word of words) { const m = word.match(/[A-Za-z0-9]/); if (m) label += m[0].toUpperCase(); if (label.length >= 2) break; }
  if (!label) label = 'AR';
  let hash = 2166136261 >>> 0;
  for (const ch of String(reg && reg.id || label)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const hue = hash % 360;
  const safe = label.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="18" fill="hsl(${hue} 36% 22%)"/><text x="64" y="76" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Arial,sans-serif" font-size="42" font-weight="700" fill="#f4f4f2">${safe}</text></svg>`);
}
function serveFaviconFallback(res, reg, reason, cacheState) {
  const body = faviconFallbackSvg(reg);
  const safeReason = String(reason || 'unavailable').replace(/[^a-z0-9_-]/gi, '-').slice(0, 64);
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'X-Agent-Radio-Fallback': safeReason,
    'X-Agent-Radio-Cache': cacheState || 'FALLBACK',
  });
  res.end(body);
}

function fetchFaviconUpstream(rawUrl) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try { parsed = assertPublicUrl(rawUrl); }
    catch { return reject({ message: 'invalid-favicon-url', code: 'invalid' }); }
    try { await assertPublicHost(parsed); }
    catch { return reject({ message: 'favicon-host-blocked', code: 'private' }); }
    const origin = `${parsed.protocol}//${parsed.host}/`;
    const doReq = (url, depth) => {
      if (depth > 4) return reject({ message: 'too-many-redirects', code: 'redirect' });
      let p; try { p = new URL(url); } catch { return reject({ message: 'bad-redirect', code: 'redirect' }); }
      const lib = p.protocol === 'https:' ? https : http;
      const r = lib.request({
        method: 'GET', hostname: p.hostname,
        port: p.port || (p.protocol === 'https:' ? 443 : 80),
        path: p.pathname + p.search,
        headers: { 'User-Agent': FAVICON_UA, 'Accept': 'image/*,*/*', 'Referer': origin },
      }, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          resp.resume();
          let next; try { next = new URL(resp.headers.location, url).href; } catch { return reject({ message: 'bad-redirect', code: 'redirect' }); }
          if (!/^https?:/.test(next)) return reject({ message: 'bad-redirect-scheme', code: 'redirect' });
          return doReq(next, depth + 1);
        }
        const ct = (resp.headers['content-type'] || '').toLowerCase();
        if (resp.statusCode !== 200) { resp.resume(); return reject({ message: 'upstream-' + resp.statusCode, code: 'upstream' }); }
        if (!ct.startsWith('image/')) { resp.resume(); return reject({ message: 'not-image', code: 'not-image' }); }
        const chunks = []; let n = 0, done = false;
        resp.on('data', (c) => {
          if (done) return;
          n += c.length; chunks.push(c);
          if (n > FAVICON_BYTE_CAP) { done = true; resp.destroy(); reject({ message: 'too-large', code: 'too-large' }); }
        });
        resp.on('end', () => { if (!done) resolve({ body: Buffer.concat(chunks), ct }); });
        resp.on('error', (e) => { if (!done) { done = true; reject({ message: e.message, code: 'fetch-error' }); } });
      });
      r.setTimeout(FAVICON_TIMEOUT_MS, () => { r.destroy(); reject({ message: 'timeout', code: 'timeout' }); });
      r.on('error', (e) => reject({ message: e.message, code: 'fetch-error' }));
      r.end();
    };
    doReq(parsed.href, 0);
  });
}

function serveFavicon(req, res, stationId) {
  if (!isValidStationId(stationId)) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'invalid-stationId' })); return;
  }
  const reg = REGISTRY.get(stationId);
  if (!reg) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'station-not-found' })); return;
  }
  if (!reg.favicon) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'no-favicon' })); return;
  }

  // A5.3R20: local artist artwork. A favicon recorded in the relative form
  // art/exclusive/<file>.jpg is read from disk beside the relay, following the same
  // house pattern as the local JS module routes. The Exclusive Radio artist images were
  // downloaded once by AgentRadioMobile's build_catalog.py and ship inside the
  // candidate, so drawing the station list needs no network at all. Remote favicons are
  // untouched and still go through fetchFaviconUpstream below.
  //
  // Traversal guard, in three parts, because a loopback service is still a service:
  //   1. the remainder must be a plain jpg basename - no slash, no backslash, no ..
  //   2. path.normalize must not change it
  //   3. the absolute result must still sit under ART_DIR
  // A5.3R25: two permitted local-art roots instead of one hardcoded prefix, and the
  // extension decides the content type instead of assuming jpeg. art/exclusive/ holds the
  // Exclusive Radio artist photos; art/stations/ holds station favicons fetched from each
  // station's own homepage. All three traversal checks below are unchanged.
  const ART_ROOTS = {
    'art/exclusive/': path.join(__dirname, 'art', 'exclusive'),
    'art/stations/':  path.join(__dirname, 'art', 'stations'),
  };
  const ART_CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    ico: 'image/x-icon', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  const artRoot = (typeof reg.favicon === 'string')
    ? Object.keys(ART_ROOTS).find((pre) => reg.favicon.indexOf(pre) === 0) : null;
  if (artRoot) {
    const relArt = reg.favicon.slice(artRoot.length);
    const ART_DIR = ART_ROOTS[artRoot];
    const joined = path.join(ART_DIR, relArt);
    const abs = path.normalize(joined);
    const extM = /^[A-Za-z0-9._-]+\.([A-Za-z0-9]+)$/.exec(relArt);
    const localCt = extM ? ART_CT[extM[1].toLowerCase()] : null;
    const nameOk = !!localCt && relArt.indexOf('..') === -1;
    if (!nameOk || abs !== joined || abs.indexOf(ART_DIR + path.sep) !== 0) {
      return serveFaviconFallback(res, reg, 'local-art-rejected', 'FALLBACK-LOCAL');
    }
    const localHit = faviconCache.get(stationId);
    if (localHit && !localHit.neg && (Date.now() - localHit.ts) < FAVICON_TTL_MS) {
      res.writeHead(200, { 'Content-Type': localHit.ct, 'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff', 'X-Agent-Radio-Cache': 'HIT-LOCAL' });
      res.end(localHit.body); return;
    }
    return fs.readFile(abs, (errArt, dataArt) => {
      if (errArt) {
        faviconCache.set(stationId, { body: null, ct: null, ts: Date.now(), neg: true, reason: 'local-art-missing' });
        return serveFaviconFallback(res, reg, 'local-art-missing', 'FALLBACK-LOCAL');
      }
      faviconCache.set(stationId, { body: dataArt, ct: localCt, ts: Date.now(), neg: false });
      res.writeHead(200, { 'Content-Type': localCt, 'Cache-Control': 'public, max-age=86400',
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff', 'X-Agent-Radio-Cache': 'MISS-LOCAL' });
      res.end(dataArt);
    });
  }
  const bypassNeg = new URL(req.url, 'http://x').searchParams.get('r') === '1';
  const cached = faviconCache.get(stationId);
  const now = Date.now();
  if (cached && !(bypassNeg && cached.neg)) {
    const age = now - cached.ts;
    const ttl = cached.neg ? FAVICON_NEG_TTL_MS : FAVICON_TTL_MS;
    if (age < ttl) {
      if (cached.neg) {
        return serveFaviconFallback(res, reg, cached.reason || 'cached-unavailable', 'FALLBACK-HIT');
      }
      res.writeHead(200, { 'Content-Type': cached.ct, 'Cache-Control': 'public, max-age=86400', 'X-Agent-Radio-Cache': 'HIT' });
      res.end(cached.body); return;
    }
  }
  fetchFaviconUpstream(reg.favicon).then(({ body, ct }) => {
    faviconCache.set(stationId, { body, ct, ts: Date.now(), neg: false });
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400', 'X-Agent-Radio-Cache': 'MISS' });
    res.end(body);
  }).catch((err) => {
    const reason = err && err.code ? err.code : 'favicon-unavailable';
    faviconCache.set(stationId, { body: null, ct: null, ts: Date.now(), neg: true, reason });
    return serveFaviconFallback(res, reg, reason, 'FALLBACK-MISS');
  });
}

// Agent DJ enrichment proxy (NEW v23) ---------------------------------------
// Read-only local SQLite lookup against agentdj.sqlite -- supplements the
// MusicBrainz enrichment below with style tags (Discogs), audio-feature
// descriptors (inline on spotify_track), and a co-occurrence count from the
// Spotify Million Playlist Dataset join. Same discipline as
// serveMusicBrainz/fetchMusicBrainz/extractMbFacts: small, honest fact
// object, null (not {}) on no match, never fabricate, cached with the same
// 24h positive / 10min negative TTL pattern. Never blocks playback or
// narration -- a failed/slow lookup just means the caller narrates from
// MusicBrainz + ICY metadata alone, exactly as before this feature
// (dossier Section 5).
//
// Schema notes (confirmed live against agentdj.sqlite, 29 Jul 2026):
//   recordings(mbid, title, artist, ...)
//   mbid_discogs(mbid, discogs_id) -- maps directly to discogs_masters.discogs_id
//   discogs_masters(discogs_id, title, artist, genres JSON, styles JSON, year)
//   spotify_track(track_id, title, artist_name, ..., tempo, energy, valence,
//                 instrumentalness, ...) -- audio features are inline, no msd_tracks join
//   spotify_track_playlist(track_id, playlist_id) -- idx_stp_track ON (track_id):
//                 EXPLAIN QUERY PLAN confirmed SEARCH USING INDEX idx_stp_track,
//                 so the co-occurrence join is a cheap indexed lookup, not a
//                 125M-row scan. Included this pass.
const AGENTRADIO_DJDB_PATH = process.env.AGENT_RADIO_DJDB_PATH
  || (process.env.AGENT_RADIO_MB_DB || './musicbrainz/agentdj.sqlite');

let _djDb = null;
let _djDbTried = false;
function getDjDb() {
  if (process.env.AGENT_RADIO_DISABLE_DJ_DB === '1') return null;
  if (_djDbTried) return _djDb;
  _djDbTried = true;
  if (!Database) return null;
  try {
    _djDb = new Database(AGENTRADIO_DJDB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error(`[agent-radio] agentdj.sqlite unavailable (${AGENTRADIO_DJDB_PATH}): ${e.message}`);
    _djDb = null; // honest failure: /radio/enrich just returns no-data, never crashes the relay
  }
  return _djDb;
}

const ENRICH_TTL_MS = 24 * 60 * 60 * 1000;   // positive cache: 24h (matches mbCache)
const ENRICH_NEG_TTL_MS = 10 * 60 * 1000;    // negative cache: 10min (matches mbCache)
const enrichCache = new Map(); // key(artist|title) -> { facts, ts, neg }

function enrichCacheKey(artist, title) {
  return (String(artist || '').toLowerCase().trim() + '|' + String(title || '').toLowerCase().trim());
}

// Query chain: recordings -> mbid_discogs -> discogs_masters for style tags;
// spotify_track (inline audio features) for tempo/energy/valence/instrumentalness;
// spotify_track -> spotify_track_playlist for a co-occurrence count (playlist
// appearances in the Million Playlist Dataset -- a raw count only, never
// converted into a popularity/quality claim by this function or the prompt
// fold). Returns null (not {}) when nothing usable was found, so the caller
// can distinguish "no data" from "empty but valid" cleanly -- same discipline
// as extractMbFacts.
function queryDjFacts(db, artist, title) {
  const facts = {
    styleTags: null, tempo: null, energy: null, valence: null,
    instrumentalness: null, playlistCooccurrence: null,
  };

  try {
    const styleRow = db.prepare(`
      SELECT dm.styles AS styles
      FROM recordings r
      JOIN mbid_discogs md ON md.mbid = r.mbid
      JOIN discogs_masters dm ON dm.discogs_id = md.discogs_id
      WHERE r.artist = ? AND r.title = ?
      LIMIT 1
    `).get(artist, title);
    if (styleRow && styleRow.styles) {
      try {
        const parsed = JSON.parse(styleRow.styles);
        if (Array.isArray(parsed) && parsed.length) facts.styleTags = parsed.slice(0, 5);
      } catch (e) { /* malformed JSON in source data -- leave null, never guess */ }
    }
  } catch (e) { /* table/column mismatch or lookup failure -- leave null, don't fail the whole request */ }

  let trackId = null;
  try {
    const featRow = db.prepare(`
      SELECT track_id, tempo, energy, valence, instrumentalness
      FROM spotify_track
      WHERE artist_name = ? AND title = ?
      LIMIT 1
    `).get(artist, title);
    if (featRow) {
      trackId = featRow.track_id || null;
      if (typeof featRow.tempo === 'number') facts.tempo = featRow.tempo;
      if (typeof featRow.energy === 'number') facts.energy = featRow.energy;
      if (typeof featRow.valence === 'number') facts.valence = featRow.valence;
      if (typeof featRow.instrumentalness === 'number') facts.instrumentalness = featRow.instrumentalness;
    }
  } catch (e) { /* leave null */ }

  if (trackId) {
    try {
      const cooc = db.prepare(`
        SELECT COUNT(*) AS n
        FROM spotify_track_playlist
        WHERE track_id = ?
      `).get(trackId);
      if (cooc && typeof cooc.n === 'number' && cooc.n > 0) facts.playlistCooccurrence = cooc.n;
    } catch (e) { /* leave null */ }
  }

  const hasAnything = facts.styleTags || facts.tempo !== null || facts.energy !== null
    || facts.valence !== null || facts.instrumentalness !== null || facts.playlistCooccurrence !== null;
  return hasAnything ? facts : null;
}

async function serveDjEnrich(req, res, u) {
  const artist = u.searchParams.get('artist') || '';
  const title = u.searchParams.get('title') || '';
  if (!artist && !title) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'missing-artist-and-title' }));
    return;
  }

  const key = enrichCacheKey(artist, title);
  const now = Date.now();
  const cached = enrichCache.get(key);
  if (cached) {
    const ttl = cached.neg ? ENRICH_NEG_TTL_MS : ENRICH_TTL_MS;
    if ((now - cached.ts) < ttl) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Agent-Radio-Cache': 'HIT' });
      res.end(JSON.stringify({ ok: true, facts: cached.facts, cached: true }));
      return;
    }
  }

  const db = getDjDb();
  if (!db) {
    enrichCache.set(key, { facts: null, ts: now, neg: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'agentdj-db-unavailable', facts: null }));
    return;
  }

  try {
    const facts = queryDjFacts(db, artist, title);
    enrichCache.set(key, { facts: facts, ts: now, neg: !facts });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Agent-Radio-Cache': 'MISS' });
    res.end(JSON.stringify({ ok: true, facts: facts, cached: false }));
  } catch (e) {
    enrichCache.set(key, { facts: null, ts: now, neg: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: e.message, facts: null }));
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
// MusicBrainz enrichment proxy (NEW v11) -- server-side lookup so the browser
// never talks to MusicBrainz directly (avoids CORS friction and keeps the
// required, MusicBrainz-mandated identifying User-Agent string out of client
// JS). Looks up a recording/work by artist+title, returns a small set of
// verified facts for the bridge to fold into the narration prompt as grounded
// context -- targets the fact-fabrication problem (dossier Section 4) by
// giving the model real data instead of only the raw ICY title string.
// Read-only, GET-only, no auth. Positive cache 24h, negative cache 10min.
// Never blocks playback or narration -- a failed/slow lookup just means the
// caller narrates from ICY metadata alone, exactly as before this feature.
const MB_UA = 'AgentRadio/10.0 ( local-only desktop app, no network service )';
const MB_TTL_MS = 24 * 60 * 60 * 1000;
const MB_NEG_TTL_MS = 10 * 60 * 1000;
const MB_TIMEOUT_MS = 6000;
const MB_BYTE_CAP = 500000;
const mbCache = new Map(); // key(artist|title) -> { facts, ts, neg }

function mbCacheKey(artist, title) {
  return (String(artist || '').toLowerCase().trim() + '|' + String(title || '').toLowerCase().trim());
}

function fetchMusicBrainz(artist, title) {
  return new Promise((resolve, reject) => {
    const a = String(artist || '').trim();
    const t = String(title || '').trim();
    if (!a && !t) return reject(new Error('no artist or title'));
    const parts = [];
    if (a) parts.push('artist:"' + a.replace(/"/g, '') + '"');
    if (t) parts.push('recording:"' + t.replace(/"/g, '') + '"');
    const query = parts.join(' AND ');
    const qs = new URLSearchParams({ query: query, fmt: 'json', limit: '3' }).toString();
    const reqPath = '/ws/2/recording/?' + qs;
    const req = https.request({
      hostname: 'musicbrainz.org',
      port: 443,
      path: reqPath,
      method: 'GET',
      headers: { 'User-Agent': MB_UA, 'Accept': 'application/json' },
      timeout: MB_TIMEOUT_MS
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('musicbrainz upstream ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > MB_BYTE_CAP) { res.destroy(); reject(new Error('musicbrainz response too large')); } });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('musicbrainz parse failed')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('musicbrainz timeout')));
    req.end();
  });
}

// Extract a small, honest fact set from the top MusicBrainz match. Returns
// null (not an empty object) when nothing usable was found, so the caller can
// distinguish "no data" from "empty but valid" cleanly. Low-confidence
// matches (score < 60) are treated as no match, to avoid feeding the model a
// guess dressed up as a verified fact.
function extractMbFacts(json) {
  if (!json || !Array.isArray(json.recordings) || !json.recordings.length) return null;
  const rec = json.recordings[0];
  if (rec && typeof rec.score === 'number' && rec.score < 60) return null;
  const facts = {
    recordingTitle: rec.title || null,
    disambiguation: rec.disambiguation || null,
    firstReleaseDate: rec['first-release-date'] || null,
    artist: (Array.isArray(rec['artist-credit']) && rec['artist-credit'][0] && rec['artist-credit'][0].name) || null,
    releaseTitle: (Array.isArray(rec.releases) && rec.releases[0] && rec.releases[0].title) || null,
    workTitle: null
  };
  if (Array.isArray(rec.relations)) {
    const workRel = rec.relations.find(function (r) { return r.work && r.work.title; });
    if (workRel) facts.workTitle = workRel.work.title;
  }
  const hasAnything = facts.recordingTitle || facts.workTitle || facts.firstReleaseDate || facts.artist;
  return hasAnything ? facts : null;
}

async function serveMusicBrainz(req, res, u) {
  const artist = u.searchParams.get('artist') || '';
  const title = u.searchParams.get('title') || '';
  if (!artist && !title) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'missing-artist-and-title' }));
    return;
  }
  const key = mbCacheKey(artist, title);
  const now = Date.now();
  const cached = mbCache.get(key);
  if (cached) {
    const ttl = cached.neg ? MB_NEG_TTL_MS : MB_TTL_MS;
    if ((now - cached.ts) < ttl) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Agent-Radio-Cache': 'HIT' });
      res.end(JSON.stringify({ ok: true, facts: cached.facts, cached: true }));
      return;
    }
  }
  try {
    const json = await fetchMusicBrainz(artist, title);
    const facts = extractMbFacts(json);
    mbCache.set(key, { facts: facts, ts: now, neg: !facts });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Agent-Radio-Cache': 'MISS' });
    res.end(JSON.stringify({ ok: true, facts: facts, cached: false }));
  } catch (e) {
    mbCache.set(key, { facts: null, ts: now, neg: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: e.message, facts: null }));
  }
}

const server = http.createServer((req, res) => {
  // CORS (localhost-bound; allow any origin for local dev).
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, 'http://x');
  const route = u.pathname;
  const method = req.method;

  // Player UI
  if (method === 'GET' && (route === '/' || route === '/radio' || route === '/radio/' || route === '/agent-radio-v6.html' || route === '/index.html')) {
    return serveHtml(res);
  }

  // v10: local LLM bridge module (client-side, loaded by the HTML). Served from
  // disk next to the relay; entirely local, no external dependency.
  if (method === 'GET' && route === '/agent-radio-narration-output-guard.js') {
    return fs.readFile(path.join(__dirname, 'agent-radio-narration-output-guard-v1.js'), (err, data) => {
      if (err) return json(res, 500, { ok: false, error: 'output-guard-script-read' });
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  if (method === 'GET' && route === '/agent-radio-narration-telemetry.js') {
    return fs.readFile(path.join(__dirname, 'agent-radio-narration-telemetry-v1.js'), (err, data) => {
      if (err) return json(res, 500, { ok: false, error: 'telemetry-script-read' });
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  if (method === 'GET' && route === '/agent-radio-llm-bridge.js') {
    return fs.readFile(path.join(__dirname, 'agent-radio-llm-bridge-v11.2.js'), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('bridge not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

if (method === 'GET' && route === '/agent-radio-analysis-provenance-v1.js') {
    return fs.readFile(path.join(__dirname, 'agent-radio-analysis-provenance-v1.js'), (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('module not found'); return; }
      res.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(data);
    });
  }

if(method==='GET'&&route==='/agent-radio-grounded-story-v1.js'){return fs.readFile(path.join(__dirname,'agent-radio-grounded-story-v1.js'),(err,data)=>{if(err){res.writeHead(404,{'Content-Type':'text/plain'});res.end('module not found');return;}res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);});}
if (method === 'GET' && route === '/agent-radio-story-packet-v1.js') {
    return fs.readFile(path.join(__dirname, 'agent-radio-story-packet-v1.js'), (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('module not found'); return; }
      res.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
    });
  }
      // A3.4 isolated Native Card browser modules.
  if (method === 'GET' && ['/agent-radio-native-card-browser.js','/agent-radio-native-card-bridge.js','/agent-radio-native-card-ui.js','/agent-radio-native-card-demo.js','/agent-radio-musical-affect.js'].includes(route)) {
    return fs.readFile(path.join(__dirname, route.slice(1)), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('module not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  // Full deduplicated accepted catalog (NEW v6)
  if (method === 'GET' && (route === '/catalog.json' || route === '/catalog')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    // Annotate link-out stations here, once. The page reads this rather than keeping a second
    // copy of the rule -- a list in two places desyncs and fails silently.
    const annotated = CATALOG.map((s) => {
      const lo = linkOutForStream(s && (s.stream_url || s.streamUrl));
      if (!lo) return s;
      return { ...s, playback: 'link-out', linkOut: { service: lo.service, url: lo.url } };
    });
    res.end(JSON.stringify({ ok: true, stats: CATALOG_STATS, stations: annotated }));
    return;
  }

  // A4.1R5 exact local static assets; no arbitrary path mapping.
  const A4_STATIC_ASSETS = new Map([
    ['/agent-radio-analysis-engine-v1.1.js', ['agent-radio-analysis-engine-v1.1.js', 'application/javascript; charset=utf-8']],
    ['/agent-radio-analysis-musical-vocab-v1.js', ['agent-radio-analysis-musical-vocab-v1.js', 'application/javascript; charset=utf-8']],
    ['/agent-radio-analysis-pure-math-v1.js', ['agent-radio-analysis-pure-math-v1.js', 'application/javascript; charset=utf-8']],
    ['/agent-radio-taxonomy-v1.js', ['agent-radio-taxonomy-v1.js', 'application/javascript; charset=utf-8']],
    ['/centroids.js', ['centroids.js', 'application/javascript; charset=utf-8']],
    ['/leaflet.js', ['leaflet.js', 'application/javascript; charset=utf-8']],
    ['/leaflet.css', ['leaflet.css', 'text/css; charset=utf-8']],
    ['/agent-radio-live-native-adapter.js', ['agent-radio-live-native-adapter.js', 'application/javascript; charset=utf-8']],
    ['/agent-radio-runtime-controller-browser-v1.js', ['agent-radio-runtime-controller-browser-v1.js', 'application/javascript; charset=utf-8']]
  ]);
  if (method === 'GET' && A4_STATIC_ASSETS.has(route)) {
    const [name, type] = A4_STATIC_ASSETS.get(route);
    return fs.readFile(path.join(__dirname, name), (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('asset missing'); return; }
      res.writeHead(200, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(data);
    });
  }

  // A3.5 demo network guard: these self-routes must never contact upstreams.

  // Audio stream proxy (NEW v5) — registered-station-only pipe.
  if (method === 'GET' && route.startsWith('/stream/')) {
    const stationId = route.slice('/stream/'.length);
    return serveStream(req, res, stationId);
  }

  // Favicon proxy (NEW v7) — registered-station-only, SSRF-guarded, cached.
  if (method === 'GET' && route === '/radio/musicbrainz') {
    return serveMusicBrainz(req, res, u);

// Agent DJ catalog enrichment (NEW v23) -- style tags + audio features + co-occurrence.
if (method === 'GET' && route === '/radio/enrich') {
return serveDjEnrich(req, res, u);
}
  }

  if (method === 'GET' && route.startsWith('/favicon/')) {
    const stationId = route.slice('/favicon/'.length);
    return serveFavicon(req, res, stationId);
  }

  // Health
  // Native authorization: same-origin, loopback-only, action-bound and fail-closed.
  if (method === 'POST' && (route === '/native-auth/authorize' || route === '/native-auth/consume')) {
    return agentRadioHandleNativeAuth(req, res, route);
  }

  // Runtime controller broker: same-origin, loopback-only, fixed verbs. The
  // relay routes a zero-argument intent to the dedicated controller; it never
  // performs a runtime lifecycle action itself.
  if ((route === '/runtime-controller/nonce' ||
       route === '/runtime-controller/status' ||
       route === '/runtime-controller/request-stop' ||
       route === '/runtime-controller/request-start')) {
    return agentRadioHandleRuntimeController(req, res, route);
  }

  if (method === 'GET' && route === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, relay: 'agent-radio-v11.2-a5.1r8-stop-control', version: '11.2-a4.0-promotion-candidate', port: PORT,
      registeredStations: REGISTRY.size, cacheEntries: CACHE.size,
      faviconCacheEntries: faviconCache.size,
enrichCacheEntries: enrichCache.size, djDbConnected: !!getDjDb(),
      upstreamInFlight: _active, maxConcurrent: MAX_CONCURRENT,
      streamsInFlight: _streamsActive, maxStreamConcurrent: MAX_STREAM_CONCURRENT,
      catalog: CATALOG_STATS, testMode: TEST_MODE, ts: nowIso(),
    }));
    return;
  }

  // Register stations
  if (method === 'POST' && route === '/radio/register-stations') {
    registerStations(req).then(({ httpStatus, body }) => {
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }).catch(() => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'relay-failure' })); });
    return;
  }

  // Now playing
  if (method === 'GET' && route === '/radio/now-playing') {
    const stationId = u.searchParams.get('stationId');
    if (!stationId || !isValidStationId(stationId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing-or-invalid-stationId' }));
      return;
    }
    getNowPlaying(stationId, { force: u.searchParams.get('force') === '1' || u.searchParams.get('r') === '1' }).then(({ httpStatus, body }) => {
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }).catch(() => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'relay-failure' })); });
    return;
  }

  // Diagnostics
  if (method === 'GET' && route === '/radio/diagnostics') {
    const stationId = u.searchParams.get('stationId');
    if (!stationId || !isValidStationId(stationId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing-or-invalid-stationId' }));
      return;
    }
    const { httpStatus, body } = getDiagnostics(stationId);
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not-found', route }));
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[agent-radio] v10 relay on http://${HOST}:${PORT}  (UI at /  ·  catalog at /catalog.json  ·  stream at /stream/:id  ·  API at /radio/*)`);
    console.log(`[agent-radio] HTML:    ${HTML_FILE}`);
    console.log(`[agent-radio] Catalog: ${CATALOG_STATS.file}`);
    console.log(`[agent-radio]   totalRecords=${CATALOG_STATS.totalRecords}  dedupAccepted=${CATALOG_STATS.dedupAccepted}  plottable=${CATALOG_STATS.plottable}  unavailable=${CATALOG_STATS.unavailable}  hls=${CATALOG_STATS.hls}  probeMerged=${CATALOG_STATS.probeMerged}`);
    console.log(`[agent-radio] Caps:    metadata: upstreamTimeout=${UPSTREAM_TIMEOUT_MS}ms  byteCap=${HARD_BYTE_CAP}  concurrent=${MAX_CONCURRENT}  ·  streams: concurrent=${MAX_STREAM_CONCURRENT}  idleTimeout=${STREAM_IDLE_TIMEOUT_MS}ms${TEST_MODE ? '  TEST MODE' : ''}`);
    // Auto-open the browser on direct launch (skip in tests / when suppressed).
    if (!TEST_MODE && process.env.AGENT_RADIO_NO_OPEN !== '1') {
      const url = `http://${HOST}:${PORT}/`;
      const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start ""'
        : 'xdg-open';
      setTimeout(() => {
        try {
          const child = require('child_process').spawn(cmd, [url], { detached: true, stdio: 'ignore' });
          child.unref();
          console.log(`[agent-radio] Opened browser: ${url}`);
        } catch (e) { /* non-fatal: user can open the URL manually */ }
      }, 500);
    }
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[agent-radio] Port ${PORT} in use — free with: lsof -ti:${PORT} | xargs kill`);
    console.error('            (note: the Agent DJ emotional-card relay also uses :4200; only one may run at a time.)');
  } else {
    console.error('[agent-radio] Server error:', e.message);
  }
  process.exit(1);
});

// ── Exports for the test runner (Phase F/G fixtures + hardening) ───────────────
module.exports = {
  // constants
  PORT, HOST, UPSTREAM_TIMEOUT_MS, HARD_BYTE_CAP, MAX_CONCURRENT,
  MIN_CACHE_TTL_S, MAX_CACHE_TTL_S, STALE_GRACE_MS, TEST_MODE,
  MAX_STREAM_CONCURRENT, STREAM_IDLE_TIMEOUT_MS,
  // parsers & helpers
  parseStandard, parseClassical, parseShowPrefixed, parseStreamTitle, applyJsonPaths,
  buildResponse, safeGet, normStr, isPrivateIp, isValidStationId,
  looksLikeProgram, clampTtl,
  // stream proxy
  resolveAudioUrl, codecContentType, serveStream,
  // favicon proxy (NEW v7)
  serveFavicon, fetchFaviconUpstream, faviconFallbackSvg, serveFaviconFallback, faviconCache,
  fetchMusicBrainz, extractMbFacts, serveMusicBrainz, mbCache,
// Agent DJ enrichment (NEW v23)
serveDjEnrich, queryDjFacts, getDjDb, enrichCache, ENRICH_TTL_MS, ENRICH_NEG_TTL_MS,
  FAVICON_TTL_MS, FAVICON_NEG_TTL_MS, FAVICON_TIMEOUT_MS, FAVICON_BYTE_CAP,
  // catalog (NEW v6)
  CATALOG, CATALOG_STATS, loadCatalog, deriveMetadata,
  // state (for cache/leak inspection)
  REGISTRY, CACHE,
};
