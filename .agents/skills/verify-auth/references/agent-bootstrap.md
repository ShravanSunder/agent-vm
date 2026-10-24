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
| Build/artifact | Build workspace dependencies from that frozen source with its frozen lockfile. Retain the build command, exit and artifact identities. The harness bundles `auth-proof-entrypoint.ts` and `packages/tool-host-cloudflare/src/test-fixtures/workspace-gateway-proof-entrypoint.ts` with pinned esbuild and passes those actual module contents to Miniflare. Compare executed module/build identities with the declared frozen build; stale `dist` output or an unrecorded overlay is a prerequisite gap. Source HEAD alone cannot identify an executed build. |
| Configuration | Read the frozen harness's issuer construction, compatibility date/flags, D1 and named binding declarations, two Gateway heaps, three workspace configurations, trusted Tool Portal origin, resource addresses and `remembered-login` setting. Compare the configuration actually passed to Miniflare. Only loopback addresses/runtime roots may be assigned dynamically by that fixture; retain their private mapping. A different configuration needs a newly declared target. |
| Client | Read the declared target's `packages/auth/src/test-fixtures/local-auth-harness.ts`, `packages/auth/src/test-fixtures/native-cli-proof.ts`, `packages/auth/src/native-owner-cli/owner-cli.ts` and `packages/auth/src/native-owner-cli/owner-cli-login.ts`. The harness calls `loginThroughNativeOwnerCli`, which spawns the delivered `scripts/verify-auth/owner-cli.ts` entry with the fixed public code+S256 client, loopback callback, management audience, selected workspace and short private cache. Compare that executed entry and its client/redirect/audience with the frozen source; helper-only login is insufficient. Do not substitute WIP or dirty driver code. |
| Offered inventory | Collect `mise exec node@24.7.0 -- pnpm exec vitest list --project e2e-host packages/auth --json` on the same source. Compare offered names/files with selected runner files and `agent:` or `bootstrap:` selector, then compare the executed report's selected names/counts. Discovery is inventory only. Missing accepted cases remain gaps; they cannot disappear behind a positive count. |
| Host/toolchain | The runner checks hostname and Node24.7.0. Check pinned pnpm/toolchain and installed lockfile as well. Run real workerd/D1 proof on the Lead-admitted execution host and slot; local static checks do not replace that target. |

If a driver does not yet retain enough evidence to complete a comparison, report that exact gap and do not count the run as verification. A failed prerequisite must not become a product assertion failure. Run each command in its released execution slot without load admission checks or load waits. Retain bounded timeouts, owned process-group cleanup and terminal receipts; report timing failures for diagnosis.

## Run the selected journey

The existing CLI forms are:

```bash
mise exec node@24.7.0 -- pnpm exec tsx scripts/verify-auth/verify-auth.ts bootstrap --target-file "$AUTH_VERIFY_TARGET_FILE"
mise exec node@24.7.0 -- pnpm exec tsx scripts/verify-auth/verify-auth.ts agent --target-file "$AUTH_VERIFY_TARGET_FILE"
```

For a chosen evidence root, set `TMPDIR` to an existing absolute, user-owned mode0700 directory outside Git before running either command. The runner creates its `2026-10-verify-auth-*` evidence child there, and the harness uses the same `tmpdir()` for runtime SQLite and native CLI targets. Retain the actual paths the runner prints; an output-directory flag is not provided.

Set `AUTH_VERIFY_TARGET_FILE` to the private declaration established above; run only the chosen journey. Select Node24.7.0 explicitly for every invocation: the runner refuses other versions, and the checkout's mise configuration does not pin Node. `--help` describes the interface; keep the explicit Node selector above even if its usage example omits it. The runner starts permanent host tests and retains a private Vitest report. Interface/help success does not establish journey operability. Inspect actual output and assertions rather than assuming a documented command has passed.

The harness applies canonical migrations as one ordered real D1 batch, starts the issuer and production Gateway/DO, and supplies a controlled external Google code/S256/ID-token protocol. Better Auth itself creates the person, session, cookie, OAuth client and JWT/JWKS. The upstream records independently which workspace's credential caused each effect. The Tool Portal-owned proof wrapper delegates ordinary traffic to production `index.ts` and only adds read-only workspace membership/removal maps. Auth bundles its repository path string; Auth must not import Cloudflare source into its TypeScript program. The storage reader does not preseed membership.

### Bootstrap

Use `packages/auth/src/agent-issuer.host.e2e.test.ts`, selected by `bootstrap:`.

1. Drive the delivered native CLI. Its authorization URL starts the real provider flow; the fixture completes the external protocol. Observe the genuine Better Auth callback/cookie and live bound owner. Provider-fixture success alone does not establish a person proof.
2. Send same-origin cookie-only owner bootstrap. Observe exactly one fixed public native client with code-only, PKCE and management-only policy, owner state and no client secret. Check the initial intent/outcome audit separately. Repeat the request and compare the client, resource-link and owner rows; these repeat readbacks do not assert unchanged audit rows. A bearer-bearing bootstrap request must refuse.
3. Continue real native authorization and S256 token exchange through the loopback listener. Observe a management-audience JWT with real session identity, no refresh token and lifetime at most300s; verify through actual public JWKS. A missing Location/code, provider error, consent page or JSON redirect is a diagnostic result to inspect, not permission to invent a callback code.
4. Inspect mode0600 private cache/target handling and absence of captured tokens, codes or cookies in CLI output. A valid cached login does not waive the next command's live server checks.

The permanent assertion inventory determines which observations are executable. Return missing direct client/audit/claim/output assertions as gaps rather than inferring them from a nonempty token.

### Agent

Read `agent-issuer.host.e2e.test.ts`, `agent-registration-faults.host.e2e.test.ts` and every additional selected management/race/CLI test offered by the frozen runner.

