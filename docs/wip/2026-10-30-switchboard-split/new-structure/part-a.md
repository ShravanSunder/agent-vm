# Part A — independent structure advice

**Proposal, not an adopted design.** Source is H `2dfea38e8dcdd01fce28d811ed5ec8db45c25023`. The owner's latest model is the controller as the local hub, with the harness outside the VM. I have not opened the Lead's draft page while forming this proposal.

My recommendation is to use the controller as **one local transport front door and VM execution owner**, while keeping **one tool-policy owner in Switchboard**. Do not rebuild the entire current Gateway inside the controller. Split its jobs: local connection/VM/process/file lifetimes go to Agent VM; tool discovery/policy/approvals/provider-account decisions go to Switchboard; client behavior goes to the SDK. The hub adds a hop, but it does not require a second policy engine.

## 1. Target maps

### Runtime communication — proposed controller-hub model

```text
On a managed computer
  Agent / host-side harness
           |
           | published tool/computer SDK over private local socket
           v
  Agent VM controller  <=====================>  Switchboard
     local front door      authenticated        tool/control authority
     VM execution owner    duplex connection        |
           |                                      +--> workspace remote MCP
           +--> VM backend                        +--> per-user provider tools
                Gondolin today                    +--> collaboration MCP adapter
                cloud adapter later               +--> computer backend:
                                                       call controller on channel

Separate service
  Switchboard -- live identity/agent-client calls --> Sign-in
  Both use Fleet-owned identity contracts; Fleet owns workspace/bot meaning

Agent without Agent VM -- standard MCP --> Switchboard   [recommended exception]
```

The double arrow is one proposed authenticated connection, not two competing authorities. For a local computer tool the runtime round trip is intentionally `agent → controller → Switchboard → same controller → VM`. A handler waiting for Switchboard must not hold the execution lock or block processing commands arriving on that same duplex channel. Acknowledgement, completion, cancellation and an unknown outcome stay separate.

### Repository imports — proposed, distinct from runtime calls

An arrow means **imports a published library**, never calls a service:

```text
agent-vm ---------> switchboard libraries ---------> agent-collaboration identity contracts
sign-in ---------> switchboard tool-resource contracts
sign-in -----------------------------------------> agent-collaboration identity contracts
```

This is acyclic. Switchboard calls Sign-in at runtime through an injected port and a host adapter; it does **not** import Sign-in's implementation. Sign-in may import a small pure Switchboard tool-resource contract for canonical MCP audience/resource rules. Generic Fleet identity shapes come from `agent-collaboration`; Switchboard-specific `/workspaces/W/mcp` URL rules do not become Fleet identity rules merely because they contain a workspace ID.

Agent Collaboration must not import Switchboard's SDK back into that same repository if the owner requires **repository-level** acyclicity. It can expose collaboration MCP and let clients configure Switchboard endpoints through standard protocol/configuration. If a future Router implementation truly needs Switchboard-specific imported code, this four-repo graph must be revisited; package acyclicity alone would not satisfy the stated repo rule.

## 2. What to publish from Switchboard

### Contracts and SDK have different jobs

**Proposed computer contracts** are a small new public boundary, seeded by existing code rather than a renamed complete Gateway protocol:

- public tool request/result/artifact contracts remain owned once in `tool-access/contracts`;
- a dedicated computer-contract entry/package defines the admitted computer environment/process/file/stream/terminal operations, handles, correlated outcomes and transport envelope actually needed by external implementations;
- domain identities are imported from Fleet's identity contract package;
- provider-private requests, raw host paths, VM SDK objects, private SSH keys and Gateway/Hermes attachment cohorts are excluded from the public computer boundary;
- publish language-neutral schemas for other implementations, with TypeScript/Rust representations checked against the same authority. The existing Router schema-export pattern is a starting point, not a claim that this new contract already exists (`R:crates/collaboration-protocol/examples/export_protocol_types.rs:1-6`).

