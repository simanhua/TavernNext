# Synthetic Worldbook fixture provenance

Every fixture in this directory was authored for TavernNext tests. No SillyTavern
Worldbook, lorebook, character, or image asset is copied here.

The field names and conversion expectations were derived by reading the checked-out,
read-only SillyTavern compatibility oracle at `D:\CodeX\SillyTavern`:

- package version: `1.18.0`
- git commit: `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`
- native runtime/default fields and foreign converters:
  `public/scripts/world-info.js`
- Character Book export envelope: `src/endpoints/characters.js`
- Character Book type declaration: `src/types/spec-v2.d.ts`

`naidata.png` is generated from the synthetic `native.json` payload and an original
one-pixel test PNG. Its `naidata` `tEXt` chunk contains base64-encoded UTF-8 JSON,
matching the oracle's PNG import convention.
