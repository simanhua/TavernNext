# TavernNext development

## Package boundaries

- `apps/web` is the React/Vite browser application. It owns navigation, forms, chat interaction, Prompt Preview, and browser-side stream consumption. It talks only to `/api`.
- `apps/server` is the local Fastify application. It owns persistence, imports, exports, provider credentials, generation lifecycle, backups, assets, and HTTP response redaction.
- `packages/domain` defines shared schemas and entities. It has no UI, database, or provider behavior.
- `packages/st-compat` detects, inspects, normalizes, preserves, and exports SillyTavern-compatible artifacts. It is pure compatibility code and does not start SillyTavern.
- `packages/tokenizer-engine` selects tokenizer IDs, loads bounded local/cache models, and performs token counting.
- `packages/prompt-engine` compiles Chat and Text prompts and evaluates Worldbooks. It has no network or database ownership.
- `packages/provider-openai-compatible` is the server-side OpenAI-compatible HTTP/SSE client.
- `packages/extension-runtime` consumes normalized attached assets and owns pure regex execution, shared Worker timeout orchestration, and trusted TavernHelper script manifest/tree projection (stable ownership, buttons, and pinned remote-cache URLs). It depends inward on `packages/domain`; SillyTavern artifact extraction/export stays in `packages/st-compat`, while browser and Node Worker adapters are exposed as separate package entry points. The web app owns the same-origin iframe and compatibility globals.
- `tests/fixtures` contains deterministic compatibility and golden inputs. `tests/e2e` owns the restartable local stack and real-browser release scenarios.
- `scripts/verify-st-oracle.mjs` and `scripts/smoke-local.mjs` are release gates, not runtime dependencies.

Keep dependencies pointing inward through those public package contracts. In particular, browser code must not receive provider secrets, compatibility packages must not write application state, and prompt/tokenizer packages must not reach into Fastify or SQLite.

## SillyTavern is an oracle, not a dependency

The checkout named by `SILLYTAVERN_ORACLE_DIR` is read-only test input. Production source must not import it, copy runtime files from it, add it to module resolution, or require it to start TavernNext. The compatibility gate maps that variable to the existing test-only `TAVERNNEXT_ST_ORACLE_ROOT` probes, validates the pinned 1.18.0 checkout in place, and fails if its Git working state changes.

Static fixtures and golden expectations must be original synthetic data or recorded parity results with provenance. Do not vendor upstream runtime modules to make a test pass. Bundled tokenizer model files retain their existing notices and hashes.

## Local workflow

From the repository root:

```powershell
npm install
npm run typecheck
npm test
npm run test:e2e
npm run smoke:local
```

Use `TAVERNNEXT_DATA_DIR` for disposable manual profiles. The Playwright command first provisions its pinned Chromium build. The harness creates temporary data directories, assigns a per-run loopback API port to both Vite and the actual server entrypoint, uses a local deterministic provider, proves the spawned server owns that port, runs one worker, and removes its temporary state. Vitest explicitly excludes `tests/e2e` so each suite is collected by only one runner.

The complete release command is:

```powershell
$env:SILLYTAVERN_ORACLE_DIR='D:\CodeX\SillyTavern'
$env:TAVERNNEXT_REGEX_CARD_PATH='D:\path\to\exact-example-card.png'
$env:TAVERNNEXT_REGEX_PRESET_PATH='D:\path\to\exact-target-preset.json'
$env:TAVERNNEXT_APPROVED_REMOTE_CACHE_MANIFEST='D:\path\to\approved-cache.json'
npm run verify
npm run smoke:local
```

The two regex artifact variables and approved-cache manifest are mandatory when the SillyTavern oracle is enabled. The artifacts must identify the reviewed 12-rule example card and 9-rule target Preset. The manifest is versioned JSON with exact artifact hashes plus a non-empty `entries` array of `{ "url", "sha256", "path" }`; relative entry paths resolve beside the manifest. The gate hashes every cached entry before and after the oracle run, binds the manifest to the exact Character and Preset bytes, records the pinned SillyTavern revision, performs no download, and does not modify any input.
