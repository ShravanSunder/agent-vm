# Package structure: folders by job, across every Tool Portal PR

> **Status (2026-10-28): record.** This plan shaped the #262 stack (PRs #238–#246). Its remaining steps are not continued. The [Switchboard remediation plan](../../2026-10-24-tool-portal-remediation/plans/2026-10-28-switchboard-remediation-delivery.html) now governs this code, which moves to its own `agent-collaboration` repository first (OD13). The Tool Portal is now called Switchboard (OD12).

The owner asked why the new packages keep things in one giant folder, and why
the PRs don't follow the repository's rules. They don't. This plan fixes the
structure of every Tool Portal PR (#238, #240, #241, #243, #244, #245, #246)
without changing behavior, and merges `master` up the stack on the way
(owner, 2026-10-21: "just merge then fix new issues").

## What's wrong today

| Where | Problem |
| --- | --- |
| `tool-engine/src/mcp-gateway/` | 25 modules and 19 tests in one folder, covering six jobs: catalog views, search, the `tool_portal_*` tools, approvals, signed tokens, proxy results |
| `tool-engine/src/mcp-gateway/portal-tools.ts` | 728 lines holding five jobs |
| `tool-engine/src/mcp-gateway/` | two import cycles: `organization-tool-catalog` ↔ `portal-session`; `portal-tool-contracts` (types) imports implementations |
| `tool-engine/src/connectors/` | import cycle: `upstream-mcp-errors` ↔ `upstream-mcp-client-runtime` |
| `tool-engine/src/dispatch/` | two jobs in one folder: the dispatch rule (S2) and the standalone Tool Portal core (S3d), with a test fixture among the sources |
| `tool-host-cloudflare/src/` | 16 modules and 17 tests at the package root; 4 relative imports |
| `gateway-runtime/src/managed-tool-engine/` | 8 modules, 3 test fixtures and 6 tests in one folder |
| `tool-host-node/src/` | single-word folders that name a position, not a job (`ingress`, `upstream`, `standalone`, `operations`, `configuration`, `observability`); two modules copied from `tool-engine` (`catalog-tool-presentation-name.ts`, `typescript-artifact.ts`) |
| `tool-access/src/` | 49 relative imports |
| `tool-access-ui/src/` | 18 views, state, fixtures and types at the package root |
| names | `portal-session` in a protocol with no sessions; `zod-schema-loader` builds validators and loads nothing; `hmac-token` names the algorithm, not the job |

## The rules every layer passes

From `.cursor/rules/ts-rules.md`, `.cursor/rules/monorepo-rules.md`,
`domain-typescript` and the separation and ownership principles:

1. **Every folder holds one job, and its name says the job** in more than one
   word. Exceptions: a package's public entry that is already precise
   (`tool-access/contracts`, `tool-access/authorization`,
   `tool-engine/mcp-gateway`) and standard folders (`bin/`, `test-fixtures/`,
   `models/`, shadcn's `components/ui/` and `hooks/`).
2. **Pure schemas and types live in `models/`** inside their job folder. A
   model imports only other models and contract packages, never an
   implementation.
3. **No import cycles** between files of a package.
4. **Absolute imports only**, through the package's `#` alias. No `./` or `../`.
5. **No file over 600 lines.**
6. **One owner per module.** No copy of another package's module.
7. **Tests sit next to the file they test.** Test-only modules live in the job
   folder's `test-fixtures/`.
8. **Names say what the thing is now.**
9. **Hard cutover.** Old paths and names are removed, with no re-export shims.

## Target trees

These are the final trees after #245 and #246. Each layer places the files it
has (see *Sequence*).

### `tool-engine`

```text
packages/tool-engine/src/
├── capability-dispatch/                 public entry …/capability-dispatch (was dispatch/)
│   ├── index.ts
│   ├── capability-dispatcher.ts
│   ├── dispatch-intent.ts
│   └── models/
│       ├── dispatch-contracts.ts
│       └── resource-failure-detail.ts   pure schema the contracts use
├── standalone-tool-portal/              public entry …/standalone-tool-portal (S3d's files from dispatch/)
│   ├── index.ts
│   ├── standalone-tool-portal-core.ts
│   ├── standalone-portal-ports.ts
│   ├── standalone-portal-call-results.ts
│   ├── portal-discovery-merger.ts
│   └── test-fixtures/standalone-portal-core-fixture.ts
├── upstream-mcp-connectors/             public entry …/upstream-mcp-connectors (was connectors/)
│   ├── index.ts
│   ├── upstream-mcp-client-runtime.ts
│   ├── upstream-mcp-protocol.ts
│   ├── upstream-mcp-errors.ts
│   ├── upstream-response-middleware.ts
│   └── models/upstream-mcp-server.ts    NormalizedUpstreamMcpServer, UpstreamMcpTransportKind
└── mcp-gateway/                         public entry …/mcp-gateway (name kept)
    ├── index.ts
    ├── mcp-gateway.ts                   createMcpGateway: composes the folders below
    ├── agent-catalog-views/
    │   ├── organization-tool-catalog.ts
    │   ├── agent-catalog-view-cache.ts  (was portal-session.ts)
    │   ├── tool-list-pagination.ts
    │   ├── tool-loading.ts
    │   ├── tool-ref.ts
    │   ├── catalog-tool-presentation-name.ts
    │   └── models/
    │       ├── catalog-types.ts
    │       └── agent-catalog-view.ts    view, snapshot, discovery failure, refusal
    ├── tool-search/
    │   ├── search-index.ts
    │   ├── tool-summary.ts
    │   ├── tool-graph.ts
    │   └── indirect-tool-descriptors.ts
    ├── portal-tools/
    │   ├── portal-tool-handlers.ts      createPortalToolHandlers only
    │   ├── portal-catalog-requests.ts   list, search and describe
    │   ├── portal-call-execution.ts     prepare and run calls
    │   ├── portal-tool-selection.ts     selectors, exact filters, paging
    │   ├── portal-batch-results.ts      item and batch results, diagnostics
    │   ├── portal-call-validation.ts
    │   ├── json-schema-validators.ts    (was zod-schema-loader.ts)
    │   ├── typescript-catalog-artifact.ts (was typescript-artifact.ts)
    │   └── models/
    │       ├── portal-tool-contracts.ts
    │       └── input-validation-results.ts
    ├── call-approvals/                  deciding whether a call may run
    │   ├── gateway-call-approval.ts     (was gateway-approval.ts)
    │   ├── approval-token-use.ts
    │   └── models/call-approval.ts      approval tokens, verified approval, call authorization, one-use result
    ├── signed-tokens/                   token wire formats
    │   ├── token-signing-primitives.ts  (was token-crypto.ts)
    │   ├── approval-token-signing.ts    (was hmac-token.ts)
    │   └── agent-bearer-tokens.ts       (was agent-bearer-token.ts)
    ├── proxy-results/
    │   ├── proxy-mcp-result.ts
    │   └── proxy-upstream-failure.ts
    └── test-fixtures/
```

`portal-tools.ts` splits along its existing functions. Nothing is rewritten.
The agent bearer tokens stay in `tool-engine`, because the design places them
there so both hosts share one copy (program-design "Where today's code goes").

### `tool-host-cloudflare`

```text
packages/tool-host-cloudflare/src/
├── index.ts                             Worker entry: fetch and the Durable Object export
├── worker-request-handling/
│   ├── worker-host.ts
│   ├── worker-mcp-server.ts
│   └── worker-call-limits.ts
├── caller-authorization/
│   ├── caller-check.ts                  the only edge that reads tokens
│   └── organization-authorization.ts    the organization's Durable Object
├── organization-engines/
│   ├── organization-engine.ts
│   ├── request-operation-entries.ts
│   ├── proxy-profile-policy.ts
│   └── worker-upstream-transports.ts
├── worker-configuration/
│   ├── worker-mcp-configuration.ts
│   ├── worker-secret-values.ts
│   └── models/                          the configuration schemas
├── call-analytics/
│   ├── call-analytics.ts
│   ├── batch-call-analytics.ts
│   └── worker-observation-log.ts
└── test-fixtures/
```

### `gateway-runtime/src/managed-tool-engine`

```text
managed-tool-engine/
├── managed-dispatch-adapter.ts
├── managed-backend-projection.ts
├── managed-access/
│   ├── access-profile-projection.ts
│   ├── managed-access-request.ts
│   ├── managed-invocation-authority.ts
│   └── managed-google-binding.ts
├── managed-call-results/
│   ├── managed-call-projection.ts
│   └── managed-call-results.ts
├── models/managed-tool-engine-adapter.ts   the adapter interface (breaks the adapter ↔ call-projection cycle)
└── test-fixtures/
    ├── composition-profile-test-fixture.ts
    ├── managed-approval-dispatch-test-fixture.ts
    ├── managed-profile-test-fixture.ts
    └── prepared-policy-test-fixture.ts
```

### `tool-host-node`

```text
packages/tool-host-node/src/
├── index.ts, node-host-composition.ts, node-host-startup.ts
├── bin/tool-host-node.ts
├── host-configuration/                  (was configuration/; its typescript-artifact.ts copy is removed)
├── mcp-proxy-server/                    (was ingress/)
├── standalone-tool-portal/              (was standalone/; standalone-portal-contracts.ts → models/)
├── stdio-upstream-servers/              (was upstream/)
├── host-observability/                  (was observability/)
├── operation-records/                   (was operations/)
├── catalog-typescript/                  (its catalog-tool-presentation-name.ts copy is removed)
└── test-fixtures/
```

`tool-host-node` uses `tool-engine`'s presentation name and TypeScript
artifact. Their tests must show byte-identical output. If the outputs differ,
or a synchronous caller can't take the engine's asynchronous version, stop and
bring the difference to the Lead. Don't keep both.

### `tool-access`

The folders stay. Add `"imports": { "#tool-access/*": "./src/*.ts" }` and
replace all 49 relative imports with it.

### `tool-access-ui`

```text
packages/tool-access-ui/src/
├── index.ts, style-imports.d.ts
├── tool-access-panel.tsx
├── panel-views/        access-associations, account-and-audit-views, account-details, organization-navigation, proposal-form
├── panel-state/        use-panel-model, panel-request-router, models/panel-view-types
├── panel-demo/         panel-demo, panel-fixture, panel-fixture-data
├── components/ui/      shadcn primitives (unchanged)
└── hooks/use-mobile.ts shadcn (unchanged)
```

## Renames

| Old | New |
| --- | --- |
| `@agent-collaboration/tool-engine/dispatch` | `…/capability-dispatch` |
| `@agent-collaboration/tool-engine/connectors` | `…/upstream-mcp-connectors` |
| (S3d exports from `…/dispatch`) | `…/standalone-tool-portal` |
| `#dispatch/*`, `#connectors/*` | `#capability-dispatch/*`, `#upstream-mcp-connectors/*`, `#standalone-tool-portal/*` |
| `PortalSession` | `AgentCatalogView` |
| `PortalSessionManager` | `AgentCatalogViewCache` |
| `PortalSessionManagerOptions` | `AgentCatalogViewCacheOptions` |
| `PortalSessionRuntime` | `AgentCatalogViewRuntime` |
| `createPortalSessionManager` | `createAgentCatalogViewCache` |
| `getSession` / `invalidateSession` | `getView` / `invalidateView` |
| `zod-schema-loader.ts` | `json-schema-validators.ts` |
| `hmac-token.ts` | `approval-token-signing.ts` |
| `token-crypto.ts` | `token-signing-primitives.ts` |
| `gateway-approval.ts` | `gateway-call-approval.ts` |
| `typescript-artifact.ts` (engine) | `typescript-catalog-artifact.ts` |

Everything else keeps its exported names. The connector runtime's
`closeSession` and `closeAgentScope` keep theirs: they belong to the outbound
client, which waits on question 8. `tool-engine` hasn't been released, so no
consumer outside this stack exists.

## Not in this pass

- Behavior. Every observable result, error, byte and limit stays the same.
- The outbound client (owner question 8) and cancellation (question 9).
- Moving any module to a different package, apart from removing the two
  `tool-host-node` copies.
- `agent-portal-sdk`'s existing folders, and the old `tool-portal` and
  `mcp-portal` packages, which S4 deletes.

## Sequence

One layer at a time, from the bottom. At each layer:

1. Merge the parent branch, which already carries `master` and the layers
   below. Read both sides of every conflict. Commit the merge on its own.
2. Run the touched packages' unit and integration tests, and record each
   package's test count.
3. Restructure what exists at this layer, following the target trees. Update
   every consumer in the same commit.
4. Run the checks under *Proof*, then push. Never rebase or force-push.

| PR | Branch | Worktree | Merges | Restructures |
| --- | --- | --- | --- | --- |
| #237 | `docs/tool-portal-design` | `agent-vm.docs-tool-portal-design` | `origin/master` | program-design's package table uses the new entry names |
| #238 | `tool-access/s1-rules-and-access-check` | `agent-vm.tool-access-s1-rules-and-access-check` | #237 | `tool-access` imports |
| #240 | `tool-engine/s2-dispatch-seam` | `agent-vm.tool-engine-s2-dispatch-seam` | #238 | `capability-dispatch/`, `managed-tool-engine/` |
| #241 | `tool-engine/s3a-mcp-gateway` | `agent-vm.tool-engine-s3a-mcp-gateway` | #240 | `mcp-gateway/`, `upstream-mcp-connectors/`, renames, the `portal-tools` split |
| #244 | `tool-host-node/s3b-node-host` | `agent-vm.tool-host-node-s3b-node-host` | #241 | `tool-host-node` folders, duplicate removal, anything S3b added to `tool-engine` |
| #245 | `tool-host-node/s3d-standalone-core` | `agent-vm.tool-host-node-s3b` | #244 | `standalone-tool-portal/` in both packages |
| #246 | `tool-host-cloudflare/s6-worker` | `agent-vm.tool-host-cloudflare-s6-worker` | #244 | `tool-host-cloudflare` |
| #243 | `tool-access-ui/panel` | `agent-vm.tool-access-ui-panel` | none (already on `master` 08f9e426) | `tool-access-ui` |

## Proof at every layer

- `pnpm check` exits 0.
- Unit and integration tests for the touched packages pass, with the **same
  test count per package** as before the restructure.
- `git diff -M <merge>..HEAD` shows moves as renames. Content changes are
  limited to imports, alias maps, models taken out of their files, the renames
  above and the `portal-tools` split.
- In the touched packages: no relative imports, no file over 600 lines, no
  cycle between files.
- `tool-host-cloudflare`'s Worker end-to-end suite (`--project e2e-host`) runs
  on sunclaw, never on the owner's Mac. The Lead runs it.
- No VM tests locally; those run in CI only.

## Done

Every layer is pushed with its proof, the Lead has accepted each one, and a
structure scan of the touched packages shows no rule above broken.

## Rulings during execution

- `tool-access` copies `tool-engine`'s `#` alias setup: an `imports` map in
  package.json and extensionless specifiers, with no tsconfig, build or test
  config changes unless proof shows one is needed.
- Worker-vs-Node parity tests reach the Node host only through
  `@agent-collaboration/tool-host-node`'s public entry, as a devDependency of
  `tool-host-cloudflare`. Their Node config is the Worker test's own fixture
  (`test-fixtures/node-parity-host-config.ts`). The Worker's production bundle
  has no `tool-host-node` input. The design's "may not import `tool-host-node`"
  covers production code.
- When a planned `models/` file turns out to hold functions too, the pure types
  and constants go to `models/`. Each function goes to the job folder that uses
  it, in a file named for that job, never `helpers` or `utils`.
- shadcn's generated primitives under `tool-access-ui/src/components/ui/` stay
  as generated. The 600-line rule doesn't apply to them (`sidebar.tsx` is 699
  lines).
- This pass has no paired Verifier. The Lead verifies each layer from its
  proof.
- `managed-dispatch-adapter.ts` and `managed-call-projection.ts` imported each
  other. The `ManagedToolEngineAdapter` interface moves to
  `managed-tool-engine/models/managed-tool-engine-adapter.ts`.
- `managed-approval-dispatch.integration.test.ts` (738 lines, one test) keeps
  its one test. Its shared setup moves unchanged into
  `test-fixtures/managed-approval-dispatch-test-fixture.ts`.
- `tsconfig.base.json` holds the `tool-engine` entry paths. The repo's
  monorepo rules require the owner's permission to edit it, so the
  `capability-dispatch` and `upstream-mcp-connectors` renames wait for that.
- tool-host-node's catalog compiler had a synchronous copy (Node crypto) of
  the engine's asynchronous presentation-name rule. The engine's version is now
  the only one. The compiler path (`fingerprintCatalogTypescriptInput` and its
  callers) becomes `async` inside tool-host-node, an unreleased package with no
  outside caller, while the output bytes stay identical. gateway-runtime still
  imports the old `mcp-portal` compiler. S4 adapts it when it switches over.
- A type or schema moves into a job folder's `models/` only when it is a data
  shape or schema used by more than one file, when it creates an import cycle,
  or when a `models/` file would otherwise import an implementation. A
  function's own Props or options interface, or a type used by one file, stays
  next to that function. The repo's ts-rules say "Colocate type definitions
  near their usage". tool-host-node's root composition and startup interfaces
  stay at the package root.
