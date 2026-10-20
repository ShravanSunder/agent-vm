# Verification Design: prove tool access at its real boundaries

[Overview](index.html) · [HTML](verification-design.html) · [Requirements](requirements.md) · [Specification](2026-10-14-portable-tool-portal-hosts.md) · [Program Design](program-design.md)

This is the proof strategy for the proposed design, not a test report. **No target behavior below has been observed by writing this document.** Each requirement has an owner-readable observation and a review row. The current proposal still depends on policy decisions D1–D8 and D10.

The source identities are the three linked documents in this same folder. The authorized need set is U1–U22. References C1–C12, obligations R1–R35 and proof obligations V1–V26 belong to the Specification; observation seams S1–S24 and the neutral dispatch seam belong to Program Design. The target is the delivered revision and explicitly selected deployment configuration, not the current unmodified source.

Three facts shape the new rows:
- Identity, workspace membership and managers come from explicit configuration until the fleet contract (D2) exists (F-53). Journeys run on that configuration adapter, and fleet-verified identity stays unverified.
- A separate console service will most likely own the UI and the request router (F-57, provisional). Tool Portal's control API, its access assessment and the reusable UI package are observed here; the console's own browser session and its model calls are observed when the console is designed.
- The router-model experiment (Jev 4/16, Haiku 14/16 on frozen synthetic cases) is evidence for D8, not proof of any row.

## What the owner will see proven

### U1 — Run the same security on Worker and Node

**Proven by:** submit the same admitted and denied requests to both hosts and see matching catalogs, decisions and normalized outcomes; reject a Node-only binding on a Worker before it serves.

Unverified until performed: deployed Worker behavior, actual import graph and host-specific durable-store semantics. Local emulation is not the hosted result.

### U2 — Use different agent harnesses

**Proven by:** supported real clients connect through MCP and perform the same permitted call while unauthorized calls fail. The client need not know Hermes/controller internals.

Unverified until performed: each named client/version and unattended credential configuration. Unknown client support is not claimed universal.

### U3 — Preserve isolation, revocation and exact approval

**Proven by:** one permitted caller succeeds; another caller, a revoked credential, a stale approval and a spoofed approver all fail before an effect. Race and restart do not add an effect.

Unverified until performed: chosen issuer/ingress, approval authority and exact revocation-age bound. A successful login or a hidden UI button is insufficient.

### U4 — Compose registered services

**Proven by:** calls to independently identifiable services reach the configured destination, while changing target/address arguments, stale bindings and route loss never redirect the action.

Unverified until performed: actual private routes and provider transports. A mock connector does not establish this outcome.

### U5 — Keep provider credentials away from agents

**Proven by:** selected provider/account authorization reaches the real controlled backend while the agent environment, tool results, artifacts, display and diagnostics contain no test credential material.

Unverified until performed: real controlled CLI process isolation and authenticated downstream provider. Test-only grants must be used; no personal grants are required for a proof fixture.

### U6 — Recover work without replay

**Proven by:** interrupt transport and processes at defined admission/arming/receipt boundaries, reconnect, and recover the same operation or its explicit ambiguity with no second effect. This covers calls under the public operation contract, including usable ones. A managed call that needs no approval is `untracked` and is not recoverable; J7 observes that boundary.

Unverified until performed: durable adapters under process/Worker replacement, expiry/retention and multi-handler contention.

### U7 — Match the client's discovery model

**Proven by:** full and compact discovery expose the same permitted capabilities and give equivalent invocation/approval outcomes; client-side code mode uses no extra portal runtime.

Unverified until performed: actual integration with the chosen native-search/code-mode clients; a generic fixture establishes only the MCP presentation contract.

### U8 — Select an execution backend

**Proven by:** the same admitted capability contract reaches a native/controlled CLI backend and the existing managed backend through separate adapters; the portable runtime imports no Gondolin or desktop API, and Tool Portal's dispatch module loads with none of agent-vm's managed types.

Unverified until performed: native permissions and managed VM wiring. A future Codex execution server is only an extension point until implemented and proven.

### U9 — Preserve managed controls

**Proven by:** existing managed calls still work, now through Tool Portal's neutral backend and approval interfaces. Stale epochs, wrong artifacts, forbidden controller administration, public-host escalation and a dispatch the controller did not authorize all fail through the real controller/backend path.

Unverified until performed: live VM/controller proof. Fake VM tests cannot close this requirement.

### U10 — Route cloud calls to configured computer resources

**Proven by:** use two caller profiles across ordinary/sensitive/computer resources, inspect leaf effects, and confirm that unavailable computers remain unavailable rather than changing target.

Unverified until performed: selected ingress and cloud-to-computer route; Fly/Railway redundancy is not established by a local HTTP test.

### U11 — Keep collaboration independent

**Proven by:** reuse the same identity subject with different service audiences/assignments and show that tool-only and collaboration-only credentials cannot cross those boundaries.

Unverified until performed: actual Router/coordination integration. A stand-in can exercise our adapter contract but is not service proof.

### U12 — Consume security without either portal

**Proven by:** a minimal packed consumer imports and evaluates the shared security entrypoints without loading either portal runtime, Node hosting, desktop or controller modules, and competing authority calls cannot create two authoritative records. Every package entrypoint's published files load without host, agent-vm or Gondolin code, and the access assessment runs inside a Worker.

Unverified until performed: packed package import graph and all authority adapters. A type-only import check is insufficient for runtime portability.

