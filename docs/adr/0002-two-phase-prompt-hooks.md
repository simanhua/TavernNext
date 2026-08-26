# Seal generation through two-phase prompt hooks

> Superseded by ADR 0007. Agent Runs do not expose browser prompt hooks or candidate sealing.

The server compiles a short-lived candidate, the browser may transform only messages/text/stop through trusted hooks, and the server revalidates revisions, shape, budget, trust, and hashes before accepting the user turn or calling the Provider. This keeps Provider identity, model, credentials, samplers, and maximum budgets authoritative even though compatibility prompt code runs in the browser.
