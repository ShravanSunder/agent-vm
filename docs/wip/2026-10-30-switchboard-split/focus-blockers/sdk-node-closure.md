# SDK / Node extraction closure at H2dfea38e

Source-only at `2dfea38e8dcdd01fce28d811ed5ec8db45c25023`. Scope is the owner's keep11/rip12 extraction, not future AgentVM design. No tests, builds, network, services or product changes. Parent owns root gates/plans. Prior report's "retained six" terminology does not apply here.

## Checked answer

source: SDK, Node host and Worker production/declaration entry source has no direct import of any rip12 package. However retained Node host and tool-engine tests import ripped MCP Portal, Tool Portal and Gateway Runtime source. Their package typechecks include tests, so production-only import closure does not close declared package validation. (`packages/tool-host-node/tsconfig.json:1`; `packages/tool-host-node/tsconfig.build.json:10`; `packages/tool-engine/src/capability-dispatch/capability-dispatcher.unit.test.ts:19-20`; complete import ledger below)

source: Worker legacy oracle is materially different: its alias explicitly pins the released npm MCP Portal 0.0.153, validates installed manifests/lock integrity, rejects workspace fallback and resolves its config-contracts dependency from the installed legacy package. This is an external released test oracle, not retention of the ripped workspace MCP Portal source. (`packages/tool-host-cloudflare/package.json:51`; `packages/tool-host-cloudflare/src/test-fixtures/legacy-proxy-artifact.ts:26-50,86-104`)

## SDK: source/declaration closure versus retained AgentVM-specific surfaces

| Surface | Exact retained wiring | Closure finding |
|---|---|---|
| `gateway-runtime-client` | Public package export `package.json:56-58`; tsdown entry `tsdown.config.ts:15`; client imports local approval/artifact/contracts/Portal call/sandbox/transport modules `src/gateway-runtime-client/index.ts:1-60`. | source: No import of ripped gateway-runtime package. Client contains managed attachment handshake, sandbox/approval/artifact APIs and default managed UDS path `index.ts:62-63,372-400,403-424,545-568`. Keeping this SDK subpath does not restore its deleted server. |
| `gateway-runtime-local-exec` | Public export `package.json:60-62`; tsdown builds API plus helper `tsdown.config.ts:16-17`. Transport imports local protocol and Node APIs `src/gateway-runtime-local-exec/gateway-runtime-local-exec-transport.ts:1-13`; default helper is package-local generated JS `:171-182`. | source: No ripped-package dependency; helper is an actual build asset, not an import of gateway-runtime. If this API is removed in the bounded extraction, its export, both build entries, helper asset and tests must move together. This report does not decide whether API removal is required. |
| Tool VM relay | Root exports `connectToolPortal` at `src/index.ts:11`; it dynamically imports local transport and MCP client `src/tool-vm-relay/connect-tool-portal.ts:4-18`; CLI imports local relay `src/cli/tool-portal-cli-operation.ts:25`. | source: No ripped source import, but managed runtime assumption is explicit. Local transport reads `AGENT_VM_TOOL_PORTAL_SOCKET` and errors when absent `src/tool-vm-relay/local-transport.ts:66-72`. This is SDK-local runtime code with a formerly external server, not standalone Node-host selection. |
| contracts / fixtures | SDK root exports managed contracts `src/index.ts:7`; `src/contracts/trusted-context-contracts.ts:27-31` restricts framework/client kinds to Hermes literals. Portable fixtures include managed attachment, projection and trusted invocation examples; manifest contains their emitted schema. | source: These are real retained managed protocol declarations/fixtures, but literal names/paths are not imports of deleted packages. Source closure alone will not remove them. Exact removal scope belongs to parent, not a new architecture proposal. |
| declarations/build | SDK `tsconfig.json` includes `src/**/*.ts`; build excludes only `src/**/*.test.ts`; tsdown explicitly lists all public subpaths and local-exec helper. Manifest dependencies are retained tool-access and oauth-broker-contracts plus third-party libraries. | source: No ripped-package declaration dependency found. Export removal cannot be inferred from folder names; current public/build configuration deliberately includes these surfaces. (`packages/agent-portal-sdk/tsconfig.json`; `tsconfig.build.json`; `tsdown.config.ts:5-23`; `package.json` exports/dependencies) |

All SDK paths in that table are under `packages/agent-portal-sdk/` at the pin.

## Exact blockers in retained tests / fixtures

source: Node host has four MCP proxy integration files comparing against ripped MCP Portal: proxy-large-request, proxy-result-parity, public-name-failure-parity, upstream-response-limit. These import old core/server/auth helpers directly using workspace package names. This differs from Worker's pinned external alias. (`packages/tool-host-node/src/mcp-proxy-server/*` exact import ledger below)

