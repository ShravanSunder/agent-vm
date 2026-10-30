# Part A — corrected direct-harness / computer-Portal structure

**Current owner direction; structural details below are proposals.** This replaces the mandatory-controller-hub proposal, which the owner explicitly rejected. Harnesses run outside VMs and talk directly to Switchboard for tools and Fleet central for messages. Bots register to workspaces. Agent VM registers with Switchboard as a computer Tool Portal over MCP; systems on that computer can also use its controller directly. Later, Switchboard MCP can also carry Fleet messages.

The important split is **a tool aggregator/control service and a registered computer tool provider**, using shared libraries and protocol. Agent VM is not a mandatory relay for harness tools or Fleet communication. It still provides the full computer Tool Portal capability surface, not only VM creation.

## 1. Target runtime map

```text
Host harness --------------------> Switchboard ----------------> remote MCP tools
      |                                |
      | messages                       | MCP computer tools
      v                                v
Fleet central                 Agent VM computer Tool Portal
      ^                         ^       |
      | later: messages         |       +--> VM/sandbox backend
      +----- Switchboard MCP    |            Gondolin now; cloud later
                                |
                    authorized same-computer systems
                    may call controller directly

Bots ---- register / bind ----> workspaces (Fleet domain)
Agent VM ---- register MCP service ----> Switchboard (computer provider)
```

The two registrations identify different things. A computer provider registration is not bot membership in a workspace. A harness session is not the computer service identity. Changing where a harness runs must not silently create or delete the bot's workspace relationships.

For computer registration, the contract must name an admitted MCP endpoint/private route and which computer service/capabilities it represents. Registration alone does not make a loopback address remotely reachable. A reachable private MCP endpoint can be dialed by Switchboard; a private computer can establish an outbound admitted route if needed. **The owner's registration direction does not itself decide the TCP/WebSocket connection opener.** Do not add a mandatory one-session-per-computer custom RPC tunnel to the design before the actual reachability option is chosen.

## 2. Code imports — separate from those runtime arrows

```text
agent-vm ---------> Switchboard tool libraries / contracts / SDK
switchboard -----> Fleet-owned identity contract artifact
sign-in ---------> Fleet-owned identity contract artifact
sign-in ---------> small pure Switchboard tool-resource contract (if needed)
```

These imports are acyclic if Switchboard calls Sign-in only through an injected runtime port and does not import Sign-in implementation. Fleet/Router can expose collaboration protocol/MCP without importing Switchboard SDK back into its own repo. If a later Router library needs that SDK, the strict repo DAG must be revisited; Rust does not make an artifact dependency impossible or exempt it from the DAG.

Generic identities belong to Fleet's shared contract authority. Switchboard-specific canonical tool resource URL rules remain Switchboard's protocol. Current H mixes those in `tool-access/contracts`; the proposed split moves generic person/agent/workspace proof representations while isolating verifier I/O from schemas (`H:packages/tool-access/src/contracts/index.ts:10-20`; `H:packages/tool-access/src/contracts/person-proof.ts:26-74,75-140`; `H:packages/tool-access/src/contracts/workspace-resource.ts:3-29`). Router already has a source pattern for exporting shared DTO schemas (`R:crates/collaboration-protocol/examples/export_protocol_types.rs:1-6`); the new identity artifact is proposed, not already implemented by that example.

## 3. Two Tool Portal hosts, shared behavior

**Proposed:** Switchboard owns the tool-access/engine/contracts/SDK libraries and its Node/Cloudflare aggregator hosts. Agent VM composes the same supported Tool Portal libraries with a concrete computer/VM backend, and publishes those capabilities over MCP plus an admitted local controller interface. Its VM backend does not import Switchboard service implementation or provider SDKs into the portable core.

- Switchboard owns workspace tool visibility, profile/account assessment, aggregate routing and its approval/account domain.
- The computer Portal owns its actual local resources, advertised capabilities, local service admission, execution/stream/file/artifact lifetime and concrete containment.
- Direct local callers intentionally use the computer Portal. They do not need to proxy unrelated tool calls or Fleet messages through Agent VM.
- Provider-local restrictions and Switchboard policy are distinct facts, as with other upstream MCP providers. Reuse one policy/dispatch implementation; do not create a second hand-written approval engine. The binding between central approvals and local direct access remains an explicit decision.

