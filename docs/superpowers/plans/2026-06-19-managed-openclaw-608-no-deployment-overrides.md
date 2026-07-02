# 2026-06-19 Managed OpenClaw 2026.6.8 Without Deployment Overrides Plan

## Goal

Correct the OpenClaw crash-recovery direction so version ownership is clear and
deployments stay simple:

1. `agent-vm` owns the managed OpenClaw runtime line at `2026.6.8`.
2. `shravan-claw` and `shravan-claw-beta` use `2026.6.8` for host-side
   OpenClaw validation packages.
3. Deployment overlays do not carry OpenClaw version pins when they only repeat
   the managed default.
4. The known `undici@8.3.0` hard-crash trigger is fixed by an
   agent-vm-owned, version-scoped managed-base runtime patch. Do not hide that
   risk behind "latest OpenClaw", and do not make beta carry the workaround.
5. Add an easy OpenClaw stability e2e lane that can be run repeatedly against
   the managed gateway path without relying on beta-only Discord credentials.

## Non-Goals

- Do not introduce a new user-facing `packageOverrides` overlay shape in this
  correction.
- Do not ship a deployment-facing `pnpmOverrides` overlay surface. Existing
  dirty-branch support for `pnpmOverrides` must be removed or rewritten as the
  internal managed patch described below.
- Do not keep beta-only OpenClaw package pins as the normal operating model.
- Do not publish or merge as part of this plan.
- Do not claim the original Sunclaw crash is impossible after this change.
- Do not delete unrelated dirty files or generated stores in beta.
- Do not make live Discord credentials required for the generic stability test.
- Do not hard-cut the existing `openClawPackageOverrides` escape hatch in this
  branch. Keep it as the existing advanced version-pin surface, but beta and
  shravan-claw must not use it to restate managed defaults.

## Source Coverage

Read in full:

- `tmp/workflow-state/2026-06-19-openclaw-discord-crash-bcd/details.md`
  - 176 lines, read `1-176`.
- `tmp/workflow-state/2026-06-19-openclaw-discord-crash-bcd/evidence-ledger.md`
  - 197 lines, read `1-197`.
- `docs/superpowers/plans/2026-06-18-openclaw-gateway-crash-recovery.md`
  - 400 lines, read `1-400`.
- `docs/wip/debugging/2026-06-18-openclaw-gateway-crash-recovery.md`
  - 309 lines, read `1-309`.
- `packages/agent-vm/managed-images.json`
  - 19 lines, read fully.
- `shravan-claw/package.json`
  - inspected OpenClaw dev dependency block.
- `shravan-claw/vm-images/gateways/openclaw/overlay.jsonc`
  - read fully; no OpenClaw package pins present.
- `shravan-claw-beta/package.json`
  - inspected OpenClaw dev dependency block.
- `shravan-claw-beta/vm-images/gateways/openclaw/overlay.jsonc`
  - read top-level overlay, including current redundant OpenClaw pins and
    `pnpmOverrides`.
- `shravan-claw-beta/vm-images/tool-vms/default/overlay.jsonc`
  - read top-level overlay, including empty OpenClaw package override field.

Partially inspected for implementation surfaces:

- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
  - schema/load path, OpenClaw package resolution path, dependency override
    render path.
- `scripts/sync-local-tarballs-to-deployment.ts`
  - overlay migration/preservation path used by beta tarball sync.
- `packages/agent-vm/src/cli/init-command.ts`
  - generated overlay default shape.
- `packages/agent-vm/src/cli/manual-templates.ts`
  - generated deployment manual wording.
