# Task 13 report: immutable prompt snapshots and generation integration

## Status

Complete. Prompt preview and normal Chat/Text generation now share one
immutable schema-v1 snapshot pipeline. The provider request is read directly
from the validated stored artifact; generation no longer recompiles macros,
presets, Worldbooks, tokenization, or prompt content after snapshot acceptance.
`compileBasicChat` was removed.

## Public interfaces

- `POST /api/conversations/:id/prompt-preview` accepts the conversation
  revision, normal user input, and optional deterministic seed/message index.
  It returns the snapshot ID, prompt kind, exact messages or text, stops,
  ordered token ledger, local total, Worldbook evaluation ledger, final
  tokenizer decision, warnings, deterministic inputs, revision manifest, and
  both snapshot hashes.
- `GenerationService.start(input)` is asynchronous. It accepts either a
  referenced `snapshotId` or atomically creates and accepts an identical
  snapshot for the existing normal-generation API. Validation failures are
  returned before an event stream or provider connection exists.
- `PromptSnapshotService` exposes `createPreview`, `createAndAccept`,
  `acceptExisting`, and `commitTimedState`. `ServerTokenizerRuntime` injects
  Task 6 selection plus async text/message counters without a production
  SillyTavern import or network fallback.
- Domain and storage schema v3 add explicit conversation provider and
  Chat/Text/Context/Instruct/System preset selections, prompt/response limits,
  global Worldbooks, and one revisioned Worldbook runtime-state row per
  conversation. Migrations are additive and backfill existing rows.

## Locked compilation behavior

- Aggregate reads occur in one database transaction and leave it only as deep
  JSON clones. Worldbooks resolve in global, Character-linked,
  Character-embedded, then conversation-linked order. Persisted books are
  stably de-duplicated by row ID; duplicate entry source UIDs remain distinct.
  Entry reads use the indexed `listByWorldbookId` path.
- Chat requires an explicitly selected Chat preset. Text requires explicitly
  selected Text, Context, Instruct, and System companions. Every preset passes
  through Task 9 execution sanitization before Task 10 compilation or provider
  request construction.
- Task 12 evaluates the locked books with the selected Task 6 tokenizer,
  explicit seed/message index, and prior timed state. A bounded retry loop
  restarts the complete evaluation/compile operation if deterministic
  tokenizer fallback changes the final decision.
- The executable request contains the provider model, exact compiled Chat
  messages or Text prompt, exact stops, and only supported temperature and
  response-token parameters. Chat calls `streamChat`; Text calls `streamText`.
  Provider usage events remain separate from the immutable local token ledger.
- The audit copy keeps only executable Character, Persona, provider, sanitized
  preset, Worldbook, and prior-state data. API keys, secret references,
  authorization/header values, and non-executable provider compatibility
  envelopes are absent.

## Snapshot schema and hashes

`PROMPT_SNAPSHOT_SCHEMA_VERSION` is `1`. The persisted payload contains:

- normalized input, kind, seed, and message index;
- exact revisions for the conversation, Character, Persona, provider, selected
  presets, global and linked Worldbooks, every persisted Worldbook entry,
  message/active-variant history, and prior runtime-state row;
- sanitized executable audit copies, prior and next Worldbook state, complete
  activated/excluded/token/warning ledgers, and final tokenizer decision;
- exact compiled messages or text, stops, local tokens, and provider request;
- `compiledRequestHash` and `payloadHash`.

`canonicalJson` recursively sorts object keys, preserves array order, and JSON
serializes the result. `compiledRequestHash` is
`SHA-256(UTF-8(canonicalJson(compiledRequest)))`. `payloadHash` applies the
same definition to the complete payload with only `payloadHash` omitted.
Stored snapshots are parsed with exact allowed-key and nested-shape checks,
then both hashes and the request/prompt projection are recomputed. Unknown
versions, malformed nested ledgers/decisions, mutable-row corruption, and
hash-consistent semantic tampering all fail closed.

## Revision and transaction rules

- Preview loads a coherent aggregate, compiles outside the synchronous
  transaction, then revalidates the complete manifest in a write transaction
  before inserting only the immutable snapshot. It never mutates messages,
  variants, conversation revision, or timed state.
