# TavernNext development

## Package boundaries

- `apps/web` is the React/Vite browser application. It owns navigation, forms, Scene workspaces, Save Agent configuration, and browser-side event-stream consumption. It talks only to `/api`.
- `apps/server` is the local Fastify application. It owns persistence, official Scene resources, provider credentials, Agent Run lifecycle, tools, backups, assets, and HTTP response redaction.
- `packages/domain` defines shared schemas and entities. It has no UI, database, or provider behavior.
- `packages/st-compat` decodes, normalizes, and preserves the source artifacts required by Scene loading and historical migrations. It is pure compatibility code and does not start SillyTavern.
- `packages/tokenizer-engine` selects tokenizer IDs, loads bounded local/cache models, and performs token counting.
- `packages/prompt-engine` compiles Chat prompts and evaluates Worldbooks. It has no network or database ownership.
- `packages/provider-openai-compatible` owns safe model discovery plus the Pi provider/model adapter used by the Agent Runtime.
- `packages/extension-runtime` owns pure server-side prompt regex execution and Node Worker timeout orchestration over retained attached-resource data. It depends inward on `packages/domain`; source artifact decoding stays in `packages/st-compat`. Browser script hosts, display regex workers, trust/RPC bridges, and interactive message HTML have been retired.
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
npm run verify
npm run smoke:local
```

The two regex artifact variables are required when the SillyTavern oracle is enabled. They identify the reviewed 12-rule example card and 9-rule target Preset used to verify prompt-eligible regex behavior. The gate records the pinned SillyTavern revision, performs no download, and rejects any change to its working tree. Retired script bridges and remote-code caches are not release surfaces.
