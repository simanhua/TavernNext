# TavernNext Role Chat MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first role-chat application that runs SillyTavern-compatible characters, personas, presets, tokenizers, Worldbooks, and solo-chat files against OpenAI-compatible Chat and Text Completion APIs.

**Architecture:** Create a new TypeScript npm-workspaces modular monolith at `D:\CodeX\TavernNext`; the existing `D:\CodeX\SillyTavern` checkout is a read-only compatibility oracle. React/Vite owns the browser UI, Fastify owns local APIs and secrets, SQLite/Drizzle owns persistence, and pure packages own file compatibility, tokenization, prompt compilation, and provider transport.

**Tech Stack:** Node 22, npm workspaces, TypeScript strict, React, Vite, Fastify, Drizzle ORM, SQLite, Zod, TanStack Query, Zustand, Tailwind CSS, Radix UI, Vitest, Playwright.

## Global Constraints

- Compatibility baseline is the checked-out SillyTavern `1.18.0`; future upstream compatibility requires new fixtures and migrations.
- Do not modify `D:\CodeX\SillyTavern`, import its runtime modules, or copy its source code into TavernNext.
- Behavioral parity may use the same independently published tokenizer libraries and legally distributable model data.
- Bind HTTP to `127.0.0.1` by default, emit no telemetry, and never return or log API keys.
- Support only OpenAI-compatible `/v1/models`, `/v1/chat/completions`, and `/v1/completions` for generation.
- Preserve unknown imported fields and original artifacts even when TavernNext cannot execute them.
- Use test-driven development: failing test, minimal implementation, passing focused test, full affected suite, then commit.
- MVP excludes group chat, branches, checkpoints, impersonation, attachments/RAG, image generation, TTS, STscript, extensions, cloud sync, installer, and auto-update.

---

## Delivery Milestones

1. **Runnable role-chat vertical slice — Tasks 1-5:** local server, SQLite, one character/persona, OpenAI-compatible streaming, chat history, stop/edit/delete.
2. **ST character and preset compatibility — Tasks 6-10:** original tokenizer behavior, Character Card import/export, preset codecs, Chat/Text prompt compilation.
3. **Full Worldbook runtime — Tasks 11-13:** Worldbook codecs, deterministic activation engine, snapshot-based generation integration.
4. **Core ST chat UX and release gate — Tasks 14-17:** Swipe/Regenerate/Continue, JSONL round-trip, manager UIs, security/recovery/E2E verification.

## Locked File Structure

```text
apps/web/src/
  api/                  typed API client and SSE client
  app/                  router, query client, global layout
  features/chat/        conversation UI and state
  features/characters/  library, editor, import/export
  features/personas/    persona manager
  features/presets/     preset manager
  features/worldbooks/  Worldbook manager
  features/settings/    OpenAI-compatible connection settings

apps/server/src/
  app.ts                Fastify composition root
  config.ts             local paths and bind settings
  db/                   Drizzle schema, migrations, repositories
  routes/               thin HTTP route adapters
  services/             imports, prompt previews, generations, secrets

packages/domain/src/                shared Zod schemas and TypeScript types
packages/st-compat/src/             format detection, codecs, lossless envelopes
packages/tokenizer-engine/src/      ST tokenizer IDs, selection, loading, counting
packages/prompt-engine/src/         macros, Worldbook evaluation, Chat/Text compilers
packages/provider-openai-compatible/src/  HTTP/SSE provider adapter
tests/fixtures/                      immutable compatibility and provider fixtures
```

## Milestone 1 — Runnable Role-Chat Vertical Slice

### Task 1: Bootstrap the monorepo and health-checked applications

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/app.ts`, `apps/server/src/main.ts`
- Create: `apps/server/test/health.test.ts`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`

**Interfaces:**
- Produces: `createApp(): FastifyInstance`
- Produces: root scripts `dev`, `build`, `test`, `typecheck`, `test:e2e`

- [ ] **Step 1: Initialize the repository and create the root workspace manifests**

```json
{
  "name": "tavernnext",
  "private": true,
  "engines": { "node": ">=22" },
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "concurrently -k \"npm:dev -w @tavernnext/server\" \"npm:dev -w @tavernnext/web\"",
    "build": "npm run build --workspaces --if-present",
    "test": "vitest run",
    "typecheck": "tsc -b",
    "test:e2e": "playwright test"
  }
}
```

Run:

```powershell
git init -b main
npm install -D concurrently typescript vitest @vitest/coverage-v8 @types/node
npm install -w @tavernnext/server fastify
npm install -w @tavernnext/web react react-dom vite @vitejs/plugin-react
npm install -D -w @tavernnext/web @types/react @types/react-dom
```

Expected: `package-lock.json` is created, the resolved versions are pinned by that lockfile, and `npm ls --workspaces` exits 0.

- [ ] **Step 2: Write the failing server health test**

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('reports the local API as ready', async () => {
    const app = createApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', app: 'TavernNext' });
    await app.close();
  });
});
```

- [ ] **Step 3: Run the focused test and confirm the missing composition root**

Run: `npm test -- apps/server/test/health.test.ts`
Expected: FAIL because `../src/app.js` or `createApp` does not exist.

- [ ] **Step 4: Implement the Fastify composition root and minimal React shell**

```ts
// apps/server/src/app.ts
import Fastify from 'fastify';

export function createApp() {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.x-api-key'] } });
  app.get('/api/health', async () => ({ status: 'ok', app: 'TavernNext' }));
  return app;
}
```

`main.ts` must listen on `host: process.env.TAVERNNEXT_HOST ?? '127.0.0.1'` and numeric `TAVERNNEXT_PORT ?? 4312`. `App.tsx` must render the application name and fetch `/api/health` through Vite's `/api` proxy.

- [ ] **Step 5: Verify both applications**

Run: `npm test -- apps/server/test/health.test.ts && npm run typecheck && npm run build`
Expected: one health test passes; all TypeScript projects and both production builds succeed.

- [ ] **Step 6: Commit the bootstrap**

```powershell
git add package.json package-lock.json tsconfig.base.json .gitignore .editorconfig apps
git commit -m "chore: bootstrap TavernNext workspace"
```

### Task 2: Define domain contracts and SQLite persistence

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/src/index.ts`
- Create: `packages/domain/src/entities.ts`, `packages/domain/src/compatibility.ts`, `packages/domain/src/generation.ts`, `packages/domain/test/contracts.test.ts`
- Create: `apps/server/src/config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/src/db/migrate.ts`
- Create: `apps/server/src/db/repositories.ts`, `apps/server/test/db/repositories.test.ts`

