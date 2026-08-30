# Give every Scene Save an owned Worldbook mirror

TavernNext copies the Scene backing Worldbook into a Save Worldbook when a Save is created, and Agent Runs, runtime inspection, and editing use that owned copy instead of the installed Scene template. Existing Scene Saves are migrated by copying their current template and materializing persisted entry overrides; later Scene upgrades or edits to another Save cannot change it. The installed Worldbook remains a template for new Saves and explicit reset/synchronization, rather than a shared mutable runtime dependency.

## Consequences

Save deletion also deletes its Worldbook mirror and entries. Global Worldbooks and explicitly attached non-Scene Worldbooks retain their existing shared semantics, while full Save Worldbook edits are only accepted through a route scoped to the owning Save.
