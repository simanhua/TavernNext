# TavernNext synthetic chat fixtures

These JSONL files are original TavernNext test data. Their field shapes were
derived from the read-only SillyTavern 1.18.0 `ChatHeader`, `ChatMessage`, and
`SwipeInfo` declarations plus the solo-chat save path. No SillyTavern chat,
runtime source, user content, or third-party asset is copied into these files.

- `basic.jsonl` covers a header plus one user and one assistant message.
- `swipes.jsonl` covers aligned `swipes`, `swipe_id`, and `swipe_info` data.
- `unknown-extra.jsonl` carries synthetic future fields at every envelope.