### U13 — Give agents and machines real identities

**Proven by:** enroll through a trusted provisioner, rotate and revoke separate credentials, spoof session/machine labels from an untrusted client, and confirm that logical identity and operation history remain correct.

Unverified until D2/D4/D5 are selected and performed: issuer bootstrap, source-machine proof policy and concrete freshness values.

### U14 — Approve through Hermes, Router, IDE or a webhook adapter

**Proven by:** deliver the same redacted challenge through selected surfaces, authenticate the human decision at its owner, duplicate/tamper/delay events, and see at most one permitted leaf effect.

Unverified until performed: each selected real surface and remote decision path. Delivery acknowledgement never counts as approval.

### U15 — Integrate distributed Router without taking it over

**Proven by:** a real current Router adapter correlates its interaction/session with our challenge, preserves authenticated principal and exact decision meaning, and rejects a declared actor or unsupported contract. Contract review identifies the standards actually used, platform-specific deviations and the justified operating costs of the selected integration.

Unverified until performed: external Router identity/approval authority contract, cross-machine continuation and the selected implementation revision. The inspected local broker does not already supply these guarantees. Account entitlement, hosted usage and actual cost remain uninspected; this design does not authorize buying a tier or service.

### U16 — Configure agents and resources per workspace

**Proven by:** with two configured workspaces, a manager's accepted change affects only that manager's workspace. An agent discovers the union of its tools, but each call is admitted only for the workspace it names. A team-account grant works under its admitted authority; another workspace, a personal account or a copied session label cannot widen it. A host with no workspaces configured keeps today's per-agent profiles, and switching workspaces on makes every earlier answer stale.

Unverified until performed: fleet-verified membership and managers (configuration stands in until D2), coding-run versus persistent-bot identity mapping, named-workspace carriage in real clients and authoritative team/personal classification. A fixture screen does not close them.

### U17 — Use a consistent administration interface

**Proven by:** in a real browser, the shared UI package renders the access view, the proposal card, connections and the audit log with the selected design system at wide and phone widths. It shows each state truthfully: field errors, proposal state, conflict, unavailable, applying and unconfirmed. Requests sent straight to the control API, bypassing the UI, still fail the same server checks.

Unverified: the console that will host the UI (F-57) and its own session and CSRF protection, which are observed when the console is designed; visual design itself, which is aligned later (F-56). Mock screenshots do not count.

### U18 — Keep security changes attributable

**Proven by:** after normal operation, restart, audit failure and a lost acknowledgement, every committed change reads back with exactly one audit event naming its actor, scope and before/after meaning. For a chat-proposed change, the event also names who asked and which manager accepted. No grant commits without its event, and no event shows a secret or proof.

Unverified until D6 is selected and performed: audit owner, store, retention and its atomic relationship to policy state. A toast or an append-only fixture file is insufficient.

### U19 — Understand what the app is for and what each agent can use

**Proven by:** for the same agent, tool, workspace and inputs, the access view's answer equals what admission decides when the call is actually made. That includes each "not usable" reason, a paused account policy and per-operation breakdowns such as Gmail read, send and delete. Filters agree; search finds only items in the manager's workspaces; looking changes nothing.

Unverified: inputs from the fleet (configuration now) and providers beyond the controlled test accounts.

### U20 — Change access by asking

**Proven by:** a request produces a question, a proposal or "can't do", never a change. A proposal changes nothing until a manager of that workspace Accepts it. Accept binds the exact items and revisions, applies once even after a lost response, and authorizes no tool action. Every proposed item is listed with its system-computed effect beside the original request, including an item nobody asked for. Tool Portal's view data handed to the router contains no secret, proof or other workspace.

Unverified: the console's router itself, including what it sends the model and how it handles a failed, slow or malformed model (R33), which is observed when the console is designed; the D8 model choice. Model quality is not proven by any of this.

### U21 — See what integrations need and supply it safely

**Proven by:** each integration shows what it needs and whether that need is met. Connecting an account happens on the provider's own screen. Account options change only through an accepted proposal, keeping preview, revision and the paused-until-contained behavior. Once its writer is selected, an entered test secret never reappears in the browser, logs, audit, agent paths or model input.

Unverified: who stores a typed secret (a design gap: the writer is not selected), so the secret-entry part cannot pass until it is chosen; real provider consent screens beyond the controlled test provider.

### U22 — Configure and decide approvals

**Proven by:** changing which operations need approval is a proposal like any other. Where D7 is confirmed, pending approvals show caller, target and exact action, and a decision goes through the authenticated decision path. An approval never accepts a proposal and an Accept never approves an action, tried both ways.

Unverified: D7 (whether pending approvals appear in this UI) and each selected presenter (U14).

## Coverage rows

Journeys J1–J9 and J11–J18 below are **needed**, with lifetime **lasting**, because these public behaviors can regress. J10 is a **needed temporary** cutover rehearsal; permanent version/proof-rejection checks stay in J2/J3. No `verify-tool-access` skill exists under this checkout's `.agents/skills/` (the directory is absent); these are required future observations, not invented existing journeys. Focused pure-rule and package-structure checks are additional evidence and have no journey lifetime. Where a row reuses an existing test, the [reuse section](#existing-evidence-and-honest-reuse) names what it keeps real.

