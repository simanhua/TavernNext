# Synthetic preset compatibility fixtures

Every document in this directory is original TavernNext test data. No
SillyTavern preset, settings file, source text, or runtime module was copied
into this repository.

The field families were independently observed from the read-only
SillyTavern 1.18.0 default preset files under
`D:\CodeX\SillyTavern\default\content\presets`. These fixtures deliberately
use distinct names and prose, while covering the structural shapes used by
Chat, Text, Context, Instruct, System Prompt, Reasoning, `.settings`, and
`.preset` imports.

`attached-release.settings` is original release-gate data for nine inert
RegexBinding probes, deterministic ChatSquash/post-processing, reasoning, and
an offline SPreset runtime marker. It and its embedded code are licensed under
CC0-1.0 as described by `tests/fixtures/LICENSE.md`; it contains no copied or
remote code.