- `packages/agent-vm/src/cli/build-command.integration.test.ts`
  - managed overlay and package-plan assertions.
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`
  - managed version and generated Dockerfile assertions.
- `scripts/sync-local-tarballs-to-deployment.unit.test.ts`
  - beta overlay preservation assertions.
- `package.json`
  - existing e2e scripts include `test:e2e:openclaw`.
- `scripts/run-e2e-proof-lanes.ts`
  - default broad e2e proof currently runs host, VM, and mediation lanes, but
    not OpenClaw.
- `packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts`
  - existing live OpenClaw e2e structure, health-event waiting, controller
    runtime, and harness utilities.

Fresh package metadata checked on 2026-06-19:

- `openclaw@2026.6.8` depends on `undici@8.3.0`.
- `@openclaw/discord@2026.6.8` depends on `undici@8.3.0`.
- `@openclaw/codex@2026.6.8` depends on `@openai/codex@0.139.0`.

## Current Live State

- `agent-vm` currently has `packages/agent-vm/managed-images.json`
  `openClawVersion: "2026.6.8"` and `openAiCodexCliVersion: "0.139.0"`.
- `shravan-claw` package dev dependencies still pin:
  `openclaw`, `@openclaw/codex`, and `@openclaw/discord` to `2026.5.20`.
- `shravan-claw` OpenClaw gateway overlay has no OpenClaw package version pins.
- `shravan-claw-beta` package dev dependencies already pin:
  `openclaw`, `@openclaw/codex`, and `@openclaw/discord` to `2026.6.8`.
- `shravan-claw-beta` OpenClaw gateway overlay currently has redundant
  `openClawPackageOverrides` for the `2026.6.8` line plus `pnpmOverrides` for
  `undici@8.5.0`.
- The reproduced crash class is removed only when OpenClaw runtime packages
  resolve `undici@8.5.0`; plain OpenClaw `2026.6.8` still resolves
  `undici@8.3.0`.

## Design Decision

Use this ownership model:

```text
agent-vm managed-images.json
  owns OpenClaw runtime line: 2026.6.8
  owns Codex CLI companion: 0.139.0
  owns version-scoped managed-base crash patches

deployment package.json
  owns host-side validation OpenClaw packages

deployment overlay.jsonc
  owns apt packages, copies, and post-base commands
  does not restate the managed OpenClaw version
  does not carry transitive dependency patches