source: Node standalone parity additionally imports old Tool Portal service/listener/approval functions and MCP provider factory; its fingerprint unit test imports the old non-public `tool-portal/policy-comparison` alias. The latter is not a declared Tool Portal package export, so a released-package alias alone is not demonstrated as a valid replacement. (`packages/tool-host-node/src/standalone-tool-portal/standalone-resource-parity.integration.test.ts:12-20`; `standalone-dispatch-identity.unit.test.ts:1`; `packages/tool-portal/package.json:18-42`; `tsconfig.base.json:34`)

source: Node controlled-upstream parity imports ripped MCP Portal's test server subpath; this is a workspace source/testing alias, not proof a released package exports it. (`packages/tool-host-node/src/testing/controlled-upstream-parity.integration.test.ts:2`; `packages/mcp-portal/package.json:20-65`; `tsconfig.base.json:137-139`)

source: tool-engine dispatcher tests import managed profile projection and fixture directly from ripped gateway-runtime, while MCP catalog/helpers/results/token parity tests import ripped MCP Portal. These are further keep11 test-source blockers even though this report focuses SDK/Node/Worker. (`packages/tool-engine/src/capability-dispatch/capability-dispatcher.unit.test.ts:19-20`; full ledger below)

inference: Removing rip12 folders without addressing those tests leaves source-resolution and test validation broken. Existing assertions should retain an independent baseline or equivalent established behavior proof; the source evidence does not authorize dropping parity coverage. This report does not prescribe a new oracle mechanism. (Import ledger; package tsconfig inclusion)

## Node build/declaration and string-only references

source: Node root export exposes host/config/standalone/provider APIs and separate catalog compiler/testing subpaths. tsdown entrypoints are root index, catalog compiler, executable and fake upstream server. Build tsconfig excludes tests and `src/test-fixtures/**`, whereas package typecheck tsconfig includes all source TS. Thus test imports are a package typecheck/test closure blocker, not evidence production declarations import old packages. (`packages/tool-host-node/src/index.ts:1-35`; `package.json` exports; `tsdown.config.ts:6-11`; `tsconfig.json:1`; `tsconfig.build.json:10`)

source: Compiler's old MCP Portal generator header and frozen catalog baseline's same header are string data, not module dependencies. Generated tool source imports retained SDK/generated-tools. Removing these labels is not necessary for module resolution, and rebaselining bytes would change an existing parity fixture. (`packages/tool-host-node/src/catalog-typescript/catalog-typescript-compiler.ts:336-337`; `packages/tool-host-node/src/test-fixtures/catalog-v2-baseline.ts:60`)

## Allowed external released Worker oracle

source: Worker test reference imports `legacy-mcp-portal/core`, `/mcp-proxy` and `/portal-auth/agent-bearer-token`; fixture calls `assertLegacyProxyArtifact` before constructing reference server. (`packages/tool-host-cloudflare/src/test-fixtures/legacy-proxy-reference-test-fixture.ts:8-14,36-44`)

source: Validator enforces npm alias/version, registry lock integrities for MCP Portal and its config-contracts dependency, and that neither resolves under workspace `packages/`. Its lookup is rooted in the legacy entry via `createRequire`, not the retained workspace config-contracts. (`packages/tool-host-cloudflare/src/test-fixtures/legacy-proxy-artifact.ts:26-50,76-103`)

source: Worker build excludes its test-fixtures, but typecheck includes all source TS and therefore needs the external alias installed. Retaining that pinned devDependency and registry lock artifact does not require retaining workspace mcp-portal source. (`packages/tool-host-cloudflare/tsconfig.build.json:10`; `tsconfig.json:9-10`; `package.json:51`)

inference: The existing Worker alias meets the stated allowed external released-oracle distinction in source. Actual installed artifact provenance was not executed/verified in this read-only grant. The comment claiming source identity to older commits was not independently revalidated and is not needed for this closure classification. (`packages/tool-host-cloudflare/src/test-fixtures/legacy-proxy-artifact.ts:86-104`)

## Complete direct rip-package import ledger in keep11

Search includes tests and fixtures. Each line is an exact pinned source import; not all are runtime dependencies.

