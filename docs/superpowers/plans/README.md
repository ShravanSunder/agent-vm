# Superpowers Plan Status Index

This directory contains historical and active implementation plans. Do not infer
current status from filename date alone; read the status block at the top of a
plan before executing it.

## Canonical Current Goal

The current Tool VM revamp goal is **not** the active-use lifecycle slice by
itself. Tool VM already worked before that slice. The current system change is:

1. expose Gondolin native `vm.exec` / `vm.fs` through the adapter using
   Gondolin's public types;
2. add the small generic `VmCapabilityLease<TTransport>` base and reusable VM
   SSH endpoint/lease primitives;
3. specialize those primitives as the current OpenClaw `ToolVmSshLease`;
4. keep OpenClaw's filesystem bridge inside the OpenClaw adapter;
5. keep the controller as control plane, not command/file data plane;
6. use `../specs/2026-05-30-credentialed-actions-design.md` as the current
   credentialed actions design reference, not the older runner plan.

Execute `2026-05-22-gondolin-adapter-tool-vm-ssh-cleanup.md` for that work.
Use `2026-05-21-tool-vm-active-use-lifecycle.md` only as already-shipped
supporting context.

## Implemented Plan Records

- `2026-05-21-tool-vm-active-use-lifecycle.md`
  - Implemented in commit `a95072f` before the current Tool VM architecture was
    clarified.
  - Supporting infrastructure only. Do not use it as the standalone Tool VM
    revamp plan.
  - Pair it with `2026-05-22-gondolin-adapter-tool-vm-ssh-cleanup.md` when
    reasoning about the current system change.

## Current Executable Plans

- `2026-06-10-repo-improvements/` — repo-wide improvement audit batch
  (14 prioritized plans: leases, controller↔worker communication, gateway
  recovery, 1Password hardening, Codex SDK upgrade, executor
  genericization, extensibility, CI gates, docs drift, backup, build
  security, MCP portal). See its `README.md` for ordering, backlog, and
  rejected candidates.

- `2026-05-22-gondolin-adapter-tool-vm-ssh-cleanup.md`
  - Current prerequisite plan for exposing Gondolin native `vm.exec` / `vm.fs`
    through `@agent-vm/gondolin-adapter`.
  - Also adds the small generic VM capability/SSH type layer, specializes it as
    `ToolVmSshLease`, and keeps the OpenClaw FS bridge adapter-local.

There is currently no executable credentialed-actions implementation plan.

## Current Design References, Not Direct Execution Plans

- `../specs/2026-05-30-credentialed-actions-design.md`
  - Current credentialed actions design reference.
  - Supersedes `2026-05-22-credentialed-runner-v1.md` for execution and design
    synthesis.
  - Use it to write a fresh TDD implementation plan before code changes.

- `2026-05-22-credentialed-runner-v1.md`
  - Historical runner implementation plan imported from
    `plan/credentialed-runner-v1`.
  - Do not execute directly. It is useful as source material for the current
    credentialed actions spec and the next implementation plan.

- `2026-05-29-vm-capability-lease-redesign.md`
  - Historical lease substrate plan imported from the credentialed runner
    planning worktree.
  - Do not execute directly. Its useful lease identity, runtime-record,
    liveness, lock, and recovery ideas are absorbed into
    `../specs/2026-05-30-credentialed-actions-design.md`.

- `2026-05-20-credentialed-tool-system.md`
  - Historical credentialed tool architecture reference.
  - Superseded for execution and design synthesis by
    `../specs/2026-05-30-credentialed-actions-design.md`.

## Superseded Credential / Tool VM Plans

- `2026-05-10-gondolin-secret-source.md`
  - Superseded for credentialed execution; useful only for secret-manager
    evidence and historical context.

- `2026-05-10-tool-vm-mediated-cli-auth.md`
  - Shipped baseline/reference for audience-scoped mediated secrets.
  - Not a full credentialed runner plan.

- `2026-05-15-credentialed-tool-vm-runner.md`
  - Superseded by the later credentialed tool system direction,
    `2026-05-22-credentialed-runner-v1.md`, and the current credentialed
    actions spec.

- `2026-05-16-controller-credential-broker.md`
  - Superseded by the later credentialed tool system direction.

## Older Historical Plans

Older plans in this folder may already be shipped, partially superseded, or
retained as background. Treat any plan without an explicit status block as
historical until you verify it against current code and branch state.