```

Do not make beta carry the OpenClaw version as an overlay override just because
we are testing the managed default. The generated Dockerfile plan should show
OpenClaw packages coming from `managed-default`, not from `overlay`.

For the `undici` crash, use one implementation branch:

1. Move the `undici@8.5.0` workaround into agent-vm as a managed-base runtime
   patch. This keeps deployment overlays clean while still removing the
   reproduced trigger.
2. Reject deployment overlay `pnpmOverrides` with an actionable error. The beta
   legacy field must be removed; tarball sync must not preserve it.
3. Keep `openClawPackageOverrides` only as the existing advanced runtime package
   version-pin escape hatch. It is not a transitive dependency patch surface and
   must not appear in shravan-claw or beta when it only repeats the managed
   default.

Use this manifest-backed patch shape in `packages/agent-vm/managed-images.json`
so the decision is visible, version-scoped, and reviewable:

```json
{
  "schemaVersion": 1,
  "openClawVersion": "2026.6.8",
  "openAiCodexCliVersion": "0.139.0",
  "openClawRuntimeDependencyPatches": [
    {
      "packageName": "undici",
      "version": "8.5.0",
      "appliesToOpenClawVersions": ["2026.6.8"],
      "reason": "Avoid the reproduced Node/undici assert(!this.paused) hard crash in OpenClaw 2026.6.8 runtime packages.",
      "removeWhen": "Fresh package evidence shows openclaw and installed @openclaw/* companions no longer resolve or bundle vulnerable undici@8.3.0."
    }
  ]
}
```

Guardrails:

- The first managed runtime dependency patch is only `undici@8.5.0` for
  `openClawVersion: "2026.6.8"`.
- The schema accepts exact package names and exact versions only.
- The generator fails closed if a patch does not include the active
  `managedImageRelease.openClawVersion` in `appliesToOpenClawVersions`.
- The generated Dockerfile plan exposes dependency patches with a source, for
  example `overrides undici@8.5.0[managed-images.json]`.
- The patch work happens during image build through generated Dockerfile `RUN`
  steps; runtime gateway startup remains a normal supervised OpenClaw launch.

## Requirements / Proof Matrix

| Requirement / claim | Owning task | Proof owner | Proof gate | Layer | Stale-proof guard | Red/green required | Sized for scope |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Managed OpenClaw version is owned by `agent-vm`, not beta overlay pins. | Task 1, Task 3 | implementer | Generated Dockerfile plan/source assertions show `openclaw`, `@openclaw/codex`, `@openclaw/discord` from `managed-default` when no deployment override is present. | unit/integration | Inspect `managed-images.json` and generated plan after edits. | yes | yes |
| `shravan-claw` host validation packages are updated from `2026.5.20` to `2026.6.8`. | Task 4 | implementer | `shravan-claw/package.json` and lockfile show all three OpenClaw dev dependencies at `2026.6.8`; a real install refreshes `node_modules`; `pnpm exec openclaw --version` and `pnpm validate` use the installed `2026.6.8` CLI. | static/integration | Run from real `shravan-claw` checkout and report pre-existing untracked docs separately. | no, package update proof is static plus installed-binary validate | yes |
| `shravan-claw-beta` has no redundant OpenClaw version overrides. | Task 5 | implementer | Beta OpenClaw gateway overlay has no `openClawPackageOverrides`, no `pnpmOverrides`, and no replacement OpenClaw version pin when it repeats managed default. | static | Check beta git status before writes; preserve unrelated config changes. | no | yes |
| Crash trigger is not reintroduced in the rebuilt beta image. | Task 2, Task 5 | implementer | Built image inspection proves `openclaw` and `@openclaw/discord` resolve `undici@8.5.0`; `@openclaw/codex` has no vulnerable bundled `undici` path. | runtime image inspection | Re-run after `pnpm dev:sync-tarballs` and beta `mise exec -- pnpm build`. | yes for managed patch branch | yes |
| Gateway child crashes are contained without hiding sustained crash loops. | Existing change, Task 6 | implementer | Existing supervisor tests continue to pass and logs show restart-limit escalation behavior. | host e2e/static | Run from current crash-fix checkout after rebasing plan changes. | yes | yes |
| No meaningful startup slowdown is added. | Task 2, Task 5 | implementer | Patch/install/relink work happens during image build; runtime startup command remains a normal OpenClaw launch plus supervisor. | static/runtime smoke | Inspect Dockerfile lines and beta boot log timestamps if needed. | no, proof is structural | yes |
| OpenClaw managed gateway has an easy repeatable stability e2e. | Task 5A | implementer | New `.openclaw.e2e.test.ts` boots a real managed OpenClaw gateway, exercises a small non-secret control-plane workload, repeatedly probes controller health/readiness/liveness for a bounded interval, consumes durable health events across the run, scans boot/runtime logs for crash signatures, and fails on any unexpected post-readiness restart or recovery event. | e2e/openclaw | Run `mise exec -- pnpm test:e2e:openclaw -- packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts` and record iterations/duration. | deterministic red/green for crash-signature/event classification; e2e is acceptance proof | yes |
| Beta proves the corrected ownership model locally. | Task 5 | implementer | `pnpm validate`, `mise exec -- pnpm build`, controller health, zone health, and image inspection pass in beta. | integration/smoke/runtime | Re-sync local tarballs before beta proof; do not trust stale beta package pins. | no durable red phase for live beta | yes |
| Real Discord post-rebuild stress proof is either completed or reported blocked without blocking PR readiness. | Task 7 | implementer | Send repeated messages in a private test Discord channel, capture message ids, zone health, and crash-signature scan; or record private bot-auth blocker. | e2e/live service | Use same controller boot for sends and log scans. | no durable red phase for live Discord | yes if private bot auth unlocks |

## Task Sequence

### Task 1: Normalize Managed OpenClaw Ownership In Agent-VM

Keep `packages/agent-vm/managed-images.json` on:

```json
{
  "schemaVersion": 1,
  "openClawVersion": "2026.6.8",
  "openAiCodexCliVersion": "0.139.0",
  "openClawRuntimeDependencyPatches": [
    {
      "packageName": "undici",
      "version": "8.5.0",
      "appliesToOpenClawVersions": ["2026.6.8"],
      "reason": "Avoid the reproduced Node/undici assert(!this.paused) hard crash in OpenClaw 2026.6.8 runtime packages.",
      "removeWhen": "Fresh package evidence shows openclaw and installed @openclaw/* companions no longer resolve or bundle vulnerable undici@8.3.0."
    }
  ]
}
```

Then adjust code/tests/docs so `2026.6.8` is treated as the managed default,
not as something beta has to restate in an overlay.

Likely touched files:

- `packages/agent-vm/managed-images.json`
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`
- `packages/agent-vm/src/cli/build-command.integration.test.ts`
- `packages/agent-vm/src/cli/build-command.ts`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `docs/getting-started/openclaw-guide.md`
- `docs/reference/validate-and-doctor.md`

### Task 2: Move The Undici Fix Out Of Deployment Overlays

Recommended implementation:

- Remove the public flat `pnpmOverrides` overlay surface added during the debug
  lane from schema, docs, manuals, generated manual tests, build tests, and beta
  sync preservation tests.
- Reject any remaining overlay `pnpmOverrides` field with an actionable error:
  "pnpmOverrides is not supported in deployment overlays; update the agent-vm
  managed release or remove the stale beta workaround."
