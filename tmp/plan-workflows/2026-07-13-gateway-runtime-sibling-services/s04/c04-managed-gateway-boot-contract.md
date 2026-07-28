# C04 managed Gateway boot contract checkpoint receipt

Goal id: `2026-07-13-gateway-runtime-sibling-services`

Plan anchor: Slice 04 and the S04-owned portion of Gate G4 in
`docs/specs/2026-07-12-agent-vm-gateway-runtime/plans/2026-07-13-gateway-runtime-sibling-services-implementation.md`.

## Source custody

- Parent baseline HEAD: `b867ff86b7481c5850ff57e7e40af96cf12ba31f`.
- Accepted spec SHA-256: `7fc31b7365f85aab5c8395f13ccb90965492de2dd51795d10313007a8b91adff`.
- Accepted glossary SHA-256: `6f1d0efbe65f372926e487469d032a50deb8563fc8e49baffef5e684a74bddc2`.
- Accepted plan SHA-256: `8d7732162e3597d8cab905327bb969516e2af4c33ccc1cdecd112bada7478e6c`.
- Tracked S04 binary diff SHA-256 before checkpoint commit:
  `407fe971f095e942b20075a199ef458594c5c7a04630c7b59622553904f57aa1`.
- Untracked S04 source files were individually SHA-256 inventoried in the
  parent transcript before staging. Unrelated user-owned renames, test-harness
  refactors, controller-execution test changes, check-gate changes, and
  ManagedVm audit changes were excluded from this checkpoint.

## Closed image-owned boot contract

- Managed Gateway boot input contains exactly two named roles:
  `toolPortalService` and one closed `frameworkService` discriminator.
- OpenClaw supplies only its framework-specific protected configuration,
  environment, log, readiness, and ingress identities.
- Generic service arrays, Worker roles, framework child recipes, supervisors,
  launchers, callbacks, guest PIDs, process/native handles, commands, argv,
  resolved secret values, accessors, and unknown fields are rejected.
- The controller-side boot projection is validated, deeply frozen, and included
  in image recipe/fingerprint identity.
- Worker images do not receive managed sibling boot metadata or sibling init
  entries.

## Image-owned sibling startup

- Gondolin rootfs init creates the protected managed-Gateway input directory and
  the service-owned mode-`0700` runtime root.
- Init starts the Tool Portal service and selected framework concurrently as
  sibling roles, then continues the normal `sandboxd` path.
- `setpriv` performs the UID/GID transition and is replaced by the service;
  there is no resident `su`, shell launcher, supervisor, restarter, or adopter.
- Fresh real-VM process evidence proves both production roles run as the same
  non-root UID with PPID `1`; neither is the other's parent.
- Partial-start cuts prove Tool-Portal-only and framework-only startup without a
  second start identity or local restart path.
- Observational `ManagedVm.exec()` occurs only after boot to read process and
  receipt evidence; it does not create configuration, directories, or processes.

## Image and process evidence

- Prepared OpenClaw image fingerprint: `3599358a64dd3a01`.
- Boot projection:

  ```json
  {
    "frameworkBootEntry": "openclaw-framework-service",
    "kind": "managed-gateway-exact-two-role"
  }
  ```

- Prepared-record SHA-256:
  `1c71fff5c19075da315990129899d6607934cb3fbed7c0064263b3598db7089f`.
- Rebuilt Docker image SHA observed during proof:
  `304ea436f64b5addacd084f373a828236181b4843f5d90122088b5afb024740b`.
- VM evidence result SHA-256:
  `ff42b86d962cfbf2d48507e06563bfb4b023990b74313ec6ed9e883e5c85d79a`.

## Architecture-audit remediation

The focused topology audit originally treated the negative `childRecipe`
fixture in the managed boot-contract unit test as a production declaration.
Permanent red/green proof now excludes ordinary test fixtures only after
preserving the explicit prohibition on the deleted managed-framework supervisor
test path. The audit still rejects production child/supervisor residue and now
passes both the topology-only and full architecture lanes.

## Fresh parent-run proof

All commands ran from the repository root on 2026-07-14 local time.

1. Focused S04 unit matrix
   - `pnpm vitest run scripts/audit-portal-architecture.unit.test.ts packages/gateway-lifecycle/src/managed-gateway-boot-contract.unit.test.ts packages/agent-vm/src/gateway/managed-gateway-boot-contract.unit.test.ts packages/gondolin-vm-adapter/src/managed-gateway-rootfs-init.unit.test.ts packages/openclaw-gateway/src/openclaw-managed-boot-metadata.unit.test.ts packages/agent-vm/src/build/prepared-gondolin-image-cache.unit.test.ts packages/agent-vm/src/build/managed-image-release.unit.test.ts`
   - exit `0`; 7 files, 96 tests passed.
2. Targeted controller/build integration
   - `pnpm vitest run packages/agent-vm/src/cli/build-command.integration.test.ts packages/agent-vm/src/integration-tests/gateway-runtime-sandbox.integration.test.ts`
   - exit `0`; 2 files, 53 tests passed.
3. Full unit
   - `pnpm test:unit`
   - exit `0`; 341 files, 3,610 tests passed.
4. Host E2E
   - `pnpm test:e2e:host -- packages/agent-vm/src/integration-tests/e2e-harness.host.e2e.test.ts`
   - exit `0`; 32 tests passed, 0 skipped, 0 todo.
   - Evidence JSON: `tmp/vitest-results/e2e-host-18600-n2YZ1d/results.json`.
5. Fresh stock-VM boot and partial-start proof
   - `mise exec -- pnpm test:e2e:vm -- packages/agent-vm/src/integration-tests/managed-gateway-image-boot.vm.e2e.test.ts`
   - exit `0`; 4 tests passed, 0 skipped, 0 todo.
   - Evidence JSON: `tmp/vitest-results/e2e-vm-86758-S6FU4F/results.json`.
6. Full quality gate
   - `pnpm check`
   - exit `0`; 14 gates passed, 0 failed.
   - Type-aware lint reported 59 existing warnings and 0 errors.
7. `git diff --check`
   - exit `0`.

## S04/S05 joined benchmark obligation

The G0 comparison milestone is the first successful framework-root request
after controller admission. Before S05, the live controller still owns the
legacy post-boot guest launch and singleton admission path. Running the new
distribution now would either exercise that legacy path or use a different
milestone, so it would not be comparable evidence.

The new-path distribution is therefore an explicit C05/G5 join obligation:
immediately after S05 installs aggregate readiness and new-path controller
admission, rerun the unchanged G0 fixture with the same host/hardware, cache
state, request, sample count, and reporting method. Then remove the legacy
launch/recovery source path in the same hard cut. This deferral preserves no
compatibility path and does not relabel stock-VM boot proof as admitted-ingress
benchmark proof.

## Checkpoint decision

`C04 complete`. The S04-owned contract, image wiring, process identity,
partial-start, Worker-isolation, and no-controller-launch-mechanism proofs are
green. The matched admitted-ingress distribution remains open only as the
explicit S04/S05 join proof and must be closed before `G5` completes.
