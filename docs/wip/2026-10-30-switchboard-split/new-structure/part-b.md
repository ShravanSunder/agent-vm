# Part B — factual check and second view of the new HTML

Target is **new-structure.html**, replacing the retired switchboard-split.html per Lead push `01a18df4-a0ef-7bc3-a927-3b5b004c251d`. Read complete snapshot `lead-new-structure-snapshot.html`, SHA256 `269e209a0421bab76f1187fbc0512de62b75e6b3ead12ed41a99e986b8725e0f`, captured 2026-10-30T17:56:49Z. Independent Part A was saved before either page was opened, SHA256 `6e23eacbb810f392645f61c2e63a2e0c5d2580ebca495954ba4f93bf3b8268b9` (see `part-a-freeze.json`). No HTML edit or visual/runtime verification performed; this is advisory source checking, not the independent Reviewer's verdict.

## What holds

- The controller's three jobs are a useful **proposed responsibility map**: local front door, Switchboard link, VM service. The separation must remain visible in code and authority; it need not imply three processes.
- H's managed runtime no longer imports old Tool Portal/MCP Portal implementations. It uses the local managed facade/adapter plus new engine/Node libraries; old packages retain public implementations and MCP image distribution. Parent production-import search over the six VM source roots found zero old-Portal module imports, separately from remaining manifest declarations.
- The 23→6+17 manifest cut has no back-edge from the 17 to the six in dependencies, optional/peer or dev dependencies. Eleven of the copied packages also exist on master. These are graph/source facts, not a statement that copied code is ready or every package can safely be deleted.
- H's auth is already workspace-aware; the old A/H comparison is not an integration-defect finding. Parent opened H issuer (`H:packages/auth/src/better-auth-provider/provider-configuration.ts:220-261`) and H relying-service checks (`H:packages/tool-host-core/src/caller-admission/caller-check.ts:19-40`). Matching source checks are present; runtime integration still was not run here.
- The cloud limitation is correctly called out. Current provider/controller code requires local process/filesystem/mediation assumptions, not just an interchangeable remote VM factory.

## Corrections and omissions that change the picture

### B1. The OAuth catalog already uses Drizzle

Page package row at snapshot line 207 says “The catalog moves to Drizzle.” At H it already imports `drizzle-orm/better-sqlite3`, constructs a typed database and runs Drizzle migrations. The work is separating portable account-domain decisions from concrete Node persistence/provider/crypto adapters, plus choosing the new host store, not introducing Drizzle to this catalog.

Checked: `H:packages/oauth-broker/src/oauth-credential-catalog.ts:1-15,38-64`. Recommendation: correct the factual label and keep the platform/store ownership decision explicit. No ORM/storage edit is made or proposed as an automatic migration.

### B2. “codex-router is Rust, so only runtime edges” is not a valid code boundary

Snapshot line 173 and import diagram omit the proposed Fleet-owned identity contract imports. Language does not prevent publishing language-neutral schemas or generated/checked TypeScript contracts. The existing Router source exports a shared DTO schema catalog (`R:crates/collaboration-protocol/examples/export_protocol_types.rs:1-6`). H currently puts person/agent proof and verifier exports in `tool-access/contracts` (`H:packages/tool-access/src/contracts/index.ts:10-20`). Moving the generic identity contract authority to Fleet requires a **library edge** from Switchboard/Sign-in to the contract artifact, separate from calls to Fleet central.

Recommendation: draw the identity-contract library explicitly; Router runtime need not be imported or started by consumers. Keep Switchboard-specific resource URL rules separate (`H:packages/tool-access/src/contracts/workspace-resource.ts:3-29`). If Router code later imports Switchboard SDK while Switchboard imports identity from that same Router repo, the strict repository DAG would cycle; flag that rather than dismissing it on language grounds.

### B3. The old private socket is broader than “only exposes tools”

The front-door card at snapshot lines 81-91 describes the whole gateway socket as a tool exposure surface. It serves `portal.*`, approval and artifact operations **and separate raw** environment/exec/files/process/stream/terminal methods. Those raw methods go to sandbox dispatch, not through `portal.call` assessment for each operation. `SandboxExecStartRequest` extends direct shell request. This is not a source vulnerability claim: today's trusted Hermes attachment/lease admission is the existing authority. Exposing it to arbitrary registered agents changes that boundary.

Checked: `H:packages/gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.ts:210-242`; `H:packages/agent-portal-sdk/src/contracts/sandbox-execution-contracts.ts:17-31`; `H:packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.ts:479-529`.

Recommendation: distinguish agent tool proxy and registered VM-service API, even when they share one controller. Explicitly decide whether agent-facing raw sandbox operations are Switchboard-mediated tools or an independently granted local sandbox capability. Do not present a copied server handshake as that decision. Part A favors Switchboard policy for agent tool effects and a separate explicit registration for trusted harness lifecycle/control.

### B4. Split SDK/relay by job, not by which machine it connects to