- Do not add public `packageOverrides` for this release.
- Add the manifest-backed `openClawRuntimeDependencyPatches` field described in
  the design decision above.
- Extend `ManagedDockerfileDependencyOverridePlanEntry` with `source`, reusing
  the package-plan source vocabulary. Managed patches should render as
  `source: "managed-images.json"` and CLI output should print
  `overrides undici@8.5.0[managed-images.json]`.
- Feed the existing package-json install/relink mechanism from the managed
  release patch data instead of deployment overlay data. Preserve the
  `pnpm install --prod --ignore-scripts` build-time path and bundled dependency
  relink behavior.
- Add fail-closed guards:
  - unsupported patch package names fail for this release;
  - non-exact versions fail;
  - a patch whose `appliesToOpenClawVersions` does not include the active
    `managedImageRelease.openClawVersion` fails;
  - a future `openClawVersion` bump must either remove the patch or update the
    patch decision explicitly.
- Add a generated Dockerfile secret-boundary audit that rejects auth-token env
  names, auth files, `_authToken`, `_password`, `_secret`, `.npmrc`,
  `.docker/config.json`, `.netrc`, `ARG`/`ENV` token plumbing, and similar
  forbidden patterns.

Likely touched files:

- `packages/agent-vm/managed-images.json`
- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`
- `packages/agent-vm/src/cli/build-command.integration.test.ts`
- `packages/agent-vm/src/cli/build-command.ts`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`
- `docs/getting-started/openclaw-guide.md`
- `docs/reference/configuration/system-json.md`

Removal condition:

- Remove the managed patch when fresh package evidence shows OpenClaw and
  installed `@openclaw/*` companions no longer resolve or bundle vulnerable
  `undici@8.3.0`. A release that changes `openClawVersion` without revisiting
  the patch should fail a unit guard rather than silently carrying the patch
  forward.

### Task 3: Clean Generated Overlay Defaults And Sync Behavior

Keep deployment overlays focused on deployment additions:

```jsonc
{
  "schemaVersion": 1,
  "extraAptPackages": [],
  "copy": [],
  "runAfterBase": []
}
```

Do not emit empty OpenClaw package override arrays from newly generated overlays
unless schema compatibility requires them. If compatibility requires the field,
do not treat it as an active version pin.

Update beta tarball sync so it does not preserve redundant OpenClaw package
version pins that only repeat the current managed default. It should preserve
real deployment-owned overlay additions such as apt packages, local tarball copy
entries, and `runAfterBase`.

Normalization rule:

- Tarball sync must resolve the checked-out agent-vm managed release from
  `packages/agent-vm/managed-images.json`.
- Strip `openClawPackageOverrides` only when the override set resolves to the
  exact managed-default OpenClaw runtime graph for this release.
- Preserve true custom OpenClaw package pins, including partial or non-default
  package/version choices.
- Remove stale beta `pnpmOverrides` instead of preserving it. The build path
  rejects any remaining `pnpmOverrides`, so sync must not keep generating that
  invalid state.

Likely touched files:

- `packages/agent-vm/src/cli/init-command.ts`
- `packages/agent-vm/src/cli/init-command.integration.test.ts`
- `scripts/sync-local-tarballs-to-deployment.ts`
- `scripts/sync-local-tarballs-to-deployment.unit.test.ts`

Required sync tests:

- exact managed-default `openClawPackageOverrides` is removed.
- non-default `openClawPackageOverrides` is preserved.
- partial custom `openClawPackageOverrides` is preserved.
- stale beta `pnpmOverrides` is removed and never re-rendered.

### Task 4: Update Shravan-Claw Host Validation Packages

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw`:

- Update dev dependencies:
  - `openclaw` to `2026.6.8`
  - `@openclaw/codex` to `2026.6.8`
  - `@openclaw/discord` to `2026.6.8`
- Refresh `pnpm-lock.yaml`.
- Confirm the gateway overlay remains free of OpenClaw version pins.

Validation:

```text
pnpm install
pnpm exec openclaw --version
pnpm validate
```

If validation requires the updated agent-vm package before publication, record
that as a dependency rather than forcing unrelated changes into `shravan-claw`.

### Task 5: Update Shravan-Claw Beta To Consume Managed Defaults

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`:

- Remove redundant OpenClaw version pins from
  `vm-images/gateways/openclaw/overlay.jsonc`.
