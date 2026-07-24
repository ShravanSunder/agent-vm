# Hermes Discord Profile Secrets Implementation Plan

Status: ready for focused plan review

Date: 2026-07-23

Source:
[Hermes Discord Profile Secrets](../2026-07-23-hermes-discord-secret-mediation.md)

Goal state:
`tmp/workflow-state/2026-07-23-hermes-discord-profile-secrets/details.md`

## Goal And Boundary

Implement the accepted disk-free flow:

```text
validated mapping
  -> controller-serialized RAM boot inputs
  -> finalizable Gondolin MemoryProvider staging
  -> protected Hermes environment
  -> exact RAM-shadowed profile .env
  -> stock Hermes
```

Hard cut the existing host-directory managed Gateway boot staging. Do not keep
two boot-input paths or add compatibility behavior.

Do not add a Hermes secret-source plugin, upstream change, new process,
supervisor, relay, protocol, migration, copy-back, recovery, or live rotation.

## Requirements/Proof Matrix

### P1 — Closed Hermes mapping

Requirement: mapping keys match `profilesByAgent`; names are distinct same-zone
Gateway `env` secrets; mapped profiles preserve `DISCORD_BOT_TOKEN`.

Owning slice: Slice 2.

Proof: schema and adapter unit tests cover valid mappings, missing/extra keys,
duplicate or invalid secret names, invalid injection/audience, missing
`secrets.preserve_existing`, and value-free diagnostics.

Layer: unit.

Evidence source: parent-run red/green output.

Freshness guard: exact implementation diff.

### P2 — No secret-bearing host or rootfs staging

Requirement: all managed Gateway boot inputs originate in controller memory,
finalize once into declared pre-start memory mounts after VM identity exists,
and are never materialized in a host directory or copied to rootfs/qcow2.

Owning slice: Slice 1.

Proof: managed-VM contract/provider unit tests, orchestrator integration tests,
and the existing managed Gateway image boot E2E prove create-bind-finalize-start
ordering, one-shot contents/modes, absence of a host reservation/path, direct
memory-mount consumption, and no runtime-root copy.

Layer: unit, integration, real VM E2E.

Evidence source: parent-run red/green output and inspected VM request.

Freshness guard: exact built HEAD and fresh image inputs.

### P3 — Fail-closed source and unlink

Requirement: each service sources only its environment entry, unlink succeeds
before service `exec`, and source/unlink failure prevents that service from
becoming ready.

Owning slice: Slice 1.

Proof: rootfs-init rendering unit tests plus managed Gateway image boot E2E with
success and one injected missing/unlink-failure case. The success case observes
environment entries absent after readiness.

Layer: unit and real VM E2E.

Evidence source: parent-run red/green output.

Freshness guard: exact generated image recipe and built image.

### P4 — RAM-only Hermes profile tokens

Requirement: only mapped profile `.env` paths use the existing shadow-memory
upper; durable `.env` files are rejected; the adapter writes canonical values,
removes source names, and starts stock Hermes.

Owning slice: Slice 2.

Proof: Hermes lifecycle tests, profile-directory host E2E, and Python adapter
tests cover exact paths, `0600`, no-follow behavior, source removal, safe
preflight, durable sibling-state preservation, and restart replacement.

Layer: unit, integration, host E2E.

Evidence source: parent-run red/green output.

Freshness guard: exact TypeScript and Python sources under test.

### P5 — Real Hermes and retained mediation

Requirement: a real managed Hermes VM boots twice with both profiles, retains
HTTP mediation for unrelated secrets, keeps mapped Discord names and values out
of Tool Portal and Tool VM boundaries, and leaves no canary in prohibited
durable/log/telemetry surfaces.

Owning slice: Slice 3.

Proof: focused test in the existing Hermes E2E project plus the existing VM
HTTP-mediation lane. No new test suite or protocol harness.

Layer: real VM E2E.

Evidence source: parent-run no-skip evidence.

Freshness guard: exact built HEAD, pinned Hermes inputs, fresh VM identities.

### P6 — Beta and PR terminal

Requirement: exact-HEAD beta proves `clawfest` and `beta` connect, message/tag
one another, and reconnect after Gateway restart; the PR is freshly ready but
not merged.

Owning slices: Slices 3 and 4.

Proof: beta artifact provenance, validation/doctor/build, two fresh Discord
journeys before and after restart, bounded negative scans, implementation
review, CI/check/thread/mergeability refresh.

Layer: deployment acceptance and PR/release gate.

Evidence source: parent-verified beta/Discord/runtime evidence and GitHub state.

Freshness guard: beta package inputs and remote branch match final HEAD.

## Slice 1 — Replace Host Boot Staging With Seeded RAM

Behavior:

- add one narrow backend-neutral finalizable-memory mount contract with a
  complete one-shot file inventory: normalized relative path, contents, and
  explicit mode;
- validate paths, duplicates, modes, and supported content types in
  `managed-vm`; do not expose Gondolin provider types;
- declare separate environment and structured-input memory mounts;
- teach the Gondolin adapter to bind empty `MemoryProvider` instances during
  `VM.create`, populate each exactly once before `VM.start`, expose only the
  environment mount as guest-writable for unlink, and expose the structured
  mount as guest-read-only;
- replace the host filesystem boot-input reservation/finalization path with a
  pure in-memory serializer;
- remove obsolete reservation, identity, cleanup, and host-directory tests
  rather than retaining a compatibility path;
- preserve the current VM-create-before-identity ordering: create the unstarted
  VM, attach its identity, build the complete cohort-dependent inventory,
  finalize both memory mounts, then allow VM start;
- change managed Gateway init to use structured inputs directly from the
  read-only memory mount, source each environment script from the writable
  memory mount, require unlink success, then `exec` the service;
