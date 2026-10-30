# Part B — rewritten provider-model HTML

This replaces the old hub-page advice. Target: `new-structure.html` as captured 2026-10-30T18:08:52Z, SHA256 `10cc518c71b63d4b315a7a528d254f67ec6f9cee2b8f47e57fe470b6bb406333`, saved as `lead-owner-corrected-page.html`. Corrected Part A was saved before reopening this revision (SHA256 `fbf4bc92be5006a3e6d72b254409b2b49e18daad00f18e813496d13cb2b60477`). Current source remains H `2dfea38e`. No HTML edit, visual/run proof or Reviewer acceptance is claimed.

## What now matches the owner

The main tool/message paths now go from harness directly to Switchboard/Fleet; Agent VM is a registered computer Tool Portal and local direct provider. The mandatory controller relay is gone. The page correctly preserves the full computer capability intent, separates the later messaging-through-MCP path, recognizes current local-provider assumptions, and now says the OAuth catalog is already Drizzle-backed.

## Remaining corrections / advice

### C1. Put bot-to-workspace registration in the workspace/Fleet domain

The top Mermaid source still says `harness -->|"bot registers to a workspace"| signin`. That contradicts the distinction the owner just made. Signing in/registering an OAuth client and linking a token resource is not bot membership in a workspace. H itself separates signature proof/resource issuance from the relying service's membership read: `H:packages/tool-access/src/contracts/agent-proof.ts:55-61`; `H:packages/tool-host-core/src/caller-admission/caller-check.ts:28-38`.

Recommendation: show bot→workspace registration against Fleet/workspace authority; show Sign-in as issuer/authentication separately when needed. Do not present a provider token/resource link as granting workspace membership. This was returned immediately to the Lead in push `01a18e01-0720-78f2-bd3a-708025109b6e`.

### C2. Draw the identity-contract artifact imports; Rust is not a runtime-only rule

The repository paragraph still says other systems reach codex-router “only at runtime” because it is Rust. The intended Fleet-owned identity contract is a build/code artifact consumed by Switchboard and Sign-in; it need not import or start the Router service. The existing Router DTO schema export is a concrete source pattern (`R:crates/collaboration-protocol/examples/export_protocol_types.rs:1-6`). The new shared identity artifact is proposed, not already implemented by that example.

Recommendation: distinguish imports of Fleet-owned contracts from calls to Fleet central, and keep the strict repo DAG explicit. Tool-specific canonical resource URL logic can remain a small pure Switchboard contract imported by Sign-in; Switchboard calls Sign-in through a runtime port, so no code cycle is required. H current location is `tool-access/contracts`, not Sign-in (`H:packages/tool-access/src/contracts/index.ts:10-20`).

### C3. Computer registration is independent of workspace bindings

Q3's lean “the workspace it serves” risks deciding one workspace per computer. The owner named computer provider registration and bot workspace registration separately. Source old Agent VM has zones/agent workspace roots; it has no established equivalence to a Fleet workspace. A computer provider's identity, endpoint, capabilities and permitted workspace/agent bindings are different records/facts.

Recommendation: register the computer service, then describe the authorized bindings it can serve without assuming singular membership. This does not commission a new multi-tenant system; it avoids baking an unagreed 1:1 relationship into the public contract.

### C4. Local direct admission is a boundary decision, not automatically a second policy owner

Q2 offers fetched central policy or controller-owned policy. The source facts are more precise: central tool allowances and provider-local resource constraints have different owners; shared rule code need not imply duplicated authoritative policy data. Current raw sandbox methods also have a separate dispatcher path from `portal.*` (`H:packages/gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.ts:210-242`), with direct shell shapes (`H:packages/agent-portal-sdk/src/contracts/sandbox-execution-contracts.ts:17-31`). Today's trusted Hermes attachment cannot be copied as admission for arbitrary local clients.

Recommendation: specify local caller registration/admission, target ownership and which capabilities it permits. A central-policy projection needs stated freshness/revocation/offline semantics; a local provider restriction is not inherently a competing owner of the central workspace policy. Reuse the same Tool Portal engine and authority ports. Avoid making the direct-local option secretly require every call to traverse Switchboard unless the owner chooses that requirement.

### C5. Preserve original caller identity at the computer-provider boundary

In the corrected model Switchboard calls Agent VM as an upstream MCP provider. The provider connection identity proves Switchboard, not automatically the original bot/workspace. Per-agent VM roots, leases, credentialed runs and artifacts must still be bound to the authorized original caller. A public model argument naming an agent is not equivalent to that binding; neither is a signed token for the wrong audience.

Recommendation: the computer MCP contract must say how Switchboard supplies authenticated/bound caller context and how direct local clients are admitted. Keep service identity, bot/workspace identity and operation/resource authority separate. H has workspace-audience agent proof (`H:packages/tool-access/src/contracts/agent-proof.ts:26-61,90-125`) and an old Gateway-specific caller context (`H:packages/gateway-control-contracts/src/index.ts:158-242`); neither is a complete new computer MCP admission contract. This is a missing structural contract, not a request for a new authentication product.

### C6. Public SDK ownership differs from server/executor ownership