- Remove the beta-only `pnpmOverrides` workaround. Task 2 moves the patch into
  agent-vm managed image generation, and the overlay field is invalid after this
  branch.
- Keep beta package dev dependencies at `2026.6.8`.
- Re-sync local agent-vm tarballs from this checkout.

Validation:

```text
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
pnpm validate
mise exec -- pnpm build
```

Runtime proof:

```text
curl -fsS http://127.0.0.1:18900/health
curl -fsS http://127.0.0.1:18900/zones/beta/health
```

Image inspection proof:

```text
openclaw -> undici@8.5.0
@openclaw/discord -> undici@8.5.0
@openclaw/codex -> no vulnerable bundled undici path
```

There is no checked-in built-image package-version inspection helper today. Add
one as part of this task or Task 5A rather than relying on manual notes. It can
be a small host/e2e helper that runs package-resolution commands inside the
built gateway image and emits stable proof lines for `openclaw`,
`@openclaw/discord`, and `@openclaw/codex`.

### Task 5A: Add A Generic OpenClaw Stability E2E Lane

Add a repo-local stability e2e that proves the managed OpenClaw gateway can stay
healthy under a defined no-secret control-plane envelope without needing
Discord, model tokens, or beta deployment credentials.

Recommended test file:

```text
packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts
```

The test should use the existing OpenClaw e2e harness and run only when
`AGENT_VM_OPENCLAW_E2E=1`, like the current `.openclaw.e2e.test.ts` files. The
authoritative command is:

```text
mise exec -- pnpm test:e2e:openclaw -- packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts
```

Do not require a new script alias for correctness. If a convenience alias is
added, Task 6 must still report the fully expanded command above.

Concrete implementation skeleton:

```typescript
const architecture = currentE2eArchitecture();
const runOpenClawStability =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawStability = runOpenClawStability ? describe : describe.skip;

const zoneId = 'openclaw-stability';
const agentId = 'stability';
const gatewayToken = 'openclaw-stability-gateway-token';
```

Imports should mirror the existing OpenClaw e2e files:

- `scaffoldOpenClawE2eProject`
- `prepareGatewayE2eProjectImages`
- `startE2eControllerRuntime`
- `removeE2eTempRoot`
- `currentE2eArchitecture`
- `canRunGondolinE2e`
- `useLocalOpenClawPluginGatewayImage`
- `useLocalToolVmMcpPortalPackage`
- `disableOpenClawMcpPortalPlugin` if MCP Portal noise makes the baseline less
  deterministic
- `controllerHealthEventLogPath` and `readDurableHealthEvents`

Setup:

1. Build/prepare a temp managed OpenClaw e2e project through the existing
   harness:

   ```typescript
   project = await scaffoldOpenClawE2eProject({
     agents: [agentId],
     architecture,
     prefix: 'openclaw-stability-e2e-',
     zoneId,
   });
   ```

2. Tune controller health intervals for a short deterministic stability run:

   ```typescript
   systemConfig = {
     ...project.systemConfig,
     controller: {
       health: {
         ...project.systemConfig.controller?.health,
         enabled: true,
         eventHistoryLimit: 200,
         gatewayControlLinkIntervalMs: 1_000,
         gatewayControlLinkBackoffCeilingMs: 2_000,
         gatewayServiceIntervalMs: 1_000,
         staleAfterMs: 20_000,
       },
     },
   };
   ```

3. Prepare images before starting the controller:

   ```typescript
   await useLocalOpenClawPluginGatewayImage({ ... });
   await useLocalToolVmMcpPortalPackage({ ... });
   await prepareGatewayE2eProjectImages({ project });
   ```

4. Start the controller with local smoke secrets only:

   ```typescript
   harness = await startE2eControllerRuntime({
     secrets: {
       GITHUB_TOKEN: 'unused-openclaw-stability-token',
       OPENCLAW_GATEWAY_TOKEN: gatewayToken,
       PERPLEXITY_API_KEY: 'unused-openclaw-stability-perplexity-token',
     },
     startOptions: {
       systemConfig,
       zoneIds: [zoneId],
     },
   });
   ```

5. Teardown must always close the harness and remove the temp root:

   ```typescript
   await harness?.close();
   await removeE2eTempRoot(project.tempRoot);
   ```

6. If the test needs in-guest log tails or `gatewayVmId`, explicitly wrap the
   gateway start path and retain the `ManagedVm`/start metadata, following the
   existing control-link e2e pattern. If the harness cannot expose a stable VM
   handle without broad refactoring, remove the in-guest tail and `gatewayVmId`
   from the required proof output and rely on host runtime logs plus durable
   health events.

