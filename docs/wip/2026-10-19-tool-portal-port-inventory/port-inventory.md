# Tool Portal port inventory (evidence)

Source baseline `8535fdd433dc90fed627ee7a05f63e59d58cf8ee`, 2026-10-19. Returned by the 📚 Researcher Sidekick (codex-local `01a153df`, gpt-6.1-sol, read-only) to the 🦁 Lead, and stored here unchanged as the per-file checklist that [F-50](../../specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md) asks for. The governing structure is [Program Design § The packages and why each exists](../../specs/2026-10-14-portable-tool-portal-hosts/program-design.md#the-packages-and-why-each-exists); where this inventory and that section differ, the section governs.

Read this before using it:
- Every target and port kind is the Researcher's recommendation (`I`), not accepted design. `S` marks scanner evidence; `O` marks code the Researcher opened.
- Rows marked "full function bodies not inspected" give the file's public shape and dependencies only. Read the bodies before implementing or accepting a move.
- "Tests to carry" lists statically linked candidates; none were run.
- The overview's note that Program Design still lists separate `mcp-gateway`, `mcp-connectors` and `tool-control-router` packages was checked and is stale: those names do not appear in the current documents.
- `P#`, `F#`, `E#` and `A#` references expand through the dictionaries in the overview section.

Sections: overview with cross-cutting risks and dictionaries; `tool-portal`; `mcp-portal`; `config-contracts`; `gateway-runtime`; `oauth-approval-ui`.


## Overview, risks and dictionaries

📚 ResearcherHandback — bounded port inventory at 8535fdd433dc90fed627ee7a05f63e59d58cf8ee

Outcome: 117 file rows and 693 unique public declaration-symbol rows, sent in five family tables after this overview. Public symbols are resolved from the current package.json export maps/build entrypoints and static export-star/named-export declarations; overloaded declarations and repeated public routes are folded into one symbol row with all current routes named by E#. The file universe includes .ts/.tsx/.css source, four dedicated test fixtures, published testing helpers and five build configs plus UI fingerprint script; .test/.spec files are candidates in the tests column, not production file rows. No source access failed. No files written, no app/test/build run, no packages installed. Tracked diff remains empty; baseline HEAD unchanged.

Source / inference boundary:
- O: I opened the decisive surrounding bodies for managed Tool Portal dispatch/principal verification/ports, MCP provider adapter, managed composition, pure MCP access filtering, legacy proof evaluator/token/coordinator, configured CLI image codec and execution targets, config-schema artifact IDs, mixed outbound HTTP/SSE/stdio construction, schema-validator construction, tool-reference codec, and the already-inspected consent/policy UI at this same unchanged HEAD.
- S: The full 117-file scope was machine-read for exported declarations, static imports/re-exports and named host/VM dependency tokens; a repository-wide packages/scripts static-import graph supplied consumer/test path:line anchors. Files marked S-only explicitly have full function bodies NOT INSPECTED: the bounded inventory establishes their public/dependency shape, not a line-by-line behavioral review. Their responsibility summaries are inferred from exported API/module role. This meets coverage by giving every file a row, without pretending every implementation was audited.
- I: Every target/port-kind assignment is an inventory recommendation under your confirmed structure, not independent governing design authorship, implementation acceptance or portability proof. move as-is means preserve that piece’s semantics, with imports necessarily updated; it does not mean the entire current package closure is already Worker-safe.
- Existing tests are discovered candidates linked by static imports/barrels, not individually reviewed or executed. Move relevant behavior tests to the resulting owner; rewrite host-specific fixtures as needed. For retired approval APIs, retain meaningful negative cutover/replay/zero-effect coverage against the replacement, rather than porting tests that would perpetuate the old authority.
- Consumers are current checkout static imports/re-export consumers (including test-support modules). This is a lexical graph, not a TypeScript-compiler reference proof; dynamic imports, inline import-type queries, generated code and external published consumers are not exhaustive. Consumer anchors point at the import statement start. Same export name in a barrel may require compiler collision confirmation. An attempted require.resolve('typescript') found no installed root module; I used the read-only lexical walk rather than installing dependencies. Body inspection depth is explicit in every file row.

Target interpretation and source consistency:
- Your newer confirmed five-package structure supersedes Program Design §packages: mcp-gateway, connectors and control/router belong inside tool-portal, not separate npm packages. Opened program-design.md:32 and :174. The document still lists the old separate mcp-gateway/mcp-connectors/tool-control-router topology; update that governing prose separately. This is a known superseded doc, not a new owner decision.
- Concrete MCP/controller/Tool VM backend implementations remain host/managed adapters. tool-portal holds dispatch interfaces and outbound HTTP protocol code, not concrete managed executors. Rows saying stays in agent-vm/execution mean preserve the existing gateway-runtime/configured execution owner outside portable packages; they do not propose physically moving all gateway-runtime code into agent-vm.
- config-contracts may retain its existing host/managed role after schema extraction, as §foundation says. “Retire mixed root” means retire the present mixed schema+host export surface and update consumers; whether the residual host package is folded into tool-host-node or remains as external execution config needs a final package-layout choice. No compatibility re-export is presumed.

Cross-cutting risks and placement limits:
1. source: Existing ToolPortalBackendPort.call is generic only over backend kind; its options still carry GatewayRuntimeToolPortalDispatchAuthorityForBackendKind, and ToolPortalApprovalPort carries managed reservations/intents (packages/tool-portal/src/tool-portal-service.ts:104,182). Managed resolveManagedInvocation verifies active semantic snapshot, configured assignment and derived principal at :331; dispatch enforces exactly one matching operation result and maps exception/mismatch to ambiguous at :611. inference: moving these signatures unchanged would violate the confirmed dependency boundary. Define portable backend/approval/verified-fact contracts and keep this existing managed validation in the external adapter; an opaque proof must not become an unvalidated permission boolean.
2. source: Managed composition already injects three backend factories while owning artifact/current-authority/epoch state (packages/gateway-runtime/src/managed-tool-portal-composition.ts:45,86). Tool VM/backend implementations import SSH, sandbox/process/artifact and Gateway contracts. inference: retain every managed concrete backend/composition row outside Tool Portal; this is precisely where the confirmed execution interface fits. No direct Gondolin import was found in the scoped scan; that says nothing about the downstream provider path.
3. source: Legacy MCP proof is ordered-call HMAC verification plus optional token-id consumption (packages/mcp-portal/src/portal-auth/hmac-token.ts:160; core/portal-approval-evaluator.ts:108). Standalone Tool Portal proof is a different batch fingerprint, service generation, credential version and in-memory reserve/arm tombstone mechanism (packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-approval.ts:286,378). inference: retire their public signer/verifier/coordinator/key trust/admission entrypoints at the NEW PUBLIC cutover; no token, grant, replay or operation-state translation. Keep the managed controller ledger and managed presenter untouched. No existing generic durable approval-rules engine can be moved as-is from these mechanisms.
4. source: hashCallArguments and ApprovalTokenCallDigest remain shared imports in packages/mcp-portal/src/core/portal-tools.ts:11, with argument digests created at :814/:832. inference: extract the shared digest shape/canonical bytes before deleting hmac-token.ts. Removing the whole file with the signer/verifier would break active shared Core consumers. No production application minter call was found by rg over non-test package files; exported APIs and tests still exist and are consumers to account for, not evidence that no external application uses them.
5. source: mixed transport imports StdioClientTransport and reads process.env; HTTP/SSE selection is in packages/mcp-portal/src/upstream-mcp-client-runtime.ts:266,305. inference: split transport construction and stdio env inheritance into tool-host-node; merely changing the package name or tree-shaking an import is not Worker closure proof. The HTTP client/progress/cancel/session logic can be adapted under connectors with an injected transport.
6. source: Core tool handlers also import the catalog TypeScript artifact generator (packages/mcp-portal/src/core/portal-tools.ts:12); generator/compiler paths use Node crypto/Buffer and json-schema-to-typescript/TypeScript. inference: portable runtime needs prepared-catalog/generator ports; moving compiler files to Node while leaving this import would fail the boundary. No claim these compiler dependencies run in a Worker.
7. source: controller-configured-cli.ts mixes isIP from node:net, Buffer UTF-8 byte checks, prepared image codec, concrete controller_host/ephemeral_managed_vm/tool_vm target schemas and portable CLI policy (:1,324,514,586). tool-portal-config.ts mixes pure profile/selector rules, concrete managed backend shapes, host auth/listeners, file loading and projections (:280,307,474,780,1021). inference: split per public symbol; whole-file “move as-is” would either pull execution details into the pure package or drop validation that current consumers require. File/export tables name both homes.
8. source: Existing deterministicOperationId hashes semanticRevision, surfaceClass, stablePrincipal and callId, with an exact NUL-separated v1 prefix; directDispatchFingerprint hashes a different canonical object including revisions/arguments/managed Google facts (packages/tool-portal/src/dispatch-authority.ts:34,61). inference: preserve current MANAGED IDs/fingerprint bytes at their external owner. The new public stable operation lookup vs admission fingerprint is a NEW contract; no aliasing old IDs or automatic migration.
9. source: Exact artifact/schema byte contracts include config JSON Schema $id/schemaVersion/draft-07 output (packages/config-contracts/src/schema-artifacts.ts:7,13,38); prepared-image identity prefix, JSON property order, base64url and canonical roundtrip (controller-configured-cli.ts:514,528,540); tool-reference mcp: base64url canonical roundtrip (packages/mcp-portal/src/tool-ref.ts:18,32); catalog generatorVersion=2/sdkContractVersion=1, sorted fingerprints, presentation names, manifest and byte lengths (catalog-typescript/catalog-typescript-compiler.ts:24,190,399); OAuth asset manifest css/javascript and hashed filename shape (packages/oauth-approval-ui/src/contracts.ts:114; scripts/fingerprint-assets.ts:7,28,36). inference: preserve bytes for unchanged contracts; version deliberate changes. Replacing Buffer/TextEncoder/WebCrypto/sort helpers can change UTF-8 length, invalid-UTF-8 rejection, locale ordering or hash inputs. Equality fixtures, emitted artifacts and current managed readback—not TypeScript equivalence—must settle this.
10. source: JSON Schema validator uses z.fromJSONSchema then value normalization and safeParse with explicit unsupported/failed results (packages/mcp-portal/src/zod-schema-loader.ts:499); config/CLI refinements and defaults are behavior beyond emitted JSON Schema. inference: keep failure/normalization semantics and prove the actual packed Worker validator. A direct no-node-import scan alone cannot establish Worker compatibility or equivalent validation.
11. source: UI root reaches a Node fs asset reader (packages/oauth-approval-ui/src/server/oauth-approval-renderer.tsx:1,53), while browser entry only updates permission summaries. inference: move asset reading/serving to host; rewrite Hono JSX into React UI components and injected client app shell. Keep consent/account-policy command authority in existing controller/OAuth owners and preserve Origin/browser/CSRF/revision/preview/applying/containment obligations. UI re-render is not authority migration.
12. source: rg for assessAccess|ControlPolicyPort|RouterModelPort|ChangeProposal|propose\\(|decide\\(|DurableObject|cloudflare:workers in the scoped non-test sources returned no matches. inference: assessAccess composition, generic control propose/decide/apply/request-router/model-port and Worker/DO/Access bindings are NEW work; no scoped source file can truthfully be marked a completed move to these implementations. Existing Google evaluator/provider facts stay with their owner; do not manufacture a second account policy engine.

Design details still needed (not contradictions to the confirmed ownership direction): exact generic backend/approval/operation proof and recovery contracts; final host location for code generation and residual config loaders; selected new public auth/store/authority binding (including durable replay/unknown recovery); which provider fact schemas are shared without moving Google authority. The inventory does not select these. No inherent placement contradiction was established, so I completed the bounded map rather than stopping on an already-superseded package-name diagram.

Read coverage/queries: rg --files over named package trees; current package.json exports plus tsdown entries; full source lexical scans for ^export, static import/export-from, node:*, process.*, Buffer, @hono/node-server, stdio, gateway-control/controller-execution and Gondolin; repository-wide packages/scripts named-import/re-export graph; direct rg for legacy sign/hash/coordinator uses; bounded nl -ba reads at anchors above; named Advisor source-boundaries.md used as discovery and decisive claims re-opened. No web/OSS/runtime sources needed for a pinned local source inventory. No delegated lane. No ledger written under the no-write grant. Every scoped file is in a family table; S-only depth and unobserved runtime/packed/build/test/external consumers remain explicit.

Reference dictionary (P# + :line in tables expands to this exact repository-relative path:line):

| Ref | Path |
|---|---|
| P1 | packages/agent-vm/src/cli/init-command.ts |
| P2 | packages/agent-vm/src/controller/control-session/gateway-configured-cli-cancellation.integration.test.ts |
| P3 | packages/agent-vm/src/controller/control-session/gateway-control-controller-execution-authorization.ts |
| P4 | packages/agent-vm/src/controller/control-session/gateway-control-controller-execution-authorization.unit.test.ts |
| P5 | packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts |
| P6 | packages/agent-vm/src/controller/control-session/gateway-control-oauth-invocation-context.ts |
| P7 | packages/agent-vm/src/controller/control-session/tool-portal-mcp-approval.integration.test.ts |
| P8 | packages/agent-vm/src/controller/controller-runtime.ts |
| P9 | packages/agent-vm/src/controller/controller-runtime.unit.test.ts |
| P10 | packages/agent-vm/src/controller/credentialed-runtime/credentialed-managed-vm.ts |
| P11 | packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-manager-contracts.ts |
| P12 | packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-manager.integration.test.ts |
| P13 | packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-registry.ts |
| P14 | packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-registry.unit.test.ts |
| P15 | packages/agent-vm/src/controller/oauth/controller-oauth-runtime.integration.test.ts |
| P16 | packages/agent-vm/src/controller/oauth/controller-oauth-runtime.ts |
| P17 | packages/agent-vm/src/controller/oauth/gog-realfs-journey.integration.test.ts |
| P18 | packages/agent-vm/src/controller/oauth/google-account-policy-editor.integration.test.ts |
| P19 | packages/agent-vm/src/controller/oauth/google-account-policy-editor.ts |
| P20 | packages/agent-vm/src/controller/oauth/google-approval-intent-validation.ts |
| P21 | packages/agent-vm/src/controller/oauth/google-permission-policy-service.integration.test.ts |
| P22 | packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts |
| P23 | packages/agent-vm/src/controller/oauth/managed-google-file-preflight.ts |
| P24 | packages/agent-vm/src/controller/oauth/managed-google-file-preflight.unit.test.ts |
| P25 | packages/agent-vm/src/controller/oauth/managed-google-portal-policy.integration.test.ts |
| P26 | packages/agent-vm/src/controller/oauth/oauth-access-http.integration.test.ts |
| P27 | packages/agent-vm/src/controller/oauth/oauth-account-policy-routes.ts |
| P28 | packages/agent-vm/src/controller/oauth/oauth-browser-session-routes.ts |
| P29 | packages/agent-vm/src/controller/oauth/oauth-https-server.ts |
| P30 | packages/agent-vm/src/controller/oauth/oauth-permission-form.ts |
| P31 | packages/agent-vm/src/controller/runner/configured-cli-authorization.ts |
| P32 | packages/agent-vm/src/controller/runner/configured-cli-environment.ts |
| P33 | packages/agent-vm/src/controller/runner/configured-cli-host-executor.ts |
| P34 | packages/agent-vm/src/controller/runner/configured-cli-host-executor.unit.test.ts |
| P35 | packages/agent-vm/src/controller/runner/configured-cli-managed-vm-executor.integration.test.ts |
| P36 | packages/agent-vm/src/controller/runner/configured-cli-managed-vm-executor.ts |
| P37 | packages/agent-vm/src/controller/runner/configured-cli-output.ts |
| P38 | packages/agent-vm/src/gateway/gateway-runtime-portal-admission-material.ts |
| P39 | packages/agent-vm/src/gateway/gateway-runtime-portal-admission-material.unit.test.ts |
| P40 | packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts |
| P41 | packages/agent-vm/src/gateway/managed-framework-agent-projections.ts |
| P42 | packages/agent-vm/src/gateway/managed-gateway-runtime-input-builders.ts |
| P43 | packages/agent-vm/src/gateway/managed-gateway-runtime-input-builders.unit.test.ts |
| P44 | packages/agent-vm/src/gateway/mcp-portal-effective-config.integration.test.ts |
| P45 | packages/agent-vm/src/gateway/mcp-portal-effective-config.ts |
| P46 | packages/agent-vm/src/gateway/mcp-portal-effective-config.unit.test.ts |
| P47 | packages/agent-vm/src/integration-tests/configured-cli-host-executor.host.e2e.test.ts |
| P48 | packages/agent-vm/src/integration-tests/configured-cli-managed-vm.vm.e2e.test.ts |
| P49 | packages/agent-vm/src/integration-tests/gateway-runtime-sandbox-test-fixture.ts |
| P50 | packages/agent-vm/src/integration-tests/gateway-runtime-sandbox-vm-test-fixture.ts |
| P51 | packages/agent-vm/src/integration-tests/hermes-tool-portal-orientation.hermes.e2e.test.ts |
| P52 | packages/agent-vm/src/integration-tests/managed-gateway-image-boot-test-fixture.ts |
| P53 | packages/agent-vm/src/integration-tests/pinned-gog-runtime.vm.e2e.test.ts |
| P54 | packages/agent-vm/src/integration-tests/portal-composition-hermes-e2e-config.ts |
| P55 | packages/agent-vm/src/integration-tests/portal-composition-hermes-e2e-config.unit.test.ts |
| P56 | packages/agent-vm/src/integration-tests/portal-composition-hermes-e2e-program.ts |
| P57 | packages/agent-vm/src/integration-tests/portal-composition.hermes.e2e.test.ts |
| P58 | packages/agent-vm/src/integration-tests/structured-logging.host.e2e.test.ts |
| P59 | packages/agent-vm/src/integration-tests/tool-portal-artifact-cli.host.e2e.test.ts |
| P60 | packages/agent-vm/src/operations/config-validation.integration.test.ts |
| P61 | packages/agent-vm/src/operations/config-validation.ts |
| P62 | packages/agent-vm/src/operations/mcp-portal-live-validation.ts |
| P63 | packages/config-contracts/src/compiled-google-command-set.ts |
| P64 | packages/config-contracts/src/configured-cli-prepared-image-identity.unit.test.ts |
| P65 | packages/config-contracts/src/controller-configured-cli.ts |
| P66 | packages/config-contracts/src/controller-configured-cli.unit.test.ts |
| P67 | packages/config-contracts/src/index.ts |
| P68 | packages/config-contracts/src/managed-google-policy-config.unit.test.ts |
| P69 | packages/config-contracts/src/mcp-config.ts |
| P70 | packages/config-contracts/src/mcp-config.unit.test.ts |
| P71 | packages/config-contracts/src/mcp-portal-approval-policy.ts |
| P72 | packages/config-contracts/src/mcp-portal-approval-policy.unit.test.ts |
| P73 | packages/config-contracts/src/mcp-portal-config.ts |
| P74 | packages/config-contracts/src/mcp-portal-config.unit.test.ts |
| P75 | packages/config-contracts/src/namespace-discovery-compiler.ts |
| P76 | packages/config-contracts/src/namespace-discovery-compiler.unit.test.ts |
| P77 | packages/config-contracts/src/oauth-config-examples.integration.test.ts |
| P78 | packages/config-contracts/src/oauth-config-test-fixture.ts |
| P79 | packages/config-contracts/src/oauth-config-v2.unit.test.ts |
| P80 | packages/config-contracts/src/oauth-config.ts |
| P81 | packages/config-contracts/src/oauth-config.unit.test.ts |
| P82 | packages/config-contracts/src/oauth-policy-compiler-test-fixture.ts |
| P83 | packages/config-contracts/src/oauth-policy-compiler.unit.test.ts |
| P84 | packages/config-contracts/src/oauth-tool-portal-config.ts |
| P85 | packages/config-contracts/src/schema-artifacts.ts |
| P86 | packages/config-contracts/src/schema-artifacts.unit.test.ts |
| P87 | packages/config-contracts/src/tool-portal-config.ts |
| P88 | packages/config-contracts/src/tool-portal-config.unit.test.ts |
| P89 | packages/gateway-control-contracts/src/gateway-runtime-approval.ts |
| P90 | packages/gateway-control-contracts/src/gateway-runtime-portal-admission.ts |
| P91 | packages/gateway-control-contracts/src/gateway-runtime-portal-semantic-revision.ts |
| P92 | packages/gateway-control-contracts/src/gateway-runtime-portal-semantic-revision.unit.test.ts |
| P93 | packages/gateway-control-contracts/src/index.ts |
| P94 | packages/gateway-runtime/src/backends/configured-cli-tool-vm-executor.ts |
| P95 | packages/gateway-runtime/src/backends/configured-gog-file-discovery.unit.test.ts |
| P96 | packages/gateway-runtime/src/backends/controller-execution-backend-port.ts |
| P97 | packages/gateway-runtime/src/backends/controller-execution-backend-port.unit.test.ts |
| P98 | packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts |
| P99 | packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.unit.test.ts |
| P100 | packages/gateway-runtime/src/backends/index.ts |
| P101 | packages/gateway-runtime/src/backends/tool-vm-runner-artifact-writer.ts |
| P102 | packages/gateway-runtime/src/backends/tool-vm-runner-artifact-writer.unit.test.ts |
| P103 | packages/gateway-runtime/src/backends/tool-vm-runner-backend-port.ts |
| P104 | packages/gateway-runtime/src/backends/tool-vm-runner-backend-port.unit.test.ts |
| P105 | packages/gateway-runtime/src/backends/tool-vm-runner-catalog-projection.ts |
| P106 | packages/gateway-runtime/src/backends/tool-vm-runner-configured-catalog.ts |
| P107 | packages/gateway-runtime/src/backends/tool-vm-runner-configured-catalog.unit.test.ts |
| P108 | packages/gateway-runtime/src/backends/tool-vm-runner-process-backend-port.unit.test.ts |
| P109 | packages/gateway-runtime/src/bin/gateway-runtime.host.e2e.test.ts |
| P110 | packages/gateway-runtime/src/catalog/prepared-catalog-python-publication.host.e2e.test.ts |
| P111 | packages/gateway-runtime/src/catalog/prepared-catalog-source-cache-lazy-loading.unit.test.ts |
| P112 | packages/gateway-runtime/src/catalog/prepared-catalog-source-cache.ts |
| P113 | packages/gateway-runtime/src/catalog/prepared-catalog-source-cache.unit.test.ts |
| P114 | packages/gateway-runtime/src/control-endpoint/gateway-control-operation-active-use-runtime.ts |
| P115 | packages/gateway-runtime/src/gateway-runtime-approval-port.ts |
| P116 | packages/gateway-runtime/src/index.ts |
| P117 | packages/gateway-runtime/src/managed-tool-portal-composition.integration.test.ts |
| P118 | packages/gateway-runtime/src/managed-tool-portal-composition.ts |
| P119 | packages/gateway-runtime/src/managed-tool-portal-real-backends.integration.test.ts |
| P120 | packages/gateway-runtime/src/oauth-availability-gateway-control-port.ts |
| P121 | packages/gateway-runtime/src/production/gateway-runtime-private-uds-catalog.unit.test.ts |
| P122 | packages/gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.ts |
| P123 | packages/gateway-runtime/src/production/gateway-runtime-production-control-runtime.ts |
| P124 | packages/gateway-runtime/src/production/gateway-runtime-production-control-runtime.unit.test.ts |
| P125 | packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.ts |
| P126 | packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.unit.test.ts |
| P127 | packages/gateway-runtime/src/production/gateway-runtime-production-service.integration.test.ts |
| P128 | packages/gateway-runtime/src/production/gateway-runtime-production-service.ts |
| P129 | packages/gateway-runtime/src/production/gateway-runtime-service-config.ts |
| P130 | packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts |
| P131 | packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.unit.test.ts |
| P132 | packages/gateway-runtime/src/runtime/managed-tool-portal-service.ts |
| P133 | packages/gateway-runtime/src/testing/gateway-runtime-unavailable-ports.ts |
| P134 | packages/gateway-runtime/src/tool-portal-artifacts.integration.test.ts |
| P135 | packages/gateway-runtime/src/tool-portal-projections.integration.test.ts |
| P136 | packages/gateway-runtime/src/tool-portal-projections.ts |
| P137 | packages/mcp-portal/src/bin/mcp-portal-command-dispatcher.ts |
| P138 | packages/mcp-portal/src/bin/mcp-portal.host.e2e.test.ts |
| P139 | packages/mcp-portal/src/bin/mcp-portal.ts |
| P140 | packages/mcp-portal/src/bin/mcp-portal.unit.test.ts |
| P141 | packages/mcp-portal/src/bin/secret-value-resolver.ts |
| P142 | packages/mcp-portal/src/bin/secret-value-resolver.unit.test.ts |
| P143 | packages/mcp-portal/src/catalog-types.ts |
| P144 | packages/mcp-portal/src/catalog-types.unit.test.ts |
| P145 | packages/mcp-portal/src/catalog-typescript/catalog-typescript-compiler.ts |
| P146 | packages/mcp-portal/src/catalog-typescript/catalog-typescript-compiler.unit.test.ts |
| P147 | packages/mcp-portal/src/catalog-typescript/catalog-typescript-generated-consumer.host.e2e.test.ts |
| P148 | packages/mcp-portal/src/catalog-typescript/catalog-typescript-types.ts |
| P149 | packages/mcp-portal/src/catalog-typescript/declaration-fragment-validation.unit.test.ts |
| P150 | packages/mcp-portal/src/catalog-typescript/index.ts |
| P151 | packages/mcp-portal/src/catalog-typescript/safe-schema-projection.ts |
| P152 | packages/mcp-portal/src/cli/index.ts |
| P153 | packages/mcp-portal/src/cli/mcp-portal-cli-parser.unit.test.ts |
| P154 | packages/mcp-portal/src/cli/portal-server-operation.ts |
| P155 | packages/mcp-portal/src/cli/process-logging.ts |
| P156 | packages/mcp-portal/src/cli/process-logging.unit.test.ts |
| P157 | packages/mcp-portal/src/cli/serve-command.integration.test.ts |
| P158 | packages/mcp-portal/src/core/index.ts |
| P159 | packages/mcp-portal/src/core/portal-approval-evaluator.ts |
| P160 | packages/mcp-portal/src/core/portal-approval-evaluator.unit.test.ts |
| P161 | packages/mcp-portal/src/core/portal-call-validation.ts |
| P162 | packages/mcp-portal/src/core/portal-core-validation.ts |
| P163 | packages/mcp-portal/src/core/portal-core-validation.unit.test.ts |
| P164 | packages/mcp-portal/src/core/portal-core.integration.test.ts |
| P165 | packages/mcp-portal/src/core/portal-core.ts |
| P166 | packages/mcp-portal/src/core/portal-tools.ts |
| P167 | packages/mcp-portal/src/core/portal-tools.unit.test.ts |
| P168 | packages/mcp-portal/src/core/provider-runtime.ts |
| P169 | packages/mcp-portal/src/core/provider-runtime.unit.test.ts |
| P170 | packages/mcp-portal/src/index.ts |
| P171 | packages/mcp-portal/src/json-schema.unit.test.ts |
| P172 | packages/mcp-portal/src/mcp-provider-backend/index.ts |
| P173 | packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.integration.test.ts |
| P174 | packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts |
| P175 | packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.unit.test.ts |
| P176 | packages/mcp-portal/src/mcp-proxy/index.ts |
| P177 | packages/mcp-portal/src/mcp-proxy/portal-http-server.integration.test.ts |
| P178 | packages/mcp-portal/src/mcp-proxy/portal-http-server.ts |
| P179 | packages/mcp-portal/src/mcp-proxy/portal-mcp-server.ts |
| P180 | packages/mcp-portal/src/mcp-proxy/portal-mcp-server.unit.test.ts |
| P181 | packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts |
| P182 | packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.unit.test.ts |
| P183 | packages/mcp-portal/src/portal-access-policy.unit.test.ts |
| P184 | packages/mcp-portal/src/portal-auth/agent-bearer-token.unit.test.ts |
| P185 | packages/mcp-portal/src/portal-auth/hmac-env.unit.test.ts |
| P186 | packages/mcp-portal/src/portal-auth/hmac-token.unit.test.ts |
| P187 | packages/mcp-portal/src/portal-config/index.ts |
| P188 | packages/mcp-portal/src/portal-config/typescript-artifact.ts |
| P189 | packages/mcp-portal/src/portal-config/typescript-artifact.unit.test.ts |
| P190 | packages/mcp-portal/src/portal-config/zod-schema-loader.ts |
| P191 | packages/mcp-portal/src/portal-session.ts |
| P192 | packages/mcp-portal/src/portal-session.unit.test.ts |
| P193 | packages/mcp-portal/src/search-index.ts |
| P194 | packages/mcp-portal/src/search-index.unit.test.ts |
| P195 | packages/mcp-portal/src/standalone-mcp-portal.integration.test.ts |
| P196 | packages/mcp-portal/src/tool-graph.ts |
| P197 | packages/mcp-portal/src/tool-graph.unit.test.ts |
| P198 | packages/mcp-portal/src/tool-ref.unit.test.ts |
| P199 | packages/mcp-portal/src/tool-summary.ts |
| P200 | packages/mcp-portal/src/tool-summary.unit.test.ts |
| P201 | packages/mcp-portal/src/upstream-mcp-client-runtime.integration.test.ts |
| P202 | packages/mcp-portal/src/upstream-mcp-client-runtime.ts |
| P203 | packages/mcp-portal/src/upstream-mcp-errors.ts |
| P204 | packages/mcp-portal/src/upstream-mcp-errors.unit.test.ts |
| P205 | packages/mcp-portal/src/upstream-response-middleware.ts |
| P206 | packages/mcp-portal/src/upstream-response-middleware.unit.test.ts |
| P207 | packages/mcp-portal/src/zod-schema-loader.ts |
| P208 | packages/mcp-portal/src/zod-schema-loader.unit.test.ts |
| P209 | packages/oauth-approval-ui/src/browser/entry.tsx |
| P210 | packages/oauth-approval-ui/src/permission-selection-summary.ts |
| P211 | packages/oauth-approval-ui/src/permission-selection-summary.unit.test.ts |
| P212 | packages/oauth-approval-ui/src/server/index.ts |
| P213 | packages/oauth-approval-ui/src/server/oauth-account-policy-renderer.unit.test.ts |
| P214 | packages/oauth-approval-ui/src/server/oauth-approval-page.unit.test.ts |
| P215 | packages/oauth-approval-ui/src/server/oauth-approval-renderer.tsx |
| P216 | packages/oauth-approval-ui/src/server/waiting-for-access-renderer.unit.test.ts |
| P217 | packages/oauth-broker/src/google/google-authorization-commit.ts |
| P218 | packages/oauth-broker/src/google/google-authorization-view-models.ts |
| P219 | packages/oauth-broker/src/google/google-broker-facade-test-fixture.ts |
| P220 | packages/oauth-broker/src/google/google-callback-test-fixture.ts |
| P221 | packages/oauth-broker/src/google/google-oauth-broker-contracts.ts |
| P222 | packages/oauth-broker/src/google/google-oauth-broker-service.ts |
| P223 | packages/oauth-broker/src/google/google-oauth-permission-policy.ts |
| P224 | packages/oauth-broker/src/google/google-oauth-permission-policy.unit.test.ts |
| P225 | packages/oauth-broker/src/google/google-policy-catalog.unit.test.ts |
| P226 | packages/oauth-broker/src/google/google-provider-authorization-callback.ts |
| P227 | packages/oauth-broker/src/google/google-runtime-credential-policy.ts |
| P228 | packages/oauth-broker/src/oauth-account-policy.integration.test.ts |
| P229 | packages/oauth-broker/src/oauth-policy-defaults.integration.test.ts |
| P230 | packages/tool-portal/src/cli-allowances/cli-allowance-contracts.unit.test.ts |
| P231 | packages/tool-portal/src/cli-allowances/cli-allowance-validator.ts |
| P232 | packages/tool-portal/src/cli-allowances/configured-cli-invocation-policy.unit.test.ts |
| P233 | packages/tool-portal/src/cli-allowances/index.ts |
| P234 | packages/tool-portal/src/cli-allowances/managed-google-command-shape.unit.test.ts |
| P235 | packages/tool-portal/src/cli-allowances/models/cli-allowance-schema.ts |
| P236 | packages/tool-portal/src/configured-cli-call-policy.unit.test.ts |
| P237 | packages/tool-portal/src/dispatch-authority.ts |
| P238 | packages/tool-portal/src/google-account-policy.unit.test.ts |
| P239 | packages/tool-portal/src/index.ts |
| P240 | packages/tool-portal/src/managed-catalog-preparation.ts |
| P241 | packages/tool-portal/src/mcp-provider-backend/index.ts |
| P242 | packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts |
| P243 | packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.unit.test.ts |
| P244 | packages/tool-portal/src/standalone-entrypoint/index.ts |
| P245 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-approval.ts |
| P246 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-approval.unit.test.ts |
| P247 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-bearer-credentials.unit.test.ts |
| P248 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-http-server.integration.test.ts |
| P249 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-http-server.ts |
| P250 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-entrypoints.integration.test.ts |
| P251 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-entrypoints.ts |
| P252 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-http-server.integration.test.ts |
| P253 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-http-server.ts |
| P254 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-projection.ts |
| P255 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-stdio-server.integration.test.ts |
| P256 | packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-stdio-server.ts |
| P257 | packages/tool-portal/src/standalone-tool-portal-invocation-contracts.ts |
| P258 | packages/tool-portal/src/standalone-tool-portal-service-test-fixture.ts |
| P259 | packages/tool-portal/src/standalone-tool-portal-service.ts |
| P260 | packages/tool-portal/src/testing/index.ts |
| P261 | packages/tool-portal/src/testing/tool-portal-testing-fixtures.unit.test.ts |
| P262 | packages/tool-portal/src/tool-portal-backend-port.type-contract.unit.test.ts |
| P263 | packages/tool-portal/src/tool-portal-invocation-contracts.ts |
| P264 | packages/tool-portal/src/tool-portal-result-router.unit.test.ts |
| P265 | packages/tool-portal/src/tool-portal-service-approval-dispatch.unit.test.ts |
| P266 | packages/tool-portal/src/tool-portal-service-catalog-routing.unit.test.ts |
| P267 | packages/tool-portal/src/tool-portal-service-common.ts |
| P268 | packages/tool-portal/src/tool-portal-service-common.unit.test.ts |
| P269 | packages/tool-portal/src/tool-portal-service-context-identity.unit.test.ts |
| P270 | packages/tool-portal/src/tool-portal-service-standalone.unit.test.ts |
| P271 | packages/tool-portal/src/tool-portal-service-test-fixture.ts |
| P272 | packages/tool-portal/src/tool-portal-service.ts |
| P273 | scripts/audit-optique-cli-boundaries.unit.test.ts |

Existing public routes (E#):

| Ref | Existing package export routes |
|---|---|
| E1 | @agent-vm/tool-portal, @agent-vm/tool-portal/cli-allowances |
| E2 | @agent-vm/tool-portal |
| E3 | @agent-vm/tool-portal, @agent-vm/tool-portal/standalone-entrypoint |
| E4 | @agent-vm/tool-portal/dispatch-authority |
| E5 | @agent-vm/tool-portal/testing |
| E6 | @agent-vm/mcp-portal |
| E7 | @agent-vm/mcp-portal, @agent-vm/mcp-portal/core |
| E8 | @agent-vm/mcp-portal, @agent-vm/mcp-portal/portal-config |
| E9 | @agent-vm/mcp-portal/core |
| E10 | @agent-vm/mcp-portal/mcp-proxy |
| E11 | @agent-vm/mcp-portal/mcp-provider-backend |
| E12 | @agent-vm/mcp-portal/cli |
| E13 | @agent-vm/mcp-portal/portal-config |
| E14 | @agent-vm/mcp-portal/portal-auth/hmac-token |
| E15 | @agent-vm/mcp-portal/portal-auth/hmac-env |
| E16 | @agent-vm/mcp-portal/portal-auth/agent-bearer-token |
| E17 | @agent-vm/mcp-portal/catalog-typescript |
| E18 | @agent-vm/mcp-portal/testing/fake-upstream-mcp-server |
| E19 | @agent-vm/config-contracts |
| E20 | @agent-vm/oauth-approval-ui |
| E21 | @agent-vm/gateway-runtime |

Specialized per-symbol placements (A#; full target/change cells used in public export tables):

| Ref | Target package/module (I) | Port kind | Required change/reason (I) |
|---|---|---|---|
| A1 | stays in agent-vm/execution provider evaluator | move as-is | One Google policy owner; pass result facts into assessAccess rather than duplicate evaluation |
| A2 | stays in agent-vm/execution managed wrapper; retire standalone old envelope | adapt | Every exported generic union currently encodes managed/standalone mode; new neutral contract must be explicit |
| A3 | tool-portal/dispatch for neutral core; existing managed wrapper stays execution | adapt | Split generic orchestration from Gateway trusted principal/snapshot/reservation validation; preserve managed final authority |
| A4 | tool-portal/dispatch backend interface (types in tool-access/contracts) | adapt | Keep discriminated backend kinds; replace GatewayRuntime dispatch authority with injected opaque/generic contract |
| A5 | retire legacy standalone public contract; replacement tool-access/contracts + dispatch | rewrite | standalone-hmac-batch authority type is explicitly obsolete |
| A6 | stays in agent-vm/execution managed adapter; neutral counterpart tool-access/contracts | adapt | Current signatures are Gateway/Google-specific; keep controller authority external, use new fact/approval interfaces |
| A7 | tool-portal/mcp-gateway/core | adapt | Replace Buffer byte counting, legacy approval evaluator and local identity assumptions with portable ports; retain errors/results/progress |
| A8 | tool-portal/mcp-gateway + dispatch; contracts in tool-access | adapt | Separate wire schemas from handlers; retire HMAC token proof fields/decisions only in selected legacy family; keep shared hashCallArguments consumer |
| A9 | retire | retire | Legacy approval key/verifier/replay plumbing; update Node server composition |
| A10 | retire | retire | Legacy approval key trust path; server/auth consumer cutover required |
| A11 | tool-access/contracts/call digest (rename independent of legacy proof) | adapt | Shared core digest shape survives old token type family; no token translation |
| A12 | retire | retire | Legacy HMAC approval proof API/audience/sign/verify; do not re-export or trust old keys |
| A13 | tool-host-node/crypto utility with portable hash port; shared caller contracts in tool-access | adapt | Used by portal-tools as well as retiring evaluator; preserve canonical bytes and replace import before module retirement |
| A14 | tool-access/contracts/cli-allowances | adapt | Keep exact validation/defaults; replace node isIP/Buffer where reached; remove execution-target imports from closure |
| A15 | stays in agent-vm/execution (configured CLI/credential/VM contract) | adapt | Keep existing execution/credential/image fields and managed consumers; import moved pure policy schema |
| A16 | tool-access/authorization/cli-allowances | move as-is | Pure timeout decision; import only pure schemas |
| A17 | tool-access/contracts/mcp-provider | adapt | Schema/value projection; split host loader, keep Node stdio config outside portable outbound HTTP factory |
| A18 | tool-host-node/config | move as-is | Filesystem loader |
| A19 | tool-access/contracts/mcp-policy (schemas/types) or authorization (resolveMcpPortalProfile) | adapt | Pure policy/compiler fragment split from loader and host auth schema |
| A20 | tool-host-node/config/auth | adapt | Host auth/listener config; remove old approval key trust as separately selected; never import host config root in core |
| A21 | tool-host-node/config | adapt | Rename config surface at cutover and load new host-owned shape |
| A22 | stays in agent-vm/execution OAuth contracts | adapt | Provider/owner/editor/Access config, not generic enrollment; use new pure shared inputs |
| A23 | stays in agent-vm/execution OAuth host loader | move as-is | Existing OAuth owner remains external |
| A24 | tool-access/contracts/tool-policy | adapt | Split portable selector/profile/policy/binding contracts from concrete execution targets and host loading |
| A25 | stays in agent-vm/execution managed configuration/projection | adapt | Concrete execution/managed shape stays external; supplies backend-neutral catalog/facts through interface |
| A26 | tool-access/authorization | adapt | Keep current filtering/deny semantics over moved schemas; remove managed-wide input unions from portable closure |
| A27 | tool-host-node/config | adapt | Host listener/auth configuration, not portable runtime; strip legacy approvalHmacKey acceptance at cutover |
| A28 | tool-host-node/config (managed loader remains execution consumer) | adapt | Split filesystem load from schema roots |
| A29 | tool-access/contracts/control view model + host asset props split | rewrite | React props/client model separate from host asset/form transport configuration |
| A30 | tool-host-node/assets (managed controller host adapter) | adapt | Filesystem asset read/bundle serving outside browser root |

Checkpoint: same service/project/board/topic/root as prior handback (service 0ff962c5-7fa3-4c18-a5ca-1bbe8db09e89; project 01a14e9e-ba87-7605-bc7b-7e6be7931fb1; board 01a14e9e-ba87-7605-bc7b-7e6cdff4d3a5; topic 01a14e9e-ba87-7605-bc7b-7e6d49d07e5f; root 01a14e9e-ba87-7605-bc7b-7e6eff6ec101). This direct handback is returned for your trace; no board posting grant assumed. No stand-ins, implementations or acceptance. Next: Lead reconciles target homes/contracts with governing Program Design, then uses file/export rows as a port checklist; S-only bodies need decisive inspection before implementing or accepting a move.



## tool-portal

📚 ResearcherHandback port inventory — tool-portal (29 files; 127 public symbols).

Legend from the overview applies: I = inferred placement; S = source scanner evidence; O = bounded surrounding code opened. F# gives exact path; P# consumer/test path; A# specialized placement; E# existing public export route(s). Every “=F#/A#” expands to that row’s full target/change/dependency/test cell. No runtime/portability proof claimed. Tests are existing statically linked candidates, not passing runs.

| Current path | What it does (responsibility; I) | Target (I) | Port kind/change (I) | Host/VM dependencies (S/O) | Current consumers (S) | Tests to carry/adapt (S candidates) |
|---|---|---|---|---|---|---|
| F89 packages/tool-portal/src/cli-allowances/cli-allowance-validator.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Pure fixed CLI argument/flag/stdin/approval-rule evaluation | I tool-access/authorization/cli-allowances | move as-is: Same evaluator inputs/outputs; rebind to moved pure schemas only | none of named host/VM hazards directly detected; transitive closure unproven | P239:1, P233:1, P3:21, P267:25, P33:7, P36:27, P98:39, P22:44 | P234:3, P232:3, P230:3 |
| F90 packages/tool-portal/src/cli-allowances/index.ts:1 [O bounded source + S declarations/imports] | Allowance evaluator/schema barrel | I tool-access/authorization and /contracts explicit entries | adapt: Avoid schema entrypoint importing evaluator or host config root | none of named host/VM hazards directly detected; transitive closure unproven | P239:1, P3:21, P33:7, P36:27 | P232:3, P230:3, P261:4, P55:6 |
| F91 packages/tool-portal/src/cli-allowances/models/cli-allowance-schema.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | CLI allowance schema/type aliases and timeout wrapper | I tool-access/contracts/cli-allowances (helper authorization) | adapt: Replace @agent-vm/config-contracts root with canonical schema definitions; do not duplicate aliases into a second truth | config-contracts root transitive fs/net/crypto | P239:1, P233:2, P231:3, P260:3, P33:7 | P232:3, P230:3, P261:4, P55:6 |
| F92 packages/tool-portal/src/dispatch-authority.ts:1 [O bounded source + S declarations/imports] | Managed operation identity and dispatch fingerprint hashing | I stays in agent-vm/execution for existing managed bytes; generic tool-access contracts + host crypto adapter | adapt: Current operation ID includes semantic revision/principal/surface; new stable operation identity must not reinterpret legacy hashes/reservations | node:crypto:1; config-contracts root transitive fs/net/crypto | P3:22, P267:21, P259:32, P272:86 | P4:15, P48:18 |
| F93 packages/tool-portal/src/google-account-policy.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Pure Google grant/default/override/maximum decision combination | I stays in agent-vm/execution (provider evaluator); result facts to tool-access | adapt: Preserve Google owner function, do not create second policy engine; port-independent input type could be shared if agreed | none of named host/VM hazards directly detected; transitive closure unproven | P239:2, P22:44 | P238:3 |
| F94 packages/tool-portal/src/index.ts:1 [O bounded source + S declarations/imports] | Tool Portal mixed root (schemas, service, host standalone, backend implementation) | I retire; explicit tool-access/dispatch + host composition imports | retire: Hard-cut every consumer; forbid host/managed re-exports from portable root | none of named host/VM hazards directly detected; transitive closure unproven | P115:14, P118:1, P133:13, P120:10, P132:1, P98:39, P103:26, P96:32, P94:10, P136:26, P22:44, P123:9, P130:8, P128:25, P50:62, P49:23 | P117:34, P134:15, P7:44, P135:30, P97:12, P104:18, P108:18, P99:16, P119:32, P17:37, P25:23, P110:9, P124:5, P127:43, P131:6, P59:5, P53:30 |
| F95 packages/tool-portal/src/managed-catalog-preparation.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Prepare managed catalog across MCP/controller/Tool VM ports | I stays in agent-vm/execution adapter; portable catalog aggregation in tool-portal/dispatch if separated | adapt: Inject host-neutral catalog ports; retain all-backend completeness/incomplete diagnostics; no fake catalog success | none of named host/VM hazards directly detected; transitive closure unproven | P272:64 | none found in static import scan |
| F96 packages/tool-portal/src/mcp-provider-backend/index.ts:1 [O bounded source + S declarations/imports] | Mixed managed/standalone MCP provider adapter barrel | I stays in agent-vm/execution (managed adapter); generic connector interface in Tool Portal | adapt: Concrete backend factory cannot sit in Tool Portal root under confirmed interfaces-only rule | none of named host/VM hazards directly detected; transitive closure unproven | P239:3 | none found in static import scan |
| F97 packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:1 [O bounded source + S declarations/imports] | Concrete managed and standalone MCP backend adapter, principal pool keys and authority validation | I stays in agent-vm/execution (managed branch); Node host standalone replacement; portable interface only | adapt: Keep managed authority/principal validation outside core; replace standalone legacy proof; inject outbound connector | node:crypto:1; @agent-vm/gateway-control-contracts:13; config-contracts root transitive fs/net/crypto | P239:3, P241:1, P128:25 | P243:20 |
| F98 packages/tool-portal/src/standalone-entrypoint/index.ts:1 [O bounded source + S declarations/imports] | Standalone mixed auth/approval/listeners/service barrel | I retire; explicit tool-host-node entries and tool-portal/mcp-gateway projection | retire: Export-map consumers must migrate together; no re-export of retired token coordinator | none of named host/VM hazards directly detected; transitive closure unproven | P239:4 | none found in static import scan |
| F99 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-approval.ts:1 [O bounded source + S declarations/imports] | Batch HMAC approval signer/coordinator and in-memory reserve/arm tombstones | I retire legacy authority; new pure rules tool-access/approval-rules + host durable adapter | retire: No token/state translation; preserve fail-closed reserve/arm/unknown outcomes as obligations in new mechanism; managed ledger unaffected | node:crypto:1; return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); [166]; return `${Buffer.from(payloadJson, 'utf8').toString('base64url')}.${signPayload(paylo [218]; const payloadBytes = Buffer.from(payloadPart, 'base64url'); [230]; const signature = Buffer.from(signaturePart, 'base64url'); [231] | P258:13, P239:4, P244:2, P254:35, P259:15, P272:65 | P246:5, P270:9 |
| F100 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-bearer-credentials.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Fixed bearer credential set, principal/version and in-flight drain logic | I tool-host-node/auth and lifecycle; shared principal contracts tool-access | adapt: Node timing-safe/Buffer checks stay adapter; selected stable identity contract separate from credential version; retire old public admission binding | node:crypto:1; Buffer.compare( [127]; Buffer.from(String(leftAgentId), 'utf8'), [128]; Buffer.from(String(rightAgentId), 'utf8'), [129]; tokenBytes: Buffer.from(credential.bearerToken, 'utf8'), [163]; const expectedPadded = Buffer.alloc(comparedLength); [190]; const candidatePadded = Buffer.alloc(comparedLength); [191]; const candidateBytes = Buffer.from(bearerToken, 'utf8'); [202] | P258:17, P239:4, P257:4, P249:18, P244:1, P254:36, P253:13, P251:4, P256:4, P245:5 | P252:10, P247:3, P250:5, P255:7, P248:5, P59:5 |
| F101 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-http-request-policy.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | HTTP Host/Origin/content request policy | I tool-host-node/listeners (pure policy fragment could be shared) | adapt: Replace IncomingMessage type with Web request facts if shared; retain fail-closed headers/origin restrictions | node:http:1 | P249:30, P253:26 | none found in static import scan |
| F102 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-http-server.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Node standalone HTTP Tool Portal listener and approval header | I tool-host-node/listeners | adapt: Replace standalone HMAC header/admission mechanism with injected authority; retain body bounds/auth/error handling; managed invariants external | node:crypto:1; node:http:7; node:net:8; if (!Buffer.isBuffer(chunk)) [92]; return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; [99] | P239:4, P244:5, P251:8 | P248:9 |
| F103 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-entrypoints.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Start/close HTTP+MCP+stdio standalone entrypoints and credential activation | I tool-host-node/composition | adapt: Separate explicit host listeners; remove legacy approval coordinator activation; preserve teardown/credential-drain semantics via host authority | config-contracts root transitive fs/net/crypto | P239:4, P244:4 | P250:9 |
| F104 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-http-server.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Node streamable-HTTP MCP server/session lifecycle | I tool-host-node/listeners/mcp | adapt: Inject new MCP projection and current auth/operation ownership; no legacy HMAC proof acceptance at new public entry | node:crypto:1; node:http:7; node:net:8 | P239:4, P244:3, P251:12 | P252:14, P59:5 |
| F105 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-projection.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Project Tool Portal calls/discovery into MCP tools and bridge transport | I tool-portal/mcp-gateway | adapt: Replace Buffer byte limits with TextEncoder; StreamableHTTP Node bridge moves host-side; retain tool result/input schemas | Buffer.byteLength(encoded, 'utf8') > maximumMcpToolResultBytes [149] | P239:4, P249:34, P244:6, P253:30, P251:16, P256:8 | P252:18, P250:10, P255:11, P248:14, P270:13, P59:5 |
| F106 packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-stdio-server.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Node stdio MCP server lifecycle | I tool-host-node/stdio | adapt: Explicit compatibility entrypoint only; portable imports must not evaluate StdioServerTransport | @modelcontextprotocol/sdk/server/stdio.js:1 | P239:4, P244:7, P251:20 | P255:15 |
| F107 packages/tool-portal/src/standalone-tool-portal-invocation-contracts.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Standalone invocation envelope and semantic snapshot schema | I retire legacy envelope at public cutover; new tool-access/contracts invocation | rewrite: Current envelope binds fixed auth generation/profile/credential version; new identity/recovery meaning is a new contract, not rename | none of named host/VM hazards directly detected; transitive closure unproven | P258:21, P239:4, P239:5, P244:8, P254:33, P259:20, P272:70, P272:101, P263:8, P263:14 | P270:24 |
| F108 packages/tool-portal/src/standalone-tool-portal-service-test-fixture.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Standalone service testing fixture | I tool-host-node/testing + replacement public-contract fixtures | adapt: Retire old HMAC token authority fixture at cutover; retain negative/ambiguity tests against new mechanism | config-contracts root transitive fs/net/crypto | none found in static import scan | P270:14 |
| F109 packages/tool-portal/src/standalone-tool-portal-service.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Legacy standalone-v1 capability service and batch proof admission | I retire standalone-v1 implementation; replacement tool-portal/dispatch with authority ports | rewrite: Keep routing behavior but replace fixed envelope/service generation/batch-token coordinator, injected hash/identity and new operation contract | node:crypto:1; config-contracts root transitive fs/net/crypto | P239:4, P244:9, P272:69 | none found in static import scan |
| F110 packages/tool-portal/src/testing/index.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Published pure config and allowance fixture factories | I tool-access/testing | adapt: Use canonical new schemas; avoid importing Node-linked config root; testing not portable production root | config-contracts root transitive fs/net/crypto | none found in static import scan | P261:5 |
| F111 packages/tool-portal/src/tool-portal-abort-signal-schema.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | AbortSignal schema | I tool-access/contracts/cancellation | move as-is: Web AbortSignal contract; check Worker constructor/realm behavior separately | none of named host/VM hazards directly detected; transitive closure unproven | P257:5, P263:12 | none found in static import scan |
| F112 packages/tool-portal/src/tool-portal-invocation-contracts.ts:1 [O bounded source + S declarations/imports] | Managed Gateway and standalone invocation-options type/schema union | I SPLIT: managed wrapper stays execution; generic tool-access/contracts invocation | adapt: Remove generic dependency on gateway-control schemas; preserve old managed wire schema via adapter; retire legacy standalone branch | @agent-vm/gateway-control-contracts:5 | P239:5, P254:33, P271:35, P272:70, P272:101 | P7:44 |
| F113 packages/tool-portal/src/tool-portal-result-router.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Route/group calls and merge discovery results across backend ports | I tool-portal/dispatch (managed authority adapter external) | adapt: Inject UUID and host-neutral invocation/dispatch context; preserve ordering/partial/ambiguous outcome algebra | node:crypto:1; @agent-vm/gateway-control-contracts:31 | P240:3, P239:5, P271:35, P259:26, P272:79, P272:100, P242:19, P103:26 | P117:34, P264:12, P262:9, P135:30, P104:18, P119:32 |
| F114 packages/tool-portal/src/tool-portal-service-common.ts:1 [O bounded source + S declarations/imports] | Shared policy composition, discovery metadata, diagnostics and hashes re-export | I SPLIT: tool-access/authorization; tool-portal/dispatch projections; managed Google facts external | adapt: Extract pure rules; remove hash re-export/host-linked config; retain invocation-dependent CLI and Google evaluation supplied by owner | config-contracts root transitive fs/net/crypto | P259:32, P272:86 | P268:16, P236:10 |
| F115 packages/tool-portal/src/tool-portal-service-test-fixture.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Managed service/approval/backend test fixture | I stays in agent-vm/execution testing + portable dispatch fixture subset | adapt: Retain managed reservation/generation/principal tests in integration owner; portable tests use new contracts, not fake Gateway epochs | @agent-vm/gateway-control-contracts:33; config-contracts root transitive fs/net/crypto | none found in static import scan | P269:10, P266:20, P265:14, P270:23, P17:53, P25:32, P53:37 |
| F116 packages/tool-portal/src/tool-portal-service.ts:1 [O bounded source + S declarations/imports] | Managed dispatch core, approval/OAuth/backend ports and trusted-context validation | I SPLIT: tool-portal/dispatch neutral interfaces/orchestration; managed validation/approval bridge stays execution | adapt: Replace GatewayRuntime authority types at portable edge; keep principal/config/snapshot/final-admission checks externally; do not move approval authority | @agent-vm/gateway-control-contracts:49; config-contracts root transitive fs/net/crypto | P115:14, P118:1, P258:21, P240:8, P239:5, P133:13, P120:10, P254:34, P132:1, P271:35, P259:46, P242:19, P98:39, P103:26, P96:32, P94:10, P136:26, P123:9, P130:8, P50:62, P49:23 | P117:34, P134:15, P7:44, P266:28, P270:24, P262:9, P243:16, P135:30, P97:12, P104:18, P108:18, P99:16, P119:32, P17:37, P25:23, P110:9, P124:5, P127:43, P131:6, P53:30 |
| F117 packages/tool-portal/tsdown.config.ts:1 [O bounded source + S declarations/imports] | Tool Portal mixed-entry build map | I tool-portal + tool-access + tool-host-node build configs | rewrite: New explicit exports; packed closure lint forbids managed/host roots; remove old public root compatibility exports | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |

Per-public-symbol rows (overloads/re-export aliases deduplicated to source declaration; public routes E#):

| Current path/export | What it does | Target (I) | Port kind/change (I) | Host/VM deps | Current consumers (S) | Tests to carry/adapt |
|---|---|---|---|---|---|---|
| F89:15 CliAllowanceEvaluationResult [E1] | type contract; responsibility =F89 | =F89 | =F89 | =F89 | P239:1, P233:1 | =F89 |
| F89:35 EvaluateCliAllowanceInvocationProps [E1] | type contract; responsibility =F89 | =F89 | =F89 | =F89 | P239:1, P233:1 | =F89 |
| F89:47 CliAllowanceInvocationValidation [E1] | type contract; responsibility =F89 | =F89 | =F89 | =F89 | P239:1, P233:1 | =F89 |
| F89:57 validateCliAllowanceInvocation [E1] | function/API; responsibility =F89 | =F89 | =F89 | =F89 | P239:1, P234:3, P233:1, P267:25, P36:27, P98:39, P22:44 | =F89 |
| F89:95 evaluateCliAllowanceInvocation [E1] | function/API; responsibility =F89 | =F89 | =F89 | =F89 | P239:1, P234:3, P233:1, P232:3, P230:3, P3:21, P267:25, P33:7 | =F89 |
| F91:31 CliArgvTokenSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:32 CliPatternRuleSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:33 CliFlagNameSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:34 CliFlagRuleSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:35 CliInvocationFlagPredicateSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:36 CliInvocationMatcherSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:37 CliInvocationCallPolicySchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:38 CliInvocationDispositionSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:39 CliAllowedCommandSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:40 CliStdinPolicySchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:41 CliTimeoutPolicySchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:42 CliAllowanceSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P232:3, P230:3, P260:3, P261:4 | =F91 |
| F91:43 QuickCliAllowanceInputSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P230:3 | =F91 |
| F91:44 OpenCliAllowanceInputSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P230:3 | =F91 |
| F91:45 CliAllowanceInputSchema [E1] | validation schema; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P232:3, P230:3 | =F91 |
| F91:47 CliPatternRule [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3 | =F91 |
| F91:48 CliFlagRule [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3 | =F91 |
| F91:49 CliInvocationCallPolicy [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:50 CliInvocationDisposition [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3 | =F91 |
| F91:51 CliInvocationFlagPredicate [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3 | =F91 |
| F91:52 CliInvocationMatcher [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3 | =F91 |
| F91:53 CliAllowedCommand [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3 | =F91 |
| F91:54 CliStdinPolicy [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:55 CliTimeoutPolicy [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:56 CliAllowance [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3, P232:3, P260:3 | =F91 |
| F91:57 CliAllowanceInput [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3 | =F91 |
| F91:58 CliAllowanceBaseline [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P231:3, P232:3 | =F91 |
| F91:60 ResolvedCliAllowanceTimeout [E1] | type contract; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2 | =F91 |
| F91:62 resolveCliAllowanceTimeout [E1] | function/API; responsibility =F91 | =F91 | =F91 | =F91 | P239:1, P233:2, P230:3, P33:7, P55:6 | =F91 |
| F93:31 resolveGoogleAccountInvocationPolicy [E2] | function/API; responsibility =F93 | =A1 | =A1 | =F93 | P239:2, P238:3, P22:44 | =F93 |
| F97:28 CreateManagedToolPortalMcpProviderBackendPortProps [E2] | type contract; responsibility =F97 | =F97 | =F97 | =F97 | P239:3, P241:1 | =F97 |
| F97:34 CreateStandaloneV1ToolPortalMcpProviderBackendPortProps [E2] | type contract; responsibility =F97 | =F97 | =F97 | =F97 | P239:3, P241:1 | =F97 |
| F97:40 CreateToolPortalMcpProviderBackendPortProps [E2] | type contract; responsibility =F97 | =F97 | =F97 | =F97 | P239:3, P241:1 | =F97 |
| F97:240 createToolPortalMcpProviderBackendPort [E2] | function/API; responsibility =F97 | =F97 | =F97 | =F97 | P239:3, P241:1, P243:20, P128:25 | =F97 |
| F100:5 TOOL_PORTAL_MCP_BEARER_AUDIENCE [E3] | exported value; responsibility =F100 | =F100 | =F100 | =F100 | P258:17, P239:4, P252:10, P244:1, P247:3, P250:5, P255:7, P248:5, P59:5 | =F100 |
| F100:6 maximumStandaloneToolPortalBearerTokenCharacters [E3] | exported value; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P244:1 | =F100 |
| F100:30 StandaloneToolPortalBearerCredential [E3] | type contract; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P244:1 | =F100 |
| F100:33 StandaloneToolPortalBearerCredentialSet [E3] | type contract; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P252:10, P249:18, P244:1, P247:3, P253:13, P250:5, P251:4, P248:5 | =F100 |
| F100:37 CompiledStandaloneToolPortalCredential [E3] | type contract; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P244:1, P253:13 | =F100 |
| F100:45 StandaloneToolPortalAuthenticatedPrincipalSchema [E3] | validation schema; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P244:1 | =F100 |
| F100:54 StandaloneToolPortalAuthenticatedPrincipal [E3] | type contract; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P244:1 | =F100 |
| F100:58 StandaloneToolPortalAuthenticatedEnvelopeSchema [E3] | validation schema; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P257:4, P244:1, P256:4, P245:5 | =F100 |
| F100:66 StandaloneToolPortalAuthenticatedEnvelope [E3] | type contract; responsibility =F100 | =F100 | =F100 | =F100 | P258:17, P239:4, P244:1, P254:36, P251:4, P255:7, P256:4 | =F100 |
| F100:70 StandaloneToolPortalCredentialSetState [E3] | type contract; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F100:77 StandaloneToolPortalFixedCredentialPrincipal [E3] | type contract; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P244:1, P59:5 | =F100 |
| F100:83 fixedStandaloneToolPortalCredentialPrincipals [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F100:98 assertStandaloneToolPortalCredentialPrincipalsUnchanged [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F100:135 compileStandaloneToolPortalCredentialSet [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P247:3, P253:13 | =F100 |
| F100:174 parseStandaloneToolPortalBearerToken [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F100:197 authenticateStandaloneToolPortalRequest [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F100:212 finishStandaloneToolPortalCredentialRequest [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F100:221 waitForStandaloneToolPortalCredentialDrain [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P244:1 | =F100 |
| F100:228 waitForStandaloneToolPortalCredentialDrainDeadline [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F100:249 activeCredentialVersionsByAgent [E3] | function/API; responsibility =F100 | =F100 | =F100 | =F100 | P239:4, P249:18, P244:1, P253:13 | =F100 |
| F99:7 STANDALONE_TOOL_PORTAL_APPROVAL_AUDIENCE [E3] | exported value; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2, P246:5 | =F99 |
| F99:8 STANDALONE_TOOL_PORTAL_APPROVAL_META_KEY [E3] | exported value; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2, P254:35 | =F99 |
| F99:31 StandaloneToolPortalApprovalBatchIntentSchema [E3] | validation schema; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2 | =F99 |
| F99:49 StandaloneToolPortalApprovalBatchIntent [E3] | type contract; responsibility =F99 | =F99 | =F99 | =F99 | P258:13, P239:4, P244:2, P246:5, P270:9, P259:15 | =F99 |
| F99:69 StandaloneToolPortalApprovalCredential [E3] | type contract; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2 | =F99 |
| F99:75 StandaloneToolPortalApprovalReservation [E3] | type contract; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2 | =F99 |
| F99:84 StandaloneToolPortalApprovalAdmission [E3] | type contract; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2 | =F99 |
| F99:111 StandaloneToolPortalApprovalArmResult [E3] | type contract; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2, P272:65 | =F99 |
| F99:125 StandaloneToolPortalApprovalCoordinator [E3] | type contract; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2, P246:5, P259:15, P272:65 | =F99 |
| F99:188 deriveStandaloneToolPortalApprovalBatchFingerprint [E3] | function/API; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2, P246:5, P259:15 | =F99 |
| F99:204 createStandaloneToolPortalApprovalToken [E3] | function/API; responsibility =F99 | =F99 | =F99 | =F99 | P239:4, P244:2, P246:5, P270:9 | =F99 |
| F99:286 createStandaloneToolPortalApprovalCoordinator [E3] | function/API; responsibility =F99 | =F99 | =F99 | =F99 | P258:13, P239:4, P244:2, P246:5 | =F99 |
| F104:39 StartStandaloneToolPortalMcpHttpServerProps [E3] | type contract; responsibility =F104 | =F104 | =F104 | =F104 | P239:4, P244:3 | =F104 |
| F104:50 StandaloneToolPortalMcpHttpServer [E3] | type contract; responsibility =F104 | =F104 | =F104 | =F104 | P239:4, P252:14, P244:3, P251:12, P59:5 | =F104 |
| F104:125 startStandaloneToolPortalMcpHttpServer [E3] | function/API; responsibility =F104 | =F104 | =F104 | =F104 | P239:4, P252:14, P244:3, P251:12, P59:5 | =F104 |
| F103:25 StartStandaloneToolPortalEntrypointsProps [E3] | type contract; responsibility =F103 | =F103 | =F103 | =F103 | P239:4, P244:4 | =F103 |
| F103:34 StandaloneToolPortalEntrypoints [E3] | type contract; responsibility =F103 | =F103 | =F103 | =F103 | P239:4, P244:4 | =F103 |
| F103:92 startStandaloneToolPortalEntrypoints [E3] | function/API; responsibility =F103 | =F103 | =F103 | =F103 | P239:4, P244:4, P250:9 | =F103 |
| F102:36 STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER [E3] | exported value; responsibility =F102 | =F102 | =F102 | =F102 | P239:4, P244:5, P248:9 | =F102 |
| F102:48 StartStandaloneToolPortalHttpServerProps [E3] | type contract; responsibility =F102 | =F102 | =F102 | =F102 | P239:4, P244:5 | =F102 |
| F102:58 StandaloneToolPortalHttpServer [E3] | type contract; responsibility =F102 | =F102 | =F102 | =F102 | P239:4, P244:5, P251:8, P248:9 | =F102 |
| F102:118 startStandaloneToolPortalHttpServer [E3] | function/API; responsibility =F102 | =F102 | =F102 | =F102 | P239:4, P244:5, P251:8, P248:9 | =F102 |
| F105:38 STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES [E3] | exported value; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P252:18, P244:6, P255:11 | =F105 |
| F105:47 StandaloneToolPortalArtifactReadCaller [E3] | type contract; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P244:6 | =F105 |
| F105:52 StandaloneToolPortalInvocationOptions [E3] | type contract; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P244:6 | =F105 |
| F105:60 StandaloneToolPortalProjectionService [E3] | type contract; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P252:18, P249:34, P244:6, P253:30, P250:10, P251:16, P255:11, P256:8, P248:14, P59:5 | =F105 |
| F105:95 createStandaloneToolPortalProjectionService [E3] | function/API; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P244:6, P270:13 | =F105 |
| F105:110 StandaloneToolPortalArtifactReader [E3] | type contract; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P252:18, P244:6, P253:30, P251:16, P256:8, P59:5 | =F105 |
| F105:159 createStandaloneToolPortalMcpServer [E3] | function/API; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P244:6, P253:30, P256:8 | =F105 |
| F105:252 createStandaloneToolPortalTransportBridge [E3] | function/API; responsibility =F105 | =F105 | =F105 | =F105 | P239:4, P244:6, P253:30 | =F105 |
| F106:14 StartStandaloneToolPortalMcpStdioServerProps [E3] | type contract; responsibility =F106 | =F106 | =F106 | =F106 | P239:4, P244:7 | =F106 |
| F106:21 StandaloneToolPortalMcpStdioServer [E3] | type contract; responsibility =F106 | =F106 | =F106 | =F106 | P239:4, P244:7, P251:20 | =F106 |
| F106:34 startStandaloneToolPortalMcpStdioServer [E3] | function/API; responsibility =F106 | =F106 | =F106 | =F106 | P239:4, P244:7, P251:20, P255:15 | =F106 |
| F107:7 ToolPortalStandaloneServiceInvocationOptionsSchema [E3] | validation schema; responsibility =F107 | =F107 | =F107 | =F107 | P239:4, P239:5, P244:8, P259:20, P272:101, P263:14 | =F107 |
| F107:22 ToolPortalStandaloneServiceInvocationOptions [E3] | type contract; responsibility =F107 | =F107 | =F107 | =F107 | P239:4, P239:5, P244:8, P254:33, P259:20, P272:70, P272:101, P263:8, P263:14 | =F107 |
| F107:35 ToolPortalStandaloneSemanticSnapshotSchema [E3] | validation schema; responsibility =F107 | =F107 | =F107 | =F107 | P239:4, P239:5, P244:8, P259:20, P272:101, P263:14 | =F107 |
| F107:57 ToolPortalStandaloneSemanticSnapshot [E3] | type contract; responsibility =F107 | =F107 | =F107 | =F107 | P258:21, P239:4, P239:5, P244:8, P270:24, P259:20, P272:70, P272:101, P263:8, P263:14 | =F107 |
| F109:227 createStandaloneV1ToolPortalService [E3] | function/API; responsibility =F109 | =F109 | =F109 | =F109 | P239:4, P244:9, P272:69 | =F109 |
| F112:16 ToolPortalManagedServiceInvocationOptionsSchema [E2] | validation schema; responsibility =F112 | =A2 | =A2 | =F112 | P239:5, P272:70, P272:101 | =F112 |
| F112:29 ToolPortalManagedServiceInvocationOptions [E2] | type contract; responsibility =F112 | =A2 | =A2 | =F112 | P239:5, P7:44, P271:35, P272:70, P272:101 | =F112 |
| F112:33 ToolPortalServiceInvocationOptions [E2] | type contract; responsibility =F112 | =A2 | =A2 | =F112 | P239:5, P272:101 | =F112 |
| F112:37 ToolPortalServiceMode [E2] | type contract; responsibility =F112 | =A2 | =A2 | =F112 | P239:5, P272:70, P272:101 | =F112 |
| F112:39 ToolPortalSemanticSnapshot [E2] | type contract; responsibility =F112 | =A2 | =A2 | =F112 | P239:5, P272:70, P272:101 | =F112 |
| F112:44 ToolPortalInvocationOptionsForMode [E2] | type contract; responsibility =F112 | =A2 | =A2 | =F112 | P239:5, P272:70, P272:101 | =F112 |
| F116:102 ToolPortalTrustedInvocationContext [E2] | type contract; responsibility =F116 | =A3 | =A3 | =F116 | P134:15, P239:5, P271:35, P135:30 | =F116 |
| F116:104 ToolPortalBackendCallOptions [E2] | type contract; responsibility =F116 | =A4 | =A4 | =F116 | P117:34, P239:5, P7:44, P262:9, P271:35, P97:12, P104:18, P103:26, P108:18, P99:16, P119:32 | =F116 |
| F116:110 ToolPortalBackendPort [E2] | type contract; responsibility =F116 | =A4 | =A4 | =F116 | P118:1, P117:34, P134:15, P239:5, P133:13, P7:44, P262:9, P271:35, P242:19, P135:30, P98:39, P97:12, P104:18, P103:26, P96:32, P119:32, P17:37, P123:9, P127:43, P131:6, P130:8, P50:62, P53:30, P49:23 | =F116 |
| F116:130 ToolPortalStandaloneMcpDispatchAuthority [E2] | type contract; responsibility =F116 | =A5 | =A5 | =F116 | P239:5, P259:46, P242:19 | =F116 |
| F116:147 ToolPortalStandaloneMcpBackendInvocationOptions [E2] | type contract; responsibility =F116 | =A5 | =A5 | =F116 | P239:5, P259:46, P242:19, P243:16 | =F116 |
| F116:155 ToolPortalStandaloneMcpBackendReadOptions [E2] | type contract; responsibility =F116 | =A5 | =A5 | =F116 | P239:5, P259:46, P242:19, P243:16 | =F116 |
| F116:162 ToolPortalStandaloneMcpBackendPort [E2] | type contract; responsibility =F116 | =A5 | =A5 | =F116 | P258:21, P239:5, P242:19 | =F116 |
| F116:182 ToolPortalApprovalPort [E2] | type contract; responsibility =F116 | =A6 | =A6 | =F116 | P115:14, P118:1, P117:34, P134:15, P239:5, P133:13, P271:35, P135:30, P98:39, P94:10, P99:16, P136:26, P119:32, P123:9, P124:5, P50:62, P49:23 | =F116 |
| F116:191 ToolPortalOAuthAvailabilityPort [E2] | type contract; responsibility =F116 | =A6 | =A6 | =F116 | P239:5, P120:10, P123:9 | =F116 |
| F116:204 ToolPortalCapabilityCore [E2] | type contract; responsibility =F116 | =A3 | =A3 | =F116 | P117:34, P134:15, P239:5, P7:44, P132:1, P271:35, P259:46, P135:30, P136:26, P119:32, P110:9 | =F116 |
| F116:230 ToolPortalCatalogDefinition [E2] | type contract; responsibility =F116 | =A3 | =A3 | =F116 | P240:8, P239:5 | =F116 |
| F116:237 ToolPortalCatalogPreparationResult [E2] | type contract; responsibility =F116 | =A3 | =A3 | =F116 | P240:8, P239:5 | =F116 |
| F116:241 ToolPortalService [E2] | type contract; responsibility =F116 | =A3 | =A3 | =F116 | P239:5, P254:34, P132:1, P259:46 | =F116 |
| F116:246 CreateManagedToolPortalCapabilityCoreProps [E2] | type contract; responsibility =F116 | =A3 | =A3 | =F116 | P118:1, P239:5 | =F116 |
| F116:321 CreateStandaloneV1ToolPortalServiceProps [E2] | type contract; responsibility =F116 | =A5 | =A5 | =F116 | P239:5, P259:46 | =F116 |
| F116:582 createManagedToolPortalCapabilityCore [E2] | function/API; responsibility =F116 | =A3 | =A3 | =F116 | P118:1, P134:15, P239:5, P7:44, P266:28, P271:35, P135:30, P17:37, P25:23, P53:30, P49:23 | =F116 |
| F116:988 createToolPortalService [E2] | function/API; responsibility =F116 | =A3 | =A3 | =F116 | P258:21, P239:5, P270:24 | =F116 |
| F113:33 ToolPortalInvocationOptions [E2] | type contract; responsibility =F113 | =F113 | =F113 | =F113 | P117:34, P240:3, P239:5, P262:9, P271:35, P272:79, P272:100, P242:19, P135:30, P104:18, P103:26, P119:32 | =F113 |
| F92:34 deterministicOperationId [E4] | function/API; responsibility =F92 | =F92 | =F92 | =F92 | P3:22, P4:15, P267:21, P259:32, P272:86, P48:18 | =F92 |
| F92:61 directDispatchFingerprint [E4] | function/API; responsibility =F92 | =F92 | =F92 | =F92 | P3:22, P4:15, P267:21, P259:32, P272:86, P48:18 | =F92 |
| F110:8 CreateToolPortalConfigFixtureProps [E5] | type contract; responsibility =F110 | =F110 | =F110 | =F110 | none found | =F110 |
| F110:15 CreateCliAllowanceFixtureProps [E5] | type contract; responsibility =F110 | =F110 | =F110 | =F110 | none found | =F110 |
| F110:19 createToolPortalConfigFixture [E5] | function/API; responsibility =F110 | =F110 | =F110 | =F110 | P261:5 | =F110 |
| F110:52 createCliAllowanceFixture [E5] | function/API; responsibility =F110 | =F110 | =F110 | =F110 | P261:5 | =F110 |



## mcp-portal

📚 ResearcherHandback port inventory — mcp-portal (48 files; 233 public symbols).

Legend from the overview applies: I = inferred placement; S = source scanner evidence; O = bounded surrounding code opened. F# gives exact path; P# consumer/test path; A# specialized placement; E# existing public export route(s). Every “=F#/A#” expands to that row’s full target/change/dependency/test cell. No runtime/portability proof claimed. Tests are existing statically linked candidates, not passing runs.

| Current path | What it does (responsibility; I) | Target (I) | Port kind/change (I) | Host/VM dependencies (S/O) | Current consumers (S) | Tests to carry/adapt (S candidates) |
|---|---|---|---|---|---|---|
| F31 packages/mcp-portal/src/bin/mcp-portal-command-dispatcher.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | CLI command dispatch, filesystem catalog/config artifacts and process lifecycle | I tool-host-node/cli | adapt: Compose new gateway/connectors instead of old mixed root; retire legacy approval mint/admission command paths | node:fs/promises:3; node:path:4; process.stderr.write(text); [66]; stderr: process.stderr, [82]; process.stderr.write( [137]; process.stderr.write( [148]; process.stdout.write(`${JSON.stringify(clientConfig, null, '\t')}\n`); [214]; process.stderr.write(`${event.message}\n`); [299]; process.stderr.write(`${message}\n`); [305]; process.stderr.write(`upstream notification ${event.method}\n`); [309]; process.stdout.write(`${JSON.stringify(result, null, '\t')}\n`); [383]; env: props.env ?? process.env, [411]; process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); [462]; config-contracts root transitive fs/net/crypto | P139:8 | P140:21 |
| F32 packages/mcp-portal/src/bin/mcp-portal.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Executable MCP Portal CLI bootstrap | I tool-host-node/cli | adapt: Rename CLI/entry imports as selected; process argv/exit handling stays Node | node:path:3; if (shouldRunMcpPortalEntrypoint(process.argv[1])) { [19]; process.exitCode = await runMcpPortalCommandWithProcessLogging(command); [26] | none found in static import scan | P140:27 |
| F33 packages/mcp-portal/src/bin/secret-value-resolver.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Resolve configured secret references for CLI | I tool-host-node/secrets | adapt: Keep resolver implementation outside portable contracts; import references through new schema home | config-contracts root transitive fs/net/crypto | P154:24, P137:44 | P142:5 |
| F34 packages/mcp-portal/src/catalog-types.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Catalog tool metadata/annotations schemas | I tool-access/contracts/catalog | move as-is: Keep annotation and metadata validation identical; annotation is data, not new trust | none of named host/VM hazards directly detected; transitive closure unproven | P170:1, P188:3, P199:1, P191:5, P193:1, P161:1, P166:4, P196:1, P137:15 | P182:3, P144:3, P160:4 |
| F35 packages/mcp-portal/src/catalog-typescript/catalog-tool-presentation-name.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Stable generated native-tool presentation names using hash | I tool-portal/mcp-gateway/catalog via injected hash; Node build implementation | adapt: Replace Node crypto dependency with injected hashing or host-generated exact names; preserve generated-name bytes | node:crypto:1 | P165:4, P145:12, P150:3 | none found in static import scan |
| F36 packages/mcp-portal/src/catalog-typescript/catalog-typescript-compiler.ts:1 [O bounded source + S declarations/imports] | Generate/fingerprint TypeScript tool modules and native manifest | I tool-host-node/catalog-build; shared types in tool-access/contracts | adapt: Node crypto/Buffer and declaration compiler are not Worker admission imports; inject prepared bundle/catalog port into portable runtime | node:crypto:1; byteLength: Buffer.byteLength(source), [384] | P150:1, P112:16 | P147:10, P146:4 |
| F37 packages/mcp-portal/src/catalog-typescript/catalog-typescript-types.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Generated catalog input/bundle/manifest TypeScript interfaces | I tool-access/contracts/catalog | move as-is: No compiler side effects in contract entry; preserve SDK wire/version meaning | none of named host/VM hazards directly detected; transitive closure unproven | P145:13, P150:2, P112:16 | P147:11, P113:3, P111:1 |
| F38 packages/mcp-portal/src/catalog-typescript/declaration-fragment-validation.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Validate declaration-only generated fragments via TypeScript compiler | I tool-host-node/catalog-build | move as-is: Build-time validator/compiler stays out of Worker dispatch closure | typescript compiler import:1 (build concern) | P145:21 | P149:3 |
| F39 packages/mcp-portal/src/catalog-typescript/index.ts:1 [O bounded source + S declarations/imports] | Catalog compiler/types export barrel | I retire (mixed root); explicit contracts and Node compiler entrypoints | retire: Update catalog generation imports; do not re-export compiler through portable contracts | none of named host/VM hazards directly detected; transitive closure unproven | P112:16 | P113:3, P111:1 |
| F40 packages/mcp-portal/src/catalog-typescript/safe-schema-projection.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Safe JSON Schema projection for generated declarations | I tool-host-node/catalog-build (candidate portable utility) | move as-is: No need to import compiler into runtime; optional pure helper extraction only if a real Worker consumer needs it | none of named host/VM hazards directly detected; transitive closure unproven | P145:22 | none found in static import scan |
| F41 packages/mcp-portal/src/cli/index.ts:1 [O bounded source + S declarations/imports] | Node portal-server export barrel | I tool-host-node/cli | adapt: Stop re-exporting legacy auth/key plumbing; consume new host composer | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |
| F42 packages/mcp-portal/src/cli/mcp-portal-cli-parser.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | MCP Portal CLI command parser and Zod option projection | I tool-host-node/cli | adapt: Keep parser semantics and desired non-legacy operations; update command owners, retire old proof input options | none of named host/VM hazards directly detected; transitive closure unproven | P139:7, P137:16 | P153:10, P140:12 |
| F43 packages/mcp-portal/src/cli/portal-server-operation.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Node server composition, profiles, secrets and HMAC-derived keys | I tool-host-node/composition | adapt: Split pure policy projection; replace legacy HMAC approval trust/derivation and compose injected interfaces | node:crypto:1; node:path:2; @hono/node-server:22; process.stdout.write(`listening port=${String(info.port)}\n`); [521]; config-contracts root transitive fs/net/crypto | P152:1, P155:13, P137:17 | P156:6, P157:12, P195:10 |
| F44 packages/mcp-portal/src/cli/process-logging.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Process LogTape logger/stream lifecycle | I tool-host-node/observability | move as-is: Node Writable/process stream adapter only; portable runtime receives logger/event port | node:stream:1; // LogTape disposes this proxy-owned stream without closing process.stderr. [47] | P154:37, P137:24 | P156:7, P157:19 |
| F45 packages/mcp-portal/src/core/index.ts:1 [O bounded source + S declarations/imports] | Core barrel re-exporting runtime and legacy evaluator | I retire (mixed root); explicit dispatch/connector/rule exports | retire: Core consumers update imports; approval evaluator retirement must not delete shared core functions | none of named host/VM hazards directly detected; transitive closure unproven | P40:37, P174:32, P174:37, P62:17 | P173:6, P175:11 |
| F46 packages/mcp-portal/src/core/portal-approval-evaluator.ts:1 [O bounded source + S declarations/imports] | Legacy profile approval policy plus HMAC proof verifier | I retire (legacy approval mechanism); pure disposition already goes to authorization | retire: Remove evaluator/options/replay-key admission at hard cutover; retain classification and shared argument-digest utility separately | config-contracts root transitive fs/net/crypto | P181:9, P158:2 | P164:8, P160:7 |
| F47 packages/mcp-portal/src/core/portal-call-validation.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Validate tool arguments through JSON Schema→Zod converter | I tool-portal/dispatch/validation | adapt: Import pure contracts; injected validator seam if pinned converter closure cannot run on Worker; preserve failure reasons | none of named host/VM hazards directly detected; transitive closure unproven | P158:3, P166:19 | none found in static import scan |
| F48 packages/mcp-portal/src/core/portal-core-validation.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Validate JSON-compatible Core values | I tool-access/contracts/json validation | move as-is: Keep accepted JSON and depth/value behavior; consolidate duplicate guards deliberately | none of named host/VM hazards directly detected; transitive closure unproven | P165:21 | P163:3 |
| F49 packages/mcp-portal/src/core/portal-core.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Core catalog/descriptors, result collection and runtime orchestration | I tool-portal/mcp-gateway/core | adapt: Replace Buffer byte counting, legacy approval evaluator and local identity assumptions with portable ports; retain errors/results/progress; inspect transitive portal-tools/catalog generator closure before Worker acceptance | const byteLength = Buffer.byteLength(serialized, 'utf8'); [427] | P178:7, P179:9, P154:25, P158:4, P174:32, P174:37, P137:29 | P177:9, P180:6, P164:9, P173:6, P175:11 |
| F50 packages/mcp-portal/src/core/portal-tools.ts:1 [O bounded source + S declarations/imports] | Batch tool input schemas, validation, approvals and upstream call handlers | I tool-portal/mcp-gateway + dispatch; contracts in tool-access | adapt: Separate wire schemas from handlers; retire HMAC token proof fields/decisions only in selected legacy family; keep shared hashCallArguments consumer; extract runtime catalog/declaration generation behind a prepared-catalog port so moving Node generator alone actually severs core import | none of named host/VM hazards directly detected; transitive closure unproven | P181:10, P179:18, P165:22, P158:5, P159:6, P174:37 | P167:9, P164:16, P160:8 |
| F51 packages/mcp-portal/src/core/provider-runtime.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Resolve upstream server definitions | I tool-portal/connectors/config projection | adapt: Separate stdio from HTTP portable server definitions; remove config host-root dependency | config-contracts root transitive fs/net/crypto | P154:26, P158:1, P174:32, P137:30, P62:17 | P169:3 |
| F52 packages/mcp-portal/src/index.ts:1 [O bounded source + S declarations/imports] | MCP Portal mixed root | I retire; replace tool-portal/mcp-gateway and connectors explicit entrypoints | retire: Update all root import consumers; portable root cannot re-export Node transport/catalog compiler/auth | none of named host/VM hazards directly detected; transitive closure unproven | P62:11 | P60:5 |
| F53 packages/mcp-portal/src/json-schema.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Duplicate JSON value/object schemas and guards | I tool-access/contracts/json | adapt: Consolidate with config-contracts/json-value only after behavior comparison; update consumers, do not silently change serialized schema | none of named host/VM hazards directly detected; transitive closure unproven | P202:15, P170:2, P207:3, P199:2, P143:3, P205:1, P193:2, P165:5, P161:2, P166:5, P162:1, P196:2, P62:11, P151:3, P145:10, P148:7 | P182:4, P208:3, P160:5, P171:3 |
| F54 packages/mcp-portal/src/mcp-provider-backend/index.ts:1 [O bounded source + S declarations/imports] | Concrete MCP provider backend barrel | I tool-host-node/adapters (current concrete implementation); portable connector interface | adapt: Backend implementations stay host compositions; portable Tool Portal exports backend contracts only | none of named host/VM hazards directly detected; transitive closure unproven | P242:14, P128:21 | P173:3, P175:13, P243:10, P127:42 |
| F55 packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Concrete MCP provider capability backend/session factory | I tool-host-node/adapters; reusable HTTP protocol logic tool-portal/connectors | adapt: Remove Node UUID dependency via host injection; separate managed projection/session ownership and actual outbound MCP protocol | node:crypto:1; config-contracts root transitive fs/net/crypto | P172:1, P242:14, P128:21 | P173:3, P175:13, P243:10, P127:42 |
| F56 packages/mcp-portal/src/mcp-provider-backend/mcp-provider-model-errors.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Safe MCP provider errors/diagnostics projection | I tool-portal/connectors/errors | move as-is: Keep redacted failure classes; exact input/diagnostic schema imports portable | none of named host/VM hazards directly detected; transitive closure unproven | P174:47 | none found in static import scan |
| F57 packages/mcp-portal/src/mcp-proxy/index.ts:1 [O bounded source + S declarations/imports] | Mixed MCP proxy export barrel | I retire; Node serving vs portable MCP projection exports | retire: Do not reach Node auth/conninfo from gateway root | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |
| F58 packages/mcp-portal/src/mcp-proxy/portal-http-server.ts:1 [O bounded source + S declarations/imports] | Authenticated Node HTTP MCP sessions, limits and audit hooks | I tool-host-node/listeners; portable request-binding port used by Cloudflare separately | adapt: Node conninfo/randomUUID/Buffer auth split from MCP handler; Cloudflare supplies Access/DO rather than importing this listener | node:crypto:1; @hono/node-server/conninfo:4 | P176:1, P154:27 | P177:21 |
| F59 packages/mcp-portal/src/mcp-proxy/portal-mcp-server.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | MCP tool projection, compact/full catalog and progress | I tool-portal/mcp-gateway | adapt: Inject generic identity/access/dispatch contracts; use Web-standard SDK transport; remove legacy approval token path | none of named host/VM hazards directly detected; transitive closure unproven | P176:2, P178:11 | P180:8 |
| F60 packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Agent fixed-record/HMAC resolution and approval verifier/replay state | I tool-host-node/auth for non-legacy identity plumbing; retire HMAC approval parts | adapt: Split createPortalApprovalVerifier/key trust from identity admission; new verified identity adapter is required, not a renamed local record | return [props.agentId, Buffer.from(secretValue, 'hex')]; [64]; config-contracts root transitive fs/net/crypto | P176:3, P154:28, P137:31 | P182:6 |
| F61 packages/mcp-portal/src/portal-access-policy.ts:1 [O bounded source + S declarations/imports] | Local branded agent identity and pure namespace/tool filtering | I tool-access/contracts + authorization; identity admission adapters stay host/managed | adapt: resolvePortalAccessPolicy moves unchanged over adapted facts; brand constructor is not verified fleet identity; preserve cache/session scoping | none of named host/VM hazards directly detected; transitive closure unproven | P170:3, P178:8, P181:15, P154:34, P191:6, P165:6, P158:6, P166:6, P159:4, P174:46 | P183:3, P192:4, P177:10, P167:3 |
| F62 packages/mcp-portal/src/portal-auth/agent-bearer-token.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Master-key-derived audience bearer tokens and verification | I tool-host-node/auth (legacy route cutover decision tracked) | adapt: Do not confuse bearer auth with approval proof; replace fixed identity binding with selected host auth; no portable Node crypto | node:crypto:1; const masterKey = Buffer.from(trimmedMasterKey, 'base64url'); [34]; const leftBuffer = Buffer.from(left); [67]; const rightBuffer = Buffer.from(right); [68] | P178:9, P154:35, P137:36 | P177:14, P157:11, P184:3, P195:14, P140:13, P138:15 |
| F63 packages/mcp-portal/src/portal-auth/hmac-env.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Environment HMAC approval-key discovery | I retire (legacy approval-key plumbing) | retire: Account for CLI/server resolver/test consumers; environment access belongs host if any independent nonapproval use remains | keysByAgent.set(agentId, Buffer.from(value, 'hex')); [20] | P137:41 | P185:3 |
| F64 packages/mcp-portal/src/portal-auth/hmac-token.ts:1 [O bounded source + S declarations/imports] | Legacy HMAC approval tokens plus shared argument canonicalization/hash | I SPLIT: retire proof APIs; preserve argument hashing via host-neutral crypto port/host helper | adapt: hashCallArguments is still used by shared portal-tools; cannot delete whole module with signer/verifier without replacing that import | node:crypto:1; const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : value; [81]; JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8')), [131]; const providedSignature = Buffer.from(signatureEncoded, 'base64url'); [179] | P166:11, P159:5 | P182:5, P186:5, P195:15, P164:5, P160:6, P138:16 |
| F65 packages/mcp-portal/src/portal-config/index.ts:1 [O bounded source + S declarations/imports] | Catalog artifact/schema-loader barrel | I retire (mixed barrel); explicit host build/portable validation entries | retire: Track both schema-loader and generator consumers; no host generator export in Worker root | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |
| F66 packages/mcp-portal/src/portal-config/typescript-artifact.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Generate TypeScript catalog artifact/fingerprint | I tool-host-node/catalog-build | adapt: Preserve emitted declaration/fingerprint behavior; inject hash if sharing pure text generator is useful | node:crypto:1 | P187:1, P166:12, P137:42 | P189:3 |
| F67 packages/mcp-portal/src/portal-config/zod-schema-loader.ts:1 [O bounded source + S declarations/imports] | Alias export of shared schema loader | I retire alias; canonical tool-portal/dispatch/validation import | retire: Hard-cut exported alias consumers; no compatibility barrel | none of named host/VM hazards directly detected; transitive closure unproven | P187:2 | none found in static import scan |
| F68 packages/mcp-portal/src/portal-session.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Catalog discovery/session pooling and access-scoped cache | I tool-portal/connectors/sessions | adapt: Inject hash/clock/session owner and portable access facts; retain close/error/cache isolation semantics | node:crypto:1 | P170:4, P178:10, P165:13, P166:13 | P192:9, P167:7, P164:6 |
| F69 packages/mcp-portal/src/search-index.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Catalog search ranking/index | I tool-portal/mcp-gateway/discovery | move as-is: Update contract imports only; preserve ordering/filter semantics | none of named host/VM hazards directly detected; transitive closure unproven | P170:5, P191:13, P166:14 | P194:3 |
| F70 packages/mcp-portal/src/testing/fake-upstream-mcp-server.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Node HTTP fake upstream MCP server | I tool-host-node/testing | adapt: Published test-support API stays test-only; use for real host integration tests, not Worker import proof | @hono/node-server:1 | P56:4 | P195:16, P173:7, P201:9, P140:17, P138:17, P51:7, P57:7 |
| F71 packages/mcp-portal/src/tool-graph.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Catalog tool relationship graph | I tool-portal/mcp-gateway/discovery | move as-is: Update metadata contract imports; preserve graph/visibility behavior | none of named host/VM hazards directly detected; transitive closure unproven | P170:6, P191:14, P193:3, P165:20 | P197:3 |
| F72 packages/mcp-portal/src/tool-ref.ts:1 [O bounded source + S declarations/imports] | Encode/decode canonical tool references | I tool-access/contracts/tool-reference codec | adapt: Replace Buffer base64url/UTF-8 with portable codec preserving exact bytes/canonical rejection behavior | const decoded = Buffer.from(segment, 'base64url').toString('utf-8'); [23]; const canonicalSegment = Buffer.from(decoded, 'utf-8').toString('base64url'); [24]; const encodedNamespace = Buffer.from(parsed.namespace, 'utf-8').toString('base64url') [34]; const encodedToolName = Buffer.from(parsed.toolName, 'utf-8').toString('base64url'); [35] | P170:7, P188:4, P199:3, P166:15, P196:3 | P194:4, P198:3, P197:4 |
| F73 packages/mcp-portal/src/tool-summary.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Summarize schema/tool safety and discovery hints | I tool-portal/mcp-gateway/discovery | move as-is: Metadata hints remain advisory; no new policy authority | none of named host/VM hazards directly detected; transitive closure unproven | P170:8, P193:4, P166:16 | P200:3 |
| F74 packages/mcp-portal/src/upstream-mcp-client-runtime.ts:1 [O bounded source + S declarations/imports] | Upstream MCP HTTP/SSE/stdio sessions, timeout/cancel/close/progress | I SPLIT: tool-portal/connectors/http; tool-host-node/connectors/stdio | adapt: Inject transport factory; remove eager StdioClientTransport and process.env inheritance from portable entry; prove pinned SDK Worker closure | @modelcontextprotocol/sdk/client/stdio.js:6; const value = process.env[name]; [269]; const byteLength = Buffer.byteLength(serialized, 'utf8'); [384] | P170:9, P154:36, P203:1, P158:8, P168:9, P174:32, P137:43, P62:11 | P177:15, P173:11, P204:3, P201:13, P60:5 |
| F75 packages/mcp-portal/src/upstream-mcp-errors.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Classify/sanitize upstream transport failures | I tool-portal/connectors/errors | adapt: Use portable remote server contract; retain stdio diagnostic shape in Node adapter if required; preserve URL redaction | none of named host/VM hazards directly detected; transitive closure unproven | P202:16, P170:10, P191:15, P166:17, P166:18, P62:11 | P192:10, P180:7, P167:8, P164:7, P175:12, P204:4 |
| F76 packages/mcp-portal/src/upstream-response-middleware.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Credential-aware response/catalog/error redaction | I tool-portal/connectors/redaction | move as-is: Import credential reference/JSON types from pure home; preserve redaction of exact credential text and config keys | none of named host/VM hazards directly detected; transitive closure unproven | P40:37, P202:23, P170:11, P179:19, P158:7 | P206:3 |
| F77 packages/mcp-portal/src/zod-schema-loader.ts:1 [O bounded source + S declarations/imports] | Bounded JSON Schema→Zod validation construction and unsupported-feature results | I tool-portal/dispatch/validation | adapt: Preserve supported/unsupported schema behavior and issue paths; Worker no-eval/validator closure must be proven, not inferred from no node import | none of named host/VM hazards directly detected; transitive closure unproven | P170:12, P187:2, P190:1, P161:3, P62:11, P145:11 | P208:4 |
| F78 packages/mcp-portal/tsdown.config.ts:1 [O bounded source + S declarations/imports] | MCP multi-entry package build config | I tool-portal + tool-host-node build configs | rewrite: Replace mixed root/auth/CLI/compiler exports with explicit host-free entry closures | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |

Per-public-symbol rows (overloads/re-export aliases deduplicated to source declaration; public routes E#):

| Current path/export | What it does | Target (I) | Port kind/change (I) | Host/VM deps | Current consumers (S) | Tests to carry/adapt |
|---|---|---|---|---|---|---|
| F34:44 portalToolAnnotationsSchema [E6] | validation schema; responsibility =F34 | =F34 | =F34 | =F34 | P170:1 | =F34 |
| F34:55 safeToolMetadataSchema [E6] | validation schema; responsibility =F34 | =F34 | =F34 | =F34 | P170:1 | =F34 |
| F34:71 portalToolRecordSchema [E6] | validation schema; responsibility =F34 | =F34 | =F34 | =F34 | P170:1, P188:3, P199:1, P144:3, P191:5, P193:1, P196:1, P137:15 | =F34 |
| F34:84 PortalToolRecord [E6] | type contract; responsibility =F34 | =F34 | =F34 | =F34 | P170:1, P188:3, P199:1, P182:3, P191:5, P193:1, P161:1, P166:4, P160:4, P196:1, P137:15 | =F34 |
| F34:85 PortalToolAnnotations [E6] | type contract; responsibility =F34 | =F34 | =F34 | =F34 | P170:1 | =F34 |
| F53:3 JsonPrimitive [E6] | type contract; responsibility =F53 | =F53 | =F53 | =F53 | P170:2 | =F53 |
| F53:4 JsonArray [E6] | type contract; responsibility =F53 | =F53 | =F53 | =F53 | P170:2 | =F53 |
| F53:5 JsonObject [E6] | type contract; responsibility =F53 | =F53 | =F53 | =F53 | P202:15, P170:2, P207:3, P199:2, P182:4, P143:3, P193:2, P208:3, P161:2, P166:5, P160:5, P196:2, P151:3, P145:10, P148:7 | =F53 |
| F53:6 JsonValue [E6] | type contract; responsibility =F53 | =F53 | =F53 | =F53 | P170:2, P207:3, P143:3, P205:1, P193:2, P165:5, P162:1, P151:3, P145:10 | =F53 |
| F53:8 jsonValueSchema [E6] | validation schema; responsibility =F53 | =F53 | =F53 | =F53 | P170:2, P171:3 | =F53 |
| F53:19 jsonObjectSchema [E6] | validation schema; responsibility =F53 | =F53 | =F53 | =F53 | P170:2, P143:3, P165:5, P166:5, P171:3 | =F53 |
| F53:21 isJsonObject [E6] | function/API; responsibility =F53 | =F53 | =F53 | =F53 | P170:2 | =F53 |
| F53:25 assertJsonObject [E6] | function/API; responsibility =F53 | =F53 | =F53 | =F53 | P170:2, P171:3, P62:11 | =F53 |
| F61:3 PortalAgentIdentity [E6] | type contract; responsibility =F61 | =F61 | =F61 | =F61 | P170:3, P192:4, P177:10, P178:8, P191:6, P165:6, P166:6, P167:3, P159:4 | =F61 |
| F61:16 PortalAgentScopeSource [E6] | type contract; responsibility =F61 | =F61 | =F61 | =F61 | P170:3, P165:6, P174:46 | =F61 |
| F61:22 PortalToolSelector [E7] | type contract; responsibility =F61 | =F61 | =F61 | =F61 | P170:3, P154:34, P191:6, P158:6, P166:6 | =F61 |
| F61:27 PortalDefaultPolicy [E6] | type contract; responsibility =F61 | =F61 | =F61 | =F61 | P170:3 | =F61 |
| F61:29 PortalAccessPolicyConfig [E6] | type contract; responsibility =F61 | =F61 | =F61 | =F61 | P170:3, P191:6, P165:6 | =F61 |
| F61:39 ResolvedPortalAccessPolicy [E6] | type contract; responsibility =F61 | =F61 | =F61 | =F61 | P170:3 | =F61 |
| F61:45 createPortalAgentIdentity [E6] | function/API; responsibility =F61 | =F61 | =F61 | =F61 | P183:3, P170:3, P192:4, P177:10, P178:8, P181:15, P165:6, P167:3 | =F61 |
| F61:87 portalAgentScopeKey [E6] | function/API; responsibility =F61 | =F61 | =F61 | =F61 | P170:3, P191:6, P166:6 | =F61 |
| F61:111 resolvePortalAccessPolicy [E6] | function/API; responsibility =F61 | =F61 | =F61 | =F61 | P170:3, P192:4, P191:6, P165:6 | =F61 |
| F68:21 PortalCatalogSnapshot [E6] | type contract; responsibility =F68 | =F68 | =F68 | =F68 | P170:4, P165:13, P164:6 | =F68 |
| F68:29 PortalDiscoveryFailure [E6] | type contract; responsibility =F68 | =F68 | =F68 | =F68 | P170:4, P166:13 | =F68 |
| F68:43 PortalSession [E6] | type contract; responsibility =F68 | =F68 | =F68 | =F68 | P170:4, P166:13, P167:7 | =F68 |
| F68:50 PortalSessionRuntime [E6] | type contract; responsibility =F68 | =F68 | =F68 | =F68 | P170:4, P165:13 | =F68 |
| F68:59 PortalSessionManagerOptions [E6] | type contract; responsibility =F68 | =F68 | =F68 | =F68 | P170:4 | =F68 |
| F68:69 PortalSessionManager [E6] | type contract; responsibility =F68 | =F68 | =F68 | =F68 | P170:4, P165:13 | =F68 |
| F68:75 PortalCatalogPreparationError [E6] | named export; responsibility =F68 | =F68 | =F68 | =F68 | P170:4, P178:10, P165:13 | =F68 |
| F68:143 createPortalSessionManager [E6] | function/API; responsibility =F68 | =F68 | =F68 | =F68 | P170:4, P192:9, P165:13 | =F68 |
| F69:6 SearchQuery [E6] | type contract; responsibility =F69 | =F69 | =F69 | =F69 | P170:5 | =F69 |
| F69:12 SearchResultSet [E6] | type contract; responsibility =F69 | =F69 | =F69 | =F69 | P170:5 | =F69 |
| F69:16 SearchIndex [E6] | type contract; responsibility =F69 | =F69 | =F69 | =F69 | P170:5, P191:13 | =F69 |
| F69:27 ToolRelationshipHint [E6] | type contract; responsibility =F69 | =F69 | =F69 | =F69 | P170:5 | =F69 |
| F69:34 ToolSearchResult [E6] | type contract; responsibility =F69 | =F69 | =F69 | =F69 | P170:5, P166:14 | =F69 |
| F69:190 createSearchIndex [E6] | function/API; responsibility =F69 | =F69 | =F69 | =F69 | P194:3, P170:5, P191:13 | =F69 |
| F71:5 ToolRelationshipType [E6] | type contract; responsibility =F71 | =F71 | =F71 | =F71 | P170:6 | =F71 |
| F71:7 ToolRelationshipEndpoint [E6] | type contract; responsibility =F71 | =F71 | =F71 | =F71 | P170:6 | =F71 |
| F71:11 ToolRelationship [E6] | type contract; responsibility =F71 | =F71 | =F71 | =F71 | P170:6, P193:3 | =F71 |
| F71:19 SkillGraphInput [E6] | type contract; responsibility =F71 | =F71 | =F71 | =F71 | P170:6, P191:14, P165:20 | =F71 |
| F71:26 ScopedSkillGraphEntry [E6] | type contract; responsibility =F71 | =F71 | =F71 | =F71 | P170:6 | =F71 |
| F71:33 ToolGraphInput [E6] | type contract; responsibility =F71 | =F71 | =F71 | =F71 | P170:6 | =F71 |
| F71:38 ToolGraph [E6] | type contract; responsibility =F71 | =F71 | =F71 | =F71 | P170:6, P191:14, P193:3 | =F71 |
| F71:246 buildToolGraph [E6] | function/API; responsibility =F71 | =F71 | =F71 | =F71 | P170:6, P197:3, P191:14 | =F71 |
| F72:3 ToolIdentity [E6] | type contract; responsibility =F72 | =F72 | =F72 | =F72 | P170:7, P196:3 | =F72 |
| F72:16 ToolRef [E6] | type contract; responsibility =F72 | =F72 | =F72 | =F72 | P170:7 | =F72 |
| F72:32 encodeToolRef [E6] | function/API; responsibility =F72 | =F72 | =F72 | =F72 | P194:4, P170:7, P188:4, P198:3, P199:3, P197:4, P196:3 | =F72 |
| F72:40 decodeToolRef [E6] | function/API; responsibility =F72 | =F72 | =F72 | =F72 | P170:7, P198:3, P166:15 | =F72 |
| F73:5 ToolSchemaSummary [E6] | type contract; responsibility =F73 | =F73 | =F73 | =F73 | P170:8 | =F73 |
| F73:12 ToolSafetySummary [E6] | type contract; responsibility =F73 | =F73 | =F73 | =F73 | P170:8 | =F73 |
| F73:17 ToolSchemaHintNext [E6] | type contract; responsibility =F73 | =F73 | =F73 | =F73 | P170:8 | =F73 |
| F73:19 ToolSchemaHint [E6] | type contract; responsibility =F73 | =F73 | =F73 | =F73 | P170:8, P166:16 | =F73 |
| F73:24 ToolSummary [E6] | type contract; responsibility =F73 | =F73 | =F73 | =F73 | P170:8, P193:4, P166:16 | =F73 |
| F73:53 summarizeJsonSchema [E6] | validation schema; responsibility =F73 | =F73 | =F73 | =F73 | P170:8 | =F73 |
| F73:67 createToolSummary [E6] | function/API; responsibility =F73 | =F73 | =F73 | =F73 | P170:8, P200:3, P193:4, P166:16 | =F73 |
| F74:29 UpstreamMcpTransportKind [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9, P203:1 | =F74 |
| F74:37 RemoteUpstreamMcpServer [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9, P201:13 | =F74 |
| F74:45 StdioUpstreamMcpServer [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9 | =F74 |
| F74:53 NormalizedUpstreamMcpServer [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9, P177:15, P203:1, P168:9, P204:3, P201:13 | =F74 |
| F74:55 ListToolsCall [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9 | =F74 |
| F74:60 UpstreamToolCall [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9 | =F74 |
| F74:70 UpstreamToolEvent [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9 | =F74 |
| F74:92 UpstreamMcpProgress [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9 | =F74 |
| F74:94 UpstreamListToolsResult [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9, P177:15, P201:13 | =F74 |
| F74:99 UpstreamMcpClientLike [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9, P177:15, P173:11, P201:13 | =F74 |
| F74:122 UpstreamMcpRuntimeOptions [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9 | =F74 |
| F74:134 UpstreamMcpCloseErrorContext [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9 | =F74 |
| F74:139 UpstreamMcpClientRuntime [E6] | type contract; responsibility =F74 | =F74 | =F74 | =F74 | P170:9, P60:5 | =F74 |
| F74:529 createUpstreamMcpClientRuntime [E7] | function/API; responsibility =F74 | =F74 | =F74 | =F74 | P170:9, P177:15, P154:36, P158:8, P174:32, P173:11, P201:13, P137:43, P62:11 | =F74 |
| F75:6 UpstreamMcpFailurePhase [E6] | type contract; responsibility =F75 | =F75 | =F75 | =F75 | P170:10 | =F75 |
| F75:8 UpstreamMcpFailureClass [E6] | type contract; responsibility =F75 | =F75 | =F75 | =F75 | P202:16, P170:10, P166:18 | =F75 |
| F75:16 UpstreamMcpTransportSummary [E6] | type contract; responsibility =F75 | =F75 | =F75 | =F75 | P170:10 | =F75 |
| F75:28 UpstreamMcpFailureDetails [E6] | type contract; responsibility =F75 | =F75 | =F75 | =F75 | P170:10 | =F75 |
| F75:45 UpstreamMcpError [E6] | named export; responsibility =F75 | =F75 | =F75 | =F75 | P170:10, P192:10, P180:7, P167:8, P164:7, P62:11 | =F75 |
| F75:55 messageFromUnknownError [E6] | function/API; responsibility =F75 | =F75 | =F75 | =F75 | P202:16, P170:10, P191:15 | =F75 |
| F75:65 isUpstreamMcpError [E6] | function/API; responsibility =F75 | =F75 | =F75 | =F75 | P202:16, P170:10 | =F75 |
| F75:69 transportSummaryFromServer [E6] | function/API; responsibility =F75 | =F75 | =F75 | =F75 | P202:16, P170:10, P204:4 | =F75 |
| F75:88 sanitizeRemoteMcpUrlForDiagnostics [E6] | function/API; responsibility =F75 | =F75 | =F75 | =F75 | P170:10, P204:4 | =F75 |
| F75:119 createUpstreamMcpError [E6] | function/API; responsibility =F75 | =F75 | =F75 | =F75 | P202:16, P170:10, P175:12 | =F75 |
| F75:130 upstreamMcpFailureDetailsFromUnknown [E6] | function/API; responsibility =F75 | =F75 | =F75 | =F75 | P170:10, P191:15, P166:17 | =F75 |
| F75:136 formatUpstreamMcpFailureMessage [E6] | function/API; responsibility =F75 | =F75 | =F75 | =F75 | P170:10, P191:15 | =F75 |
| F76:9 RedactionOptions [E6] | type contract; responsibility =F76 | =F76 | =F76 | =F76 | P170:11 | =F76 |
| F76:13 isCredentialConfigKey [E6] | function/API; responsibility =F76 | =F76 | =F76 | =F76 | P170:11 | =F76 |
| F76:32 redactExactCredentialText [E6] | function/API; responsibility =F76 | =F76 | =F76 | =F76 | P170:11 | =F76 |
| F76:36 redactCredentialText [E7] | function/API; responsibility =F76 | =F76 | =F76 | =F76 | P40:37, P206:3, P170:11, P158:7 | =F76 |
| F76:109 redactUpstreamResponse [E6] | function/API; responsibility =F76 | =F76 | =F76 | =F76 | P206:3, P202:23, P170:11 | =F76 |
| F76:113 redactUpstreamCatalogValue [E6] | function/API; responsibility =F76 | =F76 | =F76 | =F76 | P202:23, P170:11 | =F76 |
| F76:136 redactThrownError [E6] | function/API; responsibility =F76 | =F76 | =F76 | =F76 | P206:3, P202:23, P170:11, P179:19 | =F76 |
| F76:162 toRedactedJsonValue [E6] | function/API; responsibility =F76 | =F76 | =F76 | =F76 | P170:11 | =F76 |
| F77:5 InputValidationIssue [E8] | type contract; responsibility =F77 | =F77 | =F77 | =F77 | P170:12, P187:2, P190:1, P161:3 | =F77 |
| F77:18 InputValidationError [E8] | type contract; responsibility =F77 | =F77 | =F77 | =F77 | P170:12, P187:2, P190:1 | =F77 |
| F77:23 SchemaValidationUnavailableError [E8] | type contract; responsibility =F77 | =F77 | =F77 | =F77 | P170:12, P187:2, P190:1 | =F77 |
| F77:30 PortalValidationResult [E8] | type contract; responsibility =F77 | =F77 | =F77 | =F77 | P170:12, P187:2, P190:1 | =F77 |
| F77:34 BuiltZodValidator [E8] | type contract; responsibility =F77 | =F77 | =F77 | =F77 | P170:12, P187:2, P190:1 | =F77 |
| F77:499 buildZodValidatorFromJsonSchema [E8] | validation schema; responsibility =F77 | =F77 | =F77 | =F77 | P170:12, P187:2, P190:1, P208:4, P161:3, P62:11, P145:11 | =F77 |
| F51:11 ResolveUpstreamServersProps [E9] | type contract; responsibility =F51 | =F51 | =F51 | =F51 | P158:1 | =F51 |
| F51:58 resolveUpstreamServers [E9] | function/API; responsibility =F51 | =F51 | =F51 | =F51 | P154:26, P158:1, P169:3, P174:32, P137:30, P62:17 | =F51 |
| F46:12 PortalApprovalPolicyRecord [E9] | type contract; responsibility =F46 | =F46 | =F46 | =F46 | P158:2 | =F46 |
| F46:17 CreatePortalPolicyApprovalEvaluatorProps [E9] | type contract; responsibility =F46 | =F46 | =F46 | =F46 | P158:2 | =F46 |
| F46:52 createPortalPolicyApprovalEvaluator [E9] | function/API; responsibility =F46 | =F46 | =F46 | =F46 | P181:9, P158:2, P164:8, P160:7 | =F46 |
| F47:8 validatePortalToolArguments [E9] | function/API; responsibility =F47 | =F47 | =F47 | =F47 | P158:3, P166:19 | =F47 |
| F49:34 PortalAgentScope [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P179:9, P158:4 | =F49 |
| F49:36 PortalCoreToolName [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P179:9, P158:4, P174:37 | =F49 |
| F49:42 PortalAuditEvent [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:56 PortalCoreResult [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P179:9, P158:4, P174:37 | =F49 |
| F49:63 PortalCoreItemResult [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:76 PortalCoreItemError [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:87 PortalCoreValidationIssue [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:100 PortalCoreContentBlock [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:104 PortalCoreEvent [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P179:9, P158:4, P164:9, P174:37, P137:29 | =F49 |
| F49:152 PortalCoreStreamCall [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:163 PortalCoreCollectOptions [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:167 PortalCoreRuntime [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:171 PortalApprovalEvaluator [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:181 CreatePortalCoreProps [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:185 PortalCore [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P177:9, P178:7, P179:9, P158:4, P174:37 | =F49 |
| F49:215 PreparedPortalCatalogTool [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P158:4 | =F49 |
| F49:221 PreparedPortalCatalog [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P179:9, P158:4 | =F49 |
| F49:226 PortalCoreToolDescriptor [E9] | type contract; responsibility =F49 | =A7 | =A7 | =F49 | P179:9, P158:4 | =F49 |
| F49:232 preparePortalCatalogSnapshot [E9] | function/API; responsibility =F49 | =A7 | =A7 | =F49 | P158:4, P164:9 | =F49 |
| F49:574 listPortalCoreToolDescriptors [E9] | function/API; responsibility =F49 | =A7 | =A7 | =F49 | P158:4, P164:9 | =F49 |
| F49:605 collectPortalCoreResult [E9] | function/API; responsibility =F49 | =A7 | =A7 | =F49 | P158:4, P164:9 | =F49 |
| F49:782 createPortalCore [E9] | function/API; responsibility =F49 | =A7 | =A7 | =F49 | P177:9, P180:6, P154:25, P158:4, P164:9, P174:32, P173:6, P175:11, P137:29 | =F49 |
| F50:21 PortalToolSuccess [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:27 PortalToolFailure [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:33 PortalToolResult [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P165:22, P158:5, P174:37 | =F50 |
| F50:34 PortalToolResultMap [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:36 PortalBatchError [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:42 PortalSafeTransportDiagnostic [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:46 PortalBatchDiagnostic [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P165:22, P158:5, P174:37 | =F50 |
| F50:77 PortalBatchResult [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P165:22, P158:5, P174:37 | =F50 |
| F50:84 PortalApprovalCall [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P181:10, P165:22, P158:5, P159:6, P160:8 | =F50 |
| F50:210 portalToolInputSchemas [E9] | exported value; responsibility =F50 | =A8 | =A8 | =F50 | P179:18, P165:22, P158:5 | =F50 |
| F50:217 PortalToolHandlerCall [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:222 PortalCallUpstreamTool [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:232 PortalUpstreamEvent [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:251 PortalToolRuntime [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P165:22, P158:5 | =F50 |
| F50:261 PortalApprovalCallDecision [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P181:10, P158:5, P164:16, P159:6 | =F50 |
| F50:269 PortalApprovalEvaluation [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P181:10, P158:5, P164:16, P159:6 | =F50 |
| F50:273 PortalApprovalCallDigestMap [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P165:22, P158:5 | =F50 |
| F50:275 PortalToolHandlers [E9] | type contract; responsibility =F50 | =A8 | =A8 | =F50 | P158:5 | =F50 |
| F50:814 preparePortalApprovalCallDigests [E9] | function/API; responsibility =F50 | =A8 | =A8 | =F50 | P165:22, P158:5 | =F50 |
| F50:857 createPortalToolHandlers [E9] | function/API; responsibility =F50 | =A8 | =A8 | =F50 | P165:22, P158:5, P167:9 | =F50 |
| F58:13 PortalHttpAgentIdentity [E10] | type contract; responsibility =F58 | =F58 | =F58 | =F58 | P176:1 | =F58 |
| F58:15 PortalAgentBearerAuth [E10] | type contract; responsibility =F58 | =F58 | =F58 | =F58 | P176:1 | =F58 |
| F58:21 PortalHttpAuditEvent [E10] | type contract; responsibility =F58 | =F58 | =F58 | =F58 | P176:1, P154:27 | =F58 |
| F58:35 PortalHttpAppOptions [E10] | type contract; responsibility =F58 | =F58 | =F58 | =F58 | P176:1 | =F58 |
| F58:54 PortalHttpApp [E10] | type contract; responsibility =F58 | =F58 | =F58 | =F58 | P176:1 | =F58 |
| F58:118 createPortalHttpApp [E10] | function/API; responsibility =F58 | =F58 | =F58 | =F58 | P176:1, P177:21, P154:27 | =F58 |
| F59:21 portalMcpToolNames [E10] | exported value; responsibility =F59 | =F59 | =F59 | =F59 | P176:2 | =F59 |
| F59:28 PortalMcpToolName [E10] | type contract; responsibility =F59 | =F59 | =F59 | =F59 | P176:2 | =F59 |
| F59:33 PortalCatalogMode [E10] | type contract; responsibility =F59 | =F59 | =F59 | =F59 | P176:2, P178:11 | =F59 |
| F59:39 listPortalMcpTools [E10] | function/API; responsibility =F59 | =F59 | =F59 | =F59 | P176:2, P180:8 | =F59 |
| F59:119 emitMcpProgress [E10] | function/API; responsibility =F59 | =F59 | =F59 | =F59 | P176:2, P180:8 | =F59 |
| F59:197 createPortalMcpServer [E10] | function/API; responsibility =F59 | =F59 | =F59 | =F59 | P176:2, P180:8, P178:11 | =F59 |
| F60:20 ResolveAgentHmacKeysProps [E10] | type contract; responsibility =F60 | =A9 | =A9 | =F60 | P176:3 | =F60 |
| F60:26 PortalAgentRuntimeRecord [E10] | type contract; responsibility =F60 | =F60 | =F60 | =F60 | P176:3, P182:6 | =F60 |
| F60:33 PortalApprovalAuditEvent [E10] | type contract; responsibility =F60 | =F60 | =F60 | =F60 | P176:3, P154:28 | =F60 |
| F60:67 resolveAgentHmacKeys [E10] | function/API; responsibility =F60 | =A9 | =A9 | =F60 | P176:3, P137:31 | =F60 |
| F60:84 createPortalAgentRuntimeRecords [E10] | function/API; responsibility =F60 | =F60 | =F60 | =F60 | P176:3, P154:28, P137:31 | =F60 |
| F60:104 createPortalHttpAgentResolver [E10] | function/API; responsibility =F60 | =F60 | =F60 | =F60 | P176:3, P154:28 | =F60 |
| F60:120 createPortalApprovalVerifier [E10] | function/API; responsibility =F60 | =A9 | =A9 | =F60 | P176:3, P182:6, P154:28, P137:31 | =F60 |
| F55:49 McpProviderCapabilityBackendCallOptions [E11] | type contract; responsibility =F55 | =F55 | =F55 | =F55 | P172:1 | =F55 |
| F55:54 McpProviderCapabilityBackend [E11] | type contract; responsibility =F55 | =F55 | =F55 | =F55 | P172:1, P242:14, P243:10 | =F55 |
| F55:73 CreateMcpProviderCapabilityBackendProps [E11] | type contract; responsibility =F55 | =F55 | =F55 | =F55 | P172:1 | =F55 |
| F55:80 McpProviderBackendSessionOptions [E11] | type contract; responsibility =F55 | =F55 | =F55 | =F55 | P172:1 | =F55 |
| F55:85 ManagedMcpProviderBackendFactory [E11] | type contract; responsibility =F55 | =F55 | =F55 | =F55 | P172:1, P242:14, P243:10, P127:42, P128:21 | =F55 |
| F55:94 CreateManagedMcpProviderBackendFactoryProps [E11] | type contract; responsibility =F55 | =F55 | =F55 | =F55 | P172:1 | =F55 |
| F55:99 CreateManagedMcpProviderBackendFactoryFromConfigProps [E11] | type contract; responsibility =F55 | =F55 | =F55 | =F55 | P172:1 | =F55 |
| F55:155 createManagedMcpProviderBackendFactory [E11] | function/API; responsibility =F55 | =F55 | =F55 | =F55 | P172:1 | =F55 |
| F55:164 createManagedMcpProviderBackendFactoryFromConfig [E11] | function/API; responsibility =F55 | =F55 | =F55 | =F55 | P172:1, P128:21 | =F55 |
| F55:241 createMcpProviderCapabilityBackend [E11] | function/API; responsibility =F55 | =F55 | =F55 | =F55 | P172:1, P173:3, P175:13 | =F55 |
| F43:42 PortalServerLogEvent [E12] | type contract; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P156:6, P157:12, P155:13 | =F43 |
| F43:90 PortalServerLogger [E12] | type contract; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P155:13 | =F43 |
| F43:94 PortalServerCliArgs [E12] | type contract; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P137:17 | =F43 |
| F43:101 StartPortalServerProps [E12] | type contract; responsibility =F43 | =F43 | =F43 | =F43 | P152:1 | =F43 |
| F43:109 CreateServeSecretResolverDependencies [E12] | type contract; responsibility =F43 | =F43 | =F43 | =F43 | P152:1 | =F43 |
| F43:185 createServeSecretResolver [E12] | function/API; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P157:12, P137:17 | =F43 |
| F43:206 ProfilePolicyMaps [E12] | type contract; responsibility =F43 | =F43 | =F43 | =F43 | P152:1 | =F43 |
| F43:214 applyAgentOverrides [E12] | function/API; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P157:12 | =F43 |
| F43:239 DeferredPort [E12] | type contract; responsibility =F43 | =F43 | =F43 | =F43 | P152:1 | =F43 |
| F43:273 handlePortalServerError [E12] | function/API; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P157:12 | =F43 |
| F43:310 buildProfilePolicyMaps [E12] | function/API; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P137:17 | =F43 |
| F43:362 deriveApprovalHmacKeysFromMasterKey [E12] | function/API; responsibility =F43 | =A10 | =A10 | =F43 | P152:1, P195:10, P137:17 | =F43 |
| F43:393 startPortalServer [E12] | function/API; responsibility =F43 | =F43 | =F43 | =F43 | P152:1, P157:12, P195:10, P137:17 | =F43 |
| F66:6 CatalogArtifactInput [E13] | type contract; responsibility =F66 | =F66 | =F66 | =F66 | P187:1 | =F66 |
| F66:31 generateTypescriptCatalogArtifact [E13] | function/API; responsibility =F66 | =F66 | =F66 | =F66 | P187:1, P189:3, P166:12, P137:42 | =F66 |
| F64:5 ApprovalTokenCallDigest [E14] | type contract; responsibility =F64 | =A11 | =A11 | =F64 | P186:5, P166:11 | =F64 |
| F64:11 SignApprovalTokenProps [E14] | type contract; responsibility =F64 | =A12 | =A12 | =F64 | none found | =F64 |
| F64:20 SignAudienceScopedApprovalTokenProps [E14] | type contract; responsibility =F64 | =A12 | =A12 | =F64 | none found | =F64 |
| F64:24 VerifyApprovalTokenProps [E14] | type contract; responsibility =F64 | =A12 | =A12 | =F64 | none found | =F64 |
| F64:39 VerifyAudienceScopedApprovalTokenProps [E14] | type contract; responsibility =F64 | =A12 | =A12 | =F64 | none found | =F64 |
| F64:43 VerifyApprovalTokenResult [E14] | type contract; responsibility =F64 | =A12 | =A12 | =F64 | none found | =F64 |
| F64:78 mcpPortalApprovalTokenAudience [E14] | exported value; responsibility =F64 | =A12 | =A12 | =F64 | P186:5 | =F64 |
| F64:99 hashCallArguments [E14] | function/API; responsibility =F64 | =A13 | =A13 | =F64 | P182:5, P186:5, P195:15, P166:11, P164:5, P159:5, P160:6, P138:16 | =F64 |
| F64:103 signApprovalToken [E14] | function/API; responsibility =F64 | =A12 | =A12 | =F64 | P182:5, P186:5, P195:15, P160:6, P138:16 | =F64 |
| F64:110 signAudienceScopedApprovalToken [E14] | function/API; responsibility =F64 | =A12 | =A12 | =F64 | P186:5 | =F64 |
| F64:160 verifyApprovalToken [E14] | function/API; responsibility =F64 | =A12 | =A12 | =F64 | P186:5, P159:5 | =F64 |
| F64:167 verifyAudienceScopedApprovalToken [E14] | function/API; responsibility =F64 | =A12 | =A12 | =F64 | P186:5 | =F64 |
| F63:4 portalHmacKeyEnvName [E15] | function/API; responsibility =F63 | =F63 | =F63 | =F63 | P185:3 | =F63 |
| F63:8 parseHmacKeysFromEnv [E15] | function/API; responsibility =F63 | =F63 | =F63 | =F63 | P185:3, P137:41 | =F63 |
| F62:3 DeriveAgentBearerTokenProps [E16] | type contract; responsibility =F62 | =F62 | =F62 | =F62 | none found | =F62 |
| F62:9 DeriveAudienceScopedAgentBearerTokenProps [E16] | type contract; responsibility =F62 | =F62 | =F62 | =F62 | none found | =F62 |
| F62:13 VerifyAgentBearerAuthorizationProps [E16] | type contract; responsibility =F62 | =F62 | =F62 | =F62 | none found | =F62 |
| F62:17 VerifyAudienceScopedAgentBearerAuthorizationProps [E16] | type contract; responsibility =F62 | =F62 | =F62 | =F62 | none found | =F62 |
| F62:21 VerifyAgentBearerAuthorizationResult [E16] | type contract; responsibility =F62 | =F62 | =F62 | =F62 | none found | =F62 |
| F62:25 mcpPortalAgentBearerAudience [E16] | exported value; responsibility =F62 | =F62 | =F62 | =F62 | none found | =F62 |
| F62:29 decodePortalMasterKey [E16] | function/API; responsibility =F62 | =F62 | =F62 | =F62 | P154:35, P184:3, P137:36 | =F62 |
| F62:46 deriveAgentBearerToken [E16] | function/API; responsibility =F62 | =F62 | =F62 | =F62 | P177:14, P157:11, P184:3, P195:14, P140:13, P138:15, P137:36 | =F62 |
| F62:53 deriveAudienceScopedAgentBearerToken [E16] | function/API; responsibility =F62 | =F62 | =F62 | =F62 | P184:3 | =F62 |
| F62:62 formatMasterKeyFingerprint [E16] | function/API; responsibility =F62 | =F62 | =F62 | =F62 | P184:3, P140:13, P137:36 | =F62 |
| F62:77 verifyAgentBearerAuthorization [E16] | function/API; responsibility =F62 | =F62 | =F62 | =F62 | P178:9, P184:3 | =F62 |
| F62:86 verifyAudienceScopedAgentBearerAuthorization [E16] | function/API; responsibility =F62 | =F62 | =F62 | =F62 | P184:3 | =F62 |
| F36:24 CatalogTypescriptGeneratorVersion [E17] | exported value; responsibility =F36 | =F36 | =F36 | =F36 | P150:1 | =F36 |
| F36:25 GeneratedToolsSdkContractVersion [E17] | exported value; responsibility =F36 | =F36 | =F36 | =F36 | P150:1 | =F36 |
| F36:190 fingerprintCatalogTypescriptInput [E17] | function/API; responsibility =F36 | =F36 | =F36 | =F36 | P150:1, P146:4, P112:16 | =F36 |
| F36:399 compileCatalogTypescriptModules [E17] | function/API; responsibility =F36 | =F36 | =F36 | =F36 | P150:1, P147:10, P146:4, P112:16 | =F36 |
| F37:9 NormalizedCatalogToolDefinition [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P145:13, P150:2, P147:11 | =F37 |
| F37:16 CompiledCatalogNativeTool [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P150:2 | =F37 |
| F37:24 CompileCatalogTypescriptModulesInput [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P145:13, P150:2, P112:16 | =F37 |
| F37:28 CompiledCatalogTypescriptTool [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P145:13, P150:2 | =F37 |
| F37:39 CompiledCatalogTypescriptNamespace [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P145:13, P150:2 | =F37 |
| F37:46 CompiledCatalogTypescriptManifest [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P150:2 | =F37 |
| F37:54 CompiledCatalogTypescriptFile [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P145:13, P150:2 | =F37 |
| F37:62 CompiledCatalogTypescriptBundle [E17] | type contract; responsibility =F37 | =F37 | =F37 | =F37 | P145:13, P150:2, P113:3, P111:1, P112:16 | =F37 |
| F35:10 createCatalogToolPresentationName [E17] | function/API; responsibility =F35 | =F35 | =F35 | =F35 | P165:4, P145:12, P150:3 | =F35 |
| F70:12 fakeUpstreamNamespace [E18] | exported value; responsibility =F70 | =F70 | =F70 | =F70 | P195:16, P173:7, P201:9, P140:17, P56:4, P51:7, P57:7 | =F70 |
| F70:14 FakeUpstreamToolCallRecord [E18] | type contract; responsibility =F70 | =F70 | =F70 | =F70 | none found | =F70 |
| F70:19 FakeUpstreamHttpRequestRecord [E18] | type contract; responsibility =F70 | =F70 | =F70 | =F70 | none found | =F70 |
| F70:25 StartedFakeUpstreamMcpServer [E18] | type contract; responsibility =F70 | =F70 | =F70 | =F70 | P138:17, P51:7, P57:7 | =F70 |
| F70:34 FakeUpstreamMcpServerOptions [E18] | type contract; responsibility =F70 | =F70 | =F70 | =F70 | none found | =F70 |
| F70:101 createFakeUpstreamTools [E18] | function/API; responsibility =F70 | =F70 | =F70 | =F70 | P173:7 | =F70 |
| F70:128 startFakeUpstreamMcpServer [E18] | function/API; responsibility =F70 | =F70 | =F70 | =F70 | P195:16, P201:9, P140:17, P138:17, P51:7, P57:7 | =F70 |



## config-contracts

📚 ResearcherHandback port inventory — config-contracts (18 files; 262 public symbols).

Legend from the overview applies: I = inferred placement; S = source scanner evidence; O = bounded surrounding code opened. F# gives exact path; P# consumer/test path; A# specialized placement; E# existing public export route(s). Every “=F#/A#” expands to that row’s full target/change/dependency/test cell. No runtime/portability proof claimed. Tests are existing statically linked candidates, not passing runs.

| Current path | What it does (responsibility; I) | Target (I) | Port kind/change (I) | Host/VM dependencies (S/O) | Current consumers (S) | Tests to carry/adapt (S candidates) |
|---|---|---|---|---|---|---|
| F1 packages/config-contracts/src/compiled-google-command-set.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Compiled Google CLI command-set schema and argv lookup | I stays in agent-vm/execution (provider policy); portable fact contract may be consumed by tool-access | adapt: Keep provider semantics with Google owner; import portable JSON/CLI input types only | none of named host/VM hazards directly detected; transitive closure unproven | P84:18, P84:42, P67:10, P67:11, P65:6, P87:3, P267:13, P272:23, P36:9, P22:3, P20:3, P23:3 | P99:1, P53:6 |
| F2 packages/config-contracts/src/controller-configured-cli.ts:1 [O bounded source + S declarations/imports] | CLI allowance schemas plus credential, image and concrete execution-target schemas | I SPLIT: tool-access/contracts + authorization; stays in agent-vm/execution target/image schemas; Node host parsing | adapt: Separate pure policy/input/timeout pieces from node:net isIP, Buffer, prepared-image encoding, controller/VM target union | node:net:1; .refine((value) => Buffer.byteLength(value, 'utf8') <= 256, { [324]; return `${CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX}${Buffer.from(canonicalPayloa [537]; untrustedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8 [552] | P45:5, P84:22, P67:1, P87:4, P8:6, P235:1, P11:1, P10:3, P13:4, P13:13, P267:13, P272:23, P32:1, P31:1, P33:3, P37:1, P36:5, P36:9, P98:8, P94:1, P22:3, P20:3, P91:7, P93:13, P54:1 | P44:5, P46:4, P66:3, P64:3, P88:3, P68:3, P268:1, P5:3, P2:3, P12:5, P14:1, P34:4, P35:1, P99:1, P17:6, P25:7, P53:6, P48:5, P47:5, P55:1 |
| F3 packages/config-contracts/src/google-policy-defaults-config.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Google consent recommendation, defaults and managed-Google policy marker schemas | I tool-access/contracts/provider-policy facts (provider-owned semantics) | adapt: Relocate schema-only definitions without policy expansion; remove config root import closure; keep Google rule authority external | none of named host/VM hazards directly detected; transitive closure unproven | P67:2, P87:20 | none found in static import scan |
| F4 packages/config-contracts/src/index.ts:1 [O bounded source + S declarations/imports] | Shared config barrel mixing schemas and loaders | I retire (mixed root); rebuild explicit portable and host exports | retire: All package-root import consumers must hard-cut to new owner imports; no compatibility re-export | none of named host/VM hazards directly detected; transitive closure unproven | P45:5, P42:2, P41:2, P38:2, P181:1, P154:4, P218:1, P218:5, P220:1, P219:5, P221:1, P223:1, P222:1, P227:1, P217:3, P226:1, P168:1, P159:1, P159:2, P8:6, P258:7, P237:4, P174:21, P133:11, P141:1, P137:6, P235:1, P61:4, P62:3, P3:3, P6:1, P251:1, P11:1, P10:3, P13:4, P13:13, P260:1, P267:6, P267:13, P271:12, P259:10, P272:23, P242:4, P32:1, P31:1, P33:3, P37:1, P36:5, P36:9, P98:8, P94:1, P106:6, P27:1, P22:3, P19:4, P16:5, P28:1, P20:3, P23:3, P29:4, P1:5, P129:5, P123:8, P130:7, P128:5, P91:7, P93:13, P89:5, P90:1, P50:17, P52:3, P54:1, P49:7 | P273:931, P44:5, P39:1, P43:3, P46:4, P109:17, P224:1, P117:24, P134:10, P164:1, P160:1, P268:1, P269:2, P173:2, P175:7, P5:3, P7:18, P2:3, P250:1, P236:1, P266:7, P12:5, P14:1, P261:1, P270:6, P243:2, P135:22, P34:4, P35:1, P107:1, P104:12, P108:10, P99:1, P119:15, P15:5, P17:6, P24:1, P26:3, P18:1, P25:7, P21:1, P9:5, P124:1, P127:12, P92:1, P53:6, P48:5, P47:5, P55:1, P58:11 |
| F5 packages/config-contracts/src/json-config-file.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | JSONC filesystem load and parse errors | I tool-host-node/config | move as-is: Node file reader remains host-only; pure parsing can be separated if Worker config needs it | node:fs/promises:1 | P67:3, P87:25, P80:4, P73:3, P69:3 | P77:6 |
| F6 packages/config-contracts/src/json-value.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | JSON value/object recursive schemas and guards | I tool-access/contracts/json | move as-is: Choose one canonical JSON schema family; account for duplicate mcp-portal/json-schema consumers without changing accepted values | none of named host/VM hazards directly detected; transitive closure unproven | P67:4, P65:7, P3:3, P6:1, P89:5 | P17:6, P53:6 |
| F7 packages/config-contracts/src/mcp-config.ts:1 [O bounded source + S declarations/imports] | MCP provider transports/secret-policy schemas, loader and provider resolver | I SPLIT: tool-access/contracts + tool-portal/connectors; tool-host-node/config loader | adapt: Split loadMcpConfig from schemas/mcpConfigToResolvedProviders; retain stdio shapes only in Node adapter config | none of named host/VM hazards directly detected; transitive closure unproven | P45:5, P38:2, P75:3, P75:4, P85:3, P67:5, P87:26, P154:4, P168:1, P258:7, P174:21, P137:6, P61:4, P62:3, P272:23, P129:5, P91:7, P90:1, P52:3, P54:1 | P39:1, P43:3, P46:4, P70:7, P76:3, P109:17, P270:6, P127:12, P92:1, P58:11 |
| F8 packages/config-contracts/src/mcp-portal-approval-policy.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Pure MCP call allow/block/approval disposition | I tool-access/authorization (policy classification) | move as-is: Policy classification is not proof/signature verification; approval interface stays distinct | none of named host/VM hazards directly detected; transitive closure unproven | P67:6, P159:2 | P72:3 |
| F9 packages/config-contracts/src/mcp-portal-config.ts:1 [O bounded source + S declarations/imports] | Legacy standalone MCP profiles, auth/proxy config and profile compilation | I SPLIT: tool-access/contracts + authorization; tool-host-node/config; legacy auth fields retire at public cutover | adapt: Split loader and Node host knobs; retain policy semantics, retire legacy HMAC admission fields only with consumer cutover | none of named host/VM hazards directly detected; transitive closure unproven | P45:5, P85:4, P67:7, P71:1, P181:1, P154:4, P159:1, P137:6 | P74:7, P72:7, P164:1, P160:1 |
| F10 packages/config-contracts/src/namespace-discovery-compiler.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Compile per-profile namespace discovery metadata | I tool-access/authorization (config projection) | adapt: Use effect-free schema imports; preserve configured visibility; no authoritative credential reads | none of named host/VM hazards directly detected; transitive closure unproven | P45:5, P67:8, P259:10 | P76:4 |
| F11 packages/config-contracts/src/oauth-config-test-fixture.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | OAuth config test factory | I stays in agent-vm/execution testing | adapt: Testing fixture, not production API; update provider/portable imports with its tests | none of named host/VM hazards directly detected; transitive closure unproven | P82:1 | P79:3, P81:3, P60:9 |
| F12 packages/config-contracts/src/oauth-config.ts:1 [O bounded source + S declarations/imports] | OAuth host/provider/owner/editor config schemas and loader | I stays in agent-vm/execution (OAuth); Node host config adapter | adapt: Split host loader from provider-specific schemas if needed; do not move OAuth enrollment authority into generic access | none of named host/VM hazards directly detected; transitive closure unproven | P45:5, P84:26, P67:9, P87:27, P78:1, P63:9, P218:1, P218:5, P220:1, P219:5, P221:1, P223:1, P222:1, P227:1, P217:3, P226:1, P61:4, P27:1, P22:3, P19:4, P16:5, P28:1, P29:4 | P79:4, P81:4, P15:5, P21:1 |
| F13 packages/config-contracts/src/oauth-policy-compiler-test-fixture.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | OAuth policy compiler fixture | I stays in agent-vm/execution testing | adapt: Testing support follows provider compiler, with moved pure input schemas imported | none of named host/VM hazards directly detected; transitive closure unproven | P220:9, P219:15 | P83:4, P79:5, P81:5, P228:15, P224:4, P225:4, P229:9, P268:15, P266:19, P35:18, P15:10, P17:43, P24:9, P26:15, P18:8, P25:26, P21:12, P9:14, P53:36 |
| F14 packages/config-contracts/src/oauth-tool-portal-config.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Compile Tool Portal OAuth policy/command sets and revisions | I stays in agent-vm/execution (Google compiler) | adapt: Node hashing/path resolution and Google owned interpretation stay external; supply facts through portable interface | node:crypto:1; node:path:2 | P45:5, P67:10, P220:1, P219:5, P61:4, P22:3, P16:5, P20:3, P23:3 | P83:5, P79:6, P81:6, P77:7, P228:16, P224:1, P225:5, P229:10, P268:1, P266:7, P35:1, P17:6, P24:1, P26:3, P18:1, P25:7, P21:1, P9:5, P53:6 |
| F15 packages/config-contracts/src/schema-artifacts.ts:1 [O bounded source + S declarations/imports] | Draft-07 config schema IDs/paths and emitted JSON Schema artifacts | I tool-host-node/build tooling; tool-access/contracts inputs | adapt: Split portable schemas before artifact generation; preserve IDs, versions, default/refinement behavior or explicitly version changed contract | none of named host/VM hazards directly detected; transitive closure unproven | P67:12, P1:5 | P86:3 |
| F16 packages/config-contracts/src/secret-value.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Secret-reference/format schemas and value formatting | I tool-access/contracts/credential references | move as-is: References/formatting only; actual resolution/custody stays host/provider owned | none of named host/VM hazards directly detected; transitive closure unproven | P45:5, P67:13, P65:8, P87:28, P73:4, P69:4, P181:1, P154:4, P168:1, P174:21, P141:1, P137:6, P62:3, P13:4, P128:5, P91:7 | P127:12 |
| F17 packages/config-contracts/src/tool-portal-config.ts:1 [O bounded source + S declarations/imports] | Tool selectors/profiles plus managed/standalone configs and execution projections | I SPLIT: tool-access/contracts + authorization; managed projections stay execution; loaders/listeners Node host | adapt: Break 1177-line mixed schema module; route individual exports below; keep exact managed schemas in external compatibility owner | none of named host/VM hazards directly detected; transitive closure unproven | P45:5, P42:2, P41:2, P38:2, P75:5, P84:33, P85:5, P67:14, P258:7, P237:4, P174:21, P133:11, P61:4, P62:3, P3:3, P251:1, P13:4, P13:13, P260:1, P267:6, P271:12, P259:10, P272:23, P242:4, P98:8, P94:1, P106:6, P22:3, P16:5, P129:5, P123:8, P130:7, P128:5, P91:7, P89:5, P90:1, P50:17, P52:3, P54:1, P49:7 | P39:1, P43:3, P46:4, P88:8, P68:8, P76:5, P109:17, P117:24, P134:10, P268:1, P269:2, P173:2, P175:7, P7:18, P250:1, P236:1, P266:7, P14:1, P261:1, P270:6, P243:2, P135:22, P107:1, P104:12, P108:10, P99:1, P119:15, P17:6, P25:7, P124:1, P127:12, P92:1, P53:6, P55:1, P58:11 |
| F18 packages/config-contracts/tsdown.config.ts:1 [O bounded source + S declarations/imports] | Config package build entry | I tool-access + tool-host-node build configs; existing execution config package as needed | rewrite: Old single root violates pure/host import closure; replace entry map and packed import proof | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |

Per-public-symbol rows (overloads/re-export aliases deduplicated to source declaration; public routes E#):

| Current path/export | What it does | Target (I) | Port kind/change (I) | Host/VM deps | Current consumers (S) | Tests to carry/adapt |
|---|---|---|---|---|---|---|
| F2:10 configuredCliArgvTokenSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:16 configuredCliPatternRuleSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P87:4, P235:1 | =F2 |
| F2:21 configuredCliFlagNameSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:33 configuredCliFlagRuleSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:41 configuredCliInvocationFlagPredicateSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:48 configuredCliInvocationMatcherSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:69 configuredCliStaticInvocationCallPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P87:4 | =F2 |
| F2:93 configuredCliManagedGoogleCallPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:105 configuredCliInvocationCallPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P87:4, P235:1 | =F2 |
| F2:110 configuredCliInvocationDispositionSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:116 configuredCliAllowedCommandSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P87:4, P235:1 | =F2 |
| F2:138 configuredCliStdinPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P87:4, P235:1 | =F2 |
| F2:156 configuredCliTimeoutPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P87:4, P235:1 | =F2 |
| F2:161 configuredCliPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1, P54:1 | =F2 |
| F2:213 suggestedConfiguredCliInvocationCallPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:221 suggestedConfiguredCliPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P54:1 | =F2 |
| F2:261 configuredCliPolicyFromSuggestions [E19] | function/API; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:277 configuredCliEnvironmentPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:292 configuredCliCredentialLogicalNameSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P87:4 | =F2 |
| F2:308 configuredCliExactNetworkHostSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:321 configuredCliCredentialRelativePathSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:341 configuredCliCredentialFileMappingSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:348 configuredCliCredentialEnvironmentValueSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:417 configuredCliCredentialProjectionSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:514 CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX [E19] | exported value; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P64:3 | =F2 |
| F2:516 configuredCliPreparedImageIdentityPayloadSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:524 ConfiguredCliPreparedImageIdentity [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:528 encodeConfiguredCliPreparedImageIdentity [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P45:5, P67:1, P64:3, P88:3, P268:1, P12:5, P14:1, P35:1, P99:1, P53:6 | =F2 |
| F2:540 decodeConfiguredCliPreparedImageIdentity [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P44:5, P46:4, P67:1, P64:3, P10:3, P13:13, P48:5 | =F2 |
| F2:563 configuredCliPreparedImageIdentitySchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:575 configuredCliImageRecipePathSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:586 configuredCliControllerHostExecutionTargetSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:593 configuredCliEphemeralManagedVmExecutionTargetSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:604 configuredCliToolVmExecutionTargetSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:618 configuredCliExecutionTargetSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P66:3, P67:1 | =F2 |
| F2:624 configuredCliEffectiveControllerHostExecutionTargetSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:631 configuredCliEffectiveEphemeralManagedVmExecutionTargetSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:643 configuredCliEffectiveExecutionTargetSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:649 configuredCliOutputPolicySchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:658 configuredCliAuthorizationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P87:4 | =F2 |
| F2:735 controllerRegisteredOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P87:4 | =F2 |
| F2:752 controllerHostConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:760 controllerEphemeralManagedVmConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P99:1 | =F2 |
| F2:768 controllerEnforcedConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P66:3, P67:1, P5:3, P2:3, P55:1 | =F2 |
| F2:773 controllerToolVmConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P55:1 | =F2 |
| F2:780 controllerConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P66:3, P67:1, P88:3, P68:3 | =F2 |
| F2:786 ControllerHostConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:789 ControllerEphemeralManagedVmConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P84:22, P67:1 | =F2 |
| F2:792 ControllerToolVmConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:795 ControllerConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:799 isControllerEphemeralManagedVmConfiguredCliOperation [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P45:5, P84:22, P67:1, P68:3, P268:1, P22:3, P20:3 | =F2 |
| F2:805 isControllerToolVmConfiguredCliOperation [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P45:5, P66:3, P67:1 | =F2 |
| F2:811 controllerExecutionOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P87:4 | =F2 |
| F2:816 effectiveControllerHostConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P87:4 | =F2 |
| F2:824 effectiveControllerEphemeralManagedVmConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P268:1 | =F2 |
| F2:834 effectiveControllerToolVmConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P66:3, P67:1 | =F2 |
| F2:842 effectiveControllerConfiguredCliOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:848 EffectiveControllerHostConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:851 EffectiveControllerEphemeralManagedVmConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P35:1, P53:6 | =F2 |
| F2:854 EffectiveControllerToolVmConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:857 EffectiveControllerConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:861 isEffectiveControllerHostConfiguredCliOperation [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:867 isEffectiveControllerEphemeralManagedVmConfiguredCliOperation [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P87:4, P268:1, P35:1, P36:9, P99:1 | =F2 |
| F2:873 isEffectiveControllerToolVmConfiguredCliOperation [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P66:3, P67:1, P87:4 | =F2 |
| F2:879 effectiveControllerExecutionOperationSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P87:4 | =F2 |
| F2:884 normalizePreparedControllerExecutionOperation [E19] | function/API; responsibility =F2 | =A15 | =A15 | =F2 | P45:5, P66:3, P67:1, P88:3, P268:1, P99:1 | =F2 |
| F2:915 quickConfiguredCliInputSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P66:3, P67:1, P235:1, P267:13, P98:8 | =F2 |
| F2:916 openConfiguredCliInputSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1, P267:13, P98:8 | =F2 |
| F2:923 configuredCliInputSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:928 quickOAuthConfiguredCliInputSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P267:13, P98:8 | =F2 |
| F2:935 openOAuthConfiguredCliInputSchema [E19] | validation schema; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P267:13, P98:8 | =F2 |
| F2:943 oauthConfiguredCliInputSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P66:3, P67:1, P68:3 | =F2 |
| F2:948 controllerConfiguredCliInputSchema [E19] | validation schema; responsibility =F2 | =A14 | =A14 | =F2 | P66:3, P67:1, P8:6, P267:13, P272:23, P98:8, P94:1, P17:6, P22:3, P20:3, P25:7, P93:13, P53:6 | =F2 |
| F2:953 ConfiguredCliAllowedCommand [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:954 ConfiguredCliFlagRule [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:955 ConfiguredCliInput [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1, P33:3, P93:13 | =F2 |
| F2:956 ControllerConfiguredCliInput [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P11:1, P10:3, P36:5, P22:3 | =F2 |
| F2:957 ConfiguredCliAuthorization [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1 | =F2 |
| F2:958 ConfiguredCliCredentialEnvironmentValue [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P13:4 | =F2 |
| F2:961 ConfiguredCliCredentialProjection [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P13:4 | =F2 |
| F2:964 ConfiguredCliCredentialFileMapping [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P13:4 | =F2 |
| F2:967 ConfiguredCliInvocationCallPolicy [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:970 ConfiguredCliInvocationDisposition [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:973 ConfiguredCliInvocationFlagPredicate [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:976 ConfiguredCliInvocationMatcher [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1, P91:7 | =F2 |
| F2:977 ConfiguredCliPatternRule [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:978 ConfiguredCliPolicy [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:979 ConfiguredCliStdinPolicy [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:980 ConfiguredCliTimeoutPolicy [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1, P235:1 | =F2 |
| F2:981 ControllerExecutionOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P32:1, P34:4, P37:1, P47:5 | =F2 |
| F2:982 ControllerEnforcedConfiguredCliOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P46:4, P67:1 | =F2 |
| F2:985 EffectiveControllerExecutionOperation [E19] | type contract; responsibility =F2 | =A15 | =A15 | =F2 | P67:1, P12:5, P13:13, P31:1, P33:3, P36:5 | =F2 |
| F2:989 ResolvedConfiguredCliTimeout [E19] | type contract; responsibility =F2 | =A14 | =A14 | =F2 | P67:1 | =F2 |
| F2:1001 resolveConfiguredCliTimeout [E19] | function/API; responsibility =F2 | =A16 | =A16 | =F2 | P67:1, P235:1, P10:3, P94:1, P93:13 | =F2 |
| F3:12 googleConsentRecommendationConfigSchema [E19] | validation schema; responsibility =F3 | =F3 | =F3 | =F3 | P67:2, P87:20 | =F3 |
| F3:28 GoogleConsentRecommendationConfig [E19] | type contract; responsibility =F3 | =F3 | =F3 | =F3 | P67:2 | =F3 |
| F3:33 googlePolicyDefaultsConfigSchema [E19] | validation schema; responsibility =F3 | =F3 | =F3 | =F3 | P67:2, P87:20 | =F3 |
| F3:42 GooglePolicyDefaultsConfig [E19] | type contract; responsibility =F3 | =F3 | =F3 | =F3 | P67:2 | =F3 |
| F3:44 managedGoogleNamespaceCallPolicySchema [E19] | validation schema; responsibility =F3 | =F3 | =F3 | =F3 | P67:2, P87:20 | =F3 |
| F5:23 loadJsonConfigFile [E19] | function/API; responsibility =F5 | =F5 | =F5 | =F5 | P67:3, P87:25, P80:4, P73:3, P77:6, P69:3 | =F5 |
| F6:3 JsonPrimitive [E19] | type contract; responsibility =F6 | =F6 | =F6 | =F6 | P67:4 | =F6 |
| F6:4 JsonArray [E19] | type contract; responsibility =F6 | =F6 | =F6 | =F6 | P67:4 | =F6 |
| F6:5 JsonObject [E19] | type contract; responsibility =F6 | =F6 | =F6 | =F6 | P67:4 | =F6 |
| F6:6 JsonValue [E19] | type contract; responsibility =F6 | =F6 | =F6 | =F6 | P67:4 | =F6 |
| F6:8 jsonValueSchema [E19] | validation schema; responsibility =F6 | =F6 | =F6 | =F6 | P67:4, P17:6, P53:6 | =F6 |
| F6:19 jsonObjectSchema [E19] | validation schema; responsibility =F6 | =F6 | =F6 | =F6 | P67:4, P65:7, P3:3, P6:1, P89:5 | =F6 |
| F6:21 isJsonObject [E19] | function/API; responsibility =F6 | =F6 | =F6 | =F6 | P67:4 | =F6 |
| F6:25 assertJsonObject [E19] | function/API; responsibility =F6 | =F6 | =F6 | =F6 | P67:4 | =F6 |
| F7:16 namespaceDiscoverySchema [E19] | validation schema; responsibility =F7 | =A17 | =A17 | =F7 | P75:4, P67:5, P87:26 | =F7 |
| F7:22 NamespaceDiscovery [E19] | type contract; responsibility =F7 | =A17 | =A17 | =F7 | P67:5 | =F7 |
| F7:67 mcpSecretPolicySchema [E19] | validation schema; responsibility =F7 | =A17 | =A17 | =F7 | P67:5 | =F7 |
| F7:90 mcpProviderSchema [E19] | validation schema; responsibility =F7 | =A17 | =A17 | =F7 | P67:5 | =F7 |
| F7:104 mcpConfigSchema [E19] | validation schema; responsibility =F7 | =A17 | =A17 | =F7 | P39:1, P43:3, P46:4, P85:3, P67:5, P76:3, P109:17, P258:7, P174:21, P270:6, P129:5, P127:12, P92:1, P90:1, P52:3, P54:1, P58:11 | =F7 |
| F7:112 McpConfig [E19] | type contract; responsibility =F7 | =A17 | =A17 | =F7 | P45:5, P39:1, P38:2, P46:4, P75:3, P67:5, P168:1, P258:7, P174:21, P272:23, P129:5, P91:7, P92:1, P54:1 | =F7 |
| F7:113 McpProvider [E19] | type contract; responsibility =F7 | =A17 | =A17 | =F7 | P39:1, P67:5 | =F7 |
| F7:115 ResolvedMcpProvider [E19] | type contract; responsibility =F7 | =A17 | =A17 | =F7 | P67:5, P168:1 | =F7 |
| F7:133 loadMcpConfig [E19] | function/API; responsibility =F7 | =A18 | =A18 | =F7 | P45:5, P67:5, P70:7, P154:4, P174:21, P137:6, P61:4, P62:3 | =F7 |
| F7:137 mcpConfigToResolvedProviders [E19] | function/API; responsibility =F7 | =A17 | =A17 | =F7 | P67:5, P70:7, P168:1 | =F7 |
| F8:3 McpPortalApprovalToolAnnotations [E19] | type contract; responsibility =F8 | =F8 | =F8 | =F8 | P67:6 | =F8 |
| F8:8 McpPortalApprovalToolCall [E19] | type contract; responsibility =F8 | =F8 | =F8 | =F8 | P67:6 | =F8 |
| F8:52 McpPortalCallPolicyDecision [E19] | type contract; responsibility =F8 | =F8 | =F8 | =F8 | P67:6 | =F8 |
| F8:57 mcpPortalCallPolicyDecision [E19] | function/API; responsibility =F8 | =F8 | =F8 | =F8 | P72:3, P67:6, P159:2 | =F8 |
| F8:81 mcpPortalCallRequiresApproval [E19] | function/API; responsibility =F8 | =F8 | =F8 | =F8 | P72:3, P67:6 | =F8 |
| F9:6 namespaceToolRefSchema [E19] | validation schema; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:13 NamespaceToolRef [E19] | type contract; responsibility =F9 | =A19 | =A19 | =F9 | P67:7, P71:1 | =F9 |
| F9:15 portalToolSelectorSchema [E19] | validation schema; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:22 PortalToolSelector [E19] | type contract; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:24 portalApprovalConfigSchema [E19] | validation schema; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:47 PortalApprovalConfig [E19] | type contract; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:82 mcpPortalProfileDefinitionSchema [E19] | validation schema; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:111 McpPortalProfileDefinition [E19] | type contract; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:113 resolvedMcpPortalProfileSchema [E19] | validation schema; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F9:130 ResolvedMcpPortalProfile [E19] | type contract; responsibility =F9 | =A19 | =A19 | =F9 | P67:7, P71:1, P181:1, P154:4, P164:1, P159:1, P160:1 | =F9 |
| F9:132 mcpPortalExternalAuthSchema [E19] | validation schema; responsibility =F9 | =A20 | =A20 | =F9 | P67:7 | =F9 |
| F9:138 McpPortalExternalAuthConfig [E19] | type contract; responsibility =F9 | =A20 | =A20 | =F9 | P67:7, P154:4 | =F9 |
| F9:147 mcpPortalProxySchema [E19] | validation schema; responsibility =F9 | =A20 | =A20 | =F9 | P67:7 | =F9 |
| F9:171 McpPortalProxyConfig [E19] | type contract; responsibility =F9 | =A20 | =A20 | =F9 | P67:7, P154:4 | =F9 |
| F9:173 mcpPortalAgentConfigSchema [E19] | validation schema; responsibility =F9 | =A20 | =A20 | =F9 | P67:7 | =F9 |
| F9:181 McpPortalAgentConfig [E19] | type contract; responsibility =F9 | =A20 | =A20 | =F9 | P67:7, P181:1, P154:4 | =F9 |
| F9:183 mcpPortalConfigSchema [E19] | validation schema; responsibility =F9 | =A19 | =A19 | =F9 | P45:5, P85:4, P67:7 | =F9 |
| F9:204 McpPortalConfig [E19] | type contract; responsibility =F9 | =A19 | =A19 | =F9 | P45:5, P72:7, P67:7, P181:1, P154:4, P137:6 | =F9 |
| F9:220 loadMcpPortalConfig [E19] | function/API; responsibility =F9 | =A21 | =A21 | =F9 | P74:7, P67:7, P154:4, P137:6 | =F9 |
| F9:311 resolveMcpPortalProfile [E19] | function/API; responsibility =F9 | =A19 | =A19 | =F9 | P74:7, P72:7, P67:7, P181:1, P154:4 | =F9 |
| F9:322 secretValueToEnvironmentReference [E19] | function/API; responsibility =F9 | =A19 | =A19 | =F9 | P67:7 | =F9 |
| F10:7 toolPortalEffectiveNamespaceDiscoverySchema [E19] | validation schema; responsibility =F10 | =F10 | =F10 | =F10 | P67:8 | =F10 |
| F10:11 ToolPortalEffectiveNamespaceDiscovery [E19] | type contract; responsibility =F10 | =F10 | =F10 | =F10 | P67:8 | =F10 |
| F10:15 ToolPortalNamespaceDiscoveryByProfile [E19] | type contract; responsibility =F10 | =F10 | =F10 | =F10 | P67:8 | =F10 |
| F10:30 compileToolPortalNamespaceDiscoveryByProfile [E19] | function/API; responsibility =F10 | =F10 | =F10 | =F10 | P45:5, P67:8, P76:4, P259:10 | =F10 |
| F12:6 googleOAuthApplicationIds [E19] | exported value; responsibility =F12 | =A22 | =A22 | =F12 | P67:9, P16:5 | =F12 |
| F12:7 googleOAuthApplicationIdSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P84:26, P67:9, P87:27, P63:9, P218:1, P223:1, P222:1, P227:1, P217:3, P226:1, P27:1, P22:3, P19:4, P21:1 | =F12 |
| F12:8 GoogleOAuthApplicationId [E19] | type contract; responsibility =F12 | =A22 | =A22 | =F12 | P84:26, P67:9, P78:1, P218:5, P221:1, P223:1, P222:1, P227:1, P217:3, P226:1, P22:3, P16:5 | =F12 |
| F12:65 oauthBrowserPublicBaseUrlSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F12:66 cloudflareAccessIssuerSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F12:67 cloudflareAccessBrowserIdentityConfigSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F12:75 googleOAuthApplicationConfigSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F12:85 GoogleOAuthApplicationConfig [E19] | type contract; responsibility =F12 | =A22 | =A22 | =F12 | P67:9, P78:1 | =F12 |
| F12:87 googleOAuthCeilingSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9, P87:27 | =F12 |
| F12:103 resolvedOAuthAgentConfigSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F12:112 oauthOwnerConfigSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F12:119 oauthPolicyEditorConfigSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F12:126 oauthConfigSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P84:26, P67:9, P79:4, P81:4 | =F12 |
| F12:229 OAuthConfig [E19] | type contract; responsibility =F12 | =A22 | =A22 | =F12 | P67:9, P78:1, P217:3, P226:1, P15:5, P16:5, P28:1 | =F12 |
| F12:231 resolvedOAuthConfigSchema [E19] | validation schema; responsibility =F12 | =A22 | =A22 | =F12 | P84:26, P67:9 | =F12 |
| F12:258 ResolvedOAuthConfig [E19] | type contract; responsibility =F12 | =A22 | =A22 | =F12 | P84:26, P67:9, P218:1, P220:1, P219:5, P223:1, P222:1, P227:1, P27:1, P16:5, P29:4 | =F12 |
| F12:260 googleOAuthCallbackUrl [E19] | function/API; responsibility =F12 | =A22 | =A22 | =F12 | P67:9, P79:4, P81:4 | =F12 |
| F12:263 loadOAuthConfig [E19] | function/API; responsibility =F12 | =A23 | =A23 | =F12 | P45:5, P67:9, P61:4, P16:5 | =F12 |
| F12:266 requireGoogleOAuthApplication [E19] | function/API; responsibility =F12 | =A22 | =A22 | =F12 | P67:9 | =F12 |
| F14:43 CompiledOAuthPolicy [E19] | type contract; responsibility =F14 | =F14 | =F14 | =F14 | P67:10, P22:3, P16:5, P23:3 | =F14 |
| F14:57 configuredGoogleOperationKey [E19] | function/API; responsibility =F14 | =F14 | =F14 | =F14 | P45:5, P67:10, P268:1, P266:7, P35:1, P17:6, P22:3, P24:1, P20:3, P23:3, P25:7, P53:6 | =F14 |
| F14:216 managedToolPortalRequiresOAuthConfiguration [E19] | function/API; responsibility =F14 | =F14 | =F14 | =F14 | P45:5, P67:10, P61:4, P16:5 | =F14 |
| F14:270 compileOAuthPolicy [E19] | function/API; responsibility =F14 | =F14 | =F14 | =F14 | P45:5, P67:10, P83:5, P79:6, P81:6, P77:7, P228:16, P220:1, P219:5, P224:1, P225:5, P229:10, P268:1, P61:4, P266:7, P35:1, P17:6, P16:5, P24:1, P26:3, P18:1, P25:7, P21:1, P9:5, P53:6 | =F14 |
| F1:30 CompiledGoogleCommandSet [E19] | type contract; responsibility =F1 | =F1 | =F1 | =F1 | P84:18, P84:42, P67:10, P67:11 | =F1 |
| F1:12 compiledGoogleCommandSetSchema [E19] | validation schema; responsibility =F1 | =F1 | =F1 | =F1 | P84:18, P67:11, P65:6, P87:3, P99:1 | =F1 |
| F1:32 resolveCompiledGoogleCommand [E19] | function/API; responsibility =F1 | =F1 | =F1 | =F1 | P67:11, P267:13, P272:23, P36:9, P22:3, P20:3, P23:3, P53:6 | =F1 |
| F15:7 mcpPortalConfigSchemaVersions [E19] | exported value; responsibility =F15 | =F15 | =F15 | =F15 | P86:3, P67:12 | =F15 |
| F15:13 mcpPortalConfigSchemaIds [E19] | exported value; responsibility =F15 | =F15 | =F15 | =F15 | P86:3, P67:12 | =F15 |
| F15:19 mcpPortalConfigSchemaPaths [E19] | exported value; responsibility =F15 | =F15 | =F15 | =F15 | P86:3, P67:12, P1:5 | =F15 |
| F15:25 ConfigContractSchemaArtifacts [E19] | type contract; responsibility =F15 | =F15 | =F15 | =F15 | P67:12 | =F15 |
| F15:38 createConfigContractSchemaArtifacts [E19] | function/API; responsibility =F15 | =F15 | =F15 | =F15 | P86:3, P67:12, P1:5 | =F15 |
| F16:3 secretFormatSchema [E19] | validation schema; responsibility =F16 | =F16 | =F16 | =F16 | P67:13 | =F16 |
| F16:38 secretValueSchema [E19] | validation schema; responsibility =F16 | =F16 | =F16 | =F16 | P67:13, P65:8, P87:28, P73:4 | =F16 |
| F16:43 formattedSecretValueSchema [E19] | validation schema; responsibility =F16 | =F16 | =F16 | =F16 | P67:13, P69:4 | =F16 |
| F16:52 SecretFormat [E19] | type contract; responsibility =F16 | =F16 | =F16 | =F16 | P67:13 | =F16 |
| F16:53 SecretValue [E19] | type contract; responsibility =F16 | =F16 | =F16 | =F16 | P67:13, P73:4, P181:1, P154:4, P141:1, P137:6, P62:3, P13:4 | =F16 |
| F16:54 FormattedSecretValue [E19] | type contract; responsibility =F16 | =F16 | =F16 | =F16 | P45:5, P67:13, P69:4, P168:1, P174:21, P127:12, P128:5, P91:7 | =F16 |
| F16:56 formatSecretValue [E19] | function/API; responsibility =F16 | =F16 | =F16 | =F16 | P67:13, P168:1 | =F16 |
| F17:30 toolPortalToolSelectorSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:37 ToolPortalToolSelector [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P174:21, P62:3, P3:3, P267:6 | =F17 |
| F17:39 toolPortalCallPolicySchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:55 ToolPortalCallPolicy [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:57 toolPortalNamespaceCallPolicySchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:61 ToolPortalNamespaceCallPolicy [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:105 toolPortalBackendKindSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P89:5 | =F17 |
| F17:138 toolPortalSandboxSshOperationDefinitionSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:198 ToolPortalSandboxSshOperationDefinition [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14, P106:6 | =F17 |
| F17:202 toolPortalSandboxSshBackendBindingSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:214 ToolPortalSandboxSshBackendBinding [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P39:1, P67:14 | =F17 |
| F17:218 toolPortalControllerExecutionBackendBindingSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:229 ToolPortalControllerExecutionBackendBinding [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:233 toolPortalBackendBindingSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:239 ToolPortalBackendKind [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P117:24, P134:10, P237:4, P133:11, P7:18, P267:6, P271:12, P272:23, P135:22, P119:15, P127:12, P130:7, P128:5, P89:5, P50:17, P49:7 | =F17 |
| F17:240 ToolPortalBackendBinding [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P272:23 | =F17 |
| F17:272 toolPortalNamespacePolicySchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:278 ToolPortalNamespacePolicy [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P45:5, P75:5, P67:14 | =F17 |
| F17:280 toolPortalSelectorAllowsOperation [E19] | function/API; responsibility =F17 | =A26 | =A26 | =F17 | P84:33, P67:14, P55:1 | =F17 |
| F17:290 ToolPortalOperationReachabilityPolicy [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:295 toolPortalNamespaceAllowsOperation [E19] | function/API; responsibility =F17 | =A26 | =A26 | =F17 | P45:5, P84:33, P67:14, P13:13, P22:3 | =F17 |
| F17:307 toolPortalProfileDefinitionSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:332 ToolPortalProfileDefinition [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P62:3 | =F17 |
| F17:334 toolPortalAgentConfigSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:340 ToolPortalAgentConfig [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:349 toolPortalCredentialBindingSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:362 managedToolPortalAgentConfigSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:371 ManagedToolPortalAgentConfig [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:373 toolPortalStandaloneAgentAuthenticationSchema [E19] | validation schema; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:381 ToolPortalStandaloneAgentAuthentication [E19] | type contract; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:385 toolPortalStandaloneAuthenticationSchema [E19] | validation schema; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:391 ToolPortalStandaloneAuthentication [E19] | type contract; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:395 toolPortalNetworkAddressSchema [E19] | validation schema; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:402 ToolPortalNetworkAddress [E19] | type contract; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:417 toolPortalHttpEntrypointSchema [E19] | validation schema; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:428 ToolPortalHttpEntrypoint [E19] | type contract; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:430 toolPortalMcpEntrypointSchema [E19] | validation schema; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:442 ToolPortalMcpEntrypoint [E19] | type contract; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:444 toolPortalStdioEntrypointSchema [E19] | validation schema; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:456 ToolPortalStdioEntrypoint [E19] | type contract; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:458 toolPortalStandaloneEntrypointsSchema [E19] | validation schema; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:466 ToolPortalStandaloneEntrypoints [E19] | type contract; responsibility =F17 | =A27 | =A27 | =F17 | P67:14 | =F17 |
| F17:474 managedToolPortalConfigSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P45:5, P67:14, P54:1 | =F17 |
| F17:482 ManagedToolPortalConfig [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P41:2, P84:33, P67:14, P242:4, P243:2, P54:1 | =F17 |
| F17:516 preparedManagedToolPortalConfigSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P45:5, P67:14, P88:8, P236:1, P14:1 | =F17 |
| F17:526 PreparedManagedToolPortalConfig [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P45:5, P67:14, P14:1, P13:4 | =F17 |
| F17:538 gatewayRuntimeControllerHostConfiguredCliOperationSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:546 gatewayRuntimeEphemeralManagedVmConfiguredCliOperationSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:555 gatewayRuntimeToolVmConfiguredCliOperationSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:574 gatewayRuntimeConfiguredCliOperationSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:580 gatewayRuntimeControllerExecutionOperationSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:585 GatewayRuntimeControllerExecutionOperation [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14, P98:8, P94:1 | =F17 |
| F17:628 gatewayRuntimeControllerExecutionBackendBindingSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:660 effectiveManagedToolPortalConfigSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P45:5, P39:1, P38:2, P43:3, P67:14, P109:17, P107:1, P108:10, P127:12, P92:1, P90:1, P52:3, P58:11 | =F17 |
| F17:671 EffectiveManagedToolPortalConfig [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P45:5, P39:1, P38:2, P67:14, P13:4, P99:1, P124:1, P91:7, P92:1 | =F17 |
| F17:727 createEffectiveManagedToolPortalConfig [E19] | function/API; responsibility =F17 | =A25 | =A25 | =F17 | P67:14, P88:8, P268:1, P236:1, P13:4, P99:1 | =F17 |
| F17:780 gatewayRuntimeManagedToolPortalConfigSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14, P266:7, P272:23, P104:12, P25:7, P129:5, P53:6 | =F17 |
| F17:789 GatewayRuntimeManagedToolPortalConfig [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14, P117:24, P134:10, P268:1, P269:2, P7:18, P236:1, P267:6, P271:12, P272:23, P242:4, P135:22, P98:8, P107:1, P106:6, P99:1, P119:15, P123:8, P91:7, P50:17 | =F17 |
| F17:793 createGatewayRuntimeManagedToolPortalConfig [E19] | function/API; responsibility =F17 | =A25 | =A25 | =F17 | P42:2, P67:14, P88:8, P109:17, P268:1, P236:1, P107:1, P108:10, P99:1, P17:6, P124:1, P127:12, P52:3, P58:11 | =F17 |
| F17:836 standaloneToolPortalConfigSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P270:6 | =F17 |
| F17:853 StandaloneToolPortalConfig [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P258:7, P250:1, P251:1, P267:6, P272:23, P242:4, P243:2 | =F17 |
| F17:855 toolPortalConfigSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P46:4, P84:33, P85:5, P67:14, P88:8, P68:8, P76:5, P236:1, P260:1, P261:1, P259:10 | =F17 |
| F17:1019 ToolPortalConfig [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P45:5, P46:4, P67:14, P61:4, P62:3, P260:1, P267:6, P49:7 | =F17 |
| F17:1021 loadToolPortalConfig [E19] | function/API; responsibility =F17 | =A28 | =A28 | =F17 | P45:5, P67:14, P61:4, P62:3, P16:5 | =F17 |
| F17:1025 ToolPortalMcpProjectionNamespaceSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:1032 ToolPortalMcpProjectionNamespace [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:1036 ToolPortalMcpProjectionSchema [E19] | validation schema; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P88:8, P174:21, P173:2, P175:7 | =F17 |
| F17:1044 ToolPortalMcpProjection [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14, P174:21 | =F17 |
| F17:1046 ToolPortalControllerExecutionProjectionNamespaceSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:1053 ToolPortalControllerExecutionProjectionNamespace [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:1057 ToolPortalControllerExecutionProjectionSchema [E19] | validation schema; responsibility =F17 | =A25 | =A25 | =F17 | P67:14, P88:8 | =F17 |
| F17:1065 ToolPortalControllerExecutionProjection [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:1069 CreateToolPortalMcpProjectionProps [E19] | type contract; responsibility =F17 | =A24 | =A24 | =F17 | P67:14 | =F17 |
| F17:1077 createToolPortalMcpProjection [E19] | function/API; responsibility =F17 | =A26 | =A26 | =F17 | P67:14, P88:8, P242:4 | =F17 |
| F17:1111 CreateToolPortalControllerExecutionProjectionProps [E19] | type contract; responsibility =F17 | =A25 | =A25 | =F17 | P67:14 | =F17 |
| F17:1119 createToolPortalControllerExecutionProjection [E19] | function/API; responsibility =F17 | =A25 | =A25 | =F17 | P67:14, P88:8, P3:3 | =F17 |



## gateway-runtime

📚 ResearcherHandback port inventory — gateway-runtime (12 files; 52 public symbols).

Legend from the overview applies: I = inferred placement; S = source scanner evidence; O = bounded surrounding code opened. F# gives exact path; P# consumer/test path; A# specialized placement; E# existing public export route(s). Every “=F#/A#” expands to that row’s full target/change/dependency/test cell. No runtime/portability proof claimed. Tests are existing statically linked candidates, not passing runs.

| Current path | What it does (responsibility; I) | Target (I) | Port kind/change (I) | Host/VM dependencies (S/O) | Current consumers (S) | Tests to carry/adapt (S candidates) |
|---|---|---|---|---|---|---|
| F19 packages/gateway-runtime/src/backends/configured-cli-tool-vm-executor.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Execute configured CLI through acquired Tool VM SSH | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | @agent-vm/controller-execution-contracts:9; ./controller-execution-backend-port.js:13; config-contracts root transitive fs/net/crypto | P98:49 | P99:26 |
| F20 packages/gateway-runtime/src/backends/configured-gog-file-discovery.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Project Gog file discovery hints | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | none of named host/VM hazards directly detected; transitive closure unproven | P98:53 | P95:4 |
| F21 packages/gateway-runtime/src/backends/controller-execution-backend-port.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Concrete controller-execution backend with managed dispatch requests | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | @agent-vm/controller-execution-contracts:26; @agent-vm/gateway-control-contracts:31 | P116:3, P98:54, P100:1, P94:13 | P97:16 |
| F22 packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Gateway Control RPC/authorization adapter for controller execution | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | @agent-vm/controller-execution-contracts:29; @agent-vm/gateway-control-contracts:38; ../control-endpoint/gateway-control-caller-context-registration-client.js:46; ../control-endpoint/gateway-control-command-client.js:47; ../control-endpoint/gateway-control-endpoint-contracts.js:48; ./controller-execution-backend-port.js:60; config-contracts root transitive fs/net/crypto | P116:3, P100:2, P123:16, P50:26 | P99:27 |
| F23 packages/gateway-runtime/src/backends/index.ts:1 [O bounded source + S declarations/imports] | Managed backend export barrel | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | ./controller-execution-backend-port.js:1; ./controller-execution-gateway-control-adapter.js:2 | P116:3 | none found in static import scan |
| F24 packages/gateway-runtime/src/backends/tool-vm-runner-artifact-writer.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Write Tool VM runner output artifacts under managed authority | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | none of named host/VM hazards directly detected; transitive closure unproven | P123:20 | P102:13 |
| F25 packages/gateway-runtime/src/backends/tool-vm-runner-backend-port.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Concrete Tool VM sandbox/file/process backend | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | node:buffer:1; @agent-vm/gateway-control-contracts:25; Buffer.byteLength(argumentsValue.content, 'utf8') <= MAXIMUM_TOOL_VM_RUNNER_TEXT_WRIT [194]; stderr: Buffer.concat( [484]; .map((chunk) => Buffer.from(chunk.chunk.contentBase64, 'base64')), [487]; stdout: Buffer.concat( [489]; .map((chunk) => Buffer.from(chunk.chunk.contentBase64, 'base64')), [492]; const bytes = Uint8Array.from(Buffer.from(parsedArguments.content, 'utf8')); [752] | P116:3, P100:3, P105:12, P106:11, P101:9, P114:12, P123:24, P125:38, P50:26 | P104:28, P102:14, P108:25, P124:9, P126:23 |
| F26 packages/gateway-runtime/src/backends/tool-vm-runner-call-results.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Tool VM execution result projections | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | none of named host/VM hazards directly detected; transitive closure unproven | P103:40 | none found in static import scan |
| F27 packages/gateway-runtime/src/backends/tool-vm-runner-catalog-projection.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | List/search/describe managed Tool VM catalog | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | none of named host/VM hazards directly detected; transitive closure unproven | P103:46 | none found in static import scan |
| F28 packages/gateway-runtime/src/backends/tool-vm-runner-configured-catalog.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Compile configured Tool VM runner operations into catalog | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | config-contracts root transitive fs/net/crypto | P116:3, P100:4, P123:28 | P107:8, P104:37, P108:33 |
| F29 packages/gateway-runtime/src/managed-tool-portal-composition.ts:1 [O bounded source + S declarations/imports] | Compose managed core, backend factories, artifact store and epoch lifecycle | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | none of named host/VM hazards directly detected; transitive closure unproven | P116:9, P123:59, P128:33, P50:26 | P117:52, P119:48, P127:57 |
| F30 packages/gateway-runtime/src/tool-portal-projections.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Managed private-UDS operations/projections and principal/artifact binding | I stays in agent-vm/execution (existing gateway-runtime managed integration) | adapt: Consume new portable backend interfaces from outside; retain managed principal, SSH/lease/process/artifact/generation fences; do not lift concrete executor into Tool Portal | @agent-vm/gateway-control-contracts:24; @agent-vm/gateway-control-contracts:25 | P118:27, P116:17, P128:37, P122:36, P50:26 | P117:56, P134:35, P7:33, P135:41, P119:49, P110:16, P121:3 |

Per-public-symbol rows (overloads/re-export aliases deduplicated to source declaration; public routes E#):

| Current path/export | What it does | Target (I) | Port kind/change (I) | Host/VM deps | Current consumers (S) | Tests to carry/adapt |
|---|---|---|---|---|---|---|
| F21:35 ControllerExecutionDispatchRequest [E21] | type contract; responsibility =F21 | =F21 | =F21 | =F21 | P116:3, P98:54, P100:1, P94:13 | =F21 |
| F21:57 ControllerExecutionRpcPort [E21] | type contract; responsibility =F21 | =F21 | =F21 | =F21 | P116:3, P98:54, P97:16, P100:1 | =F21 |
| F21:64 ControllerExecutionRegistration [E21] | type contract; responsibility =F21 | =F21 | =F21 | =F21 | P116:3, P98:54, P100:1 | =F21 |
| F21:74 defineControllerExecutionRegistration [E21] | function/API; responsibility =F21 | =F21 | =F21 | =F21 | P116:3, P98:54, P97:16, P100:1 | =F21 |
| F21:91 CreateControllerExecutionBackendPortProps [E21] | type contract; responsibility =F21 | =F21 | =F21 | =F21 | P116:3, P100:1 | =F21 |
| F21:441 createControllerExecutionBackendPort [E21] | function/API; responsibility =F21 | =F21 | =F21 | =F21 | P116:3, P98:54, P97:16, P100:1 | =F21 |
| F22:252 CreateGatewayControlControllerExecutionBackendPortProps [E21] | type contract; responsibility =F22 | =F22 | =F22 | =F22 | P116:3, P100:2, P123:16 | =F22 |
| F22:888 createGatewayControlControllerExecutionBackendPort [E21] | function/API; responsibility =F22 | =F22 | =F22 | =F22 | P116:3, P100:2, P99:27, P123:16, P50:26 | =F22 |
| F25:52 GatewayRuntimeToolVmRunnerCapabilityOperation [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P106:11 | =F25 |
| F25:73 GatewayRuntimeToolVmRunnerCapabilityCatalogEntry [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P105:12, P106:11 | =F25 |
| F25:79 GatewayRuntimeToolVmRunnerProfileCapabilityCatalog [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P104:28, P100:3, P105:12 | =F25 |
| F25:82 GatewayRuntimeToolVmRunnerCapabilityCatalog [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P104:28, P100:3, P108:25, P106:11, P124:9, P50:26 | =F25 |
| F25:86 GatewayRuntimeToolVmRunnerArtifactRole [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3 | =F25 |
| F25:88 GatewayRuntimeToolVmRunnerArtifactWriteRequest [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P104:28, P102:14, P100:3, P108:25, P101:9, P50:26 | =F25 |
| F25:100 GatewayRuntimeToolVmRunnerArtifactWriter [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P102:14, P100:3, P101:9, P124:9 | =F25 |
| F25:106 GatewayRuntimeToolVmRunnerSandboxBindingRequest [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P104:28, P100:3, P108:25 | =F25 |
| F25:110 GatewayRuntimeToolVmRunnerBoundSandbox [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P114:12, P125:38, P50:26 | =F25 |
| F25:119 GatewayRuntimeToolVmRunnerOperationGroup [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P126:23, P125:38, P50:26 | =F25 |
| F25:128 GatewayRuntimeToolVmRunnerRejectedSandboxBinding [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P114:12 | =F25 |
| F25:134 GatewayRuntimeToolVmRunnerOperationGroupAcquisition [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3 | =F25 |
| F25:138 GatewayRuntimeToolVmRunnerOperationGroupAcquisitionPort [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P125:38, P50:26 | =F25 |
| F25:144 CreateGatewayRuntimeToolVmRunnerBackendPortProps [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P123:24 | =F25 |
| F25:150 GatewayRuntimeToolVmRunnerBackendPort [E21] | type contract; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P104:28, P100:3, P108:25 | =F25 |
| F25:162 MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES [E21] | exported value; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P104:28, P100:3, P106:11 | =F25 |
| F25:163 MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES [E21] | exported value; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P108:25, P106:11 | =F25 |
| F25:164 MAXIMUM_TOOL_VM_RUNNER_PUBLIC_PATH_CHARACTERS [E21] | exported value; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P100:3, P106:11 | =F25 |
| F25:284 createGatewayRuntimeToolVmRunnerBackendPort [E21] | function/API; responsibility =F25 | =F25 | =F25 | =F25 | P116:3, P104:28, P100:3, P108:25, P123:24, P50:26 | =F25 |
| F28:363 compileGatewayRuntimeToolVmRunnerConfiguredCatalog [E21] | function/API; responsibility =F28 | =F28 | =F28 | =F28 | P116:3, P107:8, P104:37, P100:4, P108:33, P123:28 | =F28 |
| F29:33 GatewayRuntimeManagedToolPortalArtifactRuntimeProps [E21] | type contract; responsibility =F29 | =F29 | =F29 | =F29 | P116:9 | =F29 |
| F29:40 GatewayRuntimeManagedToolPortalBackendFactoryRuntime [E21] | type contract; responsibility =F29 | =F29 | =F29 | =F29 | P117:52, P116:9 | =F29 |
| F29:45 GatewayRuntimeManagedToolPortalBackendPortFactories [E21] | type contract; responsibility =F29 | =F29 | =F29 | =F29 | P116:9, P123:59 | =F29 |
| F29:57 CreateGatewayRuntimeManagedToolPortalCompositionProps [E21] | type contract; responsibility =F29 | =F29 | =F29 | =F29 | P116:9 | =F29 |
| F29:67 GatewayRuntimeManagedToolPortalOwnedComponents [E21] | type contract; responsibility =F29 | =F29 | =F29 | =F29 | P116:9 | =F29 |
| F29:77 GatewayRuntimeManagedToolPortalComposition [E21] | type contract; responsibility =F29 | =F29 | =F29 | =F29 | P116:9, P128:33, P50:26 | =F29 |
| F29:86 createGatewayRuntimeManagedToolPortalComposition [E21] | function/API; responsibility =F29 | =F29 | =F29 | =F29 | P117:52, P116:9, P119:48, P127:57, P128:33, P50:26 | =F29 |
| F30:39 GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS [E21] | exported value; responsibility =F30 | =F30 | =F30 | =F30 | P116:17, P128:37, P50:26 | =F30 |
| F30:56 GatewayRuntimeManagedPluginClientKind [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:57 GatewayRuntimePrivateUdsOperationGroup [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:59 GatewayRuntimePortalCallInvocation [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:65 GatewayRuntimeArtifactReadInvocation [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:70 GatewayRuntimeArtifactProjectionOperations [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P117:56, P116:17, P119:49, P122:36, P50:26 | =F30 |
| F30:76 GatewayRuntimePortalDescribeInvocation [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:82 GatewayRuntimePortalListInvocation [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:88 GatewayRuntimePortalSearchInvocation [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:94 GatewayRuntimePortalProjectionResult [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17, P135:41 | =F30 |
| F30:100 GatewayRuntimePortalProjectionOperations [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P117:56, P116:17, P7:33, P135:41, P122:36, P50:26 | =F30 |
| F30:118 GatewayRuntimeCatalogProjectionOperations [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17, P110:16, P122:36, P121:3 | =F30 |
| F30:133 GatewayRuntimePortalProjectionCommonProps [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P116:17 | =F30 |
| F30:139 GatewayRuntimePrivateUdsProjectionFactoryProps [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P117:56, P116:17, P134:35, P135:41, P119:49, P128:37, P50:26 | =F30 |
| F30:145 CreateGatewayRuntimeToolPortalCompositionProps [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P118:27, P116:17 | =F30 |
| F30:183 GatewayRuntimeToolPortalComposition [E21] | type contract; responsibility =F30 | =F30 | =F30 | =F30 | P118:27, P116:17 | =F30 |
| F30:370 createGatewayRuntimeToolPortalComposition [E21] | function/API; responsibility =F30 | =F30 | =F30 | =F30 | P118:27, P116:17, P134:35, P135:41, P110:16 | =F30 |



## oauth-approval-ui

📚 ResearcherHandback port inventory — oauth-approval-ui (10 files; 19 public symbols).

Legend from the overview applies: I = inferred placement; S = source scanner evidence; O = bounded surrounding code opened. F# gives exact path; P# consumer/test path; A# specialized placement; E# existing public export route(s). Every “=F#/A#” expands to that row’s full target/change/dependency/test cell. No runtime/portability proof claimed. Tests are existing statically linked candidates, not passing runs.

| Current path | What it does (responsibility; I) | Target (I) | Port kind/change (I) | Host/VM dependencies (S/O) | Current consumers (S) | Tests to carry/adapt (S candidates) |
|---|---|---|---|---|---|---|
| F79 packages/oauth-approval-ui/scripts/fingerprint-assets.ts:1 [O bounded source + S declarations/imports] | Build-time CSS/JS asset fingerprint/manifest generation | I tool-control-ui/build tooling (Node-only development) | adapt: Keep build script outside browser/runtime root; preserve manifest shape if managed host loader unchanged | node:crypto:1; node:fs/promises:2; node:path:3 | none found in static import scan | none found in static import scan |
| F80 packages/oauth-approval-ui/src/browser/entry.tsx:1 [O bounded source + S declarations/imports] | Progressively enhance native permission form summary | I tool-control-ui/components/consent behavior | rewrite: Replace DOM query/event island with React state/view model; preserve Off/Recommended/Custom counting and no-JS semantics only if retained requirement | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |
| F81 packages/oauth-approval-ui/src/contracts.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | OAuth consent page/view-model and asset manifest schemas | I tool-access/contracts/control view models; Google-specific extension contract | adapt: Separate asset manifest from account/domain contract; preserve current managed route models until UI adapter consumes them | none of named host/VM hazards directly detected; transitive closure unproven | P210:1, P212:1, P215:7, P30:1, P28:2, P29:5 | P214:3 |
| F82 packages/oauth-approval-ui/src/permission-selection-summary.ts:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | Resolve permission mode and summarize selections | I tool-control-ui/components/consent | move as-is: Pure presentation helper; retain selection-mode fallback and summary semantics | none of named host/VM hazards directly detected; transitive closure unproven | P209:1, P215:15 | P211:3 |
| F83 packages/oauth-approval-ui/src/server/index.ts:1 [O bounded source + S declarations/imports] | UI server barrel mixing contracts/renderer/asset reads | I retire; tool-control-ui/components and /app explicit exports; Node asset loader external | retire: Controller OAuth import consumers migrate; no Node asset reader exported by browser package | none of named host/VM hazards directly detected; transitive closure unproven | P27:5, P30:1, P16:16, P28:2, P29:5 | P214:4 |
| F84 packages/oauth-approval-ui/src/server/oauth-account-policy-renderer.tsx:1 [O bounded source + S declarations/imports] | Render account policy/editor/preview, owner index and history | I tool-control-ui/components + /app | rewrite: Hono JSX document/forms→React components/client binding; preserve CSRF/revision/preview/applying semantics in existing controller authority | Hono server JSX renderer; presentation rewrite | P212:3, P27:5 | P213:3 |
| F85 packages/oauth-approval-ui/src/server/oauth-approval-renderer.tsx:1 [O bounded source + S declarations/imports] | Render consent/confirmation/status plus filesystem asset loader | I SPLIT: tool-control-ui/components + /app; tool-host-node/assets (managed adapter consumes) | rewrite: Hono render presentation replaced; loadOAuthApprovalAssetBundle and fs read move host-side; exact route model/status/binding obligations retained | node:fs/promises:1; Hono server JSX renderer; presentation rewrite | P212:2, P16:16, P29:5 | P214:4 |
| F86 packages/oauth-approval-ui/src/server/waiting-for-access-renderer.tsx:1 [O bounded source + S declarations/imports] | Render signed-in but unadmitted waiting page | I tool-control-ui/components/waiting-access | rewrite: React presentation over explicit view model; configured owner admission stays existing controller/host | Hono server JSX renderer; presentation rewrite | P212:4, P28:2 | P216:3 |
| F87 packages/oauth-approval-ui/src/styles/oauth.css:1 [S declarations/imports; full function bodies not inspected (inventory scope)] | OAuth Tailwind/CSS visual system | I tool-control-ui/styles | rewrite: Apply confirmed Bridge-derived shadcn/Base UI tokens; retain accessibility/state coverage, not parallel old presentation | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |
| F88 packages/oauth-approval-ui/tsdown.config.ts:1 [O bounded source + S declarations/imports] | Hono renderer package build entry | I tool-control-ui build config + host asset distribution | rewrite: Browser components/app and asset manifest outputs; never ship Node asset reads into UI root | none of named host/VM hazards directly detected; transitive closure unproven | none found in static import scan | none found in static import scan |

Per-public-symbol rows (overloads/re-export aliases deduplicated to source declaration; public routes E#):

| Current path/export | What it does | Target (I) | Port kind/change (I) | Host/VM deps | Current consumers (S) | Tests to carry/adapt |
|---|---|---|---|---|---|---|
| F81:5 oauthPermissionGroupModelSchema [E20] | validation schema; responsibility =F81 | =F81 | =F81 | =F81 | P212:1 | =F81 |
| F81:16 oauthApplicationChoiceModelSchema [E20] | validation schema; responsibility =F81 | =F81 | =F81 | =F81 | P212:1 | =F81 |
| F81:39 OAuthApplicationChoiceModel [E20] | type contract; responsibility =F81 | =F81 | =F81 | =F81 | P210:1, P212:1, P215:7 | =F81 |
| F81:41 oauthApplicationProgressModelSchema [E20] | validation schema; responsibility =F81 | =F81 | =F81 | =F81 | P212:1 | =F81 |
| F81:49 oauthPermissionFieldErrorSchema [E20] | validation schema; responsibility =F81 | =F81 | =F81 | =F81 | P212:1 | =F81 |
| F81:56 OAuthPermissionFieldError [E20] | type contract; responsibility =F81 | =F81 | =F81 | =F81 | P212:1, P215:7, P30:1 | =F81 |
| F81:58 oauthApprovalPageModelSchema [E20] | validation schema; responsibility =F81 | =F81 | =F81 | =F81 | P212:1, P214:3, P215:7, P30:1, P29:5 | =F81 |
| F81:112 OAuthApprovalPageModel [E20] | type contract; responsibility =F81 | =F81 | =F81 | =F81 | P212:1, P215:7, P30:1, P29:5 | =F81 |
| F81:114 oauthApprovalAssetManifestSchema [E20] | validation schema; responsibility =F81 | =F81 | =F81 | =F81 | P212:1, P215:7 | =F81 |
| F81:120 OAuthApprovalAssetManifest [E20] | type contract; responsibility =F81 | =F81 | =F81 | =F81 | P212:1, P215:7, P28:2, P29:5 | =F81 |
| F85:37 OAuthApprovalRenderProps [E20] | type contract; responsibility =F85 | =A29 | =A29 | =F85 | P212:2 | =F85 |
| F85:48 OAuthApprovalAssetBundle [E20] | type contract; responsibility =F85 | =A30 | =A30 | =F85 | P212:2 | =F85 |
| F85:53 loadOAuthApprovalAssetBundle [E20] | function/API; responsibility =F85 | =A30 | =A30 | =F85 | P212:2, P16:16 | =F85 |
| F85:483 renderOAuthApprovalPage [E20] | function/API; responsibility =F85 | =F85 | =F85 | =F85 | P212:2, P214:4, P29:5 | =F85 |
| F84:18 oauthAccountPolicyPageSchema [E20] | validation schema; responsibility =F84 | =F84 | =F84 | =F84 | P213:3, P212:3, P27:5 | =F84 |
| F84:65 OAuthAccountPolicyPage [E20] | type contract; responsibility =F84 | =F84 | =F84 | =F84 | P212:3 | =F84 |
| F84:96 renderOAuthAccountPolicyPage [E20] | function/API; responsibility =F84 | =F84 | =F84 | =F84 | P213:3, P212:3, P27:5 | =F84 |
| F84:290 renderOAuthOwnerIndex [E20] | function/API; responsibility =F84 | =F84 | =F84 | =F84 | P213:3, P212:3, P27:5 | =F84 |
| F86:9 renderWaitingForAccessPage [E20] | function/API; responsibility =F86 | =F86 | =F86 | =F86 | P212:4, P216:3, P28:2 | =F86 |


