# TavernNext

TavernNext is a local-first runtime for official, installable roleplay Scenes. A user manages role cards as Scene Packages, creates isolated Saves, and plays each Scene through its own workspace and functional modules.

## Language

**Attached Extension Resource**:
A normalized regex definition or Tavern Helper script tree owned by one Character or the globally selected primary Preset.
_Avoid_: Plugin, extension library, global script

**Compatibility Runtime**:
The bounded execution environment that projects regexes, runs trusted scripts and prompt hooks, and supplies the accepted compatibility APIs.
_Avoid_: SillyTavern clone, plugin host, sandbox

**Runtime State**:
Persisted compatibility data scoped independently to global, Character, Preset, Conversation, message variant, or script ownership.
_Avoid_: Variables blob, chat metadata

**Trust Grant**:
The user's approval of one exact executable bundle digest, including enabled code, order, approved remote hashes, and executable SPreset configuration.
_Avoid_: Install, permission toggle, permanent approval

**Global Generation Configuration**:
The single revisioned selection of Provider and primary/companion Presets shared by all Conversations.
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

**Scene State**:
Revisioned structured game data belonging to one Save and validated before transactional writes.
_Avoid_: Shared Character variables, chat metadata

**Generation Recipe**:
The Scene-owned prompt and output protocol used before the singleton global fallback Preset.
_Avoid_: User-composed Conversation preset
