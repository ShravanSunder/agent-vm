# Lane: security-reliability (parent-verified)

Status: answered. Security context: applicable. Confidence: high on anchors; medium on the two open questions (genuine spec ambiguities).

Parent verification: G0 trust-root absence, identityPem-over-/lease custody hole, and the recovery-amplifier
(no corroboration AND-gate; observation-driven consecutive-failure counting) all confirmed against code
(controller-http-route-support.ts:145-159, controller-health-event-routes.ts:34-137,
gateway-vm-recovery-policy.ts:310-354). Accepted into the plan.

## GATE-0 (cutover prerequisite — blocks all slices)
Owners: control-protocol-contract (handshake schema) + gateway-control-service-placement.
- G0.1 Controller PUBLIC key provisioned per-boot as plain VM env/config, NOT via splitResolvedGatewaySecrets/
  mediatedSecrets, NEVER baked into gateway Dockerfile. Landing: openclaw-lifecycle.ts bootstrap env ~122-148;
  worker-lifecycle.ts env 32-54. Proof: VM-spec unit — verifier present as runtime env, absent from any Dockerfile.
- G0.2 {publicKey, controllerEpoch} provisioned together; epoch bump invalidates old creds/sessions (close reason
  controller_epoch_mismatch).
- G0.3 Net-new GET /__agent-vm/ready + /__agent-vm/worker-ready issue per-session nonce bound to
  domain/route/zone/VM id/bootId/generation.
- G0.4 Atomic consume-before-101 in OpenClaw plugin handleUpgrade + worker private route; duplicate presentation
  rejected without evicting incumbent.
- G0.5 HARD STOP: if the selected delivered OpenClaw runtime can't provide private handleUpgrade-before-101, cutover stops at
  spec revision — no sidecar/controller.vm.host/polling/raw-WS fallback. SDK shim lacks the hook today.
Proof (ingress-upgrade Socket.IO rig): forged signature / duplicate nonce / wrong epoch|zone|generation|route|
protocol fail closed; rate-limited non-revealing failures. Split trigger: G0.5 unprovable → STOP.

## In-VM attacker (gateway-control-service-placement)
- P.1 Public-key-only-in-VM is the forgery firewall: untrusted model code shares the gateway process, but the VM
  holds only the public verifier + single-use atomically-consumed nonce, so in-VM code with full process read
  cannot forge a session. Proof: e2e in-VM connect attempt w/o controller signature → rejected pre-101.

## control-protocol-contract
- C.1 strict Zod parse every boundary, unknown-field fail-closed; envelope.kind/operation strictly equal domain.
- C.2 header-only creds, queryCredentialsPresent literal false.
- C.3 forbidden_bulk schema-invalid; identityPem lease frame is the largest legit message; SSH/file/log/artifact/
  provider forbidden.
- C.4 volatile.emit only droppable/latest_wins.
Proof: unit schema tests + exported JSON Schema.

## controller-session-runtime
- S.1 stale bootId/epoch/generation/session/sequence fail closed.
- S.2 no lease liveness extension from wedged/half-open socket.
- S.3 duplicate_session: incumbent never evicted; controller replacement uses fresh nonce+cred+sessionId, stales old
  only after new accepted.
- S.4 sequence-gap on command/liveness/mutation/authorized-control → stale before later liveness.
- S.5 reconnect starts resync_required unless full continuity proven; socket.recovered===true still runs hello/resync;
  Socket.IO reconnect send buffer bounded/disabled; reconnect-storm caps on epoch bump.
Proof: integration flap-during-active-use → no extension → Tool VM SSH after resync; unit fencing.

## lease-control-rpc-parity (owns identityPem custody + single-client)
- L.1 identityPem custody: today read from file and returned in lease body (serializeLeaseForResponse
  controller-http-route-support.ts:145-159; consumed openclaw-backend-dependencies.ts:21,64). Post-cutover rides
  lease-snapshot frames: NEVER logged/traced/exported; bounded in-memory lifetime; delivered only on the single
  accepted current-generation session.
- L.2 logging-redaction + single-client enforcement owned here (ties to S.3).
- L.3 maxHttpBufferSize floor > lease snapshot with multi-KB identityPem + envelope overhead.
- L.4 liveness mutations (lease_renew, lease_use_heartbeat) never replayed after reconnect/stale/overflow;
  single-use mutations bind op/use ids, duplicate → terminal result/conflict; exactly-once active-use finalize.
  Current cadence heartbeatAfterMs=30s, heartbeatStaleMs=120s (lease-manager.ts:160-181). Ordering invariant:
  heartbeat cadence < active-use TTL w/ missed-heartbeat margin; connect+ack < 10s active-use-start budget.