- Auto-snapshot creation, immutable-row insertion, normal user-message
  acceptance, and conversation revision advancement share one durable outer
  transaction. Referenced-snapshot acceptance validates its input, hashes,
  exact schema, and every dependency revision in that transaction before
  accepting the user turn.
- Changed/deleted presets, provider, Character, Persona, Worldbook rows or
  entries, message history/variants, conversation, global-book collection, or
  runtime state return a stale/conflict error with zero provider calls and no
  half-accepted user turn.
- Worldbook timed state is committed only after a provider completion. Failed,
  aborted, protocol-invalid, stale, overflow, tokenizer, and validation paths
  do not advance it. If final state persistence fails, the stream fails and an
  existing assistant variant is marked failed.
- Active-generation reservations are cleaned on every pre-stream exception,
  cancellation, iterator return, and stream completion. An unconsumed iterator
  has a 30-second reservation timeout.

## Strict TDD evidence

- Required stable initial RED, before production edits: the two new integration
  files failed with 11/11 tests because preview/snapshot integration did not
  exist.
- First implementation GREEN boundary: the required files reached 11/11.
- Companion-selection self-review RED: prompt preview reported 2 failures and
  3 passes because missing Text Instruct/System companions were accepted;
  explicit typed selection restored GREEN.
- Stored-payload self-review RED: generation reported 3 failures and 8 passes
  for hash-consistent malformed nested token, Worldbook, and tokenizer
  structures; strict recursive validation restored GREEN.
- Runtime-state self-review RED: generation reported 1 failure and 11 passes
  because malformed persisted state escaped as 500 instead of the typed 422;
  fail-closed mapping restored GREEN.
- Final-tokenizer self-review RED: preview reported 1 failure and 5 passes when
  a repeatedly mutating `BEST_MATCH` decision could escape after the retry
  limit; exhaustive final-decision validation restored GREEN.
- The final required integration corpus is 18/18 tests across exact Chat/Text
  preview/provider identity, all stale aggregate classes, overflow/tokenizer
  failure, snapshot tampering and secret exclusion, preview non-mutation,
  provider failure/abort state semantics, and reservation cleanup.

## Fresh verification

- Required focused gate: 2 files and 18/18 tests passed.
- Repository/migration slice: 13/13 tests passed, including legacy schema
  migration, indexed global/entry reads, runtime state, and snapshot
  immutability.
- Oracle-enabled `npm test` with the read-only SillyTavern checkout: 34/34
  files passed; 631 tests passed and one existing platform-specific test was
  skipped (632 total).
- `npm run typecheck` passed.
- `npx tsc -b --clean` established a source-only tree with zero generated
  workspace files. `npm run build` passed the TypeScript graph and Vite
  transformed 182 modules; TypeScript and web bundle outputs were cleaned back
  to zero.
- `git diff --check` passed. The task ships in commit
  `feat: integrate presets and Worldbooks into generation`.

## Remaining boundaries and self-review

- Task 13 intentionally supports normal turns only. Regenerate, swipe, and
  continue snapshot semantics remain Task 14; manager UI and prompt inspection
  dialogs remain Task 15.
- Task 10 exposes before/after Worldbook compiler slots. Activated entries with
  other normalized placement values currently use the after-character slot and
  emit the stable `worldbook_position_fallback` warning; richer placement-slot
  support belongs in the compiler contract rather than an integration-only
  inference.
- The 30-second unconsumed-iterator cleanup is an in-process reservation guard,
  not durable cross-process job recovery.
- Self-review closed explicit companion selection, nested snapshot validation,
  invalid persisted runtime state, unresolved tokenizer mutation, generated
  artifact cleanup, and forbidden production-oracle/secret/cast hot spots. No
  remaining Critical or Important implementation finding is known at handoff;
  independent parent review is the next SDD checkpoint.

## Fix Round 1

All seven Important and both Minor controller findings were reproduced and
closed without changing the immutable snapshot-v1 public contract.

### Corrected execution contracts

- The prompt-engine boundary now carries structured Worldbook placements for
  positions 0 through 7. Chat and Text preserve before/after Character,
  Author's Note top/bottom, Example Messages top/bottom, at-depth role/depth,
  and named outlet targets. Outlets remain explicitly out of band in
  `worldInfoOutlets`; missing compiler anchors and unknown/malformed placement
  values fail closed as `unsupported_worldbook_placement`.
