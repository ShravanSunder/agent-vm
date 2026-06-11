# Managed Dockerfile Generation: Injection Guards for Overlay Fields

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 13 (security defense-in-depth on the gateway image boundary)

## Problem

CLAUDE.md declares a hard security boundary for generated gateway
Dockerfiles (no token references, no auth files, "a future edit cannot
accidentally turn a runtime secret into image state"). The overlay `copy.to`
field undermines that boundary's enforcement: it is interpolated raw into
the generated Dockerfile, validated only as a non-empty string. A value
containing a newline (`"/tmp/x\nRUN <anything>"`) injects arbitrary
Dockerfile directives — exactly the class of edit the boundary exists to
prevent. The `copy.from` side already has a safety assertion
(`assertOverlayCopySourceIsSafe`); `to` has none. `runAfterBase` entries
are intentionally arbitrary commands but are also newline-splittable into
multiple directives, which silently defeats the existing
forbidden-substring unit test that scans line-shaped expectations.

Overlay files are operator-controlled, so this is defense-in-depth, not an
open vulnerability — but the repo's own stated boundary calls for it, and
the guard is cheap.

## Current Evidence

- `packages/agent-vm/src/build/managed-image-dockerfile.ts:339` —
  `` lines.push(`COPY overlay/${copy.from} ${copy.to}`) ``.
- `managed-image-dockerfile.ts:102` — `to: z.string().min(1)` (no character
  restrictions).
- `managed-image-dockerfile.ts:341-342` — `lines.push(\`RUN ${command}\`)`
  for `runAfterBase` (newline in a command splits into multiple Dockerfile
  lines).
- Contrast: `assertOverlayCopySourceIsSafe` guards `from`
  (absolute-path/`..` rejection); `shellJoin` (JSON.stringify quoting)
  guards `extraAptPackages`.
- Existing boundary test: `managed-image-release.unit.test.ts` (~line
  351-353) asserts the generated Dockerfile does not match
  `TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer` — a newline
  injection could still smuggle a directive that this regex misses if the
  payload avoids those substrings.

## Non-Goals

- No restriction of what `runAfterBase` may *do* (it is by-design arbitrary
  operator shell) — only that each entry is exactly one Dockerfile
  directive (no embedded newlines/CR).
- No changes to the base image reference schema (`managed-images.json` is a
  committed package file, lower risk; note it in the completion report,
  don't expand scope).

## Scope

Write surfaces:
- `packages/agent-vm/src/build/managed-image-dockerfile.ts`:
  - add `assertOverlayCopyDestinationIsSafe` (reject `\n`, `\r`, leading
    `-`, and whitespace that changes COPY arity; require absolute in-image
    destination or document relative semantics) applied next to the
    existing `from` assertion;
  - assert `runAfterBase` entries contain no `\n`/`\r`;
  - prefer schema-level enforcement too: tighten the Zod fields with
    `.refine(...)` so invalid overlays fail at parse, not at generation.
- Extend the Dockerfile boundary unit test with injection-attempt cases
  (`to: "/tmp/x\nRUN echo pwned"` → throws; same for runAfterBase).

Read-only context:
- `managed-image-release.unit.test.ts` — existing boundary test idiom to
  extend.
- Overlay loading path (`loadManagedImageOverlay`) — where parse errors
  surface to the operator, so the new refinement message is actionable.

## Task Sequence

1. Add the Zod refinements + assertion helpers with unit tests (red:
   current code emits the injected line; green: generation throws with a
   clear message naming the offending field).
2. Extend the boundary regex test with the injection cases.
3. Run build unit suites + full gate.

## Proof Gates

- Red/green proof: injection-case tests fail before (Dockerfile contains
  the injected `RUN`), pass after (throws at parse/generation).
- Focused validation:
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/agent-vm/src/build`
- Full validation: `pnpm check && pnpm test:unit`

## Stop Conditions

- Stop if any committed overlay/config in this repo legitimately uses
  characters the new refinement rejects (would indicate the rule is wrong,
  not the data) — bring the example back before loosening.

## Risks

- Overly strict destination rules could reject legitimate paths with
  spaces; Dockerfile COPY with unquoted spaced paths is already broken, so
  rejecting is the correct behavior, but the error message must say why.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/13-dockerfile-generation-injection-guards.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