Probe loop:

- Default local quick mode:
  - `AGENT_VM_OPENCLAW_STABILITY_DURATION_MS` default `180000`
  - `AGENT_VM_OPENCLAW_STABILITY_INTERVAL_MS` default `3000`
  - `AGENT_VM_OPENCLAW_STABILITY_ITERATIONS` optional override
- Short CI/debug mode may set duration to `60000`.
- Long local burn-in may set duration to `900000` or higher.

Each iteration must call the controller surface, not only ingress:

```text
GET ${controllerUrl}/health
GET ${controllerUrl}/zones/${zoneId}/health
GET ${controllerUrl}/zones/${zoneId}/service-health
GET ${controllerUrl}/zones/${zoneId}/health-snapshot
```

Pass criteria per iteration:

- controller `/health` is HTTP 200 and body `ok: true`.
- zone `/health` is HTTP 200 and body `ok: true`.
- zone `/service-health` is HTTP 200 and body `ok: true`.
- health snapshot is HTTP 200 and its discriminator is `kind: "ok"`.
- health snapshot has no current recovery blocker and no latest event showing a
  failed gateway recovery.

Failure handling:

- Fail immediately on any non-2xx response after including response body.
- Fail immediately on `ok !== true`.
- Fail immediately if durable health events observed after initial readiness
  contain:
  - any `gateway-recovery` event, even if later probes recover
  - any post-readiness gateway child exit/restart signal
  - `gateway-recovery` with `result: "failed"`
  - `gateway-service-health` with sustained non-ok result beyond one retry
  - `gateway-control-link` sustained non-ok result beyond one retry
- Allow one transient `ECONNRESET` or `ECONNREFUSED` during startup only before
  initial readiness is established; after initial readiness, any transport
  error fails the run.

Use a named helper in the test file, for example:

```typescript
interface StabilityProbeResult {
	readonly iteration: number;
	readonly controllerOk: boolean;
	readonly zoneOk: boolean;
	readonly serviceOk: boolean;
	readonly snapshotOk: boolean;
	readonly elapsedMs: number;
}

async function runStabilityProbeIteration(...): Promise<StabilityProbeResult> {
	// Fetch the four endpoints above with AbortSignal.timeout(5_000).
}
```

Avoid raw sleeps where there is an event source. For the bounded interval between
successful probes, use the repo's e2e protocol wait helper or add a named local
helper such as `waitForStabilityProbeInterval()` with a comment explaining that
this is the deliberate burn-in cadence.

Workload:

- The generic lane must do more than passive final-state polling. Add at least
  one repeated no-secret control-plane operation from the existing live OpenClaw
  e2e patterns, such as runtime-status publishing or a lease create/renew/release
  cycle that does not require model or Discord credentials.
- If only health/readiness probes are implemented in the first slice, name the
  proof honestly as "idle/control-plane health-probe stability" and do not claim
  it covers Discord conversation crashes.

Log and health-event scan:

After the probe loop, inspect:

```text
${systemConfig.runtimeDir}/zones/${zoneId}/logs/gateway-boot-latest.log
controllerHealthEventLogPath(systemConfig.runtimeDir)
```

The test must consume `controllerHealthEventLogPath(systemConfig.runtimeDir)`
incrementally or record a baseline offset after initial readiness, then fail on
any post-readiness recovery/restart/health degradation events. This closes the
gap where the child could crash and recover between endpoint probes.

The test may also ask the gateway VM to read the in-guest boot log when a probe
fails, but only if setup retained a stable VM handle as described above.

Failure signatures should include at least:

```text
assert(!this.paused)
AssertionError [ERR_ASSERTION]
gateway-supervisor: openclaw gateway exited
gateway-supervisor: restart limit exceeded
ECONNRESET bursts above threshold
zone health not ok
```

Important: `undici` alone is not a failure string because normal dependency
paths may mention it. Only fail on `undici` when it appears near assertion,
socket, parser, or process-exit signatures.

Final proof output:

The test should print or include in assertion failures:

```text
OpenClaw stability proof:
  durationMs=<number>
  iterationsAttempted=<number>
  iterationsPassed=<number>
  controllerUrl=<url>
  zoneId=openclaw-stability
  gatewayVmId=<id if available>
  childRestartEvents=<number>
  restartLimitExceeded=<true|false>
  crashSignatureMatches=<number>
```