**Interfaces:**
- Produces: Zod schemas and inferred types for all core entities
- Produces: `createDatabase(path: string): TavernDatabase`
- Produces: `createRepositories(db: TavernDatabase): Repositories`
- Produces: repository methods `create`, `get`, `list`, `update`, `delete` with optimistic `revision`

- [ ] **Step 1: Write contract tests for lossless metadata and generation modes**

```ts
import { CompatibilityMetadataSchema, GenerationRequestSchema } from '../src/index.js';

expect(CompatibilityMetadataSchema.parse({
  sourceFormat: 'st-character-v3', rawPayload: { future: true }, unknownFields: { future: true },
  compatWarnings: [], parserVersion: '1',
}).unknownFields).toEqual({ future: true });

expect(GenerationRequestSchema.parse({
  conversationId: '018f0000-0000-7000-8000-000000000001', conversationRevision: 3, mode: 'swipe',
}).mode).toBe('swipe');
```

- [ ] **Step 2: Run the domain test and confirm schemas are missing**

Run: `npm test -- packages/domain/test/contracts.test.ts`
Expected: FAIL with missing domain exports.

- [ ] **Step 3: Implement the public domain types**

Run:

```powershell
npm install -w @tavernnext/domain zod
npm install -w @tavernnext/server drizzle-orm better-sqlite3
npm install -D -w @tavernnext/server drizzle-kit @types/better-sqlite3
```

Define UUID-based schemas for `Character`, `Persona`, `Worldbook`, `WorldbookEntry`, `Preset`, `Conversation`, `Message`, `MessageVariant`, `ProviderProfile`, and `ImportArtifact`. Every mutable aggregate has `revision`, `createdAt`, and `updatedAt`. `MessageVariant.status` is exactly `streaming | completed | aborted | failed`; `Preset.kind` is exactly `chat | text | context | instruct | system | reasoning`.

```ts
export const GenerationModeSchema = z.enum(['normal', 'regenerate', 'swipe', 'continue']);
export const GenerationRequestSchema = z.object({
  conversationId: z.string().uuid(),
  conversationRevision: z.number().int().nonnegative(),
  mode: GenerationModeSchema,
  userText: z.string().optional(),
});
```

- [ ] **Step 4: Write failing repository tests using a temporary SQLite database**

Test these exact behaviors: migrations create every table; character raw metadata survives a create/get cycle; updating revision 0 to 1 succeeds; repeating revision 0 returns a conflict; deleting a conversation cascades messages and variants but not the character or Persona.

Run: `npm test -- apps/server/test/db/repositories.test.ts`
Expected: FAIL because database modules are absent.

- [ ] **Step 5: Implement schema, migrations, and repositories**

Create tables named `characters`, `personas`, `worldbooks`, `worldbook_entries`, `presets`, `conversations`, `messages`, `message_variants`, `provider_profiles`, `import_artifacts`, and `generation_snapshots`. Store normalized structured fields as SQLite JSON text through Drizzle custom types; keep indexed relationship IDs and `revision` as dedicated columns. Enable `PRAGMA foreign_keys=ON`, WAL journal mode, and a five-second busy timeout.

- [ ] **Step 6: Verify persistence**

Run: `npm test -- packages/domain/test/contracts.test.ts apps/server/test/db/repositories.test.ts && npm run typecheck`
Expected: all contract and repository tests pass.

- [ ] **Step 7: Commit the domain and storage boundary**

```powershell
git add packages/domain apps/server/src/config.ts apps/server/src/db apps/server/test/db
git commit -m "feat: add domain contracts and SQLite persistence"
```

### Task 3: Implement the OpenAI-compatible provider adapter

**Files:**
- Create: `packages/provider-openai-compatible/package.json`
- Create: `packages/provider-openai-compatible/src/types.ts`, `src/errors.ts`, `src/sse.ts`, `src/client.ts`, `src/index.ts`
- Create: `packages/provider-openai-compatible/test/mock-server.ts`, `client.test.ts`

**Interfaces:**
- Produces: `listModels(profile, signal?): Promise<ModelInfo[]>`
- Produces: `streamChat(request, signal): AsyncIterable<ProviderEvent>`
- Produces: `streamText(request, signal): AsyncIterable<ProviderEvent>`
- Produces: normalized `ProviderError` codes `auth | connection | rate_limit | protocol | context_overflow | aborted`

- [ ] **Step 1: Write provider tests against a local mock HTTP server**

```ts
const events = [];
for await (const event of client.streamChat({ model: 'mock', messages: [{ role: 'user', content: 'Hi' }] }, signal)) {
  events.push(event);
}
expect(events).toEqual([
  { type: 'delta', text: 'Hel' },
  { type: 'delta', text: 'lo' },
  { type: 'usage', inputTokens: 4, outputTokens: 2 },
  { type: 'completed', finishReason: 'stop' },
]);
```

Add focused tests for `/v1/models`, text completions, non-stream JSON, 401, 429 with retry metadata, connection refusal, malformed SSE, mid-stream disconnect, context overflow, `[DONE]`, and AbortSignal cancellation.

- [ ] **Step 2: Run provider tests and confirm the package is missing**

Run: `npm test -- packages/provider-openai-compatible/test/client.test.ts`
Expected: FAIL with missing client exports.

- [ ] **Step 3: Implement URL normalization, safe headers, SSE parsing, and error mapping**

`baseUrl` ending in `/` must normalize once; endpoint paths must not duplicate `/v1`. Send `Authorization: Bearer <key>` only from the server-provided profile. Parse multi-line `data:` frames, ignore comments, accept CRLF/LF, and never include response headers or submitted request headers in thrown error details.

- [ ] **Step 4: Verify provider behavior**

Run: `npm test -- packages/provider-openai-compatible/test/client.test.ts && npm run typecheck`
Expected: all provider tests pass without external network access.

- [ ] **Step 5: Commit the provider adapter**

```powershell
git add packages/provider-openai-compatible
git commit -m "feat: add OpenAI-compatible provider adapter"
```

### Task 4: Add the first complete generation API

**Files:**
- Create: `apps/server/src/services/basic-prompt.ts`, `apps/server/src/services/generation-service.ts`
- Create: `apps/server/src/routes/characters.ts`, `personas.ts`, `providers.ts`, `conversations.ts`, `generations.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/test/generation-api.test.ts`

