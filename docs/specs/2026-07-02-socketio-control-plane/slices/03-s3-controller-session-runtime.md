# 03 - S3 Controller Session Runtime

Purpose:
- Add the controller-side Socket.IO client/session manager.
- Own reconnect, resync, queue/backpressure, generation fencing, stale state,
  and per-domain RPC dispatch extension points.

Source anchors:
- PROTO Identity And Fencing.
- PROTO Delivery, Reconnect, Backpressure, Close Reasons.
- CUT controller-initiated session model.

Owned write surface:
- `packages/agent-vm/src/controller/control-session/**`
- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/controller/gateway-zone-orchestrator.ts`

Dependencies:
- S1.

Checkpoint:
- Controller dials VM after ingress readiness.
- Fake VM Socket.IO integration rig proves session establishment.
- Stale application emits do not auto-flush after reconnect. NOTE:
  socket.io-client has NO option to disable the send buffer — clear
  `socket.sendBuffer` on connect/reconnect (or wrap emit); `volatile` for
  latest_wins/droppable only. BP-3 asserts this behavior, not a constructor flag.
- Latest-wins/droppable advisory messages do not reserve or advance the hard
  critical-command sequence frontier. Queued lossy flushes must be ordered by
  envelope sequence before volatile emit so coalescing by key cannot reorder
  across keys.
- Runtime derives each message's delivery class from `(operation, payload)` and
  fails closed on a contradicting envelope `deliveryPolicy` (AF-2 / DP-TRUST).
- S3 exposes a per-domain RPC handler registration seam.
- DAYS-LONG: transport death drives a cheap RECONNECT; a reconnect within the
  control-session-death grace resyncs and cancels any pending recovery. After a
  VM recreate, a new-bootId/new-epoch session is accepted and the old one fenced.
  Session state is inline (no durable-store seam — user deferred it).
- Controller process restart/redeploy is NOT a same-VM reconnect case in this
  cutover. Gondolin 0.12.0 attach IPC does not recover a full `VM` lifecycle
  object with ingress, so a restarted controller recreates the managed VM unless
  a future explicit VM-adoption API is specified and proven.

Proof rows:
- DELIVERY-1/2 lossy frontier portion; DELIVERY-3, DELIVERY-4, DELIVERY-5
  session/store portion
- FENCE-1
- BP-1, BP-2, BP-3
- CONTROLLER-CEILING (controller stays a lightweight broker, never buffers bulk)
- DP-TRUST S3 dispatch-enforcement portion (AF-2)
- RESILIENT-GRACE, RECREATE-FENCE (with S6b)
- FLAP-1A
- FLAP-1B with S2
- RPC-VM-1 with S2/S4a: controller command dispatch traverses the real managed
  VM private route and parses the domain result.

Commands:
- `pnpm test:integration`
- `mise exec -- pnpm run test:e2e:openclaw`

Split trigger:
- Split connection manager, queue/backpressure, and resync if one file would
  exceed sane ownership or proof size.