| U / all R obligations | V reference; seams | Observation / target | Passing condition and wrong build |
| --- | --- | --- | --- |
| U1: R1,R5,R10,R13,R15,R18 | V1,V4,V7,V10,V12,V15; S1,S4,S7,S10,S11 | J1,J3,J5,J6; delivered Node 24 macOS/Linux plus deployed Worker | Equal normalized decisions and durable no-replay; a Worker using in-memory consumption or importing stdio fails. |
| U2: R2,R8,R10,R12,R15 | V2,V6,V7,V9,V12; S2,S6,S7,S9,S11 | J1,J2,J5,J6; supported pinned harness/SDK clients | Correct catalog/call/result and denied negative actors; branding-based profile or unsupported-version acceptance fails. |
| U3: R1,R2,R3,R5,R6,R7,R11,R13,R14,R16,R17,R19,R20,R21,R23,R24,R26,R28,R31,R33,R35 | V1,V2,V4,V5,V8,V11,V13,V14,V16,V17,V19,V21–V24,V26; S1,S2,S4,S5,S8,S10–S17,S19–S22,S24 | J11–J15,J17; J1,J3–J10; selected actual authority/issuer/backend and bounded cutover | Zero unauthorized effects; exact one accepted effect; same key across rotation/restart. Hidden-only UI, stale-token acceptance, duplicate consumption, legacy retry conversion, a shown state admission contradicts, an Accept used as a tool approval or a model-chosen change applied without Accept fails. R33's model-payload part is unverified until the console exists. |
| U4: R4,R10,R13,R15,R16 | V3,V7,V10,V12,V13; S3,S7,S10,S11 | J4,J5,J6; distinct real HTTP services and computer | Effect at configured resource only; accepting caller address or silently choosing another Mac fails. |
| U5: R4,R11,R13,R14,R16,R24,R33,R34 | V3,V8,V10,V11,V13,V19,V21,V24,V25; S3,S8,S10,S11,S17,S22,S23 | J11,J12,J15,J16; J4,J6,J7; controlled provider/CLI and managed backend | Correct test account receives work; no secret reaches agent-facing paths, the router's view data or the UI. Echoing env, choosing an alternate account or returning an entered secret fails. The secret-entry part waits on the writer gap. |
| U6: R5,R7,R9,R12,R14,R16,R23,R32 | V4,V5,V9,V11,V13,V19,V21,V23; S4,S5,S9–S11,S15,S16,S21 | J11,J14; J2,J3,J6,J10; real durable stores and bounded legacy cutover | Same operation and no second effect after ambiguity/result expiry; an accepted proposal recovers its one application after a lost response. Memory-only lookup, replay after profile rotation, automatic legacy-to-new redispatch or a second application on retry fails. |
| U7: R3,R8 | V2,V6; S2,S6 | J1; full/compact real MCP clients | Equivalent allowed set; guessed hidden tool denied; compact dispatcher bypass fails. |
| U8: R4,R11,R15,R18 | V3,V8,V12,V15; S1,S3,S8,S11 | J4,J6,J7 plus the packed import-closure check of every entrypoint, including `tool-engine/dispatch` | Correct adapter and managed fences. Unconditional Gondolin import, general-shell exposure, or a dispatch module that still imports `GatewayRuntime…` dispatch-authority types fails. |
| U9: R1,R6,R11,R12,R14,R17 | V1,V4,V8,V9,V11,V14; S1,S4,S8–S10,S13,S15 | J2,J3,J7,J9,J10; real managed and public hosts. Reuses the managed approval integration test, run through the neutral backend and approval interfaces | Existing protections remain effective. Extracting shared code to skip epoch/admin checks, losing managed history, accepting a retired proof, dropping the per-surface eligibility gate, or an adapter that trusts Tool Portal's reference instead of rebuilding its own dispatch authority fails. |
| U10: R3,R10,R15,R16,R23 | V2,V7,V12,V13,V19; S2,S7,S11,S16 | J11; J5,J6; selected actual ingress and two service levels| Preserved subject/leaf state; shared admin credential treated as original agent or wrapper 200 counted as completion fails. |
| U11: R17,R22 | V14,V18; S2,S13,S14 | J9; real tool and Router/collaboration service | Distinct assignments enforced; tool access from session/board role fails. |
| U12: R1,R18,R22,R27 | V1,V15,V18,V16,V19; S1,S4,S13–S16,S20 | J8,J11; structural/contract check plus J3,J9,J10; packed portable consumers, language-neutral artifact, a Worker probe that evaluates the access assessment, and selected authorities | Independent imports and singular writes. Re-exported host effects, separately maintained incompatible wire shapes, legacy permission aliases, a shadow approval ledger, an access assessment that cannot load in a Worker, or a `tool-access` closure that includes execution targets, images or executors fails. |
| U13: R2,R9,R13,R19,R20,R22,R27 | V2,V5,V10,V16,V18,V19; S2,S5,S10,S13,S14,S16 | J11; J2,J8,J9; selected issuer, explicit machine policy| Enrollment/credential separation and preserved operation identity; session spoof, silent consent widening through template enrollment, or revoked issuance accepted after bound fails. |
| U14: R5,R6,R18,R21,R22,R35 | V4,V15,V17,V18,V26; S4,S12–S14,S24 | J3,J9,J17; real authority and selected surfaces | Authenticated exact once-only decision. A duplicate webhook creating approval, widening to persistent permission, or an approval decision accepted as a proposal Accept fails. |
| U15: R17,R19,R21,R22,R27 | V14,V16,V17,V18,V19; S12–S14,S16 | J11; J8,J9 plus standards/cost review; selected distributed Router integration| Genuine subject/decision adapter; declared `actor` accepted as authentication, unimplemented central contract presumed live, undocumented protocol divergence or an unexplained paid dependency fails. |
| U16: R23,R24,R25,R26,R27,R28,R30,R31,R32,R34 | V16,V19–V23,V25; S16–S21,S23 | J11–J14,J16,J18; Tool Portal on Node and a deployed Worker with the configuration adapter (two configured workspaces, two managers, separately configured agents), the real account authority, and the selected D6 audit adapter | Union catalog but named-workspace call limits; workspace-local management through accepted proposals; exact audited grant. A copied selector or session label, another membership's allowance, a manager self-classifying a personal account, a stale no-workspace answer used after workspaces are configured, or a configuration change made through a proposal fails. |
| U17: R25,R29 | V20,V22; S18,S20 | J18; the UI package in a real browser at 1440 px and 430 px, against the real control API on Node | Truthful states from real API responses, keyboard and error focus, only R29's places. Hidden buttons as the only enforcement, optimistic "applied" before read-back, an extra place, or a direct API request the server accepts though the UI would block it fails. The console's own session/CSRF part is unverified until the console exists (F-57). |
| U18: R24,R26,R31,R32 | V19,V21,V23; S17,S19,S21 | J12,J14; selected D6 audit and policy/account authorities | Every committed security change has its occurrence after failure/restart, naming requester and acceptor when it came from a proposal; no unaudited grant or duplicate event on retry. A toast, log-line count, webhook acknowledgement or fixture journal alone fails. |
| U19: R25,R28,R29,R30 | V20,V22,V23; S18,S20,S21 | J13,J18; the control API's `explain` and the real admission entry on Node and Worker, same inputs and surface; reuses the Google evaluator focused tests for the evaluator's own order | Every shown state and breakdown entry equals admission's decision for the same inputs and surface, including J13's negative and paired-surface cases. A separate evaluator, a flattened Gmail state, paused shown as missing consent or unavailable, a command deny shown as paused, or an answer that hides which surface it describes fails. |
| U20: R24,R25,R26,R27,R30,R31,R32,R33 | V19–V21,V23,V24; S17–S22 | J14,J15,J12,J18; the real proposal/decision path and authoritative policy, grant and audit state; R33's model side waits for the console | A request never changes state; only a verified manager's Accept applies, once. A member's Accept, a console-asserted manager, an apply after a concurrent change, a second application on retry, or impact text taken from the model fails. |
| U21: R28,R34 | V22,V25; S20,S23 | J16,J13; the real account authority with the controlled test provider; reuses the account-policy editor integration test for editor fencing | Needs shown truthfully; sign-in on the provider's origin; options changed only through an accepted proposal with paused-until-contained preserved. An in-app imitation of consent, an option change outside a proposal, or a returned secret fails. Secret entry waits on the writer gap. |
| U22: R29,R35 | V20,V26; S18,S24 | J17,J18; the real approval authority and proposal path | Approval-mode change only through a proposal; with D7, pending approvals listed and decided through the authenticated path. An approval decision sent to `decide`, or an Accept sent to the approval decision entry, is rejected in both directions. |
Every row uses the Specification's worked examples C1–C11 as its behavioral reference. Different permitted host storage implementations may pass; no row requires a particular physical database merely because a diagram names one. Thresholds and supported runtime/client versions must be fixed before observations, not copied from observed behavior after a run.

