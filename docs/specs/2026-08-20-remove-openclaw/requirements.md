# Remove OpenClaw Requirements

## Purpose

Agent VM currently owns two managed interactive-agent framework integrations:
OpenClaw and Hermes. The OpenClaw integration adds a second framework lifecycle,
plugin bridge, identity model, authentication path, managed image, configuration
surface, documentation path, and reliability proof matrix. The repository owner
does not want to keep paying that maintenance cost when Hermes is the managed
interactive-agent framework they intend to operate.

This document records the authorized needs and limits for removing OpenClaw. The
separate [Specification](specification.md) owns observable obligations, and the
separate [Program Design](program-design.md) will own the structural realization.

## Affected people and systems

- Repository maintainers need one managed interactive-agent integration to
  understand, evolve, diagnose, and prove.
- Deployment operators need a first-class Hermes scaffold and operating path
  instead of OpenClaw-oriented defaults and commands.
- Managed Hermes agents need the existing capability, sandbox, workspace,
  security, and recovery outcomes to remain available.
- Worker Gateway consumers need their separate task-execution product to remain
  unchanged.
- Release operators need the remaining package and image train to exclude
  removed OpenClaw artifacts without weakening release verification.

## Authorized needs

The repository owner assigned every row below on 2026-08-20. `authorized` rows
are normative-eligible; observational evidence explains the current cost but
does not create the desired behavior.

| ID | Priority | Need or outcome | Authority | Evidence |
| --- | --- | --- | --- | --- |
| U1 | must | Stop maintaining and shipping the OpenClaw implementation in Agent VM. | authorized — repository owner | Current source contains separate OpenClaw lifecycle, plugin, image, auth, config, docs, and E2E owners. |
| U2 | must | Make Hermes the only supported managed interactive-agent Gateway while retaining Worker as the separate task Gateway. | authorized — repository owner | Hermes already participates in managed Gateway configuration, lifecycle loading, controller orchestration, Tool VM policy, and live E2E. |
| U3 | must | Preserve the framework-neutral managed-agent outcomes currently required from Gateway Runtime, Tool Portal operations and Hermes Tool Portal orientation, Tool VM, sandbox execution, filesystem, process, stream, workspace, and artifact behavior. | authorized — repository owner | The accepted Gateway Runtime contract defines common OpenClaw/Hermes capability and sandbox behavior; the accepted Hermes Tool Portal orientation contract and current adapter define profile-scoped startup inventory and session-once orientation. |
| U4 | must | Preserve controller authority, secret mediation, profile isolation, storage boundaries, approval behavior, observability, health, recovery, and termination safety. | authorized — repository owner | Current managed Gateway and managed VM contracts make these cross-framework controller-owned boundaries. |
| U5 | must | Give operators Hermes-native scaffold, configuration, validation, build, administration, and documentation paths. | authorized — repository owner | `agent-vm init` currently rejects Hermes even though authored Hermes configs can build and run. |
| U6 | must | Use a clean cutover: reject OpenClaw configuration and remove OpenClaw-specific commands, state contracts, packages, images, tests, and active documentation without aliases, shims, dual paths, or automatic state migration. | authorized — repository owner | Owner explicitly chose a clean break and accepted retiring OpenClaw-only behavior. |
| U7 | must | Keep Worker behavior, interfaces, configuration, and proof coverage outside the removal. | authorized — repository owner | Worker has a separate on-demand task lifecycle and is not an OpenClaw implementation detail. |
| U8 | must | Keep the packaged Hermes upstream distribution pinned at `0.20.0` during this cutover; qualify any Hermes upgrade separately. | authorized — repository owner | Current Agent VM Hermes proof is anchored to an immutable `0.20.0` OCI digest; latest upstream is a multi-thousand-commit delta. |
| U9 | must | Prove both the positive Hermes product path and the absence of active OpenClaw product residue before calling the removal complete. | authorized — repository owner | Current proof covers Hermes Tool Portal, Tool VM terminal execution, and observability; a named live Hermes filesystem proof is still missing. |

## Current observable problem

Maintainers must interpret and preserve two framework-specific paths even when
only Hermes is wanted operationally. OpenClaw-specific failures and upstream
changes cross Gateway lifecycle, session state, message delivery, plugin/core
compatibility, authentication, diagnostics, and recovery. This creates a second
set of code, tests, images, documentation, release inputs, and incident surfaces.

Operators cannot currently scaffold Hermes through the public init command.
They must begin with an already-authored Hermes deployment or beta-oriented
materialization path even though Hermes is implemented as a managed Gateway.

The problem would remain if OpenClaw packages were deleted while public schemas,
CLI choices, runtime identities, generated manuals, release inputs, or stale
fallback branches continued to present OpenClaw as supported.