The separate public computer boundary earns a package because Agent VM implements it in another repo and alternate computer/VM services must be able to implement it without importing the Tool Portal server. A `/computer-contracts` subpath can be used while it has one concrete implementation, provided it remains independent of server/runtime code; the owner need not choose a final npm name today.

**The switchboard-sdk** is client and connection code, not “everything else.” Proposed separated entrypoints in one SDK package:

| SDK entry | Job | Kept out |
|---|---|---|
| tool client | List/search/describe/call tools, generated helpers and artifact reads; connect to controller front door or standard Switchboard MCP | Policy database, approvals decisions, provider credentials |
| computer connection | Bind registered clients and serve/issue typed computer messages through injected transport | VM implementation, filesystem/SSH backend, local machine administration |
| Node transport | Local socket/stdio and WebSocket transport adapters | Portable root/barrel; browser/Worker consumers should not load Node I/O |
| framework adapters | Host-side Hermes integration and any agent-specific presentation glue | VM image boot and tool-policy authority |

Today the SDK is not merely schemas: it has MCP client methods, Gateway UDS client, Tool VM relay, generated functions and CLI (`H:packages/agent-portal-sdk/package.json:18-110`; `H:packages/agent-portal-sdk/src/index.ts:1-11`; `H:packages/agent-portal-sdk/src/tool-portal-mcp-client/index.ts:135-210`). Those responsibilities must be counted before merging or deleting it.

### Runtime-free core means more than “no Node imports”

**Proposed rule:** `tool-access` owns pure assessment and portable tool schemas; `tool-engine` owns dispatch/operation state transitions and orchestration against ports; `tool-host-core` owns shared host-neutral protocol/application coordination. Node and Cloudflare packages construct concrete I/O, clocks/timers/UUIDv7 IDs, credential resolution and typed Drizzle stores.

Drizzle schema/table ownership follows the component that owns the records. Each platform adapter translates typed domain operations to its driver's transaction; do not expose a generic `read(key)/write(key)` bag as the application's data model. SQLite synchronous transactions must not yield across an await. Existing Node process-local Maps are not durable stores simply because their function takes `directory` (`H:packages/tool-host-node/src/operation-records/node-operation-store.ts:46-114`).

Current H still needs this separation: upstream connector elapsed-time and timeout helpers directly use `Date.now` and `setTimeout`; token signing can default to `crypto.randomUUID`; person proof includes a network JWKS verifier in the contracts module. These are source facts, not new remedies already applied (`H:packages/tool-engine/src/upstream-mcp-connectors/upstream-mcp-protocol.ts:261-309`; `H:packages/tool-engine/src/mcp-gateway/signed-tokens/approval-token-signing.ts:39-40`; `H:packages/tool-access/src/contracts/person-proof.ts:67-119`). Inject the actual nondeterministic/I/O edges; no Effect adoption or new framework is needed to name them.

## 3. Per-repository disposition

### Switchboard copy — each of the 17

“Delete later” means after the new product's public/CLI/image consumers have an explicit disposition and cutover. It does not authorize changing the running old Agent VM. `tool-*` names stay as directed; npm scope remains open.