## Shared observations to build

### J1 — Discovery, policy and host parity

Needed lasting journey through real public MCP on Node and deployed Worker. It drives initialize/list/search/describe/direct and compact invocation as two independently credentialed callers; reads normalized catalog, operation result and selected leaf outcome. Negative controls include guessed names, invalid audience, profile input, spoofed client brand and unsupported host bindings. Pure policy fixtures additionally decide deterministic rule logic without launching a service.

Closes V1,V2,V6,V10 and the relevant R1–R3,R8,R13 portions. Other V10 bounds use J3. It leaves hosted identity-chain semantics to J5/J8.

### J2 — SDK contract, recovery and artifacts

Needed lasting journey with actual delivered TypeScript and Python SDKs through public hosts. It compares validation/result variants and artifact reads, rejects version skew, replaces the transport and fetches an existing operation under correct and incorrect caller identity. It reads persisted result/artifact authorization, not only client acknowledgements. Closes V9 plus R9's client-facing observation; J3 establishes effect safety.

### J3 — Approval, durability and capacity

Needed lasting journey through a real approval/operation authority and effect backend with an independent durable effect log. It races identical requests, changes exact intent, denies as unauthorized actor, kills the owner before/after arm and before receipt, reconnects, expires result bytes, rotates credentials, attempts first dispatch of A1-approved work using another valid issuance A2, and fills safe capacity. A2 may only read history that its current caller-scoped lookup permissions admit; it cannot consume A1’s approval. Read back both durable authority state and backend effect log. At most one permitted effect; no forbidden effect. Missing receipt after arm is ambiguity, not proof of non-execution.

Include two independent operations with identical caller, tool and arguments but distinct operation items. A retry of the first item must reuse its record; neither its approval nor its cached result may be applied to the second item. This catches an implementation that uses argument hashes and a time window as operation identity. If direct-to-resource approval delivery is selected, lose and duplicate its messages as well; delivery alone cannot arm either operation.

