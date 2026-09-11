# Prompt fixture provenance

`chat-golden.json` is an original synthetic TavernNext fixture.
Its field ordering, example framing, and oldest-history-first truncation expectations
were hand-derived by observing the read-only SillyTavern 1.18.0 checkout. No SillyTavern
source, default preset, character, or asset is copied into this fixture.

Optional tests use `TAVERNNEXT_ST_ORACLE_ROOT` only to inspect the external checkout in
place. Production code never reads that variable or imports oracle runtime modules.
