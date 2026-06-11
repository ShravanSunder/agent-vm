# Plan 06 Secret Resolution Hardening Research Gate

Status: blocked pending retry-classification approval
Branch: improve/plan-06-secret-resolution-hardening
Worktree: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-plan-06-secret-resolution-hardening

## Coverage

- Plan loaded: docs/superpowers/plans/2026-06-10-repo-improvements/06-secret-resolution-hardening.md, 169 lines, read 1-169.
- Execution skill loaded: implementation-execute-plan/SKILL.md, 115 lines, read 1-115.
- Validation checklist loaded: implementation-execute-plan/references/validation-checklist.md, 54 lines, read 1-54.
- TDD skill loaded: test-driven-development/SKILL.md, 371 lines, read 1-371.
- Testing anti-patterns loaded: testing-anti-patterns.md, 299 lines, read 1-299.

## Research Gate Evidence

- Installed package: `@1password/sdk@0.4.0` from `packages/secret-management/package.json`.
- `pnpm view @1password/sdk` reported `latest: 0.4.0`, `stable: 0.4.0`, `beta: 0.4.1-beta.1`.
- Installed README points to upstream repository `1Password/onepassword-sdk-js`.
- Local declarations show `Secrets.resolve(secretReference): Promise<string>` and `Secrets.resolveAll(secretReferences): Promise<ResolveAllResponse>`.
- Local `errors.d.ts` exports only `DesktopSessionExpiredError` and `RateLimitExceededError`.
- Local `errors.js` maps core JSON name `RateLimitExceeded` to `RateLimitExceededError`, `DesktopSessionExpired` to `DesktopSessionExpiredError`, and all other parsed errors to plain `Error`.
- Local `ResolveReferenceError` union codes are reference/domain/content failures:
  `parsing`, `fieldNotFound`, `vaultNotFound`, `tooManyVaults`, `itemNotFound`, `tooManyItems`, `tooManyMatchingFields`, `noMatchingSections`, `incompatibleTOTPQueryParameterField`, `unableToGenerateTotpCode`, `sSHKeyMetadataNotFound`, `unsupportedFileFormat`, `incompatibleSshKeyQueryParameterField`, `unableToParsePrivateKey`, `unableToFormatPrivateKeyToOpenSsh`, `other`.
- DeepWiki `ask_question` against `1Password/onepassword-sdk-js` agreed: single `resolve` has a typed `RateLimitExceededError` signal, otherwise generic `Error`; `resolveAll` per-reference errors do not represent transient network/429/5xx classes; no status/code metadata is exposed beyond the exported error subclass.

## Local Spikes

Command:

```sh
node --input-type=module -e '... createClient({ auth: "ops_synthetic_bad_token_for_agent_vm_research_only", ... }) ...'
```

Exit code: 0

Observed shape:

```json
{
  "label": "bad-token",
  "constructorName": "Error",
  "name": "Error",
  "ownKeys": [],
  "instanceofRateLimitExceededError": false,
  "instanceofDesktopSessionExpiredError": false
}
```

Command:

```sh
node --input-type=module -e '... createClient({ auth: `ops_${syntheticBase64Payload}`, ... }) ...'
```

Exit code: 0

Observed shape for two syntactically base64-shaped synthetic tokens:

```json
{
  "constructorName": "Error",
  "name": "Error",
  "ownKeys": [],
  "instanceofRateLimitExceededError": false,
  "instanceofDesktopSessionExpiredError": false
}
```

No `AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN` or `OP_SERVICE_ACCOUNT_TOKEN` was present, so the real-token unreachable-network spike could not be run without using personal credentials or guessing token internals.

## Decision Needed

The plan's original retry scope says "network errors, 429/5xx", but the installed SDK exposes only one typed transient signal: `RateLimitExceededError`.

Evidence-backed implementation contract:

1. Retry SDK client creation, `resolve`, and thrown `resolveAll` failures only when the thrown error is `RateLimitExceededError`.
2. Do not retry generic SDK `Error` values, because auth, permission, reference, network, and 5xx are not distinguishable without message parsing.
3. Do not retry per-reference `ResolveReferenceError` responses from `resolveAll`; no union member represents a transient class.
4. Do not retry op-inject fallback failures unless a new typed classification surface is added to `redacted-exec-file.ts`; current fallback errors expose safe redacted detail for humans, not a stable retry classifier.

This is narrower than the proposed plan and needs approval before retry code is written.
