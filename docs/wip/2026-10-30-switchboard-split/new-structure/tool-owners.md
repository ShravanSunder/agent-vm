# Implemented Tool Portal owners at 2dfea38e

Source-only investigation at `2dfea38e8dcdd01fce28d811ed5ec8db45c25023`. Worktree HEAD was `de2e51155e7376cb8298395a1410b336e6cdb30f`; all evidence uses `git show`/`git grep` at the requested pin. No tests, builds, network, services, product edits or runtime observations. Researcher Worker contributes to parent trace. Prior communications-map reports were discovery material only; this report's claims use reopened pinned source. Closest ground-truth scenario: the plugin that was never wired; package presence and exported APIs are separated from actual callers.

## Checked answer

source: The six new tool/SDK libraries (`tool-access`, `tool-engine`, `tool-host-core`, `tool-host-node`, `tool-host-cloudflare`, `agent-portal-sdk`) do not import `@agent-vm/tool-portal` or `@agent-vm/mcp-portal` in production source. Those six new tool/SDK library manifests likewise have no production dependency on either old package. This is distinct from the commissioned six retained VM packages (agent-vm, gateway-runtime, gateway-lifecycle, hermes-gateway, managed-vm and gondolin-vm-adapter): old VM package manifests still declare Portal dependencies even though the parent checked their actual production source imports are absent. The parent owns that separate manifest/source qualification. Cloudflare's devDependency `legacy-mcp-portal` is a registry alias, not a production dependency. (`packages/*/package.json`; exhaustive production import inventory below)

source: Old packages are downstream of the new ones: both depend on `tool-access`, `tool-host-node` and `agent-portal-sdk`; old Tool Portal additionally consumes old MCP Portal's provider-backend types. (`packages/tool-portal/package.json:54-64`; `packages/mcp-portal/package.json:77-94`; `packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:3-17`)

source: The stronger claim "old packages are entirely unconsumed leaves" is false for MCP Portal: agent-vm still resolves and installs it into managed Tool VM images, and local deployment sync still packs and links its executable. Tool Portal has no cross-package production import caller at this pin; it remains a published/exported API and sync input. (`packages/agent-vm/src/build/managed-image-dockerfile.ts:26,207-208,279-297`; `scripts/sync-local-tarballs-to-deployment.ts:26-51,396`; `packages/tool-portal/package.json:18-42`)

inference: "Not imported by six new tool/SDK libraries" is a checked graph fact, not proof of safe package deletion. Old CLI behavior, generated manuals, image distribution, public exports, tests and external consumers need a disposition before removing their packages. This report does not choose that disposition. (`packages/mcp-portal/package.json:20-65`; `packages/agent-vm/src/cli/manual-templates.ts:314-362`; consumer inventory below)

## Evidence table: overlap and distinct implemented responsibility

