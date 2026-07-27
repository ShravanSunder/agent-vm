# Tool Portal PR #166 — Implementation Review (VM Sandbox & Inter-VM Communication)

Date: 2026-07-22
Reviewer: implementation review swarm (xhigh effort), main-agent validated
PR: [#166 Add common Tool Portal integration for OpenClaw and Hermes](https://github.com/ShravanSunder/agent-vm/pull/166)
Branch: `feat/tool-portal-openclaw-hermes-beta-pr`
Range: `fb8605ad` (merge-base with `master`) → `46f1bd5e` (HEAD)
Diff size: 100 files reported by GitHub; +183k / −47k including generated manifests, lockfiles, and specs.

## Scope Of This Review

Per the review request, this pass is scoped to the **local-VM sandbox and
tool-calling system** and the **communication paths between the controller,
the gateway runtime, and the Tool VMs**. It is not a cyber-security /
adversarial-agent audit. Findings are ranked by their effect on:

- correct execution of processes inside Tool VMs;
- correctness and liveness of tool-calling (Capability + Sandbox APIs);
- controller ↔ gateway ↔ Tool VM communication under reconnect, replacement,
  and teardown.

Security-hardening, backup, and storage-isolation items surfaced by the swarm
are recorded in the *Out-of-focus / noted* appendix rather than ranked, since
they fall outside this scope or were mitigated / refuted.

## Method

10 finder lanes + 2 design/system evaluation lanes produced 30 candidates.
Every candidate was checked by an independent adversarial verifier
(CONFIRMED / PLAUSIBLE / REFUTED with quoted line evidence); the main agent
additionally self-checked the conventions finding and the top spec item.
Line numbers below are the verifier-corrected anchors.

Verdict tally: 30 candidates → 8 REFUTED/mitigated-out, 3 downgraded to
cleanup, 19 carried (17 CONFIRMED, 2 PLAUSIBLE).

## Positive Result — Removed-Behavior Audit Clean

The PR deletes ~47k lines (backup coordinator, restore publication, Hermes
copy-back / durable-home, OpenClaw process-epoch-owner supervisor, migration).
A dedicated audit traced every deleted **guard** and confirmed each is
re-established — usually hardened — in the new structure:

- path-traversal / NUL / absolute-path rejection → `sandbox-path-contract.ts`
- SSH operation timeout + abort → `strict-tool-vm-ssh-client.ts`
- work-mount symlink containment → `validateControllerSelectedToolVmDirectory`
- caller-context HMAC auth → registration-client sign + controller verify
  (`timingSafeEqual` + agent-authority-key)
- protocol generation/sequence fencing → `gateway-control-session-service.ts`
- teardown exact-process-identity fencing → `lease-manager.ts`

No lost invariant was found from the deletions. The instability findings below
are in **new** code, not regressions from the cut.

---

## Ranked Findings (In Scope)

Severity: **S1** stuck/leaked VM resource or lost tool output that needs an
operator/VM-death to clear · **S2** degraded correctness or wrong result
discriminant · **S3** efficiency / maintainability on a long-running gateway.

### S1 — Liveness: stuck or leaked VM resources

**F1. Control-session reconnect orphans in-flight Tool VM uses — and blocks idle reap**
`packages/agent-vm/src/controller/leases/lease-manager.ts:1486` (CONFIRMED)
`markControlSessionDisconnected` has **no production caller**. The orchestrator
fires `onControlSessionAttachmentGap` (`gateway-zone-orchestrator.ts:2581`) but
the controller-runtime wiring that consumed it was deleted in this PR (only the
integration test sets the callback). So a running active-use never transitions
to `observation-gap`. On a transient control drop + reattach under a new
`sessionAttachmentGeneration`, `heartbeat-active-use` rejects with
`attachment-generation-regressed` (`tool-vm-lease-authority-state.ts:468`) and
`resume-active-use` requires `observation-gap` (`:546`), so the op can neither
heartbeat nor resume. **Worse than first reported:** the stuck use keeps
`activeUseCount > 0`, and `isToolVmLeaseExpired` requires `activeUseCount === 0`
(`tool-vm-lease-lifecycle.ts:37`), so `reapDeadIdleLeases` skips it too
(`lease-manager.ts:1617`). Recovery is only VM-death eviction or forced release.
→ A momentary control blip permanently pins a Tool VM lease and its operation.

**F2. Gateway destruction transaction poisons itself on a transient failure**
`packages/agent-vm/src/gateway/gateway-zone-destruction-transaction.ts:114` (CONFIRMED)
On the first `destroyExactGateway()` throw, `exactDestructionFailure` is cached
(`:81`) and **never cleared**. `destroyGateway()` short-circuits at `:114`
(`if (exactDestructionFailure !== undefined) return Promise.reject(...)`) before
re-entering `runAttempt`, so the exact-destruction stage is never retried — even
for a transient cause (e.g. process-kill confirmation timeout). Withdrawal /
post-destruction phases resume via `completedStages`, but an exact-destruction
*throw* poisons the whole transaction. Callers reuse the same instance
(`gateway-zone-orchestrator.ts:1919, 2759`). → A transient terminate failure
permanently wedges that gateway's teardown/replacement; the recovery loop cannot
make forward progress and the atomic admission controller can only escalate to
owner-unsafe. (Per-gateway-instance; a fresh build gets a fresh closure.)

**F3. SFTP operation deadline counts queue wait, then destroys the shared SSH transport**
`packages/gateway-runtime/src/sandbox/strict-tool-vm-ssh-client.ts:951` (CONFIRMED)
`runSftpOperation` arms the operation deadline **synchronously** (`:951`,
`onExpire → client.destroy()` `:956`) *before* `await precedingAdmission`
(`:962`). SFTP ops are serialized one-at-a-time (`:946`, released in `.finally`
`:976`), so a queued op's deadline clock includes head-of-line wait. On expiry,
`client.destroy()` tears down the **single shared** SSH `Client`
(`requireConnectedTransport()` `:945`) → `close` →
`publishConnectedTransportFailure({kind:'transport-close'})` → active-use
`retireGroup('failed')`, aborting every in-flight process channel and SFTP op —
even though the expired op never started. `executeCommand` / `openCommand...`
front no queue, so this queue-folding is unique to the SFTP path. → Several
concurrent filesystem calls (e.g. a large `fs.read`) can collapse the whole
agent's SSH session.

**F4. Process-open deadline over-escalates one slow channel-open into full-group teardown**
`packages/gateway-runtime/src/sandbox/strict-tool-vm-ssh-client.ts:692` (CONFIRMED)
`openCommandProcessChannel`'s open deadline `onExpire` publishes
`publishConnectedTransportFailure({kind:'transport-unresponsive'})` (`:692`) →
`retireGroup('failed')`, cancelling every other running process for the agent
and closing the connection. `executeCommand`'s open path (`:566`) only rejects
its own op (`finishRejected`, no transport-failure publish). Both use the same
`client.exec` primitive. A slow open (guest busy, sshd `MaxStartups`/`MaxSessions`
throttling) is a plausible non-fatal event, so the process path over-escalates a
transient slow-open into a session-wide teardown while the exec path does not.

**F5. Framework UDS blip drives attachment to terminal `retired` (no lightweight reattach)**
`packages/gateway-runtime/src/uds/managed-plugin-attachment-policy.ts:332` (CONFIRMED)
A single disconnect reduces to `stateWithoutActiveConnection(state, 'retired')`
(`:332`); `retired` is terminal — `reduceHandshakeEvent` rejects every reconnect
with `retired-attachment` (`:237`) — even though the UDS snapshot records the
distinct, recoverable `attachment-lost`. Recovery is a **full gateway-generation
teardown/rebuild** driven by the controller (`recoverFromTerminalAttachmentLoss`,
push-driven and prompt), not a cheap reattach. Correct and bounded, but every
transient framework-socket blip costs all Tool VMs/processes in the generation.

**F6. `attachment-lost` does not eagerly reap sandbox/SSH state**
`packages/gateway-runtime/src/production/gateway-runtime-production-service.ts:691` (CONFIRMED)
The attachment-lost observer only rebuilds readiness (`:693–702`); nothing
retires the sandbox dispatcher or operation-active-use runtime (dispatcher
`retire()` is wired only to lifecycle teardown). Between framework disconnect and
the controller's re-provision, running Tool VM processes keep executing and the
strict SSH connection stays open with no eager cleanup. Pairs with F5: the leak
window is the controller re-provision latency.

**F7. Hermes: blocking `os.write` runs on the shared asyncio loop thread**
`python/agent-vm-hermes-adapter/.../managed_gateway_runtime_environment.py:409` (CONFIRMED)
`os.pipe()` fds are blocking (`:520`, no `os.set_blocking`); `_read_stream`
(`async def`, `:386`) calls `os.write(write_fd, content)` (`:409`) and is
scheduled via `run_coroutine_threadsafe` onto the single shared loop thread
(`agent-vm-hermes-gateway-runtime`) that serves **every profile** on the adapter.
If the reader stalls, the 64 KiB pipe fills and `os.write` blocks the loop →
head-of-line stall for all profiles. (Return value is discarded → silent tail
drop on a signal-interrupted partial write, real-but-rare; the loop-thread block
is the load-bearing defect.)

**F8. Hermes: adapter wedges when a Gateway-Runtime RPC hangs under the resolution lock**
`python/agent-vm-hermes-adapter/.../managed_gateway_bootstrap.py:317` (CONFIRMED)
`resolve_container_task_id` holds `_resolution_lock` across two round-trips
(`resolve_status_kind` `:317`, environment create `:328`). `run()` passes
`timeout=None`, and the UDS transport has no request timeout or heartbeat
(`gateway_runtime_uds_transport.py` `_read_frame` uses `readuntil`/`readexactly`
with no `asyncio.timeout`). A **hung-but-connected** gateway blocks `readuntil`
forever while holding the lock; every later tool invocation's resolve/create then
blocks on the same lock → permanent adapter wedge. (A crashed/closed peer is
bounded by EOF → `IncompleteReadError`; the hung-open case is the gap.)

### S2 — Correctness / wrong result discriminant

**F9. Signal-killed commands yield `exitCode: null` into a `number`-typed contract**
`packages/gateway-runtime/src/sandbox/strict-tool-vm-ssh-client.ts:612` and `:799` (CONFIRMED)
The ssh2 `exit` handler is typed `(code: number)` but ssh2 emits `code === null`
on signal termination (`@types/ssh2` overload `(code: null, signal, ...)`). The
guards check `exitCode === undefined`, so `null` falls through: at `:612` →
`{exitCode: null, kind: 'exited'}` (a signal death mislabeled as a clean exit);
at `:799` → `completedOutcome(null)` does `null === 0` → classifies `failed`
(masking the signal) and writes `null` into the `number`-typed
`terminalExitCode`. Downstream, `null` propagates into `PortalCallResult` and
`parseBackendResult` rejects the whole `portal.call` as invalid-backend-result.
→ An OOM/timeout-killed tool command surfaces as a hard invalid-result error or
an indistinguishable "failed", never as a clean signal outcome.

**F10. Hermes: exec waits to completion before draining output → success reported as failure, output lost**
`python/agent-vm-hermes-adapter/.../managed_gateway_runtime_environment.py:488` (CONFIRMED; mechanism corrected)
`_run_operation` awaits `execution.wait` to completion (`:488`) *before*
draining stdout/stderr (`:492`), and `execution.start` passes no
`retainOutputBytes`. The server ring-buffer evicts oldest (it does **not**
backpressure/deadlock — that part of the original claim is refuted), so: (a) a
command whose cumulative output exceeds `maxStdoutBytes = 1 MiB` makes
`deliverBoundedOutput` emit `ambiguous` + close the channel → adapter raises
`OutcomeError` → returncode 125, so a command that actually **succeeded fails**;
(b) output evicted before the post-wait read is **lost** (stale-cursor guard).
→ Output-heavy tool calls into Hermes VMs are unreliable.

**F11. Healthy lease replacement suppresses the transport-failure publish**
`packages/gateway-runtime/src/sandbox/strict-tool-vm-ssh-client.ts:446` (CONFIRMED)
`close()` sets `closeRequested = true` before `transport.end()`, and
`publishConnectedTransportFailure` returns early when `closeRequested` (`:446`),
so a controller-initiated **healthy** replacement (`published-binding-runtime`
`closeSlot → client.close()`) never fires the operation group's failure observer
(`operation-active-use-runtime.ts:619`). Long-lived sandbox-environment groups
stay `bindingIsCurrent = true` against a dead SSH client until the next heartbeat
rejection, returning raw SSH errors instead of a clean stale-generation signal
during that window. No safety hole (an old handle can't reach the new VM), but a
degraded error contract for the M5 replacement journey. The unhealthy path fences
correctly via transport failure.

**F12. Workspace-git push conflict misclassified as transport failure**
`packages/agent-vm/src/controller/workspace-git/workspace-git-operations.ts:689` (CONFIRMED)
Pre-dispatch conflict checks throw `WorkspaceGitConflictError` (a
`WorkspaceGitPushNotDispatchedError`) → domain handler maps to
`result: 'rejected'` / `workspace_git_conflict` (`gateway-control-domain-handler.ts:958`).
But the final `git push --force-with-lease` (`:689`) runs through
`runSanitizedWorkspaceGitCommand(reject:true)`, which throws a **plain** `Error`
on non-zero exit (`:503`). `markPushMayHaveStarted()` already ran, so
`pushWorkspaceGit` re-throws it raw (`:732`), and the handler falls through to
`result: 'failed'` / `controller_host_action_failed` (`:978`). A concurrent
non-fast-forward (stale-lease) rejection — where git guarantees the ref was **not**
updated — is thus indistinguishable from a real transport/auth failure. This
collapses a discriminant the controller API contract documents (`pull-default` /
push result classes). Post-dispatch conservatism is partly intentional, but the
force-with-lease-rejected case is specifically reclassifiable and is not.

**F13. Retained-result lookup falls back to an ambiguous linear scan**
`packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.ts:400` (CONFIRMED; bounded)
`runtimeForRetainedResultLookup` tries an O(1) key, then on miss linearly scans
`runtimesByActiveUseId` returning the **first** runtime matching principal +
generation. Two runtimes for one principal at the same `environmentGeneration`
are structurally possible (each `sandbox.environment.open` gets a distinct
`activeUseId`; `openEnvironment` only rejects duplicate `activeUseId`), so the
scan can be ambiguous. Blast radius is bounded — the handler re-validates by
exact `operationId` + `owningGeneration` and returns `unavailable` rather than
leaking another op's result — so this is a robustness weakness, not a data leak.

### S3 — Efficiency / maintainability (long-running gateway)

**F14. Sandbox dispatcher: six parallel handle→runtime index maps, manually reconciled**
`packages/gateway-runtime/src/production/gateway-runtime-production-sandbox-dispatcher.ts:294` (CONFIRMED)
Six index maps (`runtimesBy{ActiveUseId,EnvironmentKey,OperationKey,ProcessKey,StreamKey,TerminalKey}`)
plus per-runtime descendant indexes are kept consistent by hand across ~15
set/delete/reconcile sites in a **1231-line** file (over the repo's own 900-line
refactor threshold). This is the likeliest future index-desync site — a missed
update leaves a stale handle resolvable or a runtime leaked. Recommend a single
handle-registry abstraction owning all six maps.

**F15. UDS frame encoder validates twice per outbound frame**
`packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-protocol.ts:402` (CONFIRMED)
`encodeGatewayRuntimeFrame` validates the envelope, `JSON.stringify`s it, then
`JSON.parse`s the string back and validates **again** (`:402`) on every frame —
the sole per-response/per-streamed-frame write path. Partly defensive (guards
`toJSON` mutation), but the parse-back + second recursive walk doubles
serialization CPU/GC on the busiest path. Validate once before stringify (or gate
the parse-back behind a debug flag).

**F16. UDS frame decoder does O(frames × remaining) tail-copies**
`packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-protocol.ts:359` (CONFIRMED; bounded)
`GatewayRuntimeFrameDecoder.push` `concatenateBytes` per push (`:295`) and
`workingBuffer = workingBuffer.slice(bodyEndOffset)` per decoded frame (`:359`),
so a chunk packing N frames triggers N full-remaining copies. On the inbound
decode hot path (streamed stdout/stderr); bounded by `maxFramesPerChunk = 32`.
Track a read offset and slice once at the end.

**F17. Telemetry re-serializes every record for byte-quota accounting**
`packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts:536` (CONFIRMED; magnitude speculative)
`admitRecord` does `Buffer.byteLength(JSON.stringify(record))` per admitted
telemetry record (`:536`), separate from the OTLP exporter's own serialization,
plus an unmemoized `sha256` of the stable `agentId` per invocation (`:331`).
Estimate size from attribute count or reuse the exporter's encoded length, and
memoize the per-principal hash.

### Cleanup (in-scope dead / redundant code)

- **F18. Sandbox operation-authority context comparison is a production tautology + dead bound-handle surface.** `sandbox-operation-authority.ts:30, 62` (CONFIRMED). All three production callers pass the same `operationContext` object the authority was built from, so `contextsMatch` compares an object to itself — always true. Real stale-generation fencing lives in `replacementStarted` + caller `environmentGeneration` guards, so this is redundant, not a missing fence. `bindHandle` / `GatewayRuntimeSandboxBoundHandle` / `authorizeOperation` are exported but used only by a test fixture — dead surface. Drop `currentContext`/`candidateContext`/`contextsMatch` and the bound-handle API.
- **F19. `beginProcessEpochLoss` / `markProcessEpochLost` are orphaned dead code.** `lease-manager.ts:1156` (REFUTED as vuln → cleanup). The PR deleted the in-VM process-succession subsystem (`openclaw-gateway-process-epoch-owner.ts`, −359) and its controller wiring; these methods now have zero production callers and `lostProcessEpochsByGateway` never fills. A dead epoch now entails a dead `gatewayEpoch` (fenced at `startActiveUse:1741` before the epoch check) and attachment-generation monotonicity fences within a live epoch, so there is no unfenced-epoch hole — just vestigial code to remove.
- **F20. `worker-runtime-record.ts` clones `gateway-runtime-record.ts`.** `worker-runtime-record.ts:94` (CONFIRMED). Byte-identical load-result union, ENOENT handling, atomic 0o600 write, and `resolveManagedVmHostProcessId`; the VM-ownership identity-fencing `superRefine` is the same idiom. Both are anti-PID-reuse fences — harden one and the other silently keeps the weaker check. Share one generic runtime-record store.
- **F21. Small dead/derivable state in the comms layer** (CONFIRMED): unreachable `'awaiting-handshake'` branch in `managed-plugin-attachment-policy.ts:195` (both call sites pass `'retired'`); redundant identical field re-declaration in `ManagedPluginAttachmentConfiguration` (`:30`); `retired` boolean fully derivable from `retirementPromise !== undefined` in `sandbox-process-registry.ts:53`; near-duplicate `mergeToolPortalSearch`/`Describe`/`List` in `tool-portal-result-router.ts:241/323/398`.

### Conventions

- **F22. Test fixture deep-imports gateway-runtime internals, bypassing the package alias.** `packages/agent-vm/src/integration-tests/gateway-runtime-sandbox-test-fixture.ts:19,24,28,32,33` (self-verified). Five `../../../gateway-runtime/src/sandbox/...` relative imports violate monorepo-rules "Absolute imports only"; this PR adds the `@agent-vm/gateway-runtime` alias, so the boundary is available and deliberately bypassed — couples agent-vm to gateway-runtime's private `src/sandbox/` layout.

---

## Design & System Assessment

Two independent design lanes evaluated the runtime/isolation model and the
storage/contract model against the spec's Locked Architecture Decisions.

Verdict per area (`sound` / `sound-with-risks` / `gap`):

```text
Process/trust topology (sibling + protected UDS)   sound-with-risks
Per-agent isolation (handle/generation keying)     sound  (structural)
Tool-VM-death mid-op                               sound
SSH drop + reconnect                               sound (fail-closed), low resilience
Framework (UDS client) crash + reconnect           gap    → F5/F6
Gateway restart / new epoch                        sound (consumer side)
Lease replacement under in-flight ops              sound-with-risks → F11
Slow-consumer backpressure                         sound
State-machine soundness                            sound (exhaustive reducers)
Layering (A1 one core / A4 Cap vs Sandbox split)   sound
Complexity budget                                  sound-with-risks → F14
```

Load-bearing strengths worth stating plainly:

- **Isolation is structural, not discipline-based.** Handle keys are
  `owningGeneration\0handleId`; all lookups funnel through one
  `requireRuntimeAuthority` re-checking principal + generation; SSH slots are
  one-per-principal. Digest collisions are re-checked by agentId/revision.
- **One semantic core (A1) holds.** Policy, approval reservation, and routing
  live in `createManagedToolPortalCapabilityCore`, not forked into adapters.
  Capability vs Sandbox APIs are cleanly separated. Approval-before-dispatch
  (A7) is preserved: `reserveDispatch`/`armDispatch` complete before any
  `dispatchCall`, and the controller re-verifies authority on the result.
- **Trust fences are centralized** in one pure reducer
  (`reduceManagedPluginAttachmentState`): protocol/epoch/generation/clientKind/
  cohort/replay/duplicate-active/public-authority.

The dominant system-level theme behind the S1 findings: **the co-hosted
framework's disconnect/reconnect lifecycle is modeled as terminal + controller-
driven-full-recovery, while several in-VM resources (leases, SSH connections,
running processes, in-flight uses) are only reaped by that heavy path or not at
all (F1, F2, F5, F6).** The building blocks for lighter recovery exist
(`observation-gap`, `resume-active-use`, `completedStages` resume) but two of
them are unwired (F1) and one is non-retryable after a throw (F2).

---

## Out-Of-Focus / Noted (not ranked)

Surfaced by the swarm, outside this review's VM+communication scope, or
mitigated/refuted. Recorded for completeness; a maintainer may pick them up
separately.

- **Spec S3 rail — `whole-root-writable` production workspace selector** persists
  at `tool-vm-lifecycle.ts:106` for both frameworks with empty deny/tmpfs lists.
  CONFIRMED as a spec-literal deviation (the spec calls this selector "invalid"
  and requires per-framework ShadowProvider templates) **with mitigation**:
  `validateControllerSelectedToolVmDirectory` pins the mount to the per-agent
  root, so there is no cross-agent breach — the gap is missing defense-in-depth
  and negative-path policy proof (a security-hardening concern, deprioritized).
- **Hermes SQLite on RealFS/VFS mount durability** (`hermes-lifecycle.ts:213`)
  is proven only by a happy-path e2e turn; no WAL/`flock`/`fsync` handling at the
  mount layer and no concurrent-writer / checkpoint / fault-injection test. This
  is the spec's own named stop-condition — worth a targeted durability test even
  though this scope treats it as noted.
- **Contract anti-drift is dead** (`scripts/generate-portal-contracts.ts:132`):
  `--check-clean` is wired into no CI/check path and the Python parity test never
  runs in CI, so the TS↔Python tool-call contract can drift silently. Relevant to
  tool-calling integrity; low effort to wire into `pnpm check`.
- **Security/hardening items (out of scope):** hardlink-through-symlink filter
  bypass (`filtered-workspace-provider.ts:430`, unverified); divergent
  `normalizeHostname` between OTLP mediation and policy-compiler; backup lexical
  (symlink-blind) disjointness; `workspaceGit` toggle-off dangling `.git`
  pointer; e2e admission-pressure actuator constructed in the production runtime
  (defense-in-depth holds).
- **Refuted:** Hermes managed process-registry "wiring gap" (production uses a
  real `StockHermesManagedProcessRegistryPort` adapter with the cap enforced);
  UDS abort-set connection kill (server always answers cancelled requests, so the
  set drains); `dispatchCall` bare-catch "lost discriminant" (backends return
  discriminated results, so the catch only sees genuinely unexpected throws);
  sandbox-filesystem "drifted path guard" (the third site is a deliberately
  different admitted-roots allowlist that rejects absolute escapes); Hermes
  bootstrap global-env monkeypatch (guarded by nesting check + try/except restore
  + finally).

---

## Recommendation

The architecture is sound and the removed-behavior cut is clean. Before merge,
address the S1 liveness findings — **F1** (control-reconnect lease orphan +
reap block) and **F2** (destruction-transaction poison) are the highest-value
fixes because both permanently pin/wedge VM resources on ordinary transient
events and require operator or VM-death intervention to clear. **F3/F4** (SSH
deadline teardown/over-escalation) and **F7/F8** (Hermes loop-block and
resolution-lock wedge) are the next tier for tool-calling stability. The S2
correctness items (**F9** signal exit-code, **F10** Hermes output loss, **F12**
push discriminant) affect result fidelity and should be fixed alongside.

---

## 2026-07-27 Current-Source Revalidation

This section records the maintainer reduction against
`1a6140028fa21307087d4b886cc834a2c306934b` plus the bounded fixes applied in
the current worktree. The original review above remains preserved as reviewer
input, not as an automatically accepted implementation queue.

### Accepted and addressed

- **F1:** controller startup now routes the existing control-session attachment
  gap into `LeaseManager.markControlSessionDisconnected`.
- **F3:** an SFTP operation deadline starts after serialized admission, so
  queued work cannot time out and destroy the shared SSH transport before it
  begins.
- **F7:** Hermes pipe output writes run off the shared asyncio loop and write
  complete chunks across partial `os.write` results.
- **F8:** timed-out synchronous Hermes bridge calls cancel their submitted
  coroutine. Environment `open` and `status`, the calls made under the
  resolution path, use the existing environment timeout.
- **F9:** signal-only ssh2 exits no longer enter number-only result contracts;
  direct execution rejects and process execution reports the existing
  `ambiguous` terminal outcome.
- **F11:** explicit binding replacement and retirement publish the existing
  transport invalidation before ending SSH. Ordinary final lifecycle close
  remains silent.
- **F12:** only the exact Git porcelain `force-with-lease` stale-info rejection
  is promoted to `workspace_git_conflict`; unrelated Git failures retain their
  prior classification.
- **F22:** the test fixture consumes the public
  `@agent-vm/gateway-runtime` package surface instead of deep source imports.
- **S3 workspace selector:** OpenClaw and Hermes now use the accepted positive
  root selector over the already controller-selected per-agent RealFS root,
  retaining nested read-only `.git` policy.
- **Generated contract anti-drift:** freshness is part of `pnpm check` and an
  explicit CI step. CI also runs the Python tests, format check, and typecheck.
- **Read-only hardlink bypass:** async and sync hardlink creation now resolves
  the source through the composed filtered provider before delegating to the
  underlying provider, closing the reproduced symlink-to-hidden/read-only
  bypass.

The transient Python UDS report was also narrowed: a complete remote JSON-RPC
error was previously raised as `GatewayRuntimeUdsTransportError`, even though
the response frame had been consumed and the connection remained usable. The
SDK now exposes `GatewayRuntimeUdsRemoteError`, preserving the remote JSON-RPC
code and safe structured data. A real-UDS regression proves a remote error
followed by a successful request on the same connection. The original backend
exception cannot be reconstructed without the correlated historical server
log.

### Rejected after source validation

- **F2:** retrying exact Gateway destruction without a proven pre-dispatch
  result would weaken owner-safety. The cached owner-unsafe terminal failure is
  intentional.
- **F4:** ssh2 reports channel/exec acceptance through the callback; a timeout
  before that point leaves transport state uncertain. Retiring that transport
  remains the bounded ambiguity fence.
- **F10:** the stated retained-output eviction mechanism is absent. Direct
  execution retains 16 MiB while strict SSH caps each output channel at 1 MiB.
  No claimed failure path was reproduced.
- **F13:** generation identity includes the active-use identity; the claimed
  cross-runtime ambiguity requires a SHA-256 collision.
- **F14–F18, F20, F21:** speculative refactors, deliberate guards, or cleanup
  without a current failure path. They are not part of this focused correction.

### Deferred or decision-required

- **F5/F6:** current UDS attachment loss is terminal and controller recovery
  replaces the Gateway generation. The older supporting runtime specification
  instead requires bounded same-epoch reattachment. Terminal attachment loss
  can also occur during stabilization/cooldown before controller replacement.
  Adding reattachment, eager dual-owner teardown, a supervisor, or queued
  recovery would change lifecycle ownership and requires maintainer
  concurrence before code changes.
- **F19:** dead cleanup only.
- SQLite fault injection, backup path hardening, and cleanup after disabling
  `workspaceGit` remain outside this PR's accepted behavior change.

### Proof status

Targeted red/green proof exists for each accepted behavior change. Fresh
current-worktree targeted receipts include:

- controller/tool-lifecycle/domain unit tests: 92 passed;
- workspace Git host e2e: 13 passed;
- strict SSH integration: 64 passed;
- published-binding and active-use unit tests: 24 passed;
- Hermes adapter: 75 tests and 61 subtests passed;
- Python UDS transport: 24 passed;
- check-gate unit tests: 5 passed;
- Python formatting, linting, and typing: passed.

Full repository checks and the required live VM/framework/beta proof remain
separate completion gates; this revalidation does not claim them from targeted
receipts.