1. Obtain owner proof through the delivered native CLI/bootstrap path. POST `/management/workspaces/<workspaceId>/agents` with `requestId` and a configured `persona`. Omit `clientId` to register; include it to link an existing client. Registration requires private credential output; linking returns no credential or rotation. The named binding uses `registerAndLink`, `link`, `unlink` and `disable`, with no `changeClient` compatibility method.
2. Inspect real D1 for exact E9 grant/scope/Basic/org-only metadata; E6 identifier `<trusted Tool Portal origin>/workspaces/<UUID>/mcp`, workspace/org metadata, agent-only scopes and null custom claims; and E11 links. Read intent/outcome audit records back for client, resource and link mutations. Observe workspace membership/persona and a live-owner recheck before credentials are released.
3. Link the same client to O1/W2 as well as O1/W1. Issue separate tokens at the actual token endpoint with `resource` selecting W1 or W2. Verify real JWT/JWKS `organization_id`, `workspace_id`, requested audience and absence of `sid`/refresh token. Call each production workspace MCP address and require its intended upstream credential/effect, with zero sibling/foreign effects. Cross-present W1 at W2 and O2/W3. Check foreign/unlinked issuance as `invalid_target`, cross-org link refusal without mutation, and incompatible resource refusal without overwrite.
4. Preserve every accepted S1 case below on its adapted workspace route. Forbidden grants create no code; rejected token/management responses contain no credential in either snake_case or camelCase, including nested values. Compare the protected state, attributable audit changes and effect ledger as each case specifies. Public binding aliases, forged actor fields, owner cookies, E10 and signed no-sid identity never grant Person authority.
5. Inject retained actual D1 registration/rotation/disable faults and added resource/link audit intent/outcome faults. Read partial rows and absent membership/credential release. Retry the same intent to one audited working client, rotating a lost secret only where registration recovery requires it. A reused request ID with changed operation/client/org/workspace refuses as `operation-conflict` without additional mutation.
6. Remove W1 through its workspace DELETE. Old W1 calls in warm heaps refuse after membership removal; before a failed unlink finishes, issuance may still succeed, so observe that between-writes gap explicitly. An authorized status retry completes unlink; new W1 issuance then gives `invalid_target`. Require a NEW W2 token/effect, W2 membership/link retained and the client still enabled.
7. Retire through `DELETE /management/organizations/<org>/agents/<client>`. Every configured workspace membership is removed before one global `disable`; no unlink is required. Read disabled state and audit completion. Old calls refuse and new token requests give `invalid_client`; leftover links are allowed. Separately unlink the last link, then call the actual named `disable` RPC without any workspace field.
8. For WS11, hold retirement B at the real provider owner read after remove A left a pending unlink. Read membership still removed and pending disable B in the touched workspace objects before releasing the hold. Finish retirement, then retry stale A. Require retired completion without restoring membership, repeating disable or unlinking A. Portal's focused proof observes exact sign-in call counts; Auth reads actual provider disable writes, D1 links/audits and workspace state.
9. Exercise all seven J checks: held post-signing unlink (`invalid_target`), held disable (`invalid_client`), old token after membership removal before unlink (call refused), resource custom-claim organization override (`invalid_client`), workspace override (`invalid_client`), forced cross-org E11 link (early `invalid_target`, no signing), and resource organization changed after correct signing (`invalid_client`). Actual signed tokens must be withheld by the final fresh client/resource/link fence.
10. Link/scope the real public Person code client to a workspace in test composition. Its genuine code exchange must still refuse workspace proof as `invalid_target`. Use the issuer's authentic keys to sign the legacy Worker-wide audience without `workspace_id` only as a negative control; it must enter no workspace. Positive agent/link/unlink/retirement journeys always use actual issuer APIs.

These steps implement workspace-unit r3 amendment 2 and the canonical Step 0 ruling, including Later rulings 3, 5 and 6, in the design worktree's `tmp/plan-workflows/`. E6/E10/E11 and J are defined in the adopted people-sign-in design at `a2e0116c`. Read the governing sources when deciding an expected result; missing sources are a prerequisite gap. D2's organization-specific sign-in DO owner/allowlist is owner-decided; implementation is deferred beyond W-cut. Configured organization facts remain a stand-in, not a proof of that storage integration.

The agent runner selects all offered `agent:` cases from retained S1 files plus `workspace-agent-issuance`, `workspace-management-boundaries`, `workspace-management-audit-faults`, `workspace-person-boundary`, `workspace-retirement-overlap` and `workspace-owner-cli` host files. Compare exact names/files against offered inventory. Preserve an explicit old-to-new map for all 28 accepted S1 cases (process 2, bootstrap 3, agent 23); do not replace an old positive path with a refusal or infer preservation from a count. Process lifecycle cases remain their separate gate before journeys.

Predeclare the two additional Auth wrong builds: skip only the final link fence and derive workspace identity from a discriminating wrong source. Retain each exact selected runtime assertion red, restored same-case green, source/module restoration and bounded cleanup. The historical three S1 controls below remain separate evidence; new setup/compile/timeout failures are not sensitivity reds.

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
| Named service route reachable by public URL/header | `owner-authority-boundaries.host.e2e.test.ts`: `agent: real non-owner E7, forged actor input and public binding URLs never acquire owner authority across concurrent requests` (explicit `/changeClient`, `/isLiveOwner` and named-entrypoint public aliases with forged headers/body) |
| Agent or no-sid proof treated as a Person | `management-boundaries.host.e2e.test.ts`: `agent: every management boundary refuses real E10 and signed management no-sid identity before protected reads or effects` (refusal bodies, rows/audits and effects; guard order is source-inspected, not a runtime read-count assertion) |
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