| Package | Source-backed implemented responsibility | Overlap and unique residual behavior / deletion caution |
|---|---|---|
| tool-access | Zod contracts and effect-free access assessment; CLI selectors/path policies, Google command/account policies, profile resolution; provider configuration and secret-reference schemas; agent/person proof verification. Public entrypoints `contracts`, `authorization`. | SDK now reexports many portable schemas from here rather than owning duplicate definitions. Access assessor is shared by managed adapter, Node standalone and engine. It is not a host/runtime, dispatcher, secret resolver or approval ledger. Anchors: `src/contracts/index.ts:1-20`; `src/authorization/index.ts:1-8`; `src/authorization/access-assessor.ts:92-109,490-536`; SDK `src/portal-call-surface/models/portal-call-request-schema.ts:1-6`. |
| tool-engine | Runtime-portable capability dispatcher with injected assessment, operation, approval and backend ports; standalone Portal wire-result aggregation and discovery merging; MCP gateway/catalog/search/schema validation/token helpers; scoped upstream MCP client runtime. Public entrypoints `capability-dispatch`, `standalone-tool-portal`, `mcp-gateway`, `upstream-mcp-connectors`. | It contains both canonical Portal and MCP proxy machinery. It does not own durable host storage or managed controller ledger. Dispatcher produces pending/denied/ambiguous/completed results and calls backend only after assessment/operation/approval fences. Anchors: `src/capability-dispatch/capability-dispatcher.ts:61-216`; `src/standalone-tool-portal/standalone-tool-portal-core.ts:30-153`; `src/mcp-gateway/index.ts:1-138`; `src/upstream-mcp-connectors/upstream-mcp-client-runtime.ts:48-55,222-317`. |
| tool-host-core | Hosted workspace MCP resource server: caller admission, configuration/catalog caching, request limits, analytics, workspace engine, membership/agent removal/approval replay authority through injected storage. Root export only. | Distinct hosted composition, not generic schema package. Workspace catalog may be cached across requests; upstream clients are request-owned and closed after response stream EOF/error/cancel. Hosted authority provides storage operations rather than owning Cloudflare storage itself. Anchors: `src/index.ts:1-42`; `src/hosted-mcp-proxy/hosted-mcp-proxy.ts:47-183,198-236`; `src/workspace-engines/workspace-engine.ts:151-218`. |
| tool-host-node | JSONC/config/schema artifact loading, host secret and process logging edges, stdio upstreams, Node HTTP/MCP/stdio serving, bearer admission, process-local approval operation store, standalone Portal service/provider adapters, catalog TypeScript compiler. Bin `tool-host-node`. | Both new Node MCP host composition and exported standalone Tool Portal listener assembly exist. Standalone Portal assembly is not the `tool-host-node` bin's startup path: bin calls startNodeHost, which selects new MCP HTTP or stdio based on NodeHostConfig. Compiler still emits an old MCP Portal generator comment; that string is not an old-package import. Anchors: `src/index.ts:1-35`; `src/bin/tool-host-node.ts:10-54`; `src/node-host-startup.ts:25-92`; `src/node-host-composition.ts:68-98,126-150,225-294`; `src/standalone-tool-portal/standalone-service-adapter.ts:19-76`; `src/catalog-typescript/catalog-typescript-compiler.ts:336-337`. |
| tool-host-cloudflare | Worker fetch root and DurableObject adapters, Worker transport policy, Analytics Engine sink, deployment binding/config readers; calls hosted core. | No cross-package production import consumer found: deployable entrypoint is default Worker `fetch`. DurableObject owns persistence boundary for memberships/removal/replay via core algorithm; it does not run tool calls or hold credentials. Anchors: `src/index.ts:30-80`; `src/durable-workspace-authority/workspace-authority.ts:7-56`. |
| agent-portal-sdk | Portal-neutral contracts plus client implementations: root connectToolPortal, canonical MCP client, generated tool functions, private managed Gateway Runtime UDS client and sandbox/approval/artifact operations, Tool VM relay/local execution, CLI `tool-portal`. | Not merely schemas. Portable schema facade now reexports tool-access, but managed contracts/client/relay/CLI remain actual code; generated catalog TS references this package. It has extensive controller/gateway consumers even where imports are schema-only. Anchors: `src/index.ts:1-11`; `src/tool-vm-relay/connect-tool-portal.ts:4-18`; `src/tool-portal-mcp-client/index.ts:135-210`; `src/gateway-runtime-client/index.ts:372-400,490-569`; `package.json` export map/bin. |
| old tool-portal | Original managed cross-backend service, managed dispatch-authority/contracts, MCP provider bridge and standalone v1 service/listener APIs, CLI allowance facade. | Duplicate behavioral surface remains, not a thin alias to new managed adapter. Original managed service dispatches three backend kinds and directly reserves/arms controller approval; current production managed composition imports its replacement in gateway-runtime, not this package. It still publicly exports standalone APIs. Anchors: `src/index.ts:1-5`; `src/tool-portal-service.ts:584-639,793-863`; `src/standalone-tool-portal-service.ts:68-110`; `src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:80-96,153-190`; `package.json:18-42`. |
| old mcp-portal | Executable standalone MCP Portal product and public core/proxy/provider/catalog/auth APIs; old MCP SDK v1 runtime/core/server code remains. CLI has call, generate-helper, print-client-config, serve, validate. | Overlap with new engine/node includes scoped runtime, MCP catalog/session/core, signed bearer/HMAC helpers, compiler and serving, but old command/parser/config operating surface is not just an alias. Old CLI additionally composes 1Password secret-management resolution; new Node bin explicitly accepts environment secrets only unless embedding injects a resolver. No production invocation of old CLI was observed; its executable and image installation are source-wired. Anchors: `src/bin/mcp-portal-command-dispatcher.ts:406-454`; `src/cli/portal-server-operation.ts:17-38,187-205`; `src/core/portal-core.ts:1-40`; Node `src/bin/tool-host-node.ts:18-28`; `package.json:20-65`. |

All table source paths are under `packages/<package>/` at the pin.

## Representative source paths (edge kind explicitly named)

source: Managed Portal entry is Gateway Runtime production service -> managed composition -> **local** `managed-tool-engine/managed-portal-facade` -> managed dispatch adapter -> portable capability dispatcher -> resource backend port. Production service constructs three backend ports and composition; composition owns artifactStore/current-authority registry and catalog source cache, and calls the local facade. It does not call old tool-portal. (`packages/gateway-runtime/src/production/gateway-runtime-production-service.ts:546-552,607-650`; `packages/gateway-runtime/src/managed-tool-portal-composition.ts:85-152`; `packages/gateway-runtime/src/managed-tool-engine/managed-portal-facade.ts:29-45`; `packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-adapter.ts:537-588`)

source: For a managed MCP call, managed provider factory constructs `createNodeProviderRuntime`, catalog-view cache and `createStandaloneMcpProviderBackend`, then its adapter returns canonical Portal results. This shows retained host-node/engine are concrete live managed dependencies. (`packages/gateway-runtime/src/backends/managed-mcp-provider-backend.ts:87-171`)