This differs from merely deleting `gateway-runtime`: it currently owns full environment/process/file/stream/terminal execution, SSH binding use, artifacts and relay, as well as tool composition and guest attachment (`H:packages/gateway-runtime/src/production/gateway-runtime-production-service.ts:558-735`; `H:packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.ts:479-529`). Preserve the computer features while retiring the Gateway-in-VM hosting shell.

### Published contracts and SDK

Keep one authoritative tool request/result/artifact schema owner in `tool-access`; factor the computer capability schemas from current SDK raw sandbox models and appropriate execution result models. Standard MCP is the chosen provider boundary; a new universal custom control bus is not required by that. Reuse SDK/client/transport entrypoints rather than copying Gateway-specific HMAC/epoch/SSH details as a permanent public computer API.

The SDK should have typed tool/computer clients, generated functions, artifact reads and Node/Python transport adapters. It can address Switchboard or an admitted local computer Portal. It does not own VM execution, policy storage or credential custody. Host-specific client transports can be isolated subpaths. Actual SSH/VM/process/file implementations stay in Agent VM. A relay has multiple sides: shared wire/client behavior can remain SDK; guest helper distribution and concrete VM process hosting can remain Agent VM.

Source: current SDK has actual MCP calls, UDS clients, relay and CLI, not just schemas (`H:packages/agent-portal-sdk/package.json:18-110`; `H:packages/agent-portal-sdk/src/tool-portal-mcp-client/index.ts:135-210`; `H:python/agent-vm-agent-portal-sdk/src/agent_vm_agent_portal_sdk/__init__.py:16-21`). Current raw socket methods are distinct from tool dispatch (`H:packages/gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.ts:210-242`). Decide whether local clients receive raw sandbox service access or named tool access; do not assume today's trusted Hermes handshake authorizes arbitrary agents.

### Runtime injection and state

Core assessment/dispatch runs against narrow storage, time/timer, UUIDv7 and I/O ports. Runtime hosts supply typed Drizzle adapters for their domain stores. Sharing the Tool Portal implementation does not mean sharing one mutable machine-global caller context or one universal database.

H is not already finished against this rule: Node operation state is a process Map despite a directory parameter (`H:packages/tool-host-node/src/operation-records/node-operation-store.ts:46-114`); core upstream timeout helpers use native time/timers (`H:packages/tool-engine/src/upstream-mcp-connectors/upstream-mcp-protocol.ts:261-309`); Sign-in D1 adapters contain raw queries (`H:packages/auth/src/d1-persistence/person-admission-store.ts:36-53`). The OAuth broker catalog, however, **already uses Drizzle/better-sqlite3** (`H:packages/oauth-broker/src/oauth-credential-catalog.ts:1-15,38-64`). No new gates, Effect adoption or runtime change is authorized here.

## 4. Switchboard's copied packages — each of the 17

The coarse 17-package copy has no declared back-edge into the six VM packages across runtime/peer/optional/dev dependencies. Eleven of the 17 also exist on master. That supports the copy operation, not a conclusion that every package is pure or safely deletable. `tool-*` basenames stay. Npm scope is still an owner naming choice.

