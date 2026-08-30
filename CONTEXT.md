# TavernNext

TavernNext is a local-first runtime for official, installable roleplay Scenes. A user manages role cards as Scene Packages, creates isolated Saves, and plays each Scene through its own workspace and functional modules.

## Language

**Attached Extension Resource**:
A normalized regex definition or Tavern Helper script tree owned by one Character or the globally selected primary Preset.
_Avoid_: Plugin, extension library, global script

**Compatibility Runtime**:
The bounded presentation environment that projects Markdown regexes, runs explicitly trusted scripts, and supplies accepted non-prompt compatibility APIs. It never changes an Agent Run prompt or Scene View block.
_Avoid_: SillyTavern clone, plugin host, sandbox

**Runtime State**:
Persisted compatibility data scoped independently to global, Character, Preset, Conversation, message variant, or script ownership.
_Avoid_: Variables blob, chat metadata

**Trust Grant**:
The user's approval of one exact executable bundle digest, including enabled code, order, approved remote hashes, and executable SPreset configuration.
_Avoid_: Install, permission toggle, permanent approval

**Global Generation Configuration**:
The single revisioned selection of the global Provider/model and the default Chat Preset template copied into new Saves.
_Avoid_: Conversation preset, chat provider binding

**Scene Package**:
One official catalog artifact containing a roleplay Scene's manifest, frontend workspace, optional trusted server module, prompt resources, and state contract.
_Avoid_: Character library item, plugin bundle

**Scene Workspace**:
The Scene-owned, trusted top-level application opened in its own browser tab to create a Save or play one current Save through the Scene SDK.
_Avoid_: Generic chat skin, regex-rendered message

**Save**:
One isolated Conversation, player-profile snapshot, setup snapshot, messages, variants, and Scene State belonging to exactly one installed Scene.
_Avoid_: Global chat, Character state

**Save Agent Configuration**:
The revisioned, Save-owned copy of one Chat Preset's executable settings and template lineage used by that Save's Agent Runs.
_Avoid_: Conversation preset binding, global active Preset

**Save Worldbook**:
The fully editable, Save-owned copy of a Scene's Worldbook and its template lineage. It is created with the Save and never shares mutable rules or entries with another Save or the installed Scene.
_Avoid_: Worldbook override, shared Scene Worldbook, Conversation Worldbook

**Save Agent**:
The one persistent roleplay-director identity owned by a Save. Its durable identity consists of the Save Agent Configuration, Save messages, Scene State, and Agent Run audit history; a fresh Pi Agent instance is reconstructed for each run.
_Avoid_: Persisted Pi session, coding agent, background agent

**Agent Run**:
One user-triggered, bounded execution of a Save Agent against immutable input revisions. It may perform multiple model/tool turns and commits completed narrative, state, views, and audit outcome atomically.
_Avoid_: Generation request, autonomous task, Pi session

**Turn Workspace**:
The in-memory staged projection of one Scene State revision used by tools during an Agent Run. Successful operations are visible to later tools in the same run but reach persistent Scene State only at the final atomic commit.
_Avoid_: Temporary Save, mutable database transaction, Agent memory

**Roleplay Document**:
The canonical versioned assistant response made of ordered Markdown and Scene View blocks. Plain text is a derived compatibility/search projection, never a second response source.
_Avoid_: HTML response, message text plus widgets, model-authored UI

**Scene View**:
A typed, read-only block inside a Roleplay Document whose objective props are projected by trusted Scene code from the Turn Workspace and stored as a commit-time snapshot.
_Avoid_: Agent-generated HTML, live state panel, interactive state editor

**Scene State**:
Revisioned structured game data belonging to one Save and validated before transactional writes.
_Avoid_: Shared Character variables, chat metadata

**Save Memory**:
Branch-visible historical evidence derived from completed Agent Runs and owned by one Save. It may support recall but never overrides Scene State, World Rules, or newer messages.
_Avoid_: Agent memory, conversation lore, permanent fact

**Near Memory**:
Recent Save Memory retained at turn-level detail before consolidation.
_Avoid_: Chat history, working context

**Far Memory**:
Consolidated Save Memory that may roll older Far Memory forward while preserving direct or hierarchical provenance to its contributing Near Memories.
_Avoid_: Worldbook entry, character biography

**Memory Index**:
A rebuildable retrieval projection over Save Memory whose loss never damages the Save's authoritative records.
_Avoid_: Memory database, source of truth

**Generation Recipe**:
Legacy Scene metadata retained for package compatibility. Agent Runtime prompt precedence and Save-owned Preset selection are defined by the Save Agent contract, not by a runtime recipe fallback.
_Avoid_: Active Scene prompt override, output parser
