# Switchboard extraction and Fleet auth: boundary blockers

The eleven-package keep set is closed at the package-manifest level. A direct source-import scan found no production import into the twelve removed packages. **It is not an independently validated extraction yet:** retained tests import removed source, and root validation still requires removed packages and generated support outside those eleven directories. Resolve those boundaries in the extraction; no Agent VM end-state design is needed.

Read-only source analysis, 30 October 2026. Package/source target **H = `2dfea38e8dcdd01fce28d811ed5ec8db45c25023`**. Plans/design target **D = `de2e51155e7376cb8298395a1410b336e6cdb30f`**, `design/portal-remediation`, in this worktree. `H:path:line` below means that exact Git object's file, not today's default branch. No build, typecheck, test, registry check, service call or repository copy ran.

Scope comes from the owner's re-scope relayed in [Lead commission](router://0ff962c5-7fa3-4c18-a5ca-1bbe8db09e89/push/01a18e04-af21-7ea2-a85c-5371212035d7): preserve the thinking, copy to `agent-collaboration/switchboard`, remove non-Switchboard/non-sign-in code, then deliver the existing X′ identity design. Fleet central's authority, sign-in's minting role, machine login and workspace registration are settled inputs.

## B1. Removing the twelve packages breaks retained test-source closure

**Blocks:** step 2's independently passing validation, not copying the repository.

**Source:** eleven kept manifests have **21 internal dependency edges, all within the keep set**, including development dependencies. The source scan finds **29 direct import lines in 14 test files**, all under retained `tool-engine` or `tool-host-node`, into removed MCP Portal, Tool Portal or Gateway Runtime. Both packages' typecheck configurations include those tests. Production-only build closure would miss this.

Decisive examples at H:

- `packages/tool-engine/src/capability-dispatch/capability-dispatcher.unit.test.ts:19–20` imports Gateway Runtime's managed projection and fixture.
- `packages/tool-host-node/src/standalone-tool-portal/standalone-resource-parity.integration.test.ts:12–20` imports the old MCP backend and old Tool Portal service/listeners.
- `packages/tool-host-node/src/standalone-tool-portal/standalone-dispatch-identity.unit.test.ts:1` imports `tool-portal/policy-comparison`; `tsconfig.base.json:34–35` resolves that to local source. It is absent from the old package's public exports (`packages/tool-portal/package.json:22–42`).
- `packages/tool-host-node/src/testing/controlled-upstream-parity.integration.test.ts:2` imports another workspace-only testing alias (`tsconfig.base.json:137–139`).
- `packages/tool-engine/tsconfig.json:1` and `packages/tool-host-node/tsconfig.json:1` include `src/**/*.ts`.

**Needed:** a disposition for each comparison/fixture before deleting its source. Preserve the behavior assertions and independent baseline. Do not replace an old implementation with the new implementation as both sides of a comparison, and do not assume every private test alias exists in a released npm package.

**Who decides:** the **🦁 Lead**, for reversible test/fixture relocation that preserves scope and assertions. Any weakening or removal of required proof goes to the **owner**. The complete import ledger is in [sdk-node-closure.md](sdk-node-closure.md); [support-closure.md](support-closure.md) records config/broker/UI closure.

The SDK's Gateway client, local-exec helper and managed relay are not missing-module imports: they use SDK-local contracts and transport. They remain explicitly exported/buildable managed APIs, however; copying the SDK does not copy their removed server. Keep that distinction in the extraction inventory. Redesigning Agent VM or silently removing these public SDK APIs is not necessary to resolve the test imports. Evidence: H `packages/agent-portal-sdk/package.json:56–62,80–86`; `tsdown.config.ts:15–17`; `src/gateway-runtime-client/index.ts:373–400`; `src/tool-vm-relay/local-transport.ts:66–72`.

## B2. The proof boundary extends beyond the eleven package directories

**Blocks:** step 2's working check/CI entrypoints; a package-only keep list is insufficient.

**Source:** H `scripts/verify-portal-package-exports.ts:33–56` explicitly requires removed controller/gateway contracts, Gateway Runtime and old Portal exports. `scripts/run-check-gate.ts:113–154` invokes that audit, contract generation and VM boundary/contract audits. The copied gate therefore cannot remain literally unchanged after removal. Root Vitest and TypeScript aliases also still point into removed directories (`vitest.config.ts:36–180`; `tsconfig.base.json:30–38,137–143`).

The contract generator is a concrete non-package dependency: `scripts/generate-portal-contracts.ts:15–22,74–98,101–123` reads a Python template, generates both the kept SDK's JSON schema manifest **and** `python/agent-vm-agent-portal-sdk/.../contracts.py`, formats Python through `uv`, and compares both artifacts in `--check-clean`. Deleting all Python/support files while keeping that check breaks it. This does not require keeping Hermes or a VM runtime.

**Needed:** one explicit extraction inventory covering root scripts, configs, tests, templates and generated SDK support, with each existing check marked retained, retargeted or removed because its product was removed. Keep the SDK's generated support until its existing contract/proof obligations have an agreed disposition. Do not use “rip twelve directories” as approval for a blanket gate reset.

