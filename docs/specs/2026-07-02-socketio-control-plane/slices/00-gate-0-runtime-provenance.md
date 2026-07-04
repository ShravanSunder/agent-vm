# 00 - GATE-0 Runtime Provenance And Feasibility

Purpose:
- Fail fast before production implementation.
- Prove the exact managed OpenClaw runtime artifact can host detached
  Socket.IO/Engine.IO through plugin `handleUpgrade(req, socket, head)` with
  private auth before `101`.

Source anchors:
- `implementation-plan.md` GATE 0.
- CUT Placement And Route Ownership.
- PROTO transport and handshake requirements.

Owned write surface:
- Throwaway spike artifacts only.
- No production S1/S2 code dependency.

Required steps:
1. Resolve the exact OpenClaw version shipped by the generated managed image or
   overlay.
2. Assert runtime provenance with generated package/Dockerfile evidence and
   in-VM `openclaw --version`.
3. Prove HTTP readiness and upgrade hook behavior in that exact runtime.
4. Feed a detached Socket.IO server from the plugin `handleUpgrade` hook.
5. Connect a Socket.IO client over `/__agent-vm/gateway-control` with
   `transports: ["websocket"]`.
6. Prove bad credentials are rejected before `101`.
7. Prove no second guest port is opened.

Stop condition:
- If the exact runtime cannot provide private `handleUpgrade` before `101`, and
  no accepted version bump supplies it, stop and route back to spec. Do not
  use sidecar, polling, raw WebSocket, or `controller.vm.host`.

Proof rows:
- HANDSHAKE-5, INGRESS-1, INGRESS-2 precondition.

Local proof:
- Spike receipt with runtime version, good upgrade, bad pre-101 rejection, and
  no second port.
