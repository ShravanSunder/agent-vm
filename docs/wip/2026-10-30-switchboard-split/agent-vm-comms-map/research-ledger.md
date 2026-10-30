# Agent VM runtime communication map — evidence ledger

2026-10-30. Owner/Lead commission: understand the whole old Agent VM and draw current communication, then distinguish newer branch hosts and bounded Router touchpoints. All repository split/deletion/destination statements in the initial commission were explicitly withdrawn as decisions by its correction. This work does not choose destinations, adopt Effect, or change product code.

## Questions and bounds

1. Which processes, VM/provider handles, stores and transports compose Agent VM at master `38569fca72e88a74162b75f5401949ef19cd5a29`?
2. How do startup, leases, tools, consent, credentials and approvals cross those boundaries, including result/error return?
3. What changes on #262 `2dfea38e8dcdd01fce28d811ed5ec8db45c25023` and what sign-in runtime exists on #263 `0ff6a6afcaa443d0686f647564b1452af362b9a7`?
4. What Router-local MCP and Fleet connections exist at `f465808fe0acafab240a78472cdf0bb95dbb188a`, and is any Agent VM connection actually wired?

Evidence is static source inspection at those pins. No tests, builds, VM boots, requests, credential reads or deployment inspections are authorized. "Today" means the commissioned master source, not a verified installed deployment. External runtime behavior and undeclared deployment configuration remain unknown.

## Source routes and preflight

- Local code/docs first: `git show`, `git grep`, `git ls-tree`, direct scratch report reads. Read README, docs map, architecture model first. No third-party API claim requires web research; external libraries are left as named boundaries.
- Adjacent product source: codex-router exact pin for local MCP/Fleet transport only.
- Memory registry was used only to recover communication preferences and source-proof limits; no architecture fact is accepted from it.
- Web/DeepWiki/saved-reader/session-transcript/UI lanes skipped: no question asks current external service behavior, no UI/runtime observation authorized, no transcript needed.
- Pins accessible, shell read tools available, 297 GiB free. No credentials or live services needed. Existing report HTML directory is untracked; tracked worktree clean at `de2e51155e7376cb8298395a1410b336e6cdb30f`.

## Work home and bounded delegation

Existing trace: service `0ff962c5-7fa3-4c18-a5ca-1bbe8db09e89`, workspace `01a14e9e-ba87-7605-bc7b-7e6be7931fb1`, board `01a14e9e-ba87-7605-bc7b-7e6cdff4d3a5`, project `01a14e9e-ba87-7605-bc7b-7e6d49d07e5f`, root `01a16fc6-807e-786b-861e-48cef1bbfbb2`. Resumed recent history and posted scope correction at `01a18dba-e876-7a7f-bc92-6d775ca5a2a1`, epoch 2 position 1280.

Native Researcher Workers, fresh history, read-only product, disjoint scratch reports, no subdelegation or external communication:

| Lane | Classification | Model/effort | Reason and end check |
|---|---|---|---|
| controller/managed VM/storage | Complete, Cross-domain, Task | Sol 6.1 medium | Lifecycle joins several owners; source-anchored nodes, edges and recovery |
| gateway/Hermes/control sessions | Complete, Cross-domain, Task | Sol 6.1 medium | Both host and guest contracts; startup/control/return path |
| legacy tools/approvals/execution | Complete, Cross-domain, Task | Sol 6.1 medium | Several enforcement owners; entry through effect and cleanup |
| OAuth/secrets | Complete, Cross-domain, Task | Sol 6.1 medium | Consent, policy, encrypted credentials and VM mediation |
| newer hosts/sign-in | Complete, Cross-domain, Task | Sol 6.1 medium | Core/host/issuer joins and explicit branch-only status |
| Router touchpoints | Complete, Local, Task | Luna high | One product and its transport contracts; bounded MCP/Fleet map |

Parent owns config reading, joins, decisive-anchor reopening and synthesis. Reports do not independently prove deployment or acceptance. No separate reviewer commissioned: this is bounded collection and parent synthesis, not design acceptance.

## Queries and null results

- Agent VM: `git grep -n -i -E 'codex.router|agent.collaboration|router://|fleet.central|fleetCentral|routerEndpoint' 38569fca -- packages config vm-images` → exit 1, zero matches. This bounds the absence claim to the named paths and pin; external deployment configuration was not inspected.
- Located config schema/load/storage derivation with `git grep` in `packages/agent-vm/src/config/system-config.ts`.
- Router path discovery: `git ls-tree` plus `git grep` in collaboration-mcp and Host. Two initial unquoted shell globs failed before git; quoted/explicit paths replace them, no absence conclusion drawn from those failures.

## Important correction during collection

Configured CLI `targetKind: tool_vm` is executed by the Gateway Runtime over strict SSH; the controller's configured-CLI executor rejects that target. Controller-owned managed credentialed execution is a separate path. The controller still owns approval reservation/arming authority used by the Tool VM path. This is checked in synthesis rather than drawing every command through the controller executor.

## Synthesis and checkpoint

