# 2026-06-10 Repo Improvement Plans

Audit batch planned at commit `4f419b0`. Nine read-only audit lanes (leases,
controller↔worker communication, gateway stability/recovery, 1Password/
secrets, worker genericization/extensibility, general arch/tests/docs,
mcp-portal, build/backup/zone-git, Codex SDK research) plus parent
verification of every accepted finding against source. Each plan is
self-contained and independently executable; recommended order is the
priority order below.

Reviewed 2026-06-11 by a six-lane plan-review-swarm (adversarial, read-only,
grounded against live code + external docs); accepted blocker/important
findings were folded back into every plan. Review report:
`tmp/plan-workflows/2026-06-11-repo-improvements-plan-review.md`.

## Plans

| # | Plan | Theme | Primary risk addressed |
| --- | --- | --- | --- |
| 01 | [tool-vm-tcp-slot-quarantine-recovery](01-tool-vm-tcp-slot-quarantine-recovery.md) | Leases | TCP pool drains permanently on failed `vm.close()`; lease creation eventually starves |
| 02 | [controller-worker-http-timeouts](02-controller-worker-http-timeouts.md) | Communication | Controller hangs unbounded on a stalled in-VM worker (submit, poll, close) |
| 03 | [orphaned-task-startup-sweep](03-orphaned-task-startup-sweep.md) | Communication | Controller crash mid-task → task stuck non-terminal forever + leaked resources |
| 04 | [gateway-stale-close-owner-safe-recovery](04-gateway-stale-close-owner-safe-recovery.md) | Stability | Dead-PID close timeout permanently strands an OpenClaw zone as `owner-unsafe` |
| 05 | [health-monitor-hygiene](05-health-monitor-hygiene.md) | Stability | Unbounded set growth, cross-zone probe starvation, silent durable-log loss |
| 06 | [secret-resolution-hardening](06-secret-resolution-hardening.md) | 1Password | No retry on transient 1P failures; resolved-value redaction gap; audit version; silent GITHUB_TOKEN fallback |
| 07 | [codex-sdk-upgrade](07-codex-sdk-upgrade.md) | Codex SDK | ^0.130.0 → ^0.139.0 (no "v2" package exists; v2 = protocol); optional streaming |
| 08 | [worker-executor-genericization](08-worker-executor-genericization.md) | Genericization | Codex-only seams (MCP setup, auth, gates); lands a Claude Code executor path |
| 09 | [task-event-stream-and-embedding](09-task-event-stream-and-embedding.md) | Extensibility | Polling-only observation; no library embedding entrypoint |
| 10 | [ci-publish-gate-parity](10-ci-publish-gate-parity.md) | Proof gates | publish.yml weaker than ci.yml; e2e runner covers 3 of 10 vitest projects |
| 11 | [docs-architecture-drift](11-docs-architecture-drift.md) | Docs | Package map (7/11), event-name table, overview routes/startup all stale |
| 12 | [backup-pipeline-hardening](12-backup-pipeline-hardening.md) | Backup | Plaintext tar residue; backups-include-backups growth; non-atomic restore |
| 13 | [dockerfile-generation-injection-guards](13-dockerfile-generation-injection-guards.md) | Build security | Overlay `copy.to`/`runAfterBase` newline injection into generated Dockerfiles |
| 14 | [mcp-portal-approval-and-discovery-hardening](14-mcp-portal-approval-and-discovery-hardening.md) | MCP portal | Mixed-batch approval bypass; digest pre/post-validation mismatch; unbounded pagination |

## Backlog (verified but not planned — small or needs a decision first)

- Gateway start-error classification by message substring can misroute
  recovery (`gateway-zone-state-machine.ts:171-192`); replace with typed
  errors when touching that surface.
- Worker gateway boot log written only to in-VM `/tmp`
  (`worker-lifecycle.ts:80-84`); mount a host-readable log dir like the
  OpenClaw gateway does.
- Controller HTTP server accepts new requests during the whole shutdown
  sequence (`controller-runtime.ts:804-828`); close/drain earlier.
- SSH secret-env policy: warn at config validation when `policy:
  'explicit'` coexists with env-injected secrets on an OpenClaw zone.
- Portal auth rate-limit FIFO bucket eviction can be flushed by many-IP
  failures (`portal-http-server.ts:132-144`); LRU/expiry-aware eviction.
- Build dedup (`build-pipeline.ts:271-273`) is bypassed when `output` is
  set — currently unexercised concurrently; remove the bypass when next in
  that file.
- Backup filename `__` delimiter is ambiguous for zone IDs containing `__`
  (parse-only issue).
- `agentScopeGenerations` maps grow unboundedly
  (`upstream-mcp-client-runtime.ts` ~:469, `portal-session.ts` ~:134).
  WARNING from plan review: do NOT fix by deleting entries on close —
  `generationForAgentScope` defaults to 0 for missing entries and the
  stale-connection guard (`upstream-mcp-client-runtime.ts:598-615`) depends
  on the post-close incremented value; delete-on-close lets a stale
  in-flight client be promoted. Safe fixes: size-capped structure, or prove
  scope IDs are never reused and document that invariant.

## Unknowns (investigate before planning)

- Concurrent JSONL event-log appends from controller (host) and worker
  (in-VM via VFS) rely on append atomicity through the virtio/VFS layer for
  large lines (e.g. `task-accepted` with full effectiveConfig). Needs an
  empirical write-interleaving test before deciding on per-file
  serialization.
- OpenClaw plugin `inFlightLeaseRequests` coalescing can hand a second
  waiter a lease that the first waiter force-released moments later
  (`sandbox-backend-handle-factory.ts:377-422`); observable as transient
  SSH failures + retry. Reproduce before fixing.

## Rejected candidates (checked, not real)

- Lease renew/release double-`vm.close()` race: both paths serialize on the
  per-agent lease lock; the claimed interleaving cannot occur.
- `tmp/` artifacts tracked in git: `.gitignore` covers `tmp/` and `*.tgz`.
- `releasingLeaseIds` lifecycle on failed close: working as designed
  (guard window is intentionally only the close await).
- Cross-agent approval-token reuse in the OpenClaw portal plugin: payload
  is agentId-bound; shared HMAC key does not enable cross-agent forgery.
