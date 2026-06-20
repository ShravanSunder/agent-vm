# Per-Image Package Overrides Plan

## Goal

Implement a clean per-image package override model for managed Agent VM images and
deployment overlays.

The design goal is to replace one-off flat package fields with a single
package-override vocabulary that applies at the image profile boundary:

- managed defaults live per managed base image in `packages/agent-vm/managed-images.json`;
- deployment overrides live per image profile in that profile's `overlay.jsonc`;
- build output, validation, doctor/manual docs, and image inspection make the
  effective package set visible before anyone debugs Docker output or runtime
  logs.

## Non-Goals

- Do not add top-level `system.jsonc.packageOverrides`; package overrides are
  not deployment-global.
- Do not add `imageProfiles.gateways.<name>.packageOverrides` or
  `imageProfiles.toolVms.<name>.packageOverrides`; `system.jsonc` remains the
  pointer to the per-profile overlay file.
- Do not make one gateway profile's package policy affect another gateway
  profile.
- Do not remove managed OpenClaw/undici protection; make it clean,
  inspectable, and overridable at the per-image overlay level.
- Do not change the unrelated secret/auth model.
- Do not publish or update `shravan-claw` / `shravan-claw-beta` in this plan
  creation step.

## Source Coverage

This plan is based on chat design decisions from 2026-06-20 and the following
live repo evidence:

- `packages/agent-vm/src/build/managed-image-dockerfile.ts` has 956 lines.
  Read relevant chunks covering:
  - release and overlay schemas;
  - current `openClawPackageOverrides`;
  - current `openClawRuntimeDependencyPatches`;
  - current `openAiCodexCliVersion` use;
  - generated Dockerfile plan entries.
- `packages/agent-vm/src/config/system-config.ts` has 1451 lines. Read relevant
  chunks covering `imageProfiles.gateways` and managed-base validation.
- `packages/worker-gateway/src/worker-lifecycle.ts` has 87 lines. Read the
  runtime bootstrap that currently runs `npm install -g --force @openai/codex
  /state/agent-vm-worker.tgz`.
- `docs/reference/configuration/system-json.md` has 1176 lines. Read the
  `imageProfiles` / overlay package override section.
- `packages/agent-vm/managed-images.json` has 28 lines. Read all lines.
- `packages/agent-vm/src/cli/build-command.integration.test.ts` has 3056 lines.
  Located existing build-plan package-output tests.
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts` has 766
  lines. Located existing managed release and overlay tests.
- `scripts/sync-local-tarballs-to-deployment.unit.test.ts` relevant chunks show
  current tarball sync behavior removes stale `pnpmOverrides` and preserves or
  drops `openClawPackageOverrides` depending on managed-default matching.
- `shravan-claw-beta/config/system.jsonc` and
  `shravan-claw-beta/vm-images/gateways/openclaw/overlay.jsonc` confirm the
  current deployment shape: zones choose an image profile, and the image profile
  points at an overlay.

## Current Model

```text
system.jsonc
  imageProfiles.gateways.<profile>
    type: openclaw | worker
    source:
      kind: managedBase
      base: openclaw-gateway | worker-gateway
      overlay: ../vm-images/gateways/<profile>/overlay.jsonc

overlay.jsonc
  extraAptPackages
  copy
  runAfterBase
  openClawPackageOverrides

managed-images.json
  baseImages
  openClawVersion
  openAiCodexCliVersion
  openClawRuntimeDependencyPatches
