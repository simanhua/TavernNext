# Prefer the Scene Generation Recipe

An installed Scene's Generation Recipe is authoritative for its Saves. If a Scene has no recipe, TavernNext uses the singleton global fallback Preset. Provider, model, credentials, and hard token budgets remain global server-owned configuration.

Every accepted generation snapshots the installed Scene revision, Scene State revision, package digest, and recipe source so a response can be audited against the exact game state that produced it.
