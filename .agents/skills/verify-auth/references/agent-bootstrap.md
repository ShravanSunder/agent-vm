# Local agent and bootstrap journeys

Return the selected journey, the complete compared target tuple, observations for its required assertions, command/exit/counts, private evidence location and every remaining gap. This reference owns shared setup and detailed driving steps.

## Establish the frozen target

Work from the repository root. Read `scripts/verify-auth/verify-auth.ts`, `packages/auth/src/test-fixtures/auth-verification-cli.ts`, `packages/auth/src/test-fixtures/local-auth-harness.ts` and the selected permanent host tests before running. The runner's target declaration is an owned mode0600 JSON file outside every Git checkout, with these existing fields:

```json
{"kind":"local-workerd","sourceRevision":"<full frozen checkout HEAD>","executionHost":"<admitted host name>"}
```

The placeholders describe the file's shape; obtain actual values from the declared execution target. Do not print private target contents or create a second target schema. Resolve symlinks and ownership using the existing private-runtime-path validation. This file is separate from the native CLI target generated inside the harness.

Compare all of the following before treating output as an observation:

| Identity | Declared reference and actual comparison |
| --- | --- |
| Source | Full target `sourceRevision` equals `git rev-parse HEAD` in the execution checkout. Inspect tracked and untracked status: an overlay or uncommitted runtime input means the commit alone is not a frozen source identity. Freeze intended changes before proof. |
| Build/artifact | Build workspace dependencies from that frozen source with its frozen lockfile. Retain the build command, exit and artifact identities. The harness bundles `auth-proof-entrypoint.ts` and `auth-gateway-proof-entrypoint.ts` with pinned esbuild and passes those actual module contents to Miniflare. Compare executed module/build identities with the declared frozen build; stale `dist` output or an unrecorded overlay is a prerequisite gap. Source HEAD alone cannot identify an executed build. |
| Configuration | Read the frozen harness's issuer construction, compatibility date/flags, D1 and named binding declarations, two Gateway heaps, organization policies, audiences and `remembered-login` setting. Compare the configuration actually passed to Miniflare. Only loopback addresses/runtime roots may be assigned dynamically by that fixture; retain their private mapping. A different configuration needs a newly declared target. |
| Client | At reviewed commit `6b27f848`, read `packages/auth/src/test-fixtures/local-auth-harness.ts`, `packages/auth/src/native-owner-cli/owner-cli.ts` and `packages/auth/src/native-owner-cli/owner-cli-login.ts`. They declare the fixed public code+S256 client, loopback callback, management audience and short private cache. That committed harness calls the login helper directly: delivered-CLI process proof is missing. Compare the executed entry and fixed client/redirect/audience with the newly declared frozen source; helper-only login is insufficient. Do not substitute later WIP or dirty driver code. |
| Offered inventory | Collect `mise exec -- pnpm exec vitest list --project e2e-host packages/auth --json` on the same source. Compare offered names/files with selected runner files and `agent:` or `bootstrap:` selector, then compare the executed report's selected names/counts. Discovery is inventory only. Missing accepted cases remain gaps; they cannot disappear behind a positive count. |
| Host/toolchain | The runner checks hostname and Node24.7.0. Check pinned pnpm/toolchain and installed lockfile as well. Run real workerd/D1 proof on the Lead-admitted execution host and slot; local static checks do not replace that target. |

If a driver does not yet retain enough evidence to complete a comparison, report that exact gap and do not count the run as verification. A failed prerequisite must not become a product assertion failure. Run each command in its released execution slot without load admission checks or load waits. Retain bounded timeouts, owned process-group cleanup and terminal receipts; report timing failures for diagnosis.

## Run the selected journey

The existing CLI forms are:

```bash
mise exec -- pnpm exec tsx scripts/verify-auth/verify-auth.ts bootstrap --target-file "$AUTH_VERIFY_TARGET_FILE"
mise exec -- pnpm exec tsx scripts/verify-auth/verify-auth.ts agent --target-file "$AUTH_VERIFY_TARGET_FILE"
```

Set `AUTH_VERIFY_TARGET_FILE` to the private declaration established above; run only the chosen journey. `--help` describes the interface. The runner starts permanent host tests and retains a private Vitest report. Interface/help success does not establish journey operability. Inspect actual output and assertions rather than assuming a documented command has passed.

The harness applies canonical migrations as one ordered real D1 batch, starts the issuer and production Gateway/DO, and supplies a controlled external Google code/S256/ID-token protocol. Better Auth itself creates the person, session, cookie, OAuth client and JWT/JWKS. The upstream records independently which organization's credential caused each effect. The proof-only storage reader does not preseed admission.