**Interfaces:**
- Consumes: repositories and `streamChat`
- Produces: CRUD routes for Character, Persona, ProviderProfile, Conversation
- Produces: `POST /api/conversations/:id/generations`, `DELETE /api/generations/:id`
- Produces: SSE `started | delta | usage | completed | aborted | failed`

- [ ] **Step 1: Write the failing vertical-slice API test**

Seed one character, one Persona, one provider, and one conversation. Submit `{ conversationRevision: 0, mode: 'normal', userText: 'Hello' }`; assert one user message is persisted, the mock provider receives system content containing character description and Persona description, SSE deltas form `Hello there`, and one completed assistant variant is persisted.

Also assert: a second simultaneous generation returns 409; stale revision returns 409; cancellation retains partial content and marks the variant `aborted`; upstream failure creates no empty assistant message.

- [ ] **Step 2: Run the focused API test**

Run: `npm test -- apps/server/test/generation-api.test.ts`
Expected: FAIL because generation routes are not registered.

- [ ] **Step 3: Implement a minimal prompt and transactional generation service**

```ts
export function compileBasicChat(input: {
  character: Character;
  persona: Persona;
  history: MessageWithActiveVariant[];
}): ChatMessage[] {
  return [
    { role: 'system', content: `${input.character.description}\n\n${input.persona.description}`.trim() },
    ...input.history.map(toChatMessage),
  ];
}
```

Acquire a per-conversation in-memory generation lock, validate revision before persisting, create the assistant message only after the first non-empty delta, flush the streaming variant every 250 ms or 256 accumulated characters (whichever comes first), and finalize status in `finally`. Record a generation snapshot containing entity IDs and revisions even though the full compiler arrives later.

- [ ] **Step 4: Verify generation and CRUD routes**

Run: `npm test -- apps/server/test/generation-api.test.ts apps/server/test/db/repositories.test.ts`
Expected: all API and persistence scenarios pass.

- [ ] **Step 5: Commit the first backend vertical slice**

```powershell
git add apps/server/src apps/server/test/generation-api.test.ts
git commit -m "feat: add role chat generation API"
```

### Task 5: Build the first usable chat UI

**Files:**
- Create: `apps/web/src/api/client.ts`, `apps/web/src/api/generation-stream.ts`
- Create: `apps/web/src/app/router.tsx`, `apps/web/src/app/query-client.ts`
- Create: `apps/web/src/features/chat/ChatPage.tsx`, `MessageList.tsx`, `Composer.tsx`, `useGeneration.ts`
- Create: `apps/web/src/features/settings/ConnectionPage.tsx`
- Create: `apps/web/src/features/characters/CharacterQuickCreate.tsx`
- Create: `apps/web/src/features/personas/PersonaQuickCreate.tsx`
- Create: `apps/web/src/features/chat/ChatPage.test.tsx`

**Interfaces:**
- Consumes: Task 4 HTTP/SSE APIs
- Produces: browser workflow from local connection setup to persisted streaming chat

- [ ] **Step 1: Write the failing React interaction test**

Render `ChatPage` with MSW handlers. Select a character and Persona, type `Hello`, submit, stream `Hel` then `lo`, click Stop in a second run, edit the user message, delete a message, and switch to another persisted conversation. Assert disabled/enabled composer state and visible message content after each action.

- [ ] **Step 2: Run the component test**

Run: `npm test -- apps/web/src/features/chat/ChatPage.test.tsx`
Expected: FAIL because chat components do not exist.

- [ ] **Step 3: Implement API client, SSE state machine, and chat components**

Run:

```powershell
npm install -w @tavernnext/web @tanstack/react-query zustand react-router-dom react-hook-form @hookform/resolvers zod @radix-ui/react-dialog @radix-ui/react-tabs
npm install -D -w @tavernnext/web @testing-library/react @testing-library/user-event jsdom msw tailwindcss @tailwindcss/vite
```

Use TanStack Query for server state and a small Zustand store only for the active conversation ID, draft, and selected variant. The SSE state machine must accept exactly the six server event types and make Stop idempotent. Do not synthesize a completed reply client-side; refetch authoritative conversation state on terminal events.

- [ ] **Step 4: Add connection and quick-create forms**

Connection fields are display name, Base URL, model, API key, and mode `chat | text`. The browser sends the key only on create/update and receives `hasApiKey: boolean` thereafter. Quick-create Character fields are name, description, first message; Persona fields are name and description.

- [ ] **Step 5: Verify Milestone 1**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass and production builds succeed. Manual smoke: `npm run dev`, open the shown localhost URL, configure the mock provider, create a character and Persona, stream and stop a chat, restart, and observe the chat restored.

- [ ] **Step 6: Commit the first usable UI**

```powershell
git add apps/web
git commit -m "feat: add local role chat interface"
```

## Milestone 2 — Character, Tokenizer, and Preset Compatibility

### Task 6: Implement the complete SillyTavern tokenizer registry

**Files:**
- Create: `packages/tokenizer-engine/package.json`
- Create: `packages/tokenizer-engine/src/ids.ts`, `registry.ts`, `model-selection.ts`, `model-cache.ts`, `models.manifest.ts`
- Create: `packages/tokenizer-engine/src/tiktoken-adapter.ts`, `sentencepiece-adapter.ts`, `web-tokenizer-adapter.ts`, `remote-adapter.ts`, `index.ts`
- Create: `packages/tokenizer-engine/test/registry.test.ts`, `selection.test.ts`, `parity.test.ts`
- Create: `tests/fixtures/tokenizers/parity-corpus.json`

**Interfaces:**
- Produces: numeric `TokenizerId` values `0..19` and `99` matching ST
- Produces: `selectTokenizer(input: TokenizerSelectionInput): TokenizerDecision`
- Produces: `countText`, `encodeText`, `decodeTokens`, `countMessages`
- Produces: `TokenizerDecision.warning` when a remote/model tokenizer falls back

- [ ] **Step 1: Write registry and numeric-ID tests**

Assert exact IDs for NONE, GPT2, OPENAI, LLAMA, NERD, NERD2, API_CURRENT, MISTRAL, YI, API_TEXTGENERATIONWEBUI, API_KOBOLD, CLAUDE, LLAMA3, GEMMA, JAMBA, QWEN2, COMMAND_R, NEMO, DEEPSEEK, COMMAND_A, and BEST_MATCH.

