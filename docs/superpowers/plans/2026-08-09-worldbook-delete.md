# Worldbook Cascade Deletion Implementation Plan

> **For Codex:** Follow this plan with test-driven development and verify each gate before claiming completion.

**Goal:** Make deleting a non-empty Worldbook remove its owned entries atomically while preserving optimistic revision checks and blocking external references.

**Architecture:** Add one bounded repository operation that deletes entries by owner ID. The HTTP route will run entry deletion and the Worldbook delete in a single database transaction, converting unsuccessful repository results into a rollback. Character or Conversation references remain database-enforced conflicts.

**Tech Stack:** TypeScript, Fastify, Drizzle/sql.js, React, Vitest.

---

### Task 1: Reproduce and fix atomic Worldbook deletion

**Files:**
- Modify: `apps/server/test/manager-api.test.ts`
- Modify: `apps/server/src/db/repositories.ts`
- Modify: `apps/server/src/routes/worldbooks.ts`
- Modify: `apps/web/src/features/worldbooks/WorldbookManagerPage.test.tsx`
- Modify: `apps/web/src/features/worldbooks/WorldbookManagerPage.tsx`

1. Add a server regression proving a Worldbook with entries currently returns `409 constraint_conflict` on delete.
2. Add rollback coverage for a forced parent-delete failure and coverage that external Character/Conversation references still return 409 without deleting entries.
3. Add `WorldbookEntryRepository.deleteByWorldbookId(worldbookId)`.
4. Wrap owned-entry deletion and parent deletion in one `database.transaction`; throw on unsuccessful parent delete so the transaction rolls back.
5. Add a UI regression and map external-reference conflicts to a clear user-facing message.
6. Run focused server/web tests, typecheck, and the relevant broader test gate.
7. Commit the fix, fast-forward local `main`, restart the local service, and verify API/web health.
