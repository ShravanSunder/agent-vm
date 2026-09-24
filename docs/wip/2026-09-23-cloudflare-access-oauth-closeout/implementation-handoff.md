# Cloudflare Access OAuth and Hermes approval WIP handoff

Date: 2026-09-23 (America/Toronto)
Stage: blocked, preserved implementation; not reviewed or PR-ready
Repository: `agent-vm`
Branch: `investigate/sunclaw-oauth-access`
Implementation base: `f1f51c4bf22c9bc8815dcb112dfc4ca5cfb0b7fa`
Source request: replace Clerk/Tailscale browser admission with Cloudflare Access, then prove managed Hermes approval in the isolated beta.

## Governing plan and scope

The current, ready implementation plan is `tmp/plan-workflows/2026-09-20-cloudflare-browser-identity.md`. Its delivery-bearing record is reproduced below with only the private reviewer session identifiers omitted:

```text
plan path: tmp/plan-workflows/2026-09-20-cloudflare-browser-identity.md
originating planner: plan-implementation
planning result: ready
governing planning basis:
  kind: reviewed-three-artifact-design
  Requirements: docs/specs/2026-09-20-cloudflare-browser-identity/requirements.md
  Specification: docs/specs/2026-09-20-cloudflare-browser-identity/specification.md
  Program Design: docs/specs/2026-09-20-cloudflare-browser-identity/program-design.md
  review: tmp/review-2026-09-20-cloudflare-browser-identity/final-verification-2.md
  review identity: retained in the private local plan; omitted here to keep session identifiers out of the public handoff
  applicability: branch investigate/sunclaw-oauth-access at f1f51c4bf22c9bc8815dcb112dfc4ca5cfb0b7fa; f2fd0a3 is inspected prior art on fix/oauth-beta-hostname, not cherry-picked
delivery context:
  requested terminal: pr-ready-unmerged
  delivery grouping: single:cloudflare-browser-identity-cutover
  PR topology: one-pr
```

The governing Requirements, Specification, and Program Design are included in this WIP commit under `docs/specs/2026-09-20-cloudflare-browser-identity/`. This closeout is a preservation checkpoint, **not** the plan's terminal result. No production DNS, Access, Tunnel, provider, credential, or catalog change is included. The owner stopped new implementation and beta reproduction before this handoff; no PR or merge is authorized by the closeout.

## Included implementation inventory

Before staging, the task tree contained 99 tracked modified/deleted paths and 10 untracked paths, with an empty index. The commit includes all 99 tracked task paths and nine of those untracked paths, plus this handoff and its continuation prompt. The commit's `git show --name-status --format= HEAD` is the exact per-file inventory; these are the responsibility groups:

| Paths | Work preserved |
| --- | --- |
| `.gitignore`, `docs/README.md`, `docs/architecture/overview.md`, `docs/getting-started/google-onboarding.md`, `docs/reference/configuration/**`, `docs/subsystems/controller.md` | Access/Tunnel configuration and operator documentation; obsolete OAuth v2 example removed and v3 example added. |
| `packages/agent-vm/**` | Access verifier, loopback OAuth HTTP runtime/routes, callback diagnostics, manual template, integration and host proof; obsolete Clerk/Tailscale and TLS-fixture paths removed. |
| `packages/config-contracts/**`, `packages/oauth-approval-ui/**`, `packages/oauth-broker-contracts/**`, `packages/oauth-broker/**` | Version-3 Access identity/config and browser ceremony cutover, Clerk UI removal, issuer+subject authority, exact resource-scope and policy protections with tests. |
| `packages/agent-vm/package.json`, `pnpm-lock.yaml` | Direct `jose` dependency and intentional Clerk dependency pruning. The large lockfile deletion was audited previously, not treated as an accidental rewrite. |
| `python/agent-vm-hermes-adapter/src/**`, `python/agent-vm-hermes-adapter/tests/**` | Closed-enum, content-free approval capture/bridge/presenter diagnostics and fail-open telemetry tests. This is diagnostic-only; it does not fix approval behavior. |
| `docs/specs/2026-09-20-cloudflare-browser-identity/{requirements.md,specification.md,program-design.md}` | Reviewed governing design inputs. |
| `docs/wip/2026-09-23-cloudflare-access-oauth-closeout/**` | This durable WIP state and a context-free continuation prompt. |

