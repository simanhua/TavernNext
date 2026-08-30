# Treat Save Memory as derived, branch-scoped evidence

TavernNext stores long-term roleplay recall as Save-owned evidence derived asynchronously from completed Agent Runs. Scene State remains the authority for current facts, sibling Variant memories are visible only on their active branch, and lexical/vector indexes are disposable projections; this preserves atomic roleplay commits and allows model or index failures to degrade recall without corrupting a Save.

## Consequences

Memory extraction may complete after the response that produced it, and embedding failure falls back to lexical recall. Historical message edits deliberately do not rewrite existing Save Memory in the first version. Recall reads a bounded active candidate set plus direct hits from the external Memory Index, while older Near and Far evidence is rolled forward through a hierarchical provenance chain without discarding its original Near evidence.
