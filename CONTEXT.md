# TavernNext

TavernNext is a local-first roleplay workspace that preserves SillyTavern artifacts while executing only an explicit, auditable compatibility subset.

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
