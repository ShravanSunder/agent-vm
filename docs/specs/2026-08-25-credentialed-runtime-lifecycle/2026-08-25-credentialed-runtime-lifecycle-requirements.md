# Credentialed Runtime Lifecycle Requirements

## Purpose

Agent VM must let an authenticated managed agent repeatedly use approved external CLIs whose authentication is represented by local files or similar CLI state. Those calls must remain independently authorized while executing inside a temporary, controller-owned Managed VM that can be reused by the same agent for a short idle window.

The existing `configured_cli` Managed VM target is operation-scoped: every call creates and destroys one VM. That lifecycle makes the RPC boundary also be the VM boundary, causing repeated startup and credential materialization and preventing CLI-maintained state from carrying between related calls. This document replaces that lifecycle meaning for credentialed Managed VM execution.

The separate [Specification](./2026-08-25-credentialed-runtime-lifecycle-specification.md) defines the observable configuration, lifecycle, failure, and proof contracts.

## Problem identities

| ID | Observable problem |
| --- | --- |
| P1 | One Tool Portal RPC currently creates and destroys one Managed VM, so related calls cannot reuse startup work or runtime-local CLI state. |
| P2 | A shared capability-policy profile does not by itself distinguish which agent-specific authentication identity and mutable runtime state a call may use. |
| P3 | Running credentialed broad CLI commands on the controller host would give those commands the controller process's host filesystem and network authority. |
| P4 | Persisting credential copies in controller storage would duplicate 1Password authority and create another credential lifecycle without improving runtime behavior. |

## Governing sources

- Owner-confirmed decisions from 2026-08-25 authorize per-agent Managed runtimes, independent per-call authorization, at most one active command with retryable busy rejection, fixed 15-minute idle retirement, agent-specific 1Password credential bindings, and Managed VM rather than controller-host execution.
- The existing Tool Portal agent-to-profile assignment and call-policy model remains the access-control foundation.
- The existing controller Tool VM lifecycle is observational evidence that active-use tracking, compatibility checks, renewal, and idle retirement are viable. Its SSH, workspace, lease-request, and Tool VM authority are not inherited requirements for credentialed runtimes.
- [2026-05-20 Credentialed Tool System](../../superpowers/plans/2026-05-20-credentialed-tool-system.md) is advisory historical evidence for warm credentialed runtimes and protected credential maintenance. Its storage, package, host-backend, and artifact proposals are not adopted here.
- The historical `2026-05-22-credentialed-runner-v1.md` plan from commit `844bc478` is advisory evidence for controller-owned warm runtimes and active uses. It was not implemented, and its durable `/cred` design is not governing authority.
- The [2026-08-20 Requirements](../2026-08-20-managed-gateway-approval-presenter/2026-08-20-managed-gateway-approval-presenter-requirements.md), [Specification](../2026-08-20-managed-gateway-approval-presenter/2026-08-20-managed-gateway-approval-presenter-specification.md), and [Program Design](../2026-08-20-managed-gateway-approval-presenter/2026-08-20-managed-gateway-approval-presenter-program-design.md) remain authoritative for configured CLI policy, direct array argv, controller approval, Hermes presentation, and leased Tool VM separation. For a credentialed `ephemeral_managed_vm`, this document supersedes their uncredentialed-only and registered-action-promotion-only requirement, prohibition on controller-materialized credential files and a code-owned credential mount, one-VM-per-call guarantee, and no-reuse guarantee. It preserves every prohibition on caller-selected credentials, mounts, paths, environment values, VM authority, host fallback, and Tool VM reuse.

## Authorized needs

