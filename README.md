# TavernNext

TavernNext is a local-first, Agent-driven roleplay runtime for official Scene Packages. Each Save owns a private writing Preset and runs one bounded Scene Director through tool-capable Chat models; SillyTavern-compatible Characters, Presets, Worldbooks, and tokenizers remain reusable library/import data.

## Run locally

Prerequisite: Node.js 22.19.0 or newer.

On Windows, use the checked startup entrypoint from the repository root:

```powershell
.\Start-TavernNext.cmd
```

It validates Node.js, npm, dependencies, and both ports; installs missing workspace dependencies; starts the API and web development servers together; and opens the browser after the API is ready. Press `Ctrl+C` to stop both servers.

Common options:

```powershell
# Keep an isolated data profile and do not open a browser.
.\Start-TavernNext.cmd -DataDir 'D:\TavernNext-data' -NoBrowser

# Use alternate ports (the web proxy follows the API port automatically).
.\Start-TavernNext.cmd -ApiPort 4412 -WebPort 5273

# Repair or refresh workspace dependencies.
.\Start-TavernNext.cmd -InstallDependencies

# Validate the environment without starting anything.
.\Start-TavernNext.cmd -CheckOnly
```

Run `.\Start-TavernNext.cmd -Help` for the complete parameter list. The startup script keeps both services on `127.0.0.1` by default; passing another bind address can expose them to your network.

The underlying manual workflow remains available on every platform:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The browser UI proxies `/api` to the local server at `http://127.0.0.1:4312`; the server binds to `127.0.0.1` by default.

The default data directory is `.tavernnext` under the repository root. Override it before manual startup when you want a separate profile:

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
