# Root-Derived Gateway-Zone Storage Implementation Plan

Status: Ready for execution
Date: 2026-07-22
Source: `../2026-07-22-root-derived-zone-storage.md` (403 lines, read in full as lines 1-140, 141-280, and 281-403)

## Goal

Make `storageRootDir` the only authored standard operational storage path in schema version 2, derive the accepted global and per-zone leaves once at config loading, and mechanically pass those existing concrete-path capabilities to their current consumers.

## Scope Guard

This plan does not add migration, compatibility readers, discovery, copying, recovery, a storage service, a generalized ownership abstraction, new filesystem validation, new lifecycle behavior, or new proof infrastructure. Existing `backupDir`, observability `dataDir`, guest mounts, backup membership, controller authority, and framework behavior stay unchanged.

## Tasks

### T1. Hard-cut the authored schema and derive loaded paths

- Change schema version 1 to version 2.
- Replace authored `cacheDir`, `controllerStateDir`, and `runtimeDir` with required `storageRootDir`.
- Remove authored Gateway `stateDir` and managed-Gateway `zoneFilesDir`.
- Reject `cache`, `controller-state`, and `controller-runtime` as zone IDs.
- At the existing config-loading boundary, resolve/canonicalize the root and derive:
  - `cacheDir`;
  - `controllerStateDir`;
  - `controllerRuntimeDir`;
  - per-zone `stateDir`, optional `zoneFilesDir`, and `zoneRuntimeDir`.
- Keep loaded concrete paths in the existing internal config/composition contracts; add only the smallest authored-versus-loaded type split required by TypeScript.

Proof: focused `system-config` unit tests cover exact derivation, default/relative/home resolution, reserved IDs, and rejection of removed fields.

### T2. Mechanically wire the renamed runtime leaves

- Send `controllerRuntimeDir` only to controller-wide ownership-lock, health, and observability consumers.
- Send each `zoneRuntimeDir` to zone logs, workspace Git roots, Worker task runtime, control-session material, Gateway lifecycle VM requirements, backup exclusion checks, and zone destruction.
- Remove old `runtimeDir/zones/<zoneId>` and `runtimeDir/worker-tasks/<zoneId>` joins; do not change the remaining suffixes or behavior.
- Preserve existing concrete-path lifecycle and VM boundaries. Frameworks do not receive `storageRootDir`.

Proof: update existing focused path expectations and existing affected unit/integration tests; add no new behavior scenarios.

### T3. Cut over authored surfaces and maintained documentation

- Make local, user-dir, and pod scaffolds append the generated or explicit `projectNamespace` exactly once and emit the final explicit `storageRootDir` fixed by the spec.
- Update generated schema/config/manual fixtures and maintained configuration/storage documentation to the new authored shape and tree.
- Mechanically update repo and beta configuration fixtures to schema version 2 and one storage root; keep `backupDir` and observability `dataDir` independent.

Proof: existing init/config/manual integration tests and built-CLI init-to-validate smoke.

### T4. Validate the exact change

- Run focused schema/path tests while iterating.
- Run existing affected unit/integration tests.
- Run `pnpm check`.
- Run the existing beta OpenClaw and Hermes startup smoke after syncing the exact implementation HEAD into beta.
- Inspect the final diff for forbidden migration, compatibility, lifecycle, backup, lease, Tool Portal, Gondolin, or proof-framework expansion.

## Execution Order

```text
T1 schema + loaded derivation
  |
T2 concrete consumer wiring
  |
T3 authored fixtures + maintained docs
  |
targeted tests
  |
pnpm check
  |
existing beta OpenClaw/Hermes startup smoke
  |
final scope review
```

The production type and path cut is serial because T2 and fixture compilation depend on T1's final loaded shape. After T1/T2 compile, disjoint documentation and fixture updates may run in parallel.

## Requirements And Proof

| Requirements | Owning tasks | Existing proof |
| --- | --- | --- |
| R1-R3 | T1 | `system-config.unit.test.ts`, generated schema assertions |
| R4-R8 | T2 | existing affected unit/integration path expectations and normal check gate |
| R2, R9 | T3 | existing init/config/manual integration and CLI smoke tests |
| R1-R9 | T4 | fresh `pnpm check` plus existing beta OpenClaw/Hermes startup smoke |

Red/green is required only for the focused schema/path behavior introduced by T1. Mechanical fixture and documentation replacements use existing passing assertions. Evidence is fresh only when run against the final worktree HEAD.

## Stop Conditions

Stop before broadening if implementation would require a new storage subsystem, compatibility or migration behavior, a new authority boundary, changed backup semantics, changed guest paths, changed Gateway/Tool Portal lifecycle, new proof infrastructure, or edits outside the accepted storage path cut. An unrelated validation failure is reported separately and is not authorization to change that layer.

## Open Questions

None. The source specification fixes every architecture-relevant choice needed by this plan.
