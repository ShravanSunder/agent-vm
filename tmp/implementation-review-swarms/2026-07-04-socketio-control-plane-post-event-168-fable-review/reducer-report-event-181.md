Post-Event-180 Reducer Report
=============================

Verdict: not_ready

Review class:
- source-backed
- plan-backed
- risk-triggered

Whole-source trace:
- required
- completed by read-only reviewer lanes

Scope reviewed:
- staged diff against `origin/master`
- accepted Socket.IO control protocol spec
- gateway hard-cutover spec
- 2026-07-02 vertical-slice implementation plan
- validation proof matrix
- current post-Event-180 review packet

Reviewer lanes completed and closed:
- whole-source trace: `019f2ba1-80ac-7d82-bd8c-3b4de7aff20a`
- spec/plan compliance: `019f2ba1-8564-73b3-ab0b-a97fa318a65c`
- proof/reachability: `019f2ba1-8953-73f0-9227-7c5f655bfc64`
- security/trust boundary: `019f2ba1-8d6d-7b22-9c02-a8d40c06f2fc`
- reliability/lifecycle: `019f2ba1-925e-7b91-8a71-3a0f3f418eac`
- contracts/tests/code quality: `019f2ba1-96b4-7770-b6e8-e73da66a769d`

Accepted findings:

1. Blocker: control-session reconnect across controller restart is not
   implementable with current in-memory signer material.
   - Evidence:
     `packages/agent-vm/src/controller/control-session/gateway-control-session.ts`
     and `worker-control-session.ts` generate Ed25519 private keys in memory.
     VM runtime config receives only verifier public key material.
     `gateway-runtime-record.ts` does not persist control-session signer
     material.
   - Scenario:
     Controller A boots a VM. Controller B restarts within death grace but has a
     new private key, so it cannot sign the existing VM's ready/upgrade
     credential. The live VM cannot reconnect/resync and must be recreated.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     cross-process or persisted-state integration that a fresh controller
     reconnects to a still-running gateway/worker service without VM recreate.

2. Blocker: existing leases lose caller-context authority after controller
   restart.
   - Evidence:
     `gateway-control-lease-client.ts` caches only callerContextId by leaseId.
     Only `requestLease` refreshes cached caller context when the controller
     returns `absent`; `lease_renew`, `lease_release`, `lease_use_start`,
     `lease_use_heartbeat`, `lease_use_end`, and `lease_peek` reuse the old id.
   - Scenario:
     Controller caller-context registry is rebuilt empty after restart. Active
     lease operations return absent and turn a tolerated reconnect into broken
     active Tool VM use.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     integration/unit test that a cached active lease operation re-registers
     caller context once after an absent response.

3. Important: pending command-result waiters can be overwritten by retrying the
   same messageId while the previous timeout remains armed.
   - Evidence:
     `waitForControlSessionCommandResult`, `waitForGatewayControlCommandResult`,
     and `waitForWorkerControlCommandResult` set a timeout keyed by messageId
     but do not cancel an existing waiter before replacing the map entry.
   - Scenario:
     attempt 1 is acked then loses transport before command_result; attempt 2
     reuses messageId; attempt 1's timer deletes attempt 2's pending waiter.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     focused integration/unit coverage for reused messageId replacing or
     reusing the waiter safely.

4. Important/security: managed SSH egress uses host GitHub SSH agent without a
   production repo allowlist.
   - Evidence:
     `openclaw-lifecycle.ts` and `worker-lifecycle.ts` call
     `createGitReadOnlySshEgressOptions` with only `allowedHosts:
     ["github.com"]`; `vm-adapter.ts` enforces repo scoping only when
     `allowedRepos` is supplied.
   - Scenario:
     compromised VM can run read-only `git-upload-pack` against any GitHub repo
     the host SSH identity can read.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     production lifecycle path must either pass trusted repo allowlists or fail
     closed when no allowlist is available.

5. Important: generated Tool VM lease manual still teaches removed HTTP lease
   semantics.
   - Evidence:
     `manual-templates.ts` still says "controller lease request", "GET lease",
     and "POST renew"; `manual-templates.unit.test.ts` asserts that wording.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     manual unit test and residue audit reject stale public HTTP lease guidance
     in generated manuals.

6. Follow-up/important residue: shipped OpenClaw plugin manifest still says
   "controller lease API".
   - Evidence:
     `packages/openclaw-agent-vm-plugin/openclaw.plugin.json` description.
     The package build copies the manifest into `dist`.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     audit scans shipped plugin/package metadata, not only TypeScript and docs.

7. Important: portal export audit does not cover all live public import
   surfaces.
   - Evidence:
     `verify-portal-package-exports.ts` omits `@agent-vm/mcp-portal/core` and
     several root named exports used by runtime code.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     verifier covers every runtime-consumed public specifier/name.

8. Important: JSON Schema proof does not satisfy the source matrix snapshot /
   equality gate.
   - Evidence:
     contract tests fully compare only the shared envelope JSON schema and only
     smoke-check domain schema shapes.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     exact `z.toJSONSchema(...)` equality or snapshots for every exported
     schema bundle.

9. Important proof gap: Worker control e2e proves worker-side protocol emission
   with a fake controller socket, not the real controller-backed git RPC path.
   - Evidence:
     `worker-control-session.worker.e2e.test.ts` fabricates controller
     command_result payloads; it does not run
     `worker-control-domain-handler.ts`.
   - Route:
     `implementation-execute-plan`.
   - Proof needed:
     either add real controller-backed worker git RPC e2e coverage or narrow the
     proof claim to worker-side protocol only.

10. Important proof gap: terminal live OpenClaw, Worker, VM, aggregate e2e, and
    beta Discord/OpenClaw proof are stale after later runtime-affecting fixes.
    - Evidence:
      current review packet states those proof layers still need refresh after
      accepted Fable findings.
    - Route:
      `implementation-execute-plan`, then `implementation-review-swarm` after
      fresh proof.

11. Follow-up: Vitest aliases still advertise the removed
    `credentialed-runner-boundary` subpath.
    - Evidence:
      `vitest.config.ts` still maps the removed subpath.
    - Route:
      `implementation-execute-plan`.

Rejected or downgraded:
- Raw-control removal itself is not accepted as a surviving implementation
  defect. Reviewers found the managed raw-control surfaces removed, with stale
  wording handled separately as residue findings.

Review proof:
- The prior focused unit/integration/static proof remains useful but no longer
  proves PR-readiness because accepted implementation defects and stale terminal
  proof remain.

Recommended next workflow:
`shravan-dev-workflow:implementation-execute-plan`

Recommended transition reason:
Accepted blocker and important implementation findings remain after
post-Event-180 review. Fix accepted issues, run focused proof, refresh the
review packet, rerun implementation-review-swarm, then refresh terminal e2e and
beta proof before PR-ready wrapup.
