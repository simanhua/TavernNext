# Security boundaries

## Official Scene code

Only TavernNext-bundled official Scenes may expose Agent tools in the first release. Their frontend and server modules are reviewed as fully trusted application code before distribution. Tool schemas and Save-only APIs reduce accidental authority; they do not make untrusted code safe.

Scene server modules run in Worker Threads for timeouts and crash containment. Worker Threads are not a security sandbox and do not prevent filesystem, process, or network access. Do not install or enable arbitrary Scene tool code on the assumption that the Worker isolates it.

## Agent and presentation boundaries

The Agent receives only platform and reviewed Scene tools—never bash, arbitrary filesystem, arbitrary network, or general code execution. State-changing tools stage operations in a Turn Workspace, and persistence occurs only in the successful Agent Run commit. Scene Views are typed, read-only snapshots projected by trusted Scene code; model-generated HTML or JavaScript is not accepted.

Legacy TavernHelper scripts, Trust Grants, RPC bridges, and interactive message HTML are retired. Script payloads retained in historical data are inert; only reviewed official Scene code supplies executable presentation and tools.

## Sensitive data

Provider credentials remain in the server-side Secret Store and are redacted from logs, browser responses, snapshots, Agent Run diagnostics, and debug views. Raw private reasoning produced during an Agent Run is neither rendered nor persisted; its audit records contain only bounded, sanitized lifecycle, activity, usage, revision, and failure data. Historical compatibility payloads remain storage data and are not exposed through a legacy chat or script runtime.

The development Agent Run trace records model/provider identifiers, per-turn request sizes, response usage and stop reasons, tool names, numeric/boolean values, and bounded argument/result shapes. String values are represented only by type, character count, and a per-run salted fingerprint for detecting repeated values; sensitive-looking keys are redacted. Raw messages, reasoning, headers, credentials, and tool text are never stored in the trace.
