# Keep generation selection global

> Superseded in part by ADR 0007. Provider/model selection stays global; the global Chat Preset is only a template for new Save Agent Configurations.

Provider and Preset selection live in one Global Generation Configuration rather than Conversation identity because Presets are mutable writing rules, not part of who is speaking. Conversations retain Character, Persona, Worldbooks, chat budgets, messages, variants, and Runtime State while every generation snapshots the current global selection.
