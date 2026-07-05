Please perform a read-only implementation review of the current committed
branch diff.

Repo:

```text
/Users/shravansunder/Documents/dev/project-dev/agent-vm.mcp-portal-better-interface
```

Review packet:

```text
tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md
```

Latest workflow state:

```text
tmp/workflow-state/2026-07-02-socketio-control-plane/details.md
```

Read the packet first, then review the actual branch diff and source artifacts.
Do not trust summaries, prior reducer reports, or proof claims without checking
the current repo.

Scope:

- Branch: `mcp-portal-better-interface`
- Base: `origin/master`
- Branch diff against origin/master: `origin/master...HEAD`; see the refreshed
  inventory in the review packet. The inventory filenames still say `staged`
  because they are legacy generated review aids from earlier review cycles.
- Review class: source-backed, plan-backed, risk-triggered
- Whole-source trace required

The key job is to verify the current branch fixes after Event 172, Event 176,
Event 178, the post-Event-179 reducer fixes, the Event 181 reducer fixes, the
Event 183 signer-exposure fix, the Event 184 controller-restart semantics
correction, the Event 185 accepted finding fixes, the Event 187 Worker git RPC
proof-gap fix, the Event 188 internal-review fixes, and the Event 189 accepted
finding fixes captured in execution-report-event-190.md, plus the Event 191
fixes captured in reducer-report-event-191.md, plus the Event 192 Worker-control
scope fixes captured in execution-report-event-192.md, plus the Event 193
post-Fable fixes captured in reducer-report-event-193.md, plus the Event 194
accepted findings captured in reducer-report-event-194.md, plus the Event 195
accepted findings fixed in execution-report-event-196.md, plus the Event 205
OpenClaw health/recovery rerun, Event 206 post-OpenClaw `pnpm check`
refresh, Event 208 full Worker e2e refresh, Event 209 accepted finding fixes,
Event 210 stale Tool VM unit fixture repair, and Event 211 Composer/Bugbot
follow-up reduction recorded in workflow state, plus Event 212 terminal
OpenClaw, Worker, VM, default e2e, and `pnpm check` refresh.
In particular, scrutinize:

1. empty and multi-agent `zones[].agents` fail-closed behavior for managed OpenClaw
2. managed Tool Portal `controller_host_action.zone_git_push` profile binding
3. caller-context purpose/session/workspace scope isolation and stale cached context refresh
4. handler-generated response sequencing after rejected or pending receipts
5. Worker git retry command/message identity across ack-before-result reconnect/flap
6. portal export verifier freshness and new in-process named export coverage
7. standalone `pnpm lint` proof in addition to `pnpm check`
8. terminal e2e freshness after Event 200, OpenClaw freshness after Event 205,
    Worker freshness after Event 208, `pnpm check` freshness after Event 209,
    full unit freshness after Event 210, Event 211 full unit/full integration
    proof, Event 212 terminal OpenClaw/Worker/VM/default e2e and `pnpm check`
    proof, and remaining stale beta Discord/OpenClaw proof after Event 172
9. remaining old raw-controller string matches, especially whether deletion of
    `scripts/live-sandbox-manual.mjs` fully removes shippable manual raw-control
    residue
10. latest fixes for host-action authorization proof overgrant, MCP Portal agent
    parity, worker reconnect sequence continuity, and stale Worker raw-control docs
11. Event 178 fixes for reconnect/resync, reconnect hello timeout, ready-fetch
    aborts, caller-context registry bounds, `tool_vm_runner` fail-closed
    behavior, and shippable docs/manual residue audit scope
12. post-Event-179 fixes for lazy controller-host-action caller-context
    registration, current Tool Portal response-shape manual text, expanded
    shippable docs/manual audit coverage, and absence of stale Worker
    raw-control docs
13. Event 181 fixes for gateway control-session signer persistence, worker
    control-session material serialization boundary, active lease caller-context
    refresh, managed SSH Git read allowlisting / fail-closed behavior,
    generated lease manual and plugin metadata residue cleanup, portal export
    verifier expansion, full JSON Schema snapshot/equality proof, and stale
    Vitest alias removal
14. Event 183 signer-exposure fix: private gateway control-session signing
    material must not be written to guest-visible `gateway-runtime.json` or
    `zone.gateway.stateDir`; host-only material storage and cleanup must be
    correct