- [ ] **Step 2: Add parity fixtures generated from the read-only ST oracle**

For English, Chinese, emoji, roleplay markup, leading spaces, and newline-heavy prompts, record tokenizer ID, input, encoded IDs, decoded text, and count. The fixture-generation command may invoke ST during development, but committed TavernNext tests must read static JSON and run without ST.

- [ ] **Step 3: Run tokenizer tests and confirm missing adapters**

Run: `npm test -- packages/tokenizer-engine/test`
Expected: FAIL with missing registry and adapters.

- [ ] **Step 4: Implement local adapters and model caching**

Run:

```powershell
npm install -w @tavernnext/tokenizer-engine tiktoken @agnai/sentencepiece-js @agnai/web-tokenizers
```

Use `tiktoken`, `@agnai/sentencepiece-js`, and `@agnai/web-tokenizers`. Cache models under `<dataDir>/tokenizers`; download to a temporary filename, verify configured SHA-256, then atomically rename. Web tokenizer families Command R/A, Qwen2, Nemo, and DeepSeek fall back to Llama 3 when their model cannot load, matching the baseline behavior. NONE returns `ceil(utf8ByteLength / 3.35)` and cannot encode IDs.

- [ ] **Step 5: Implement Best Match and remote fallback behavior**

Match model IDs for Llama 3, Mistral/Mixtral, Gemma, Nemo/Pixtral, DeepSeek, Yi, Jamba, Command R/A, and Qwen2 before generic Llama. API_CURRENT, API_TEXTGENERATIONWEBUI, and API_KOBOLD call only an explicitly configured tokenizer endpoint; on unavailable/invalid responses they emit a warning and use the same local fallback as the baseline.

- [ ] **Step 6: Verify tokenizer parity**

Run: `npm test -- packages/tokenizer-engine/test && npm run typecheck`
Expected: every local parity fixture has identical IDs and counts; fallback tests report the expected warning and fallback ID.

- [ ] **Step 7: Commit tokenizer compatibility**

```powershell
git add packages/tokenizer-engine tests/fixtures/tokenizers
git commit -m "feat: add SillyTavern-compatible tokenizers"
```

### Task 7: Build lossless import inspection and artifact storage

**Files:**
- Create: `packages/st-compat/package.json`
- Create: `packages/st-compat/src/artifact.ts`, `detect-format.ts`, `warnings.ts`, `index.ts`
- Create: `apps/server/src/services/import-service.ts`, `apps/server/src/routes/imports.ts`
- Modify: `apps/server/src/app.ts`
- Create: `packages/st-compat/test/detect-format.test.ts`, `apps/server/test/import-api.test.ts`

**Interfaces:**
- Produces: `inspectArtifact(input: SourceArtifact): Promise<ImportPreview>`
- Produces: `POST /api/imports/inspect` and `POST /api/imports/commit`
- `ImportPreview` contains detected type/version, normalized preview, blocking errors, warnings, and opaque inspection token

- [ ] **Step 1: Write format-detection and two-stage import tests**

Cover JSON, JSONL, PNG metadata, ZIP-based CharX/BYAF, YAML, invalid JSON, corrupt PNG, corrupt ZIP, and ambiguous JSON. Assert inspection never changes entity tables; commit with a valid inspection token performs one database transaction; invalid or expired token is rejected.

- [ ] **Step 2: Run focused tests and confirm the package is missing**

Run: `npm test -- packages/st-compat/test/detect-format.test.ts apps/server/test/import-api.test.ts`
Expected: FAIL with missing detector and routes.

- [ ] **Step 3: Implement safe artifact inspection**

Run:

```powershell
npm install -w @tavernnext/st-compat fflate yaml png-chunks-extract png-chunks-encode png-chunk-text
npm install -w @tavernnext/server @fastify/multipart @fastify/static
```

Set limits to 64 MiB uploaded bytes, 256 MiB total decompressed bytes, 2,048 archive entries, four archive nesting levels, and 16 MiB per text/JSONL line. Hash the original bytes with SHA-256, store inspection files in `<dataDir>/tmp/imports/<uuid>`, and issue a server-side inspection token that expires after 15 minutes. Reject path traversal and symbolic links in archives. Distinguish blocking errors from compatibility warnings.

- [ ] **Step 4: Implement atomic commit**

On commit, begin SQLite transaction, create normalized rows plus `ImportArtifact`, write assets to a temporary asset directory, commit database state, then atomically move the asset directory. On any failure, roll back rows and remove only the task-specific temporary directory.

- [ ] **Step 5: Verify import infrastructure**

Run: `npm test -- packages/st-compat/test/detect-format.test.ts apps/server/test/import-api.test.ts`
Expected: all format, safety, preview, transaction, and cleanup tests pass.

- [ ] **Step 6: Commit the import pipeline**

```powershell
git add packages/st-compat apps/server/src/services/import-service.ts apps/server/src/routes/imports.ts apps/server/src/app.ts apps/server/test/import-api.test.ts
git commit -m "feat: add lossless two-stage imports"
```

### Task 8: Implement Character Card and Persona compatibility

**Files:**
- Create: `packages/st-compat/src/characters/schemas.ts`, `normalize.ts`, `json-codec.ts`, `png-codec.ts`, `yaml-codec.ts`, `archive-codec.ts`, `export.ts`
- Create: `apps/server/assets/default-card.png`
- Create: `packages/st-compat/test/characters.test.ts`
- Create: `tests/fixtures/characters/` fixture files for V1, V2, V3, dual-metadata PNG, YAML, CharX, BYAF, unknown extensions, embedded Character Book
- Create: `apps/server/src/routes/character-exports.ts`

**Interfaces:**
- Produces: `inspectCharacter(bytes, fileName): Promise<CharacterImportPreview>`
- Produces: `exportCharacter(character, format: 'json-v2' | 'json-v3' | 'png'): Promise<ExportArtifact>`
- Produces: normalized Character fields plus raw top-level fields, `data.extensions`, alternate greetings, creator metadata, and auxiliary assets

- [ ] **Step 1: Write fixture-driven import tests**

Assert V1/V2/V3 normalization for name, description, personality, scenario, first message, examples, system prompt, post-history instructions, alternate greetings, creator notes/tags/version, extensions, and embedded Character Book. For a PNG containing both `chara` and `ccv3`, assert V3 wins while both raw payloads remain recorded.

