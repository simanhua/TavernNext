# Third-party notices

## SillyTavern tokenizer assets

This package redistributes the exact tokenizer-model blobs listed below from the SillyTavern source distribution.

- Source repository: https://github.com/SillyTavern/SillyTavern
- Source version: `1.18.0`
- Source commit: `51ad27fb86d39a3daca3adaa970375c9670c12df`
- Declared source-package license: `AGPL-3.0`
- Upstream license: https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/LICENSE
- Included license text: `LICENSES/AGPL-3.0.txt`
- Modifications: none; the files are byte-identical to the referenced source revision.
- Copyright notice: no asset-specific copyright notice is supplied in the referenced source revision; consult the upstream repository history for contributors.

| Bundled file | Upstream source path | SHA-256 |
| --- | --- | --- |
| `models/claude.json` | [`src/tokenizers/claude.json`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/claude.json) | `c241737df24b4e7f7c9af4fdcee29a0ca903dcb288a8b753bc346a3092911767` |
| `models/gemma.model` | [`src/tokenizers/gemma.model`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/gemma.model) | `61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2` |
| `models/jamba.model` | [`src/tokenizers/jamba.model`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/jamba.model) | `8b0df4fb43262c452ef37061951a06df4c63ca191d02a60ea08f14428af24376` |
| `models/llama.model` | [`src/tokenizers/llama.model`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/llama.model) | `9e556afd44213b6bd1be2b850ebbbd98f5481437a8021afaf58ee7fb1818d347` |
| `models/llama3.json` | [`src/tokenizers/llama3.json`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/llama3.json) | `126f3c57d297e9a5a18427338812d9fed68f132c612b3c42e361ce3157beb729` |
| `models/mistral.model` | [`src/tokenizers/mistral.model`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/mistral.model) | `dadfd56d766715c61d2ef780a525ab43b8e6da4de6865bda3d95fdef5e134055` |
| `models/nerdstash.model` | [`src/tokenizers/nerdstash.model`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/nerdstash.model) | `578fa0ed4d6dbee435f21d7f7a741506d09cdd93cce241008abf725407cbdb41` |
| `models/nerdstash_v2.model` | [`src/tokenizers/nerdstash_v2.model`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/nerdstash_v2.model) | `005ad680b10f1abd406bdb0ca9c6a5d83fc1f6e0a855bdd1942c1ceab1fb47ab` |
| `models/yi.model` | [`src/tokenizers/yi.model`](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/tokenizers/yi.model) | `386c49cf943d71aa110361135338c50e38beeff0a66593480421f37b319e1a39` |

The five model URLs in `src/models.manifest.ts` are not redistributed by this package. They remain manifest-only optional downloads and require a configured trusted SHA-256 before the cache will fetch them; otherwise runtime uses the documented deterministic fallback.
