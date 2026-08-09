# Task 15 report: asset managers, import preview, and prompt preview

## Status

Complete. TavernNext now exposes the six final role-chat MVP destinations:
Chat, Characters, Personas, Presets, Worldbooks, and Connection. The asset
pages replace quick-create-only flows with revisioned editors, bounded safe
manager DTOs, import/export actions, conflict recovery, and accessible
validation. Chat adds a read-only Prompt Preview without widening Task 13/14's
snapshot, HMAC, provider-secret, compatibility-envelope, or timed-state trust
boundaries.

## Manager routes and DTO boundary

- Character manager routes provide bounded list, sanitized detail, create,
  revisioned patch/delete, explicit nullable Worldbook unlinking, and the
  existing safe export flow. Character DTOs expose normalized editable fields,
  a server-owned avatar URL, and only a bounded compatibility summary.
- Persona manager routes provide bounded list/detail and revisioned CRUD.
  Repository transitions preserve the exactly-one-default invariant whenever
  personas exist, including create, default switching, and delete.
- Preset manager routes provide bounded list/detail and revisioned CRUD for
  every preset family. Detail DTOs contain only validated executable fields;
  provider/foreign fields remain in server persistence and are never returned
  as generic editable JSON. Updates merge recognized fields into the stored
  settings and retain server-owned compatibility markers, including nested
  prompt/order markers, without exposing them to the browser.
- Worldbook manager routes provide bounded list/detail and revisioned book and
  entry CRUD. Entry reads use the indexed Worldbook relationship and its
  existing relationship cap. Atomic reorder requires the complete entry set,
  verifies every revision and ownership relation, and persists deterministic
  distinct ranks even when imported entries originally share an order.
- `PUT /api/characters/:id/avatar` and
  `PUT /api/personas/:id/avatar` accept a single multipart `file` plus the
  expected revision. `GET` returns the validated stored asset. Uploads enforce
  an 8 MiB streaming limit, supported PNG/JPEG/WebP/GIF MIME/extension/magic
  agreement, atomic temporary-file promotion, owner and path containment, and
  cleanup on premature multipart failure. Stored traversal, symlink, cross-owner,
  missing-owner, and stale-revision cases fail without disclosing local paths.
- Manager lists cap at 512 rows. Response DTOs never include compatibility raw
  payloads, unknown values, avatar filesystem paths, provider keys/secret refs,
  inspection storage paths, snapshot HMACs, or complete compiler audits.

## Final pages and form behavior

- The application router and navigation now have six explicit destinations.
  The prior settings destination is labeled Connection, and Chat remains the
  real generation surface.
- Character library supports search, selection, create/edit/delete,
  import/export, linked Worldbook selection and unlinking, avatar preview and
  upload, and all normalized V3 role-card fields. Alternate greetings and tags
  use stable row identities; tag values containing commas survive a no-op edit.
- Persona manager supports create/edit/delete, avatar preview/upload, default
  selection, and immediate query refresh so Chat sees manager changes without a
  page reload.
- Preset manager lists and labels all families. Typed editors expose recognized
  booleans, numbers, strings, and ordered arrays only. Chat prompt controls cover
  identifier/name/role/content/enabled, system prompt, marker, injection
  position/depth/order, override prohibition, and injection/generation trigger
  arrays. A no-op edit preserves each character-specific prompt-order group's
  local sequence and enabled flags; new prompt definitions are appended safely.
- Worldbook manager covers normalized book fields plus every Task 11/12 runtime
  entry field. Keys, secondary keys, Character/Persona filter names and tags,
  and triggers are stable typed arrays rather than comma-delimited text, so
  embedded commas round-trip unchanged. Source UID/ordinal remain read-only and
  compatibility sidecars remain server-owned.
- React Hook Form and UI-local Zod schemas provide accessible `role=alert`
  summaries for top-level and nested validation, including Worldbook numeric
  fields and Preset injection/trigger controls. The resolver was updated to a
  Zod 4-compatible release after systematic isolation showed the prior resolver
  converted invalid form submissions into unhandled promise rejections.
