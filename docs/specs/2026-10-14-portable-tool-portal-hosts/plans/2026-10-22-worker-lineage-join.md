# Join the Worker lineage to the accepted S4 stack

> **Status (2026-10-28): done; record.** The join was accepted at #246 `a5ff0ba6` on 22 October. The [Switchboard remediation plan](../../2026-10-24-tool-portal-remediation/plans/2026-10-28-switchboard-remediation-delivery.html) now governs this code, which moves to its own `agent-collaboration` repository first (OD13).

**Status: accepted by the Lead (2026-10-22).** Ready for implementation. Phase 1
research (a dry run of every merge, done in a scratch clone with no pushes) is
the evidence:
`tmp/practices-research/2026-10-22-worker-lineage-join/research-ledger.md` in
the S4d Implementer's worktree.

## Why

The Worker's pull requests branch from S3b (#244), and the S4 stack branches
from it separately. So the Worker can't use S4d's outbound MCP client until the
two lines join, and every later Worker step needs one tree: outbound tool
servers, configuration in the database, and the workspace as the portal's unit.

```text
today   #244 S3b ─┬─ #245 S3d ─ S4a ─ S4c1 ─ fix ─ S4b ─ #259 ─ #256 S4d (77c4c52a)
                  └─ #246 Worker ─ #248 tool-host-core ─┬─ #247 deployed checks
                                                        └─ #249 Hegel properties
after   … #256 S4d ─ #246 Worker ─ #248 tool-host-core ─┬─ #247
                                                        └─ #249
```

## Rulings

- **R1, one owner for the portable schemas.** Tool Access owns the provider
  and secret schemas. `tool-host-core` imports or derives them and deletes its
  copies, which match Tool Access byte for byte once normalized. Hosted
  organization configuration, binding lookup, environment-only enforcement and
  the Durable Object wiring stay in `tool-host-core`. This is its own commit.
- **R2, one closure rule.** `tool-host-core` adopts the dual scan accepted for
  Engine in S4d, through one parameterized scanner shared by both packages:
  - first-party code (`tool-host-core` and `@agent-collaboration/*`) has no
    `node:` import under Node conditions. The existing single, narrowly
    specified SDK-server `node:process` shim keeps its current scope;
  - the full closure, resolved by the real Worker bundler under Wrangler's
    conditions and with non-literal `import()`/`require()` rejected, has no
    `node:` import.

  The name-based `pkce-challenge` ban is removed. It stood in for "no Node-only
  code on the Worker", which the Worker-resolution scan now proves; under Worker
  conditions pkce resolves to its browser build. Every other forbidden
  first-party edge stays (`agent-vm`, `@cloudflare/workers-types`,
  `typescript`, and the rest). Nothing is allow-listed. Permanent negative
  controls: a host-core first-party `node:` import, the browser-field fixture
  and the non-literal fixture each fail under the host-core scan.
- **R3, the Wrangler stand-in closes.** With Wrangler in the tree, the Worker
  scan resolves esbuild from the installed `wrangler` (a dependency of
  `tool-host-cloudflare`) instead of the root pin. Drop the root
  `esbuild` 0.28.1 devDependency if nothing else uses it. This is its own
  commit.
- **R4, boundaries unchanged.** `tool-host-core` keeps composing Engine's
  `createMcpGateway`, and the standalone core stays a separate wire projection.
  No second execution owner.

## Steps

1. Merge S4d (`77c4c52a`) into `tool-host-cloudflare/s6-worker`. In
   `contracts/index.ts`, keep both sides: the Worker's agent-proof export and
   the S4 exports. Regenerate `pnpm-lock.yaml` with pnpm 10.33.0.
2. Adopt the outbound client in the Worker's
   `src/organization-engines/worker-upstream-transports.ts` (the saved
   three-file adoption patch), as its own commit.
3. Merge `s6-worker` into `tool-host-core/runtime-neutral-hosting`, applying R1
   and R2. Keep both export inventories in `verify-portal-package-exports.ts`.
4. Apply R3.
5. Merge `runtime-neutral-hosting` into `tool-host-cloudflare/deployed-checks`
   and into `tool-host-core/hegel-access-properties`.
6. Retarget #246's base to `tool-portal/s4d-outbound-mcp`.

Every merge is an ordinary signed merge: no rebase, no force push, no history
rewrite. All pull requests stay drafts.

## Proof

- Each step: the targeted tests of the changed packages, run locally. No Docker
  or VM on the Mac.
- The final #247 and #249 heads: the Lead's full sunclaw sweep (check, unit,
  integration, e2e-host, Python), which runs only when sunclaw's load is normal.
- The paired Verifier observes R2 (controls red, then green when restored, and
  the real closure clean), R3 (esbuild from the installed `wrangler`) and the
  adoption.
- Not in this plan: deploying the private Worker or running its deployed
  checks. That's a later step the Lead schedules.

## Out of scope

The workspace-as-unit redesign (fleet F-69 to F-76) comes after the
Specification and Program Design are revised.
