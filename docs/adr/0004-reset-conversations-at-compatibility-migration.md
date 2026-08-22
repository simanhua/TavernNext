# Reset Conversation-owned data at the compatibility migration

The compatibility schema transition takes a verified pre-migration backup and then removes all Conversations, messages, variants, snapshots, timed Worldbook state, and Conversation/message Runtime State while preserving library entities and import artifacts. A clean reset was chosen over silently translating obsolete Conversation-specific Provider/Preset bindings and stale executable references.