- Every mutation disables duplicate submission while active. A 409 refreshes
  the latest server value into a conflict banner but retains the local draft;
  users explicitly choose whether to reload/discard or review and retry.

## Shared import state machine

1. File selection or keyboard-accessible drop sends one multipart inspect
   request. The dialog displays only projected kind/format, bounded normalized
   summary, counts, warnings, and blocking errors.
2. Inspect never commits or refreshes entity lists. Cancel invalidates the
   dialog generation, clears the local inspection token, and ignores a late
   inspect response; closing cannot resurrect a cancelled token.
3. Commit is enabled only for a nonempty token with no blocking errors. A
   submitting guard prevents double commit. Success clears the token, closes the
   dialog, refreshes the correct manager, and selects the imported entity.
4. Expired/replayed-token and commit failures remain visible and retry-safe; the
   browser never automatically re-inspects or commits. Export uses the server's
   MIME, `Content-Disposition` filename, and body rather than constructing a
   filename from an entity name.

The preview renderer uses an explicit per-kind safe projection. It does not
recursively render arbitrary normalized values, so unknown provider/foreign
fields cannot become a UI data-exfiltration surface.

## Prompt Preview

Configured Chat conversations can open a read-only dialog that calls the Task
13 preview endpoint with the current conversation revision and proposed normal
user draft. The client projects the response before storing it in UI state and
renders:

- prompt kind and exact Chat role/content messages or exact Text prompt;
- exact stop strings using an escaped quoted representation that preserves
  newlines, repeated spaces, and leading/trailing whitespace;
- requested tokenizer, resolved/fallback tokenizer, model, decision, and
  fallback/estimate warnings;
- total token count and ordered per-section ledger;
- activated Worldbook entries plus ordered exclusions and reasons;
- previous and next message index, sticky, and cooldown timed-state values;
- compiler/compatibility warnings and the bounded entity revision manifest.

The browser projection excludes integrity/HMAC values, raw executable/provider
settings, provider secrets, compatibility envelopes, and internal audit fields.
Opening or closing preview never starts generation. Task 13 continues to own
immutable snapshot creation, no-message/no-variant preview behavior, unchanged
conversation revision, and no timed-state advancement.

## Strict TDD and review evidence

- Required initial web RED was captured before production edits: 10 suites were
  collected, 8 failed and 2 passed; 17 tests were collected and the 15 existing
  assertions passed. The failures were the missing router/Prompt Preview
  behavior and six missing manager/import modules.
- Initial manager API RED was 3/3 failures against absent/sanitization routes.
  Initial avatar RED was 7/7 failures because PUT/GET routes were unregistered.
- Shared import regressions observed unsafe generic summary rendering, then an
  inspect-cancel race; focused transitions moved from 1 failed/2 passed to 3/3,
  then 1 failed/3 passed to 4/4.
- Character search, Persona default-on-create, and avatar previews were each
  observed failing before their minimal implementations. Character unlinking
  was RED in both web (1 failed/3 passed) and server (1 failed/2 passed) before
  explicit `null` clear semantics made both slices green.
- Lossless Character/Worldbook array regressions produced 2 failures and 7
  passes across 9 tests before stable typed controls made 9/9 pass.
- Preset group-local order/enabled preservation and recognized executable
  prompt controls produced 3 failures and 3 passes before 6/6 passed. Nested
  invalid prompt-field accessibility was then observed as 1 failure/6 passes
  before 7/7 passed.
- Worldbook tied-order reorder began at 1 failure/2 passes, and Worldbook error
  summaries began at 2 failures/4 passes. Both focused slices passed after the
  atomic canonical-order and accessible-error changes.
- Prompt response projection, requested/fallback tokenizer/timed counters, and
  whitespace-exact stop rendering were separately captured RED and then made
  green; the final Prompt Preview slice passed 3/3.