| Current package | Proposed disposition and final job | Reason to change / decisive H source |
|---|---|---|
| `tool-access` | **Keep; split out Fleet identity and effectful verification.** Pure tool contracts/access assessment; keep tool-specific resource URL policy | Tool policy/schema changes. `src/contracts/index.ts:1-20`; `src/contracts/workspace-resource.ts:3-29`; `src/authorization/access-assessor.ts:92-109` |
| `tool-engine` | **Keep; segregate protocol connectors from pure dispatch and inject time/I/O.** One tool orchestration engine | Dispatch/state/outcome semantics. `src/capability-dispatch/capability-dispatcher.ts:71-216`; upstream timeout source above |
| `tool-host-core` | **Keep.** Shared host-neutral resource-server/application composition and authority/store ports | Request admission/lifetime across hosts. `src/hosted-mcp-proxy/hosted-mcp-proxy.ts:65-183,198-236`; `src/index.ts:1-42` |
| `tool-host-node` | **Keep.** Node MCP/stdio server and backend adapters, Node Drizzle/storage/secret/config loading; reusable by the computer Portal | Node runtime and driver behavior. `src/node-host-startup.ts:25-92`; `src/node-host-composition.ts:68-98,126-166`; `src/standalone-tool-portal/standalone-entrypoints.ts:104-183` |
| `tool-host-cloudflare` | **Keep.** Worker/DO/platform bindings, Drizzle platform driver, analytics/logs and request transport adapters | Cloudflare runtime/storage behavior. `src/index.ts:30-80`; `src/durable-workspace-authority/workspace-authority.ts:7-56` |
| `auth` | **Copy intact initially, then move to its own Sign-in repo/service.** Keep private issuer core and provider host separate | Issuer/session/client/admission rules, independent of tools. `src/sign-in-core/index.ts:1-8`; `src/cloudflare-host/index.ts:9-65` |
| `agent-portal-sdk` | **Split/reshape into switchboard-sdk.** Move portable schemas to their owners; preserve tool clients/helpers/CLI; computer Tool Portal clients/contracts; remove obsolete Gateway attachment from target | Client/protocol evolution, not server policy. Public export map and MCP client above; `src/contracts/sandbox-environment-contracts.ts:11-44` |
| `tool-portal` | **Delete later in the edited copy.** Surviving policy/dispatch goes to access/engine; needed serving/client behavior to host/SDK; managed VM execution to controller | Old managed facade and standalone service overlap replacements but remain implemented/public. `src/index.ts:1-5`; `src/tool-portal-service.ts:584-639,793-863`; `src/standalone-tool-portal-service.ts:68-110` |
| `mcp-portal` | **Delete later in edited copy after command/image disposition.** Upstream/catalog/serving in engine+hosts; helper/client behavior in SDK | Old CLI remains a product operating surface and is installed into Tool VM images. `src/bin/mcp-portal-command-dispatcher.ts:406-454`; `H:packages/agent-vm/src/build/managed-image-dockerfile.ts:207-208,279-297` |
| `oauth-broker` | **Split internally; retain credential-domain core.** Tool-provider consent/refresh/catalog/containment belongs Switchboard; driver/crypto/provider HTTP adapters injected from hosts | Tool-account custody changes independently from people sign-in. `src/oauth-credential-catalog.ts:1-64`; `src/google/google-oauth-broker-service.ts:80-110`; `src/google/google-oauth-adapter.ts:210-320` |
| `oauth-approval-ui` | **Keep as provider-consent/account-policy UI; isolate asset loading.** Do not merge its authority into Sign-in or call it the whole approval system | Presentation/browser changes. `src/server/oauth-approval-renderer.tsx:1-18,53-69`; `src/browser/entry.tsx:1-24` |
| `oauth-broker-contracts` | **Keep as portable account-policy/consent contracts; trim legacy-specific names as consumers cut over.** Not the new identity package | Provider-account permission semantics. `src/index.ts:1-13`; `src/google-account-policy-contracts.ts:88-121` |
| `config-contracts` | **Split by responsibility.** Pure tool/OAuth schemas/projections remain here or merge into access/account owners; Node loading moves host; VM deployment config stays Agent VM | Tool/OAuth schema vs host file loading change separately. `src/index.ts:1-10`; `src/json-config-file.ts:1-38`; `src/tool-portal-config.ts:19-41`; Agent VM `src/config/system-config.ts:1704-1712` |
| `secret-management` | **Keep, with portable `/contracts` and isolated `/node` implementation.** Hosts inject resolver; VM-only secret selection remains Agent VM | Shared credential-source interfaces vs SDK/op/Keychain. `src/contracts.ts:1-24`; `src/index.ts:1-7`; `src/onepassword-secret-resolver.ts:1-8,551-595` |
| `gateway-control-contracts` | **Split, then retire Gateway-specific public package at cutover.** Tool policy/approval shapes to access/engine; neutral computer subset to computer contracts; VM-internal lease/SSH bindings remain private Agent VM | Current package conflates Gateway attachment, leases, policy and effects. `src/index.ts:158-360,615-645,850-900`; `src/gateway-runtime-approval.ts:49-176` |
| `control-protocol-contracts` | **Extract/merge only needed wire semantics into computer contracts; delete obsolete Gateway protocol later.** Do not invent a universal control bus | Framing/correlation/delivery differ from application authority. `src/index.ts:29-85,195-231`; domain is currently `gateway_control` only |
| `controller-execution-contracts` | **Split.** Public computer operations/outcomes seed the MCP computer schemas; provider-private VM exec remains Agent VM; tool invocation policy belongs access; retired Gateway bulk binding disappears | Execution protocol vs provider input vs tool policy are distinct. `src/index.ts:1-5`; `src/tool-vm-runner-boundary/models/managed-vm-exec-request-schema.ts:19-38`; `src/controller-execution-data-boundary/index.ts:17-69` |