15. Event 184 controller-restart semantics correction: specs/plans/tests must no
    longer claim same-VM reconnect after controller process restart with
    Gondolin 0.12.0; RESILIENT-GRACE should apply only to in-process
    transport/socket flaps, while controller restart/redeploy is a managed-VM
    recreate boundary unless a future VM adoption API is specified and proven
16. Event 185 fixes:
    - caller-context ids are bound to accepted gateway boot/session and old
      contexts are evicted/released across lifecycle changes
    - managed OpenClaw strips stale base `mcp-portal` plugin config and rejects
      runtime `mcp-portal` plugin config
    - Tool Portal no longer imports `@agent-vm/mcp-portal/core` in production
      runtime code; MCP core assembly is behind `@agent-vm/mcp-portal/mcp-provider-backend`
    - unauthenticated `GET /leases` and `controller lease list` are removed
    - stale/absent controller-host-action caller contexts retry once in the
      same `tool_portal_call`
    - failed accepted gateway/worker upgrade credentials are terminal-stamped
      so reapers can evict them
    - managed SSH Git read allowlisting derives generic trusted repo hosts,
      permits upload-pack, denies receive-pack, and fails closed without a
      trusted repo allowlist
    - managed `hmacKey` docs no longer claim OpenClaw approval-token behavior
17. Event 187 Worker git RPC proof fix:
    - `worker-loop.worker.e2e.test.ts` should prove real Worker-originated
      `git_push` and `git_pull_default` through the controller-backed Worker
      control session, not a local synthetic socket result path
    - `worker-control-domain-handler.ts` should return full
      `worker_control_rpc` command-result messages, not bare payloads
18. Event 188 internal-review fixes:
    - Worker death-grace classification should require accepted/ready
      control-session diagnostics, not raw transport connection
    - controller-host-action caller contexts should be released/evicted after
      terminal use and stale rejection
    - package export verification should cover runtime-consumed named exports
      from the new control contract and Tool Portal/MCP backend surfaces
    - JSON Schema tests should compare reviewed static artifacts, not freshly
      generated schemas against themselves
    - stale `lease-list` public vocabulary should be gone
    - SG SSH Git egress assertions should be backed by a real `zoneGit`
      allowlist fixture
19. Event 189 fixes:
    - managed Tool Portal effective config should be read-only inside the
      OpenClaw guest and manifest paths must be validated inside the
      controller-owned effective-config directory
    - accepted post-ack handler failures should produce explicit failed
      `command_result` messages when the domain supports them, not only
      transport timeouts
    - failed reserved handler-response receipts should stale/close the session
      rather than leaving sequence holes
    - gateway `zone_git_push` should retain `messageId`, `commandId`, and
      `idempotencyKey` across ack-before-result flaps
    - `/leases` route disposition should be consistently delete in plan/slice
      and implementation
    - package export verification should include root runtime named exports
      from `@agent-vm/agent-portal-sdk` and
      `@agent-vm/controller-execution-contracts`
    - portal call JSON Schema proof should compare generated schemas against a
      reviewed static snapshot artifact
20. Event 191 fixes:
    - package export verifier should cover the missing runtime-consumed root
      exports reported after Event 190
    - gateway/worker control package metadata should no longer describe the
      packages as placeholders
    - gateway `zone_git_push` stale caller-context retry should refresh command,
      message, and idempotency identity, while accepted-result retry should
      reuse identity
    - controller-mediated `zone_git_push` should refuse the concrete shipped
      protected defaults `main` and `master`; scrutinize whether lack of a
      general configured protected-pattern source is acceptable for this PR
    - managed Tool Portal session-keyed entrypoints should be bounded, and the
      OpenClaw plugin should not retain its separate temporary caller-context
      scope map after entrypoint creation/failure
    - worker-control scope concern should be rechecked against current
      contracts and handlers; scrutinize whether worker-originated runtime
      observations need another production emitter before PR-ready
21. Post-Event-191 proof cleanup:
    - plain `pnpm lint` should be part of the refreshed proof and `pnpm check`
      should include a distinct lint line
    - the CI/default e2e label should not imply OpenClaw and Worker proof are
      part of the default four-lane `pnpm test:e2e`
    - `staged-stat.txt` is a generated review aid with a documented
      legacy filename caveat; use live `git diff --stat origin/master...HEAD`
      when exact counts matter