- [ ] **Step 2: Write round-trip tests before codecs**

For each supported format, import, edit only `description`, export, re-import, then assert the edited field changed and all unknown fields/assets stayed byte- or value-equivalent. Validate exported JSON and PNG by importing them through the baseline ST validator/endpoint in a separate oracle test command.

- [ ] **Step 3: Run the character tests**

Run: `npm test -- packages/st-compat/test/characters.test.ts`
Expected: FAIL because character codecs do not exist.

- [ ] **Step 4: Implement schemas and codecs**

Parse JSON V1/V2/V3 through Zod passthrough objects. Read/write PNG text chunks without recompressing unrelated image chunks. Parse YAML into the same source schemas. Treat CharX/BYAF as bounded archives, resolve their manifest-declared card and assets, and retain unrecognized archive entries as auxiliary assets. Export deterministic JSON with stable field ordering. PNG export uses the imported source PNG when available, otherwise converts the current avatar to PNG, otherwise uses the bundled `default-card.png`.

- [ ] **Step 5: Connect import commit and export routes**

Register Character preview/commit handlers with Task 7 and add `GET /api/characters/:id/export?format=json-v2|json-v3|png`. Persona remains TavernNext-native in MVP with name, avatar, description, default flag, and CRUD; it is included in prompt snapshots but has no ST Persona-file compatibility promise.

- [ ] **Step 6: Verify Character compatibility**

Run: `npm test -- packages/st-compat/test/characters.test.ts apps/server/test/import-api.test.ts && npm run typecheck`
Expected: all formats normalize and round-trip; ST oracle validation passes when the oracle command is enabled.

- [ ] **Step 7: Commit Character compatibility**

```powershell
git add packages/st-compat/src/characters packages/st-compat/test/characters.test.ts tests/fixtures/characters apps/server/src/routes/character-exports.ts
git commit -m "feat: add Character Card compatibility"
```

### Task 9: Implement preset codecs and compatibility preservation

**Files:**
- Create: `packages/st-compat/src/presets/schemas.ts`, `detect.ts`, `normalize.ts`, `export.ts`
- Create: `packages/st-compat/test/presets.test.ts`
- Create: `tests/fixtures/presets/chat/`, `text/`, `context/`, `instruct/`, `system/`, `reasoning/`
- Create: `apps/server/src/routes/preset-exports.ts`

**Interfaces:**
- Produces: `inspectPreset(raw, fileName): PresetImportPreview`
- Produces: `exportPreset(preset): ExportArtifact`
- Normalizes: Chat, Text, Context, Instruct, System Prompt, Reasoning, `.settings`, `.preset`

- [ ] **Step 1: Write preset type-detection tests**

Use current ST default preset files as read-only source fixtures. Assert detection uses structural discriminators rather than filenames: Chat has `prompts` and `prompt_order`; Context has `story_string`; Instruct has input/output/system sequences; Reasoning has reasoning extraction/config fields. Ambiguous files return a warning and explicit candidate list.

- [ ] **Step 2: Write lossless round-trip tests**

Change one executable field, export, and re-import. Assert provider-specific sampler and vendor fields remain in `unknownFields` and return in exported JSON. Unknown fields must never become form defaults that change execution behavior.

- [ ] **Step 3: Implement preset schemas, detection, normalization, and export**

Use passthrough schemas. Preserve `prompts`, `prompt_order`, roles, markers, enabled flags, generation triggers, story string, formatting flags, instruct sequences/suffixes, stop sequences, tokenizer IDs, sampler settings, and provider metadata. Mark unsupported provider settings with warning code `provider_field_preserved_not_executable`.

- [ ] **Step 4: Connect import and export endpoints**

Add `GET /api/presets/:id/export`; commit creates one typed `Preset` row and its `ImportArtifact`. Do not merge imported presets by name.

- [ ] **Step 5: Verify preset codecs**

Run: `npm test -- packages/st-compat/test/presets.test.ts apps/server/test/import-api.test.ts`
Expected: every supported preset family is detected and losslessly exported.

- [ ] **Step 6: Commit preset compatibility**

```powershell
git add packages/st-compat/src/presets packages/st-compat/test/presets.test.ts tests/fixtures/presets apps/server/src/routes/preset-exports.ts
git commit -m "feat: add SillyTavern preset codecs"
```

### Task 10: Compile Chat and Text presets into executable prompts

**Files:**
- Create: `packages/prompt-engine/package.json`
- Create: `packages/prompt-engine/src/types.ts`, `macros.ts`, `budget.ts`, `chat-compiler.ts`, `text-compiler.ts`, `index.ts`
- Create: `packages/prompt-engine/test/macros.test.ts`, `chat-compiler.test.ts`, `text-compiler.test.ts`
- Create: `tests/fixtures/prompts/chat-golden.json`, `text-golden.json`

**Interfaces:**
- Consumes: Character, Persona, Conversation history, Presets, Tokenizer
- Produces: `compileChatPrompt(input): PromptCompilationResult`
- Produces: `compileTextPrompt(input): PromptCompilationResult`
- Produces: ordered `tokenBreakdown` entries with source, included tokens, omitted tokens, and omission reason

- [ ] **Step 1: Write core macro tests**

Cover character name, Persona name, description, personality, scenario, user/character substitutions, escaped braces, and nested values used by ST core prompt fields. Unknown macros remain literal and produce a warning instead of disappearing.

- [ ] **Step 2: Write Chat compiler golden tests**

Assert exact final role messages for prompt ordering, disabled prompts, marker prompts, system/user/assistant roles, character-specific prompt order, example messages, history, post-history instructions, and generation triggers. Compare serialized message arrays to static ST oracle fixtures.

- [ ] **Step 3: Write Text compiler golden tests**

Assert exact strings for story string, Context formatting, Instruct system/input/output sequences, name insertion, example separators, history separators, stop strings, suffixes, and token-budget truncation. The oldest eligible history is removed first; immutable system/character content either fits or returns context overflow before provider invocation.

- [ ] **Step 4: Run prompt-engine tests**

Run: `npm test -- packages/prompt-engine/test`
Expected: FAIL because the compilers do not exist.

- [ ] **Step 5: Implement macro expansion, budget ledger, and both compilers**

The budget ledger must call the selected tokenizer for every included block and record deterministic ordering. Compilers are pure functions: no database, network, global clock, or random calls. Return `{ kind: 'chat', messages, stop }` or `{ kind: 'text', text, stop }` plus itemization and warnings.