Snapshot lines 201 and 226 place the socket client/local exec/relay wholesale in Agent VM. I agree the **executor**, SSH/lease use, process/file/artifact state belong to the controller. I differ on the public client: code that reaches a controller is still client/transport/protocol code. The owner asked for a Switchboard SDK any agent can use, including agent-vm's own harness connection. Keep one public protocol/client family in Switchboard, with Node/Python transport entrypoints; the controller implements it. Delete/replace obsolete Hermes Gateway attachment, rather than moving its trust model unchanged.

The SDK already contains actual MCP methods (`H:packages/agent-portal-sdk/src/tool-portal-mcp-client/index.ts:135-210`) and raw sandbox schemas. Python is not only a Gateway resident: its public `connect_tool_portal()` explicitly creates a Tool VM client from invocation environment (`H:python/agent-vm-agent-portal-sdk/src/agent_vm_agent_portal_sdk/__init__.py:16-21`). Relay protocol/client, trusted harness bridge, and guest helper process can be placed separately. The physical guest-helper image installation may remain Agent VM; that does not require duplicating the public SDK there.

This is a design alternative, not a factual error about what the existing client does. Gain: a single public contract/client owner; cost: cross-repo SDK publication and transport/adapter cutover. The page's placement gains fewer immediate package moves but risks two public client families. Owner chooses the long-lived library boundary.

### B5. Narrow Q3 to new dispatch; keep cancellation and cleanup local

Snapshot Q3 line 239 says local tools “stop” on Switchboard outage. I share fail-closed as the initial lean for **new policy-authorized work**. That statement must not mean inability to inspect/cancel/drain a current operation, inability to clean up a VM, or claiming an already-dispatched effect was stopped remotely. Current retirement coordinates resource drainage locally (`H:packages/gateway-runtime/src/production/gateway-runtime-production-lifecycle.ts:127-193`); the new controller must retain an owner for it.

Recommendation: no policy cache by default; local status/cancel/cleanup stay available to their legitimate owner; in-flight operations return known or unknown outcomes without blind replay. A stale-policy cache would be a separate offline-authorization feature with explicit expiry/revocation tradeoff. This does not add a second policy database.

### B6. Per-agent token forwarding and VM registration are different contracts

Q2/Q6, snapshot lines 238/242, correctly reject controller-only identity. But “machine and agent tokens from sign-in” does not yet specify authority to register/use a computer, or bind a local agent to its bot/session/workspace. H agent proof has client/organization/workspace/audience/expiry; the verifier requires a workspace resource audience and `tool-portal:agent`. It is not a ready generic machine/computer-service admission token (`H:packages/tool-access/src/contracts/agent-proof.ts:26-61,90-125`). The issuer's actual resource linkage is workspace-specific (`H:packages/auth/src/better-auth-provider/provider-configuration.ts:235-261`).

Recommendation: preserve original per-agent proof/caller context through the computer channel, separately authenticate the service connection, and define the caller/registration audience and Fleet binding before public exposure. Do not infer computer privilege merely from possession of a tool-audience token. Generic identity types and token validation are not themselves workspace permission or VM resource grants. This is the missing contract in the proposal, not an invitation to add a new auth product.

### B7. The per-user diagram chooses a credential-delivery architecture

Snapshot's per-user example says Switchboard hands a short-lived token to the controller for each call. That is plausible for the existing Gog CLI case, but it is a proposal beyond “Switchboard owns tool control.” Domain custody and physical token placement are distinct. Alternatives include Switchboard directly calling a per-user MCP/provider, or a computer-local credential adapter behind a scoped authorization interface. The old broker's Node-local encrypted catalog does not become Worker-compatible or remotely mediated by copying it.

Recommendation: label this specifically as the proposed credentialed-CLI path. Keep provider consent/account policy distinct from people sign-in. Defer its token/material transport and store/crypto details until per-user tools, rather than requiring it to deliver remote MCP first. Source: `H:packages/oauth-broker/src/oauth-credential-catalog.ts:1-64`; `H:packages/agent-vm/src/controller/credentialed-runtime/credentialed-managed-vm.ts:55-90,126-149`.

### B8. Do not turn the three hub jobs into one serialized RPC handler

The local computer path has a central permission round trip; the remote computer path dispatches on the same controller connection. If a local request awaits Switchboard while holding a one-at-a-time computer/session lock, the returning execute request can wait behind its own caller. The page's topology can be implemented without this problem, but the required concurrency/lifetime owner is absent from the picture.

Recommendation: show independent front-door request and admitted computer dispatch handling, correlated by call/agent/operation identity, with local cancellation and no automatic redispatch after ambiguous disconnect. This is an architectural failure case inferred from the proposed loop, not an observed defect in existing code. Part A names the deciding real-path scenario; no new prototype/gate was run or commissioned.

## Q1–Q7: my second view

