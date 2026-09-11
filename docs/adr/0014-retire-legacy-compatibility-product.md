# Retire the legacy compatibility product

TavernNext now exposes only the Scene/Save product. We retire the generic legacy chat, schema-v9 recovery utility, asset-library import/export and editing APIs, non-Chat Preset management, TavernHelper script execution, trust/RPC bridges, and interactive legacy message HTML so a second application no longer needs to be maintained beside Scene workspaces. This supersedes the executable compatibility surfaces in ADR 0001 and ADR 0002 and the recovery/hidden-route exception in ADR 0012.

Existing database records are not purged or converted into Saves by this retirement. Historical schemas and migration code remain readable, but scene-less Conversations are excluded from active Save APIs. Retired routes remain unavailable in tests and when the former opt-in environment flag is set; tests seed current Scene/Save records without re-enabling old APIs.

Official Scene loading, current Chat Preset editing, Save Worldbooks, server-side prompt regex projection, tokenizers, and their shared data parsers remain supported. Historical script and non-Chat metadata may be preserved by those parsers and migrations without supplying any execution or management surface. Full database backup/restore remains the recovery boundary; the old schema-v9 graph-copy utility is removed.
