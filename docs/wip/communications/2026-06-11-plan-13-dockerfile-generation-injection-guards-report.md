# Plan 13 Report — Dockerfile Generation Injection Guards

Status: complete
Branch: improve/plan-13-dockerfile-generation-injection-guards
Pushed: yes, origin/improve/plan-13-dockerfile-generation-injection-guards
Date: 2026-06-11

## Scope

Plan:
docs/superpowers/plans/2026-06-10-repo-improvements/13-dockerfile-generation-injection-guards.md

Implemented the managed Dockerfile overlay hardening for:

- `copy.from`: reject whitespace/line breaks so source paths cannot split the generated COPY directive.
- `copy.to`: reject whitespace/line breaks, leading Dockerfile option markers, and non-absolute in-image destinations.
- `runAfterBase`: reject embedded CR/LF so one overlay entry cannot split into multiple Dockerfile directives.
- Added schema-level Zod refinements and generation-time assertions.
- Added permanent unit tests for newline directive injection, copy destination shape, and schema-time rejection before output cleanup.

## Files Touched

Within declared write surfaces:

- packages/agent-vm/src/build/managed-image-dockerfile.ts
- packages/agent-vm/src/build/managed-image-release.unit.test.ts

Report artifact:

- docs/wip/communications/2026-06-11-plan-13-dockerfile-generation-injection-guards-report.md

No deviation from the plan write surface for product/test code.

## Evidence

Red proof before implementation:

```text
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/build
exit: 1
result: 1 test file failed, 6 passed; 2 tests failed, 53 passed
expected failure: injected copy.to and runAfterBase payloads resolved instead of rejecting
```

Focused green proof after implementation and formatting:

```text
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/build
exit: 0
result: 7 test files passed; 60 tests passed
```

Formatting:

```text
pnpm fmt
exit: 0
result: oxfmt finished on 621 files
```

Static/full check gate:

```text
pnpm check
exit: 0
result: check gate 6 passed, 0 failed
passed: package-versions, zod-version, test-taxonomy, format, type-aware-lint, typecheck
note: type-aware lint emitted existing warnings but the gate summary was pass
```

Unit gate:

```text
pnpm test:unit
exit: 0
result: test taxonomy passed; 197 test files passed; 1809 tests passed
```

Integration gate:

```text
pnpm test:integration
exit: 0
result: 23 test files passed; 327 tests passed
```

Stop-condition check:

```text
rg -n '"to"\s*:' . --glob '*.json' --glob '*.jsonc' --glob '!node_modules/**' --glob '!tmp/**' --glob '!**/dist/**'
exit: 1
result: no committed JSON/JSONC overlay copy.to values found outside excluded generated/temp paths
```

Whitespace check:

```text
git diff --check
exit: 0
result: no whitespace errors
```

## Security Proof

The red/green tests prove that overlay-controlled Dockerfile fields can no longer:

- split `COPY overlay/<from> <to>` with a newline in `copy.from`;
- split `COPY overlay/<from> <to>` with a newline in `copy.to`;
- change COPY source arity with whitespace in `copy.from`;
- change COPY destination arity with whitespace in `copy.to`;
- supply a Dockerfile COPY option-looking destination;
- use ambiguous relative in-image copy destinations;
- split one `runAfterBase` entry into multiple Dockerfile directives.

`runAfterBase` remains an arbitrary operator-owned shell command as required by the plan; only embedded CR/LF is rejected.

## E2E

No e2e lane is named by Plan 13. This slice changes schema validation and generated Dockerfile text covered by unit tests plus the repo global unit/integration gates.

## Open Questions / Follow-ups

None discovered for Plan 13.

## Review

Implementation-review-swarm: complete.

Accepted findings:

- Security/spec/contracts reviewers found that `copy.from` still permitted whitespace/newline Dockerfile injection because only absolute path and parent traversal were rejected. Fixed with schema-level and generation-time `copy.from` single-token validation plus a newline-source regression test.
- Contracts reviewer found the tests did not prove parse-time schema rejection because later generation assertions would also satisfy the original throw assertions. Fixed with a sentinel output-directory test that asserts the Zod field-path error occurs before `generateManagedDockerfile` clears the output directory.

Rejected findings:

- None.

Final verdict after reducer verification: ready.
