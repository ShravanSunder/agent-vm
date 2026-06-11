# CI Publish-Gate Parity and E2E Lane Wiring

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 10 (proof integrity — shipped artifacts get weaker gates than PRs)

## Problem

1. **publish.yml runs a strictly weaker gate than ci.yml.** A tag push /
   manual publish ships npm packages that never passed `test:taxonomy`,
   `lint:types`, `typecheck`, `test:integration`, or `test:e2e:inventory` at
   the published commit. npm artifacts are effectively irreversible, so the
   weakest gate in the pipeline is the one guarding the most permanent
   output.
2. **The default E2E proof runner covers 3 of the 10 vitest projects.**
   `run-e2e-proof-lanes.ts` defines lanes for `e2e-host`, `e2e-vm`,
   `e2e-vm-mediation` only. `e2e-openclaw`, `e2e-worker`, `e2e-secrets`,
   `e2e-llm` exist as vitest projects but are reachable only by hand (or via
   the worker package's own `test:e2e:worker` script). CI's
   `pnpm test:e2e` therefore proves nothing about the OpenClaw lifecycle or
   worker runtime paths — the two most complex subsystems.

## Current Evidence

- `.github/workflows/publish.yml:150-162` — build, lint, fmt:check,
  test:unit, test:e2e only.
- `.github/workflows/ci.yml:105-132` — additionally test:taxonomy,
  lint:types, typecheck, test:integration, test:e2e:inventory.
- `scripts/run-e2e-proof-lanes.ts:6` —
  `type E2eProofLaneId = 'e2e-host' | 'e2e-vm' | 'e2e-vm-mediation'`.
- `vitest.config.ts:90-199` — ten projects including `e2e-openclaw`,
  `e2e-worker`, `e2e-secrets`, `e2e-llm`.
- `packages/agent-vm-worker/package.json` — `test:e2e:worker` exists but is
  not invoked by `pnpm test:e2e` or any workflow.

## Non-Goals

- Do not make secret-dependent lanes (`e2e-secrets`, `e2e-llm`,
  credentialed `e2e-worker`) hard-required in CI; they stay env-gated with
  explicit skip reporting.
- Do not restructure the vitest project taxonomy.

## Scope

Write surfaces:
- `.github/workflows/publish.yml`: add the five missing steps between
  install and build/publish, mirroring ci.yml order:
  `pnpm test:taxonomy`, `pnpm lint:types`, `pnpm typecheck`,
  `pnpm test:integration`, `pnpm test:e2e:inventory`.
- `scripts/run-e2e-proof-lanes.ts`: add lane definitions for
  `e2e-openclaw` and `e2e-worker` (and `e2e-secrets` as a gated lane),
  each with the appropriate env gate (mirroring how `e2e-vm` gates on its
  env var) so the runner reports "skipped: gate X absent" instead of
  silently not existing. Extend `E2eProofLaneId`.
- `docs/` wherever the e2e lane taxonomy is documented (check
  `scripts/run-e2e-proof-lanes.ts` header comments and any taxonomy doc
  added by the recent test-taxonomy commits) — keep lane lists in sync.

Read-only context:
- `scripts/run-vitest-evidence-project.ts` — how the worker package invokes
  its e2e lane today; reuse the same evidence conventions.
- `vitest.config.ts:169-199` — project globs and any `env`-based gating the
  projects already encode, so lane gates match project gates exactly.
- Recent commits `80c9c1e` (e2e taxonomy), `c40e3a7` (split host e2e proof
  lane) — follow the established lane pattern.

## Task Sequence

1. Add lanes for `e2e-openclaw`, `e2e-worker`, `e2e-secrets` to
   `run-e2e-proof-lanes.ts` with explicit gates and skip-reason output;
   unit-test the lane-plan function if one exists (check for an existing
   `run-e2e-proof-lanes` test).
2. Verify locally: `mise exec -- pnpm test:e2e` shows the new lanes either
   running or skipping with stated reasons; capture the output as evidence.
3. Update publish.yml with the five missing steps.
4. Validate workflow syntax (`gh workflow view` after push, or actionlint
   if available locally); confirm no step ordering breaks the existing
   tarball-evidence steps in the publish job.

## Proof Gates

- Focused validation: `pnpm test:e2e:inventory` and
  `mise exec -- pnpm test:e2e` locally with lane-status evidence.
- Full validation: `pnpm check && pnpm test:unit`.
- Workflow proof: next PR's CI run green; publish workflow proven on the
  next release (note explicitly in the completion report that the publish
  job can only be fully proven by a release run).

## Stop Conditions

- Stop if `e2e-openclaw`/`e2e-worker` projects have zero test files matching
  their globs (then the right fix is removing the dead projects or writing
  the missing tests — different plan; report which).
- Stop if publish.yml's added steps materially conflict with its existing
  release-evidence steps (e.g. duplicate builds with different flags) —
  reconcile rather than stacking.

## Risks

- Publish job duration grows by the integration suite; acceptable for
  release cadence, but note it.
- Gated lanes that never run anywhere are false comfort; the lane output
  must say loudly which gates were absent so the release evidence is honest.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/10-ci-publish-gate-parity.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
