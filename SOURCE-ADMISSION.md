# Source admission record

Generated: 20260921T044300Z

## Source reference

- Local candidate: `<operator home>/Aether/AgentDJ/Agent-Radio-v11.2-staging/phase5_3/candidates/a5_3r23_orb_strategy_20260921T032955Z`
- Candidate manifest verified: `A5.3R23-MANIFEST.sha256.txt`
- Admission policy: explicit allowlist only
- Deliberately excluded: catalogs, runtime/service controls, model integrations, credentials, logs, PIDs, telemetry, candidate/rehearsal evidence, historic manifests, rollback/deploy scripts, and predecessor copies. Additionally excluded in this admission: third-party images (`art/exclusive/` 86 files, `art/stations/` 324 files), the station-catalog JSON (`agent-radio-stations-v11.2-projected.json`), the runtime-controller browser client, the native authorization helper binary (`native/bin/agent-radio-auth-helper`), and the favicon/art build scripts (see Fixtures provenance).

## Application files

- `app/agent-radio-v11.2.html`
- `app/agent-radio-relay-v11.2.js`
- `app/agent-radio-llm-bridge-v11.2.js`
- `app/agent-radio-analysis-engine-v1.1.js`
- `app/agent-radio-analysis-musical-vocab-v1.js`
- `app/agent-radio-analysis-provenance-v1.js`
- `app/agent-radio-analysis-pure-math-v1.js`
- `app/agent-radio-artist-identity-v1.cjs`
- `app/agent-radio-grounded-story-v1.js`
- `app/agent-radio-live-native-adapter.js`
- `app/agent-radio-musical-affect.js`
- `app/agent-radio-narration-output-guard-v1.js`
- `app/agent-radio-narration-telemetry-v1.js`
- `app/agent-radio-narrative-foundation-v1.js`
- `app/agent-radio-narrative-ui-v1.js`
- `app/agent-radio-native-card-bridge.js`
- `app/agent-radio-native-card-browser.js`
- `app/agent-radio-native-card-demo.js`
- `app/agent-radio-native-card-engine.source.cjs`
- `app/agent-radio-native-card-ui.js`
- `app/agent-radio-story-packet-v1.js`
- `app/agent-radio-taxonomy-v1.js`
- `app/centroids.js`
- `app/leaflet.css`
- `app/leaflet.js`

## Runtime-release note

`app/agent-radio-v11.2.html` embeds a runtime-release UI (the "No DJ releases the shared runtime" interaction) and an inline runtime-controller wrapper. That UI is admitted verbatim as part of the HTML. Its companion browser client, `agent-radio-runtime-controller-browser-v1.js`, is deliberately excluded as a runtime/service control; the HTML constructs its controller with a null backend and wires the client only when the (absent) script is present, so the baseline degrades cleanly without it.

## Fixtures

- `fixtures/favicon-backfill-manifest.csv`

Provenance (reproducibility only — the build scripts themselves are NOT admitted; both write candidate directories and fall under the excluded build/deploy category):

- `phase5_3/builders/r24-favicon-backfill.sh` — SHA-256 `a562ea3550997e41f6556bb27fd5b3b2c10765b70e2bba444ef019190df5dcd1` — produces candidate `a5_3r24_favicon_backfill_20260921T031018Z`
- `phase5_3/builders/r25-localart-stations.sh` — SHA-256 `c7a08e9f31a51c8c5cf3a75d3da2e74d54ce59416721eca46df7369358ddf4ba` — produces candidate `a5_3r25_localart_stations_20260921T031903Z`

The manifest CSV is admitted from the live candidate named above, with SHA-256 `80a0f6da9c647837689c78467e6d5b694264b639a938e3bbc4692b97b14b0875`.

## Tests

- `tests/tests-layout-contract.cjs`
- `tests/tests-tab-exclusive.cjs`
- `tests/tests-favorites-order.cjs`
- `tests/tests-station-triage.cjs`