Pass criteria for the whole test:

- initial readiness established within 90 seconds
- all stability iterations pass
- no `assert(!this.paused)` or `AssertionError [ERR_ASSERTION]` in scanned logs
- no `gateway-supervisor: restart limit exceeded`
- `gateway-supervisor: openclaw gateway exited` count is zero in the generic
  stability test
- no post-readiness durable `gateway-recovery` event
- no post-readiness durable gateway-service or gateway-control-link failure
  event that exceeds the allowed single retry
- final controller health and zone health are `ok: true`

If we want a separate supervisor recovery test, keep it separate from this
stability test. The existing control-link e2e already kills/stops the gateway
to prove restart and VM recovery behavior; the generic stability e2e should
prove no unexpected crash/restart under normal probes.

Keep this test generic:

- no Discord token required
- no model provider token required
- no external LLM call required
- no beta deployment path required
- no wall-clock sleeps between probes when an event/protocol wait exists; if a
  bounded interval is necessary, use the repo's named e2e protocol wait helper
  rather than importing raw timers in the test file

Optional convenience alias after the test exists:

```json
"test:e2e:openclaw:stability": "AGENT_VM_OPENCLAW_E2E=1 tsx scripts/run-vitest-evidence-project.ts e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts"
```

Do not add this stability lane to the default `pnpm test:e2e` runner until its
runtime cost is measured. The default broad runner currently excludes OpenClaw;
keep that boundary unless the measured cost is acceptable.

Optional extended local burn-in:

```text
AGENT_VM_OPENCLAW_STABILITY_DURATION_MS=900000 mise exec -- pnpm test:e2e:openclaw -- packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts
```

Proof output must report:

- iterations attempted
- iterations passed
- total duration
- gateway VM id
- whether any child restart event occurred
- crash-signature scan result
- controller health and zone health final state

Red/green rule:

- Add deterministic unit/integration coverage for crash-signature and durable
  health-event classification, and watch that fail/pass around the helper
  implementation.
- Treat the live OpenClaw stability e2e as acceptance proof for the defined
  envelope. Do not claim an e2e red phase unless the live runtime actually
  reproduces a failure.

### Task 6: Re-run Supervisor And Quality Gates

The existing bounded OpenClaw child supervisor is still required even after the
dependency fix because it contains future hard child crashes.

Run:

```text
pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
pnpm vitest run packages/agent-vm/src/build/managed-image-release.unit.test.ts
pnpm vitest run packages/agent-vm/src/cli/build-command.integration.test.ts -t "managed base"
pnpm vitest run packages/agent-vm/src/cli/manual-templates.unit.test.ts
pnpm vitest run scripts/sync-local-tarballs-to-deployment.unit.test.ts
mise exec -- pnpm test:e2e:openclaw -- packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm check
git diff --check
```

If `pnpm check` reports warnings but exits `0`, report warnings separately from
errors.

### Task 7: Complete Or Bound The Live Discord Proof

After beta is rebuilt with clean overlays and the managed runtime patch, run the
real Discord conversation proof only if the private test Discord bot credential
is readable.

Proof envelope:

- send repeated messages to the private test Discord channel
- capture sent message ids and bot replies
- check controller health and zone health after messages
- scan logs for `assert(!this.paused)`, qualified `undici` crash context,
  gateway child exits, and supervisor restart-limit events. Do not fail on a
  benign `undici` package/path mention by itself.

If private bot authorization still times out, do not call the Discord proof done.
Report the beta non-Discord proof and leave Task 7 blocked without blocking PR
readiness, provided every required non-Discord proof gate is green.

## Validation Gates By Layer

Unit/static:

- managed image release tests
- init overlay tests
- sync tarball overlay tests
- doctor/config validation tests touched by version hints
- generated manual tests proving deployment docs do not teach public
  `pnpmOverrides`
- generated Dockerfile secret-pattern audit for OpenClaw managed images
- `pnpm fmt:check`
- `pnpm lint`
- `pnpm typecheck`
- `git diff --check`

Integration:

- build-command integration tests for managed-default package source
- build-command integration tests for managed dependency patch source output
- `pnpm validate` in beta
- `pnpm exec openclaw --version` and `pnpm validate` in shravan-claw after a
  real `pnpm install`

Host e2e / runtime:

- OpenClaw lifecycle host e2e for supervisor behavior
- generic OpenClaw stability e2e for repeated health/readiness probes and
  crash-signature scans