source: Canonical standalone call: Node service adapter **calls** engine standalone core -> core **awaits** invocation access facts and assesses each original call -> groups approval/direct calls -> **awaits** injected batch preparation -> **awaits** dispatcher for each -> validates/projects results -> returns `PortalCallResult`. The dispatcher calls access assessment, awaits createOrRead, checks matching approval receipts, awaits arm transition, then awaits backend invoke; errors after operation planning become ambiguous. Node adapter re-resolves current invocation and validates exact semantic/call identity before dispatch. (`packages/tool-host-node/src/standalone-tool-portal/standalone-service-adapter.ts:19-76`; `packages/tool-engine/src/standalone-tool-portal/standalone-tool-portal-core.ts:30-153`; `packages/tool-engine/src/capability-dispatch/capability-dispatcher.ts:71-216`)

source: Hosted call: Cloudflare default fetch **awaits** hosted-core handle -> core **awaits** caller admission, then configuration -> MCP handler callback **awaits** workspace engine -> gateway uses request-owned operation entries, approval-token verifier and MCP backend -> backend **awaits external** upstream callTool and returns completed JSON or mapped upstream failure. Core closes the request gateway on streamed-response completion/error/cancel. Exact remote provider response and deployed selection were not observed. (`packages/tool-host-cloudflare/src/index.ts:31-76`; `packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-proxy.ts:65-183,198-236`; `packages/tool-host-core/src/workspace-engines/workspace-engine.ts:151-218`)

source: Concrete failure case predicted from source: dispatcher receives a fixed access assessment blocked by policy -> returns denied at lines 88-89 -> never creates operation or calls backend. An armed existing record returns ambiguous at lines 147-148; a completed existing record returns stored result at lines 145-146. These are source predictions, not runtime proof. (`packages/tool-engine/src/capability-dispatch/capability-dispatcher.ts:75-89,125-149`)

source: Node operation storage is process-local despite accepting a directory. `openNodeOperationStore` creates a Map; its explicit comment says approval entries last only this host process and unprotected calls are not recorded. A storage move cannot assume existing on-disk durability. (`packages/tool-host-node/src/operation-records/node-operation-store.ts:46-63`)

## Concrete deletion blockers and limits

source: Old MCP Portal image distribution is still real source wiring: non-overlay Tool VM generation resolves the installed package spec and emits a global pnpm install; local sync has its package in overlay/global package sets and symlinks mcp-portal. (`packages/agent-vm/src/build/managed-image-dockerfile.ts:207-208,279-297,327-331`; `scripts/sync-local-tarballs-to-deployment.ts:26-51,396`)

source: Public export/bin contracts exist for both old packages; repository export-check/audit scripts still enumerate them. Removing package directories alone leaves those declarations/gates and manifests stale. (`packages/tool-portal/package.json`; `packages/mcp-portal/package.json`; `scripts/verify-portal-package-exports.ts:42-56,298-347,375-388`; `scripts/audit-portal-architecture.ts:51-52,283-286`)

source: Generated end-user manuals still prescribe separate standalone MCP Portal serve/catalog-mode and distinguish managed/standalone surfaces. (`packages/agent-vm/src/cli/manual-templates.ts:314-362`)

inference: Broad behavior overlap is established, but equivalent public API/CLI semantics are not: new host-node bin takes one NodeHostConfig path and its own listener selection; old CLI has subcommands, config-pair loading and credential-printing/1Password composition. Deleting old standalone executable without explicit replacement/retirement changes a public operating surface even though six new tool/SDK libraries never import it. (`packages/tool-host-node/src/bin/tool-host-node.ts:10-31`; `packages/tool-host-node/src/node-host-startup.ts:25-72`; `packages/mcp-portal/src/bin/mcp-portal-command-dispatcher.ts:158-215,406-454`)

## Consumer package summary

source: `tool-access` has production source consumers in agent-portal-sdk, agent-vm, auth, config-contracts, gateway-control-contracts, gateway-runtime, mcp-portal, oauth-broker, tool-engine, tool-host-cloudflare, tool-host-core, tool-host-node and tool-portal; `tool-engine` in agent-vm, gateway-runtime, tool-host-cloudflare, tool-host-core and tool-host-node; `tool-host-core` in tool-host-cloudflare; `tool-host-node` in agent-vm, config-contracts, gateway-runtime, mcp-portal and tool-portal; `agent-portal-sdk` in agent-vm, controller-execution-contracts, gateway-control-contracts, gateway-runtime, mcp-portal, tool-host-node and tool-portal. Old tool-portal has none; old mcp-portal has only old tool-portal's type import plus the separate image/distribution consumers above; tool-host-cloudflare has no cross-package production source import caller and exposes its Worker fetch entry. (Full pinned file/line inventory below)

