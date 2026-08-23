# TavernNext MVP compatibility

This document describes the executable compatibility surface. Imports are inspected before commit, known fields are normalized, and unknown source fields stay in server-side compatibility envelopes for re-export. Compatibility retention does not make an unknown field executable.

## Input and output formats

| Family | Accepted input | Output |
| --- | --- | --- |
| Character | Character Card V1, V2, and V3 JSON; legacy and card-shaped YAML; PNG `chara` and `ccv3` metadata (V3 wins when both exist); CharX ZIP; BYAF archive | Character Card V2 JSON, V3 JSON, and PNG containing both V2/V3 metadata. The manager exposes V3 JSON; the HTTP export also supports V2 and PNG. |
| Persona | TavernNext Persona create/edit with optional PNG/JPEG/WebP/GIF avatar | TavernNext database/API view. No SillyTavern Persona file import/export in the MVP. |
| Preset | Structurally detected Chat, Text, Context, Instruct, System Prompt, and Reasoning JSON/settings/preset documents | JSON in the imported preset's family/shape, with recognized edits merged into retained source data. A newly created preset without source compatibility metadata is not exportable as an ST file. |
| Worldbook | Native SillyTavern World Info JSON, embedded Character Book JSON, NovelAI lorebook JSON, Agnai memory JSON, Risu lorebook JSON, and `naidata` PNG metadata | Native SillyTavern World Info JSON in deterministic source order. |
| Chat | SillyTavern solo-chat JSONL/NDJSON header plus ordered message records, including `swipes`, `swipe_info`, timing, token, model, reasoning, `extra`, system/narrator, and `/sendas`-shaped records | SillyTavern solo-chat JSONL with one header and ordered message lines/variants. Explicit group-chat metadata is rejected. |

Import/schema failures remain at the inspection or transaction boundary: a blocked inspection has no commit token, and a failed commit rolls back database rows and task-owned staged/published assets.

## Executable preset modes

- Chat mode executes one `chat` preset through the OpenAI-compatible `/chat/completions` stream. Prompt definitions/order, roles, marker prompts, enabled flags, injection position/depth/order, generation triggers, Character overrides, sampler settings, stop strings, and token budget participate where defined.
- Text mode executes one `text` preset through `/completions` together with a required `context`, `instruct`, and `system` selection in the MVP UI. Story/context formatting, instruct input/output/system sequences and suffixes, name insertion, separators, stop strings, sampler settings, and truncation participate.
- `reasoning` presets are detected, editable, preserved, and exportable, but there is no separate Conversation reasoning-preset slot in the MVP; they are not independently executed.

Chat and Text provider modes stream and support abort, regenerate, swipe, and continue. Prompt Preview compiles the selected mode without creating messages or committing Worldbook timed state.

## Tokenizer IDs

The numeric IDs match the SillyTavern 1.18.0 registry.

| ID | Key | Implementation |
| ---: | --- | --- |
| 0 | `NONE` | Estimated count |
| 1 | `GPT2` | tiktoken |
| 2 | `OPENAI` | Model-selected tiktoken |
| 3 | `LLAMA` | Bundled SentencePiece |
| 4 | `NERD` | Bundled SentencePiece |
| 5 | `NERD2` | Bundled SentencePiece |
| 6 | `API_CURRENT` | Configured remote tokenizer contract |
| 7 | `MISTRAL` | Bundled SentencePiece |
| 8 | `YI` | Bundled SentencePiece |
| 9 | `API_TEXTGENERATIONWEBUI` | Text-generation remote tokenizer contract |
| 10 | `API_KOBOLD` | Kobold remote tokenizer contract |
| 11 | `CLAUDE` | Bundled web tokenizer |
| 12 | `LLAMA3` | Bundled web tokenizer |
| 13 | `GEMMA` | Bundled SentencePiece |
| 14 | `JAMBA` | Bundled SentencePiece |
| 15 | `QWEN2` | Cached model download with Llama 3 fallback |
| 16 | `COMMAND_R` | Cached model download with Llama 3 fallback |
| 17 | `NEMO` | Cached model download with Llama 3 fallback |
| 18 | `DEEPSEEK` | Cached model download with Llama 3 fallback |
| 19 | `COMMAND_A` | Cached model download with Llama 3 fallback |
| 99 | `BEST_MATCH` | Deterministic selector from API/model metadata |

Remote/model tokenizer hosts are contacted only when the selected tokenizer contract requires them. Downloaded models are hash-checked and stored under the configured data directory; a declared fallback is surfaced in the tokenizer decision.

## Worldbook behavior

The executable Worldbook engine supports global and Character-linked books; enabled state; scan depth and token budget; primary/secondary keys; regex and whole-word/case rules; selective logic; constant entries; probability; grouping, weights, scoring, and override; priority/source order; positions before/after Character, author-note top/bottom, at-depth, example-message top/bottom, and named outlets; depth and role; recursion, exclusion/prevention/delay; ignore-budget entries; sticky/cooldown/delay timed effects; Character and Persona name/tag filters; dedicated Character/Persona/scenario/creator-note scan sources; generation triggers; and deterministic seeded decisions.

Prompt Preview reports activated and excluded entries, recursion steps, outlet content, exact budget use, warnings, and previous/next timed state. Successful generation commits timed state; preview, failure, and abort do not advance it.