The Worker's released legacy oracle belongs in that inventory **as an external test dependency**, not local product code. Its validator pins `npm:@agent-vm/mcp-portal@0.0.153`, pins its released config dependency and lock integrities, and refuses workspace resolution (H `packages/tool-host-cloudflare/src/test-fixtures/legacy-proxy-artifact.ts:35–50,87–104`). It is not a reason to retain the removed workspace MCP Portal. A global package-name rewrite or workspace override must not redirect this oracle to the new code. Installed provenance was not executed here.

**Who decides:** the **🦁 Lead** prepares the exact keep/retarget/remove mapping. The **owner approves root script/check-gate changes**, as the commission explicitly requires. Routine support-file placement is a reversible Lead call; deleting or changing a public SDK contract is not.

## B3. The delivery plans still execute the superseded repository boundary

**Derails:** both steps 2 and 3 if implementation follows the existing M1/A4b cards.

**Source:** D identity delivery plan `docs/specs/2026-10-24-agent-identity/plans/2026-10-27-agent-identity-delivery.source.html:296–304` moves **six** packages, then consumes the SDK and OAuth contracts as published Agent VM packages. That is six moved plus two external dependencies, not literally eight moved. The current owner instruction instead copies the repository and retains eleven package directories locally.

D `docs/specs/2026-10-24-delivery-orchestration/program-design.source.html:74–92` still assigns A4b to Agent VM, leaves the SDK there, and requires its fixed version to be published. The remediation plan repeats this at `docs/specs/2026-10-24-tool-portal-remediation/plans/2026-10-28-switchboard-remediation-delivery.source.html:99–107,150–154`. These are executable dependency mistakes, not only naming errors. The old M1 also assumes particular pre-copy gate restoration and script deletion; that cannot substitute for B2's approved extraction-specific changes.

**Needed:** update M1 and the SDK/Python work's repository ownership under copy-then-rip. Do not leave a Switchboard SDK repair waiting on an Agent VM PR/publication when that SDK is now in the keep set. Preserve Agent VM's documentation/thinking without assigning new Agent VM implementation. Name one governing home for each cross-repository design/plan and link from the other repos; copied copies must not become competing authorities. The commission reports PR #268 in Agent VM; its live GitHub state was not checked here.

**Who decides:** the **🦁 Lead**, as a plan/doc reconciliation within the owner's stated focus. No new owner decision about Agent VM's future is needed. The Lead should present any actual change to an approved outcome, contract or proof gate separately.

## B4. Contract handoff must survive the repository move

**Blocks:** independent sign-in/Fleet implementation when consumers need the contract; it does not block the repository copy or require a new identity architecture.

**Source:** X′ already assigns the homes at D `docs/specs/2026-10-24-agent-identity/program-design.source.html:135,142–144`:

- machine claims and removal notices originate in Rust `identity_contract.rs`, with generated schemas for TypeScript;
- workspace/collaboration claims originate in `tool-access/contracts`, with fixtures for Rust consumers.

The delivery plan already assigns F1 generated schemas/structural fixtures (`.../2026-10-27-agent-identity-delivery.source.html:369–380`) and distinguishes them from real producer-output checks (`:166–181`). But that paragraph still calls several contracts' locations their “agent-vm homes”. After the move, these must point to their actual Switchboard or codex-router owner.

**Needed:** preserve these existing homes and name the exact revisioned schema/fixture artifact each consumer takes, including who updates its pin and where the existing producer/consumer check runs. This is a concrete cross-repository handoff, not a Rust runtime dependency on a TypeScript package, or a reason to introduce another identity service/repository. Schema-generated fixtures remain structural proof; real minted-token/decision-output proof stays at the existing joint cuts.

**Who decides:** the **🦁 Lead**, coordinating the existing Fleet and Switchboard contract owners, for reversible artifact delivery/pinning. No new owner choice about identity authority is forced by extraction. Existing owner approval for sign-in tables/migrations still holds before B1 (`identity delivery plan:308–311`; Program Design `:1670`); repository copying does not grant it.

## B5. Publishing the copied packages needs an explicit npm ownership choice

**Blocks:** the first new package release/consumer cutover, not step 2's local copy or source work.

**Source:** the keep set at H mixes six `@agent-collaboration/*` packages with five `@agent-vm/*` packages: SDK, config contracts, OAuth contracts, broker and approval UI. Their own manifests specify these names, and kept dependency edges use both scopes. The old M1 publication plan only transfers the former six; it does not define the copied five's new release authority (D identity delivery plan `:298–300`).

**Needed:** decide the new product's published names and which repository owns future releases of the copied five, then change package names, imports, generated client imports and release references consistently. Avoid having two repositories publish independent successors under the same package name. Preserve the released legacy oracle's original names/pins from B2.

**Who decides:** the **owner**, because published package identity and existing consumers are a public contract. `@agent-fleet` ownership is owner/Lead-provided input, not a recorded selection of that scope for every package. The **🦁 Lead** can do the resulting mechanical inventory/rename within that decision. The assertion that nothing is published under `@agent-collaboration` is supplied by the commission; this audit did not verify the registry, and a single package's 404 would not establish scope-wide emptiness.

## Evidence limits

These are source-level blockers and disposition needs. The manifest inventory and direct-import scan do not prove installability, declaration emission, tests, deployed auth or a successful extraction. The report does not authorize implementation, a gate change, API deletion, migration, package publication, or an Agent VM redesign.