| Current package | Proposed disposition and final job | Reason to change / decisive H source |
|---|---|---|
| `tool-access` | **Keep; split out Fleet identity and effectful verification.** Pure tool contracts/access assessment; keep tool-specific resource URL policy | Tool policy/schema changes. `src/contracts/index.ts:1-20`; `src/contracts/workspace-resource.ts:3-29`; `src/authorization/access-assessor.ts:92-109` |
| `tool-engine` | **Keep; segregate protocol connectors from pure dispatch and inject time/I/O.** One tool orchestration engine | Dispatch/state/outcome semantics. `src/capability-dispatch/capability-dispatcher.ts:71-216`; upstream timeout source above |
| `tool-host-core` | **Keep.** Shared host-neutral resource-server/application composition and authority/store ports | Request admission/lifetime across hosts. `src/hosted-mcp-proxy/hosted-mcp-proxy.ts:65-183,198-236`; `src/index.ts:1-42` |
| `tool-host-node` | **Keep.** Node server/stdio/process adapters, Node Drizzle/storage/secret/config loading composition | Node runtime and driver behavior. `src/node-host-startup.ts:25-92`; `src/node-host-composition.ts:68-98,126-166`; `src/standalone-tool-portal/standalone-entrypoints.ts:104-183` |
| `tool-host-cloudflare` | **Keep.** Worker/DO/platform bindings, Drizzle platform driver, analytics/logs and request transport adapters | Cloudflare runtime/storage behavior. `src/index.ts:30-80`; `src/durable-workspace-authority/workspace-authority.ts:7-56` |
| `auth` | **Copy intact initially, then move to its own Sign-in repo/service.** Keep private issuer core and provider host separate | Issuer/session/client/admission rules, independent of tools. `src/sign-in-core/index.ts:1-8`; `src/cloudflare-host/index.ts:9-65` |
| `agent-portal-sdk` | **Split/reshape into switchboard-sdk.** Move portable schemas to their owners; preserve tool clients/helpers/CLI; generic computer client contracts; remove obsolete Gateway attachment from target | Client/protocol evolution, not server policy. Public export map and MCP client above; `src/contracts/sandbox-environment-contracts.ts:11-44` |
| `tool-portal` | **Delete later in the edited copy.** Surviving policy/dispatch goes to access/engine; needed serving/client behavior to host/SDK; managed VM execution to controller | Old managed facade and standalone service overlap replacements but remain implemented/public. `src/index.ts:1-5`; `src/tool-portal-service.ts:584-639,793-863`; `src/standalone-tool-portal-service.ts:68-110` |
| `mcp-portal` | **Delete later in edited copy after command/image disposition.** Upstream/catalog/serving in engine+hosts; helper/client behavior in SDK | Old CLI remains a product operating surface and is installed into Tool VM images. `src/bin/mcp-portal-command-dispatcher.ts:406-454`; `H:packages/agent-vm/src/build/managed-image-dockerfile.ts:207-208,279-297` |
| `oauth-broker` | **Split internally; retain credential-domain core.** Tool-provider consent/refresh/catalog/containment belongs Switchboard; driver/crypto/provider HTTP adapters injected from hosts | Tool-account custody changes independently from people sign-in. `src/oauth-credential-catalog.ts:1-64`; `src/google/google-oauth-broker-service.ts:80-110`; `src/google/google-oauth-adapter.ts:210-320` |
| `oauth-approval-ui` | **Keep as provider-consent/account-policy UI; isolate asset loading.** Do not merge its authority into Sign-in or call it the whole approval system | Presentation/browser changes. `src/server/oauth-approval-renderer.tsx:1-18,53-69`; `src/browser/entry.tsx:1-24` |
| `oauth-broker-contracts` | **Keep as portable account-policy/consent contracts; trim legacy-specific names as consumers cut over.** Not the new identity package | Provider-account permission semantics. `src/index.ts:1-13`; `src/google-account-policy-contracts.ts:88-121` |
| `config-contracts` | **Split by responsibility.** Pure tool/OAuth schemas/projections remain here or merge into access/account owners; Node loading moves host; VM deployment config stays Agent VM | Tool/OAuth schema vs host file loading change separately. `src/index.ts:1-10`; `src/json-config-file.ts:1-38`; `src/tool-portal-config.ts:19-41`; Agent VM `src/config/system-config.ts:1704-1712` |
| `secret-management` | **Keep, with portable `/contracts` and isolated `/node` implementation.** Hosts inject resolver; VM-only secret selection remains Agent VM | Shared credential-source interfaces vs SDK/op/Keychain. `src/contracts.ts:1-24`; `src/index.ts:1-7`; `src/onepassword-secret-resolver.ts:1-8,551-595` |
| `gateway-control-contracts` | **Split, then retire Gateway-specific public package at cutover.** Tool policy/approval shapes to access/engine; neutral computer subset to computer contracts; VM-internal lease/SSH bindings remain private Agent VM | Current package conflates Gateway attachment, leases, policy and effects. `src/index.ts:158-360,615-645,850-900`; `src/gateway-runtime-approval.ts:49-176` |
| `control-protocol-contracts` | **Extract/merge only needed wire semantics into computer contracts; delete obsolete Gateway protocol later.** Do not invent a universal control bus | Framing/correlation/delivery differ from application authority. `src/index.ts:29-85,195-231`; domain is currently `gateway_control` only |
| `controller-execution-contracts` | **Split.** Public computer operations/outcomes seed computer contracts; provider-private VM exec remains Agent VM; tool invocation policy belongs access; retired Gateway bulk binding disappears | Execution protocol vs provider input vs tool policy are distinct. `src/index.ts:1-5`; `src/tool-vm-runner-boundary/models/managed-vm-exec-request-schema.ts:19-38`; `src/controller-execution-data-boundary/index.ts:17-69` |