## Preserved but not executable

- Unknown Character top-level/data fields, auxiliary archive assets, unknown extensions, and raw PNG payloads are retained. Only mapped Character fields and the typed depth prompt enter prompt compilation.
- Provider/vendor-specific preset fields without an implemented semantic mapping are retained and warned as `provider_field_preserved_not_executable`; unknown settings do not silently become execution defaults.
- Unknown or lossy foreign-Worldbook fields/extensions and display/editor metadata are retained for export. Vector/embedding execution and arbitrary automation identifiers are not external automation hooks.
- Unknown chat header/message/swipe/variant fields are retained for JSONL re-export but are not provider instructions.

## Explicit MVP exclusions

The MVP excludes group chat, conversation branches/checkpoints, impersonation, attachments/RAG, image generation, TTS, STscript, SillyTavern extensions, cloud sync, an installer, and auto-update. It also does not run SillyTavern itself: the optional 1.18.0 checkout is a read-only release oracle only.

## Attached Extension Resource compatibility

The accepted owner order is primary Preset then Character. Raw messages remain canonical; prompt and display projections are recomputed from Attached Extension Resources, while explicit trusted message APIs remain intentional canonical mutations.

Supported regex behavior includes user-input and AI-output placement, prompt-only and display-only mode, Markdown-only gating, depth, edit/run-on-edit, enablement, macro substitution, captures and named captures, trim strings, replacement substitution, deterministic owner order, worker deadlines, and fail-open traces. Completed display-projected HTML fences may create lazy same-origin message frontends; streaming and raw model fences stay inert.

Supported trusted runtime behavior includes lifecycle events and cleanup, script buttons, pinned static remote entries, parent/document access after a Trust Grant, all six Runtime State scopes, and the following complete Tavern Helper bridge inventory. `npm run verify:compat` checks every method exported by `TAVERN_HELPER_BRIDGED_METHODS` remains named here.

<!-- tavern-helper-methods:start -->
| Surface | Supported methods |
| --- | --- |
| Messages | `getChatMessages`, `setChatMessages`, `createChatMessages`, `deleteChatMessages`, `getLastMessageId`, `getMessageId` |
| Runtime State | `getVariables`, `getAllVariables`, `replaceVariables`, `updateVariablesWith`, `insertVariables`, `deleteVariable` |
| Regex | `getTavernRegexes`, `replaceTavernRegexes` |
| Worldbooks | `getWorldbookNames`, `getWorldbook`, `getLorebookEntries`, `updateLorebookEntriesWith` |
| Macros and prompt injection | `substitudeMacros`, `injectPrompts`, `uninjectPrompts` |
| Generation | `generate`, `generateRaw`, `triggerSlash` |
<!-- tavern-helper-methods:end -->

`triggerSlash` is the accepted `/trigger` surface. The browser compatibility globals additionally support `eventOn`, `eventOnce`, `eventEmit`, `eventEmitAndWait`, `eventRemoveListener`, `eventClearEvent`, `eventClearAll`, `getScriptId`, `getButtonEvent`, `getScriptButtons`, `replaceScriptButtons`, `getTavernHelperVersion`, `getTavernVersion`, the accepted `SillyTavern.getContext` reasoning/settings facade, and the reviewed Zod, Vue, and Lodash helper globals. Repeated prompt hooks reuse the initialized Compatibility Runtime. A script that registers an accepted prompt event is permanently prompt-only for that runtime epoch, so no later Promise, timer, DOM event, or button callback can regain a mutating bridge; an individual hung listener also fails open before the outer generation deadline. Any unlisted Tavern Helper method and every `TavernNext.call` method fail with the stable `not_supported` code. Arbitrary STscript, plugin installation, MacroNest, ToolBindings, a general SillyTavern DOM/settings clone, group chat, attachments/RAG, image generation, TTS, and cloud/plugin synchronization are explicitly not supported.

Interactive message frontends support the accepted `$().load(...)` shape only through a variant-bound server route. The requested URL must exist in a current active owner's approved remote cache under a current Trust Grant; unapproved URLs fail with `runtime_not_authorized`. Adjacent real-card HTML fences such as `</details>```<body>` are normalized only after a display regex has enabled interactive rendering. Large immutable generation snapshots are gzip-compressed inside the repository storage boundary while their external payload, integrity tag, and legacy uncompressed reads remain unchanged.

The target SPreset subset supports RegexBinding through the shared Preset-first projection plus enabled ChatSquash affixes, literal/regex separators, stop strings, the reviewed custom post-script, and the accepted reasoning extraction/DOM facade. Provider, endpoint, model, credentials, samplers, and server token limits cannot be changed by these hooks.

## Trust and remote-code risk

Import never executes Attached Extension Resources. A Trust Grant is bound to the exact executable digest; code, order, enablement, approved remote entry hashes, or executable SPreset configuration changes invalidate it. Runtime State and presentation metadata do not.

The remote entry hash is an audit and reproducibility record, not a network sandbox. Once same-origin trust is granted, code can dynamically load unlisted resources or access parent application state. Ordinary CI therefore contains only original synthetic CC0 fixtures and never downloads third-party bundles. The optional local oracle requires an explicitly configured approved-cache manifest, binds it to hashes of the exact reviewed Character and Preset, verifies every cached file by SHA-256 before and after the run, and performs no live download.
