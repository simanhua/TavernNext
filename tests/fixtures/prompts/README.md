# Prompt fixture provenance

`chat-golden.json` and `text-golden.json` are original synthetic TavernNext fixtures.
Their field ordering, example framing, Text Context/Instruct concatenation, stop ordering,
and oldest-history-first truncation expectations were hand-derived by observing the
read-only SillyTavern 1.18.0 checkout. No SillyTavern source, default preset, character,
or asset is copied into these fixtures.

Optional tests use `TAVERNNEXT_ST_ORACLE_ROOT` only to inspect the external checkout in
place. Production code never reads that variable or imports oracle runtime modules.