- Text `BEST_MATCH` now selects with the OpenAI-compatible API plus provider
  model, so `gpt-3.5-turbo-instruct` resolves to the OPENAI tokenizer rather
  than NONE.
- Character `extensions` is typed and persisted. Import, export, schema-v4
  migration, executable audit, and matching all carry
  `extensions.depth_prompt.prompt`; `postHistoryInstructions` is never used as
  a substitute for `matchCharacterDepthPrompt`.
- The shipped Chat page loads providers and presets, requires an explicit
  mode-compatible selection, creates configured conversations, and PATCHes
  unconfigured migrated conversations before generation. Text mode requires
  explicit Text, Context, Instruct, and System presets. No arbitrary first-row
  default is selected.
- Message, variant, and Worldbook-entry repositories now expose stable
  relationship reads ordered by `createdAt, id`. Composite relationship/order
  indexes back those reads, and prompt compilation, revalidation, and the Chat
  message route no longer scan global message or variant collections.
- A successful terminal variant flush and Worldbook timed-state commit now run
  in one durable outer transaction. An injected timed-state fault rolls the
  completed status back before the variant is durably marked failed; provider
  failure and abort continue to leave timed state unchanged.
- The executable audit has its own exact schema version and recursively
  validates Character, Persona, provider, preset containers, normalized
  Worldbooks/entries/filters, history, and prior timed state. Acceptance binds
  audit input and manifest to the root payload, provider mode/model to the
  compiled request, verifies both hashes, revalidates revisions, and
  deterministically recompiles before the user turn is accepted. Unknown,
  malformed, and hash-consistent semantic tampering fails closed.
- Persisted Character, Preset, and Worldbook compatibility warnings are now
  included in preview warnings. All base and relationship list orderings have
  the stable ID tie-break.

### Strict TDD and debugging evidence

- Consolidated pre-production RED: all 8 affected test files failed, with 23
  failed and 65 passing tests (88 total). The failures covered placement
  routing, Text tokenizer identity, typed depth prompt matching, real ChatPage
  configuration, indexed reads/order, atomic terminal rollback, strict audit
  validation, compatibility warnings, and stable ties.
- The implementation reached 88/88 affected tests across 9 files. The final
  count uses 9 files because 8 persistence/security cases were moved intact
  from `full-generation.test.ts` to `generation-persistence.test.ts` after
  systematic isolation showed sql.js asm-heap exhaustion at the sixteenth
  database-heavy context. Both files pass together at 21/21 with no skip and
  no behavioral relaxation.
- Migration self-review raised the schema marker to v4 and added a legacy-row
  regression proving raw Character depth-prompt extensions are backfilled into
  the typed field. Preset discovery was narrowed to the GET-only API required
  by the Chat UI.

### Fresh verification

- Affected gate: 9/9 files, 88/88 tests passed.
- Normal full suite: 33 files passed, 513 tests passed, and 8 gated/existing
  tests skipped (521 total).
- Read-only pinned SillyTavern oracle full suite: 35/35 files passed, 646 tests
  passed, and one existing Windows/platform test skipped (647 total).
- `npm run typecheck` passed.
- From a confirmed source-only tree with zero workspace `dist`/`.tsbuild`
  files, `npm run build` passed the TypeScript graph and Vite transformed 182
  modules. Generated outputs were cleaned back to zero.
- `git diff --check` passed; only Git's existing LF-to-CRLF notices were
  printed. Static self-review found no production global message/variant scan,
  no newly introduced unchecked trust-boundary cast, and no generated output.

Task 13 remains limited to normal turns; regenerate, swipe, and continue keep
their previously documented Task 14 boundary. Fix Round 1 ships as
`fix: preserve generation integration contracts` for independent controller
review.

## Fix Round 2

All six Important findings and the compatibility-warning Minor from the second
controller review were reproduced and closed. Snapshot replay, selector APIs,
Worldbook placement parity, relationship bounds, and Character depth-prompt
storage now have explicit fail-closed contracts.

### Corrected execution contracts

