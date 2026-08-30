# TavernNext

TavernNext is a local-first, Agent-driven roleplay runtime for official Scene Packages. Each Save owns a private writing Preset and runs one bounded Scene Director through tool-capable Chat models; SillyTavern-compatible Characters, Presets, Worldbooks, and tokenizers remain reusable library/import data.

## Run locally

Prerequisite: Node.js 22 or newer.

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The browser UI proxies `/api` to the local server at `http://127.0.0.1:4312`; the server binds to `127.0.0.1` by default.

The default data directory is `.tavernnext` under the directory where the server starts. Override it before startup when you want a separate profile:

```powershell
$env:TAVERNNEXT_DATA_DIR='D:\TavernNext-data'
npm run dev
```

`TAVERNNEXT_DATABASE_PATH` can override only the SQLite path. `TAVERNNEXT_HOST` and `TAVERNNEXT_PORT` override the API listen address; changing the host can expose the server and is not required for normal local use.

## Data, backups, and API keys

TavernNext stores its SQLite database and managed assets under the data directory. Before a required schema migration it creates a verified snapshot under `<data-directory>/backups`; the five newest automatic backups are retained. Stop TavernNext before copying or restoring live database files.

API keys are written server-side to `<data-directory>/secrets.json`, not to SQLite, browser storage, API responses, or ordinary logs. The file is permission-restricted where the operating system supports verifiable owner-only access, but it is not described as encrypted; protect data-directory backups accordingly. The Connection page never reads a saved key back into the browser.

## Release and test commands

```powershell
npm run typecheck
npm test
npm run build
npm run verify:compat
npm run setup:e2e
npm run test:e2e
npm run smoke:local
npm run verify
```

`npm run test:e2e` and `npm run verify` provision the pinned Playwright Chromium binary automatically. To provision it separately:

```powershell
npx playwright install chromium
```

`npm run verify` runs typechecking, all Vitest unit/integration tests, both production builds, the compatibility inventory/oracle gate, and Playwright. Enable the read-only SillyTavern 1.18.0 oracle checks with:

```powershell
$env:SILLYTAVERN_ORACLE_DIR='D:\CodeX\SillyTavern'
$env:TAVERNNEXT_REGEX_CARD_PATH='D:\path\to\exact-example-card.png'
$env:TAVERNNEXT_REGEX_PRESET_PATH='D:\path\to\exact-target-preset.json'
npm run verify
```

See [docs/compatibility.md](docs/compatibility.md) for the exact compatibility surface and [docs/development.md](docs/development.md) for package boundaries.