## All cross-package production source consumers

The following inventory records import/export/dynamic-import specifiers in tracked `packages/**/src/**/*.{ts,tsx,js,mjs}` at the pin. Excludes unit/integration/e2e test/spec files, `/testing/`, `/test-fixtures/`, `/deployed-checks/`, integration-test support directories, `*-test-fixture.ts`, docs, manifests and known generated-code/example string content (managed-image-tool-portal-guide). Entries are source dependencies, including type-only contracts and reexports; this does not assert every exported API is externally invoked. Self-package aliases are excluded. Runtime image/bin consumers and build/distribution references are listed separately above.

### tool-portal (@agent-vm/tool-portal)

source: No cross-package production source import/export consumers found under the stated search.

### mcp-portal (@agent-vm/mcp-portal)

- source: `packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:17` -> `@agent-vm/mcp-portal/mcp-provider-backend`

### tool-engine (@agent-collaboration/tool-engine)

- source: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts:6` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/agent-vm/src/operations/mcp-portal-live-validation.ts:8` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/agent-vm/src/operations/mcp-portal-live-validation.ts:9` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/gateway-runtime/src/backends/managed-mcp-provider-backend.ts:13` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-access-request.ts:6` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-invocation-authority.ts:4` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-backend-projection.ts:6` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-catalog-preparation.ts:4` -> `@agent-collaboration/tool-engine/standalone-tool-portal`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-adapter.ts:22` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-portal-facade.ts:6` -> `@agent-collaboration/tool-engine/standalone-tool-portal`
- source: `packages/gateway-runtime/src/managed-tool-engine/models/managed-tool-engine-adapter.ts:10` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-cloudflare/src/durable-workspace-authority/workspace-authority.ts:1` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-cloudflare/src/worker-upstream-transports.ts:1` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-core/src/call-analytics/batch-call-analytics.ts:1` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-proxy.ts:9` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-server.ts:7` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/hosted-mcp-proxy/models/hosted-mcp-proxy-ports.ts:2` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/hosted-mcp-proxy/models/hosted-mcp-proxy-ports.ts:3` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-core/src/request-limits/hosted-call-limits.ts:31` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/request-limits/models/hosted-request-limits.ts:4` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-core/src/request-limits/models/hosted-request-limits.ts:5` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/workspace-authority/models/workspace-authority-state.ts:1` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/workspace-authority/workspace-authority.ts:1` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/workspace-engines/models/workspace-engine.ts:4` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-core/src/workspace-engines/models/workspace-engine.ts:9` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/workspace-engines/proxy-profile-policy.ts:8` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/workspace-engines/request-operation-entries.ts:4` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-core/src/workspace-engines/workspace-engine.ts:16` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-core/src/workspace-engines/workspace-engine.ts:23` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-core/src/workspace-engines/workspace-engine.ts:28` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-node/src/catalog-typescript/catalog-typescript-compiler.ts:4` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-node/src/catalog-typescript/catalog-typescript-compiler.ts:5` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-node/src/mcp-proxy-server/direct-operation-item.ts:1` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-node/src/mcp-proxy-server/node-http-server.ts:5` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-node/src/mcp-proxy-server/node-mcp-server.ts:8` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-node/src/node-host-composition.ts:12` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-node/src/node-host-composition.ts:21` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-node/src/node-host-composition.ts:25` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-node/src/node-host-startup.ts:3` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-node/src/operation-records/node-operation-store.ts:10` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-node/src/standalone-tool-portal/models/standalone-portal-contracts.ts:13` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-node/src/standalone-tool-portal/models/standalone-portal-contracts.ts:17` -> `@agent-collaboration/tool-engine/standalone-tool-portal`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-batch-dispatch.ts:8` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-batch-dispatch.ts:15` -> `@agent-collaboration/tool-engine/standalone-tool-portal`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-mcp-provider.ts:21` -> `@agent-collaboration/tool-engine/mcp-gateway`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-mcp-provider.ts:25` -> `@agent-collaboration/tool-engine/standalone-tool-portal`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-mcp-provider.ts:26` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-service-adapter.ts:8` -> `@agent-collaboration/tool-engine/capability-dispatch`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-service-adapter.ts:9` -> `@agent-collaboration/tool-engine/standalone-tool-portal`
- source: `packages/tool-host-node/src/stdio-upstream-servers/node-provider-runtime.ts:6` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-node/src/stdio-upstream-servers/node-upstream-transports.ts:4` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-node/src/stdio-upstream-servers/stdio-upstream-protocol.ts:4` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`
- source: `packages/tool-host-node/src/stdio-upstream-servers/stdio-upstream-runtime.ts:5` -> `@agent-collaboration/tool-engine/upstream-mcp-connectors`

### tool-access (@agent-collaboration/tool-access)

- source: `packages/agent-portal-sdk/src/artifact-surface/models/artifact-reference-schema.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/artifact-surface/models/artifact-reference-schema.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/artifact-surface/models/portal-artifact-contract-schema.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/artifact-surface/models/portal-artifact-contract-schema.ts:12` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/capability-description-surface/models/capability-descriptor-schema.ts:15` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/capability-description-surface/models/capability-descriptor-schema.ts:27` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/contract-primitives/models/capability-reference-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/contract-primitives/models/capability-reference-schema.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/contract-primitives/models/json-value-schema.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/contract-primitives/models/json-value-schema.ts:14` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/contract-primitives/models/namespace-discovery-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/contract-primitives/models/namespace-discovery-schema.ts:9` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/contract-primitives/models/request-id-schema.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portable-contracts/portable-refinement-authoring.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portable-contracts/portable-refinement-authoring.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portable-contracts/portable-refinement-descriptors.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portable-contracts/portable-refinement-descriptors.ts:9` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-batch-id-refinement.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-batch-id-refinement.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-call-request-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-call-request-schema.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-call-result-schema.ts:26` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-call-result-schema.ts:35` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-describe-request-schema.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-describe-request-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-error-schema.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-error-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-list-request-schema.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-list-request-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-search-request-schema.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/models/portal-search-request-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/portal-call-json-schema-exporter.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-call-surface/portal-call-json-schema-exporter.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-event-surface/models/safe-diagnostic-schema.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-portal-sdk/src/portal-event-surface/models/safe-diagnostic-schema.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/cli/init-command.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/control-session/gateway-control-controller-execution-authorization.ts:3` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/controller/control-session/gateway-control-controller-execution-authorization.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/controller-runtime.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/credentialed-runtime/credentialed-managed-vm.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-manager-contracts.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-registry.ts:3` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-registry.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/oauth/controller-oauth-runtime.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/oauth/google-account-policy-editor.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/oauth/google-approval-intent-validation.ts:3` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/controller/oauth/google-approval-intent-validation.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts:7` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts:13` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/oauth/managed-google-file-preflight.ts:3` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/controller/oauth/oauth-account-policy-routes.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/runner/configured-cli-host-executor.ts:6` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/controller/runner/configured-cli-host-executor.ts:7` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/controller/runner/configured-cli-managed-vm-executor.ts:7` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/controller/runner/configured-cli-managed-vm-executor.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/gateway/gateway-runtime-portal-admission-material.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts:5` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts:9` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/agent-vm/src/operations/mcp-portal-live-validation.ts:7` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/auth/src/better-auth-provider/agent-client-management.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/auth/src/better-auth-provider/provider-configuration.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/auth/src/better-auth-provider/sign-in-management-binding.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/auth/src/native-owner-cli/owner-cli-login.ts:7` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/auth/src/sign-in-core/agent-clients/workspace-resource.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/auth/src/sign-in-core/models/deployment-configuration.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/auth/src/sign-in-core/response-release/sign-in-response-release.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/config-contracts/src/controller-configured-cli.ts:15` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/config-contracts/src/managed-tool-portal-projections.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/config-contracts/src/namespace-discovery-compiler.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/config-contracts/src/oauth-config.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/config-contracts/src/oauth-tool-portal-config.ts:7` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/config-contracts/src/oauth-tool-portal-config.ts:13` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/config-contracts/src/tool-portal-config.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/config-contracts/src/tool-portal-config.ts:18` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-approval.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-portal-admission.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-portal-semantic-revision.ts:7` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-control-contracts/src/index.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/backends/configured-cli-tool-vm-executor.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/backends/managed-mcp-provider-backend.ts:7` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/gateway-runtime/src/backends/managed-mcp-provider-backend.ts:12` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/access-profile-projection.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-access-request.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-google-binding.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-google-binding.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-google-preparation.ts:6` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-google-preparation.ts:11` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-backend-projection.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-discovery-policy.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-adapter.ts:4` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-adapter.ts:11` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-identity.ts:3` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/models/managed-portal-ports.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/models/managed-tool-engine-adapter.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/gateway-runtime/src/managed-tool-engine/models/managed-tool-engine-adapter.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/production/gateway-runtime-production-service.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/production/gateway-runtime-service-config.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/mcp-portal/src/bin/mcp-portal-command-dispatcher.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/mcp-portal/src/bin/secret-value-resolver.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/mcp-portal/src/cli/portal-server-operation.ts:4` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/mcp-portal/src/cli/portal-server-operation.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/mcp-portal/src/core/portal-approval-evaluator.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/mcp-portal/src/core/portal-approval-evaluator.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/mcp-portal/src/core/provider-runtime.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/oauth-broker/src/google/google-authorization-commit.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/oauth-broker/src/google/google-authorization-view-models.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/oauth-broker/src/google/google-oauth-broker-contracts.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/oauth-broker/src/google/google-oauth-broker-service.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/oauth-broker/src/google/google-oauth-permission-policy.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/oauth-broker/src/google/google-provider-authorization-callback.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/oauth-broker/src/google/google-runtime-credential-policy.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/capability-dispatch/capability-dispatcher.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/capability-dispatch/dispatch-intent.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/capability-dispatch/models/dispatch-contracts.ts:12` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/capability-dispatch/models/resource-failure-detail.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/agent-catalog-views/agent-catalog-view-cache.ts:6` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-engine/src/mcp-gateway/agent-catalog-views/models/agent-catalog-view.ts:4` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-engine/src/mcp-gateway/agent-catalog-views/models/catalog-types.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/call-approvals/gateway-call-approval.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/index.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/mcp-gateway.ts:5` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-engine/src/mcp-gateway/mcp-gateway.ts:12` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/json-schema-validators.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/models/input-validation-results.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/models/portal-tool-contracts.ts:4` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/models/portal-tool-contracts.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/portal-call-execution.ts:4` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/portal-call-execution.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/portal-call-validation.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/portal-input-schemas.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/portal-tools/portal-tool-selection.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-engine/src/mcp-gateway/proxy-results/proxy-mcp-result.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/signed-tokens/approval-token-signing.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/signed-tokens/approval-token-signing.ts:20` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/tool-search/search-index.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/tool-search/tool-graph.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/mcp-gateway/tool-search/tool-summary.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/standalone-tool-portal/portal-discovery-merger.ts:21` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/standalone-tool-portal/standalone-portal-ports.ts:12` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/standalone-tool-portal/standalone-tool-portal-core.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-engine/src/standalone-tool-portal/standalone-tool-portal-core.ts:9` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/upstream-mcp-connectors/upstream-mcp-protocol.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-engine/src/upstream-mcp-connectors/upstream-response-middleware.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-cloudflare/src/index.ts:3` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/agent-management/workspace-agent-management.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/caller-admission/caller-check.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/caller-admission/models/caller-admission.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-configuration/mcp-configuration.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-configuration/mcp-configuration.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-configuration/models/hosted-configuration.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-configuration/models/hosted-configuration.ts:2` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-configuration/models/hosted-configuration.ts:3` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-configuration/secret-values.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-proxy.ts:4` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-server.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/hosted-mcp-proxy/models/hosted-mcp-proxy-ports.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/index.ts:21` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/index.ts:24` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/workspace-engines/proxy-profile-policy.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-host-core/src/workspace-engines/proxy-profile-policy.ts:7` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-core/src/workspace-engines/workspace-engine.ts:5` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-host-core/src/workspace-engines/workspace-engine.ts:10` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/catalog-typescript/catalog-typescript-compiler.ts:3` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/catalog-typescript/models/catalog-typescript-types.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/catalog-typescript/safe-schema-projection.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/host-configuration/mcp-proxy-config.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/host-configuration/models/mcp-config.ts:10` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/host-configuration/models/node-host-config.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/host-configuration/models/secret-value.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/host-configuration/standalone-portal-config.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/mcp-proxy-server/node-mcp-server.ts:3` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/node-host-composition.ts:5` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-host-node/src/node-host-composition.ts:6` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/models/standalone-portal-contracts.ts:12` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-batch-dispatch.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-dispatch-identity.ts:3` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-http-servers.ts:8` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-mcp-provider.ts:4` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-mcp-provider.ts:15` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-mcp-server.ts:9` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-provider-errors.ts:5` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-service-adapter.ts:3` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-service-adapter.ts:7` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-host-node/src/stdio-upstream-servers/models/stdio-upstream-protocol.ts:1` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-portal/src/cli-allowances/models/cli-allowance-schema.ts:29` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-portal/src/dispatch-authority.ts:3` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-portal/src/tool-portal-service-common.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-portal/src/tool-portal-service-common.ts:10` -> `@agent-collaboration/tool-access/contracts`
- source: `packages/tool-portal/src/tool-portal-service.ts:1` -> `@agent-collaboration/tool-access/authorization`
- source: `packages/tool-portal/src/tool-portal-service.ts:6` -> `@agent-collaboration/tool-access/contracts`