```

Problems:

- `openClawVersion`, `openAiCodexCliVersion`, and
  `openClawRuntimeDependencyPatches` are flat package decisions beside base image
  metadata.
- `openClawPackageOverrides` is per-overlay but too narrow: it cannot express
  `pnpm` transitive overrides such as `undici`.
- `openAiCodexCliVersion` is a special-case field even though `@openai/codex`
  is just a direct npm package installed into an image.
- Worker gateway bootstrap uses unpinned `npm install -g --force @openai/codex`
  at VM startup, which is slow, non-reproducible, and inconsistent with the
  repo's pnpm-managed image model.

## Target Schema

### Managed Release Manifest

`managed-images.json` should keep `baseImages` as the owner of per-managed-base
metadata. Each base image may include `packageOverrides`.

```jsonc
{
  "schemaVersion": 1,
  "baseImages": {
    "openclaw-gateway": {
      "repository": "ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base",
      "tag": "2026.05.27.1",
      "packageOverrides": {
        "openclaw": [
          "openclaw@2026.6.8",
          "@openclaw/codex@2026.6.8"
        ],
        "npm": [
          "@openai/codex@0.139.0"
        ],
        "pnpm": {
          "undici": "8.5.0"
        }
      }
    },
    "worker-gateway": {
      "repository": "ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base",
      "tag": "2026.05.27.1"
    },
    "tool-vm": {
      "repository": "ghcr.io/shravansunder/agent-vm-managed-tool-vm-base",
      "tag": "2026.05.27.1"
    }
  }
}
```

### Deployment Overlay

`overlay.jsonc` should use the same package override vocabulary, scoped to that
one image profile.

```jsonc
{
  "schemaVersion": 1,
  "extraAptPackages": ["ffmpeg", "bubblewrap"],
  "packageOverrides": {
    "openclaw": [
      "@openclaw/discord@2026.6.8"
    ],
    "npm": [
      "@openai/codex@0.139.0"
    ],
    "pnpm": {
      "undici": "8.5.0"
    }
  },
  "runAfterBase": []
}
```

### Semantics

Canonical schema and normalization owner:

```text
packages/agent-vm/src/build/package-overrides.ts
  owns PackageOverrides TypeScript types
  owns Zod schemas for managed and overlay packageOverrides
  owns exact package-spec parsing and validation
  owns effective-policy merge and source-label metadata
  owns legacy-key rejection helpers

Consumers must import this module instead of reimplementing normalization:
  managed-image-dockerfile.ts
  config-validation.ts
  doctor.ts
  build-command.ts
  sync-local-tarballs-to-deployment.ts
  inspect-openclaw-runtime-image.ts, if it needs policy-aware expectations
```

```text
packageOverrides.openclaw
  Direct OpenClaw runtime package specs:
    openclaw@<version>
    @openclaw/<package>@<version>

packageOverrides.npm
  Direct non-OpenClaw npm package specs installed into the image:
    @openai/codex@<version>
    future image helper CLIs

packageOverrides.pnpm
  Transitive pnpm override map for generated image installs:
    undici: "8.5.0"
```

Precedence:

```text
overlay.jsonc packageOverrides
  > managed-images.json baseImages[base].packageOverrides
  > generated defaults derived from required packages
```

Overlay ownership is closed for this plan:

```text
system.jsonc
  imageProfiles.* stay pointer-only; no inline packageOverrides fields.

overlay.jsonc
  is the only deployment-authored package override surface.
```

Legacy cutover is also closed for this plan:

```text
openClawPackageOverrides
  rejected everywhere with:
  move openClawPackageOverrides to packageOverrides.openclaw

pnpmOverrides
  rejected everywhere with:
  move pnpmOverrides to packageOverrides.pnpm
```

`packageOverrides.npm` is an array of exact package specs. Duplicate package
names merge by package name, with overlay entries replacing managed entries.
Build-plan metadata must preserve exact source labels per bucket and owner path.

Accepted package grammar:

```text
packageOverrides.openclaw[]
  allowed:
    openclaw@<exact-semver>
    @openclaw/<package>@<exact-semver>
  rejected:
    unversioned specs
    ranges
    aliases
    protocol specs such as npm:, git:, file:, link:, workspace:, http:, https:
    non-OpenClaw packages