- [ ] **Step 6: Verify Chat/Text parity**

Run: `npm test -- packages/prompt-engine/test packages/tokenizer-engine/test && npm run typecheck`
Expected: macro, Chat, Text, token budget, and golden parity tests pass.

- [ ] **Step 7: Commit executable preset compilation**

```powershell
git add packages/prompt-engine tests/fixtures/prompts
git commit -m "feat: compile Chat and Text presets"
```

## Milestone 3 — Complete Worldbook Compatibility

### Task 11: Implement Worldbook and Character Book codecs

**Files:**
- Create: `packages/st-compat/src/worldbooks/schemas.ts`, `normalize.ts`, `native-codec.ts`, `foreign-codecs.ts`, `png-codec.ts`, `export.ts`
- Create: `packages/st-compat/test/worldbooks.test.ts`
- Create: `tests/fixtures/worldbooks/native.json`, `character-book.json`, `novel.json`, `agnai.json`, `risu.json`, `naidata.png`, `all-fields.json`
- Create: `apps/server/src/routes/worldbook-exports.ts`

**Interfaces:**
- Produces: `inspectWorldbook(bytes, fileName): Promise<WorldbookImportPreview>`
- Produces: `exportWorldbook(worldbook): ExportArtifact`
- Produces: normalized entries covering every ST runtime field

- [ ] **Step 1: Write field-mapping tests for every Worldbook runtime field**

Assert primary/secondary keys, regex, selective logic, constant, probability, group, group weight, group override, priority, order, position, depth, role, token budget settings, recursion controls, sticky, cooldown, delay, character filter, Persona filter, UID, display name, enabled state, extensions, and unknown fields.

- [ ] **Step 2: Write foreign-format and round-trip tests**

Normalize native ST JSON, Character Book, Novel, Agnai, Risu, and `naidata` PNG. Export every normalized book as native ST JSON, re-import, and compare the executable normalized form plus retained raw extensions.

- [ ] **Step 3: Implement codecs and warnings**

Map foreign fields only when semantics are known. For lossy foreign concepts, retain the original data and issue a field-specific warning. Preserve original numeric/string UIDs; assign a TavernNext UUID separately. Export entries in deterministic order without reusing array index as UID.

- [ ] **Step 4: Connect Worldbook import/export routes**

Register preview/commit with Task 7 and add `GET /api/worldbooks/:id/export?format=st-native`. Character export from Task 8 must re-embed the currently linked Character Book without dropping its compatibility envelope.

- [ ] **Step 5: Verify codecs**

Run: `npm test -- packages/st-compat/test/worldbooks.test.ts packages/st-compat/test/characters.test.ts`
Expected: all mappings and round trips pass.

- [ ] **Step 6: Commit Worldbook codecs**

```powershell
git add packages/st-compat/src/worldbooks packages/st-compat/test/worldbooks.test.ts tests/fixtures/worldbooks apps/server/src/routes/worldbook-exports.ts
git commit -m "feat: add Worldbook format compatibility"
```

### Task 12: Build the deterministic Worldbook activation engine

**Files:**
- Create: `packages/prompt-engine/src/worldbook/types.ts`, `match.ts`, `groups.ts`, `timed-effects.ts`, `budget.ts`, `evaluate.ts`
- Create: `packages/prompt-engine/test/worldbook/match.test.ts`, `groups.test.ts`, `timed-effects.test.ts`, `evaluate.test.ts`
- Create: `tests/fixtures/worldbooks/runtime-golden.json`

**Interfaces:**
- Produces: `evaluateWorldbooks(input: WorldbookEvaluationInput): WorldbookEvaluationResult`
- Input includes `seed`, `messageIndex`, `previousTimedState`, scan sources, books, and token budget
- Output includes ordered activated entries, updated timed state, token usage, excluded entries with reasons, and warnings

- [ ] **Step 1: Write keyword and logic tests**

Cover literal and regex primary keys; case sensitivity; whole-word matching; secondary AND ANY, AND ALL, NOT ANY, NOT ALL; constant entries; disabled entries; additional scan sources; character and Persona include/exclude filters.

- [ ] **Step 2: Write group, probability, and ordering tests**

Use a seeded RNG to assert probability selection, group weighting, group override, priority, order, and stable UID tie-breaking. Repeating the same seed and input must produce byte-identical results.

- [ ] **Step 3: Write recursion, budget, and timed-effect tests**

Cover recursive scans, recursion exclusion, maximum recursion steps, budget exhaustion, min activations, max depth, sticky duration, cooldown duration, delay, and state progression across message indexes. Ensure an invalid entry is excluded with warning while other entries continue.

- [ ] **Step 4: Run Worldbook runtime tests**

Run: `npm test -- packages/prompt-engine/test/worldbook`
Expected: FAIL because the evaluator is absent.

- [ ] **Step 5: Implement the evaluator as a pure state transition**

Do not read current time or call `Math.random`. Use supplied `seed` and `messageIndex`; scan sources in a locked order; apply filters before random/group selection; apply recursion until stable or capped; then sort and budget entries; return the next timed state. Every exclusion records a machine-readable reason.

- [ ] **Step 6: Verify runtime parity**

Run: `npm test -- packages/prompt-engine/test/worldbook packages/prompt-engine/test/chat-compiler.test.ts packages/prompt-engine/test/text-compiler.test.ts`
Expected: all deterministic and golden cases pass.

- [ ] **Step 7: Commit the Worldbook engine**

```powershell
git add packages/prompt-engine/src/worldbook packages/prompt-engine/test/worldbook tests/fixtures/worldbooks/runtime-golden.json
git commit -m "feat: add deterministic Worldbook runtime"
```

### Task 13: Replace the basic generator with immutable full prompt snapshots

**Files:**
- Create: `apps/server/src/services/prompt-snapshot-service.ts`, `prompt-preview-service.ts`
- Modify: `apps/server/src/services/generation-service.ts`, `apps/server/src/routes/generations.ts`
- Create: `apps/server/src/routes/prompt-preview.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/test/full-generation.test.ts`, `prompt-preview.test.ts`

**Interfaces:**
- Consumes: tokenizer registry, Worldbook evaluator, Chat/Text compilers, provider adapter
- Produces: `POST /api/conversations/:id/prompt-preview`
- Persists: immutable snapshot of all entity IDs/revisions, selected tokenizer, seed, timed state, compiled prompt hash, warnings