### tool-host-core (@agent-collaboration/tool-host-core)

- source: `packages/tool-host-cloudflare/src/analytics-engine-sink/analytics-engine-sink.ts:1` -> `@agent-collaboration/tool-host-core`
- source: `packages/tool-host-cloudflare/src/durable-workspace-authority/workspace-authority.ts:2` -> `@agent-collaboration/tool-host-core`
- source: `packages/tool-host-cloudflare/src/index.ts:10` -> `@agent-collaboration/tool-host-core`
- source: `packages/tool-host-cloudflare/src/worker-bindings/worker-configuration.ts:5` -> `@agent-collaboration/tool-host-core`
- source: `packages/tool-host-cloudflare/src/worker-bindings/worker-observation-log.ts:1` -> `@agent-collaboration/tool-host-core`
- source: `packages/tool-host-cloudflare/src/worker-limits.ts:1` -> `@agent-collaboration/tool-host-core`

### tool-host-node (@agent-collaboration/tool-host-node)

- source: `packages/agent-vm/src/cli/config-schema-artifacts.ts:4` -> `@agent-collaboration/tool-host-node`
- source: `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts:14` -> `@agent-collaboration/tool-host-node`
- source: `packages/agent-vm/src/operations/config-validation.ts:4` -> `@agent-collaboration/tool-host-node`
- source: `packages/agent-vm/src/operations/mcp-portal-live-validation.ts:14` -> `@agent-collaboration/tool-host-node`
- source: `packages/config-contracts/src/tool-portal-config.ts:23` -> `@agent-collaboration/tool-host-node`
- source: `packages/gateway-runtime/src/backends/managed-mcp-provider-backend.ts:19` -> `@agent-collaboration/tool-host-node`
- source: `packages/gateway-runtime/src/catalog/prepared-catalog-source-cache.ts:8` -> `@agent-collaboration/tool-host-node/catalog-typescript`
- source: `packages/gateway-runtime/src/catalog/prepared-catalog-source-cache.ts:110` -> `@agent-collaboration/tool-host-node/catalog-typescript`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-discovery-policy.ts:2` -> `@agent-collaboration/tool-host-node`
- source: `packages/mcp-portal/src/bin/mcp-portal-command-dispatcher.ts:11` -> `@agent-collaboration/tool-host-node`
- source: `packages/mcp-portal/src/cli/portal-server-operation.ts:16` -> `@agent-collaboration/tool-host-node`
- source: `packages/mcp-portal/src/core/provider-runtime.ts:9` -> `@agent-collaboration/tool-host-node`
- source: `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:9` -> `@agent-collaboration/tool-host-node`
- source: `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts:9` -> `@agent-collaboration/tool-host-node`
- source: `packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:3` -> `@agent-collaboration/tool-host-node`
- source: `packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-entrypoints.ts:1` -> `@agent-collaboration/tool-host-node`
- source: `packages/tool-portal/src/tool-portal-service-common.ts:11` -> `@agent-collaboration/tool-host-node`
- source: `packages/tool-portal/src/tool-portal-service.ts:7` -> `@agent-collaboration/tool-host-node`

### tool-host-cloudflare (@agent-collaboration/tool-host-cloudflare)

source: No cross-package production source import/export consumers found under the stated search.

### agent-portal-sdk (@agent-vm/agent-portal-sdk)

- source: `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts:7` -> `@agent-vm/agent-portal-sdk`
- source: `packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-registry.ts:5` -> `@agent-vm/agent-portal-sdk`
- source: `packages/agent-vm/src/controller/files/native-attachment-controller-access.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/agent-vm/src/controller/runner/configured-cli-managed-vm-executor.ts:9` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/agent-vm/src/controller/runner/controller-execution-registry.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/agent-vm/src/gateway/gateway-runtime-portal-admission-material.ts:2` -> `@agent-vm/agent-portal-sdk`
- source: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts:7` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/agent-vm/src/gateway/managed-framework-agent-projections.ts:1` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/agent-vm/src/gateway/managed-gateway-runtime-input-builders.ts:1` -> `@agent-vm/agent-portal-sdk/gateway-runtime-client`
- source: `packages/controller-execution-contracts/src/controller-dispatch-boundary/models/controller-dispatch-intent-schema.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/controller-execution-contracts/src/controller-dispatch-boundary/models/controller-execution-result-schema.ts:5` -> `@agent-vm/agent-portal-sdk`
- source: `packages/controller-execution-contracts/src/controller-dispatch-boundary/models/execution-fingerprint-schema.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/controller-execution-contracts/src/controller-execution-data-boundary/index.ts:1` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/controller-execution-contracts/src/controller-execution-request-boundary/models/controller-execution-request-schema.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-control-contracts/src/gateway-control-principal.ts:8` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-approval.ts:7` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-control-contracts/src/gateway-runtime-approval.ts:8` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-portal-context.ts:1` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-portal-context.ts:12` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-portal-context.ts:21` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-control-contracts/src/gateway-runtime-portal-semantic-revision.ts:11` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-control-contracts/src/index.ts:11` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-control-contracts/src/index.ts:17` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/artifacts/artifact-read-authority.ts:4` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/artifacts/artifact-store.ts:9` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/artifacts/verified-artifact-reader.ts:8` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/artifacts/workspace-artifact-publisher.ts:3` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/configured-gog-file-discovery.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/controller-execution-backend-port.ts:22` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts:14` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts:15` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/managed-mcp-provider-backend-port.ts:3` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/managed-mcp-provider-backend.ts:30` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/tool-vm-runner-artifact-writer.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/tool-vm-runner-backend-port.ts:20` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/tool-vm-runner-call-results.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/tool-vm-runner-catalog-projection.ts:10` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/backends/tool-vm-runner-configured-catalog.ts:5` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/catalog/prepared-catalog-source-cache.ts:21` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/control-endpoint/gateway-control-caller-context-registration-client.ts:3` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/control-endpoint/gateway-control-command-client.ts:6` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/control-endpoint/gateway-control-operation-active-use-runtime.ts:3` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/control-endpoint/gateway-control-published-binding-runtime.ts:1` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/control-endpoint/gateway-control-replacement-session-use-end-runtime.ts:1` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/gateway-runtime-approval-decision-operations.ts:6` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/gateway-runtime-approval-port.ts:1` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-access-request.ts:7` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-google-binding.ts:3` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-access/managed-google-preparation.ts:12` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-backend-projection.ts:14` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-call-results/managed-call-projection.ts:6` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-call-results/managed-call-results.ts:2` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-catalog-preparation.ts:5` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-discovery-policy.ts:3` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-adapter.ts:27` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-identity.ts:4` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/managed-portal-facade.ts:17` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/models/managed-portal-ports.ts:15` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/models/managed-portal-ports.ts:83` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/managed-tool-engine/models/managed-tool-engine-adapter.ts:11` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/native-attachment-gateway-control-port.ts:7` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.ts:27` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.ts:31` -> `@agent-vm/agent-portal-sdk/gateway-runtime-client`
- source: `packages/gateway-runtime/src/production/gateway-runtime-production-control-runtime.ts:7` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.ts:35` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-filesystem.ts:3` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts:6` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts:7` -> `@agent-vm/agent-portal-sdk/gateway-runtime-client`
- source: `packages/gateway-runtime/src/sandbox/sandbox-binding-authority.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/sandbox/sandbox-environment-runtime.ts:18` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/sandbox/sandbox-operation-authority.ts:1` -> `@agent-vm/agent-portal-sdk/contracts`
- source: `packages/gateway-runtime/src/sandbox/sandbox-process-registry.ts:16` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/sandbox/strict-tool-vm-ssh-portal-relay-output.ts:7` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/sandbox/strict-tool-vm-ssh-process-runtime.ts:24` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/sandbox/strict-tool-vm-ssh-retained-output.ts:10` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/tool-portal-projections.ts:20` -> `@agent-vm/agent-portal-sdk`
- source: `packages/gateway-runtime/src/uds/gateway-runtime-bounded-chunk-sender.ts:10` -> `@agent-vm/agent-portal-sdk/gateway-runtime-client`
- source: `packages/gateway-runtime/src/uds/gateway-runtime-uds-server.ts:13` -> `@agent-vm/agent-portal-sdk/gateway-runtime-client`
- source: `packages/mcp-portal/src/catalog-typescript/catalog-typescript-compiler.ts:7` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/mcp-portal/src/catalog-typescript/catalog-typescript-compiler.ts:335` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/mcp-portal/src/catalog-typescript/catalog-typescript-types.ts:5` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/mcp-portal/src/catalog-typescript/safe-schema-projection.ts:1` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:27` -> `@agent-vm/agent-portal-sdk`
- source: `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-model-errors.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-host-node/src/catalog-typescript/catalog-typescript-compiler.ts:10` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/tool-host-node/src/catalog-typescript/catalog-typescript-compiler.ts:337` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/tool-host-node/src/catalog-typescript/models/catalog-typescript-types.ts:6` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/tool-host-node/src/catalog-typescript/safe-schema-projection.ts:2` -> `@agent-vm/agent-portal-sdk/generated-tools`
- source: `packages/tool-host-node/src/standalone-tool-portal/standalone-mcp-server.ts:10` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/dispatch-authority.ts:4` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/managed-catalog-preparation.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:4` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-http-server.ts:15` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-projection.ts:18` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/standalone-tool-portal-invocation-contracts.ts:1` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/standalone-tool-portal-service.ts:9` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/tool-portal-result-router.ts:27` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/tool-portal-service-common.ts:16` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/tool-portal-service.ts:29` -> `@agent-vm/agent-portal-sdk`
- source: `packages/tool-portal/src/tool-portal-service.ts:234` -> `@agent-vm/agent-portal-sdk`

## Gaps

gaps: External npm/Python deployment consumers are not discoverable from this source-only repository grant; searched pinned tracked package imports/manifests and distribution scripts; settled by deployment inventory or owner retirement/replacement decision.

gaps: Runtime and deployed behavior unobserved; inspected pinned source only; settled by the relevant existing host/VM/Worker proof lanes under a separate execution grant.

gaps: Exact behavioral/API equivalence of every old export to every new export is not claimed; inspected decisive managed, standalone, hosted, SDK and distribution paths; settled by a scoped public API/CLI migration matrix and existing parity/real-path validation.

gaps: No claim that published version 0.0.153 contains these pinned changes; package manifests are source declaration only; settled by packed/published artifact inspection.