The table still sends socket client/local exec/relay wholesale to Agent VM. I agree on moving actual SSH/VM/process/file/artifact execution to controller ownership. Public typed computer/tool clients, shared relay protocol and portable Node/Python transport entrypoints should remain the Switchboard SDK family, so any harness can use one maintained interface. An obsolete Gateway cohort handshake should be retired/replaced, not moved as if it were a generic permanent controller client.

Physical guest helper distribution can remain VM-specific; a trusted framework adapter can live near that framework; shared request/result schemas have one protocol owner. Current SDK is already substantive client code (`H:packages/agent-portal-sdk/src/tool-portal-mcp-client/index.ts:135-210`). Python's public client explicitly supports Tool VM code as well as the Gateway/harness side (`H:python/agent-vm-agent-portal-sdk/src/agent_vm_agent_portal_sdk/__init__.py:16-21`). This is advisory placement, not a source error about where the current code connects.

### C7. “All Tool Portal features over MCP” needs a complete operation mapping

Preserve the owner's full feature intent: discovery/schema/helper generation, environments, commands, processes/streams/terminals, filesystem/workspace operations, configured CLI/credentialed runs, artifacts, approvals and invocation relay. Existing Node standalone MCP serving exposes Portal wrappers/resources; raw sandbox methods currently use a different private dispatch (`H:packages/gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.ts:210-242`). A generic MCP listener existing in the copy is not evidence that every old raw capability is already mapped and implemented in the controller.

Recommendation: use MCP plus shared capability/result schemas as the public boundary and inventory each feature's actual server/executor/lifetime owner. Keep private lease, local PID/path and SSH material internal. Do not resurrect the old Socket.IO domain or the unused execution WebSocket merely because their code exists. Source production upgrade accepts only current control path (`H:packages/gateway-runtime/src/control-endpoint/gateway-control-endpoint.ts:133-145`).

## Current Q1–Q6: second view of the leans

| Question | My view | Qualification / gain and cost |
|---|---|---|
| Q1 private computer reachability | Reuse a real admitted private MCP route; Tunnel/Access or outbound routing are concrete deployment options | Registration is not reachability or caller authorization. No blanket assertion that all private machines require a new custom reverse RPC session; no platform/runtime integration was tested here |
| Q2 local direct policy | Shared Portal logic, separately named central allowance and local resource/admission facts | Central policy projection gives consistent central rules but has freshness/offline cost. A local provider rule can govern local resources without becoming another writer of global workspace policy |
| Q3 registration | Computer provider identity/capabilities/route, plus explicit authorized bindings | Do not conflate issuer resource registration, bot membership and computer service registration; do not infer one workspace per computer |
| Q4 messaging via Switchboard later | Agree to defer; it can provide an MCP way into Fleet for clients that need it | Fleet remains the message/relationship owner. Do not add a new audit/control project just to justify an optional later route |
| Q5 per-user CLI placement | Computer credentialed sandbox is one credible implementation | Central provider API/MCP avoids computer delivery; local credential adapter changes custody/availability. Short-lived token transfer is a proposed credential architecture, not already decided by “Switchboard owns tool control” |
| Q6 cloud backend later | Agree to defer implementation | Keep new public computer contracts free of local PID/path/FD assumptions now. Existing provider/controller durable records need redesign for a selected cloud backend; swapping only factory is insufficient |

## Factual precision on package rows

- The 17/6 declared dependency cut and eleven duplicated packages hold at H/M. Within the copy, old Tool Portal is a source-import leaf, and old MCP Portal has its old Tool Portal type consumer. Image distribution and old manifests remain separately relevant; package graph isolation is not safe deletion proof.
- Broker catalog is already typed Drizzle/better-sqlite3 (`H:packages/oauth-broker/src/oauth-credential-catalog.ts:1-64`); the rewritten page corrects that. Portability means separating domain and concrete host adapters, not an automatic ORM migration.
- `control-protocol-contracts` does not own data credit frames. Those are in `controller-execution-contracts/src/controller-execution-data-boundary/index.ts:36-60`; the former owns envelope/receipt/sequence/queue policy.
- “Implemented and tested” for the unused execution WS is supported here only as implementation plus test source; no tests were run by this investigation. No current production constructor caller was found.
- Current raw D1 Sign-in adapters are not evidence that the standing Drizzle/runtime-injection requirement is already satisfied (`H:packages/auth/src/d1-persistence/person-admission-store.ts:20-53`). Preserve provider-owned session/client data semantics when designing typed adapters; this report adds no migration.
- Keep checks for code that moves: root distinguishes Python SDK host checks from Hermes-specific checks (`H:package.json:18-26`). The presence of obsolete Gateway VM hosting does not justify deleting tests for retained shared client behavior. No new gate/removal is authorized.

## Result

The rewritten direct-harness / registered-provider topology now matches the owner's central correction. C1/C2/C3 remain concrete map corrections in this captured revision. The important design differences are public SDK ownership, local direct admission, original caller context at the computer MCP boundary, feature mapping and credential placement. No source/runtime proof is implied for the target system, and no governing design or package disposition is adopted by this handback.