- Prompt snapshots now use schema v2 (with executable-audit v2). Stored v1
  artifacts return the distinct `snapshot_unsupported` error. Acceptance
  recursively validates the stored v2 artifact, both hashes, executable-to-
  manifest identity/order, provider/request identity, and current revisions,
  then sends the persisted compiled request without loading or compiling the
  aggregate. A regression removes the preview-time tokenizer/compiler runtime
  before acceptance and proves byte-equivalent request replay still succeeds.
- Manifest revalidation now binds the exact conversation Character, Persona,
  provider, preset ids/kinds, deduplicated global/Character/conversation
  Worldbook sources, entry ids/order, message/active-variant revisions, and
  timed state. Hash-consistent entry substitution and a self-consistent omitted
  Worldbook relationship were each captured as RED and now fail closed.
- `GET /api/presets` returns only the typed selector DTO `id`, `revision`,
  `name`, and `kind`; raw settings, compatibility envelopes, unknown fields,
  and secret sentinels never cross that route.
- Numeric Worldbook positions 0 through 7 and all supported string aliases are
  mapped exactly. Author's Note top/bottom entries wrap the configured note and
  preserve its IN_PROMPT/IN_CHAT/BEFORE_PROMPT position, role, and depth.
  Example-message top placement follows SillyTavern's repeated-unshift order;
  at-depth roles/depths and named outlets retain their exact contracts.
- Message, variant, and Worldbook-entry relation reads are stable by
  `createdAt, id`, indexed, and bounded with `LIMIT max+1` before parsing or
  allocation (2,048 messages; 4,096 variants; 4,096 entries). Stable relation-
  specific cap errors cover UI loading, compilation, and manifest revalidation.
- Character depth prompts are a dedicated typed field. Imports and schema-v5
  migration validate only `extensions.depth_prompt.prompt`; malformed legacy
  scalar/array extension shapes remain loadable with a local compatibility
  warning, while arbitrary extensions remain compatibility/export data and are
  excluded from executable snapshot audit.
- Preview warnings now include persisted compatibility warnings from the
  conversation, Character, Persona, provider, every selected preset,
  Worldbooks and entries, embedded sources, messages, and variants.

### Strict TDD and debugging evidence

- Consolidated pre-production RED: 88 tests ran, 69 passed and 19 failed. The
  18 intended failures covered every controller finding; one additional
  database-heavy context exposed sql.js WASM heap exhaustion rather than a
  behavior defect.
- The compiler slice first reached 42/44, exposing two exact Text Author's Note
  newline mismatches; the narrow story-only correction reached 44/44.
- Systematic isolation showed the sql.js failure occurred only after the
  eleventh full-generation database context. Moving two terminal-transaction
  cases intact into a companion file kept every assertion and made the combined
  server slice pass 29/29 without skips or relaxed coverage.
- Two self-review adversarial tests were added after initial GREEN: a hash-
  consistent executable Worldbook entry-id substitution and a hash-consistent
  manifest that omitted a current executable Worldbook relationship. Both were
  observed failing before the binding corrections and now return 409.

### Fresh verification

- Compiler/domain focused gate: 44/44 tests passed.
- Server focused gate after the sql.js split: 29/29 tests passed; generation
  persistence independently passes 11/11.
- Repository gate: 15/15 tests passed, including both variant query plans,
  `LIMIT max+1`, stable ties, and pre-parse cap failures.
- Real ChatPage path: 6/6 tests passed, including explicit configuration of a
  migrated conversation.
- Read-only SillyTavern 1.18 differential oracle: 3/3 tests passed.
- Oracle-enabled full suite: 36 files passed; 654 tests passed and one existing
  platform-conditional test was skipped (655 total).
- `npm run typecheck` passed. From a confirmed source-only tree with zero
  generated workspace files, `npm run build` passed the TypeScript graph and
  Vite transformed 182 modules; generated outputs were cleaned back to zero.
- `git diff --check` passed. Final static review found no hidden compile/load in
  existing-snapshot acceptance, no unsafe selector field, no unbounded relation
  read, no arbitrary Character extension in the audit, and no generated output.

Fix Round 2 ships as `fix: harden immutable snapshot replay` for independent
controller review. Task 13 retains its documented normal-turn-only boundary.