### Bootstrap

Use `packages/auth/src/agent-issuer.host.e2e.test.ts`, selected by `bootstrap:`.

1. Drive the delivered native CLI. Its authorization URL starts the real provider flow; the fixture completes the external protocol. Observe the genuine Better Auth callback/cookie and live bound owner. Provider-fixture success alone does not establish a person proof.
2. Send same-origin cookie-only owner bootstrap. Observe exactly one fixed public native client with code-only, PKCE and management-only policy, owner/audit state and no client secret. Repeat the request and inspect D1 for duplicate clients or extra writes. A bearer-bearing bootstrap request must refuse.
3. Continue real native authorization and S256 token exchange through the loopback listener. Observe a management-audience JWT with real session identity, no refresh token and lifetime at most300s; verify through actual public JWKS. A missing Location/code, provider error, consent page or JSON redirect is a diagnostic result to inspect, not permission to invent a callback code.
4. Inspect mode0600 private cache/target handling and absence of captured tokens, codes or cookies in CLI output. A valid cached login does not waive the next command's live server checks.

The permanent assertion inventory determines which observations are executable. Return missing direct client/audit/claim/output assertions as gaps rather than inferring them from a nonempty token.

### Agent

Read `agent-issuer.host.e2e.test.ts`, `agent-registration-faults.host.e2e.test.ts` and every additional selected management/race/CLI test offered by the frozen runner.

1. Obtain owner proof through bootstrap. POST organization registration through the actual Gateway HTTP route and named sign-in binding. Inspect D1 for one stable client, exact `client_credentials` grant, agent scope ceiling, Basic authentication, signed organization metadata, one resource link and registration intent/outcome audit. Inspect DO admission directly. Release credentials only after those owners agree.
2. Exchange credentials at the real issuer. Verify its JWT/JWKS through the production Gateway and call the controlled tool with a unique correlation. Require exactly one organization-one effect and zero organization-two effects; compare the independent ledger and direct DO/D1 rows. A JWT decode or HTTP200 alone is insufficient.
3. Submit forbidden grant/resource/dynamic registration requests and foreign-organization operations. Require refusal, no returned credentials/proof, no unauthorized storage change and zero extra tool effects.
4. Inject failures at actual D1 intent, client, resource-link and outcome writes. Inspect exact partial rows, absence of admission and absence of released secret. Retry the same operation ID; require one linked, audited client, supported secret rotation where needed and a usable resulting credential.
5. Warm both Gateway heaps, remove admission, then fail issuer disable. Both heaps must refuse the already issued token with no effect. Keep pending retirement readable; a later live owner retry must finish disable. Read both owners again and require token issuance refusal after completion.
6. Challenge every management/admin entry with E10 and a genuinely issuer-signed management-audience token lacking `sid`. Require refusal even alongside an owner cookie, no protected reads past the refusal boundary, no returned credentials, no change to protected issuer/admission/client/credential state and no tool effect. An attributable refusal audit event is allowed; inspect before/after audit rows to distinguish that append from unauthorized audit mutation. A signed `client_id` is never a Person session. Exercise the public no-hook path and request-isolation guard; no unverified actor/session substitution may work.
7. Exercise held real post-signing disable/resource-organization races, wrong-owner/removed/revoked/expired Person checks and native code/PKCE/redirect/replay/live-next-command cases. Compare against the accepted S1 prebuild deciders. If cases are absent or unrun, name each missing case.

The adopted S1 deciders and frozen permanent tests own expected results; the skill creates no new outcomes. The three fixed wrong builds remove the final active read, remove signed-organization equality, and skip management `sid` discrimination. Run them only within the assigned mutation grant, retain each intended assertion red and restore the original target for a green run. Compilation/startup failure does not demonstrate sensitivity.

## Interpret and retain the result

Check selected names as well as counts. The report must show positive selected passes, zero failures and success; unselected tests remain separate. Before claiming the whole S1 proof complete, match every adopted decider and mutant with its actual receipt. Preserve failed diagnostics as failures even if a later corrected run passes.

Keep raw reports, module/config identities, D1/DO snapshots and effect receipts in owned private evidence storage. Report redacted results and gaps. Let `close()` dispose Miniflare and owned listeners and let the CLI helper terminate its own child. Check for surviving owned processes after a failed run; never terminate unrelated jobs. Delay removal of owned runtime state until evidence has been preserved and consumers have finished.
