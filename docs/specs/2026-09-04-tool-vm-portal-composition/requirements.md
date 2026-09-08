# Tool VM Portal composition requirements

[Specification](specification.md) · [Program design](program-design.md)

## Goal

An agent writes ordinary code inside its Tool VM, calls Tool Portal through a
reusable SDK or CLI, and uses returned data to decide what to call next. Tool
Portal continues to select each capability's execution destination. The
composition program itself does not move to the host or credentialed VM.

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

| ID | Consumer | Need and reason | Authority / priority |
| --- | --- | --- | --- |
| U1 | Agent composing a task | Execute the composition in Tool VM; sequence, branch, loop, and combine Portal results without a model turn for each sub-call. | Owner-authorized / must |
| U2 | SDK and CLI consumers | Use reusable Python and TypeScript packages and the Portal CLI, independent of Hermes and individual MCP providers. Reuse the existing packages rather than create competing APIs. | Owner-authorized / must |
| U3 | Agent entering its execution environment | Find installed interfaces, automatic connection setup, and accurate usage instructions without configuring endpoints or credentials manually. | Owner-authorized / must |
| U4 | Capability owner and approving human | Preserve Portal discovery, argument validation, routing, approval, and result behavior for calls originating in Tool VM. | Owner-authorized preservation / must |
| U5 | Agent and operator | Know whether a call succeeded, failed, needs approval, was cancelled, or has an uncertain effect; do not silently repeat side effects. | Existing Portal behavior preserved / must |
| U6 | Deployment owner | Keep agent/profile isolation and credential ownership intact across the new communication path; do not expose framework/admin authority to guest code. | Existing managed-runtime boundary preserved / must |

No separate buyer journey is introduced. The deployment owner is the affected
operator and decision authority; other frameworks are potential SDK consumers,
not new framework integrations promised by this change.

## Foundation and scope

Reuse the published `@agent-vm/agent-portal-sdk` package, its `tool-portal` CLI,
the Python `agent-vm-agent-portal-sdk`, portable Portal contracts, managed
Gateway Tool Portal, and the Hermes adapter's existing execution and instruction
seams. Source snapshot: `origin/master` at `b4647ae2`.

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
- other agents' changes and the separate PR A remediation lane.

## Negative space and complexity limit

No provider-specific SDK/CLI generation, installation inventory, new policy
engine, workflow scheduler, persistent composition database, automatic whole-
program replay, general host proxy, or public admin endpoint. No Hermes fork or
upstream distribution upgrade is implicitly authorized. No deployment secret,
egress, or privileged configuration edits occur during this design cycle.

PR A's Tool VM configured-CLI target is a destination prerequisite, not a reason
to copy its implementation into this branch. A missing prerequisite must remain
explicit; the other agent's repair work is not subsumed here.

## Outcome evidence

The existing repository proof rules require real Tool VM-originated Python,
TypeScript, and CLI calls, with data consumed by the program. Evidence must
include MCP and configured-CLI routing, a result-dependent second call,
concurrent calls, real approval interaction, denial and wrong-agent cases,
connection-loss/cancellation behavior, and truthful agent instructions. Unit
tests alone cannot prove cross-VM communication. Beta proof is a separate claim
and cannot be inferred from local or CI evidence.
