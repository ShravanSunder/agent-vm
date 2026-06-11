# Secret Resolution Hardening (1Password Pipeline)

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 6 (robustness + security hygiene on the 1Password path)

## Problem

Four gaps in the secret pipeline, all on the same surface:

1. **No retry/backoff anywhere in resolution.** A transient 1Password API
   blip (DNS, 429, momentary network loss) during gateway preflight fails
   the entire zone boot. The SDK→op-inject fallback only covers client
   *creation* failure, not transient resolution errors. Gateway boots are
   expensive; this turns blips into full restarts.
2. **Resolved values are not redacted in composite-resolver errors.**
   `formatUnknownError` applies `redactOnePasswordReferences` (op:// URIs)
   only. If any underlying error message embeds a *resolved value*, it flows
   into the `AggregateError`, which propagates into persisted zone startup
   failure records and logs. The pattern for value redaction
   (`redactKnownSecretValues`) already exists for the service-account token
   but is not applied at this boundary.
3. **1Password audit logs always see integration version `0.0.1`.**
   `integrationVersion: dependencies.integrationVersion ?? '0.0.1'` and no
   production caller supplies it, so secret-access audit events cannot be
   correlated with agent-vm releases.
4. **Silent ambient `GITHUB_TOKEN` fallback.** When `host.githubToken` is
   unset, the controller silently uses `process.env.GITHUB_TOKEN` — commonly
   a broad personal PAT on workstations — with no log that the fallback
   activated.

## Current Evidence

- `packages/secret-management/src/redacted-exec-file.ts:182` — single
  attempt, `timeout: 30_000`, no retry. SDK resolve path in
  `onepassword-secret-resolver.ts` likewise single-attempt.
- `packages/secret-management/src/composite-secret-resolver.ts:27-29` —
  `formatUnknownError` only calls `redactOnePasswordReferences`.
- `packages/secret-management/src/onepassword-secret-resolver.ts:562` —
  `integrationVersion: dependencies.integrationVersion ?? '0.0.1'`; the
  `redactKnownSecretValues` helper exists in the same file (~line 45).
- `packages/agent-vm/src/controller/controller-runtime-support.ts:35-38` —
  `if (!githubTokenConfig) { return process.env.GITHUB_TOKEN ?? null; }`
  with no warning.
- Verified solid (do not touch): op CLI env isolation
  (`op-cli-service-account-env.ts`), marker-based op-inject extraction,
  template-injection guards, keychain identifier sanitization, preflight
  secret caching (`createPreflightCachingSecretResolver`).

## Non-Goals

- Do not change the secret declaration schema or mediation model.
- Do not cache secrets across zone boots (preflight caching already covers
  the in-boot window; cross-boot caching changes the rotation story).
- Do not retry on auth/permission errors (only transient classes).

## Scope

Write surfaces:
- `packages/secret-management/src/onepassword-secret-resolver.ts`: retry
  helper (3 attempts, exponential backoff with jitter, injected
  sleep/now for tests) around the SDK `resolve` call and
  `resolveAllSecretsWithOpInject`; retry only on transient classes (network
  errors, 429/5xx); error messages include attempt count.
- `packages/secret-management/src/composite-secret-resolver.ts`: accumulate
  successfully resolved values during a `resolveAll` batch into a transient
  `Set<string>` and redact them (and the service-account token) from any
  error message formatted in that batch. Explicitly out of scope: the
  single-ref `resolve()` path — nothing has been resolved before its only
  resolution fails, so there is no value set to redact there
  (review-confirmed).
- `packages/secret-management/src/index.ts` /
  `packages/agent-vm/src/controller/controller-runtime.ts` +
  `controller-runtime-support.ts` (wiring): pass the real package version as
  `integrationVersion`. This is a signature change (review-verified): the
  `createSecretResolverImpl` callback in
  `createSecretResolverFromSystemConfig`
  (`controller-runtime-support.ts:9-27`) currently accepts only
  `{ serviceAccountToken }` and discards `CreateSecretResolverDependencies`
  entirely — extend it to
  `{ serviceAccountToken, integrationVersion }` and update the
  `controller-runtime.ts:345-349` injection in the same pass. For reading
  the version, add a `readAgentVmPackageVersion()` helper following the
  existing `resolveAgentVmPackageRoot()` pattern
  (`managed-image-dockerfile.ts:636-667`), or extract that function to a
  shared module.
- `packages/agent-vm/src/controller/controller-runtime-support.ts`: warn-log
  when the ambient `GITHUB_TOKEN` fallback activates. Chosen mechanism: add
  an optional `writeWarning?: (message: string) => void` parameter to
  `resolveControllerGithubToken` defaulting to `process.stderr.write` (the
  house pattern) so existing callers compile unchanged and tests can assert
  the warning.
- Unit tests adjacent to each file.

Read-only context:
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts` — preflight
  caching resolver; confirm retries compose with the frozen-cache behavior
  (retries happen inside resolution, before freeze).
- `packages/secret-management/src/onepassword-secret-resolver.unit.test.ts`
  — existing dependency-injection seams to extend.

## Task Sequence

0. RESEARCH GATE (must pass before any retry code is written): inspect what
   `@1password/sdk` (^0.4.x — see `packages/secret-management/package.json`)
   actually throws. Known from code review: only `ResolveAllResponse` and
   `ResolveReferenceError` types are imported
   (`onepassword-secret-resolver.ts:3`); `ResolveReferenceError.type` codes
   exist for per-item batch failures, but single `client.secrets.resolve()`
   errors are untyped thrown exceptions. Probe the installed SDK
   (node_modules d.ts + a spike against a bad token vs. unreachable network)
   and record the observed error shapes. If transient-vs-auth cannot be
   distinguished by type/code (only by message text), STOP and reconverge on
   an explicit allowlist of retryable `ResolveReferenceError.type` codes for
   the batch path and a conservative no-retry default for the single-resolve
   path. Do not string-match SDK messages.
1. Implement and unit-test the retry helper (fail twice transient → succeed
   third; non-transient → no retry; attempt count in final error), using the
   classification contract produced by step 0.
2. Wire retry into both the SDK resolve path and the op-inject batch path.
3. Implement resolved-value redaction in the composite resolver; unit test:
   resolver resolves secret A, then throws an error containing A's value →
   caught error message does not contain the value.
4. Thread real `integrationVersion`; unit test asserts forwarding.
5. Add the GITHUB_TOKEN fallback warning; unit test asserts warning emitted
   and value still returned.
6. Run the secret-management suites, including
   `onepassword-secret-resolver.unit.test.ts`; the `e2e-secrets` lane if op
   credentials are available locally (report skipped-with-reason otherwise).

## Proof Gates

- Red/green proof: tests in steps 1, 3, 4, 5 fail before, pass after.
- Focused validation:
  `pnpm vitest run --config vitest.config.ts --project unit packages/secret-management/src packages/agent-vm/src/controller`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`
- Optional secrets E2E (gated):
  `pnpm vitest run --config vitest.config.ts --project e2e-secrets packages/secret-management/src` — report as skipped with reason if the op
  service-account env gate is absent.

## Stop Conditions

- Stop if the 1Password SDK does not expose error classes precise enough to
  distinguish transient from auth failures (string matching on SDK error
  messages would recreate the substring-classification problem; reconverge
  on an allowlist approach first).
- Never print or snapshot real secret values in tests; use synthetic values
  only.

## Risks

- Retries lengthen worst-case boot time by the backoff budget (~seconds);
  bounded and worth it.
- Value-redaction set must not outlive the resolution batch (no long-lived
  plaintext retention); scope it to the resolver call and document that
  invariant in code.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/06-secret-resolution-hardening.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