- [ ] **Step 1: Write full generation tests**

Create a conversation with Character, Persona, linked and embedded Worldbooks, Chat preset, provider, and history. Assert the provider request exactly equals the prompt preview. Repeat for Text Completion. Edit a preset after preview and assert generation with the prior revision returns 409 rather than mixing versions.

- [ ] **Step 2: Write prompt-preview response tests**

Assert response includes prompt kind, final messages or text, stop strings, token itemization, activated Worldbook entries, excluded entry reasons, tokenizer decision, and compatibility warnings; it must not create messages or mutate timed state.

- [ ] **Step 3: Run focused tests**

Run: `npm test -- apps/server/test/full-generation.test.ts apps/server/test/prompt-preview.test.ts`
Expected: FAIL because the snapshot service and route are missing.

- [ ] **Step 4: Implement snapshot loading and prompt compilation**

Load all referenced aggregates in one read transaction and copy their normalized executable state into `generation_snapshots`. Resolve global, character-linked, character-embedded, and conversation-linked Worldbooks in that order. Commit the next Worldbook timed state only when a normal user turn is accepted; preview, Swipe, and failed generation cannot advance it.

- [ ] **Step 5: Replace `compileBasicChat` and remove it**

Route Chat profiles through `compileChatPrompt` and Text profiles through `compileTextPrompt`. Context overflow must fail before opening the provider connection. Provider usage is recorded separately from local tokenizer estimates.

- [ ] **Step 6: Verify Milestone 3**

Run: `npm test && npm run typecheck && npm run build`
Expected: full suite passes; both Chat and Text generation requests match their prompt previews.

- [ ] **Step 7: Commit full prompt integration**

```powershell
git add apps/server/src/services apps/server/src/routes apps/server/src/app.ts apps/server/test
git commit -m "feat: integrate presets and Worldbooks into generation"
```

## Milestone 4 — Core ST Chat UX and Compatibility Gate

### Task 14: Implement variants, Swipe, Regenerate, Continue, and ST JSONL

**Files:**
- Create: `packages/st-compat/src/chats/jsonl-codec.ts`, `normalize.ts`, `export.ts`
- Create: `packages/st-compat/test/chats.test.ts`
- Create: `tests/fixtures/chats/basic.jsonl`, `swipes.jsonl`, `unknown-extra.jsonl`
- Modify: `apps/server/src/services/generation-service.ts`, `apps/server/src/routes/conversations.ts`
- Create: `apps/server/src/routes/chat-import-export.ts`
- Modify: `apps/web/src/features/chat/MessageList.tsx`, `useGeneration.ts`
- Create: `apps/web/src/features/chat/SwipeControls.tsx`

**Interfaces:**
- Normalizes ST solo-chat header, messages, `swipes`, `swipe_info`, `extra`, model/time/token/reasoning fields
- Generation modes use one `Message` with multiple `MessageVariant` rows
- Exports one ST-compatible JSONL header followed by ordered message lines

- [ ] **Step 1: Write JSONL fixture and round-trip tests**

Assert header metadata, user/assistant roles, multiple swipes, active swipe index, reasoning, timing, token fields, and unknown `extra` survive import/export. Reject malformed first-line metadata and mixed-character group chat with a blocking error.

- [ ] **Step 2: Write generation-mode tests**

Assert Swipe creates a new variant on the last assistant message; Regenerate creates a new variant and selects it; Continue appends to the active variant and records the prior byte boundary; normal sends a new user message. Stop preserves partial variant content for every mode.

- [ ] **Step 3: Implement JSONL codecs and server operations**

Use a streaming line reader with explicit UTF-8 handling and line-size limit. Preserve unknown header/message fields in compatibility envelopes. Export selected variant as message text and all variants through ST `swipes`/`swipe_info` fields.

- [ ] **Step 4: Implement Swipe UI**

Show `current / total`, left/right controls, Regenerate, and Continue only on assistant messages where valid. Switching variants updates persisted active index and never calls the provider. Disable destructive controls during an active generation.

- [ ] **Step 5: Verify chat behavior and round trip**

Run: `npm test -- packages/st-compat/test/chats.test.ts apps/server/test/full-generation.test.ts apps/web/src/features/chat/ChatPage.test.tsx`
Expected: all four generation modes and JSONL round trips pass.

- [ ] **Step 6: Commit core ST chat behavior**

```powershell
git add packages/st-compat/src/chats packages/st-compat/test/chats.test.ts tests/fixtures/chats apps/server apps/web/src/features/chat
git commit -m "feat: add Swipe and ST chat compatibility"
```

### Task 15: Build full manager and import-preview interfaces

**Files:**
- Create: `apps/web/src/features/imports/ImportDialog.tsx`, `ImportPreview.tsx`
- Create: `apps/web/src/features/characters/CharacterLibraryPage.tsx`, `CharacterEditor.tsx`
- Create: `apps/web/src/features/personas/PersonaManagerPage.tsx`
- Create: `apps/web/src/features/presets/PresetManagerPage.tsx`, `PresetEditor.tsx`
- Create: `apps/web/src/features/worldbooks/WorldbookManagerPage.tsx`, `WorldbookEntryEditor.tsx`
- Create: `apps/web/src/features/chat/PromptPreviewDialog.tsx`
- Modify: `apps/web/src/app/router.tsx`
- Create: component tests alongside each feature

**Interfaces:**
- Consumes: CRUD, inspect/commit, export, and prompt-preview APIs
- Produces: six final pages: Characters, Worldbooks, Presets, Personas, Chat, Connection Settings

- [ ] **Step 1: Write import-preview interaction tests**

Drop a valid Character PNG, assert detected V3 preview and warnings, cancel and assert no entity exists, repeat and commit, then export. Drop a corrupt archive and assert Commit remains disabled with blocking-error details.

- [ ] **Step 2: Write editor tests**

Character editor covers all normalized standard fields and alternate greetings. Preset editor shows executable fields and a read-only raw compatibility panel. Worldbook editor covers all runtime fields, validation warnings, enable/disable, ordering, and Character/Persona filters. Persona manager covers create, edit, delete, avatar, default, and switching.

- [ ] **Step 3: Implement shared forms and managers**

Use React Hook Form with domain Zod schemas. Save explicit patches with current revision; on 409, refetch and show a conflict banner without overwriting the local draft. Downloads must use server-provided filename and MIME type.

- [ ] **Step 4: Implement Prompt Preview**