All six Workers returned their bounded reports. Parent read every report, reopened the decisive joins and authored `report.md`: topology first, responsibility slices, source-predicted startup and four tool-kind journeys, approval/state ownership, branch-only hosts/sign-in, then edge tables. The report is descriptive; all initial destination/deletion claims remain proposals outside this map.

Decisive parent reads include configuration loading/materialization, controller ownership/reconciliation/listeners, Gateway input construction and sibling boot, Python adapter initialization, private control/UDS composition, Tool VM creation/cleanup/mount selection, all configured CLI target distinctions, durable approval reserve/arm, old MCP projection/preflight and #262 authority-aware replacement, OAuth custody/policy/token projection, artifact authorization/relay/file-publication, #262 Node and hosted caller/runtime, #263 public and named management paths/provider claims, Router listeners and central session authentication. Worker-owned detailed collection remains in its six report files; parent conclusions cite the source, not a Worker receipt.

Additional null/correction checks:

- #262 broad namespace query matched `@agent-collaboration/*` names; these are not proof of Router calls. Narrowed `git grep -n -i -E 'codex.router|agent-collaboration/mcp|agent-collaboration mcp|router://|fleet.central|fleetCentral|routerEndpoint' 2dfea38e -- packages config vm-images` → zero matches, exit 1.
- `git grep -n 'startStandaloneToolPortalEntrypoints' 38569fca -- packages ':!*.test.ts'` → only its definition. Master standalone MCP Portal has separate executable CLI wiring, which was opened.
- Old protected-only MCP approval bridge: parent confirmed the upper grant/reservation sequence, bridge dropping authority to operation ID, unchanged requiresApproval projection and rejecting lower preflight. This is an inference from source, not a reproduced runtime defect. #262 exact-call-authority preflight differs and was opened.
- Hosted H/A mismatch: parent opened both caller-check implementations and A provider issuance. H selects a workspace and membership/persona; A uses organization-global proof/listing. No combined compatibility claim follows.
- Local Hermes framework source search returned no matching gateway/run-agent file under the OSS home; DeepWiki was not advertised. Actual upstream channel/session loop remains explicitly uninspected.
- Two guessed deeper source paths failed; `git ls-tree` found actual `packages/gateway-runtime/src/backends/` paths and those were opened. No conclusion rests on failed path reads.

Checks: `anchor-check.json` records 227 pinned source references across 124 distinct files with no missing file/line ranges and no broken local report links. It is a structural reference check, not semantic or runtime proof. Source citations in the main report link to immutable Git revisions. `git diff --stat` is empty in both Agent VM design and Router checkouts; Agent VM status still shows only the pre-existing untracked owner HTML report directory. Scratch is ignored by Git.

Owner-ask comparison: whole old Agent VM responsibilities and communication mapped; startup, remote MCP, Tool VM/configured CLI, per-user Google and bounded collaboration paths covered; newer Node/Worker/sign-in and Router differences separated. Package dependencies remain the Lead's separate task. No proposed split is treated as decided. No new owner decision is raised by this descriptive map.

Remaining limits: deployed configuration/version/reachability, upstream Hermes continuation, library internals, actual MCP approval reproduction, host/network/VM/crash correctness and H/A integration are unobserved. No stand-in was executed and no test/build/runtime/credential probe ran. No implementation or Effect comparison is open in this commission. Next consumer action: use `report.md` for the owner's progressive-disclosure runtime drawing, preserving the unknown/branch-only edges.

Delivery: commissioned source-map handback to the current Lead is push `01a18dca-7ca3-7c80-9cf2-fab5af23f0c8`, receipt `peerMessageWritten` (delivery only; no acceptance inferred). This does not send or revise the owner's separate personal Effect HTML report. Final source-map outcome checkpoint was posted to the same existing work root; no root resolution or wake was requested or created.


## Correction after Lead handback, 2026-10-30

Lead push `01a18dd0-bb38-71a2-bb7b-5060918aad1d` reports using the map and spot-checking Tool VM execution, sibling boot, host-dialed control, durable approvals and the Router absence query. Those are the Lead's reported checks; parent source evidence above remains their basis here.

The Lead correctly challenged the implied relationship between H and A. Parent ran `git merge-base 2dfea38e 0ff6a6af` → full A hash, `git rev-list --count 0ff6a6af..2dfea38e` → 59, and `git diff --stat 0ff6a6af 2dfea38e -- packages/auth` → 44 files, 3027 insertions, 256 deletions. H includes A plus later workspace auth work. The earlier H/A contract difference is retained only as historical evolution, and withdrawn as evidence of an integration mismatch within #262. H's auth and Worker at H were not checked together. The Lead explicitly requests only noting this, no new research now.

Updated `report.md` pin legend, prominent correction, section 2.5, sign-in subsection, historical table labels and unknowns; also qualified the lane `new-hosts-auth.md` so its old warning is not reused as a current finding. No product code changed, no tests/builds/runtime work or further auth research ran. The original map's other source conclusions remain unchanged. No owner decision or pending work is introduced.