For D3's selected external-authority protocol, separately inspect the authority's decision/reservation record and the resource's consumption/arm record. Lose the response between those owners, repeat delivery and restart each owner. The same recorded decision may be recovered, but a missing acknowledgement must never create another resource operation or imply local consumption. A legacy standalone HMAC token must not pass as a new public decision receipt. This is conditional protocol proof, not a requirement to implement both candidates.

Closes V4,V5,V11 and the singular-writer part of V15. Local file-store and DO tests must be separate real adapter cases. New effects must fail under store failure; a no-op backend or empty event log cannot establish liveness, so an allowed control must demonstrably create one effect.

### J4 — Credentials and execution selection

Needed lasting journey through a controlled authenticated MCP provider and controlled CLI process under the real credential-use adapter. Inspect selected account/action plus agent-visible output, diagnostics and filesystem/environment exposure at the actual process boundary. Where an account selector is explicitly configured, an authorized registered selection must work; another caller's or unregistered account ID, provider-address override and unsupported command must fail. Change the selected account after an exact approval and require rejection of that stale decision. Closes V3 and execution-selection parts of V12. Test values are unique, nonproduction canaries; passing output must show an allowed effect as well as absence of leaks.

### J5 — Actual ingress and network failure

Needed lasting journey on the selected deployed Cloudflare entry and authenticated resource route. Send allowed/disallowed Host/Origin, expired/wrong-audience proof, forged forwarding header and client brand. Exercise service loss and connector replacement; inspect resource service identity and leaf operation. For managed MCP Portal, hold upstream admin credentials constant while comparing two independently authorized agent tokens: if no verified distinct caller survives, that entry fails caller-isolation admission rather than passing as one shared agent. Closes V7; source documentation alone does not close the chain.

### J6 — Cloud/computer composition

Needed lasting journey with real cloud gateway and two independently named computer/resource services. Read outer/inner records and independent effects under pending approval, denied, succeeded, ambiguous, stale binding and lost response. Repeat over a new connection using the same item; no new inner identity. Closes V12,V13. It must keep both network hops and target verification real; replacing the computer with a mocked success function misses the obligation.

Hold the computer's response after it has durably created the inner operation, and again after its independently logged effect, but before the gateway has persisted the inner reference. Replace the gateway handler/connection and overlap recovery with the delayed original. Read back the outer target/key recorded before forwarding and the computer's operation key: its caller must be the represented agent and its item the original caller item, never the gateway or a newly generated item. Recovery must adopt the same inner record/reference and preserve its actual state; reference lookup/create-or-read produces no executor call. Release the delayed reply and ensure it cannot regress a terminal receipt to pending. A control continuation separately admitted by the selected D3 contract must establish one permitted effect; all replay attempts leave that count at one. A build that allocates its inner item only at send time fails this case even if its later reconnect tests pass.

Attempt recovery with a gateway service credential lacking delegation, an otherwise valid delegate outside the operation/lookup scope, and a conflicting registered target revision. They must not disclose or dispatch the inner operation or select another computer. If D1 selects a direct admitted path, compare direct and routed access by the same caller/item and require the same inner identity; do not create a direct path just for this proof. D3 must also supply the reference for composing cloud/resource approval gates before J6/J9 can judge challenge count and eligible approvers. An unresolved composition must fail configuration, rather than being counted as a successful one- or two-prompt implementation.

### J7 — Managed boundary preservation

Needed lasting journey through the real controller, managed gateway and relevant Tool VM/credentialed backend when the adopted change touches them. Observe allowed control and forbidden admin/epoch/principal/artifact cases. Also observe the managed `untracked` boundary: a managed usable call invokes once with no operation record, and a call that needs approval but gets an `untracked` answer is refused with zero backend invocations. Closes V8. Unit/integration suites are supporting checks; VM inventory with skips is not evidence of a managed effect. Existing repository live proof lanes must remain required by the delivery plan.

### J8 — Enrollment and revocation

Needed lasting journey against the selected issuer/registration authority, gateway and target. Trusted provisioner enrolls agent A and machine/service relationship, issues A1/A2, rotates/revokes A1, changes profile, suspends agent/machine/service and retries an old operation. Untrusted client copies all display/session labels. Read credential/assignment versions and admission/dispatch decisions within the selected freshness bound. A2 remains independently governed. Closes V16. D2/D4/D5 must settle reference limits before the journey can establish a passing result.

Start with an account grant only to A, then validly enroll B under the same profile or future template. B's identity may be valid while its account use and lookup of A's operations remain denied. Changing the template must not broaden the old grant. A separate explicitly authorized grant can admit B as the positive control. The needed future template/instance contract is supplied by D2; this observation does not invent that contract or assume current `allowedAgentIds` already grants to personas.

### J9 — Approval surfaces and Router isolation

Needed lasting journey through the actual selected Router/IDE/Hermes/event receiver. Preserve interaction-to-approval mapping; inspect human-authenticated decision at the tool authority and independent effect. Exercise the selected protected control-session or enrolled approver-client proof, including the resource-local Mac path when selected; a presenter service claiming an owner name must fail. Deliver duplicate/expired/tampered events and attempt tool access using only a Router session/declared board actor. Closes V14,V17,V18. A stand-in proves our adapter contract only; it leaves actual Router integration unverified. If Router is selected as authority rather than presenter, this journey must also exercise its durable continuation and consumption contract; current local broker restart cancellation is not waived.