- Independent final read-only review re-read the stable diff after every
  finding. It signed off with no remaining Critical or Important issue.

## Fresh verification

- Focused web gate: 11/11 files and 45/45 tests passed.
- Server gate: 19/19 files passed; 153 tests passed and 4 existing conditional
  tests skipped (157 collected).
- Controlled normal full suite with one worker: 50 files passed and 2
  capability/oracle-conditional files skipped; 641 tests passed and 14 skipped
  (655 collected).
- Read-only SillyTavern-oracle full suite: 52/52 files passed; 776 tests passed
  and 5 platform/capability tests skipped (781 collected). The oracle checkout
  was not modified or referenced by production code.
- `npm run typecheck` passed.
- `npm run build` passed the TypeScript graph and Vite transformed 248 modules.
  The emitted web bundle was 523.54 kB JavaScript, 11.73 kB CSS, and 0.40 kB
  HTML. Generated TypeScript/Vite files were cleaned back to zero workspace
  files after verification.
- `git diff --check` passed. Static self-review found no production oracle path,
  raw compatibility/provider-secret/inspection-path leak, unbounded manager
  relation scan, internal preset marker exposure, stale conflict overwrite, or
  unresolved Critical/Important finding.

Task 15 ships in commit `feat: add asset managers and prompt preview`.

## Fix Round 1

The final review findings were reproduced and closed with an allowlist-first,
field-level editing boundary:

- Character export now requests the real `json-v3` server format. Character,
  Persona, Preset, Worldbook, and Worldbook Entry saves compute structural
  diffs over explicit editable field allowlists, omit unchanged arrays and
  records, and skip empty PATCH requests. Preset settings additionally send
  only changed executable setting keys.
- Preset and Worldbook Entry editors keep a frozen local baseline after a 409.
  Ordinary Save continues to use that baseline, Retry alone adopts the latest
  server revision for the retained user delta, and Reload replaces both draft
  and baseline so the next ordinary Save succeeds.
- Import commit uses a synchronous ref guard plus a dialog epoch. Same-tick
  double activation issues one request, and late success/error from a cancelled
  or reopened dialog cannot commit UI state.
- Imported Character avatars, including the full image bytes of standalone PNG
  Character Cards, are copied to the same exact entity-bound
  `assets/avatars/characters/<entity-id>/<opaque>.<type>` namespace used by
  uploads. Reads and Character exports reject every other stored path, reject
  linked/junction/reparse components, compare pre-open and descriptor identity,
  and stream the already verified descriptor. Upload and import destinations
  also reject redirected owner directories. Replacement cleanup applies the
  same exact grammar and direct-component checks, so malformed legacy paths
  cannot delete unrelated data-directory files.
- Prompt Preview projects and displays only exact timed-entry
  `entryKey/start/end/protected` values for previous/next sticky and cooldown
  lists. Fingerprints, HMACs, and unknown timed-entry properties stay outside
  the browser DTO.
- Chat Presets expose all prompt-order groups and every ordered identifier and
  enabled flag with stable add/remove/reorder controls. Typed executable JSON
  accepts only a plain record, and whitespace-only optional numeric prompt
  values are omitted rather than coerced to zero. Prompt-order group IDs retain
  their original number/string type, including integer-looking strings.
- Worldbook managers label the finite executable book settings surface
  (`enabled`, `scanDepth`, `tokenBudget`, and `recursiveScanning`, alongside
  normalized identity text) and explicitly state that editable executable
  Worldbook extensions are unavailable in this MVP. Raw extension sidecars
  remain private compatibility data and do not cross the manager boundary.

Fix Round 1 strict TDD evidence:

- Consolidated web RED: 5/5 files failed with 14 failed and 20 passed of 34.
- Prompt timed-state RED: 2/2 files failed with 2 failed and 2 passed of 4.
- Avatar/import RED: 2/2 files failed with 2 failed and 14 passed of 16.
- Focused aggregate GREEN: 10/10 files and 61/61 tests passed.
- Independent review found the replacement-cleanup path was initially looser
  than the read path. Its sentinel regression failed 1 of 12 avatar tests before
  the shared strict owner grammar made the final 18-test avatar/Character gate
  green.