Unprefixed table paths are under `packages/<row package>/` at H. These are conceptual dispositions. The final number of npm packages is not a design goal; use subpaths/modules where no cross-repo consumer requires another public package.

### Agent VM after rework

| Current package / piece | Proposed home | What stays / what leaves |
|---|---|---|
| `agent-vm` | Agent VM repo | Controller, CLI/admin API, local agent front door, Switchboard connector, registration/admission, VM/lease/workspace/file/process lifecycle. Tool policy/provider-account custody moves to Switchboard |
| `managed-vm` | Agent VM repo | Neutral provider capabilities and explicit support/failure semantics; do not assume a cloud provider can emulate host mounts/HTTP mediation |
| `gondolin-vm-adapter` | Agent VM repo | Gondolin-specific construction/VFS/SSH/mediation/ingress/process handling |
| `gateway-runtime` raw sandbox/process/files/SSH, active-use, local artifacts and relay service | Agent VM controller-owned runtime modules | Preserve execution/cleanup owners while removing dependence on a guest Gateway's lifetime |
| `gateway-runtime` policy/catalog/provider/approval orchestration | Switchboard access/engine/host composition | One policy/approval authority; controller forwards agent tool calls and enforces local execution boundary |
| `gateway-runtime` UDS framing/server | Controller front-door transport adapter + shared contracts/client where needed | Keep local transport functionality, replace Hermes-only cohort admission consciously; no `hermes-managed-plugin` default for arbitrary agents |
| `gateway-runtime` signed host-to-guest control, Gateway readiness/cohort | Retire after host-harness cutover | Keep generic fencing/outcome requirements; delete the obsolete Gateway VM handshake and attachment ceremony |
| `gateway-lifecycle` | Retire Gateway-specific role; needed VM requirements stay `managed-vm` | No future requirement for a special VM containing the harness |
| `hermes-gateway` | Host-side Hermes adapter in SDK/integration source; VM-image-specific shell retires | Keep framework/profile/approval presentation; move startup out of VM; ordinary Hermes is still upstream software, not a new Tool Portal implementation |
| Python `agent-vm-agent-portal-sdk` | Switchboard SDK family | Portable clients/relay helpers; Node/TS package is not imported into Python; shared schema authority |
| Python `agent-vm-hermes-adapter` | Host-side harness adapter | Selects the real agent/session/workspace registration and uses controller SDK surface |

Source for mixed runtime: `H:packages/gateway-runtime/src/production/gateway-runtime-production-service.ts:558-735`; `H:packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.ts:479-529`; `H:packages/hermes-gateway/src/hermes-lifecycle.ts:121-155,289-396`. Target controller modules need not be new published packages; they have one VM service owner.

### Agent Collaboration / Fleet and Sign-in