- beta `mise exec -- pnpm build`
- beta controller health and zone health
- image package-resolution inspection

Live service:

- Discord channel/bot stress proof, only when the private bot credential is
  available.

## Security Assumptions

- No secrets are baked into gateway images.
- The managed runtime patch may alter package resolution only for OpenClaw
  runtime dependencies, not arbitrary deployment secrets or auth flows.
- Deployment overlays may not declare transitive dependency patches through
  `pnpmOverrides`.
- The managed patch is version-scoped to OpenClaw `2026.6.8`; future OpenClaw
  managed-version changes must revisit or remove it.
- Private Discord bot credentials are used only for live proof and are never
  copied into repo config, generated Dockerfiles, PR docs, or committed plans.
- Tarball sync must not write deployment config outside the deployment overlay,
  package manifest, lockfile, and generated local tarball copy surfaces.
- Dockerfile generation must continue to reject unsafe copy paths and unpinned
  package specs.
- Generated OpenClaw Dockerfiles must not contain auth-token env names, auth
  files, `.npmrc`, `.docker/config.json`, `.netrc`, `_authToken`, `_password`,
  `_secret`, or build-time token plumbing.

## Risks

- If the managed runtime patch is removed or fails validation, OpenClaw
  `2026.6.8` still carries `undici@8.3.0`, and the reproduced crash trigger
  remains.
- Moving the patch from overlay to managed generation can hide the fix unless
  the generated plan exposes it clearly with
  `overrides undici@8.5.0[managed-images.json]`.
- Removing overlay version pins may make beta look less explicit; the generated
  build plan and docs must make the managed default visible.
- `shravan-claw` has unrelated untracked docs; implementation must not clean or
  overwrite them.
- `shravan-claw-beta` is dirty from prior beta work; implementation must isolate
  the overlay/package changes and report unrelated dirt separately.

## Rollback / Recovery

- If managed OpenClaw `2026.6.8` fails validation, revert only the managed
  version/host package updates and preserve the supervisor containment work if
  its tests still pass.
- If the internal managed runtime patch breaks image build, stop and report the
  blocker. Do not restore a beta overlay `pnpmOverrides` workaround as the
  normal branch state.
- If beta runtime proof fails after overlay cleanup, compare generated build
  plans before and after cleanup to determine whether the failure came from
  version ownership, the managed patch, or unrelated beta config.
- If the generic OpenClaw stability e2e is too slow for routine local use, keep
  it as an opt-in script and publish its measured runtime in the plan closeout
  instead of weakening the proof.
- Stop beta with `pnpm stop` or `pnpm force-stop` after proof unless the user
  explicitly wants the controller left running.

## Decisions And PR-Ready Terminal

- Decision: accept the `undici@8.5.0` mitigation as an internal
  agent-vm-managed runtime patch for OpenClaw `2026.6.8`.
- Decision: reject public deployment overlay `pnpmOverrides`.
- Decision: keep existing `openClawPackageOverrides` as an advanced runtime
  package version-pin escape hatch, but do not use it in shravan-claw or beta
  when it only repeats the managed default.
- Decision: default local stability envelope is the short smoke
  (`180000` ms, 3 second probe cadence). Medium and long burn-ins are opt-in
  via environment variables.

PR-ready means:

- agent-vm branch implements Tasks 1, 2, 3, 5A, and 6 with all listed proof
  gates run or explicitly blocked by environment prerequisites.
- shravan-claw package dependencies are updated to `2026.6.8`, installed, and
  validated with `pnpm exec openclaw --version` plus `pnpm validate`, or the
  validation dependency on unpublished agent-vm packages is recorded plainly.
- shravan-claw-beta consumes clean managed defaults without
  `openClawPackageOverrides` repeating managed versions and without
  `pnpmOverrides`; beta build/health/image-inspection proof passes.
- The generic OpenClaw stability e2e passes under the short envelope.
- Task 7 live Discord proof is completed if the private bot credential is
  readable. If that credential remains unavailable, PR readiness is still
  allowed when Task 7 is explicitly marked blocked with the private auth blocker
  and all non-Discord gates above are green.
- A PR is opened or updated, implementation review findings are addressed or
  explicitly rejected with evidence, checks are reported, and merge is left out
  of scope until separately authorized.

## Recommended Next Workflow

Use `shravan-dev-workflow:plan-review-swarm` before execution because the plan
touches package resolution, image generation, deployment configs, and live beta
proof.

After review, use `shravan-dev-workflow:implementation-execute-plan`.
