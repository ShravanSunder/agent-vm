# Optique CLI Migration Proof-Completion Plan

Planning result: draft

## Governing authority and source identities

This plan is governed by the distinct design artifacts:

- Requirements: `docs/specs/2026-08-08-optique-cli-migration/requirements.md`
- Specification: `docs/specs/2026-08-08-optique-cli-migration/specification.md`
- Program Design: `docs/specs/2026-08-08-optique-cli-migration/program-design.md`

The planned repository snapshot is branch `replace-cli-library` at
`41574b5752cb33e7e042af973721ef9ec1dcd265`, under the repository instructions in
`AGENTS.md`, `.cursor/rules/ts-rules.md`, and `.cursor/rules/monorepo-rules.md`.
The earlier plan at
`docs/specs/2026-08-08-optique-cli-migration/plans/2026-08-08-optique-cli-migration.md`
is preserved unchanged; this path is the corrected plan identity for the
five-binary proof scope.

## Goal, scope, and non-goals

Make Optique and `@optique/zod` the only parsing foundation for every active
repository-owned CLI while preserving supported command behavior and proving
the shipped binaries at their real process boundary. The active binaries are
`agent-vm`, `agent-vm-worker`, `tool-portal`, `mcp-portal`, and
`agent-vm-gateway-runtime`.

The change covers parser definitions, Zod value boundaries, pure
discriminated command values, exhaustive dispatch, process-entrypoint status
ownership, direct package dependencies, residue checks, built-binary host
proof, and outside-suite smoke. Version proof applies only where a binary
already exposes a version surface. A boundary proof exercises an existing CLI
domain edge, such as an accepted numeric limit or an optional-versus-required
transition; it does not add a command, option, or validation domain.

The deprecated `packages/openclaw-mcp-portal-plugin` package is excluded.
Business operations, controller and worker HTTP behavior, deployment formats,
runtime protocols, VM behavior, logging, and OpenTelemetry are non-goals.

## Current repository evidence

The five parser-owning package manifests expose the five active binaries and
declare direct `@optique/core` and `@optique/zod` dependencies. The current
source uses package-local Optique runner boundaries, Zod-backed value parsers,
readonly discriminated command values, and exhaustive dispatch. The remaining
proof route must stay bound to those current owners and must not introduce a
shared parser framework or a compatibility facade.

## Ordered proof-bearing slices

### Slice 1: Establish parser/runtime dependency boundaries

Inspect and, where needed, update the parser-owning manifests and lockfile so
each active CLI directly declares only the Optique packages it imports and no
active package retains the removed legacy parser dependency. Keep parser runner
support package-local and
non-terminating for in-process callers; process entrypoints alone own the final
status.

Proof: focused runner tests for help, parse failure, injected streams, and
non-termination; package typechecks; dependency and residue inspection.

Stop/replan if a package requires a new cross-package parser API, a second
parser path, or an operation/runtime behavior change.

### Slice 2: Prove the `agent-vm` command tree and dispatcher

Cover all `agent-vm` leaf paths with Optique command parsers, Zod-backed values,
stable discriminators, and one exhaustive asynchronous dispatcher. Preserve
aliases, defaults, optionality, typed values, effects, streams, and operation
errors. Keep `init --type` limited to `openclaw | worker`.

Proof: complete command-contract and parser-purity units; dispatch-once units;
`agent-vm` package typecheck/lint/format; built `agent-vm` help, nested help,
version, valid, existing-domain boundary, missing, unknown, and Zod-invalid
process observations.

Requires Slice 1.

### Slice 3: Prove the `agent-vm-worker` command tree and dispatcher

Cover `serve` and `health` with typed discriminated values, Zod coercion, and
one exhaustive dispatcher without changing the existing Worker HTTP behavior.
Use existing port-domain edges for boundary coverage.

Proof: worker parser/dispatch units, worker unit and integration suites,
package typecheck/lint/format, and built `agent-vm-worker` help, valid,
boundary, invalid, and safe operation observations.

Requires Slice 1; serial with Slice 2 where shared build artifacts or package
fixtures collide.

### Slice 4: Prove the package-owned CLI roots

Keep ownership local while converting `tool-portal`, `mcp-portal`, and
`agent-vm-gateway-runtime` to Optique and `@optique/zod`. Preserve transport
constraints, nested paths, canonical JSON/protocol stdout, absolute-config
validation, status, and existing operation ownership.

Proof: package-local parser/dispatcher units; package typechecks, lint, and
format; package integration/host tests; built help, valid, existing-domain
boundary, missing, unknown, and Zod-invalid observations for each of the three
active binaries. Add version observations only if an existing package surface
provides them; do not add version behavior.

Requires Slice 1; Slice 2 and Slice 3 may be advisory-parallel when their
package fixtures and generated artifacts do not overlap.

### Slice 5: Join the five-binary cutover proof

Run static searches over active manifests, lockfile, source, tests, current
docs, and packed dependency metadata. Verify that only the named checker and
the explicitly historical/current migration documents contain the forbidden
legacy-parser token, and that the deprecated OpenClaw MCP Portal plugin remains
outside the migration.

Run the permanent built-binary host-E2E proof across all five binaries. The
proof must observe argv, stdout, stderr, status, valid behavior, an
existing-domain boundary, invalid behavior, help, and one safe effect at the
real process boundary; the `agent-vm` version surface is included.

Requires Slices 2, 3, and 4. This is the first integration gate across all
independently owned command roots.

### Slice 6: Full quality and outside-suite smoke

Build the workspace once, inspect the packed active packages, and run the
targeted parser/operation suites followed by the repository gates:

- `pnpm build`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm check`
- targeted host-E2E proof for the five active binaries
- `git diff --check`

Outside Vitest, invoke each built binary with representative safe argv and
record stdout, stderr, status, and one safe effect. Use an existing version
invocation only for `agent-vm`. Do not claim VM or live gateway proof for this
parser-only change.

Requires Slice 5. Stop if any check is stale, skipped, or observes a different
HEAD than the reviewed source.

## Obligation-to-slice-to-proof mapping

| Obligation | Slice | Proof boundary |
| --- | --- | --- |
| U1/S1 hard dependency cutover | 1, 5 | manifests, lockfile, source/doc residue, packed metadata |
| U2/S3 Zod ownership and placeholders | 1–4 | parser/value units and typechecks |
| U3/S2 command behavior preservation | 2–4 | command contracts, operation tests, built argv observations |
| U4/S4 pure parse and exhaustive dispatch | 1–4 | no-effect parse and one-dispatch units, type checking |
| U5/S5 five-binary proof | 2–6 | built host-E2E plus outside-suite smoke |
| S6 package/runtime compatibility | 1, 5, 6 | package inspection, integration suites, quality gate |

## Integration gates and risks

The first integration gate is Slice 5, where all five independent binary roots
meet the residue checker and real process-boundary proof. The final gate is
Slice 6, where the exact reviewed HEAD, full quality suite, packed packages,
and manual smoke must agree.

False-green risks are a mocked parser test standing in for a built binary, a
stale packed package, a residue search that omits lockfile or documentation,
or a version assertion that accidentally adds a new CLI surface. The proof
must reject each weaker substitute.

Replan if the current five-binary inventory changes, if any operation behavior
must change to make parsing pass, if a package needs a shared parser API, if a
new version surface is proposed, or if the deprecated plugin is pulled into
scope.