| Question | View on the page's lean | Qualification / alternative |
|---|---|---|
| Q1 outbound controller | Agree as default topology | It is not physically impossible to dial a privately routed listener. Private network/Tunnel deployment is another option. Outbound connection removes that reachability assumption, but authentication and reverse dispatch still need a contract |
| Q2 per-agent proof | Agree on retaining agent identity | Also bind bot/session/workspace/correlation to the registered agent; no machine-global mutable “current agent.” H proof does not itself define the post-Gateway Fleet bot model |
| Q3 fail closed | Agree for new policy dispatch | B5: never make cleanup/cancel depend on the outage ending; existing outcome evidence survives |
| Q4 controller→Router | Best fit for hosted Switchboard and local Router | It is a narrow private MCP relay, not yet source-wired. Do not require full remote VM support just to carry MCP. Co-located Node direct loopback is another valid initial deployment |
| Q5 direct Switchboard without Agent VM | Agree | One tool contract across transports; SDK may hide transport choice, not authority/registration differences. Generic MCP clients should also be able to use the standard endpoint |
| Q6 registration | Needs explicit contract before adoption | Separate service peer, agent proof, registration permission and execution grant. Current workspace tool audience does not define VM-service privilege |
| Q7 cloud later | Agree on deferring implementation | Avoid publishing local PID/path/SSH credential assumptions in the **new computer wire contract now**. Internal `managed-vm`/durable-record redesign can wait for a selected cloud backend; current source requires local PID outside the factory |

## Remaining Gateway Runtime / SDK ownership detail

These refine Part A's responsibility split, and are proposals rather than edits:

| Current concern | Target implementation owner | Public/client counterpart |
|---|---|---|
| Raw sandbox env/exec/fs/process/stream/terminal and active-use registry | Controller VM-service runtime | Computer contracts + SDK typed clients |
| Tool capability assessment, profile/accounts, policy and approval orchestration | Switchboard access/engine + injected authority stores | Tool contracts/SDK return challenge/receipt/outcome; clients do not decide policy |
| Managed MCP factory, upstream connection/cache/catalog | Switchboard engine/host adapters | Standard MCP and SDK catalog/helper surface |
| Tool VM runner's SSH/provider mechanics | Controller | Authorized computer request/result contract, no raw private SSH material to agent |
| Artifact bytes, handles and producer/process cleanup | Controller when produced there; Switchboard when produced remotely | One artifact-reference/read contract plus owner-routed authorization; exact expiry/retirement owner must be preserved |
| Account consent/token refresh/encrypted catalog | Switchboard credential domain + concrete host adapter | Provider-account DTOs; separate from Sign-in person/client identity |
| Private UDS framing/cancel/correlation | Controller front-door server adapter | Shared SDK Node/Python transport, independent of Hermes-only handshake |
| Gateway cohort/guest control/readiness identity | Obsolete hosting shell retires | Replace with explicit registered caller/service identity; do not carry Gateway epochs as unexplained permanent API |
| SDK passive schemas / portable refinements | One authoritative contract owner (`tool-access`, computer contracts, account contracts) | SDK imports/reexports only as deliberate client convenience, not a second schema source |
| SDK generated functions / TypeScript compiler | Compiler on build/Node host side; functions/client types in SDK | Generated imports must follow chosen published package/version; H compiler currently emits old SDK import (`H:packages/tool-host-node/src/catalog-typescript/catalog-typescript-compiler.ts:335-353`) |
| SDK CLI/local-exec bridge/guest relay | Client/transport in SDK; framework bridge in host adapter; guest helper distribution can stay VM-specific | Count both sides rather than moving the whole folder based on its current deployment |
| Process/VM health, lifecycle logging, telemetry | Producer's runtime host owns shutdown/flush | Correlation can cross the contract; observation does not become approval authority |

## Lower-priority factual precision

- `control-protocol-contracts` table row credits “sequence and credit” to one package. Source `credit` frames are in `controller-execution-contracts/src/controller-execution-data-boundary/index.ts:36-60`; control-protocol has envelope/receipt/sequence/queue policies. Keep the two contracts distinct.
- The dedicated execution WebSocket has source and tests but no production constructor caller found; this investigation did not run those tests. “Has tests” is the supported evidence, not current runtime success.
- “Nothing reaches the Switchboard or Router today” should stay scoped to the inspected managed production wiring/pins; external deployment provider configuration was not searched. Libraries are already reused at H without a service network connection.
- Sign-in can be deployed independently while its code temporarily shares a repository; repository placement and service boundary are separate decisions. Conversely a separate repo does not remove the current tool-access identity/resource import; the proposed pure contract cut must name it.
- Keep proof for moved Python SDK/client behavior if that code moves; the root already separates `python:typecheck:host`/host tests from Hermes-specific checks (`H:package.json:18-26`). Removing VM/Hermes source does not automatically make every Python check irrelevant. No check-gate change is authorized by this report.

## Result boundary

The revised page captures the owner's hub model much better than the retired split page. The important remaining discussions are public client ownership, raw sandbox admission, identity vs service registration, offline behavior, credential placement and the new controller's request/dispatch lifetime. This is an independent advisory comparison and checked source corrections; reviewer findings, owner adoption and implementation proof remain separate.