packageOverrides.npm[]
  allowed:
    <package-name>@<exact-semver>
    @<scope>/<package-name>@<exact-semver>
  rejected:
    unversioned specs
    ranges
    aliases
    protocol specs such as npm:, git:, file:, link:, workspace:, http:, https:
    @agent-vm/* packages

packageOverrides.pnpm
  allowed:
    { "<plain-package-name>": "<exact-semver>" }
  rejected:
    protocol selectors
    alias selectors
    ranges
    nested override selectors unless explicitly added by a later design
```

Lifecycle-script policy:

```text
Override-driven direct npm installs use pnpm with lifecycle scripts disabled by
default.

No package in packageOverrides.npm may run install/postinstall/prepare scripts
unless agent-vm owns an explicit allowlist entry, a reason, and a test that
proves the generated Dockerfile uses the allowlisted path only for that package.
```

Bucket support by managed base:

| Managed base | Supported buckets | Rejected buckets |
| --- | --- | --- |
| `openclaw-gateway` | `openclaw`, `npm`, `pnpm` | none |
| `worker-gateway` | `npm` | `openclaw`, `pnpm` |
| `tool-vm` | `npm` | `openclaw`, `pnpm` |

`pnpm` is supported only for the OpenClaw runtime package root in this plan. If
worker or Tool VM images need transitive package-manager overrides later, that
needs its own install-root design.

OpenClaw compatibility invariants stay separate from the override config shape.
`packageOverrides.pnpm` is how the required package version is expressed and
reported, but a compatibility validator remains responsible for enforcing known
safe minimums by OpenClaw version. For OpenClaw `2026.6.8`, the effective
package policy must include non-vulnerable `undici@8.5.0` or newer according to
the validator; a missing or downgraded overlay value must fail before Docker and
Gondolin work begin.

Channel packages stay config-conditional. `@openclaw/discord` is not installed
globally just because the managed base supports OpenClaw packages; it is required
only when the gateway config enables Discord, or when the overlay explicitly
pins it.

Source labels in generated plans must identify the exact owner:

```text
openclaw@2026.6.8[managed-images.json/packageOverrides.openclaw]
@openclaw/discord@2026.6.8[overlay.jsonc/packageOverrides.openclaw]
@openai/codex@0.139.0[managed-images.json/packageOverrides.npm]
undici@8.5.0[managed-images.json/packageOverrides.pnpm]
undici@8.6.0[overlay.jsonc/packageOverrides.pnpm]
```

## Requirements / Proof Matrix

| Requirement / Claim | Owning Task | Proof Owner | Proof Gate | Layer | Stale-Proof Guard | Red/Green Required | Sized To Pass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Managed package decisions are per managed base image, not flat manifest fields. | Task 1 | implementer | `pnpm vitest run packages/agent-vm/src/build/managed-image-release.unit.test.ts` | unit | Assert `openClawVersion`, `openAiCodexCliVersion`, and `openClawRuntimeDependencyPatches` are absent from parsed manifest/release type. | yes | yes |
| Overlay package overrides are per image profile and support `openclaw`, `npm`, and `pnpm`. | Task 2 | implementer | `pnpm vitest run packages/agent-vm/src/build/managed-image-release.unit.test.ts` | unit | Test two overlays with different package overrides and prove each generated plan stays isolated. | yes | yes |
| `openClawPackageOverrides` hard-cuts to `packageOverrides.openclaw` without silent migration. | Task 2 | implementer | unit tests plus validation error snapshot | unit/integration | Reject legacy key with exact actionable message and prove config validation and tarball sync agree. | yes | yes |
| `pnpmOverrides` becomes supported only through `packageOverrides.pnpm`, not as stale top-level overlay shape. | Task 2 | implementer | `pnpm vitest run packages/agent-vm/src/operations/config-validation.integration.test.ts` | integration | Test stale `pnpmOverrides` error and valid `packageOverrides.pnpm` pass. | yes | yes |
| Generated OpenClaw gateway Dockerfiles install OpenClaw packages, direct npm packages, and pnpm overrides from the effective package policy. | Task 3 | implementer | `pnpm vitest run packages/agent-vm/src/build/managed-image-release.unit.test.ts packages/agent-vm/src/cli/build-command.integration.test.ts` | unit/integration | Inspect generated Dockerfile content and plan output source labels. | yes | yes |
| `@openai/codex` is no longer a flat `openAiCodexCliVersion` field; it is a direct npm package override on the images that need it. | Task 3 | implementer | unit tests for OpenClaw gateway and Worker gateway generated/boot behavior | unit/integration | Assert plan entry source is `packageOverrides.npm`; assert no direct read of `openAiCodexCliVersion`. | yes | yes |
| Known unsafe OpenClaw package combinations still fail even though `undici` is expressed through generic `packageOverrides.pnpm`. | Task 3 | implementer | managed image unit tests plus build-command integration tests | unit/integration | Red tests for OpenClaw `2026.6.8` without `undici`, and with vulnerable/downgraded overlay `undici`. | yes | yes |
| Override-driven installs do not introduce lifecycle-script or secret-bearing Dockerfile regressions. | Task 3 | implementer | generated Dockerfile unit tests and forbidden-pattern assertions | unit/integration | Assert override installs use script-disabled path unless allowlisted; assert generated Dockerfiles do not contain token/auth-file patterns. | yes | yes |
| Worker gateway stops installing unpinned `@openai/codex` with `npm` at runtime. | Task 4 | implementer | `pnpm vitest run packages/worker-gateway/src/worker-lifecycle.unit.test.ts` plus `mise exec -- pnpm test:e2e:worker` | unit/e2e | Assert bootstrap no longer contains `npm install -g --force @openai/codex`; prove worker boots without networked latest fetch and records bounded readiness. | yes | yes |
| Build/doctor/manual output tells users which managed and overlay overrides are active. | Task 5 | implementer | `pnpm vitest run packages/agent-vm/src/cli/manual-templates.unit.test.ts packages/agent-vm/src/operations/config-validation.integration.test.ts packages/agent-vm/src/cli/build-command.integration.test.ts packages/agent-vm/src/operations/doctor.unit.test.ts` | unit/integration | Snapshot source-labeled package plan, doctor output, and generated manual language. | yes | yes |
| Beta/main deployments can test a per-profile OpenClaw/undici override without publishing agent-vm. | Task 6 | implementer | beta sync, build, start, `/health`, `/zones/beta/health`, and targeted generated Dockerfile/plan inspection after implementation approval | smoke/e2e | Use exact beta sync command, boot beta, inspect emitted plan for overlay source labels, then stop cleanly. | yes | yes |
| Crash mitigation remains visible in generated plan output when no overlay override is provided. | Task 7 | implementer | build-command integration test and generated Dockerfile inspection | integration | Inspect generated image plan for `undici@8.5.0` from managed source. | yes | yes |
| Crash mitigation remains active in a built OpenClaw runtime image. | Task 7 | implementer | image inspection script or live OpenClaw e2e lane | e2e/proof | Inspect built runtime for non-vulnerable `undici`; do not count static plan inspection as e2e. | yes | yes |

## Task Sequence

### Task 1: Normalize Managed Manifest Shape

Write surfaces:

- `packages/agent-vm/managed-images.json`
- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/package-overrides.ts`
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`
- `scripts/sync-local-tarballs-to-deployment.ts`
- `scripts/sync-local-tarballs-to-deployment.unit.test.ts`

Steps:

1. Introduce `packages/agent-vm/src/build/package-overrides.ts` as the canonical
   TypeScript/Zod owner for `PackageOverrides`, exact spec parsing,
   normalization, source-label metadata, and legacy-key rejection helpers.
2. Move managed package decisions under `baseImages[base].packageOverrides`.
3. Remove flat managed fields:
   - `openClawVersion`;
   - `openAiCodexCliVersion`;
   - `openClawRuntimeDependencyPatches`.
4. Preserve the current effective defaults:
   - `openclaw@2026.6.8`;
   - `@openclaw/codex@2026.6.8`;
   - `@openai/codex@0.139.0` for OpenClaw gateway;
   - `undici@8.5.0` for OpenClaw gateway pnpm installs.
5. Do not add `worker-gateway.packageOverrides.npm` in this task. Worker package
   policy changes land only in Task 4 after the worker install path is proven.

Proof:

- Add red tests expecting old flat fields to be absent from the parsed release.
- Add green tests for per-base package overrides and source labels.
- Add fixture-driven tests proving Dockerfile generation and tarball sync use
  the same package override normalizer.

### Task 2: Replace Overlay Override Schema

Write surfaces:

- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/package-overrides.ts`
- `packages/agent-vm/src/operations/config-validation.ts`
- `packages/agent-vm/src/operations/config-validation.integration.test.ts`
- `packages/agent-vm/src/cli/init-command.ts`
- `packages/agent-vm/src/cli/init-command.integration.test.ts`
- deployment overlay examples generated by init/migrate tests

Steps:

1. Add `packageOverrides` to `managedImageOverlaySchema`.
2. Support:
   - `packageOverrides.openclaw`;
   - `packageOverrides.npm`;
   - `packageOverrides.pnpm`.
3. Replace current stale `pnpmOverrides` rejection with:
   - valid `packageOverrides.pnpm` acceptance;
   - invalid top-level `pnpmOverrides` rejection with migration guidance.
4. Hard-cut legacy overlay keys:
   - reject `openClawPackageOverrides` with message
     `move openClawPackageOverrides to packageOverrides.openclaw`;
   - reject `pnpmOverrides` with message
     `move pnpmOverrides to packageOverrides.pnpm`.
5. Update init-generated overlays to emit `packageOverrides` only when needed,
   not empty boilerplate unless the existing style expects explicit empty arrays.
6. Keep `system-config.ts` pointer-only. Add a validation test proving inline
   `imageProfiles.gateways.<name>.packageOverrides` and
   `imageProfiles.toolVms.<name>.packageOverrides` are rejected by the strict
   schema.

Proof:

- Unit tests for valid and invalid package names.
- Integration validation tests for overlay acceptance/rejection.
- Two-profile isolation test: two gateway image profiles use different overlays,
  generated plans do not bleed package decisions.
- Shared legacy-overlay fixture exercised by config validation and tarball-sync
  tests so both paths reject old keys consistently.
- Base support matrix tests proving unsupported buckets fail with clear messages
  for `openclaw-gateway`, `worker-gateway`, and `tool-vm`.

### Task 3: Apply Effective Package Policy During Dockerfile Generation

Write surfaces:

- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/package-overrides.ts`
- `packages/agent-vm/src/cli/build-command.ts`
- `packages/agent-vm/src/cli/build-command.integration.test.ts`
- `scripts/inspect-openclaw-runtime-image.ts`
- `scripts/inspect-openclaw-runtime-image.unit.test.ts`

Steps:

1. Build an effective package policy resolver:

   ```text
   resolveEffectivePackageOverrides(base, managedBasePolicy, overlayPolicy)
   ```

2. Keep validation package-specific:
   - `openclaw` bucket only accepts `openclaw` and `@openclaw/*` exact specs.
   - `npm` bucket accepts exact npm package specs, rejects unversioned specs,
     rejects protocol/alias/range specs, and rejects `@agent-vm/*`.
   - `pnpm` bucket accepts package-name to exact-version entries.
3. Generate OpenClaw runtime package installs from `openclaw`.
4. Generate direct npm package installs from `npm`, including `@openai/codex`,
   using pnpm and lifecycle scripts disabled by default.
5. Generate pnpm override JSON from `pnpm`, then apply it to the OpenClaw
   runtime package root and relink bundled package copies as the current undici
   workaround does.
6. Preserve the crash guard that OpenClaw 2026.6.8 requires a non-vulnerable
   `undici` override unless the managed/overlay OpenClaw version no longer
   requires it.
7. Keep Discord conditional:
   - Discord disabled => no `@openclaw/discord` package install unless the
     overlay explicitly pins it.
   - Discord enabled => `@openclaw/discord` is required and source-labeled.
8. Add Dockerfile invariant checks for forbidden secret/auth material after all
   new package paths are rendered.

Proof:

- Build-plan output shows source labels for every package decision.
- Generated Dockerfile tests assert no hidden `@openai/codex` flat-version path.
- Image inspection script can verify effective `undici` and direct package
  versions.
- Red tests for malicious/ambiguous specs in both `managed-images.json` and
  `overlay.jsonc`.
- Red tests for lifecycle-script policy and forbidden Dockerfile auth patterns.

### Task 4: Clean Up Worker Gateway Package Install

Write surfaces:

- `packages/worker-gateway/src/worker-lifecycle.ts`
- `packages/worker-gateway/src/worker-lifecycle.unit.test.ts`
- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `docs/subsystems/gateway-lifecycle.md`
- `docs/architecture/agent-worker-gateway.md`

Steps:

1. Remove unpinned runtime `npm install -g --force @openai/codex` from worker
   bootstrap.
2. Verify whether worker gateway still needs native `@openai/codex`. If not,
   do not add it to `worker-gateway.packageOverrides.npm`.
3. If worker gateway still needs native `@openai/codex`, install the pinned
   package through the worker-gateway image package policy with pnpm and
   lifecycle scripts disabled unless an allowlist entry is justified and tested.
4. Decide the minimal worker runtime install path for `/state/agent-vm-worker.tgz`:
   - preferred: preinstall image-level packages at image build time with pnpm;
   - if `/state/agent-vm-worker.tgz` must remain runtime-injected, install only
     that tarball with a bounded pnpm command and no networked latest package.
5. Ensure the worker gateway image can receive `packageOverrides.npm` from
   `worker-gateway` managed defaults and overlay policy.
6. Update worker docs to describe image-owned direct package installs.

Proof:

- Worker lifecycle unit test rejects `npm install -g --force @openai/codex`.
- Managed image generation test proves worker-gateway direct package policy
  includes pinned `@openai/codex` if still needed.
- `mise exec -- pnpm test:e2e:worker` proves the worker gateway boots.
- Worker e2e or host proof records bounded boot-to-`/health` readiness and no
  networked latest package install during bootstrap.

Split/replan trigger:

- If worker gateway cannot currently install direct packages at image build time
  without a larger image-lifecycle refactor, stop and replan before publishing.
  Do not ship a manifest that claims worker-gateway package ownership while the
  worker still performs unpinned runtime package installation.

### Task 5: Update Docs, Manuals, and Operator Visibility

Write surfaces:

- `docs/reference/configuration/system-json.md`
- `docs/getting-started/openclaw-guide.md`
- `docs/subsystems/gateway-lifecycle.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`
- `packages/agent-vm/src/operations/doctor.ts`
- `packages/agent-vm/src/operations/doctor.unit.test.ts`

Steps:

1. Document that package overrides are per image profile via the overlay.
2. Document managed per-base defaults in `managed-images.json`.
3. Document source-label precedence:

   ```text
   overlay.jsonc packageOverrides
     > managed-images.json baseImages[base].packageOverrides
     > generated defaults
   ```

4. Make build output list:
   - base image source;
   - OpenClaw package sources;
   - direct npm package sources;
   - pnpm override sources.
5. Add doctor and validate output that points users to the exact overlay file
   when package overrides are present or malformed.

Proof:

- Manual-template tests cover the new language.
- Build-command integration tests snapshot the new source labels.
- Config-validation tests cover actionable error messages.
- Doctor unit tests assert managed-vs-overlay package ownership lines and exact
  overlay path hints.

### Task 6: Migration and Deployment Sync

Write surfaces:

- `scripts/sync-local-tarballs-to-deployment.ts`
- `scripts/sync-local-tarballs-to-deployment.unit.test.ts`
- after implementation approval only:
  - `shravan-claw/vm-images/gateways/openclaw/overlay.jsonc`;
  - `shravan-claw-beta/vm-images/gateways/openclaw/overlay.jsonc`;
  - generated manuals in both deployments if package update occurs.

Steps:

1. Preserve opaque `packageOverrides` content by default while updating
   legacy-key rejection and duplicate-pruning rules.
2. Reject old `openClawPackageOverrides` and stale `pnpmOverrides` consistently
   with config validation unless a later explicit migration command is added.
3. Read `baseImages[base].packageOverrides` from `managed-images.json`, keyed by
   the overlay's managed base, before pruning redundant managed-default repeats.
4. Prune only exact bucket-by-bucket duplicates after normalized comparison.
   Preserve partial overrides, conditional package pins, unrelated keys, and
   opaque user-authored package policy.
5. Keep beta/main overlays minimal if they only repeat managed defaults.
6. Add a targeted beta test case that writes an overlay-only override and proves
   build output identifies it as overlay-owned.

Proof:

- Script unit tests for:
  - preserving custom OpenClaw overrides;
  - preserving custom pnpm overrides;
  - removing only redundant managed-default repeats;
  - not stripping conditional package pins like `@openclaw/discord`;
  - preserving unrelated overlay keys across a sync round-trip.

### Task 7: Final Validation and Stability Proof

Commands:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm test:integration
mise exec -- pnpm test:e2e:openclaw
mise exec -- pnpm test:e2e:worker
```

Deployment proof after package update:

```bash
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
pnpm validate
mise exec -- pnpm exec agent-vm doctor --config config/system.jsonc
mise exec -- pnpm exec agent-vm build --config config/system.jsonc --no-observability
mise exec -- pnpm build
pnpm start
curl -fsS http://127.0.0.1:<controller-port>/health
curl -fsS http://127.0.0.1:<controller-port>/zones/beta/health
```

If full OpenClaw live e2e prerequisites are unavailable, the executor must say
so and keep the claim scoped to the highest proof layer actually run. Skipped
inventory is not live proof.

## Write Surfaces Summary

Expected repo surfaces:

- `packages/agent-vm/managed-images.json`
- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/package-overrides.ts`
- `packages/agent-vm/src/cli/build-command.ts`
- `packages/agent-vm/src/config/system-config.ts` only if overlay/source
  validation needs better path-aware diagnostics; do not add global package
  overrides here.
- `packages/agent-vm/src/operations/config-validation.ts`
- `packages/agent-vm/src/operations/doctor.ts`
- `packages/agent-vm/src/cli/init-command.ts`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/worker-gateway/src/worker-lifecycle.ts`
- `scripts/sync-local-tarballs-to-deployment.ts`
- `scripts/inspect-openclaw-runtime-image.ts`
- matching unit/integration/e2e tests
- docs listed in tasks above

Deployment surfaces only after implementation is validated:

- `shravan-claw` package update/manual refresh if a new agent-vm version is
  consumed there.
- `shravan-claw-beta` package update/manual refresh and optional overlay test
  override.

## Security Assumptions

- Package override schemas must reject shell fragments and unversioned package
  specs; generated Dockerfile commands must keep using structured quoting.
- Overlay `copy` path safety remains unchanged: no absolute paths and no parent
  traversal.
- Overrides must not introduce auth tokens, `.npmrc`, Docker auth files, or
  secret-bearing build args into generated Dockerfiles.
- `packageOverrides.pnpm` may change transitive dependency resolution, so build
  and doctor output must make it explicit before runtime.
- Deployment overlays are human-authored JSONC. Runtime records and API bodies
  remain strict JSON.

## Rollback / Recovery

- If schema cutover breaks existing overlays, revert only the schema cutover
  commit and keep the already-published managed crash fix active until the new
  contract is repaired.
- If `packageOverrides.pnpm` fails to relink bundled OpenClaw package copies,
  keep the old managed `undici` patch path temporarily while fixing the new
  resolver, but do not publish a release with both paths silently active.
- If worker-gateway image-time package installation is too large, split Task 4
  by replanning before publish; do not ship worker manifest defaults that are not
  consumed by the worker image or bootstrap path.
- Deployment rollback remains package-based: pin deployments back to the last
  known good `@agent-vm/agent-vm` package and rebuild images from that installed
  package.

## Implementation-Time Verification

1. Does worker gateway truly need native `@openai/codex`, or is it stale after
   `agent-vm-worker` moved to `@openai/codex-sdk`? Task 4 should verify before
   preserving the package. This does not reopen the schema contract: if the
   worker no longer needs native Codex CLI, Task 4 removes the runtime `npm`
   install and does not add a worker `packageOverrides.npm` default.

## Recommended Next Workflow

Use `shravan-dev-workflow:implementation-execute-plan` only after a final
read-through confirms this revised plan has no unresolved contract decisions.
If another review is run, it should pressure-test:

- whether the managed manifest shape should preserve `baseImages` nesting or
  introduce a parallel `managedBases` object;
- whether the proof matrix catches hidden runtime drift and startup slowdown.
