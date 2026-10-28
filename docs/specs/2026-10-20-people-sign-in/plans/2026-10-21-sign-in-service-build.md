# Build the sign-in service

> **Superseded (2026-10-24).** This plan was built from (S1, PR #263) and is a record only. The remaining sign-in work is planned from the revised [agent identity](../../2026-10-24-agent-identity/program-design.html) and [people sign-in](../program-design.html) designs and ordered by the [delivery orchestration](../../2026-10-24-delivery-orchestration/program-design.html) design. In particular, its promise that a failed agent registration can be retried to obtain a usable credential no longer holds: a lost one-time secret is never recovered, and the credential is retired and provisioned anew through Fleet central.

One `@agent-collaboration/auth` Worker per deployment runs Better Auth on D1. The first delivery registers an agent through the Gateway's owner-only management handler, obtains a real E10, and runs a Gateway tool with it. Sign-in owns the credential; the Gateway owns tool admission. The controller keeps Cloudflare Access.

**Status: accepted by the Lead for S1, with the Decision A ruling below (2026-10-21).** S1 still needs the owner's permission for the new package's tsconfig before it starts. S2–S6 keep their named preconditions (F-56 UI view, the real `decide` target, OAuth test apps and identities). S7 stays gated on the owner's D1–D3.

## Planning record and authority

```text
originating planner: plan-implementation
planning result: accepted by the Lead for S1 (Decision A ruled; governing docs amended)
plan identity: this file, as accepted by the Lead on 2026-10-21
result payload: S1 waits only for the owner's tsconfig grant; later slices keep
  their named preconditions
requested terminal: plan-only
delivery grouping: selected:worker-first-linear-stack
PR topology: separate-prs, one dependent linear stack
tracking disposition: existing Router work thread; no additional tracker
planned at: docs/tool-portal-design / 4859221c29ccf87b553b55da7d0363432761e66b
source target: tool-host-core/runtime-neutral-hosting / 14cd48921e4d27f8e6cc6f7090b30cf42d5e5272
```

The governing basis is the four distinct documents: [Requirements](../requirements.md), [Specification](../2026-10-20-people-sign-in.md), [Program Design](../program-design.html), and [Verification Design](../verification-design.md). Their last change is `df2d967685fb77e21e7097b3f84d319a35abc6f9`; `git diff df2d9676 HEAD` over that folder is empty.

Independent correction checks are board messages `01a15c2d-0000-7000-8000-000000000001` at `d526f9e4` and `01a15c2f-0000-7000-8000-000000000001` at `df2d9676`. The latter closes the resource-link, post-signing race and organization-equality findings; no findings remain in that review. The Lead's trace checkpoints dated 2026-10-21 ~02:30Z and ~02:40Z record its source verification and closure; those entries were read. This is design-review evidence, not implementation proof.

The commission and follow-ups override the older SD9 default: **owner only**, through the named service-binding route. The Lead approved configured organization/owner facts initially, org decisions last, and the Worker as the first proof path. These directions do not settle the final SD9 policy or org D1–D3.

Work home: Router service `0ff962c5-7fa3-4c18-a5ca-1bbe8db09e89`, project `01a14e9e-ba87-7605-bc7b-7e6be7931fb1`, board `01a14e9e-ba87-7605-bc7b-7e6cdff4d3a5`, topic `01a14e9e-ba87-7605-bc7b-7e6d49d07e5f`, root `01a14e9e-ba87-7605-bc7b-7e6eff6ec101`. Process checkpoints belong there, not in this document.

## Scope and current source

Deliver private and public sign-in, service-bound person and agent tokens, owner bootstrap, allowlist/removal, explicit provider linking, passkeys, audit, production verifier integration and private deployment proof. Public registration stays required; private-first orders the work, not its deletion.

Keep controller identities and stored OAuth grants unchanged (SD5). Machine, VM, VPN and Router authentication remain outside this service. Exclude fleet enrollment, Router identity attestation, general per-call approvals, a new audit platform, a reconciler/queue, paid-plan adoption, package relocation and public deployment to real users. No Gondolin or Hermes patch is needed.

Sources inspected at `14cd4892` in PR #248:

- [Agent proof contract](https://github.com/ShravanSunder/agent-vm/blob/14cd48921e4d27f8e6cc6f7090b30cf42d5e5272/packages/tool-access/src/contracts/agent-proof.ts#L45): `AgentTokenVerifier`, real JOSE verification, a single-string audience, no `sid`, UUID organization, equal `sub`/`client_id`/`azp`, required agent scope. Reuse this contract; do not duplicate it in auth.
- [Caller admission](https://github.com/ShravanSunder/agent-vm/blob/14cd48921e4d27f8e6cc6f7090b30cf42d5e5272/packages/tool-host-core/src/caller-admission/caller-check.ts#L8): every request verifies the token, then reads current organization admission. Token claims alone never admit a tool call.
- [Hosted proxy](https://github.com/ShravanSunder/agent-vm/blob/14cd48921e4d27f8e6cc6f7090b30cf42d5e5272/packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-proxy.ts#L140): injected verifier and organization directory; `hostedAgentVerifier` constructs the production verifier.
- [Worker entry](https://github.com/ShravanSunder/agent-vm/blob/14cd48921e4d27f8e6cc6f7090b30cf42d5e5272/packages/tool-host-cloudflare/src/index.ts#L32): issuer, JWKS URL and audience bindings construct that verifier. The test issuer is replaced by configuration plus real issuance, not by weakening this check.
- [Node composition](https://github.com/ShravanSunder/agent-vm/blob/14cd48921e4d27f8e6cc6f7090b30cf42d5e5272/packages/tool-host-node/src/node-host-composition.ts#L83): standalone bearer credentials, not E10 injection. Preserve that behavior; the commission's suggestion that both hosts already inject E10 is not current source reality.
- [Local Worker harness](https://github.com/ShravanSunder/agent-vm/blob/14cd48921e4d27f8e6cc6f7090b30cf42d5e5272/packages/tool-host-cloudflare/src/test-fixtures/local-worker-harness.ts#L43): local workerd, isolated persisted state and controlled upstream. Today it signs fixture tokens and sets admission through a proof-only route. Retain that fixture for hostile tokens; add a real-issuer journey beside it.
- [Private Worker deploy plan](../../2026-10-14-portable-tool-portal-hosts/plans/2026-10-21-private-worker-deploy.md): the production agent-management route is absent. The first slice must build it.

### Package and responsibility boundaries

Use `packages/auth/`, package name `@agent-collaboration/auth`, matching `packages/*` workspace discovery. One package with separate core and Worker exports is enough; a second package would add release plumbing without another consumer yet. Follow the existing package aliases, build and lint conventions; keep files under 600 lines. Expose the core from `@agent-collaboration/auth/core` and the Worker adapter from `@agent-collaboration/auth/cloudflare`; importing the core must not load Better Auth. Add exact Better Auth/provider/passkey pins, the existing Wrangler/workerd tool versions as package dev dependencies, a package build/typecheck entry and lockfile updates in S1; extend the existing guards rather than adding another quality-gate runner.

```text
packages/auth/
  src/
    sign-in-core/             exported without Better Auth or runtime imports
      models/                 parsed config, outcomes and consumer-owned ports
      private-admission/      verified-email, binding and active-person rules
      response-release/       final session/token/introspection decisions
      security-audit/         allowed event shapes and change coordination
      agent-clients/          E9 registration/disable rules
    better-auth-provider/     library configuration, hooks and HTTP adaptation
    cloudflare-host/          fetch + named service entrypoint; env -> ports
    d1-persistence/           migrations, primary reads, conditional writes/batches
    sign-in-pages/           sign-in, account, consent, owner administration
  migrations/                versioned SQL, no deployment values
  wrangler.example.jsonc      placeholder bindings only
scripts/verify-auth/          permanent journey runner and readback drivers
.agents/skills/verify-auth/   lasting journey instructions, created with the drivers
```

The core uses Web `Request`/`Response` and parsed values, with injected clock, IDs, identity-provider HTTP handler, semantic persistence operations and audit/log sinks. Its ports return domain outcomes, not D1 prepared statements or Better Auth internals. The Worker actually calls these same exports. Better Auth, D1 types, Cloudflare bindings and platform compatibility flags stay at adapters. Do not claim Better Auth's entire dependency graph is a runtime-free core.

Keep raw/projection token contracts and the new person verifier in `tool-access/contracts`, as Program Design requires. Auth may consume that package; neither access nor engine imports auth. Put the two-write agent-management coordinator's neutral logic in `tool-host-core`, its DO effects in the Cloudflare adapter, and its sign-in service-binding client at that adapter. No reverse call from sign-in to the Gateway.

```text
owner's live person proof -> Gateway management handler -> sign-in service binding -> D1 E9 + audit
agent credential         -> sign-in public token endpoint -> E10 -> Gateway verifier -> admission -> tool
```

The service-binding operation is a named entrypoint, unavailable from public `fetch`; a URL or forged header cannot select it. It accepts only the configured calling organization's operations and an attributable, verified acting Person. The Gateway checks that Person against its configured owner and current status. Never trust a body-supplied owner, organization or actor string as authority.

### Defaults and what can change them

| Decision | Draft default and reason | Dependent work |
| --- | --- | --- |
| SD1 | Deployment owner alone edits allowlist; one authority to check | S1 owner bootstrap, S2 administration, S5 audit |
| SD2 | Private first; public remains required in S6 | S1–S6 deployment order |
| SD3 | Propose **300 seconds** for both person and agent access tokens; limits ordinary person-access survival while avoiding a token request on every call | S1 issuance, S3 removal/expiry, S4 verifier, S5 CPU, S6 isolation |
| SD5 | Controller keeps Access; no automatic identity mapping | S1–S6 regression boundary |
| SD6 | Free until measured; never buy Paid as a fallback silently | S1 early sample, S5 full measurement, S6 second deployment |
| SD7 | Google/GitHub first, then session-authenticated passkey registration | S2 registration and pages, S6 public signup |
| SD8 | Propose **5 seconds**, measured at apply; bounds the race after a live status read and avoids refreshing an otherwise immediate apply | S1 management-person check, S3 introspection, S4 decisions |
| SD9 | Owner-only agent management is a stand-in; managers are refused | S1 coordinator, S5 hosted agent journey; S7 replaces only after a decision |
| Org D1–D3 | Configured UUID organizations and explicit owners; no membership plugin authority yet | S1 configured checks; S7 alone adopts new membership/link ownership |

Set both `accessTokenExpiresIn` and `m2mAccessTokenExpiresIn`, and each resource's `accessTokenTtl`, to the bound; check issued `exp - iat <= 300`. A resource override must not lengthen it. No `offline_access`, refresh-token client grant, device-code or extension grants. The five-minute bound is proposed policy, not measured compatibility. SD8 permits a check-before-removal apply within its bound; it does not promise instantaneous cancellation.

The SD9 stand-in gains an agent path now, costs owner-only administration and future policy rework, and closes only when the owner chooses authority and the real path passes. Configured membership gains independence from missing fleet contracts, costs manual configuration, and closes only through S7's reviewed ownership contract. Neither stand-in is proof of future fleet integration.

## Decision A: atomic E9 registration and audit

**The open choice:** how to keep Better Auth's server-managed registration and the design's single-D1-batch audit guarantee together. This is also relevant to client/resource updates and retirement, not just creation.

At Better Auth `1.7.12` / `f4260a95cddc0a7640f57c37cf624de019df324f`:

- [register.ts:966–1072](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/oauth-provider/src/register.ts#L966) calls `runWithTransaction`, then awaits a client insert, a resource-link read and link inserts. It does not expose a prepared statement batch containing our audit record.
- [dialect.ts:184–194](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/kysely-adapter/src/dialect.ts#L184) sets D1 transaction support to false; [d1-sqlite-dialect.ts](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/kysely-adapter/src/d1-sqlite-dialect.ts#L147) rejects interactive transactions and executes each query separately.
- [Provider documentation](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/docs/content/docs/plugins/oauth-provider.mdx#L1359) qualifies client/link atomicity on adapter transaction support.
- [D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) says a failed statement rolls the batch back. That protects statements actually in one batch; it cannot make an awaited Better Auth API call and a later audit insert atomic.

```text
required: one D1 batch [client + resource link + audit] -> release credential
default:  Better Auth client write -> resource lookup/write -> our audit write
```

| Option | Guarantee and change | Gain, cost and who pays |
| --- | --- | --- |
| A. Compose registration through a supported adapter API into one D1 batch | Preserves R12/V9 and the designed storage boundary **only if** the supported API can produce/stage all writes and return only after commit. No such composition was found in the inspected default path. | Closest fit; implementer must prove supported composition, hashing, generated IDs, resource checks and failure behavior. No SQL interceptor, speculative buffering adapter or deep-import shim is authorized. |
| B. Serialize registration in a Durable Object | A DO lock around calls into D1 **does not** make their writes atomic. Moving clients, links and audit into the DO's own transaction could, but changes the designed D1 authority and Better Auth adapter. | Serializes callers; costs a new owner/store and deployment/migration work. Lead must return that design change to the owner; it is not a drop-in solution. |
| C. Write audit intent first, then provider operation and outcome/reconciliation | A failed intent prevents the change and a lost outcome leaves an attributable intent: the R12 minimum can hold. It **does not preserve** the explicit one-batch client contract; a reconciler adds an unapproved recovery mechanism. | Reuses normal provider calls; operator pays for unresolved outcomes and recovery. Requires a design/proof change before adoption; do not quietly apply the passkey audit pattern to clients. |

The planner recommended investigating A first. The Lead's final ruling below selects C instead, using the Program Design's existing record-first pattern; no adapter is patched.

### Lead ruling on Decision A (2026-10-21, final)

The Specification requires that every change is recorded and that "a change whose record cannot be written MUST NOT happen" (`R12`, `V9`). "One D1 batch" was the Program Design's mechanism, not the Specification's. The Program Design already uses a second pattern for changes Better Auth writes itself (passkeys, linked logins): a before-change record, then the change, then an outcome record. **Client and relying-service changes, including agent clients (E9), now use that same pattern.** Better Auth writes those rows itself, and its D1 adapter runs no transactions. Program Design and Verification Design are amended to match (same commit as this ruling). Option C without a reconciler is selected; A is not pursued and B is not selected (B moves storage authority into a Durable Object, which would be the owner's call).

The contract S1 builds and proves:

1. **Before-change record first.** The agent-client route writes an attributable record (acting Person, change kind, request id, time) before calling Better Auth. If that write fails, Better Auth is not called: no E9 row, no resource link.
2. **Then the change, then the outcome record.**
3. **Readback before release.** The route returns the client's credential, and the handler writes admission, only after it reads back the client, its resource link and the record. Until then the registration reads as "incomplete".
4. **Allowed partial states:**
   - a record with no client (the change failed or the process stopped);
   - a client without its resource link (it can't get a token: `invalid_target`);
   - a client and link without an outcome record.

   None of these releases a credential or writes admission. The owner's retry completes or reports them; every write is idempotent. No background recovery.
5. **Disable** follows the same order: record, disable, outcome. Admission is removed before the disable, as the Program Design says.

The deciding test (workerd + D1, permanent) makes each write fail in turn: the record, the client, the resource link, the outcome. Each time it reads the rows directly and checks that:

- a failed record write leaves no E9 row;
- no failure returns a credential or writes admission;
- the registration reads as incomplete;
- a retry completes it with exactly one client and its records.

A real token exchange then succeeds only after completion. Repeat for disable and for client and resource changes. A mock, a mutex, cleanup after success, or a record written only after the change can't pass. No such test was run during planning.

## Branches, prerequisites and sequence

Use one linear `gh stack`, starting with `auth/s1-agent-issuer` **above PR #248**, base `tool-host-core/runtime-neutral-hosting` at `14cd4892`. `master` at `33914cbe` lacks `packages/tool-access`, so a fresh stack from master cannot deliver the first Gateway path. Later slices base on their predecessor. If the Tool Portal stack has merged before work starts, use the equivalent merged master and recheck the seam; do not cherry-pick a second copy of the host packages.

The alternative is auth-only work from master plus a separate integration branch; that splits the first proof across PRs and delays the requested real path. The selected stack costs dependency on #248's integration. It grants no merge, deploy or history-rewrite authority in this plan-only task.

```text
Tool Portal #248 + owner tsconfig grant -> S1 -> S2 -> S3 -> S4 -> S5 -> S6
                                                                           |
org D1–D3 + reviewed org contract -----------------------------------------> S7
```

Preflight before execution:

1. Re-read current instructions, four documents, accepted draft revision and exact branch/head/dirty state. Preserve other writers' work. Obtain explicit permission for any new/changed `tsconfig.json` required by the package; existing owner approval for tool-host-core paths is not auth approval.
2. Settle Decision A before client writes. Confirm F-56's sign-in/account/admin UI view before building those screens; backend preparation does not settle UI design. Confirm the real Tool Portal `decide` target for S4; it is absent from the inspected host checkout.
3. Confirm the Cloudflare test-account grant, two test OAuth apps and four identities named in Verification Design. Keep all their values outside repositories. Local tests can use fixed provider protocol responses but cannot earn hosted Google/GitHub proof.
4. Confirm Node 24/pnpm/mise, workerd, compatible Wrangler, D1 migrations and named service-binding support. The existing Worker suite runs on sunclaw; use that host for workerd proof unless this host's runtime is separately qualified. Plain Node unit tests run here.
5. Qualify the supported browser surface's virtual WebAuthn capability for observation B. Use computer-use/Chrome for on-screen proof, never a replacement Playwright UI path. If the surface cannot supply a virtual authenticator, return a verification-design gap; a Node WebAuthn verifier alone does not earn B.

## Proof-bearing slices

All commands in the next section are **planned interfaces to add**, except existing repo commands. Each PR keeps required checks and records exact pass/fail/skip counts, exit codes, target commit and prerequisites. A slice can land scoped code with a named pending external gate; it cannot claim its full requirement row passed until that gate runs.

### S1 — Real agent issuer through the Gateway

**PR 1:** `auth/s1-agent-issuer`, based on #248. Dependencies: the owner's tsconfig grant; Decision A as ruled (record-first); SD1/2/3/5/6/8/9 defaults; configured org facts, not adoption of org D1–D3.

Scope: add the package/core/Worker/D1 migrations, Better Auth OAuth/JWT configuration and primary reads; minimal owner provider sign-in and bootstrap sufficient to obtain an attributable live person proof; the shared person verifier and person/agent discrimination boundary; the owner-only Gateway agent-management handler and named sign-in binding; strict E9 registration; E10 issuance and final release checks; add/remove coordination and audit for those changes. The owner token names the management API's audience, and its live check reads the actual Person and session. This minimum person path is necessary for real owner authorization; do not substitute an arbitrary actor ID or publicly seed an agent credential. Final session/person-token/introspection checks required by this path land here; S3 completes their removal/race coverage rather than leaving the first owner path without those checks.

E9 is confidential, only `client_credentials`, only `tool-portal:agent`, metadata `{ kind: "agent", organizationId }`, one Worker resource link, and absent from `cachedTrustedClients`. Global provider scopes must register that scope, and privilege callbacks must authorize its explicit server-side assignment. Disable dynamic/unauthenticated registration. People use code+S256 PKCE only; generic JWT `/token` stays disabled.

Implement both early and **post-signing** agent checks. The final D1 read confirms active E9 and exact equality between signed `organization_id` and freshly read registration metadata. Publish real JWKS and configure the Gateway to trust this issuer. A signed agent token contains no `sid`; a person token contains one. Keep the existing `AgentProof` projection.

Add: client then admission. Remove: admission then client-disable+audit. Pending removal refuses tool calls even if token requests still work; retry the idempotent disable on owner retry/later management requests. Report complete only after both records read complete. No background queue. A binding failure, rejected actor or foreign org must not broaden authority.

Earn local J and agent G; foundations for U2/U4/U7, and U8 (`R15–R17`, `V11`) locally. Cover owner `R14`/V10 locally without claiming hosted H. Tests use real Better Auth token HTTP responses, workerd, D1 and Gateway DO, controlled upstream tools and direct storage readback. Run `C1`, `C2`, `C3` below; start lasting `agent` and `bootstrap` drivers now. On sunclaw run local workerd; after private deploy run J/H on T1+T5. Full U8 waits for the person-token counterexample and the deployed warm-instance run if unavailable in this PR.

Wrong builds: grant adds authorization code; resource link missing; agent cache enabled; final check deleted; resource custom claim overwrites org; admission cached; completion after one write; service route reachable by public URL/header; owner body trusted. Each must fail a named test and restore the correct source. Retain a positive real tool call so rejecting everything fails too.

### S2 — Private people, linking and passkeys

**PR 2:** `auth/s2-private-people`, base S1. Depends on SD1/2/5/7 and F-56's UI view. Scope: complete Google and GitHub admission, owner-only allowlist administration, explicit redirect linking/unlinking and account pages, passkey registration/authentication/removal, and each change's audit wrapper. Enable exactly the prescribed providers/plugins; offer no additional sign-in method.

Implement Program Design's verified-email gate, case folding and conditional E8 binding; owner binds once to the configured verified email. Implicit linking is disabled, different-email linking remains possible only when its own email is allowed, and ID-token linking is refused. A private Person is active only with a binding and all bound entries allowed. Cleanup deletes only still-unbound rows, never a concurrent admitted Person. Provider token columns are explicitly nulled on both account create and update; cookie account storage stays off.

Build A/B/H and their readback drivers. Earn U1 (`R1/R2/R8`, `V1/V6`, privacy), plus the admission/bootstrap portions of U2 (`R3/R14`, `V2/V10`). Run `C1`, `C2`, `C3` and `bootstrap`, `provider-sign-in`, `passkey` on T1; local provider fixtures are supporting proof only. Browser/provider steps may require the four approved human identities. Passkey B uses the qualified virtual authenticator; list real hardware and other browsers as unverified.

Wrong builds: first arrival becomes owner; unverified/unlisted profile creates rows; matching email implicitly links; passkey creates a second Person; no-session registration succeeds; repeat provider sign-in retains tokens. Inspect actual D1 rows and cookies, not only HTTP status. No public deployment yet.

### S3 — Removal, sign-out and race fences

**PR 3:** `auth/s3-removal-fences`, base S2. Depends on SD1/3/5/8. Complete removal/reactivation batches, session deletion, final checks on every session-cookie/token/introspection response, session-create tracking, conditional cleanup, and owner-active admin checks. Keep read replication off. No raw Better Auth person/token endpoint calls bypass the outer HTTP handler.

Earn sign-in-side U2 (`R4/R13`, V3), U7 removal events, and SD3 bounds. Schedule **all E cases 1–14**, including both cleanup-versus-rebind orders and failed cleanup; no sleeps, hold only at the named test-composition steps. Keep separate cases for before-final and after-final release. Agent J held tests from S1 remain. Run `C1/C2/C3`, then `removal` against T1; its T4 Accept branch remains open until S4.

Wrong builds: early checks alone, sessionless introspection active, stale owner allowed to administer, cleanup by request ownership, re-add creates another Person, or TTL resource override lengthens the bound. Read response, session/code/token rows, binding and audit. Hosted replication timing remains unverified even when ordered local D1 cases pass.

### S4 — Person proofs at the real privileged decision

**PR 4:** `auth/s4-person-decisions`, base S3 **and the accepted Tool Portal control/decide delivery**. SD3/5/8 and configured managers apply. If decide is on another unmerged stack, the Lead integrates that dependency before this PR; do not merge a guessed handler into auth or call a fake decide production proof.

Scope: complete the shared person verifier/host adapters begun in S1, in `tool-access/contracts` and the runtime hosts; real `explain/propose/decide/read` integration; apply-time freshness check. A valid signature is enough only for ordinary paths. Accept/Deny require the current Person and present session, authenticated introspection, and fresh `checkedAt`. Past five seconds, recheck or refuse. The Gateway still checks configured manager authority separately from identity.

Earn U4 (`R6/R7`, V5), the decision part of U2 (`R9`, V3), U8's cross-kind check, and complete D/F/G/C. Run `C1/C2/C3`; run `proof-audience` and full `removal` on T1+T4. F uses production decide and verifier calling T3 with an injected clock and held apply. Real console remains a scripted client stand-in, never console proof.

Wrong builds: array audience accepted; another issuer accepted; agent as person or person as agent; signature-only Accept; stale confirmation reused; introspection unavailable but apply succeeds. Include successful within-bound apply and count the state change once. Node standalone bearer authentication remains; any Node control verifier adapter is separate from replacing that existing agent edge.

### S5 — Private deployment, complete audit and cost proof

**PR 5:** `auth/s5-private-proof`, base S4. Depends on private test access and SD1/2/3/5/6/8/9. Adds only generic deploy templates, lasting drivers, audit export/redaction checks and qualification evidence plumbing; live deployment inputs remain private. Run the deployment procedure below and every T1 journey against the exact delivered artifacts.

Earn U5/R11/V8 on T1; complete U7/R12/V9 through I plus H/A/D/J; run U6/R10/V7 regression and no-machine client readback. Enumerate every R12 kind: owner binding; allowlist add/remove/re-add and Person reactivation; client/resource register/update/retire; passkey add/remove; login link/unlink; sign-in success/refusal. Include audit failure before Better Auth changes, missing outcome after intent, and failed whole batches. Decision A applies to every client/resource mutation.

Run `C1–C5`, all lasting T1 journeys and VM command `C6`. Search D1 audit export **and Worker logs** for the captured codes, tokens, cookies, passkey IDs and public keys; none may appear. Keep raw captures private and publish only redacted counts/commit anchors. Read deployed Worker version, D1 ownership/isolation and dependency/outbound inventory. No package on the controller/VM path may import auth/person verification.

Measure CPU for cold and warm owner callback, agent token exchange, JWKS, person token exchange, introspection, passkey registration/authentication and admin mutations under serial and representative concurrent requests. Collect per-route count, p50/p95/max CPU, failures/1102s and D1 reads/writes from hosted observations; wall duration is not CPU. Free has a documented 10 ms/request CPU allowance. Report the distribution against it; no local timing or average alone proves fit. If it does not fit, give the owner measured Free-versus-Paid evidence; don't purchase or weaken checks.

### S6 — Public registration and deployment isolation

**PR 6:** `auth/s6-public-isolation`, base S5. Depends on SD2/3/6/7. Public mode permits provider-first signup without the private allowlist and still enforces the proof/session, linking, privacy and audit contracts. Build T2 privately for testing, using separate Worker, D1, secrets/signing keys and issuer. Public-mode behavior does not authorize exposing a production public service.

Earn U3/R5/V4 through A/B/C on T2 and T4, and finish U5's T2 structural/release check. Run `C1/C2/C3`, then `provider-sign-in`, `passkey`, `proof-audience` against T2 and T4. Present tokens across deployments in both directions; verify separate storage and key sets as well as wrong-issuer refusal. Re-run shared code regression only where changed. Wrong builds: shared D1/keys, private allowlist leaking into public registration, issuer ignored. U3 is not silently deferred if the owner leaves SD2 unanswered.

### S7 — Organization ownership, only after D1–D3 settle

**Separate final PR:** `auth/s7-organization-membership`, base S6. This is a conditional follow-on, **not an admitted part of the four-document implementation**. No new U/R/V IDs are invented. The Lead must obtain the decisions and update/review the four documents and proof rows before making this slice executable.

If D1=C/D2=B/D3=A are selected, Better Auth organization membership becomes sign-in's truth; the fleet retains workspace membership/managers; explicit registrations remain E9 until a separately designed attestation exists. Replace only configured org-member facts assigned by that contract. Do not map client IDs, Router session IDs or workspace IDs by convention. Preserve existing UUID organization identity at the Gateway boundary or return a contract-change decision.

Inspect/configure organization creation privileges and roles explicitly: the plugin defaults allow user creation and grant the creator owner, and its `admin` role can change members. Those defaults do not implement SD1/SD9. Audit the selected ownership changes and prove reads/refusals on the real Gateway path before removing a configured source. A new fleet membership contract is external, unbuilt and not stood in by a snapshot.

## Commands, proof mapping and test disposition

Run from repository root through `mise exec --`. New journey commands below are an implementation contract, **not commands that exist today**. Their runner must fail on missing targets/prerequisites or zero selected observations; a skip is not a passed row. `AUTH_TEST_TARGET` refers to a mode-0600 file outside all repositories; the runner must not print its resolved values.

```sh
# C1: pure rules, JOSE signatures and verifier reason tables (existing runner)
mise exec -- pnpm exec vitest run --project unit packages/auth packages/tool-access/src/contracts packages/tool-host-core
# C2: module/HTTP composition only; no spawned workerd in this lane
mise exec -- pnpm exec vitest run --project integration packages/auth packages/tool-host-core
# C3: real local workerd + D1 + Better Auth + Gateway/DO, including held cases
mise exec -- pnpm exec vitest run --project e2e-host packages/auth
# C4: intended permanent driver interface, created incrementally in S1–S5
mise exec -- pnpm exec tsx scripts/verify-auth/verify-auth.ts agent --target-file "$AUTH_TEST_TARGET"
# Same interface: bootstrap, provider-sign-in, passkey, proof-audience, removal, audit
# C5: broad source and regression gates
mise exec -- pnpm check
mise exec -- pnpm test:unit
mise exec -- pnpm test:integration
mise exec -- pnpm test:e2e:host
mise exec -- pnpm test:e2e:inventory
# C6: real VM regression, with no sign-in configuration
mise exec -- pnpm test:e2e:vm
```

Project proof layers come from AGENTS.md's test taxonomy and `vitest.config.ts`. The Verification Design calls E integration on T3; because this harness spawns/executes workerd, classify its files as `*.host.e2e.test.ts` and report host e2e evidence. Keep ordinary module composition `*.integration.test.ts`, pure rules `*.unit.test.ts`; hosted/browser journeys are deployed proof. Inventory excludes host files and is not workerd execution. Add auth discovery to any explicit architecture/export guard list; prove C3 discovers and runs the intended cases without skips.

| Verification Design row | Slice earning it; command/journey | Independent oracle and limits |
| --- | --- | --- |
| U1: R1/R2/R8; V1/V6; privacy | S2: C1/C3, A/B on T1 | C1 steps 2–4; same Person ID, no forbidden rows/cookies, account token columns null; extra browsers/hardware unverified |
| U2: R3/R4/R9/R13/R14; V2/V3/V10 | S1 H foundation; S2 admission; S3 E1–14; S4 F and full D; C1–C4 | C1 setup/step 6, Spec failure table; storage state and actual apply, not mocked gate; SD3/SD8 policy and hosted replication limits remain named |
| U3: R5; V4 | S6: C3, A/B/C on T2+T4 | C2 and distinct storage/keys; public token refused by private service |
| U4: R6/R7; V5 (shares R8/R9/R13) | S4: C1/C3, C/G plus person-client grant readback | Exact token profile, single audience, `sid`, correct refusal reasons; scripted console is a stand-in |
| U5: R11; V8 | S5 T1, S6 T2: deployed readback + dependency/outbound check | Account-owned distinct D1s and delivered Worker version; SD6 measured separately |
| U6: R10; V7 (with R7) | S5: C6 + import guard + T1 client readback | C3 machines example; no auth dependency or machine client; VPN/Router remain outside this repo |
| U7: R12; V9 | S1 agent audits; S2 credential intents; S3 removal; S5 I/H/A/D/J: C3 + audit journey | Complete R12 kind table, actor/change/time, direct rows and secret search; retention/readers remain outside scope |
| U8: R15/R16/R17; V11 | S1 J/G local, S4 person counterexample, S5 J hosted: C1/C3 + agent journey | C4, exact E9 readback, forbidden grant, positive tool effect, warm removal, partial failure and all three held/conflicting-claim cases; host credential storage unverified |

All R1–R17 and V1–V11 are scheduled above. Structural obligations: F-52 core import/type guard plus plain-Node execution and real adapter delegation (S1); response-release coverage and request-local tracking (S1/S3); public-fetch exclusion of the service route (S1); artifact/privacy and deployed commit identity (S5/S6). No S7 work is counted toward these existing rows.

Use table-driven cases for token refusal order, verified-email mapper shapes, E8 active-state combinations and audit-kind coverage. Use the existing property-testing pilot only if adopted and pinned; do not add another framework here. Controlled interleavings are permanent tests with explicit events/clock injection, not randomized sleeps. Expected values come from Spec C1–C4, R/V rows and the fixed token profile, never from production helper outputs.

Existing overlapping tests: **keep** `tool-access/src/contracts/agent-proof.unit.test.ts`, core caller-check/organization-authority tests, Cloudflare worker proof suites and Node bearer/parity suites. **Extend** the real-issuer composition without replacing the hostile test-issuer fixture: the fixture is still needed to create invalid signatures/claims. Keep existing replay, concurrency, cross-org and upstream credential checks unchanged. There are no existing auth-package tests. No test removal or assertion weakening is planned.

At each integration gate, exercise the real entry and inspect the effect: S1 token HTTP -> Gateway -> upstream effect and D1/DO; S2 provider/browser -> persisted Person; S3 parallel removal -> final response/rows; S4 live confirmation -> real apply; S5/S6 exact deployed artifacts -> readback. Save wrong-build patch, red failure and restored-green evidence privately/through the work trace; never ship a disabled check or a wrong build.

## Private deployment procedure

The [existing private deploy plan](../../2026-10-14-portable-tool-portal-hosts/plans/2026-10-21-private-worker-deploy.md) supplies the CLI pattern, not a sign-in deployment grant. Before remote work, verify account authority and get the sign-in test-deployment grant if not already supplied. Planning performs no remote mutation.

1. Resolve credentials through existing environment or `op` without printing them. Store deployment manifests, OAuth app values, owner email, organization/owner mapping, issuer/audiences, RP origin/ID, Worker/D1 IDs, service-binding targets, Access values and test credentials in a user-owned mode-0600 directory outside **every** repository. Repo templates contain placeholders only; build output, sourcemaps, Wrangler state/logs and raw proof captures go outside too.
2. Use private Wrangler config to create the test D1, configure no read replication, apply checked-in schema migrations, then seed the configured owner entry through parameterized code. Do not interpolate the owner's email into a checked-in migration. Install Better Auth/provider secrets through private secret input, never command-line literal values.
3. Build the exact commit and inspect the Worker bundle. Deploy with public routes/preview URLs disabled first; configure the Access self-hosted application and owner/test-runner policies through `cf`; then enable only the protected test hostname. Verify anonymous denial before running anything. Do not publish a real hostname or open a production public route.
4. Add the Gateway's named service binding to the sign-in entrypoint; it needs no publicly reachable client-registration route. Point Gateway issuer/JWKS to sign-in. The existing Gateway Access transport gate stays for this private test. Browser/test-runner Access credentials are infrastructure admission, never an E7/E10 or authority to manage agents.
5. Run H/J first, then A/B/C/D/I and F on the real T4 target. Verify Access does not block Gateway JWKS fetches: use the protected test-runner transport credentials at the adapter/private deployment boundary. If a service-binding JWKS transport is needed, route it through the already injectable fetch port and prove the actual path; never bypass Access or alter core authority silently.
6. Read Worker version and D1 bindings back through the provider tools and retain private receipts. Run the privacy scan on tracked files, staged diff, bundles and generated config. A scan failure blocks publication. No account IDs, actual emails, hosts, secrets or raw credential references enter a public plan, PR or changelog.
7. Preserve needed redacted evidence before retiring only the task's test resources under its cleanup grant. Do not delete shared Gateway helpers, owner OAuth apps or durable sign-in data as routine cleanup. Test issuer rollback is permitted only for isolated test wiring; do not restore it as production identity.

The installed CLI help was read for these command shapes. These are parameterized steps, not invocations to run during this plan task:

```sh
pnpm --filter @agent-collaboration/auth exec wrangler d1 create "$AUTH_TEST_DATABASE" --config "$AUTH_PRIVATE_WRANGLER"
pnpm --filter @agent-collaboration/auth exec wrangler d1 migrations apply DB --remote --config "$AUTH_PRIVATE_WRANGLER"
pnpm --filter @agent-collaboration/auth exec wrangler secret bulk "$AUTH_PRIVATE_SECRETS" --config "$AUTH_PRIVATE_WRANGLER"
pnpm --filter @agent-collaboration/auth exec wrangler deploy --config "$AUTH_PRIVATE_WRANGLER" --outdir "$AUTH_PRIVATE_BUILD"
cf zero-trust access applications create --body "$AUTH_PRIVATE_ACCESS_APPLICATION_BODY"
cf zero-trust access service-tokens create --body "$AUTH_PRIVATE_ACCESS_TOKEN_BODY"
```

Redirect any secret-bearing create response directly into private storage through the deployment wrapper. Construct/validate Access policy payloads with the installed `cf` schema before their separate calls; the commands above alone do not create a policy. Initial OAuth provider login at Google/GitHub may require the owner; no personal credentials are automated into a test fixture.

## Library evidence, risks and remaining unknowns

DeepWiki was queried first for Better Auth OAuth, organization, passkey and D1 pointers; it supplied incomplete D1/passkey detail. No Better Auth checkout was found under `~/Documents/dev/open-source`, so the named files were read from immutable upstream raw source without creating another local artifact. The registry reported `better-auth` **1.7.12**; its tag resolves to `f4260a95cddc0a7640f57c37cf624de019df324f`. The GitHub `v1.7.11...v1.7.12` comparison has no implementation changes in the inspected OAuth provider, passkey, D1 adapter, organization, hooks or dispatch paths; package versions/changelogs changed. Pin Better Auth and its provider/passkey packages exactly to 1.7.12 and retain the resolved transitive lockfile. Requalify changes instead of following a floating range.

| Concern | Checked evidence | Limit / closing observation |
| --- | --- | --- |
| OAuth maturity | [provider docs](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/docs/content/docs/plugins/oauth-provider.mdx), [changelog](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/oauth-provider/CHANGELOG.md): no experimental warning in inspected intro; recent patches cover disabled clients, resource links and scope authority | Released does not establish this composition. S1 must run credential grant, JWKS, metadata claim and final-release checks in workerd. No plugin certification or production maturity claim. |
| Agent shape and claims | [token.ts:1705](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/oauth-provider/src/token.ts#L1705), [client scopes](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/oauth-provider/src/oauthClient/client-credentials.ts#L22), [claims.ts:143](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/oauth-provider/src/claims.ts#L143), [cache/disabled check](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/oauth-provider/src/utils/index.ts#L291) | Resource claims merge last; final equality and no-cache checks are mandatory. Read generated E9 rows and use real JWTs, not hand-signed successes. |
| D1 atomicity | Decision A source and primary batch docs above | The default library flow doesn't supply a batch, so client changes are record-first (Decision A). S1's workerd+D1 fault test proves that contract. Hosted replication timing remains a separate gap. |
| Passkeys on Workers | [routes.ts:653](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/passkey/src/routes.ts#L653) and `:896` use SimpleWebAuthn with expected origin/RP ID; [types.ts](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/passkey/src/types.ts#L40) defaults registration to a session; package depends on server `^13.3.1` | No passkey flow was run. Upstream generic [Cloudflare smoke](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/e2e/smoke/test/cloudflare.spec.ts) is not proof of our OAuth/passkey/D1 path. S2 must perform real ceremonies on the intended HTTPS origin; verify actual locked transitive dependencies. |
| Organization plugin | [types defaults](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/better-auth/src/plugins/organization/types.ts#L18), [roles](https://github.com/better-auth/better-auth/blob/f4260a95cddc0a7640f57c37cf624de019df324f/packages/better-auth/src/plugins/organization/access/statement.ts#L13) | Default user-created orgs/admin powers do not settle our ownership. Do not install it as authority before S7's decisions/review. |
| Workers Free CPU | [limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [pricing](https://developers.cloudflare.com/workers/platform/pricing/): Free 10 ms CPU per request; network waiting is distinct | S5 hosted route-level measurements decide SD6. No cost/CPU fit was measured during planning. |
| Missing surfaces/access | Current host source lacks T4 decide and the production agent-management handler; Verification Design requires OAuth identities/browser capability | Handler is in S1; real decide dependency gates S4. Missing test access or authenticator keeps its hosted row unverified, not passed by a fixture. |

No saved Reader research or unrelated OSS was consulted; no current runtime, hosted account, provider login or UI was observed. Memory was discovery only and was rechecked against the current four documents and commission. No independent plan review was commissioned; the Lead owns this draft's review.

Stop and return to the Lead if the record-first contract can't be met without a new adapter or storage authority, the issuer changes token meaning, a current proof row cannot reach its named target, org/owner identity cannot be supplied without inference, the D1 primary ordering assumption fails, or a fix requires moving controller identities/weakening audit/final checks. Missing external services permit only existing named test stand-ins; they never close real-path obligations.

Decision A is settled and the governing documents are amended. S1 is accepted; S2's UI view and S4's real `decide` target remain preconditions for those slices. Before implementation completion, every required row must have current proof or an explicit unresolved gap; U3 stays required and S7 stays separately gated. This plan task runs no product tests and grants no implementation, commit, deployment or merge authority.