| Repo | Proposed ownership and imports | Explicit exclusion |
|---|---|---|
| `agent-collaboration` | Fleet/Router/collaboration MCP; shared identity/relationship wire contracts published for TS and Rust | Switchboard-specific tool policy, computer VM/provider code, Tool Portal route layout |
| `sign-in` | `auth` issuer core, Better Auth/Cloudflare/D1 implementation, people/session/OAuth client/resource registration and live status; imports Fleet identity plus tiny Switchboard resource contract | Provider tool-account consent/refresh storage; runtime tool permissions |
| `switchboard` | Tool assessment/dispatch, provider catalog/connectors, approvals/operations, provider-account custody, runtime hosts, SDK and computer contract | VM lifecycle implementation, framework-specific agent loop, Fleet's workspace/bot truth |
| `agent-vm` | Registered local front door and VM/sandbox service; imports Switchboard contracts/SDK and selected generic secret library | Second tool policy database/approval policy engine; forwarding only a controller identity for all agents |

H currently publishes `PersonProof`, verifier and workspace resource from `tool-access/contracts`; this is a current location, not the desired authority. Move generic identity shapes to Fleet's shared contracts. Move effectful JWT/JWKS verification to a separate adapter/entrypoint accepting time/key-fetch ports; a signed person proof explicitly is not live-session authorization (`H:packages/tool-access/src/contracts/person-proof.ts:26-74,75-140`). Keep Switchboard resource URL construction in Switchboard (`workspace-resource.ts:3-29`). Sign-in can depend on that small pure protocol contract without Switchboard importing Sign-in back.

## 4. Four tool-kind paths through the controller hub

All paths below are **proposed**. Local registration binds the actual caller agent/session/workspace; server-generated context is not a string the model may override.

| Tool kind | Ordered hops | Where effect/credentials live |
|---|---|---|
| Workspace remote MCP | Agent → local controller front door → Switchboard → configured remote MCP → same return path | Switchboard selects tool/provider and credential binding; no local VM required |
| Per-user tool | Agent → controller → Switchboard account policy/consent/approval → provider MCP/HTTP; or → chosen computer/controller credentialed sandbox → provider | Tool-account credential owner is Switchboard. A remote controller's mediation/runtime must receive only explicitly authorized scoped material; this cross-service credential custody is a design obligation, not solved by moving broker files |
| Computer/VM tool | Agent → controller → Switchboard assess/approve → selected registered controller over duplex channel → local VM backend → result/stream → Switchboard → front door → agent | Controller owns VM/process/file/cleanup; Switchboard tool authority. Do not turn admin SSH into a public generic executor |
| Collaboration MCP | Agent → controller → Switchboard policy → collaboration MCP adapter → Router-local MCP → application → return | Router retains collaboration authority. A Cloudflare Switchboard cannot reach an unexposed loopback/Unix endpoint; use a registered private computer relay or a separately admitted reachable endpoint, not an invented existing link |

For collaboration first, the necessary private reachability can be a narrow MCP relay on the controller connection; it does not require building the full remote VM feature set first. A co-located Node Switchboard can instead call Router loopback directly. These are deployment options; the old map found no current Agent VM→Router connection. Router's current loopback/owner-only Unix MCP listeners are source-backed (`R:crates/codex-router-host/src/collaboration_runtime/collaboration_api_serving.rs:27-80`).

### Registration, identity and who dials

**Recommended topology:** local Hermes/other harness clients dial the controller's private socket; controller initiates outbound registration/connection to Switchboard; Switchboard dispatches computer requests back over that admitted duplex channel. Controller implementation serves operations even though it opened the connection. A directly reachable controller listener is an alternative, not the default assumption for every personal computer.

Computer registration and individual agent registration are distinct: a computer connection proves which service is reachable; each agent tool request must carry a separately verified agent/session/workspace binding, and its return/reverse computer invocation must remain correlated to it. The controller's machine credential must not collapse all local callers into one agent. The old caller-context/Gateway HMAC protocol is evidence of the problem being addressed, not a ready new authority model (`H:packages/gateway-control-contracts/src/index.ts:158-242`).

The old definition “bot = one agent in a gateway” must be rewritten before adopting this contract. Preserve a stable bot/agent identity separate from harness process/session and connection generation. Changing the hosting process must not silently create a new person-like access principal or grant membership. The owner/Fleet design decides those identity relationships; the controller transports/verifies them.