Unprefixed table paths are under `packages/<row package>/` at H. These are conceptual dispositions. The final number of npm packages is not a design goal; use subpaths/modules where no cross-repo consumer requires another public package.


## 5. Agent VM, harness, Fleet and Sign-in packages

| Repository / current piece | Proposed end responsibility | Reason / boundary |
|---|---|---|
| Agent VM `agent-vm` | Controller CLI/admin service; computer Tool Portal composition and local API; provider registration; VM/lease/workspace/process/file/credentialed-run lifecycle | Own the actual computer resources and execution, using imported Portal contracts/libraries |
| Agent VM `managed-vm` | Provider capabilities and typed support/failure contracts | Backend behavior, not tool-account policy |
| Agent VM `gondolin-vm-adapter` | Concrete Gondolin VFS, mediation, exec, SSH, ingress, local termination | Provider-specific runtime changes |
| Current `gateway-runtime` execution/active-use/artifact/relay implementation | Controller-owned computer runtime modules | Keep functionality; remove dependence on a guest Gateway's lifetime |
| Current `gateway-runtime` generic Tool Portal/MCP composition | Shared Switchboard libraries consumed by controller's computer Portal | One maintained implementation; backend is injected rather than an Agent VM import into Switchboard |
| Current UDS client/server and raw sandbox contracts | Separate shared SDK/client/protocol from controller server/executor | Connecting to a controller does not make client code a VM implementation |
| Current Gateway cohort / signed guest control / boot/readiness | Retire or replace when Gateway VM hosting ends | Existing app protocol is `gateway_control`, not a generic ready computer API |
| `gateway-lifecycle` | Gateway-specific role retires; remaining VM requirements go to managed-vm | Harness no longer needs a Gateway VM |
| `hermes-gateway` + Python Hermes adapter | Host-side framework adapter with VM-image delivery removed | Harness talks directly to Switchboard and Fleet, and uses Agent VM only for its computer capabilities |
| Python Portal SDK | SDK family with portable contracts and transports; VM-side helper artifacts may be packaged by Agent VM | It includes both Tool VM and Gateway/harness clients today |
| Agent Collaboration / Fleet | Workspace/bot relationships, messaging/coordination, Router and collaboration API/MCP; identity contract artifact | Authoritative membership and identity relationships are not computer registration |
| Sign-in own service/repo | Issuer/session/client/resource registration and live status, with portable core and concrete provider/Drizzle host adapters | People/agent authentication is distinct from per-user tool account consent/token storage |

The initial copy can temporarily include auth; own Sign-in repo is the recommended end boundary. Keep `secret-management` portable contracts separate from isolated provider implementations rather than forcing a new shared repository for one utility package. VM-only secret audience/mount selection remains Agent VM; tool provider credential custody stays in the tool/account owner.

## 6. Four tool-kind paths in the corrected model

| Tool kind | Ordered proposed path | Qualification |
|---|---|---|
| Workspace remote MCP | Harness → Switchboard MCP → remote provider → result to harness | Agent VM is absent from this path |
| Computer/VM | Harness → Switchboard → registered Agent VM MCP computer Portal → local VM/backend → result; **or** admitted same-computer system → controller directly | Same supported computer capability contracts; local and remote admission need an explicit policy relationship |
| Per-user | Harness → Switchboard account/consent/approval → per-user provider; when a computer credentialed CLI is needed, Switchboard → registered computer Portal → credentialed sandbox/provider | Do not assume every OAuth tool requires a VM. Raw/short-lived token placement across that boundary is a later design choice, not settled by moving code |
| Collaboration / messages | Harness → Fleet central directly; later Harness → Switchboard MCP → Fleet central adapter | The owner explicitly places the Switchboard messaging route later. Existing Router-local MCP remains a source fact, not a reason to insert Agent VM in every messaging path |

The target direct Fleet central API/transport still needs its actual harness consumer contract; today's Router-local MCP listener does not by itself implement that target (`R:crates/codex-router-host/src/collaboration_runtime/collaboration_api_serving.rs:27-80`). No currently wired Agent VM→Fleet/Router connection is inferred.