22. Event 192 Worker-control scope fix:
    - VM-side Worker control application handler should accept `control_ping`,
      handle controller-originated `operation_cancel`, handle
      `recovery_command.refresh_runtime_status`, reject unsupported recovery
      actions, and reject controller-originated `git_push` / `git_pull_default`
    - Worker runtime should publish advisory capacity/runtime observation
      events over `worker_control`
    - controller Worker domain handling should persist advisory observations
      without mutating controller-owned task authority
    - Worker task submit/state/close must still remain ingress HTTP in this PR
23. Event 193 post-Fable fixes:
    - failed Worker tasks should publish failed `worker_runtime_observation` and
      error `worker_runtime_status` advisory events
    - Worker advisory publishes should be caught/logged, not left as unhandled
      promise rejections
    - gateway caller contexts should bind to accepted `sessionId` and
      `connectionId`, and stale contexts from previous accepted sessions should
      be rejected for lease and controller-host-action paths
    - Worker `worker_capacity_snapshot` and `worker_runtime_status` publisher
      envelopes should be `latest_wins` events with no `commandId` /
      `idempotencyKey`
    - controller Worker domain handler should record capacity/runtime status
      observations without invoking controller git mutations
24. Event 194 post-Fable fixes:
    - controller-originated Worker `operation_cancel` should be hard-rejected
      over `worker_control`; Worker task submit/state/close remain ingress
      HTTP-only in this PR
    - VM-side Worker control handler should no longer depend on a close-task
      callback or close the active task from the control socket
25. Event 195 post-Fable fixes:
    - latest-wins and droppable advisory packets should not reserve or advance
      the hard critical-command sequence frontier
    - queued latest-wins flushes should be ordered by envelope sequence before
      volatile emit so coalescing by key cannot reorder across keys
    - Worker `operation_cancel` should have both Socket.IO service-level proof
      and live active-task proof showing it does not close the task
    - managed Tool Portal entrypoint LRU eviction and runtime close should
      retire session-scoped MCP provider backend/session state
    - active Tool VM leases should remain reachable after refreshed
      `callerContextId`/`sessionId`/`connectionId` when stable provenance
      matches, and remain unreachable for different agent/session-key
      provenance
    - root plan, canonical proof matrix, and slice files should describe these
      semantics so implementors do not rebuild the stale model
    - Gateway and Worker peer services should coalesce latest-wins advisory
      messages by control identity and use volatile emits for latest-wins /
      droppable traffic instead of unbounded acked sends
    - MCP-backed Tool Portal calls should scope upstream MCP sessions by session
      provenance, not only by agent identity
    - branch inventory should be current against `origin/master...HEAD`
26. Event 197 local reducer status:
    - child reviewer lanes were unavailable, timed out, or returned null
      payloads and were closed
    - local reducer checks found no accepted blocker/important Event 196
      regression
    - do not treat the local reducer as a substitute for this external Fable
      review
27. Event 200 terminal-proof refresh:
    - Worker advisory messages in the synthetic e2e controller are acked
      without command-result frames, fixing the `sequence_gap` failure in the
      live Worker control-session e2e.
    - Managed OpenClaw generator/host fixtures now include default trusted
      agents where the runtime requires them.
    - Host zone-git proof fixtures use non-protected branch names when the
      protected branch guard is not the behavior under test.
    - Full VM e2e, default four-lane e2e, and `pnpm check` are fresh and green.
28. Event 202 Bugbot drift fixes:
    - `zones[].toolPortal` is documented as the managed Tool Portal root, not a
      stale field.
    - The managed Tool Portal runtime plugin path is
      `runtimePluginConfigs.gondolin.toolPortal`.
    - The architecture overview package graph/table includes
      `control-protocol-contracts`, `gateway-control-contracts`, and
      `worker-control-contracts`.
29. Event 203 beta proof status:
    - Beta controller, OpenClaw ingress, `/readyz`, doctor, validate, Discord
      gateway connectivity, and OpenClaw `2026.6.8` plugin loading are freshly
      proven.
    - Fresh actual allowed-user Discord inbound proof is still missing and
      remains a PR-readiness blocker, not a code-review finding unless code
      makes the proof impossible.