### Outage and extra-hop advice

I recommend **fail closed for new tool-authorized dispatch** when Switchboard is unreachable. Keep local status, cancellation, draining and cleanup operable; do not strand processes because the policy server is down. An already dispatched effect remains completed/failed/unknown according to evidence; reconnect must not replay an ambiguous command. Local policy caching would create offline authorization, expiration/revocation and storage obligations not supplied by “controller as hub,” so it should be a separate owner decision.

The extra hop has a concrete tradeoff: one per-computer front door and local handle/stream/VM lifetime owner, paid for by an extra local request boundary and possible central round trip. I have not measured latency or throughput and make no speed claim. The concrete falsifier is a real controller→Switchboard→same-controller computer call under disconnect/cancel while the original front-door request waits; it must demonstrate no serial-handler deadlock, correct per-agent binding and no ambiguous replay. No prototype/run is authorized here.

Agents without Agent VM should, in my recommendation, continue using standard MCP directly to Switchboard. Installing a VM controller purely to reach remote MCP is a separate product cost. If “every agent everywhere must use the hub” is literal, offer a controller configuration with no VM backend until one is requested; do not make QEMU/Gondolin a prerequisite for remote tool calls.

## 5. Open decisions and holes

These are for the Lead/owner discussion; no question has been silently answered by source or copied into an implementation plan.

| Decision | Options and gain/cost | Recommendation / what waits |
|---|---|---|
| Local hub scope and raw sandbox authority | (A) tools through Switchboard, VM-service access separately granted to registered harness; separates policy from raw sandbox. (B) every agent sandbox operation also mediated as a Switchboard tool; adds round trips but one policy path. Neither permits arbitrary callers to claim trusted registration | Decide what “all comms” promises. I favor B for agent-facing tool effects, with a distinct trusted VM-service registration for harness lifecycle/control. Raw shell permission is broader than a configured CLI permission; it cannot silently bypass protected host/credential tools |
| Offline behavior | Fail closed: simplest current authority, availability cost to user. Expiring cached policy/grants: offline availability, operator owns revocation/replay/store complexity. Permanent local second policy: maximum divergence/maintenance | Fail closed for new protected effects; status/cancel/cleanup stay local. Offline auth can wait without blocking remote MCP delivery |
| Agent identity after Gateway removal | Stable Fleet bot identity + many sessions/connections, or an explicitly session-scoped identity. Both need actual workspace-binding authority; machine identity alone loses attribution | Preserve stable bot identity and separate session/harness/connection; Fleet terms and issuer claims must be settled before new caller contract |
| Sign-in physical repo timing | Move intact service now: independent ownership/release, package publishing work. Keep auth in copy temporarily: easier bootstrap, temporary repo coupling | Own repo as end state; intact temporary copy until its pure imports/runtime port exist is acceptable. Do not move per-user tool custody into people sign-in |
| Identity vs tool-resource contract | All URL/resource policy in Fleet: fewer imports but Fleet learns Switchboard endpoint layout. Tiny pure tool-resource contract imported by Sign-in: correct owner, one extra published dependency | Keep generic identities in Fleet, tool resource URL/policy in Switchboard. Sign-in→Switchboard contract import is acyclic because Switchboard only calls Sign-in at runtime |
| Computer connection reachability | Controller outbound duplex: no assumption of inbound address, new reverse-dispatch lifecycle. Switchboard dials controller: simple server relation when reachable, explicit private networking setup | Outbound controller connection as default proposal; local private socket for harness. Transport/auth lifecycle needs focused design before implementation |
| First collaboration deployment | Co-located Node Switchboard→Router loopback, or hosted Switchboard→controller MCP relay→Router; different deployment/reachability cost | Name one actual supported route for first delivery. Full VM operations can wait, but private collaboration reachability cannot |
| Npm scope | `@agent-fleet`: owner reports control and broader platform identity. `@agent-collaboration`: current new-package naming alignment; ownership/publication verify. Retain `@agent-vm` for old frozen consumers: least churn but misleading for new tools | Keep existing `tool-*` package basenames. Recommend `@agent-fleet` for newly named SDK/computer contract if owner wants one platform scope; decide scope once before first new publication. A reported 404 for one package does not establish scope-wide emptiness |

