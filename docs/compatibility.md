# TavernNext data and prompt compatibility

TavernNext exposes the Scene/Save product. Compatibility code reads the source data used by official Scene Packages and historical database migrations; it does not provide a second asset-library application or a script runtime. See [ADR 0014](adr/0014-retire-legacy-compatibility-product.md).

## Current product surfaces

Official Scenes install their bundled Character, Chat Preset, Worldbook, frontend, and state resources. Users create Saves through an installed Scene, edit the Save-owned Agent configuration and Worldbook, and manage Persona templates and the global Provider/default Chat Preset. Agent Runs support ordinary sends, tail regeneration/swipes, cancellation, Scene tools, Action Options, and Save Memory.

Only Chat Presets are exposed for template management. Their prompt definitions/order, markers, roles, enabled flags, sampler settings, stops, dialogue examples, Author's Note placement, Worldbook placement, macros, and history budgets compile into the Save Agent Prompt Plan beneath the platform envelope. Its initial transcript and tool directory are the same material audited in the Generation Snapshot and executed by the Save Agent.

## Retired functionality

The generic legacy chat and schema-v9 recovery utility, direct Conversation creation, standalone Character/Worldbook asset managers, standalone file import/export APIs, non-Chat Preset management, TavernHelper/Trust Grant/RPC execution, SPreset post-scripts, and interactive legacy message HTML are removed. The former legacy-asset environment flag does not restore these routes. Historical scene-less Conversations remain stored but cannot be used through active Save APIs.

Text, Context, Instruct, System, Reasoning, unknown extension payloads, and historical scoped compatibility state may remain as inert source data where parsers or migrations need them. Data preservation does not enable execution, public editing, or export. Whole-database backup/restore remains supported without converting old Conversations into Saves.

## Server-side prompt regexes

Attached regex definitions retain deterministic Preset-then-Character order, user-input/AI-output placement, common and prompt-only projection, depth and enablement checks, macro substitution, captures, trim strings, worker deadlines, and fail-open traces. Display-only rules never produce an interactive message frontend. Browser display regex workers, script globals, remote script caches, trust grants, and script buttons have no execution surface.

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

The executable Worldbook engine evaluates Save-owned Worldbooks and their retained source metadata; enabled state; scan depth and token budget; primary/secondary keys; regex and whole-word/case rules; selective logic; constant entries; probability; grouping, weights, scoring, and override; priority/source order; positions before/after Character, author-note top/bottom, at-depth, example-message top/bottom, and named outlets; depth and role; recursion, exclusion/prevention/delay; ignore-budget entries; sticky/cooldown/delay timed effects; Character and Persona name/tag filters; dedicated Character/Persona/scenario/creator-note scan sources; generation triggers; and deterministic seeded decisions.

Successful Agent Runs commit Worldbook timed state atomically with the response. Failure and abort do not advance it.

## Preserved data and execution limits

Character fields, depth prompts, Chat Preset settings, and Worldbook fields enter the prompt only through their supported mappings. Unknown/vendor-specific values remain source metadata and do not become execution defaults. Scene State is the authoritative gameplay state, and only successful Agent Runs commit its staged changes and Worldbook timed effects.

Official Scene frontend/server modules remain trusted application code. Model-authored JavaScript and HTML are not accepted as executable Scene Views. SillyTavern itself is never started or imported by the product; its optional pinned checkout is a read-only oracle for the retained data, prompt, regex, Worldbook, and tokenizer semantics.
