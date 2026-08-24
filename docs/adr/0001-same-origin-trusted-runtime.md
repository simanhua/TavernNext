# Run trusted compatibility scripts with same-origin access

> Superseded by ADR 0005 for the ordinary Scene product. This remains only as a disabled legacy conversion compatibility boundary.

TavernNext runs code covered by a current Trust Grant in disposable or Conversation-lived same-origin iframes because the accepted artifacts require parent DOM and context access. This deliberately favors compatibility over isolation: the grant dialog and audit record disclose that trusted code can inspect parent state and contact origins beyond the statically hashed entry files.