| ID | Affected class | Need and outcome | Priority | Authority |
| --- | --- | --- | --- | --- |
| U1 | Managed agent user | Related calls to the same credentialed CLI runtime should reuse one compatible live runtime instead of paying VM startup and credential setup for every call. | Must | Owner-authorized, 2026-08-25 |
| U2 | Managed agent user | CLI authentication files and runtime-local state needed by consecutive calls should remain available while that agent's compatible runtime is retained. | Must | Owner-authorized, 2026-08-25 |
| U3 | Deployment operator | The controller must own runtime creation, reuse, retirement, and destruction; Hermes, the model, and callers must receive no VM or runtime-lease authority. | Must | Owner-authorized, 2026-08-25 |
| U4 | Security operator | Every call must independently satisfy current Tool Portal visibility, admission, approval, identity, argument, timeout, and cancellation policy. Runtime reuse must never reuse authorization. | Must | Owner-authorized, 2026-08-25; existing Tool Portal authority model |
| U5 | Security operator | Credentialed runtime access must be default-deny and derived from the controller-authenticated agent's configured Tool Portal profile plus that agent's explicit credential binding. | Must | Owner-authorized, 2026-08-25; existing per-agent profile model |
| U6 | Security operator | A credentialed runtime and its mutable state must belong to one authenticated agent and must never be reused by another agent, even when both agents share a capability-policy profile. | Must | Owner-authorized, 2026-08-25 |
| U7 | Deployment operator | Only one command may execute in an agent runtime at a time; a concurrent same-runtime call should fail retryably instead of waiting for late execution, while unrelated agent runtimes may proceed independently. | Must | Owner-directed lean v1 behavior, 2026-08-25 |
| U8 | Deployment operator | A runtime must retire automatically after 15 minutes with no active command, without destroying active work merely because an earlier idle deadline passed. | Must | Owner-authorized, 2026-08-25 |
| U9 | Security operator | A runtime that is stale, incompatible, revoked, unhealthy, ownership-ambiguous, or no longer contained must receive no new call and must be retired or fenced from access. | Must | Owner-authorized, 2026-08-25; existing controller lifecycle evidence |
| U10 | Security operator | Durable authentication material must remain in the agent's configured 1Password binding and be sufficient to establish a fresh runtime; controller SQLite and runtime records must not become credential stores. | Must | Owner-authorized, 2026-08-25 |
| U11 | Security operator | Credentialed broad CLI execution must remain inside a Managed VM rather than inherit the controller process's host filesystem and network authority. | Must | Owner-authorized, 2026-08-25 |
| U12 | Maintainer | The incorrect one-shot lifecycle must be replaced directly without a compatibility target, second lease system, or preserved per-call mode unsupported by a real consumer. | Must | Owner-authorized hard-cutover preference, 2026-08-25 |
| U13 | Managed agent user | A runtime should start from an immutable image that already contains the configured CLI, use the normal fast rootfs/COW overlay while alive, and stop by discarding that overlay without per-runtime installation, checkpoint, or restoration. | Must | Owner-authorized, 2026-08-25 |

## Required outcomes

### O1 — Calls and runtimes have different lifetimes

One Tool Portal RPC remains one independently authorized command and one result. Completing that RPC does not by itself destroy the compatible credentialed runtime that executed it.

### O2 — Compatible runtimes are per agent

The controller creates or reuses a runtime for the authenticated agent and authored runtime identity. Several compatible Gog command families may share that runtime. A different agent receives a different runtime and runtime-local state, including when both agents use the same Tool Portal policy profile.

### O3 — Configuration is the access grant

An agent may access a credentialed operation only when its controller-authenticated identity is declared, its assigned Tool Portal profile exposes the operation, current call policy admits it, and the agent has the required credential binding. Callers cannot select or override agent identity, profile, runtime identity, credential binding, or credential reference.

### O4 — Authorization remains per call

Every call independently re-enters current policy and approval. A denied, pending, expired, cancelled, stale, or otherwise unadmitted call does not create a runtime, renew its idle period, register active execution, or dispatch a command.

### O5 — One runtime admits one active command

At most one command executes in an agent runtime. A concurrent same-runtime call receives a bounded retryable busy result and is never queued for later execution. After the active command completes, a newly submitted compatible call may observe its runtime-local CLI state. Commands using different agent runtimes may execute independently.

### O6 — 1Password is the durable authentication source

Each agent's credential binding resolves a bounded set of named file contents from 1Password into a memory-backed credential surface when a runtime is established. Normal CLI working files and caches use the runtime rootfs/COW overlay. Both may remain only for that runtime's lifetime. A fresh runtime must be establishable from those 1Password-backed files without recovering a credential blob from controller SQLite or a prior runtime record.

### O7 — Idle retirement is fixed and active-use aware

The runtime becomes idle after its final active command reaches a terminal outcome. A compatible admitted call within 15 minutes may reuse it and begin a new active command. If 15 idle minutes elapse, the controller retires the runtime. Active work is not idle.

### O8 — Invalidation retires access

Changes to agent identity, authored runtime identity, image revision, authored credential-binding revision, runtime-shaping policy, zone/controller ownership, health, or containment make the prior runtime ineligible for new calls. A changed 1Password value takes effect on the next runtime creation; an operator explicitly retires the live runtime when immediate replacement is required. Credential revocation, operator retirement, zone stop/restart, and controller ownership loss retire or fence the affected runtime without granting adoption authority to a successor.

### O9 — Managed VM containment is preserved

Credentialed CLI execution runs inside a Managed VM with only its authorized runtime-local credential state and configured execution capabilities. It does not run with the controller process's host filesystem or network authority, and it is not the caller's leased Tool VM.

