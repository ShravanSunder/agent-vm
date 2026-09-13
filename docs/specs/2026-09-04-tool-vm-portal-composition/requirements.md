# Tool VM Portal composition requirements

[Specification](specification.md) · [Program design](program-design.md)

## Goal

An agent writes ordinary code inside its Tool VM, calls Tool Portal through a
reusable SDK or CLI, and uses returned data to decide what to call next. Tool
Portal continues to select each capability's execution destination. The
composition program itself does not move to the host or credentialed VM.

The primary agent experience is TypeScript composition through Hermes's
foreground `terminal` tool. During managed Gateway startup, Tool Portal prepares
authorized tool definitions for catalog and generated-SDK readiness and offers
an explicit choice between compact discovery and individual MCP tools. Any
complete prepared definitions remain fixed for that Gateway lifetime; a restart
prepares any definition change. When preparation is incomplete, compact mode
retains its existing generic discovery surface without advertising generated
definitions. Generated TypeScript functions make prepared capabilities
convenient to call through the existing SDK; neither exposure mode changes
execution authority.

```text
Agent's job (U1–U3)
  Learn the available interface
        │
        ▼
  Run code in Tool VM ──► discover / describe / call
        ▲                           │
        └──── receive data ◄─────────┘
        │
        ▼
  Filter, branch, repeat, or combine concurrent results

Existing pain: installed SDKs alone do not establish a Tool VM-to-Portal
connection. Hermes's nested-tool helper is a separate, restricted surface.
Desired difference: one usable package interface, not provider wrappers.
```

## Consumers and authorized needs

Authority is the repository owner's explicit PR B instructions in the current
2026-09-04 conversation: reusable SDK, Python/TypeScript/CLI access, automatic
Tool VM setup, instructions for the agent, and design of communication out of
Tool VM. Existing Portal policy and arbitrary direct Tool VM execution are
preserved by the earlier explicit boundary. The priorities below are musts
because each is part of that requested outcome, not an external recommendation.

The owner's 2026-09-13 discussion extends this basis with selectable catalog
exposure, TypeScript-only function generation, complete preparation before
catalog/generated readiness, definition stability for the full Gateway lifetime,
restart-based definition changes, and measured generation/loading performance.
Existing generic Python/TypeScript/CLI clients, compact discovery fallback and
trusted Python infrastructure remain foundations. Python function generation is
excluded.

| ID | Consumer | Need and reason | Authority / priority |
| --- | --- | --- | --- |
| U1 | Agent composing a task | Execute the composition in Tool VM; sequence, branch, loop, and combine Portal results without a model turn for each sub-call. | Owner-authorized / must |
| U2 | SDK and CLI consumers | Use reusable Python and TypeScript packages and the Portal CLI, independent of Hermes and individual MCP providers. Reuse the existing packages rather than create competing APIs. | Owner-authorized / must |
| U3 | Agent entering its execution environment | Find installed interfaces, automatic connection setup, and accurate usage instructions without configuring endpoints or credentials manually. | Owner-authorized / must |
| U4 | Capability owner and approving human | Preserve Portal discovery, argument validation, routing, approval, and result behavior for calls originating in Tool VM. | Owner-authorized preservation / must |
| U5 | Agent and operator | Know whether a call succeeded, failed, needs approval, was cancelled, or has an uncertain effect; do not silently repeat side effects. | Existing Portal behavior preserved / must |
| U6 | Deployment owner | Keep agent/profile isolation and credential ownership intact across the new communication path; do not expose framework/admin authority to guest code. | Existing managed-runtime boundary preserved / must |
| U7 | MCP client operator | Select compact discovery or individual authorized tool schemas at Portal startup, allowing the client to manage its own model context. | Owner-authorized 2026-09-13 / must |
| U8 | Hermes agent composing TypeScript | Discover exact generated imports and typed functions, execute through foreground terminal, and retain normal Portal outcomes without manually constructing each call envelope. | Owner-authorized 2026-09-13 / must |
| U9 | Deployment owner and composing agent | Prepare definitions during managed Gateway startup, reuse any complete set without generation on every call, apply changes only through Gateway restart, and measure preparation and import costs on realistic catalogs. | Owner-authorized 2026-09-13 / must |

No separate buyer journey is introduced. The deployment owner is the affected
operator and decision authority; other frameworks are potential SDK consumers,
not new framework integrations promised by this change.

External Codex and other MCP clients use the existing standalone MCP Portal
surface with its own configuration and permissions. Managed Hermes uses managed
Tool Portal's existing private connection and OAuth-backed capabilities. Catalog
selection applies to each existing presentation surface; this work adds no
external listener or external caller access to managed Tool Portal.

## Foundation and scope

Reuse the published `@agent-vm/agent-portal-sdk` package, its `tool-portal` CLI,
the Python `agent-vm-agent-portal-sdk`, portable Portal contracts, managed
Gateway Tool Portal, and the Hermes adapter's existing execution and instruction
seams. The foundation includes the configured Tool VM CLI destination.

The permitted change is the reusable package interface and its automatic Tool
VM communication/integration. It may extend SDK transports, execution-context
plumbing, managed image package delivery, and agent orientation where required.
The transport mechanism belongs in the program design, not this document.

Preserve:

- Tool Portal as the common capability and policy owner, including MCPs;
- configured destination selection rather than caller-selected execution hosts;
- Tool VM's arbitrary direct code execution; Portal rules are not VM containment;
- existing credentialed-runtime, OAuth, lease-authority, and host boundaries;
- the existing instruction-injection lifecycle rather than a new prompt engine;
- unrelated work and existing capability implementations.

## Negative space and complexity limit

No handwritten provider SDKs, Python function generation, generated provider
CLIs, installation inventory, new policy engine, workflow scheduler, persistent
composition database, automatic whole-program replay, general host proxy, or
public admin endpoint. Schema-derived TypeScript functions are in scope. No new
JavaScript sandbox or detached Portal execution lifetime is introduced. Hermes
0.21.2 is authorized only if necessary and qualified; it is not a prerequisite
inferred from the TypeScript choice. Beta package updates and reconciliation are
authorized while preserving the unrelated Google onboarding work.

Reuse the existing Tool VM configured-CLI target as a destination. Composition
does not introduce a second execution path or redefine that target's policy.

## Outcome evidence

The existing repository proof rules require real Tool VM-originated Python,
TypeScript, and CLI calls, with data consumed by the program. Evidence must
include MCP and configured-CLI routing, a result-dependent second call,
concurrent calls, real approval interaction, denial and wrong-agent cases,
connection-loss/cancellation behavior, and truthful agent instructions. Unit
tests alone cannot prove cross-VM communication. Beta proof is a separate claim
and cannot be inferred from local or CI evidence.

The added experience requires a real foreground-terminal TypeScript journey
using generated functions, accurate orientation and local import guidance,
both MCP exposure modes with the same caller permissions, OAuth consent/denial
preservation, managed Gateway lifetime stability, changed-definition preparation
on a new Gateway epoch, and measured cold generation, reuse, import, output size,
and memory costs. Performance measurements determine whether incremental
generation machinery is warranted; it is not an independently required system.