For each selected Rust/Swift integration, validate the real producer's serialized public message at the real consumer using the one released language-neutral artifact. Compare accepted and rejected fixtures, normalization, canonical bytes, named refinements and version rejection. With independently valid caller proof, send a managed-family decision to the public decision boundary and require rejection before decision/effect; the expected family must come from that boundary, not a payload selector. Also keep a valid managed control through its real boundary. This representation check does not require a network hop when no delivery property is claimed; J9's remote decision and J3's consumption checks still require their real paths. The current managed approval schemas are a reuse pattern, not fixtures that can establish the new public protocol before it is defined.

### J10 — Legacy standalone retirement

Needed **temporary** journey through the actual cutover procedure with pinned old/new package artifacts, independently valid new caller identity, selected real approval authority and an independently logged controlled backend. The operator's inventory names all affected listeners, local paths, importers and minting integrations. Inspect packed exports and run the actual replacement host: retired approval entrypoints have no alias, old proof formats cannot admit a protected call, and an allowed control using the new authority demonstrably creates one effect. An unauthenticated test that always fails does not establish proof rejection.

Start old standalone work, retain per-item responses, and lose a response after the backend records its effect. Invoke real listener retirement with the request still outstanding. A successful close/drain result must not be reported as proven non-execution. Follow the cutover procedure: preserve existing managed history under its owner, report missing standalone history honestly, keep the affected capability unadmitted while the outcome is unknown, and reconcile against the backend before allowing genuinely new work. Old-reference lookup must create zero effects; no client adapter may convert the old uncertain call or partial batch into fresh public operation items. Inspect outcomes and effect counts, not only command exits.

This rehearses C4/C5 and the R11/R12 transition. It does not build a legacy compatibility service, invent a durable old ledger or require both D3 candidates. The actual procedure/consumer inventory and old/new revisions are delivery inputs still to supply. J2/J3 retain lasting version/legacy-proof rejection cases after the temporary cutover journey is retired. Managed runtime preservation still needs J7's real path.

### J11 — Workspace scope and named calls

Needed lasting journey on Tool Portal (Node and deployed Worker) and the gateway/resource path, with the configuration adapter supplying two workspaces, two managers keyed by issuer and subject, and separately configured agent registrations. The deciding reference is C10. Union discovery shows the agent's admitted tools, while a Studio call cannot borrow Home's tool allowance. A revoked registration or a spoofed workspace fails despite a stale catalog. Reusing the same operation item with another workspace produces no additional leaf effect, observed independently, and the recorded workspace still governs result access.

Also exercise the configuration stand-in's guards:
- A service token, machine identity or session label configured or presented as a manager is never a manager.
- A manager matching subject but not issuer is refused.
- Changing membership or managers is an operator configuration change with its own revision; no proposal can do it.
- Switching a host from `not-configured` to configured workspaces makes an earlier no-workspace assessment stale: admission and proposal apply refuse it rather than reuse it.

Wrong builds that fail: tool access taken from a session or harness label; a `not-configured` host treated as allowing everything; a fabricated `active` registration. This closes V19 through S16/S17 and R23, R24 and R27. Fleet-verified membership stays unverified while configuration stands in (F-53).

### J12 — Audited policy and account changes

Needed lasting journey through the selected D6 audited-commit implementation, with independent reads of authoritative permission/account state and its audit occurrence. The references are C11, C12 and R26. Exercise workspace allowance, agent assignment, team-account grant and revocation, each applied from an accepted proposal. Distinct denied/malformed requests need no invented mutation event. Every committed security change must have the selected authoritative occurrence, with attributable actor, scope and delta and, for a proposal, the requester, the accepting manager and the proposal and decision references. Projection/delivery duplicates must not create another grant or event.

Stop audit persistence before a change is admitted, lose the acknowledgement after an accepted change, retry the same command and replace the owner process. Verify that no grant commits without its audit record, the same command recovers the same result and event, and a different command cannot silently reuse it. Demonstrate an allowed committed control to catch an inert audit/write path. Inspect redacted event payloads and actual UI deltas against unique nonproduction secret/proof canaries. If audit and policy authorities are remote, keep their real selected settlement/recovery protocol in this journey; a fake callback cannot prove atomic admission. This closes V21 through S19. The D6 ownership/protocol/retention gap must be resolved before a passing result can be judged.

### J13 — The access view equals admission

Needed lasting journey through the control API's `explain` and, independently, the real admission entry, on Node and a deployed Worker, for the same agent, capability, workspace and input revisions. The reference is C11's table and the evaluation order in Program Design §1. For every capability in the fixture, compare each shown state, each breakdown entry and its `perCallRule` against admission decisions for calls that exercise them, across fixed and call-dependent capabilities.

Include these cases, each with its expected shown state:

| Case | Expected |
| --- | --- |
| Gmail with read allowed, send ask, delete deny | three entries: usable, approval each call, blocked by policy |
| two CLI calls with the same command path, one carrying a denied flag, pattern or stdin | `explain` shows the per-call rule; admission allows one and blocks the other |
| an account decision bound to a different call digest | admission refuses; the decision is not reused |
| a Google `command` deny on an account whose policy is `applying` | blocked by policy (step 4), not paused |
| an account policy `applying` with an allowed command | not usable: account policy paused, never "consent missing" or "service unavailable" |
| expired consent | not usable: consent missing or expired |
| registration revoked while an allowance still exists | not usable: registration revoked |
| host switched from `not-configured` to configured | earlier assessments stale; new ones use the workspace steps |
| a `not-configured` workspace fact reaching a host configured with workspaces | admission refuses; `explain` returns an error, not an answer |
| the same agent, capability and arguments over `mcp` and over `protected_uds`, eligible on one only | each answer names its surface: usable on the eligible one, not given to the agent on the other; admission agrees per surface, and the managed final fence still refuses the ineligible one |

