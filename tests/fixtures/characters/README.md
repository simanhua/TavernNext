# Synthetic Character compatibility fixtures

Every file in this directory is original synthetic test data created for
TavernNext. No character, image, archive, or source text was copied from
SillyTavern or another Character Card implementation.

The field shapes were independently derived against the read-only
SillyTavern 1.18.0 compatibility oracle at:

- `D:\CodeX\SillyTavern\src\types\spec-v2.d.ts`
- `D:\CodeX\SillyTavern\src\validator\TavernCardValidator.js`
- `D:\CodeX\SillyTavern\src\character-card-parser.js`
- `D:\CodeX\SillyTavern\src\types\byaf.d.ts`

Binary PNG, CharX, and BYAF fixtures are assembled during tests from these
JSON documents and tiny synthetic image bytes. This keeps provenance explicit
and lets safety tests construct malformed archives without shipping opaque
third-party assets.

`legacy-st.yaml` is a synthetic probe for the root-level `context` and
`greeting` envelope used by SillyTavern's legacy YAML Character importer.

`attached-release.json` is an original CCv3 release-gate fixture covering a
small InitVar book, display/prompt regex separation, MVU state, one script
button, and `/trigger`. Its source and all embedded code are licensed under
CC0-1.0 as described by `tests/fixtures/LICENSE.md`; it contains no third-party
bundle bytes or live URL.