## Fix Round 3

All four remaining Important controller findings were reproduced and closed.
Snapshot v2 now has an out-of-band trust anchor, aggregate reads stop before
unbounded parsing/allocation, legacy Character migration is stable across
restarts, and Chat Author's Note placement matches the pinned SillyTavern
1.18.0 execution path.

### Corrected execution contracts

- Schema-v6 migration adds a nullable `integrity_tag` storage column without
  changing snapshot payload schema v2. Existing untagged rows fail closed.
  Every newly persisted snapshot is signed with HMAC-SHA-256 over a canonical
  envelope binding the storage row identity and the entire persisted replay
  artifact, including executable audit, history, tokenizer decision, exact
  messages/text/stops/request, manifest, public hashes, and next timed state.
  The tag is stored outside the mutable JSON payload and verified before any
  payload schema parse or generation side effect.
- The HMAC uses a 256-bit key injected by tests/deployments, supplied as a
  strictly canonical base64 environment value, or generated once in the data
  directory. The local fallback uses exclusive creation, exact-length reads,
  no-follow/file-identity checks, owner-private POSIX modes, and a protected
  current-user-only Windows DACL. The key is never hard-coded, derived from
  snapshot data, stored in SQLite, or included in API/audit data.
- Fully rehashed mutations of Character audit data, history, tokenizer
  decisions, next timed state, and root messages plus compiled request now all
  return `snapshot_invalid` before provider calls, message writes, or runtime-
  state advancement. Untampered accepted snapshots remain self-contained and
  replay without compiler, evaluator, tokenizer, or aggregate loading.
- Global Worldbooks use the composite
  `(is_global, created_at, id)` index and `LIMIT 65`; more than 64 fails before
  payload parsing. Initial preview maps the cap to `aggregate_limit` (422),
  while manifest revalidation maps it to `snapshot_stale` (409).
- Conversation variants are read by a bounded, indexed parent-message scan,
  then bounded per-message `(message_id, created_at, id)` scans sharing one
  4,096-row budget. This avoids SQLite's join-wide temporary sort, stops at
  `max + 1`, preserves stable message/variant tie-breaks, and rejects message
  or variant overflow before parsing. Entry and message revalidation caps also
  map to `snapshot_stale`.
- Character schema-v5 depth-prompt backfill now appends
  `character_depth_prompt_invalid` only when absent. Malformed
  `compatibility.rawPayload.extensions` remains loadable, keeps revision 0,
  receives exactly one warning, and produces byte-identical payloads across
  repeated migrations/startups.
- The selected Chat preset's `authorsNote` definition overrides relative versus
  absolute injection, depth, order, and role while the actual configured note
  replaces preset placeholder content. A relative note beside an absolute
  `main` prompt inherits the main absolute role/depth/order and is spliced into
  the same bucket, matching SillyTavern's before/after squash behavior.

### Strict TDD and debugging evidence

- Consolidated pre-production RED: 45 tests ran, 29 passed and 16 failed. The
  failures covered stable migration, five fully rehashed attack classes,
  secure key reuse, global/variant bounded reads and query plans, overflow
  error mapping, preset Author's Note overrides, and absolute-main placement.
- The first query implementation used one joined variant scan; an executable
  `EXPLAIN QUERY PLAN` regression exposed `USE TEMP B-TREE FOR ORDER BY`.
  Replacing it with the bounded parent/per-message strategy removed the sort
  and kept allocation bounded without relaxing ordering or caps.
- The Author's Note oracle initially omitted upstream in-chat execution at the
  absolute main depth. The read-only harness was corrected to derive the
  configured maximum injection depth from the pinned preset, after which both
  the upstream oracle and local compiler agreed for absolute overrides and
  relative-before-absolute-main cases.
- A full-suite-only RED found the health test sharing the default `.tavernnext`
  directory across workers, causing Windows ACL contention. The test now uses
  a temporary database/data directory and injected test key; the isolated
  production key lifecycle remained green and no production relaxation was
  made.

### Fresh verification

- Consolidated Fix Round 3 gate: 45/45 tests passed.
- Repository/migration gate: 16/16 tests passed, including idempotent malformed
  migration, bounded pre-parse failures, stable ordering, required indexes,
  and query plans with no temporary variant/global sort.