Check the access projection against today's code: for the same calls, `assessAccess` over the projection the managed adapter produces must give the same decisions as today's `callPolicyDecision` over the original managed configuration. A projection that drops a field a decision reads, or copies an execution target into `tool-access`, fails here or in U12's packed check.

Then filter the same paths by agent, by tool, by account and by workspace and require identical states; search "calendar" and require only in-scope items. Read policy state before and after viewing to show nothing changed. A view computed by a second evaluator, a flattened state, or a reason that differs from admission's fails. This closes V22 through S20. The Worker probe for U12 runs the same function.

### J14 — Proposal, decision and application

Needed lasting journey through the control API's `propose`, `decide` and `read` on Node and a deployed Worker, with authoritative policy, grant and audit state read independently. The reference is C12's main path (P-17) and every row of its outcome table. Drive proposals directly through `propose`, as the console or any client would; the router is not needed for these cases.

Observe that:
- creating a proposal changes nothing;
- Deny closes it with no change;
- a concurrent change by another manager makes Accept return superseded with nothing applied;
- an invalid item (a personal account) is marked and the valid rest can be accepted;
- an unmet prerequisite (expired consent) is listed and the path stays not usable after Accept;
- an account-option item enters applying and the path stays paused until activation;
- an unavailable policy or audit store yields unavailable with no change;
- a partial application names exactly the committed items.

Lose the response after Accept and recover the same application through `read`; retrying never applies twice, observed as one grant and one audit event.

Check the contract with a client written only from the published `tool-access/contracts` schema, as the console would be. Its `ProposedChange[]` for every variant serializes and is accepted. Malformed variants, a `register-agent` naming an agent that is not a listed member, an agent named by display name instead of id, and an Accept whose content digest differs from the stored proposal are all refused by the same server schema. A `set-account-options` item's Accept confirms exactly the account editor's preview context it opened.

The effect must keep conditional paths distinguishable. Propose removing C11's mixed-mode Gmail (read usable, send approval each call, delete blocked) from the workspace, and separately revoke an account that only some entries depend on. The proposal's effect must show each affected entry by its operation class or account, with its own before state and its after state, and leave unaffected entries distinguishable. A flattened delta, swapped or unkeyed entries, or an effect the client must recompute fails; a different ordering or layout of the same entries passes. C12's three-item proposal must show Read team calendar becoming usable only as the combined effect of its valid items.

Deciders: a member, a manager of another workspace, a subject asserted by the console without a valid identity proof for Tool Portal's audience, and the console's own service credential are all refused; only a configured manager whose issuer and subject verify can Accept. A console relaying a manager's still-valid proof for a decision the manager did not make is not refused by Tool Portal's identity check alone. That case belongs to the console contract under F-57 and stays unverified here. After Accept, a tool whose mode needs approval still needs one per call: an Accept never dispatches it. Wrong builds that fail: optimistic apply on `propose`, Accept without digest and base-revision binding, a second application after a lost response, or trusting the console's word for who decided. This closes V23 through S21 and S24's proposal side.

### J15 — The router boundary on Tool Portal's side

Needed lasting journey on Tool Portal's control API, with a scripted router client standing in for the console's router. The reference is C12 and R30. Plant unique nonproduction secret, proof and other-workspace canaries in configuration and account state. Call `explain` as the router would and require that its projection contains none of them and only the requesting operator's workspaces.

Then send routed changes that a model could produce: ids outside the operator's `explain` result, a combination invalid at the current revisions, a hostile tool description or agent name containing instructions, and an extra item nobody asked for. Require that `propose` rejects the first two with reasons; that names and descriptions stay data and never change the function set; and that the extra item appears as its own item with its system-computed effect beside the original request text. Wrong builds that fail: impact text copied from router input, a proposal created from an unvalidated id, or an extra item merged silently into another.

The router itself, including its outbound model payload, timeouts and malformed output (R33, V24), runs in the console (F-57). Its journey is needed when the console is designed: capture the actual outbound payload under canaries and induce unavailable, slow and malformed model results, requiring no proposal. Until then R33 is unverified. The F-45 experiment is not this proof.

### J16 — Connections and credentials