The nine formerly untracked included files are `docs/reference/configuration/examples/oauth-v3.config.jsonc`, the three governing design files above, `packages/agent-vm/src/controller/oauth/cloudflare-access-identity-verifier.ts` and its unit test, `oauth-access-http.integration.test.ts`, and `oauth-google-callback-diagnostics.ts` and its unit test. The tracked-path list and exact deletions must be reviewed from this commit, not inferred from the group summary.

## Excluded and preserved locally

- `docs/wip/2026-09-20-cloudflare-access-continuation.md` remains untracked and local. It is a historical session/workstation checkpoint, not the public implementation contract. Do not delete it merely to make `git status` clean.
- Ignored `tmp/` plans, debug investigations, reviewer packets, and beta receipts were **not** staged. This handoff records their relevant conclusions; the private beta checkpoint and diagnostic collector remain in the separate beta checkout.
- Private beta OAuth catalog backup, state, logs/transcripts, credentials, secrets, tokens, and any disposable generated images/tarballs were not copied or staged. The owner-authorized beta-only catalog archive/reset remains reversible in that private checkout.
- No beta, provider, production, DNS, Tunnel, or Calendar state was changed during WIP closeout.

## Shared work trail

This is an explicitly **unshared** stop/commit checkpoint. Main attempted to reopen historical board root `01a0bc05-edb7-7f43-9494-0f064748f1d7` on the current local Router service and received `invalidRootMessage`; the current service did not list an Agent VM project. The historical root belongs to the separate Sunclaw Router service `8b61218b-d5f3-4ae9-a2db-d2fb4075dbc2`. Do not invent a replacement thread or claim that this handoff was posted. A future authorized coordinator should recover that exact service/root, read its current history, then reconcile this committed checkpoint without replaying stale messages.

## What works and what remains unproved

The local cutover removes active Clerk browser admission and the Tailscale browser resolver. The OAuth website uses a configurable HTTPS public origin through Tunnel to a loopback HTTP listener; the controller/admin listener remains separate. Access JWT admission is issuer+subject based. Sensitive browser actions and serialized policy commits recheck identity and local expiry; CSRF, Origin, state, PKCE, browser binding, exact resource scope, and anti-rebinding checks remain fail closed in source and focused tests. Existing local ten-/five-minute ceremony deadlines were retained. These are implementation and local-proof claims, **not** blanket live-provider qualification.

In the isolated beta, Access admitted the mapped owner and showed the account UI. An earlier Google callback correctly returned `authorization-denied` against a legacy Clerk-owned catalog account. The owner authorized a private, reversible beta-only archive/reset; fresh zero counts were verified, then a new Access-owned Google resource enrollment completed through the connected page with the approved Gmail read, Contacts read, Calendar read and Calendar events write groups. The account-policy save was separately confirmed: Calendar Read `allow`, Calendar Write `ask`, Contacts Read `allow`; status-only catalog counts were one account, one authorization, one policy and five permission events. The beta owner verified configured Tunnel-to-OAuth routing and loopback-only listeners. These are separate Access admission, resource-consent, and saved-policy proofs; none proves native per-call approval.

One later Discord Calendar create was visibly outgoing and reached Tool Portal, but the bot replied `failure: approval unavailable` without a native Ask prompt or Calendar write. The first installed diagnostic yielded `capture/captured=2`, no positive `present` reason, and one Tool Portal call. This does **not** establish the exact presenter failure. Diagnostic v2 adds only static `bridge-entered`, `presenter-entered`, and early-exception reasons at the existing Hermes adapter seam. Beta source sync/build/validate exited 0, validation was 15/15, three changed production Python modules matched the built image and running Gateway VM, controller/zone/service returned 200/200/200, and catalog/owner binding was unchanged. The safe five-minute metric collector had zero rows before a new request. A different Sept 25, 18:00–18:15 UTC synthetic label was searched in the signed-in testing Calendar and returned `No events found`; its matching Discord draft remained **unsent** when work stopped. There is no post-v2 approval reason, successful native Ask, or create/read/delete/cleanup proof. Do not infer an ingress failure from pre-dispatch zero metrics or replay an uncertain create.

The most recent computer-control attempt to inspect Discord returned `cgWindowNotFound` for both the display name and bundle ID; it sent nothing. On an earlier draft, computer-use review rejected Command+Return as an alternate Send; that denial was not an invitation to bypass the human-originated Discord route with controller HTTP. The controller exposes no external approval HTTP route; its in-VM agent-message API is not approval authority. Preserve the Discord user-originated session and native challenge boundary when the investigation resumes.