- L.5 operation_cancel/recovery_command target known active op/session ids; not generic guest/file/shell/provider.
- L.6 heartbeat/cancel priority; overflow closes/stales, never silently extends liveness.
Proof: integration duplicate/stale/replay/overflow fail closed no-extension; rig asserts identityPem frame never in
logs/traces/exports.

## managed-openclaw-hard-cutover
- H.1 remove controller.vm.host:18800 tcpHost (openclaw-lifecycle.ts:75, worker-lifecycle.ts:62) + CONTROLLER_BASE_URL
  (worker-lifecycle.ts:34); delivered tcpHosts only tool-<slot>:22.
- H.2 remove controller.vm.host from allowedHosts for control.
- H.3 websocketBypass (openclaw-lifecycle.ts:81-83) + collector raw TCP (85-97) FAIL CLOSED at validation/boot unless
  accepted replacement/exception.
- H.4 no unused-but-shippable raw clients, fallback env, old plugin identity, old health-loop wiring.
Proof: architecture residue gate (test:portal-architecture/test:taxonomy), VM-spec unit tcpHosts/allowedHosts,
boot-fail-closed integration. Rollback = VERSION PIN (name pinned pre-cutover version); no runtime dual path.

## operator-health-observability (incident-amplifier fix)
- O.1 remap gateway-control-link-unhealthy → control-session-unhealthy (gateway-vm-recovery-policy.ts:330); trigger
  from gateway_control_session in {stale,failed} or consecutive control-RPC timeout/failure over N evals/window;
  same per domain incl. worker.
- O.2 CORROBORATION GATE: gateway/worker observations advisory; recovery requires controller-owned probe corroboration
  in-window. Today recordGatewayControlLinkObservation triggers recovery DIRECTLY from a gateway observation;
  recordGatewayServiceProbe is a SEPARATE trigger — no AND-gate (VERIFIED gateway-vm-recovery-policy.ts:310-354).
- O.3 PER-SOURCE RATE/BUDGET: existing recoveryBudgets count consecutive FAILED RECOVERIES (:102-132,202-258), not
  observation volume; POST /zones/:zoneId/health-events is UNAUTHENTICATED (validates JSON/kind/zone/lease-ownership,
  no caller identity — VERIFIED controller-health-event-routes.ts:34-137). Amplifier: forge failing observations →
  drive consecutiveFailures → burn max-failed-recoveries → zone suspend.
- O.4 post-cutover observations ride the AUTHENTICATED control session, not the unauth HTTP publish route;
  gateway-control-link not a readiness dependency.
Proof: unit — recovery requires probe corroboration + per-source budget; runtime — forged health can't trigger
recovery beyond budget without corroboration.

## Git push safety (worker side + controller-mediated push)
- GP.1 host githubToken never in any VM; CONTROLLER_BASE_URL removed at cutover.
- GP.2 SSH egress execPolicy allow git-upload-pack, DENY git-receive-pack at host boundary, deny non-git/shells.
- GP.3 controller push ff-only to non-protected branch; refuse default/protected/force/delete/non-branch;
  expectedHead precondition-only, never --force-with-lease.
- GP.4 no git pack over control socket (forbidden_bulk); commits via host-backed work mount.
Proof: git-access proof.

## Meta: secrets in plan artifacts
No resolved secret values, op:// refs, credential/identity paths, account UUIDs/emails/domains in plan/handoff.
identityPem/nonce/signature/credentialId/sessionKey never in model-visible payloads/logs/diagnostics/exports; only
sessionKeyDigest propagates.

## Split / replan triggers
1. handleUpgrade-before-101 unprovable on pinned OpenClaw → STOP (spec, not plan slice).
2. Collector-mode disposition is an OPEN product ruling — isolate into its own slice gated behind the ruling so it
   can't block control-plane slices.
3. Worker-domain corroboration probe undefined → route to spec before hardening session-runtime + observability.
4. /lease identityPem route disposition (delete vs operator-auth-gate) undecided → custody proof can't close;
   gate-0-adjacent.

## Open questions (route-back candidates — parent verified BOTH as real)
Q1. Unauthenticated /lease returns Tool VM SSH private key (identityPem). Spec doesn't state whether /lease is
    DELETED (leases become control-RPC only) or RETAINED with a new operator-auth gate. Live custody hole.
Q2. Worker corroboration source ambiguous: is Worker /health (server.ts) the corroborating probe, or ingress
    readiness only? Spec says "ingress readiness/liveness"; confirm for worker_control.
