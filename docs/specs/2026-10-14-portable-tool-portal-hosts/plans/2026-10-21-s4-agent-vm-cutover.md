# S4: switch agent-vm to the new Tool Portal packages

> **Status (2026-10-28): stopped; record.** S4a, S4b, S4c1 and S4d were built into the #262 stack (S4d is #246's base). S4c2 (#255, managed distribution) is parked by the owner and isn't in the stack. The steps not yet built, including switching agent-vm onto these packages and deleting `@agent-vm/tool-portal` and `@agent-vm/mcp-portal`, are not planned now: agent-vm is out of scope (owner, 2026-10-27), and Switchboard moves to its own `agent-collaboration` repository (OD13). The remaining Switchboard work is in the [Switchboard remediation plan](../../2026-10-24-tool-portal-remediation/plans/2026-10-28-switchboard-remediation-delivery.html).

Move the managed private connection onto the shared rules and dispatcher, finish
the Python MCP client move, update the shipped images and tooling, then delete
`@agent-vm/tool-portal` and `@agent-vm/mcp-portal`. The private protocol, managed
authority, tools, approvals, artifacts and catalog operations keep their contracts.

**Status: accepted by the Lead for S4a–S4c (2026-10-21).** The post-review design
changes listed below are admitted by the Lead as recorded decisions. S4d waits for
the owner's Q8 answer; S4e follows S4d. Edits to `tsconfig*.json` or `pyproject.toml`
wait for the owner's explicit grant. Each slice stops at the first such edit until the
grant is recorded. Q9 still decides HTTP cancellation; this plan preserves #245's
provisional A and does not decide it.