### Future cloud backend: do not promise features the interface cannot carry

`managed-vm` already isolates Gondolin selection, but its capability set includes owned host-directory mounts, finalizable memory mounts, host-process identity/termination, HTTP-hook mediation, synthetic TCP/SSH and ingress. A cloud VM cannot be declared equivalent by implementing `start/exec/close` and ignoring those features. Preserve selected workspace/file/secret guarantees, or advertise/refuse unsupported operations. Capability-based provider support is preferable to pretending every backend implements local RealFS and host interception. It costs callers an explicit unsupported result; complete Gondolin emulation costs the adapter/operator a remote mount, secret-egress and recovery implementation. See [computer-contract evidence](computer-contracts.md) for required/optional source details.

This needs changes above the provider too: `ManagedVm` requires ingress, SSH and host-process observation; only memory finalization is optional. Tool VM startup and runtime-record creation independently demand a positive local PID and captured local process identity. A remote VM resource ID cannot be put in that field, and an HTTP “stop accepted” is not the same containment evidence. Thus a cloud backend is later contract/record/consumer design, not only a new factory. `H:packages/managed-vm/src/managed-vm-contracts.ts:333-413`; `H:packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts:192-223`; `H:packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:507-553`.

Fleet workspace/bot truth, Switchboard tool allowances, issuer resource/client linkage and controller registration must remain separate facts with explicit readers. In particular, moving Sign-in must not create another workspace-membership authority; issuing a correctly scoped token is not permission to use every tool in that workspace. The current issuer and relying-service checks are separate at H; the proposed Fleet-to-Switchboard admission source still needs to be named.

## 6. What I disagree with or would narrow

- **“SDK is all the other stuff” is too broad as a package definition.** Client/transport/registration code is SDK; policy stores, broker custody, controller VM execution and host-specific Drizzle drivers have independent owners.
- **The 17/6 graph cut is a valid copy boundary, not the end-state design.** It leaves mixed contracts and residual runtime tool policy in the controller. The owner's coarse copy can preserve current Agent VM while Switchboard changes, but it creates two source histories; name which branch/product is maintained and retire replaced interfaces within each cutover, not with indefinite compatibility shims.
- **Do not delete Gateway Runtime by name.** It currently owns raw computer execution, artifacts and relay as well as policy and guest handshake. Move the first group into controller ownership before retiring the old hosting shell.
- **Do not expose provider-private `ManagedVmExecRequest` as an agent-authorized public API.** It contains executable/env/runtime policy inputs after authorization; the public boundary must still establish who may select the target and cause the effect (`H:packages/controller-execution-contracts/src/tool-vm-runner-boundary/models/managed-vm-exec-request-schema.ts:19-38`).
- **Existing WebSocket helpers are not an already deployed generic computer service.** Production upgrade dispatch accepts only the current Socket.IO control path; the separate execution WebSocket constructor has no non-test caller found (`H:packages/gateway-runtime/src/control-endpoint/gateway-control-endpoint.ts:133-145`).
- **Remote MCP/collaboration first should not wait for full per-user/cloud VM redesign.** Keep those tool-kind extension contracts explicit; do not silently rebuild all deferred behavior to justify the split.

## Limits and independent checkpoint

Source facts above were collected in three bounded lanes and decisive anchors reopened by the parent. Manifest cut checked across all four dependency fields; no copied-package back-edge to the retained six. Production import absence, image distribution, actual contracts/runtime constructors and H's own workspace issuer were checked separately. No tests, builds, networking, deployment observation or product edit. New contracts, package placements and dial direction are proposals; no performance, complete provider portability or auth integration proof is claimed.

Part B has not been opened at this checkpoint. The independent proposal is frozen before that factual comparison; any later factual correction will be marked rather than presented as independent prior discovery.