### O10 — The one-shot interpretation is removed

For credentialed Managed VM execution, `ephemeral` means controller-created, non-durable, and automatically retired. It no longer means one VM per RPC call. No one-shot compatibility target or optional per-call lifetime is required.

### O11 — Runtime rootfs/COW is disposable rather than checkpointed

A new runtime starts from a prepared immutable image containing the configured CLI and uses a writable rootfs/COW overlay for its live session. Retirement closes the VM and discards that overlay. No stopped agent runtime is checkpointed, restored, or used as durable credential state.

## Boundary and non-goals

- This correction extends configured CLI credential and lifecycle behavior; it does not change `controller_host`, `tool_vm_runner`, registered-action executors, or the existing Hermes approval presenter.
- It does not expose SSH, shell, filesystem browsing, VM handles, lease handles, runtime selection, credential maintenance, or arbitrary process authority to the model or framework.
- It does not create a second per-agent capability-authorization list. Existing agent-to-profile assignment remains the capability grant; agent-specific credential bindings select authentication material.
- It does not make a Tool Portal profile imply shared authentication or a shared runtime between agents.
- It does not store credential plaintext or encrypted credential blobs in controller SQLite, runtime records, approval records, or lifecycle ledgers.
- It does not checkpoint or persist an agent runtime root filesystem or memory-backed credential surface. Provider image caching before agent credentials are materialized is not stopped-runtime state.
- It does not require generic credential writeback, token rotation, interactive OAuth setup, artifact transfer, cross-command workflow composition, or persistence of disposable CLI caches.
- It does not queue concurrent same-runtime calls or re-resolve 1Password before every call. A retry is a new independently authorized Tool Portal call.
- It assumes the configured 1Password material is sufficient to establish a fresh authenticated runtime. An authentication mode requiring runtime-mutated credentials to survive retirement requires a separate owner decision.
- It does not add a host sandbox, host operating-system user, container layer, new service, new database, new approval system, or new external lease API.
- It does not implement OpenClaw or Worker framework behavior. Generic contracts may remain framework-neutral, while Hermes is the only implemented approval presenter.

## Accepted complexity

Accepted complexity is one agent-specific credential-binding extension to existing Tool Portal assignment, one reusable lifecycle for the existing credentialed Managed VM target, one active-command slot per agent runtime with no queue, fixed 15-minute idle retirement, a prepared CLI image with a disposable rootfs/COW overlay that is never checkpointed, and reuse of existing controller authority and Managed VM capabilities.

A second runtime target, shared-agent credential mode, configurable idle TTL, generic writeback system, credential database, external lease API, new presenter, host containment system, or compatibility path requires renewed owner approval.

## Outcome-level evidence

Completion evidence must separately demonstrate:

- an undeclared agent, an agent assigned a profile without the operation, an agent missing its credential binding, and a forged caller-supplied identity/binding/runtime value are rejected before runtime acquisition;
- two different Gog operations for one agent and runtime identity reuse the same live Managed VM while receiving independent policy and approval decisions;
- the same policy profile assigned to two agents requires separate agent bindings and produces different runtime identities, credential-materialization surfaces, and mutable runtime state;
- a concurrent call to one busy runtime receives a retryable zero-effect result and is never dispatched later, while calls to different agent runtimes can proceed independently;
- denied, pending, expired, cancelled, and stale calls neither create nor renew a runtime and produce zero command effects;
- runtime-local state written by one completed call is observable to the next compatible call but disappears with retirement;
- active work prevents idle retirement, a call within 15 idle minutes reuses the runtime, and a call after retirement establishes a new runtime;
- agent, runtime, image, authored credential binding, runtime-shaping policy, ownership, health, or containment incompatibility prevents reuse and retires or fences the prior runtime;
- a fresh runtime resolves its agent-specific authentication from 1Password without reading credentials from controller SQLite or lifecycle records;
- Hermes and the model receive per-call results but no credential reference, credential value, VM identity, or runtime-lease authority;
- real Managed VM execution proves the credentialed CLI cannot exercise controller-host filesystem authority and remains separate from leased Tool VM SSH.
- a new runtime finds the configured CLI already installed, performs no runtime package installation or stopped-runtime restore, and loses a rootfs marker after retirement and replacement.

Schema-only, fake-VM-only, or approval-prompt-only evidence cannot prove runtime reuse, agent isolation, busy-call rejection, idle retirement, credential materialization, or containment.

## Unresolved hypotheses

None. A future CLI authentication mode that cannot recreate a valid runtime from its configured 1Password material is outside this accepted requirements set and must reopen credential persistence explicitly.
