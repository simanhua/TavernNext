# Preserve schema-v9 Conversations as hidden compatibility records

The compatibility migration in ADR 0004 and ADR 0007 intentionally cleared Conversation-owned runtime graphs because they could not safely become Scene Saves. That remains the default migration behavior, and every newly created roleplay runtime still belongs to exactly one installed Scene.

TavernNext nevertheless permits an explicit, one-time recovery utility to copy internally consistent TavernNext schema-v9 Conversations, Messages, Message Variants, and their Chat Preset snapshot from a pinned pre-migration database into the current database. These scene-less records are **Legacy Conversations**, not Saves. They are excluded from the Scene catalog and normal product navigation, cannot be created through the product UI, and are reachable only through the hidden `/legacy-chat` compatibility route. The recovery utility is dry-run by default, validates referenced library entities, applies all pending records transactionally, and verifies the restored graph.

This exception exists only to preserve a user's TavernNext history after an explicit recovery request. It does not restore obsolete per-Conversation Provider execution semantics, Scene State, snapshots, Agent Runs, or other cleared runtime state, and it does not import SillyTavern JSONL. A Legacy Conversation may use the generic compatibility chat surface and the copied Save Agent Configuration, but it does not acquire Scene identity or Scene capabilities.

This decision narrows the clearing policy in ADR 0004 and ADR 0007 for explicitly recovered schema-v9 history. ADR 0005 remains authoritative for all new roleplay products, Scene trust, and Save isolation.
