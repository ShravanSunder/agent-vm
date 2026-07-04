# Reducer Report - Event 178

Goal: `2026-07-02-socketio-control-plane`

Verdict: `not_ready`

The post-Event-177 implementation-review lanes completed after the workflow
state had already marked the packet review-ready. Parent reduction accepts the
findings below as in-scope implementation or proof blockers. The official route
returns to `shravan-dev-workflow:implementation-execute-plan`.

## Lanes Received And Closed

- Whole-source trace: `019f2b4b-2184-7a40-b2d5-ab44ab618b29`
- Implementation proof: `019f2b4b-498c-7792-9971-be60e54201c5`
- Security/trust: `019f2b4b-71c6-7a32-8aaf-06de7fc4707a`
- Runtime reliability: `019f2b4b-99ae-7d90-b76d-08fd6049e27b`
- Contracts/tests: `019f2b4b-c061-7322-aec5-5f65de4d7799`
- Recent-fix spot check: `019f2b4d-5512-7372-b1d7-844bf3e68be5`
- Raw-control residue audit: `019f2b4d-85c5-71c3-fa3b2a238179`

All seven reviewer agents were closed after their reports were collected.

## Accepted Findings

1. Source-of-truth worker docs still describe the retired
   `push-branches` HTTP callback path.
   - Route: implementation-execute-plan.
   - Required fix: update active architecture docs so Worker git push/pull
     routes through `worker_control_rpc`, while task submit/state/close stay on
     ingress HTTP.
   - Proof: `rg -n "push-branches endpoint|push-branches API|POST /push-branches" docs/architecture/overview.md docs/architecture/agent-worker-gateway.md`
     returns no active-flow matches.

2. Residue proof gate does not scan shippable docs/manual surfaces.
   - Route: implementation-execute-plan.
   - Required fix: extend the portal architecture/residue audit to include at
     least `docs/architecture/**`, `docs/getting-started/**`, and
     `packages/agent-vm/src/cli/manual-templates.ts`, with a planted-positive
     test.
   - Proof: audit unit test fails on retired raw-control guidance in a scanned
     docs/manual file; `pnpm check` includes the strengthened audit.

3. `resync_required` is treated as terminal stale instead of a reconnect/resync
   path.
   - Route: implementation-execute-plan.
   - Required fix: keep reconnect hello on a reconnecting path when the peer
     asks for resync and complete a new hello/resync attempt before declaring
     the session stale.
   - Proof: integration test where reconnect returns `resync_required` once,
     then accepts, and the client returns to ready without VM/task recovery.

4. Reconnect hello timeout is swallowed, so Worker control can look connected
   while unusable.
   - Route: implementation-execute-plan.
   - Required fix: when a reconnect hello fails or times out, explicitly close
     or stale the session so health does not report a usable connected session.
   - Proof: integration test where transport reconnects but the second
     `control:hello` never acks; diagnostics become unhealthy and later RPCs
     fail because the session is stale/closed, not superficially live.

5. Ready-credential fetch is not bounded by the control-session connect budget.
   - Route: implementation-execute-plan.
   - Required fix: wrap gateway and worker readiness credential fetches with an
     `AbortController` using `CONTROL_SESSION_TIMING_MS.connectTimeout`.
   - Proof: gateway and worker unit/integration coverage with a ready route
     that never responds, asserting fetch aborts within the configured budget
     rather than wedging manual reconnect.

6. `caller_context_register` can grow unbounded controller trust state.
   - Route: implementation-execute-plan.
   - Required fix: bound the caller-context registry and preferably expose
     clear/forget behavior for session turnover.
   - Proof: unit/integration test proves a flood of unique contexts is rejected
     or evicted at the cap.

7. `tool_vm_runner` is accepted by public Tool Portal config but no runtime
   backend/projection exists.
   - Route: implementation-execute-plan.
   - Required fix: fail closed until the backend exists, or implement a real
     backend. Current repair should reject/throw explicitly rather than turning
     valid config into misleading `capability_denied`.
   - Proof: focused Tool Portal test with `tool_vm_runner` config rejects at
     validation/runtime creation unless a real backend is wired.

8. Latest proof packet dropped lease-side stale caller-context and gateway
   startup/materialization proofs.
   - Route: implementation-execute-plan.
   - Required proof refresh:
     `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
     and
     `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`.

## Deferred Or Follow-Up Findings

- Worker heartbeat schema parity is a follow-up unless a current source row
  requires worker heartbeat before PR readiness.
- Session-scoped Tool Portal entrypoint/backend cache growth is a follow-up
  unless further source inspection shows it can be driven unbounded by
  untrusted input in the current managed path.

## Rejected Findings

- Raw-control residue audit found no live shippable runtime residue in the
  focused raw-control surfaces. The audit-script scope gap is accepted above,
  but no additional raw-control code residue was accepted from that lane.

## Routing

phase_result: `needs_revision`

recommended_next_workflow: `shravan-dev-workflow:implementation-execute-plan`

recommended_transition_reason: accepted important implementation and proof
findings remain; fix them, rerun focused proof, refresh the review packet, and
then rerun implementation-review-swarm/Fable before terminal e2e/beta proof and
PR-ready non-merge wrapup.