**Lead note on Q8 (2026-10-21):** the Lead re-checked DeepWiki's public endpoint. A
2026-07-28 request gets HTTP 400 ("Supported versions: 2024-11-05, 2025-03-26,
2025-06-18, 2025-11-25"), and a legacy `initialize` negotiates 2025-11-25. Because the
gateway cannot choose its third-party tool servers' versions, the Lead now recommends
that the owner allow outbound fallback to 2025 versions (SDK v2 `auto`, legacy
transport provided by the Node host). Inbound stays 2026-07-28 only. The planner's
"no fallback" recommendation above is superseded by this note, pending the owner's
answer.

## Planning record and source boundary

```text
plan path: docs/specs/2026-10-14-portable-tool-portal-hosts/plans/2026-10-21-s4-agent-vm-cutover.md
originating planner: plan-implementation
planning result: revision-requested
result payload: Lead reviews this commissioned draft and admits the governing basis;
                owner settles Q8 before outbound cutover; Q9 remains explicit.
governing planning basis:
  kind: reviewed-four-document-design, with the later changes below still to admit
  Requirements: ../requirements.md
  Specification: ../2026-10-14-portable-tool-portal-hosts.md
  Program Design: ../program-design.md
  Verification Design: ../verification-design.md
  review identities: c482b3e8 (four documents); be3f94b7 (MCP rewrite)
  current applicability: docs/tool-portal-design at 4859221c29ccf87b553b55da7d0363432761e66b
delivery context:
  requested terminal: plan-only
  delivery grouping: selected:linear-cutover-with-outbound-decision-gate
  PR topology: separate-prs, one linear gh stack above #245
```

**Lead admission (2026-10-21, restated 2026-10-22).** The record above is the
planner's original return and stays as history. The Lead admitted the plan for
S4a–S4c (see Status), so a slice's authority is this plan plus the Lead's commission
for it; `revision-requested` and `plan-only` no longer govern any slice.

The review identities and their closure are the Lead's supplied evidence, not a
new independent review by this planner. The Lead identifies the post-review changes
as ab705f5e, 63cbc4ad, 4c255301, ea5420ba, 23e67cf4, 11a57a86, 4f87ca77,
5bab6009, 56b9446a, 02df4beb, b6676fae and a1a79ec1. This draft does not turn that
history, or Lead acceptance alone, into a fresh independent design review.

Inspected sources:

| Source | Pin and use |
| --- | --- |
| Four design documents, read in full | Docs HEAD `4859221c`; Specification checks 1–12 govern S4; Worker checks 13–16 remain separate |
| Existing structure, core and private-deploy plans | Same docs HEAD; keep the renamed package entries and injected transports; no Worker deployment in S4 |
| Port inventory | [Inventory](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/docs/wip/2026-10-19-tool-portal-port-inventory/port-inventory.md), read from the design worktree; baseline `8535fdd4`; recommendations and old approval-retirement/UI proposals are superseded by the current four documents |
| S4 base | [PR #245](https://github.com/ShravanSunder/agent-vm/pull/245), `tool-host-node/s3d-standalone-core`, `9e52b5056c6bf3d80761441a08b210d0cff6cbdb` |
| Current consumers | `master` at `33914cbe`; scanned both master and #245, including manifests, dynamic imports, scripts, aliases, tests and workflow/image wiring |
| Behavioral oracle | `08f9e426`, as Verification Design requires; master is a consumer inventory, not a replacement oracle |

All paths below are repository-relative. A **new home** marked **needed** does not
exist as an exported replacement at #245. Implement it in its slice; never point
an import at an imagined export. Recheck the pins when implementation starts.

Tracking remains the existing Router work thread, root
`01a14e9e-ba87-7605-bc7b-7e6eff6ec101`; no separate ticket system is selected.
This assignment writes only this file, with no commits, product edits or VM runs.

## The connection we are changing

```text
Hermes / Portal SDK private client
  -> existing Content-Length JSON-RPC over private UDS
  -> gateway-runtime projections: portal, artifact.read, catalog.*
  -> gateway-runtime managed adapter
       rules       -> tool-access/authorization + contracts
       discovery   -> tool-engine/standalone-tool-portal mergers
       calls       -> existing S2 managed adapter -> capability-dispatch
       MCP tools   -> shared upstream-mcp-connectors + Node-injected transports
       other tools -> existing controller / configured CLI / Tool VM backends
       approvals   -> existing controller ledger, reserve and arm operations
```

Use S2's managed call projection, which already preserves controller challenges,
receipts, operation IDs and uncertain results. Do not route managed calls through
the standalone batch-approval adapter. At #245 the standalone core's generic
pending fallback is not the managed `approval_required` projection. Reuse its
exported discovery mergers; keep managed call projection in gateway-runtime.
This composes the existing owners without adding a second dispatcher or converting
controller approvals into standalone tokens.

Artifacts, current-authority registration, epoch retirement, private authentication
and catalog publication stay in gateway-runtime. No database, lease format, managed
ID, fingerprint or private wire format changes. No compatibility package, forwarding
entrypoint or old/new runtime selector. Earlier slices may leave the unused old
packages present so the old/new comparisons can run; deletion is the last slice.

## Q8: outbound MCP is a real dependency, but not for the first three slices

**Answer:** S4's outbound SDK cutover depends on Q8. The private connection and
Portal SDK client work do not. Recommend the design's **2026-07-28 only** rule,
with the explicit cost that existing old-only providers become unavailable.

The managed service loads the controller-protected `mcp.config.json` and passes
it to `createManagedMcpProviderBackendFactoryFromConfig`
(`packages/gateway-runtime/src/production/gateway-runtime-production-service.ts:519`;
`gateway-runtime-service-config.ts:313`). It does not choose a fixed server list.
`agent-vm init` emits `providers: {}` (`init-command.ts:458`). A transport named
`streamable-http` is not evidence of a protocol revision.

I also inspected the authored catalogs in the adjacent production and beta
deployment checkouts, without resolving secrets or changing them. Those are
configuration evidence, not proof that a deployment is currently running them.
No endpoint, account identifier or credential from those files belongs in this plan.

| Upstream found in those catalogs | Transport and protocol evidence |
| --- | --- |
| DeepWiki | Streamable HTTP. On Oct 21 Toronto / Oct 22 UTC, its public `/mcp` rejected a valid modern `server/discover` with HTTP 400, `-32600`, listing `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`; it did not support `2026-07-28` in that probe |
| Tavily | Streamable HTTP. Credential-free modern discovery returned 401; supported versions unknown |
| Perplexity | Production catalog uses HTTP; credential-free discovery returned 401, so that endpoint's versions are unknown. Beta catalogs use `@perplexity-ai/mcp-server`; upstream source 1.4.0 at `cd1d27cf` uses SDK v1.29 `McpServer` and stdio, whose newest protocol is `2025-11-25`. The actual installed npx version is unverified |
| Firecrawl | Catalogs use stdio `firecrawl-mcp`, without an exact package pin. Source 3.33.4 at `13246ebd` uses FastMCP 4.3.2 and SDK v1.29; a dependency alone does not establish the serving protocol. Installed version and modern support remain unknown |
| Linear | Two separately configured production bindings, Streamable HTTP. Public discovery returned 401; supported versions unknown |
| Repository CI providers | `fake-upstream-mcp-server.ts` uses SDK v1.29 server transports today. Its highest supported revision is `2025-11-25`. Modernize the positive fixtures in S4d and retain an explicit old-only negative fixture |

The wire probes sent only `server/discover`, with the required protocol, method and
client metadata; no tool was called. Authentication failures do not mean old-only.
Primary anchors: [SDK v1 supported versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/types.ts#L4),
[Perplexity server](https://github.com/perplexityai/modelcontextprotocol/blob/cd1d27cffe56739819abb3e56a18e26dbd88c487/src/server.ts#L1),
[Perplexity stdio](https://github.com/perplexityai/modelcontextprotocol/blob/cd1d27cffe56739819abb3e56a18e26dbd88c487/src/index.ts#L3),
[Firecrawl manifest](https://github.com/firecrawl/firecrawl-mcp-server/blob/13246ebd779d77e25db57f8bb892b93c67ecdd22/package.json#L38).

While Q8 waits, use the connector already present in the new packages, unchanged;
this adds no compatibility mechanism. S4a–c can be implemented and proven. Hold
S4d, and therefore the final deletion PR, until the owner answers:

- **No fallback:** client 2.3.1, `versionNegotiation: { mode: { pin: '2026-07-28' } }`,
  no remembered `prior`, no `initialize` or deprecated HTTP+SSE attempt, including
  reconnect. A configured old transport is refused clearly, not silently rerouted.
- **Fallback allowed:** the design permits SDK v2 `mode: 'auto'`. The owner must
  identify its scope and any deadline before implementation; do not invent a flag
  or allowlist. Reuse v2's negotiation, with the allowed legacy transport provided
  by the Node host. Inbound routes still reject 2025 clients. Row 10b is conditional
  and needs the Verification Design owner to reconcile its observation to that answer.

Do not disable DeepWiki or rewrite deployment policy to get a green migration.
Real third-party availability remains outside the controlled-server proof.

## Consumer map: replace these entries, not just the package names

Abbreviations: **Access** = `@agent-collaboration/tool-access`, **Engine** =
`@agent-collaboration/tool-engine`, **Node** = `@agent-collaboration/tool-host-node`,
**Runtime** = `@agent-vm/gateway-runtime`. Suffixes below are exact import entries.

| Current consumer / old entry | New import or owned implementation |
| --- | --- |
| agent-vm controller authorization, host executor, managed-VM executor; `tool-portal/cli-allowances`; composition-config tests | `Access/authorization`: `evaluateCliAllowanceInvocation`, `validateCliAllowanceInvocation`, `resolveCliAllowanceTimeout`; schema/type imports use `Access/contracts` or the existing allowance exports |
| agent-vm controller authorization, its unit test, configured-CLI VM test; S2 adapter and managed call projection; `tool-portal/dispatch-authority` | **Needed:** move `deterministicOperationId` and `directDispatchFingerprint` unchanged into runtime's `managed-tool-engine/managed-dispatch-identity.ts`; export owned symbols from Runtime's existing root |
| `controller/oauth/google-permission-policy-service.ts`; `tool-portal` root | `validateCliAllowanceInvocation` from `Access/authorization`. **Needed:** move `resolveGoogleAccountInvocationPolicy` and its tests to the existing controller OAuth owner; local package alias import, not a new generic access evaluator |
| `gateway/gateway-zone-orchestrator.ts`; `mcp-portal/core` redaction | `Engine/upstream-mcp-connectors`: `redactCredentialText` |
| `operations/mcp-portal-live-validation.ts` and `config-validation.integration.test.ts`; `mcp-portal` root/core | Runtime-independent runtime/error types from `Engine/upstream-mcp-connectors`; validator from `Engine/mcp-gateway`; JSON assertion from `Access/contracts`. **Needed:** `resolveUpstreamServers` replacement in Node's root, with both HTTP and stdio routing. Validation must use the same production Node connector factory as managed execution |
| runtime `production/gateway-runtime-production-service.ts`; `mcp-portal/mcp-provider-backend` | **Needed:** managed MCP factory in `gateway-runtime/src/backends/managed-mcp-provider-backend.ts`, over Engine connectors and Node transport construction. Keep managed projection, session scope and secret resolution outside Engine |
| same production service; `createToolPortalMcpProviderBackendPort` from `tool-portal` | **Needed:** its managed authority wrapper in runtime's existing backends; remove the standalone branch, which Node already owns. Controller grants and final principal/fingerprint checks remain real |
| runtime `managed-tool-portal-composition.ts`, `tool-portal-projections.ts`, `runtime/managed-tool-portal-service.ts`; old core/service types | **Needed:** runtime-owned managed facade; `call` uses S2's managed adapter, discovery uses `mergeToolPortalList/Search/Describe` from `Engine/standalone-tool-portal`. Preserve the facade's snapshot and catalog methods required by private projections |
| runtime `backends/{configured-cli-tool-vm-executor,controller-execution-backend-port,controller-execution-gateway-control-adapter,tool-vm-runner-backend-port}.ts` | **Needed:** move the managed-only `ToolPortalBackendPort`, call/read options and invocation schemas into `managed-tool-engine/models/managed-portal-ports.ts`; export required types from Runtime. These carry Gateway authority and must not be replaced by neutral `ToolBackend` at the concrete leaf |
| runtime approval port, OAuth-availability port, production control runtime, telemetry, unavailable ports; old root types | Same runtime-owned managed ports: `ToolPortalApprovalPort`, `ToolPortalOAuthAvailabilityPort`, managed invocation and facade types. Controller reserve/arm/decision methods stay in their current owners |
| S2 `managed-access/managed-access-request.ts`; old `hmac-token` digest | `Access/contracts`: await `hashCallArguments` before publishing the managed entry; preserve its base64url-to-hex conversion and keep synchronous final validation over the prepared digest |
| runtime catalog cache and both cache unit files; `mcp-portal/catalog-typescript` | `Node/catalog-typescript`: both `fingerprintCatalogTypescriptInput` and `compileCatalogTypescriptModules` are now async; await them, including injected test implementations and cache keys |
| old `/portal-config`, `/portal-auth/{agent-bearer-token,hmac-token}` comparison/export consumers | Helper generator and bearer/approval sign/verify functions from `Engine/mcp-gateway`; digest from `Access/contracts`. Token bytes and both existing carriers remain unchanged |
| old `/cli`, `/portal-auth/hmac-env` and `/mcp-proxy` export checks | Node owns serving and environment/key loading; `startNodeHost` and `startNodeHostMcpHttpServer` already exist. **Needed:** CLI profile/secret/key composition still referenced by the old commands; do not demand old export names in the replacement export guard |
| old `tool-portal/standalone-entrypoint`, root standalone approval/listener consumers | Node root exports `startStandaloneToolPortalEntrypoints`, both HTTP listeners, stdio listener, `createStandaloneToolPortalApprovalCoordinator` and token/fingerprint helpers; keep real batch/restart/replay tests |
| old `tool-portal/testing` and `/policy-comparison` consumers | Config/allowance fixtures move to their test owners; no production replacement for the old comparison-only entry. Freeze its independent oracle in S4e, then remove the alias, preserving the poisoned-import test |
| SDK Node transport and schema re-exports | Already on client/core 2.3.1 and `Access/contracts` at #245. Keep the existing SDK public entries and generated Python schema parity; no repeat migration or removed SDK facade |
| Python standard transport, transport tests, stdio test server, wheel metadata assertions | `mcp==2.0.0`, `mcp.Client(mode='2026-07-28')`, v2 types and `httpx2` on the MCP transport only; details below |
| managed Hermes Python bootstrap/client/catalog/approval hooks | Keep `GatewayRuntimeUdsTransport` and managed `GatewayPortalSession`; no `mcp.Client` on this private path. Update tests and image installation proof for the shared Python dependency change |
| `hermes-gateway/src/hermes-managed-image-recipe.ts`; managed-image generation and local overlay packing | Include the three new packages in runtime/Tool-VM closure as needed; replace old package installation with Node's actual executable; keep Hermes distribution pin unchanged |

Every test of a production row moves with that row, including the following
consumers found outside the two packages being deleted:

- agent-vm: controller `tool-portal-mcp-approval`, OAuth `gog-realfs-journey` and
  `managed-google-portal-policy`; `gateway-runtime-sandbox-{test-fixture,vm-test-fixture}`;
  `pinned-gog-runtime.vm.e2e`, `tool-portal-artifact-cli.host.e2e`,
  `configured-cli-managed-vm.vm.e2e`, `portal-composition-hermes-e2e-config.unit`;
  migrate their old core/ports imports to Runtime and allowances to Access.
- runtime: backend unit files, `tool-vm-runner-process-backend-port.unit`,
  `managed-tool-portal-{composition,real-backends}.integration`,
  `tool-portal-{artifacts,projections}.integration`, production service/control/
  telemetry tests, `catalog/prepared-catalog-python-publication.host.e2e`, and all
  `managed-tool-engine` tests/fixtures. Preserve assertions and their real boundaries.
- Old fake-server entry: Hermes orientation, `portal-composition.hermes.e2e`, its
  `portal-composition-hermes-e2e-program.ts`, and Engine's HTTP connector integration.
  **Needed:** carry the controlled fixture to `Node/testing` with the same exported
  fixture names, now v2; keep it test-only. An old-only fixture stays explicitly
  separate for refusal and, if authorized, fallback proof.
- Old comparison imports inside new packages: Engine's `catalog-baseline`,
  `describe-helpers`, `token-parity`, `proxy-mcp-result`; Node's `proxy-large-request`,
  `proxy-result-parity`, `public-name-failure-parity`, `upstream-response-limit`,
  `standalone-resource-parity`, `standalone-batch-approval`, `standalone-artifact-mime`,
  `standalone-dispatch-identity`; S2's `managed-projection-parity`.
  Freeze their old-side oracle before deletion, then keep the same comparisons
  against that independent data. Never replace the old expected side with the new code.
- Relative-source consumers: the three OAuth/Gog integration/VM tests also import
  `tool-portal-service-test-fixture.ts`; move its recording backend and UDS fixtures
  into runtime test support. `tests/harness/agent-portal/standalone-node-stdio-process.ts`
  imports the old server directly for its old/modern cancellation comparison. Freeze
  that old observation, then keep the modern process test and an independent recorded
  expected trace; remove its old mode/import without losing grace/cancel assertions.

### The moved config definitions also need one owner

`config-contracts` remains the managed execution/OAuth configuration package. Do not
delete it or move concrete execution targets and OAuth loaders into portable code.
S1 copied definitions; S4 removes the duplicate definitions and updates importers.
The following symbol-family rules cover every config consumer, including OAuth,
gateway-control-contracts, lifecycle/config validation, scaffold and test fixtures.

| Current family in `packages/config-contracts/src/` | Canonical owner / caller change |
| --- | --- |
| `controller-configured-cli.ts`: policy, argument, flag, stdin, timeout and ordinary input definitions already in Access | Direct `Access/contracts` import of the same `configuredCli*` symbols; allowance evaluation from `Access/authorization`. Execution targets, prepared-image codec, credential materialization and controller operation schemas stay in config-contracts, importing the moved primitives |
| `tool-portal-config.ts`: selectors, call policy and backend-kind definitions already in Access | Direct `Access/contracts`; pure selector decisions from `Access/authorization`. Managed profiles, backend bindings, effective config, projections and semantic config remain managed config, composed from those primitives |
| `compiled-google-command-set.ts`, Google application IDs and `mcp-portal-approval-policy.ts` copied by S1 | Canonical schemas in `Access/contracts`, canonical copied pure functions in `Access/authorization`; managed OAuth compiler/config consumes them. Do not move consent, grants, keys or account-policy authority |
| `mcp-config.ts`, `secret-value.ts` copied into Node | **Needed:** finish split: pure provider/secret-reference schemas and types in `Access/contracts`; `loadMcpConfig`, `loadJsonConfigFile`, secret formatting/resolution and Node transport normalization in Node. Existing managed config composes these instead of keeping copies |
| `mcp-portal-config.ts` standalone profile rules and `namespace-discovery-compiler.ts` | Pure selector/profile rules in Access contracts/authorization; standalone listener/auth config and its loader in Node; managed namespace metadata compiler remains with managed config if it depends on managed profiles |
| `schema-artifacts.ts` and standalone loader/auth definitions in `tool-portal-config.ts` | Node owns standalone schema artifacts/loaders; config-contracts owns the managed schema artifact. The init caller assembles all three artifacts. Preserve existing `$id`, schemaVersion, draft-07 bytes and default/refinement behavior |
| SDK portable schema manifest and Python `contracts.py` | Already sourced through Access at #245; keep SDK re-exports. `scripts/generate-portal-contracts.ts` remains the generator, with no independently edited generated schema |

For each family, split an import statement when it mixes moved and retained symbols.
This includes `config-contracts/src/index.ts` and internal imports, agent-vm's
`gateway/{mcp-portal-effective-config,managed-gateway-runtime-input-builders,
managed-framework-agent-projections,gateway-runtime-portal-admission-material}.ts`,
controller OAuth/runner files, gateway-control snapshot/admission/approval files,
runtime production/service config, and `scripts/generate-portal-contracts.ts`.
Keep remaining managed exports; remove re-exports of definitions that moved.

### Shipping, aliases and guards are consumers too

| Surface | Required replacement |
| --- | --- |
| agent-vm/runtime manifests and `tsconfig.build.json`; root lock and aliases | Declare Access/Engine/Node direct dependencies where actually imported; remove old deps/maps last; package export/build maps must resolve from packed artifacts |
| `scripts/sync-local-tarballs-to-deployment.ts` and its unit test | Update all host, Hermes and Tool-VM package lists, scoped install paths and binary links. Use the new scope in paths; do not replace only the display name |
| `managed-image-dockerfile.ts`, image-release unit tests, `e2e-harness.ts` and host tests | Replace old global `mcp-portal` installation with `@agent-collaboration/tool-host-node` / `tool-host-node`; preserve SDK tools and install the actual transitive workspace closure |
| Hermes recipe, E2E tarball/image preparation, cache-key action | Pack the new packages, install the updated wheel and include changed inputs in the existing rebuildable cache identity; never claim source linkage proves image installation |
| `verify-portal-package-exports.ts`, `audit-portal-architecture.ts` and tests | New export list and dependency direction; remove required-old-export checks and add retired-import refusals plus packed new-entry checks |
| `scripts/{tool-access-architecture,portable-test-aliases}.unit.test.ts`, `verify-tool-engine-closure.ts`, `vitest.config.ts`, `tsconfig.base.json` | Remove old policy-comparison/testing aliases and old-folder routing after their oracle is frozen; preserve independent forbidden-import poison tests |
| `scripts/audit-optique-cli-boundaries.ts` and its tests | Replace the old executable/parser/export inventory with the new Node CLI; retain the separate SDK `tool-portal` CLI entry |
| `scripts/audit-openclaw-removal.ts` and its tests | Update file-specific historical allowlist rows for tests moved out of the deleted folders; keep the OpenClaw absence guard effective |
| `.github/workflows/ci.yml` and local actions | Keep full quality, host Python, pinned Hermes Python, host, VM and Hermes lanes. Update package/cache inputs if explicit lists need it; do not delete a lane to hide breakage |
| Maintainer docs, generated `manual-templates.ts`, root/package README and guides | Update operative imports, install commands and CLI entry to the new package; keep historical design evidence historical. Smoke generated manuals and scaffold outside the checkout |

**CLI gap at #245:** `tool-host-node` currently accepts only a configuration path.
The old parser also provides `validate`, `generate-helper`, `call`, and
`mcp-proxy serve`, `print-client-config`, `write-credential`. Their implementations
have no complete new command home. In S4c, move their operative work into Node's
CLI/composition folders and expose those commands under `tool-host-node`, using
the established Optique parser and new libraries. Preserve their config, helper,
credential and result behavior, subject to the already-decided modern MCP changes.
The existing `tool-portal` binary belongs to **agent-portal-sdk** and stays; it is
not the package being deleted. If the Lead intends to retire an old operator
command instead of moving it, that is a scope correction to settle before deletion.

The compiler intentionally still emits the old package name in its generated
comment (`Node/catalog-typescript`, line 336). Preserve that byte-exact output.
The deletion guard checks imports, re-exports, manifests, aliases and runnable
commands; it cannot be a blind zero-string grep that also rejects historical
fixtures, denied-import literals or this promised generator comment.

## Python: the usable SDK and the test route

Current `uv.lock` resolves **mcp 1.28.1**. The Portal SDK requires
`mcp>=1.28.1,<2`; `standard_mcp_transport.py:66` calls `ClientSession.initialize()`.
Its real HTTP/stdio tests use the old `FastMCP` server. They do not prove the new
Node hosts can be called.

Use **mcp 2.0.0**, exact, to match the pinned Hermes distribution's optional MCP
extra. Source checked at tag commit **6f69a3758ebf2ee55ce050f58b470ce11af71133**:

- [`Client.__aenter__`](https://github.com/modelcontextprotocol/python-sdk/blob/6f69a3758ebf2ee55ce050f58b470ce11af71133/src/mcp/client/client.py#L458)
  uses `session.adopt(...)` for `mode='2026-07-28'`, with no handshake or fallback.
  Its default `auto` can fall back, so use the explicit pin.
- [`ClientSession.initialize`](https://github.com/modelcontextprotocol/python-sdk/blob/6f69a3758ebf2ee55ce050f58b470ce11af71133/src/mcp/client/session.py#L613)
  still sends only a handshake-era version. Keeping that call after a bump is wrong.
- [`streamable_http_client`](https://github.com/modelcontextprotocol/python-sdk/blob/6f69a3758ebf2ee55ce050f58b470ce11af71133/src/mcp/client/streamable_http.py#L638)
  takes an **httpx2** client and yields **two** streams, not the old three.
  `stdio_client(StdioServerParameters(...))` also provides the transport accepted
  by `Client`. Let Client own that context; do not enter the same transport twice.
- Types are v2 snake-case attributes with wire aliases: normalize
  `structured_content`, `mime_type`, and URI/blob/text fields back to the existing
  Portal SDK contract. Preserve the approval vendor metadata through v2's `meta`.
  See [version modes](https://github.com/modelcontextprotocol/python-sdk/blob/6f69a3758ebf2ee55ce050f58b470ce11af71133/docs/protocol-versions.md).

Use lower-level `client.session` calls where needed to preserve the existing
one-call result behavior; do not adopt the high-level client's automatic MRTR
retry/approval flow. Keep existing cancellation and close semantics under test.
Use httpx2 only for this MCP transport; keep ordinary httpx clients elsewhere.

Hermes **0.21.5**, revision `f97608f1`, remains pinned to its existing OCI digest.
Its [MCP extra](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/pyproject.toml#L294)
pins `mcp==2.0.0`. That establishes a compatible requirement, not the version
installed in a built image. CI must read installed metadata after wheel installation
and exercise the actual managed UDS path. No upstream Hermes patch or pin change.

## Slices and PR boundaries

Use one linear stack in one implementation checkout. The commission selects this
over one large PR so Q8 can wait without blocking the private/SDK work. Separate
parallel worktrees are unnecessary; these slices share imports, manifests and locks.
The following is the dependency graph, not authority to create branches now:

```text
#245 9e52b505 -> S4a managed connection -> S4b Python clients
             -> S4c images and consumers -> [Q8] S4d outbound -> S4e delete
```

**Re-sequencing (Lead, 2026-10-22).** S4a is accepted at `40a4ec5b` (PR #250). S4b
waits for the owner's `pyproject.toml` grant, so S4c is split in two:

```text
S4a 40a4ec5b -> S4c1 operator CLI and test homes -> [pyproject grant] S4b Python
             -> S4c2 images and Hermes -> [Q8] S4d outbound -> S4e delete
```

- **S4c1** takes the parts of S4c that don't depend on the Python wheel or images:
  - close the CLI command gap (`validate`, `generate-helper`, `call`, `mcp-proxy serve`, `print-client-config`, `write-credential` move to `tool-host-node`'s CLI, with their tests and packed-command proof);
  - carry the controlled upstream fixture to Node's test-only entry;
  - update the agent-vm orientation/composition fixtures and Engine connector tests to that home;
  - update operator docs and manual templates;
  - update the Optique/export guards.
- **S4c2** keeps the image, tarball, Hermes recipe and CI-only Hermes/VM journeys, after S4b.

The scope and the proof rows don't change; only the order does.

After checking existing stack registration with `gh stack view`, adopt #245 as the
base (`gh stack init --base tool-host-node/s3d-standalone-core <first-branch>` if a
new stack is needed), then `gh stack add <next-branch>`. Each PR bases on the
previous slice; use `gh stack submit` for drafts. Re-read the shared branch before
resolving changes from below. No merge, tag or publication is authorized here.

### S4a — the real private connection uses the new rules and dispatcher

Branch `tool-portal/s4a-managed-connection`, base #245. One cutover PR including
its owned contract moves; no contract-only precursor that leaves consumers broken.

- Implement the needed Runtime managed ports/facade/provider factory above; wire
  production composition to S2, not merely its test helper. Carry managed context,
  backend, principal, Google-preflight and result checks to their existing owners.
- Reuse Engine discovery mergers and upstream runtime; Node injects HTTP/stdio
  transports. Keep the existing outbound protocol untouched while Q8 waits.
- Finish config definition ownership, update mixed imports, managed IDs and digest
  preparation; adapt the async compiler cache. Keep both old packages for comparison.
- Write surfaces: `gateway-runtime/src/{managed-tool-engine,backends,production,
  catalog,runtime}`, composition/projections/approval/OAuth ports and root exports;
  agent-vm controller OAuth/authorization/runner and live validation; config-contracts;
  Access contracts/authorization; Node config/normalization and their package maps.
- First integration gate: actual private UDS -> production composition -> dispatcher
  -> counted controlled provider/controller leaf, including `portal`, `artifact.read`,
  `catalog.prepare`, paged source reads and release/retirement. Compare all public
  values and managed ID/fingerprint bytes with `08f9e426`, controlling clock/identity.
- Keep/repair existing runtime composition/projection/artifact/real-backend tests,
  S2 managed approval/parity tests, controller MCP-approval and Google-policy tests.
  Add the missing private old/new comparison to the permanent projection integration
  suite, plus a multi-item table spanning all three backend kinds and policy states.
- Wrong builds: production still invokes old core; a leaf bypasses dispatcher;
  forged/stale managed context succeeds; pending approval becomes ambiguous;
  digest is a Promise; two async catalog fingerprints collide; hidden tool is shown.
  Tests must observe leaf effect counts, public output and controller ledger, not mocks
  asserting that a dispatcher function was called.
- External dependency: #245 source and ordinary controlled host servers; no VM
  required for the local integration gate. VM/real Hermes coverage belongs to S4c CI.

### S4b — Python speaks 2026-07-28 to the replacement standalone host

Branch `tool-portal/s4b-python-mcp-client`, base S4a; one client PR.

- Change Python SDK manifest/lock, `standard_mcp_transport.py`, its tests and stdio
  fixture, public transport docs and wheel `Requires-Dist` assertions. Update any
  v1 `mcp` imports in test fixtures to v2 types/server APIs.
- Keep Node's already-pinned v2 transport, approval metadata and resource parsing.
  Keep Q9 provisional A on HTTP; stdio and private transport retain their grace.
- Add a permanent black-box host test: installed Python wheel -> built Node host
  over authenticated HTTP and a scoped stdio child -> `tool_portal_call` with a real
  signed batch approval -> counted provider; read an artifact through `resources/read`.
  Exercise missing/mismatched/replayed approval, close twice, cancellation and a
  subsequent permitted call. Record modern metadata/headers and zero initialize.
- Repair `tests/test_standard_mcp_transport.py` and
  `tests/stdio_tool_portal_mcp_test_server.py`; extend
  `python-agent-portal-sdk-wheel.host.e2e.test.ts` for the cross-language real host.
- Wrong builds: dependency-only bump; default auto negotiation; stale three-stream
  unpack; httpx object passed to httpx2 transport; dropped vendor metadata; v1 field
  access silently loses structured results; artifact call works only against a fake.
- **Lead ruling (2026-10-22):** the artifact URI carries only the id, and the bounded
  read request lives in `_meta['agent-vm/artifact-read-request']`. Today's Python
  transport drops that metadata on `resources/read`, which the URI-only fake hid. S4b
  forwards the existing metadata through v2 `session.read_resource(meta=...)`, with no
  other contract change; dropping it is an added wrong build.
- External dependency: Python 3.13, uv, Node build and controlled MCP provider.
  No live account, LLM or VM. The image-level dependency proof waits for S4c CI.

### S4c — built images, catalogs and operator commands ship the replacements

Branch `tool-portal/s4c-managed-distribution`, base S4b; one shipping/integration PR.

- Update the image, tarball, package lists, scoped paths, executable and docs consumers
  above. Install new packages from local tarballs with lifecycle scripts disabled;
  inspect the installed package source and wheel metadata, not only generated text.
- Close the CLI command gap above, including parser/dispatcher tests, real packed
  command execution, helper bytes and client-config credential checks. Move the
  old CLI tests' assertions; do not keep the old binary as a forwarding entrypoint.
- Carry the controlled upstream fixture to Node's test-only entry. Update agent-vm
  Hermes orientation/composition fixtures and Engine connector tests to that home.
  Preserve the old-only server until S4d adds the modern positive fixture.
- Add/extend host black-box proof for actual init -> generated configs -> validate,
  manual update, packed CLI and catalog compilation/publication. Existing host tests
  remain the permanent harness, using owned temporary roots.
- **CI only:** pinned Hermes-image Python tests/typecheck; real Tool VM, managed
  Gateway/Hermes and image assembly. Extend `portal-composition.hermes.e2e.test.ts`
  with the Verification row 6 journey: protected tool -> Hermes native approval ->
  real controller decision -> exactly one counted external effect, with the ledger
  read back as used. A second guest run of the same code gets its own pending
  challenge, is denied, and the count stays one. The replay-adds-zero check stays in
  #253's permanent integration test, at the private socket and durable ledger where
  the one-use rule lives. Production allows one active connection per attachment, so
  the VM journey can't open a second client to replay (Lead, 2026-10-22). Keep the
  test's current unprotected-call, catalog, artifact and private-transport assertions.
- Wrong builds: a Dockerfile still installs the old binary; an overlay lacks the new
  scope; old cached image/wheel is used; Hermes runs MCP instead of private UDS;
  source tests pass but installed wheel imports fail; replay produces a second effect.
- External dependency: existing GitHub Docker/QEMU/image cache setup, 2.5G VM memory.
  No local VM or Hermes-image test. Image proof is unverified until its CI job runs.

### S4d — outbound SDK cutover, after Q8

Branch `tool-portal/s4d-outbound-mcp`, base S4c; one protocol PR, gated by Q8.

**Q8 answered (owner, 2026-10-22): connect to whatever each tool server speaks; DeepWiki must keep working.** The Lead starts S4d now on the S4b head (`c08a0915`, PR #254) in parallel with S4c2: the two touch different files. The Lead orders them later by merging, without rewriting history.

- Move Engine's `upstream-mcp-protocol.ts`, runtime header normalization and server
  types to client/core 2.3.1. Update Node's `stdio-upstream-servers` transport,
  protocol/model/runtime files and managed validation factory together. Preserve
  transport injection, scopes, cancellation, progress, redaction and 4 MiB response
  accounting before redaction. Audit v1 callTool's old result-schema argument:
  v2 takes request options in that position, so a mechanical import swap loses them.
- Implement row 10b as rewritten for the owner's answer. Use modern-only and old-only
  (2025-11-25) controlled servers with request logs at startup and on reconnect. Both
  servers' tools are offered and called, each with exactly one effect. The modern
  server gets zero `initialize` and zero deprecated-transport attempts (never
  downgraded), and the old server is reached on its version. Inbound row 10 controls
  still refuse a 2025-era client. Add a by-hand or scheduled live DeepWiki check that
  lists its tools and makes one read-only call.
- Repair existing HTTP/stdio connector, teardown, progress and production-service
  tests; modernize the positive server fixtures and retain legacy negative controls.
  Keep SDK v1 as a devDependency only where the deliberate old-client control needs it.
- Integrate on CI's managed Hermes path, not just standalone Node. Worker source is
  on the separate #246/#248 lineage: send its Lead the exact connector contract/diff;
  its runtime adapter must move to v2 and run its existing workerd/deployed regression
  before that lineage is integrated. S4 does not silently edit or deploy that branch.
- Wrong builds: pinned to 2026-07-28 outbound, so the old-only server (and DeepWiki)
  drops out; a modern server downgraded to `initialize`; the outbound fallback leaks
  inbound and a 2025-era client is accepted; validation and runtime negotiate
  differently; the migrated client drops abort or progress; successful discovery
  masks a reconnect that negotiates differently.

### S4e — delete the old packages and the last executable references

Branch `tool-portal/s4e-remove-old-packages`, base S4d; final deletion PR.

- Before deletion, run and preserve all old/new comparisons at pinned `08f9e426`.
  Carry their literal outputs, schema/helper/token/digest bytes, inputs and provenance
  into permanent fixtures at the new test owners. Verify each fixture against the
  old implementation before changing the expected side; keep negative controls.
- Replace all comparison imports listed above with those frozen independent oracles.
  Move any uncovered behavioral test to its new owner before deleting its old file.
  Drop only the dead old-package-export assertions, replaced by negative import and
  packed-new-export checks. No mirrored expected values produced by the new code.
- Remove `packages/tool-portal/` and `packages/mcp-portal/`; remove their manifests,
  lock importers, source/build/test aliases, required-export lists, install commands
  and test-support entries, including relative source imports in `tests/harness`.
  No re-export shim. Keep only intentional historical data
  and forbidden-import literals, individually explained by the scan.
- Prove all three ways in again without either old package on disk or resolvable in
  the installed workspace. Run packed consumer installation from a clean temp root;
  list the packed dependency closure to catch an old transitive package.
- Wrong builds: dynamic import still resolves an old compiler; a test alias supplies
  deleted code; local workspace masks a missing packed dependency; image still ships
  old package; deleted tests erase approval, artifact or CLI coverage.
- External dependency: completed earlier source cuts and old oracle capture. No
  substitute/stand-in is acceptable for package absence or shipped image proof.

## Proof commands, obligations and acceptance limits

The project proof-layer authority is AGENTS.md's Testing Pyramid and test suffixes.
Use `mise exec --` for pinned tools, from the monorepo root. These are planned
commands read from repository scripts, not successful runs claimed by this draft.

| Gate | Command and scope |
| --- | --- |
| Focused unit | `mise exec -- pnpm exec vitest run --project unit packages/tool-access/src packages/tool-engine/src packages/gateway-runtime/src packages/config-contracts/src` plus the touched controller/scripts unit files |
| Real module/HTTP/private UDS integration | `mise exec -- pnpm exec vitest run --project integration packages/gateway-runtime/src packages/tool-engine/src packages/tool-host-node/src packages/agent-vm/src/controller packages/agent-vm/src/operations` |
| Python host | `mise exec -- pnpm python:test:host`; `pnpm python:typecheck:host`; `pnpm python:lint`; `pnpm python:fmt:check` |
| Host black-box/wheel | `mise exec -- pnpm test:e2e:host` after `pnpm build`; includes installed-wheel/Node-host cross-language and packed CLI tests |
| Local static | `mise exec -- pnpm fmt:check`; `pnpm lint`; `pnpm lint:types`; `pnpm typecheck`; `pnpm test:portal-architecture`; `pnpm test:portal-exports` |
| Inventory only | `mise exec -- pnpm test:e2e:inventory`; record skips as discovery, never runtime proof |
| Full quality | `mise exec -- pnpm check`; CI repeats it. Python and pinned Hermes checks are separate commands below, not implied by this gate |
| Pinned Hermes Python, CI only | `pnpm python:test:hermes`; `pnpm python:typecheck:hermes`; extend the runner's installed-version assertions to mcp/httpx2 and the new wheel |
| Real VM/Hermes, CI only | Existing workflow's `mise exec -- pnpm test:e2e:vm`, `test:e2e:vm-mediation`, `test:e2e:hermes`, including existing VM shards, using the prior workspace build and prepared image cache |

Every slice records exact commands, pass/fail/skip counts and exits at its own head.
The final report distinguishes unit, integration, host, inventory and real VM/Hermes
proof. Owner direction permits progress past unrelated existing agent-vm flakiness;
record its cause/baseline and continue. Never relabel a failed affected journey as
passing, weaken a check, or use an unrelated flake to hide a cutover regression.

| Verification row | Slice / observation earning it; independent oracle |
| --- | --- |
| 1, 4 | S4a private old/new integration, S4b real SDK/host, S4e frozen comparisons across all entries; `08f9e426` public shapes/helper bytes and controlled outputs |
| 2 | Preserve the owning Node/Worker real-client evidence and large-catalog two-address concurrent journey; S4d modernizes its upstream fixtures, S4c retains Hermes CI. Independent Verifier runs both cases as the row requires; no substitute Python-unit claim |
| 3 | S4a private exact/guessed/search hidden tool plus permitted control; S4e same across three entries, counted effects and observed catalog |
| 5 | S4a permanent forbidden-effect test with deliberately bypassed dispatcher; S4e confirms it survives deletion |
| 6 | S4a controller ledger integration; S4b standalone SDK metadata/JSON-header exact-batch cases; S4c real controller/Hermes decision/replay CI; S4e retained proxy token/input-and-metadata tests. Oracle is one effect then zero replay effects |
| 7 | S4a managed provider/config redaction and S4d connector canary; S4e all-entry regression. Search actual caller-visible output, errors and captured logs |
| 8 | Preserve Node JSON 64/65 KiB, text 4,096 bytes plus structured result, no new MCP-route request cap, >4 MiB proxy request and pre-redaction upstream 4 MiB cases in S4b/d/e; thresholds come from Program Design, not new implementation |
| 9 | S4a production private portal/artifact/catalog integration; S4c whole managed CI journeys and suite; S4e rerun after package absence |
| 10 | S4b installed Python and existing Node SDK calls/resources over HTTP and stdio; preserve all raw-wire header/meta/error/cache/session controls, JSON route and CI private Hermes. Re-run in S4e |
| 10b | S4d conditional on Q8, including production and poisoned prior, startup and reconnect request counts; exact row is the oracle |
| 11 | S4a/d/e architecture and packed export checks; poisoned forbidden import must fail, real allowed import must work |
| 12 | S4e filesystem/manifest/import/dependency/alias scan, clean packed consumer and rows 1/9/10 after deletion |
| 13–16 | Separate Worker delivery owns them. S4 cannot close them; shared connector/config changes need that lineage's existing runtime/deployed regression, with existing gaps carried explicitly |

Use tables for finite backend/policy/protocol cases. Keep existing property tests
and negative controls; S4 adds no new testing framework or Hegel rollout. Existing
tests are **keep/repair** at their new owners, except old package export/existence
tests whose contract S4 retires; those are **remove with replacement** by the
retired-import and packed-new-entry checks. Old/new tests become frozen-oracle
tests, not deletions. The MIME-without-type behavior remains unchanged and covered.

## Risks, open questions and stop conditions

- **Admission:** latest four-document changes lack a fresh independent review;
  Lead requested this draft explicitly. Return it for Lead review and the applicable
  design-admission work; do not emit `ready-for-implementation` from this plan-only run.
- **Q8:** only the owner can accept dropping old-only upstreams or authorize fallback.
  DeepWiki's live refusal and Perplexity's v1 source make the cost concrete. Other
  remote versions and installed stdio package versions remain unverified, as above.
- **Q9:** retain provisional A; never turn a cancelled request into proof of zero
  effects or retry automatically. A different owner answer requires the corresponding
  client tests and draft correction before dependent behavior changes.
- **Protected files:** `.cursor/rules/monorepo-rules.md` reserves pyproject.toml and
  tsconfig edits for explicit permission. Before execution the Lead obtains/records
  the exact grant for the Python SDK dependency edit and required TS build/alias edits;
  planning does not grant it or authorize unrelated root config changes.
- **Missing homes:** managed provider factory/ports/facade, Node normalization/testing
  entry and remaining pure config split are S4 tasks, not existing exports. Stop if
  implementing them requires changing approved ownership or public/private contracts.
- **Managed semantics:** S2 helper existence is not production wiring. Pending
  challenges, Google facts, async digest/compiler preparation and final leaf checks
  need the real-path evidence above. A shortcut through standalone approvals fails scope.
- **Oracle versus deletion:** current new-package tests import the old packages.
  Do not delete until their independent oracle is retained. Historical banner bytes
  are intentional data, not permission to leave a runnable dependency behind.
- **Shipping:** new npm scope, Node executable and Python environment can fail only
  after packing/installing. Actual image package metadata and CI runtime remain
  unobserved in this planning run. No Hermes pin, Gondolin patch or new image-cache
  contract is authorized to get past a failure.
- **Worker branch:** #245 is not the later Worker/core branch. Do not graft that
  branch or claim its tests passed here. Its owner integrates shared changes and
  reports the existing proof boundary separately.
- **Source limits:** remote SDK sources were read through GitHub because DeepWiki
  and Firecrawl tools/local SDK checkouts were unavailable. Authenticated provider
  negotiation, deployed runtime state, package installation and test execution were
  not performed. No separate research ledger was written under the one-file grant.

Stop the affected slice for a changed authority, storage format, wire/result meaning,
new limit/hardening mechanism or weakened proof. Return the evidence to the Lead;
continue unaffected work. No release, merge or production deployment is part of S4.