Display final Chat messages or Text prompt, stop strings, tokenizer name/ID, total and per-section Token counts, Worldbook activations, exclusions, timed state, and compatibility warnings. Preview is read-only and must visibly identify estimated/fallback tokenizer decisions.

- [ ] **Step 5: Verify all managers**

Run: `npm test -- apps/web && npm run typecheck && npm run build`
Expected: every page and conflict/import/export interaction test passes.

- [ ] **Step 6: Commit complete MVP management UI**

```powershell
git add apps/web/src
git commit -m "feat: add asset managers and prompt preview"
```

### Task 16: Add secrets, migration recovery, and operational hardening

**Files:**
- Create: `apps/server/src/services/secret-store.ts`, `backup-service.ts`, `log-redaction.ts`
- Modify: `apps/server/src/config.ts`, `db/migrate.ts`, `routes/providers.ts`, `app.ts`
- Create: `apps/server/test/security.test.ts`, `migration-recovery.test.ts`, `import-recovery.test.ts`

**Interfaces:**
- Produces: server-only `SecretStore` with `set`, `get`, `delete`, `has`
- Produces: startup migration result `writable | read_only_migration_failed`
- Guarantees: API responses expose only `hasApiKey`; logs redact secrets and sensitive headers

- [ ] **Step 1: Write security tests**

Submit a recognizable API key and custom sensitive header, exercise success and failure paths, capture logs and HTTP responses, and assert the secret never appears. Assert provider GET/list returns `hasApiKey: true` without the key. Assert listening host defaults to `127.0.0.1`.

- [ ] **Step 2: Write migration and import recovery tests**

Before migration, assert the database is copied to timestamped `<dataDir>/backups`. Inject a failing migration and assert the server starts read-only with a visible health warning and rejects writes. Inject asset-move failure during import and assert no entity or orphaned final asset remains.

- [ ] **Step 3: Implement the secret store and redaction**

Store secrets outside SQLite at `<dataDir>/secrets.json` with owner-only permissions where supported and atomic temp-file replacement. Provider rows store only `secretRef`. Redact authorization, API-key, configured custom secret headers, request bodies containing keys, and provider error payloads before logging.

- [ ] **Step 4: Implement backup and migration recovery**

Close or checkpoint WAL before backup; include database, WAL, and schema version metadata. A failed migration cannot reopen write mode. Retain the five newest automatic backups while never deleting the newest successful pre-migration backup.

- [ ] **Step 5: Verify hardening**

Run: `npm test -- apps/server/test/security.test.ts apps/server/test/migration-recovery.test.ts apps/server/test/import-recovery.test.ts`
Expected: all redaction, localhost, backup, read-only, and atomic cleanup tests pass.

- [ ] **Step 6: Commit operational hardening**

```powershell
git add apps/server/src apps/server/test/security.test.ts apps/server/test/migration-recovery.test.ts apps/server/test/import-recovery.test.ts
git commit -m "feat: harden local data and recovery"
```

### Task 17: Run the SillyTavern compatibility and end-to-end release gate

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/first-run-chat.spec.ts`, `imports-and-exports.spec.ts`, `restart-recovery.spec.ts`
- Create: `scripts/verify-st-oracle.mjs`, `scripts/smoke-local.mjs`
- Create: `docs/compatibility.md`, `docs/development.md`, `README.md`
- Modify: root `package.json`

**Interfaces:**
- Produces: `npm run verify:compat`, `npm run test:e2e`, `npm run verify`
- `npm run verify` executes typecheck, unit/integration tests, production build, compatibility gate, and Playwright

- [ ] **Step 1: Write first-run and restart Playwright scenarios**

Automate connection configuration, Character/Persona creation, Character/Preset/Worldbook import, Chat generation, Stop, Swipe, Regenerate, Continue, edit/delete, Prompt Preview, application restart, and restored active variant. Use only the local mock provider.

- [ ] **Step 2: Write export/re-import E2E scenarios**

Export edited Character PNG/JSON, Worldbook JSON, Preset JSON, and chat JSONL; re-import each into a fresh TavernNext data directory and compare normalized state. `verify-st-oracle.mjs` additionally submits outputs to the read-only baseline ST import paths when `SILLYTAVERN_ORACLE_DIR` is set.

- [ ] **Step 3: Implement the compatibility report**

`docs/compatibility.md` must list every supported input/output format, executable preset mode, tokenizer ID, Worldbook behavior, preserved-but-not-executable field class, and explicit MVP exclusion. The verification script prints fixture counts and fails on any missing required family.

- [ ] **Step 4: Document exact local startup and data handling**

`README.md` contains Node 22 prerequisite, `npm install`, `npm run dev`, localhost URL, data-directory override, backup location, API-key storage behavior, and test commands. `docs/development.md` describes package boundaries and the rule that ST remains an oracle rather than a dependency.

- [ ] **Step 5: Run the complete release gate**

Run: `$env:SILLYTAVERN_ORACLE_DIR='D:\CodeX\SillyTavern'; npm run verify`
Expected: typecheck, all unit/integration tests, both builds, all required compatibility fixtures, ST re-import validation, and Playwright scenarios pass with exit code 0.

- [ ] **Step 6: Inspect logs for secrets and unexpected external calls**

Run: `npm run smoke:local`
Expected: server binds only `127.0.0.1`; no telemetry request occurs; captured logs contain no configured API key; only configured provider and tokenizer-model hosts are contacted.

- [ ] **Step 7: Commit the verified MVP gate**

```powershell
git add playwright.config.ts tests/e2e scripts docs README.md package.json package-lock.json
git commit -m "test: add TavernNext MVP release gate"
```

## Final Acceptance Checklist

- [ ] Known SillyTavern Character, Worldbook, Preset, tokenizer, and solo-chat fields are mapped; unknown fields are retained.
- [ ] TavernNext exports re-import successfully into the SillyTavern 1.18.0 oracle.
- [ ] Golden scenarios produce identical tokenizer counts, Worldbook activations, Chat messages, Text prompts, stop strings, and truncation boundaries.
- [ ] Chat and Text modes both stream, abort, regenerate, swipe, and continue without corrupting conversation state.
- [ ] Import and schema failures leave recoverable database/assets and never create partial committed entities.
- [ ] Default bind is localhost, telemetry is absent, and API keys are absent from database, logs, and API responses.
- [ ] `npm run verify` succeeds from a clean checkout after `npm install`.