- Snapshot integrity/key gate: 6/6 tests passed, including all five rehashed
  attacks and stable owner-private key reuse.
- Chat compiler plus executable SillyTavern 1.18.0 oracle: 21/21 tests passed.
- Affected server/compiler gate: 64/64 tests passed.
- Oracle-enabled full suite: 666 tests passed and one existing platform-
  conditional test was skipped (667 total).
- `npm run typecheck` passed. From a confirmed source-only tree with zero
  generated workspace files, `npm run build` passed the TypeScript graph and
  Vite transformed 182 modules; generated outputs were cleaned back to zero.
- `git diff --check` passed. Static self-review found no mutable in-row trust
  anchor, replay recompile, unbounded aggregate parse, provider/state side
  effect before integrity verification, secret-bearing key material, or
  generated workspace output.

Fix Round 3 ships as `fix: anchor immutable snapshot replay` for independent
controller review. Task 13 retains its documented normal-turn-only boundary.

## Fix Round 4

The two remaining Important findings are closed. First-run integrity-key
creation now has an atomic no-clobber publication boundary, and normal relative
Chat Author's Note placement now applies the selected preset definition's role
exactly like the hash-pinned SillyTavern 1.18.0 execution path.

### Atomic integrity-key lifecycle

- A creator opens an unpredictable same-directory task temporary with exclusive
  creation, writes exactly 256 random bits, applies POSIX `0600` or the existing
  protected current-user-only Windows DACL, fsyncs and revalidates file identity,
  and only then publishes with `linkSync(temporary, final)`. Hard-link creation
  is the cross-platform no-clobber primitive: an existing final path returns
  `EEXIST` and is never renamed over or replaced.
- Winners and losers validate only the atomically published final path. A loser
  also fsyncs the POSIX parent directory before returning the winner; reopening
  an already published key does the same, closing a publisher-process crash
  between `link(2)` and its own directory fsync. Windows reads use a writable
  handle and `FlushFileBuffers` after the protected DACL is verified.
- Every normal creator removes its own temporary in `finally`. Crash debris is
  named with the creator PID and 128-bit entropy and is reclaimed only after a
  final key is valid and the owning PID is definitely absent (`ESRCH`). This
  prevents a winner from unlinking another live creator while it is still
  writing. PID reuse and ambiguous liveness fail safe by retaining the temp.
- A malformed, symlink/reparse, wrong-owner, wrong-mode, wrong-ACL, replaced, or
  wrong-length final key remains a strict refusal. It is never treated as a
  failed attempt that may be overwritten. Filesystems without atomic hard-link
  publication fail closed rather than falling back to a visible partial copy.
- A real eight-process Windows stress run returned one unique 256-bit key from
  every process, all bytes matched the published file, and the directory ended
  with only `snapshot-integrity.key`.

### Chat Author's Note parity

- The computed selected-preset `authorsNote.role` is now shared by absolute and
  both relative-main insertion branches. The configured extension role remains
  the fallback only when the preset has no role override; preset placeholder
  content is still replaced by the configured note.
- The executable, hash-pinned SillyTavern 1.18.0 oracle now includes relative
  main with an assistant preset role overriding a user extension role and a
  user preset role overriding an assistant extension role, covering both before
  and after main placement. The read-only oracle checkout was not modified.

### Strict TDD and debugging evidence

- Initial RED: 3/3 files failed; 27 tests ran with 5 failed, 21 passed, and one
  POSIX-only test skipped on Windows. The failures were atomic publication,
  crash-before-publish recovery, two local relative-role cases, and the real ST
  differential.
- Self-review found a second concurrency edge: eager orphan cleanup could unlink
  a live creator before it reached publication. Its regression was observed RED
  at 1 failed, 3 passed, and one platform skip, then GREEN at 4 passed and one
  skip after PID-liveness-gated reclamation.

### Fresh verification

- Final integrity-key gate: 4/4 tests passed with one POSIX directory-fsync test
  conditionally skipped on Windows; the existing snapshot HMAC/ACL gate also
  passed 6/6.
- Chat compiler and executable ST oracle: 23/23 tests passed.
- Oracle-enabled full suite: 39/39 files passed; 672 tests passed and two
  platform-conditional tests were skipped (674 total).