```text
2dfea38e:packages/tool-engine/src/capability-dispatch/capability-dispatcher.unit.test.ts:19:import { projectManagedAccessProfile } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/access-profile-projection.js';
2dfea38e:packages/tool-engine/src/capability-dispatch/capability-dispatcher.unit.test.ts:20:import { toolPortalConfig } from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-profile-test-fixture.js';
2dfea38e:packages/tool-engine/src/mcp-gateway/agent-catalog-views/catalog-baseline.unit.test.ts:1:import { compileCatalogTypescriptModules } from '@agent-vm/mcp-portal/catalog-typescript';
2dfea38e:packages/tool-engine/src/mcp-gateway/agent-catalog-views/catalog-baseline.unit.test.ts:2:import { generateTypescriptCatalogArtifact } from '@agent-vm/mcp-portal/portal-config';
2dfea38e:packages/tool-engine/src/mcp-gateway/portal-tools/describe-helpers.unit.test.ts:1:import { generateTypescriptCatalogArtifact as legacyArtifact } from '@agent-vm/mcp-portal/portal-config';
2dfea38e:packages/tool-engine/src/mcp-gateway/proxy-results/proxy-mcp-result.unit.test.ts:1:import { createPortalAgentIdentity, createPortalSessionManager } from '@agent-vm/mcp-portal';
2dfea38e:packages/tool-engine/src/mcp-gateway/proxy-results/proxy-mcp-result.unit.test.ts:2:import { createPortalCore, createPortalToolHandlers } from '@agent-vm/mcp-portal/core';
2dfea38e:packages/tool-engine/src/mcp-gateway/proxy-results/proxy-mcp-result.unit.test.ts:3:import { createPortalMcpServer } from '@agent-vm/mcp-portal/mcp-proxy';
2dfea38e:packages/tool-engine/src/mcp-gateway/signed-tokens/token-parity.unit.test.ts:1:import * as legacyBearer from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
2dfea38e:packages/tool-engine/src/mcp-gateway/signed-tokens/token-parity.unit.test.ts:2:import * as legacyApproval from '@agent-vm/mcp-portal/portal-auth/hmac-token';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/proxy-large-request.integration.test.ts:3:import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/proxy-large-request.integration.test.ts:4:import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/proxy-large-request.integration.test.ts:5:import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/proxy-result-parity.integration.test.ts:4:import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/proxy-result-parity.integration.test.ts:5:import { createPortalHttpApp, createPortalApprovalVerifier } from '@agent-vm/mcp-portal/mcp-proxy';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/proxy-result-parity.integration.test.ts:6:import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/proxy-result-parity.integration.test.ts:7:import { hashCallArguments, signApprovalToken } from '@agent-vm/mcp-portal/portal-auth/hmac-token';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/public-name-failure-parity.integration.test.ts:5:import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/public-name-failure-parity.integration.test.ts:6:import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/public-name-failure-parity.integration.test.ts:7:import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/upstream-response-limit.integration.test.ts:3:import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/upstream-response-limit.integration.test.ts:4:import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
2dfea38e:packages/tool-host-node/src/mcp-proxy-server/upstream-response-limit.integration.test.ts:5:import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
2dfea38e:packages/tool-host-node/src/standalone-tool-portal/standalone-artifact-mime.integration.test.ts:5:import { startStandaloneToolPortalMcpHttpServer as startOldMcp } from '@agent-vm/tool-portal';
2dfea38e:packages/tool-host-node/src/standalone-tool-portal/standalone-batch-approval.unit.test.ts:4:import { createStandaloneToolPortalApprovalToken as createOldApprovalToken } from '@agent-vm/tool-portal';
2dfea38e:packages/tool-host-node/src/standalone-tool-portal/standalone-dispatch-identity.unit.test.ts:1:import { directDispatchFingerprint as originalFingerprint } from '@agent-vm/tool-portal/policy-comparison';
2dfea38e:packages/tool-host-node/src/standalone-tool-portal/standalone-resource-parity.integration.test.ts:12:import { createManagedMcpProviderBackendFactoryFromConfig } from '@agent-vm/mcp-portal/mcp-provider-backend';
2dfea38e:packages/tool-host-node/src/standalone-tool-portal/standalone-resource-parity.integration.test.ts:20:} from '@agent-vm/tool-portal';
2dfea38e:packages/tool-host-node/src/testing/controlled-upstream-parity.integration.test.ts:2:import { startFakeUpstreamMcpServer as startOldOnlyServer } from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
```

gaps: No builds/typechecks/tests ran; source reachability only. Parent owns root tsconfig aliases, export audits, taxonomy and package closure gates.

gaps: No SDK public-surface deletion decision was made here; gateway-specific clients/relay are self-contained code with managed-runtime assumptions, not rip12 module imports. Parent's bounded extraction scope must distinguish module closure from explicit API/surface removal.

gaps: Installed released Worker oracle provenance is enforced by source but unobserved now; settled by existing artifact assertion/test lane after extraction under execution authority.