Needed lasting journey through the control API, the real account authority (the controller's Google permission policy service and broker) and the controlled test provider. The reference is C11's connections paragraph and R34.

Observe that:
- each integration shows nothing, a secret or a provider sign-in, and whether it is met, matching the backend registration;
- connecting an account redirects the browser to the provider's own origin, with no in-app credential form;
- confirmation cancel works with an empty account name;
- an account-option change goes only through `propose` and `decide`, keeping preview, revision and applying/containment, and the path stays paused until activation;
- the old direct editor route no longer accepts a change after the hard cutover.

When the secret writer is selected (today a gap), enter a unique canary secret and require that it never appears in any browser response, log, audit event, agent path or router projection, and that the integration then shows "set". Wrong builds that fail: imitated consent, an option change outside a proposal, or a secret echoed anywhere. This closes V25 through S23, except the secret-entry part while the writer gap stands.

### J17 — Approval modes and the approvals place

Needed lasting journey through the control API, the real approval authority and an independently logged effect backend. The reference is C2, C11's approvals paragraph and R35. Changing which operations need approval goes only through a proposal and Accept, and admission then follows the new mode.

Where D7 is confirmed, a pending approval appears with caller, target and exact action, and deciding it through the authenticated decision path (R6) produces exactly one effect. Cross-use both ways: an approval decision sent to `decide` is rejected, and a proposal Accept sent to the approval decision entry is rejected. Neither changes state or causes an effect. Wrong builds that fail: an approval-mode switch outside proposals, or one shared decision schema accepted by both entries. This closes V26 through S24. The approvals-place part waits on D7.

### J18 — The control surface in a real browser

Needed lasting journey rendering `tool-access-ui` in a real browser at 1440 px and 430 px, against the real control API on Node, using the J13–J17 fixtures. The console will be its production host (F-57). Until it exists, a minimal host page composing the same package stands in for it. That stand-in decides rendering and state display only. The reference is C11, C12 and R25/R29.

Observe:
- only R29's places, each with its one-line purpose;
- the request bar at the top (F-55);
- the access view's states and breakdowns as J13 reads them from the API;
- the proposal card with the original request, exact items, invalid items, and an effect that shows each conditional entry by operation class or account, as J14 reads it from the API;
- every result state forced through the real API: superseded, unavailable, applying, partial, unconfirmed until read back;
- keyboard completion and field-error focus.

Then send the same requests directly to the control API and require the server to refuse what the UI prevents. Wrong builds that fail: "applied" shown before read-back, a hidden button as the only enforcement, an extra place, or a design-system check that passes while a state is missing. Theme, registry and lint checks support visual consistency; screenshots of the actual build decide layout. This closes V20 through S18, except the console's own session and CSRF protection.

## Existing evidence and honest reuse

Current source provides useful baseline tests: [Node MCP listener integration](../../../packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-http-server.integration.test.ts), [MCP proxy integration](../../../packages/mcp-portal/src/mcp-proxy/portal-http-server.integration.test.ts), and [approval orchestration unit tests](../../../packages/tool-portal/src/tool-portal-service-approval-dispatch.unit.test.ts). The inspected fixtures use projection/backend or approval stand-ins. They can support local contracts but cannot be counted as proof of hosted identity, cross-machine delegation, durable consumption or managed VM execution.

Three existing tests are planned as deciding evidence for part of a row, each limited to what it keeps real:

| Test | Keeps real | Replaces | Decides | Leaves unverified |
| --- | --- | --- | --- | --- |
| [Managed approval integration](../../../packages/agent-vm/src/controller/control-session/tool-portal-mcp-approval.integration.test.ts) | the controller approval ledger on disk, private sockets, concurrent identical successors | the MCP provider, with a recording backend that counts invocations | U9/R5: one approved managed dispatch and refused replay, once rewired through the neutral backend and approval interfaces | the provider effect; the rewiring itself until it lands |
| [Account-policy editor integration](../../../packages/agent-vm/src/controller/oauth/google-account-policy-editor.integration.test.ts) | the broker catalog, policy editor and permission service | containment, with a stub returning contained, pending or failed | U21/R34's editor part: preview without mutation, one commit under concurrency, forged origin/session/CSRF refused, never active while containment is pending | runtime containment; the proposal path that will drive the editor |
| [Google evaluator focused tests](../../../packages/tool-portal/src/google-account-policy.unit.test.ts) | the pure evaluator | nothing (pure rule) | the evaluator's own order: an `applying` revision fences, denial before consent, independent read/write gates | `assessAccess`'s projection of that result, which J13 decides |

Each applies only while its source and target stay as inspected at baseline `8535fdd4`; the Verifier re-checks that at delivery. **No reused test decides the new access, proposal or router rows on its own.** No test has been run as part of this design document.

## Decisions and access needed for proof

- D2/D4/D5 supply identity, machine policy and numerical reference bounds. Without them J8 and parts of J1/J5 cannot be judged. Until D2, J11, J13 and J14 run on the configuration adapter (F-53); fleet-verified identity stays unverified.
- D3 supplies authority placement and continuation semantics for J3/J9; a remote store acknowledgement is insufficient.
- D6 supplies audit persistence/retention and trusted account classification before J12 can judge any commit, and so before J14 can pass its apply cases. No prototype store or UI label is accepted as that authority.
- D7 decides whether J17's approvals place exists; approval-mode changes are observed either way.
- D8 selects the router model. It does not change any Tool Portal row, because no row trusts the model.
- **F-57 moves part of the required proof to the console, for the owner to confirm.** If the console owns the UI and the router, then three things are proven in the console's design, not here: R33 (what the model sees and how failure behaves), the console's own session and CSRF protection, and that each Accept relayed through the console is the manager's own action. This follows from F-57 and leaves those observations undone in this design. J15 and J18 name the stand-ins they use meanwhile.
- The secret writer gap blocks J16's secret-entry case.
- A selected Cloudflare test deployment and controlled machines/providers are needed for J4–J8 and J11–J17. No production credentials or new paid product are assumed.
- The Router integration must name an implementation revision and external contract. Current source evidence supports an adapter seam but not a completed remote authority.

These are proof gaps and design decisions, not waived requirements. HTML/document verification is a separate artifact-quality check and does not count as any journey above.