## 7. Open decisions — scope narrowed to this model

| Question | Options and concrete tradeoff | My recommendation |
|---|---|---|
| How Switchboard reaches registered computer MCP | Admitted reachable private endpoint: standard server/client arrangement, networking setup owned by operator. Outbound admitted route from computer: avoids inbound reachability assumption, adds connection/route lifetime | Use the actual supported private transport; registration identifies service/capabilities, not an invented single global bus. WS/socket choice waits on that deployment fact |
| Local direct admission and central approvals | Local service grant can permit VM operations within an owned sandbox; central tool approval can govern named remote effects. Requiring central approval for local direct work sacrifices independence; autonomous local policy adds explicit authority state | Name which methods each admitted caller may use and how central proof is recognized. Reuse Portal engine/authority ports; no blanket local bypass or duplicated rule implementation |
| What “all Tool Portal features” retains | Capability inventory includes discovery/schema/helpers, commands, environments, files/workspaces, processes/streams/terminals, credentialed runs, artifacts, approvals and relay; some have different execution/policy owners | Inventory each against a current consumer before pruning. The computer Portal must not shrink to VM CRUD merely because the old Gateway hosting shell is removed |
| Public SDK ownership | SDK in Switchboard with typed clients/transports: one protocol owner, publication work. Controller-specific SDK fork: easier initial copy, long-lived duplicate clients | Public client family in Switchboard; computer execution/server implementation in Agent VM |
| Post-Gateway bot identity | Stable workspace-registered bot plus sessions/harness processes, or an expressly session-scoped identity | Fleet decides the relationship. Neither computer registration nor running a harness implies workspace membership |
| Sign-in repo timing / identity imports | Keep intact in copy temporarily vs extract intact service now; extraction adds publication/setup but separates release | Own repo as target; generic identities from Fleet, tool-resource protocol from Switchboard; runtime calls do not create a code cycle |
| Provider account credential placement | Central provider HTTP/MCP, scoped computer credential material, or local credential adapter with central authorization | Defer detailed placement to per-user tools; keep provider consent/policy distinct from people sign-in |
| Cloud provider | Emulate all local guarantees vs capability-specific support/unsupported outcomes | Design for a selected backend later; do not publish local PID/path/SSH credential assumptions in the new public computer contract |
| Npm scope | `@agent-fleet`, `@agent-collaboration`, or frozen old names; new publishers must not collide | Keep `tool-*` basenames; owner chooses scope once before publication. One reported package 404 does not prove a whole scope empty |

### Cloud portability: source-backed limitation

`ManagedVm` requires exec, ingress, SSH and host-process observation; only memory finalization is optional. The provider aggregate also requires owned-host-directory and exact local process termination. Tool VM startup and durable runtime records independently require a positive local PID and captured process identity. A remote VM identifier cannot satisfy that field. Local mounts, memory-only pre-start credential finalization, host-side HTTP hooks and synthetic TCP/SSH routing need actual equivalents or explicit unsupported results, not no-op implementations.

Sources: `H:packages/managed-vm/src/managed-vm-contracts.ts:333-413`; `H:packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:507-553`; `H:packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts:192-223`; `H:packages/gondolin-vm-adapter/src/managed-vm-provider.ts:256-309,483-555`. This is an internal provider/consumer redesign later, not a reason to put every harness behind the controller now.

## 8. Independent advice and limits

The corrected model is coherent as **direct clients plus an optionally used, registered computer Portal**. Its code can stay acyclic because Agent VM imports published Portal contracts/SDK while implementing VM operations behind injected backend ports. The difficult new boundary is computer-provider registration/admission and preserving full Portal capabilities after Gateway removal; it is not a mandatory controller forwarding path for remote tools/messages.

I would challenge only the broad package terms: “SDK is everything else” must still separate clients, server/domain rules, host adapters and provider execution. Do not create another custom control protocol when the requested service boundary is MCP. Do not delete old Portal APIs or Gateway execution code until their functions have a supported home. A coarse copy is a starting point with two histories, not permission to maintain divergent public protocols forever.

Static source and manifest inspection only. No product edits, dependencies, gates, transfers, builds/tests, networking, credential operations or new research lanes. Parent checked decisive source anchors. All new package placements are proposals. The corrected Part A was written before reopening the newly rewritten HTML; earlier hub artifacts are superseded and retained only as process evidence.