## Desired outcome

After the cutover, a maintainer can describe Agent VM as two intentional Gateway
products:

```text
Hermes Gateway  — long-running managed interactive agents
Worker Gateway  — on-demand autonomous coding tasks
```

Operators can scaffold and run Hermes through supported Agent VM commands.
Managed Hermes agents retain the capability and sandbox outcomes owned by the
common runtime contracts. No active product surface offers, loads, documents,
builds, tests, or publishes OpenClaw.

## Goal boundary

### Permitted to change

- Managed Gateway and portal contracts where they contain OpenClaw variants.
- Agent VM configuration, CLI, controller composition, operations, manuals,
  build inputs, integration tests, and release inventories.
- OpenClaw-owned packages, images, scripts, fixtures, and documentation.
- Hermes scaffold and proof surfaces needed to make the retained product whole.

### Protected foundation

- Hermes' immutable `0.20.0` upstream distribution pin.
- Worker Gateway observable behavior and public task APIs.
- Gateway Runtime, Tool Portal, MCP-provider backend, Tool VM, managed VM, and
  Gondolin boundaries except where an OpenClaw-only variant is removed.
- The accepted Hermes Tool Portal orientation behavior: profile/epoch-scoped
  startup inventory, bounded deterministic rendering, nonblocking session-once
  `pre_llm_call` injection, typed process-local state, and fail-closed authority.
- Controller ownership of durable lifecycle, leases, credentials, approvals,
  recovery, and termination.
- Existing Hermes recovery behavior, including known baseline defects; this
  cutover proves non-regression but does not repair or redesign recovery.
- Existing secret, workspace, storage, ingress, and trust boundaries.

### Non-goals

- Upgrading Hermes or adopting unreleased Hermes behavior.
- Redesigning Hermes, Worker, Gateway Runtime, Tool Portal, Tool VM, controller,
  managed VM, Gondolin, storage, or recovery semantics.
- Repairing the known post-control-reattachment Tool VM binding-publication
  race or changing Hermes cache, retry, reconnect, or reacquisition behavior.
- Making OpenClaw-specific idle-retirement, automatic-recovery, or repeated
  replacement timing into new Hermes lifecycle requirements merely because the
  removed OpenClaw E2E project exercised them.
- Preserving OpenClaw configuration, state, conversations, auth profiles,
  plugin APIs, command names, image compatibility, or native-plugin behavior.
- Building an automated OpenClaw-to-Hermes state migration.
- Adding a compatibility parser, deprecation period, feature flag, provider
  registry, second VM backend, or generic framework plugin system.
- Unpublishing historical npm artifacts or deleting historical container images
  as part of the repository cutover.
- Rewriting immutable historical release records merely to erase the OpenClaw
  name.
- Planning, implementation, PR, deployment, or registry mutation in this design
  cycle.

## Accepted complexity

The cutover may add only the Hermes scaffold and proof seams required to make
the retained product complete. It may simplify or delete shared branches after
OpenClaw variants disappear. New persistence, migration services, compatibility
layers, feature flags, dynamic discovery, or cross-run coordination are outside
the authorized complexity budget.

## Acceptable outcome evidence

Evidence must establish:

- a fresh Hermes deployment can be scaffolded, validated, built, started, and
  operated through supported Agent VM surfaces;
- a real managed Hermes path exercises Tool Portal, Tool VM execution,
  filesystem behavior, profile isolation, observability, and the existing
  recovery paths that are green on the pre-cutover baseline;
- any known red recovery stress case has matching base-versus-cutover behavior
  and remains separately visible rather than being deleted, weakened, or
  presented as a cutover regression;
- removed OpenClaw E2E behavior that is not equivalent to current Hermes
  lifecycle semantics is explicitly classified and transferred to a separate
  runtime owner rather than silently weakened, relabeled, or repaired here;
- Hermes Tool Portal orientation retains its bounded startup inventory,
  profile/epoch/session isolation, prompt-cache stability, nonblocking failure
  behavior, and existing unit/integration/E2E evidence;
- Worker behavior and proof remain intact;
- OpenClaw configuration is rejected and no OpenClaw runtime path can start;
- active source, schemas, package graphs, generated artifacts, documentation,
  test projects, and release inventories contain no supported OpenClaw path;
- remaining packages and published artifacts retain synchronized, verifiable
  release metadata.

## Evidence and authority notes

Current implementation evidence is anchored in the repository at head
`17da2ba2d6d7a604a3f1333ba0e9ab1c54b4ea82`. The accepted Gateway Runtime and
managed VM package-boundary specifications remain authoritative for the
framework-neutral outcomes they define. Recent upstream issue and release
research is observational evidence for maintenance cost, not authority for this
product decision.

No owner decision remains open in this Requirements boundary.
