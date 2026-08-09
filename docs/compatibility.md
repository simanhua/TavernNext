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
