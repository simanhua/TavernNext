# Worldbook Delete Design

## Problem

`DELETE /api/worldbooks/:id` currently removes only the Worldbook row. A non-empty Worldbook still has `worldbook_entries` rows referencing it, so SQLite rejects the deletion with `constraint_conflict`.

## Approved behavior

- Deleting a Worldbook deletes all of its entries and the Worldbook in one outer database transaction.
- The request still requires the current Worldbook revision.
- If deletion of any entry or the Worldbook fails, the transaction rolls back and preserves every entry and the Worldbook.
- References outside the owned entry collection, such as Character or Conversation links, continue to block deletion with HTTP 409 `constraint_conflict`.
- The browser keeps the confirmation dialog and shows a clear linked-resource message for a genuine external-reference conflict.

## Implementation boundary

Add an exact `deleteByWorldbookId(worldbookId)` repository operation for entries. The Worldbook route calls it and the existing revisioned Worldbook delete inside `database.transaction`. No schema migration or UI-side sequential deletion is used.

## Verification

- A non-empty Worldbook is deleted with all entries.
- A forced Worldbook-row delete failure rolls back the entry deletion.
- An externally referenced Worldbook remains intact and returns 409.
- Existing Worldbook manager and import/export tests remain green.