## Validation receipts and limits

The test results below preceded this documentation-only closeout; `pnpm check` was also rerun after staging the handoff and passed. These are not tests run on a pushed PR head:

| Command / proof | Observed result |
| --- | --- |
| `pnpm test:unit` | 408 files, 4,626 tests passed; exit 0 after the callback diagnostic. |
| `pnpm test:integration` | 80 files, 910 tests passed; exit 0 after the callback diagnostic. |
| `pnpm check` | 16/16 gates passed; exit 0 on the final diagnostic source snapshot and again after this handoff was staged. Includes build, lint, format, type-aware lint, TypeScript typecheck, taxonomy and architecture guards. The first sandboxed closeout attempt exited 1 before checks because tsx could not bind its local IPC pipe; the host-local retry passed. |
| `pnpm python:test:hermes` | Pinned Hermes suite 223/223 passed; exit 0 after diagnostic v2. |
| Touched-file Ruff lint/format and `git diff --check` | Exit 0 after diagnostic v2. |
| `pnpm python:typecheck:hermes` | Exit 1, 12 previously existing diagnostics in untouched files; none in new diagnostic code. This is not part of `pnpm check`. |
| Focused Access HTTP integration | 5/5 passed; exit 0. Public OAuth app lacks `/health` locally. |
| Controller OAuth runtime integration | 6/6 passed; exit 0. |
| Built-CLI manual smoke | 1/1 passed; exit 0; generated Access/Tunnel guidance inspected. |
| Pinned-Hermes real-image presenter E2E | 1/1 passed; exit 0 for synthetic clarify ownership, not a live Discord approval. |
| Beta `pnpm dev:sync-tarballs`, `mise exec -- pnpm build`, `mise exec -- pnpm validate` | Each exit 0 for diagnostic v2; validate 15/15; one graceful beta restart and installed/running artifact parity. |

For exact earlier commands, test output provenance, and changed-path detail, consult the ignored local `tmp/review-handoffs/2026-09-23-agent-vm-investigate-sunclaw-oauth-access-pr-readiness/implementation-handoff.md` and `tmp/debug-workflows/2026-09-23-agent-vm-investigate-sunclaw-oauth-access-hermes-approval-presenter/debug-investigation.md` when available. Their lower continuation sections contain superseded intermediate claims; the latest status above controls this checkpoint. The beta checkout's `tmp/cloudflare-access-beta/2026-09-22-beta-live-proof-checkpoint.md` proves the owner-approved legacy catalog cutover and fresh enrollment, but its older policy-preview section is stale after the saved policy.

## Remaining gates and continuation

1. Resume only on fresh owner direction. Inspect current branch, installed beta version, Calendar exact-label state, and the unsent Discord draft before any new request. Never send an expired draft or duplicate an uncertain create. Obtain a new native user-originated request and only closed-field OTel reason counts to isolate approval bridge/presenter failure; prove a source cause with a failing test before changing behavior. Keep the approval policy, principal, state, and exact retry fail closed.
2. After a bounded fix, rerun focused red/green proof, pinned Hermes image tests, relevant repository gates, and isolated beta Ask-gated create/read/delete/cleanup with a new unique test event. No native Ask or cleanup is yet proven.
3. Obtain authenticated public-origin HTTP evidence that controller/admin routes are inaccessible. The attempted signed-in browser probe ended client-side `ERR_BLOCKED_BY_CLIENT`, not an HTTP result. Existing Tunnel target and loopback socket checks prove configured isolation only.
4. Qualify Access renewal, logout/revocation, and callback edge behavior live where safely feasible. Treat unrun external cases as open, not as local-test failures.
5. Have Main assess the exact preservation commit and proof against the reviewed design/plan. Commission an independent different-lineage `implementation-review` on the current commit; `/tmp/cloudflare-access-review/review-result.md` was `needs-revision` for an older snapshot and cannot accept this one.
6. Only after correction and current review, perform PR wrap-up: current-head CI, review comments/threads, mergeability, and final quiet poll. This WIP closeout deliberately opens no PR and performs no merge or production deployment.

Security review should focus on Access issuer+subject admission, optional display email, bounded JWKS retrieval, callback state/PKCE/Origin/CSRF/browser binding/local expiry and exact scope, owner anti-rebinding, public/admin listener separation, and static fail-open diagnostics. No current independent review accepts all of those paths together.
