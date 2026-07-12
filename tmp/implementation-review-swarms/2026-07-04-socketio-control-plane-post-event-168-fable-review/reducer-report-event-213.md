Event 213 Implementation Review Reducer Report
==============================================

Scope:
- Current branch diff: `origin/master...HEAD`
- Review packet:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`
- Workflow state:
  `tmp/workflow-state/2026-07-02-socketio-control-plane/details.md`

Reviewer lanes:
- Source/spec trace: `019f3078-82d7-7f63-90a3-f540da4e8b55`
- Proof/reachability: `019f3078-8748-7cd0-8e6f-778dfbe862eb`
- Security/trust: `019f3078-8b33-7de3-93f8-3b32558fc838`
- Contracts/regression: `019f3078-90bf-7122-817e-c36a8fe7459a`

All four agents were closed after harvesting.

Accepted findings:

1. Blocker: live beta Discord/OpenClaw proof is still missing.
   - Status: open.
   - Route: beta proof before PR-ready non-merge wrapup.
   - Evidence: plan and validation matrix require a real
     `../shravan-claw-beta` allowed-user inbound Discord/OpenClaw path.
   - Not a code defect; it is a remaining proof gate.

2. Important: static Tool Portal validation rejected valid zoneGit
   `controller_host_action` configs.
   - Status: fixed in `64a4c98`.
   - Fix: pass `includeZoneGitControllerHostAction` into
     `planMcpPortalEffectiveConfig()` when an OpenClaw zone has `zoneGit`.

3. Important: `--mcp-live` treated `controller_host_action` as an upstream MCP
   provider namespace.
   - Status: fixed in `64a4c98`.
   - Fix: skip upstream MCP namespace/provider probing for the controller-backed
     `controller_host_action` namespace when `zoneGit` is enabled.

Rejected findings:
- None from this local reducer. Proof/reachability and security/trust lanes
  reported no findings.

Fresh proof after fixes:
- Red proof before fix:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/operations/config-validation.integration.test.ts --reporter=verbose`
  failed only the two new controller-host-action validation tests.
- Focused green proof:
  same command passed 1 file / 30 tests.
- `pnpm --filter @agent-vm/agent-vm typecheck` passed.
- `pnpm test:integration` passed 28 files / 443 tests.
- `pnpm check` passed 10 checks / 0 failed in 25.40s.
- `pnpm fmt:check` passed.
- `git diff --check` passed.

Current status:
- Local implementation-review accepted code findings are fixed and checkpointed.
- Branch inventory is regenerated:
  413 files changed, 71080 insertions, 11450 deletions.
- Remaining blocker for PR readiness:
  live `../shravan-claw-beta` actual allowed-user Discord/OpenClaw inbound proof.