- keep VM-global `request.environment` free of raw mapped values.

Likely write surfaces:

- `packages/managed-vm/src/managed-vm-contracts.ts`
- focused managed-VM contract tests
- `packages/gondolin-vm-adapter/src/managed-vm-provider.ts`
- `packages/gondolin-vm-adapter/src/vm-adapter.ts`
- focused Gondolin adapter tests
- `packages/agent-vm/src/gateway/managed-gateway-boot-input-materializer.ts`
- its focused tests
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- focused orchestrator integration tests
- `packages/gondolin-vm-adapter/src/rootfs-init-extra.ts`
- managed Gateway image boot fixtures/tests

Checkpoint:

- P2 and P3 pass;
- parent inspects the create/finalize/start sequence and confirms no boot-input
  host path or VM-global raw value remains.

Split/replan trigger:

- Gondolin cannot populate the bound `MemoryProvider` before VM start without
  an upstream change;
- a service requires a runtime structured input outside the mounted RAM path.

## Slice 2 — Finish The Existing Hermes Adapter Flow

Behavior:

- retain the implemented `discordBotTokenSecretsByAgent` schema and safe
  agent/profile/source-name projection;
- retain exact RAM-shadowed profile `.env` paths over direct Hermes RealFS;
- validate that mapped profile config includes `DISCORD_BOT_TOKEN` in
  `secrets.preserve_existing`;
- retain value-free rejection of durable root or mapped-profile `.env`;
- keep the existing adapter responsible for capture, canonical `0600`
  no-follow write, source-name removal, and stock Hermes startup;
- do not register a SecretSource or intercept Hermes caches;
- keep other application/provider credentials HTTP-mediated.

Likely write surfaces:

- existing dirty config/lifecycle/profile-materialization files and tests
- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py`
- its focused Python tests
- concise config reference/manual updates already in the scoped diff

Checkpoint:

- P1 and P4 pass;
- parent inspects that raw values occur only in the resolved boot environment,
  never controller-authored JSON or safe mapping diagnostics.

Split/replan trigger:

- stock Hermes does not honor `secrets.preserve_existing` for the RAM `.env`;
- profile config cannot be validated without resolving or rewriting external
  secrets.

## Slice 3 — Real VM And Beta Acceptance

Behavior:

- update the existing focused Hermes E2E to assert RAM boot staging, exact
  profile files, durable-lower absence, rotation across two boots, and bounded
  canary exclusion;
- assert mapped Discord source names and canary values are absent from the
  running Tool Portal environment and the Tool VM request/environment boundary;
- rely on the dedicated VM mediation lane for actual HTTP substitution rather
  than duplicating a fake mediation server in the Hermes test;
- synchronize exact-HEAD packages/wheels into `shravan-claw-beta`;
- update only intended beta Hermes mapping/configuration;
- remove only known beta legacy durable `.env` files before startup;
- run beta validation/build/doctor, then start Hermes;
- prove both Discord identities before and after supported Gateway restart.

Checkpoint:

- P5 and the beta portion of P6 pass with exact artifact provenance.

Split/replan trigger:

- unrelated runner, credential, host-capacity, or infrastructure failure blocks
  the proof; report it without editing that layer;
- bot-authored Discord messages are ignored by platform policy: use fresh
  operator-to-profile turns whose replies tag the other bot, preserving the
  accepted user-visible journey.

## Slice 4 — Review And PR Readiness

Run a bounded implementation review, validate every finding against source and
proof, address only accepted in-scope findings, commit and push scoped changes,
then refresh PR checks, comments, threads, mergeability, and exact remote head.
Do not merge.

Checkpoint: the PR portion of P6 passes.

## Execution DAG

```text
gate 0: reviewed spec + exact source state + unrelated WIP excluded
  |
  v
Slice 1: finalizable RAM boot-input hard cut
  |
  +-- P2/P3 red -> green
  |
  v
Slice 2: finish Hermes mapping/profile RAM flow
  |
  +-- P1/P4 red -> green
  |
  v
integration gate: parent inspects the combined custody path
  |
  v
Slice 3: real VM proof -> exact-HEAD beta Discord acceptance
  |
  v
Slice 4: implementation review -> PR readiness, not merged
```

The two implementation slices are parent-serial because both meet in Gateway
boot requirements and E2E fixtures. Test execution and later review may run in
parallel.

## Validation Gates

Iteration:

- targeted `managed-vm`, Gondolin adapter, boot-input serializer, rootfs-init,
  Hermes lifecycle, config, and Python adapter tests;
- `pnpm fmt:check`, `pnpm lint`, `pnpm lint:types`, and `pnpm typecheck`.

Integration:

- focused Gateway orchestrator integration;
- focused host E2E for Hermes profile preflight;
- built-CLI manual update smoke.

Real runtime:

- managed Gateway image boot E2E;
- `mise exec -- pnpm test:e2e:vm-mediation`;
- focused no-skip `mise exec -- pnpm test:e2e:hermes`.

Terminal:

- `pnpm check`;
- relevant default non-secret E2E gate or an explicitly scoped blocker;
- exact-HEAD beta acceptance;
- implementation review and PR readiness.

## Security And Rollback

Tests use synthetic canaries and emit only names, booleans, modes, counts, and
digests. Real credentials are resolved only through the existing 1Password
wrapper and never printed.

Rollback is a normal Git revert plus Gateway restart before deployment. There
is no data migration or durable secret state to undo.

## Open Questions

None. Evidence requiring host/guest disk secret staging, VM-global raw
environment, upstream changes, or new lifecycle ownership returns to spec
discussion rather than expanding this plan.