30. Event 205 OpenClaw health/recovery reduction:
    - Focused `live-openclaw-control-link.openclaw.e2e.test.ts` rerun passed
      1 file / 3 tests.
    - Full `mise exec -- pnpm run test:e2e:openclaw` passed 7 files / 12 tests
      / 0 skipped / 0 todo.
    - The previously failing control-session health and gateway-recovery
      assertions passed inside the full OpenClaw gate.
31. Event 206 post-OpenClaw check refresh:
    - Fresh `pnpm check` passed 10 checks / 0 failed after the OpenClaw rerun.
32. Event 208 Worker e2e refresh:
    - Fresh full Worker e2e passed 3 files / 5 tests / 0 skipped / 0 todo
      after the shared control-session priority-lane change.
33. Event 209 accepted finding fixes:
    - `connectWorkerControlSession()` uses the Worker delivery policy map and
      has real Worker service integration proof for controller-originated
      `operation_cancel` hard rejection.
    - Gateway and Worker peer services reject pending command results promptly
      on accepted-socket disconnect.
    - Managed OpenClaw multi-agent zones fail config validation before runtime
      caller-context registration during this cutover.
    - Portal export audit covers all published `@agent-vm/mcp-portal` subpath
      exports.
    - Fresh focused integration/config/export proof and `pnpm check` passed.
34. Event 210 stale Tool VM unit fixture repair:
    - `tool-vm-lifecycle.unit.test.ts` helper now declares only the trusted
      `sun` agent used by all Tool VM lifecycle calls, so the new managed
      OpenClaw multi-agent fail-closed rule is not tripped by unrelated Tool VM
      tests.
    - Focused Tool VM unit proof passed 1 file / 18 tests.
    - Fresh full unit proof passed 241 files / 2109 tests.
    - Fresh `pnpm check` passed 10 checks / 0 failed on the current Event 210
      head.
35. Event 211 Composer/Bugbot follow-up reduction:
    - Managed OpenClaw multi-agent scaffolds now fail at init during this
      cutover, stale trusted-agent fixtures are fixed, zone-git success fixtures
      use `agent/main`, and deprecated MCP Portal load-path stripping is exact
      rather than substring-based.
    - Active docs/manuals no longer advertise same-zone multi-agent managed
      OpenClaw during this cutover.
    - Bugbot docs drift was verified current: `zones[].toolPortal` is the
      managed Tool Portal root, generated plugin materialization is
      `runtimePluginConfigs.gondolin.toolPortal`, stale
      `runtimePluginConfigs["mcp-portal"]` remains banned, and overview includes
      the three control contract packages.
    - Fresh proof passed: focused integration 3 files / 106 tests, focused
      host-e2e 1 file / 55 tests, full unit 241 files / 2110 tests, full
      integration 28 files / 441 tests, and `pnpm check` 10 checks / 0 failed.
36. Event 212 terminal e2e and check refresh:
    - `b993f97` aligns the OpenClaw default runtime e2e fixture with the
      hard-cutover single trusted managed OpenClaw agent rule.
    - `05ae556` aligns the mediated-env live VM e2e fixture with the same rule
      while leaving multi-agent Tool VM mediated-secret selection proof in the
      pure unit owner.
    - Full OpenClaw e2e passed 7 files / 12 tests / 0 skipped / 0 todo.
    - Full Worker e2e passed 3 files / 5 tests / 0 skipped / 0 todo.
    - Full VM e2e passed 5 files / 9 tests / 0 skipped / 0 todo.
    - Default e2e passed 4 lanes / 0 failed.
    - Fresh `pnpm check` passed 10 checks / 0 failed.

Return only grounded candidate findings:

```text
severity: blocker | important | follow-up | nit
title:
evidence: exact file:line, symbol, command output, or plan section
scenario: concrete failure, exploit, regression, or maintenance path
smallest_fix:
proof: test, check, or manual reproduction that would prove the fix
confidence: high | medium | low
```

If there are no high-confidence findings, say:

```text
No findings.
Confidence: <high | medium | low>
Remaining uncertainty: <short list>
```

Read-only rules:

- Do not edit files.
- Do not stage changes.
- Do not commit.
- Do not run destructive git operations.
- Do not print secrets.
