# Local agent and bootstrap journeys

Return the selected journey, the complete compared target tuple, observations for its required assertions, command/exit/counts, private evidence location and every remaining gap. This reference owns shared setup and detailed driving steps.

## Establish the frozen target

Work from the repository root. On a fresh clone, install the frozen dependencies before invoking the TypeScript runner:

```bash
mise exec node@24.7.0 -- pnpm install --frozen-lockfile
```

Read `scripts/verify-auth/verify-auth.ts`, `packages/auth/src/test-fixtures/auth-verification-cli.ts`, `packages/auth/src/test-fixtures/local-auth-harness.ts` and the selected permanent host tests before running. The runner's target declaration is an owned mode0600 JSON file outside every Git checkout, with these existing fields:

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
| Client | Read the declared target's `packages/auth/src/test-fixtures/local-auth-harness.ts`, `packages/auth/src/test-fixtures/native-cli-proof.ts`, `packages/auth/src/native-owner-cli/owner-cli.ts` and `packages/auth/src/native-owner-cli/owner-cli-login.ts`. The harness calls `loginThroughNativeOwnerCli`, which spawns the delivered `scripts/verify-auth/owner-cli.ts` entry with the fixed public code+S256 client, loopback callback, management audience and short private cache. Compare that executed entry and its client/redirect/audience with the frozen source; helper-only login is insufficient. Do not substitute WIP or dirty driver code. |
| Offered inventory | Collect `mise exec node@24.7.0 -- pnpm exec vitest list --project e2e-host packages/auth --json` on the same source. Compare offered names/files with selected runner files and `agent:` or `bootstrap:` selector, then compare the executed report's selected names/counts. Discovery is inventory only. Missing accepted cases remain gaps; they cannot disappear behind a positive count. |
| Host/toolchain | The runner checks hostname and Node24.7.0. Check pinned pnpm/toolchain and installed lockfile as well. Run real workerd/D1 proof on the Lead-admitted execution host and slot; local static checks do not replace that target. |

If a driver does not yet retain enough evidence to complete a comparison, report that exact gap and do not count the run as verification. A failed prerequisite must not become a product assertion failure. Run each command in its released execution slot without load admission checks or load waits. Retain bounded timeouts, owned process-group cleanup and terminal receipts; report timing failures for diagnosis.

## Run the selected journey

The existing CLI forms are:

```bash
mise exec node@24.7.0 -- pnpm exec tsx scripts/verify-auth/verify-auth.ts bootstrap --target-file "$AUTH_VERIFY_TARGET_FILE"
mise exec node@24.7.0 -- pnpm exec tsx scripts/verify-auth/verify-auth.ts agent --target-file "$AUTH_VERIFY_TARGET_FILE"
```

Set `AUTH_VERIFY_TARGET_FILE` to the private declaration established above; run only the chosen journey. Select Node24.7.0 explicitly for every invocation: the runner refuses other versions, and the checkout's mise configuration does not pin Node. `--help` describes the interface; keep the explicit Node selector above even if its usage example omits it. The runner starts permanent host tests and retains a private Vitest report. Interface/help success does not establish journey operability. Inspect actual output and assertions rather than assuming a documented command has passed.

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

Step 3's body/state/effect assertions and the empty-deployment first-arrival cases were strengthened after the `cf607bf7` observation. Their real-target correction proof and independent review remain required before those coverage findings are closed; a refusal status alone does not close them.

## Accepted S1 deciders

The authoritative home is `docs/specs/2026-10-20-people-sign-in/plans/2026-10-21-sign-in-service-build.md` at `0b0aad31` on the canonical `docs/tool-portal-design` branch, section **S1 — Real agent issuer through the Gateway**, together with its **Lead ruling on Decision A**. That plan may live in the docs worktree rather than the execution checkout. Use the pinned source when available and report an unavailable governing source as a gap. The table maps those outcomes to permanent tests; it does not make a passing inventory a completeness claim.

Names below are the exact permanent case names. The three registration/disable/rotation families use the literal parameter values listed in their rows. Files are under `packages/auth/src/`; the shared cases in `agent-issuer.host.e2e.test.ts` have the report ancestor `S1 real agent issuer through the Gateway > `, while its two first-arrival cases are top-level.