- The final compatibility sweep added standalone PNG avatar, numeric-string
  prompt-order ID, and explicit Worldbook capability-message regressions. All
  three failed alongside 24 passing tests before the same 3-file gate passed
  27/27.
- The first parallel full run passed 652 tests but one unrelated atomic-key
  concurrency test exceeded its 5-second timeout. That exact file immediately
  passed 7/7 in isolation, and the stable single-worker full gate passed 50
  files and 656 tests with 2 files/14 capability tests skipped (670 collected).
- The read-only SillyTavern oracle gate passed with the oracle fixed at
  `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`; its worktree was clean before
  and after the run.
- `npm run typecheck`, the production build, and `git diff --check` passed.
  The build transformed 249 modules; its only warning remains the existing
  advisory single-chunk size warning.
- Independent final review re-read the stable post-fix diff and returned no
  remaining Critical or Important findings.

## Remaining boundaries

- The Vite production build reports its advisory warning because the single
  JavaScript chunk is larger than 500 kB. Route-level code splitting is a later
  performance improvement and does not block correctness.
- Compatibility extensions and unknown provider fields remain inert,
  server-owned sidecars. Managers expose only bounded counts/warnings/source
  provenance until each foreign field has an explicit executable contract.
- Prompt Preview remains deliberately read-only. Generation continues through
  the approved Chat/Task 13 snapshot flow rather than accepting raw preview
  payloads from the browser.

Fix Round 1 ships in commit `fix: address task 15 review findings`.

## Fix Round 2

Round 2 replaced mutable avatar filesystem writes with an owner-bound,
transactional SQLite asset boundary. New upload/import avatars use the exact
logical namespace `assets/avatars/<kind>/<owner-id>/<opaque-id>.<type>` while
their bytes, media type, kind, and owner identity are committed atomically in
`avatar_assets`. Public PNG bytes are metadata-stripped; original Character
Card containers remain available only through private import provenance and
explicit export reconstruction. The existing filesystem namespace is a
read-only compatibility fallback: every component is direct/no-link, the open
descriptor identity matches the verified file, reads are bounded to the
verified `stat()` size, exact-length checked, and image type/extension
revalidated before use.

Additional correctness closures:

- Uploaded, imported, stored-database, and legacy-fallback avatars share the
  production 8 MiB ceiling. Tests inject a smaller boundary to exercise both
  database and import rejection without allocating oversized sql.js blobs.
- Successful Character and Persona deletion atomically removes every exact
  owner asset; stale-revision/conflicting deletion preserves both owner and
  bytes.
- Preset executable clears use explicit `null` tombstones. Text-preset clears
  remove the complete canonical alias family, while empty settings, same-name,
  and other semantic no-op PATCH requests are rejected without revision
  changes.
- Chat `prompt_order` preserves a genuine empty array, permits removal of the
  final group, and no longer manufactures a default group on ordinary saves.
- The Worldbook compatibility notice explicitly states that preserved
  extensions are inert and are not executed.

Fix Round 2 strict TDD/review evidence:

- Initial consolidated RED: 13 suites ran; 12 failed, with 12 failed and 50
  passed tests. This covered PNG public canonicalization, avatar confinement,
  Preset clears/no-op behavior, empty prompt order, and compatibility wording.
- First reviewer-follow-up RED: 3 files ran with 4 failed and 25 passed of 29;
  the failures reproduced legacy PNG exposure, owner-delete blob leakage, and
  both empty-settings and unchanged-name Preset no-ops. The same 29 tests then
  passed.
- Final descriptor-growth race RED: the avatar suite had 1 failure and 17
  passes; a first-chunk append produced 262144 bytes from a 131072-byte verified
  snapshot. The bounded descriptor and exact-length/type revalidation change
  made the suite pass 18/18.
