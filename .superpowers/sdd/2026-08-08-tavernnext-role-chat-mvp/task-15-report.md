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