| S1 decider | Permanent file and test name |
| --- | --- |
| Fixed native owner bootstrap and live management proof | `agent-issuer.host.e2e.test.ts`: `bootstrap: native S256 loopback creates the fixed owner client once with real owner cookie and audit`; `native-code-protocol.host.e2e.test.ts`: `agent: native owner code rejects wrong PKCE/redirect, missing or plain PKCE, refresh, offline and reused code` |
| Empty private deployment refuses any wrong first arrival before the configured verified owner becomes administrator | `agent-issuer.host.e2e.test.ts`: `bootstrap: refuses 'a verified non-owner' first arrival before admitting the configured owner`; `bootstrap: refuses 'an unverified configured owner' first arrival before admitting the configured owner` |
| Strict E9, real E10/JWKS, one O1 effect and zero O2 effects | `agent-issuer.host.e2e.test.ts`: `agent: real HTTP registration, token and JWKS authorize exactly one O1 effect and zero O2 effects` |
| Grant adds authorization code; forbidden resource or dynamic registration | `agent-issuer.host.e2e.test.ts`: `agent: wrong grant, resource and dynamic registration never return a token or client` — requires exact `invalid_target` for the wrong resource, credential-free refusal bodies and unchanged dynamic-registration client rows/count |
| Resource link missing | `agent-issuer.host.e2e.test.ts`: `agent: real HTTP registration, token and JWKS authorize exactly one O1 effect and zero O2 effects` (direct resource-link readback) |
| Agent client cache enabled | `agent-registration-faults.host.e2e.test.ts`: `agent: rotation retry fails closed at its actual client write and invalidates the lost old secret` (retry must complete a real rotation) |
| Final active check deleted | `agent-token-races.host.e2e.test.ts`: `agent: discards the actual signed token after a held 'disable' race before the final D1 read` |
| Resource custom claim overwrites signed organization | `agent-token-races.host.e2e.test.ts`: `agent: discards the actual signed token after a held 'resource-organization' race before the final D1 read` |
| Admission cached; removal completes after only one owner | `agent-issuer.host.e2e.test.ts`: `agent: failed disable keeps admission removed in two warm Gateway heaps and a later owner request completes it` |
| Service route reachable by public URL/header; agent or no-sid proof treated as a Person | `management-boundaries.host.e2e.test.ts`: `agent: every management boundary refuses real E10 and signed management no-sid identity before protected reads or effects` |
| Owner body trusted; concurrent request inherits owner authority | `owner-authority-boundaries.host.e2e.test.ts`: `agent: real non-owner E7, forged actor input and public binding URLs never acquire owner authority across concurrent requests` |
| Foreign-organization DELETE refuses without changing the client, resource rows, either organization's admission or tool effects | `agent-issuer.host.e2e.test.ts`: `agent: real HTTP registration, token and JWKS authorize exactly one O1 effect and zero O2 effects` (foreign-request before/after readbacks; refusal audits are allowed) |
| Decision A: fail each actual registration write, with no credential/admission release and idempotent retry | `agent-registration-faults.host.e2e.test.ts`: `agent: fails closed at the actual '<write>' write and owner retry leaves exactly one linked working client`, where `<write>` is `intent`, `client`, `link` or `outcome` (quotes are part of the case name) |
| Decision A: failed disable and rotation remain recoverable | `agent-registration-faults.host.e2e.test.ts`: `agent: disable remains pending after the actual <write> write fails and same-operation retry completes both owners` and `agent: rotation retry fails closed at its actual <write> write and invalidates the lost old secret`, where `<write>` is `intent`, `client` or `outcome` |
| Every owner command rechecks current Person/session | `person-live-management.host.e2e.test.ts`: `agent: the next delivered CLI command refuses the already issued E7 after '<state>'`, where `<state>` is `revoked-session`, `expired-session`, `removed-person`, `unbound-owner` or `unavailable-session-store` (quotes are part of the case name) |

The three fixed wrong builds remove the final active read, remove signed-organization equality, and skip management `sid` discrimination. Run them only within the assigned mutation grant, retain each intended assertion red and restore the original target for a green run. Compilation/startup failure does not demonstrate sensitivity.

## Interpret and retain the result

Check selected names as well as counts. The report must show positive selected passes, zero failures and success; unselected tests remain separate. Before claiming the whole S1 proof complete, match every adopted decider and mutant with its actual receipt. Preserve failed diagnostics as failures even if a later corrected run passes.

The permanent assertions directly read D1/DO rows and the in-memory controlled upstream ledger. A passing selected assertion on the compared target establishes that observation; retain its Vitest JSON and case stream, the module/config/client and harness readiness receipts, phase/runtime/install/build logs, compared-target and process-cleanup receipts, and runtime SQLite files. Raw intermediate row snapshots and a ledger export are not retained by the driver; name this deferred row-snapshot/ledger-retention gap. Final SQLite state cannot reconstruct intermediate fault states or the lost in-memory ledger. Do not invent an export or claim those raw files exist.

Report redacted results and the remaining assertion/retention gaps. Let `close()` dispose Miniflare and owned listeners and let the CLI helper terminate its own child. Check for surviving owned processes after a failed run; never terminate unrelated jobs. Delay removal of owned runtime state until evidence has been preserved and consumers have finished.
