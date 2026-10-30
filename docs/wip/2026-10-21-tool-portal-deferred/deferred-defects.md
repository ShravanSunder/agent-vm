# Tool Portal: defects found and deferred during the decomposition

These are defects in today's behavior, found while porting it. The new code reproduces each one exactly ("same behaviour"). Fixing them belongs after cutover (S4), as an owner-visible change.

| Found | Defect | Today's anchors | Kept as | Who would notice |
| --- | --- | --- | --- | --- |
| 2026-10-21, S3d (#245, Bugbot) | A standalone artifact read can return no media type, but the Portal SDK's high-level `artifacts.read` requires one, so the SDK call fails for such an artifact | Portal SDK `index.ts:105–113`; old MCP projection returns `mimeType` undefined; identical at `d25be046` | today's behavior, pinned by an old-versus-new parity test | a Portal SDK caller reading an artifact that has no media type |

Fixed instead of deferred, because the new code would otherwise break a published contract:

| Found | Defect | Fix |
| --- | --- | --- |
| 2026-10-21, S3d | Today's standalone approval coordinator emits a 32-hex `challengeId`, while the Portal SDK schema requires a UUID | the new Node host formats a deterministic UUID from the same fingerprint; token bytes are unchanged |

## Order-sensitive assertion on concurrent effects (test defect)

`packages/tool-engine/src/mcp-gateway/approval-carriers.unit.test.ts:73`
(from S3a, #241) compares the order of upstream effects with the order of the
calls in the batch. The calls in one batch run concurrently by design, so under
load they can finish in either order: `[43, 42]` instead of `[42, 43]`. Seen
once on 2026-10-21 in a loaded Implementer run at b8c80560; it passed 6/6 when
rerun. **Fix in its own layer:** compare the effects' arguments as a multiset,
and keep the exactly-once count and the receipt assertion. This doesn't weaken
proof, because order isn't a requirement. Not changed during the structure
pass.

**Second instance, same pattern (2026-10-22):**
`packages/tool-engine/src/standalone-tool-portal/standalone-tool-portal-core.unit.test.ts:67`
("matches the frozen d25 built core for all four operations and mixed canonical
outcomes") compares effect tool names in a fixed order. In the Lead's sunclaw
sweep at S4c2 `61d24f82` it saw `['failed','uncertain','read']` instead of
`['read','failed','uncertain']`. The same file passed at `860ad050` and
`c08a0915`, and S4c2 doesn't touch tool-engine. Same fix in its own layer:
compare as a multiset and keep the exactly-once counts.

**Third instance, same pattern (2026-10-22):**
`packages/gateway-runtime/src/managed-tool-engine/managed-call-results/managed-call-batch-failures.unit.test.ts:206`
("preserves the completed sibling and literal failure outcome at
missing-challenge") compares the order in which two concurrent batch items were
dispatched. In the Lead's sunclaw sweep at S4d `ada827da` it saw
`['failing-item','original-item']` instead of `['original-item','failing-item']`;
it passed at `80067700`, and S4d doesn't touch gateway-runtime. Same fix in its
own layer: compare the dispatched items as a multiset and keep the effect,
result and release assertions.

**Fourth instance, same pattern (2026-10-23):**
`packages/tool-host-cloudflare/src/worker-mcp-serving/worker-parity.host.e2e.test.ts:159`
compares the order in which the upstream fixture received four effects:
expected `[first,last,first,last]`, got `[first,last,last,first]`. Seen in the
sunclaw host gate at #249 `bb71279b` (catalog-ordering slice); the same test
passed at #247 `904841d1`. `compare` awaits the reference host before the
Worker, so the cross-host order is fixed; within one host, batch items run
through `Promise.all` (tool-engine `portal-call-execution.ts:159`) and the
fixture records calls on HTTP arrival (`controlled-mcp-issuer.ts:140`), so
the two effects of one host can arrive in either order while the ordered
result assertions still pass. Admitted as an exception for that slice. Fix in
its own layer: assert each host's two-effect chunk as the multiset
`{first,last}`, keep the total of four and the ordered result assertions.

**All four are queued as one test-only slice**, re-gated once, instead of
four separate changes.

## Completed-result budget keeps survivors by completion order (product defect, held for #33)

Bot review thread r4350681792 on #246, now in `tool-host-core` (#248). When a batch's
completed results exceed the per-request budget, which items survive depends on the
order calls finish, not on request order. The Implementer reproduced it with a unit
test: the same inputs and successes keep a different item depending on completion order.

**Why it's held:** the brief (S4d Implementer's worktree,
`tmp/worker-review-triage-evidence/budget-boundary-brief.md`) found no fix that keeps
today's memory bound. Admitting results in request order needs scheduling or eviction
that today's interfaces don't have. A deterministic accumulator needs a new seam between
the host and Engine. Removing the cap allows about 50 × 4 MiB per request. The owner
hasn't accepted any cap and wants large results streamed or spilled to disk (#33), so the
fix belongs with that design.

**Open risk for #33 (estimated, not measured):** about 16 MiB of retained results plus
6 × 4 MiB in flight is about 40 MiB of wire-equivalent data per request. Three concurrent
requests come to about 120 MiB before parsed and copied forms, close to the Worker's
128 MiB limit. The thread stays unresolved, with a reply pointing here.

## Approved managed MCP calls are refused at the provider (pre-existing product defect) — FIXED

**Fixed at `23b1e33d` (draft PR #253), accepted by the Lead on 2026-10-22.** The
owner asked for the fix on 2026-10-22 ("yes fix approval bug"). The managed backend
port now forwards the dispatch authority that S2 already checked. The provider
admits a requiresApproval tool only for a single call whose approval grant names
that call's operation id. S2 and the controller ledger remain the only owners of
the exact-call binding and the one-use rule. Proof:

- The permanent test `managed-mcp-approval.integration.test.ts` runs the real UDS,
  production composition, S2, provider and a controlled MCP server, with the durable
  ledger. Before the fix it fails: an approved, armed write had 0 effects. After the
  fix the write runs once and a replay adds nothing. Mismatched, no-grant, blocked and
  self-approval cases have 0 effects.
- Three wrong builds each fail on the server's effect count: no-grant accepted (1
  vs 0), a wrong-fingerprint grant accepted (1 vs 0), replay allowed (2 vs 1). Both
  the Implementer and the Verifier ran them.
- The sunclaw sweep passed: check 16/16, unit 5490/5490, integration 1048/1048,
  e2e-host 244/244.

The history below is kept as found.

In agent-vm's managed path, an MCP tool that requires approval is refused even
after the controller approves it. `createToolPortalMcpProjection`
(`packages/config-contracts/src/tool-portal-config.ts:1077`) copies the profile's
`calls` unchanged into the provider's view. The managed wrapper
(`packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:153–175`)
passes the operation id but no approval grant. The provider's
`preflightCallDecision` (`packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:547–568`)
then answers `approval_required` for every requiresApproval tool; its unit test
(:737) pins that. Existing approval tests use factory doubles, so they never hit it.

Confirmed on 2026-10-21 by S4a's Implementer with the actual old factory,
connector and a controlled MCP server: an unprotected `read_thing` ran once; a
grant-carrying `write_thing` was refused `approval_required` with no effect.
Source is identical at `08f9e426` and #245. Reconfirmed with the real durable controller ledger: the decision armed the dispatch (`dispatch-armed`), yet the provider still answered `approval_required` and the write never ran (S4a evidence `old-approved-provider-ledger.log`).

**Not changed in S4a.** The cutover keeps today's behavior, and its tests don't
pin the defect as expected. Fixing it changes behavior: the provider would have
to accept a controller-dispatched approval for that exact call. **Owner decision.**

## Temp-directory cleanup race in a controller lifecycle test (test defect)

`packages/agent-vm/src/controller/zone-runtimes/managed-gateway-zone-runtime.unit.test.ts`,
"keeps lifecycle operations serialized until a timed-out replacement gateway
settles", failed once on sunclaw during a full parallel unit run at `83e9683f`
(S4c1 part 1) with `ENOTEMPTY: directory not empty, rmdir
…/runtime/gateway-lifecycle`, in its own temp-directory teardown. Alone it passed
42/42 five times in a row, and the S4 stack doesn't touch that directory (empty
diff from `40a4ec5b`). **Fix in its own layer:** the teardown should wait for the
timed-out replacement gateway to settle, or remove the directory recursively
after it settles. Don't add a retry.