- Fresh `npm run typecheck` passed.
- From a confirmed source-only tree with zero generated workspace files,
  `npm run build` passed the TypeScript graph and Vite transformed 182 modules;
  generated outputs were cleaned back to zero.
- `git diff --check` passed. Static review found no check-then-rename overwrite,
  partially visible final key, live-temp reclamation, malformed-key replacement,
  lost preset role override, SillyTavern checkout change, or generated output.

Fix Round 4 ships as `fix: make snapshot key publication atomic` for independent
controller review. Task 13 retains its documented normal-turn-only boundary.

## Fix Round 5

The final Important finding is closed. Validation of an already published
`snapshot-integrity.key` is now strictly non-mutating: unsafe POSIX ownership
or mode and unsafe Windows ownership or DACL state are refused as untrusted
instead of being repaired and accepted.

### Non-mutating published-key validation

- The Windows creation and validation paths are separate. Only
  `hardenUnpublishedWindowsTemporaryKey` runs the owner/DACL-setting script,
  and it is called before the private temporary is linked into the published
  name. `verifyWindowsKeyWithoutMutation` runs a distinct read-only script
  containing only item, owner, and access-rule queries.
- The Windows verifier requires a non-reparse regular file owned by the current
  SID, a protected DACL, and exactly one non-inherited allow ACE: current-SID
  `FullControl` with no inheritance or propagation. A wrong owner, unprotected
  DACL, extra readable principal, deny ACE, inherited rule, or different rights
  fails closed before the key is opened or read.
- POSIX validation no longer calls `fchmodSync`. It requires the named file to
  have the current uid and exact `0600` mode, then rechecks the same uid/mode
  on the no-follow descriptor before reading. Unsafe metadata is left exactly
  as found.
- Atomic hard-link publication, fsync ordering, loser behavior, live-creator
  protection, crash-debris reclamation, and malformed-key refusal are
  unchanged. Newly created unpublished temporaries are still hardened and
  verified before publication.

### Strict TDD and platform evidence

- Windows RED before production edits: 11 tests ran with 2 failed, 5 passed,
  and 4 platform/capability skips. Real NTFS files with an extra Everyone read
  ACE and with `AreAccessRulesProtected = false` were both silently repaired
  and accepted by the old combined script.
- First GREEN: the same file reached 7 passed and 4 skips. Each unsafe Windows
  test records `GetSecurityDescriptorBinaryForm()` before validation, expects
  `Snapshot integrity key is untrusted.`, and asserts the post-refusal binary
  security descriptor is byte-identical. The extra-principal test also proves
  key bytes are unchanged.
- POSIX regressions cover a byte-valid `0644` key and, when the test process can
  change uid, a wrong-owner `0600` key. Both assert rejection plus unchanged
  bytes, uid, and mode. They are platform-skipped on this Windows run.
- A real wrong-owner Windows case dynamically runs when the process token can
  assign another owner. The current standard-user token could not do so, so
  this one case skipped; the production verifier still compares the owner SID
  strictly before any ACL or file mutation.
- Safe existing keys retain identical bytes and security metadata across
  reopen. The original concurrency, crash-before-publication, live temporary,
  malformed key, and parent-directory fsync cases remain intact.

### Fresh verification

- Focused key/HMAC/full-generation/compiler/oracle gate: 9/9 files passed;
  81 tests passed and 4 platform/capability tests skipped (85 total).
- Oracle-enabled full suite: 39/39 files passed; 675 tests passed and 5
  platform/capability tests skipped (680 total).
- Fresh `npm run typecheck` passed.
- `npx tsc -b --clean` plus web-output cleanup established a source-only tree
  with zero generated output files. `npm run build` passed the TypeScript graph
  and Vite transformed 182 modules; generated outputs were cleaned back to
  zero.
- `git diff --check` passed. Static review confirms `readExistingKey` contains
  no chmod, chown, owner setter, DACL setter, or ACL-protection setter, and the
  read-only SillyTavern checkout was not changed.

Fix Round 5 ships as `fix: refuse unsafe published snapshot keys` for final
independent controller review. Task 13 retains its documented normal-turn-only
boundary.