- Final affected gate: 6/6 files and 70/70 tests passed.
- Final single-worker normal suite: 50 files passed and 2 conditional files
  skipped; 668 tests passed and 14 skipped (682 collected).
- Final read-only SillyTavern oracle suite: 52/52 files passed; 803 tests passed
  and 5 skipped (808 collected). The oracle remained clean at
  `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8` before and after verification.
- `npm run typecheck`, `npm run build`, and `git diff --check` passed. Vite
  transformed 249 modules and emitted 530.41 kB JavaScript, 11.75 kB CSS, and
  0.40 kB HTML; all generated build files were cleaned afterward. The only
  build warning is the existing advisory chunk-size warning.
- Independent final read-only review confirmed every Round 2 and follow-up
  finding closed and returned no remaining Critical or Important findings.

Fix Round 2 ships in commit `fix: close task 15 second review`.

## Fix Round 3

Round 3 removes the ambiguity between a valid nullable Preset value and an
executable-setting deletion. The browser now sends changed setting values and
an independent, schema-bounded `deleteSettingKeys` list. The server canonicalizes
Text-preset aliases before collision checks, so alias-equivalent edits and
deletions cannot bypass one another. A legitimate `json_schema: null` remains
data, while missing, repeated-null, and other semantic no-ops are rejected
without a revision bump.

Legacy filesystem avatars now reject files whose pre-open or opened-descriptor
link count is not exactly one. This closes hard-link owner aliasing while
retaining the prior direct-component, no-reparse, descriptor-identity, bounded
read, and exact owner-path checks. The capability-sensitive regression creates
a real hard link when the platform permits it and otherwise skips explicitly.

PNG avatars now pass a complete bounded structural and decoded-pixel
validation before they can become public upload/import bytes or be served from
database/legacy storage. Validation covers chunk order and CRCs, IHDR color and
bit-depth combinations, palette requirements, complete zlib decoding, filter
bytes, Adam7/non-interlaced scanline reconstruction, indexed palette bounds,
and an exact terminal IEND. Compressed/decoded size, dimensions, pixels, and
scanline counts are capped before expensive row processing. Public PNG copies
remain metadata-stripped, while private Character Card provenance retains the
original container for compatible export.

Fix Round 3 strict TDD and review evidence:

- Consolidated pre-production RED was recorded across four focused files: 8
  expected failures, 18 passes, and 27 skips. It covered nullable Preset data,
  explicit deletion, hard-link fallback confinement, missing-IDAT/oversized
  PNGs, malformed database reads, and standalone Character Card import.
- The reviewer-follow-up RED ran 2 focused files with 2 failures and 22 skips:
  `temp` versus `temperature` bypassed the edit/delete collision, and a
  tall-skinny compressed PNG bypassed bounded row-work expectations. After
  canonical alias-family checks and pre-inflate dimension/pixel/scanline caps,
  the same gate passed both tests.
- Final affected verification passed 4/4 files and 49/49 tests.
- Final stable single-worker normal suite passed 50 files with 2 conditional
  files skipped. Vitest collection listed 674 runnable test cases.
- Final read-only SillyTavern oracle suite passed 52/52 files, with 808 tests
  passed and 5 skipped (813 collected). The oracle remained clean at
  `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8` before and after verification.
- `npm run typecheck`, `npm run build`, and `git diff --check` passed. Vite
  transformed 249 modules and emitted 530.52 kB JavaScript, 11.75 kB CSS, and
  0.40 kB HTML. Its only warning is the existing advisory chunk-size warning;
  all 14 ignored build-output directories were explicitly dry-run checked and
  then removed.
- Independent final review first found the alias-family collision and
  tall-skinny PNG work-amplification cases. After their RED/GREEN closure, its
  stable re-review returned 0 Critical and 0 Important findings.

Fix Round 3 ships in commit `fix: close task 15 third review`.
