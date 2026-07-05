# 02 - S2 Gateway Control Service Placement

Purpose:
- Productionize the managed OpenClaw private control service.
- Host the Socket.IO server through the OpenClaw plugin route upgrade hook on
  the existing guest port.

Source anchors:
- CUT Placement And Route Ownership.
- CUT Handshake Requirements.
- PROTO transport and security contract.

Owned write surface:
- `packages/openclaw-agent-vm-plugin/src/openclaw-sandbox-sdk-contract.ts`
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
  register structure
- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/**`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts` path exposure

Dependencies:
- GATE-0a success.
- S1 contracts.

Checkpoint:
- `GET /__agent-vm/ready` issues a short-lived nonce.
- `/__agent-vm/gateway-control` upgrades with Socket.IO only.
- Nonce lifecycle is `issued -> consuming -> accepted | failed | expired`.
- Duplicate nonce does not evict incumbent accepted session.
- No public/model/browser auth opens the control route.

Proof rows:
- HANDSHAKE-2, HANDSHAKE-3, HANDSHAKE-4
- HANDSHAKE-5, INGRESS-1, INGRESS-2 with S3
- RPC-VM-1 with S3/S4a: a controller-originated `control_ping` command reaches
  the managed VM over `/__agent-vm/gateway-control` and returns a typed
  gateway_control result.

Commands:
- `pnpm test:integration`
- `mise exec -- pnpm run test:e2e:openclaw`

Split trigger:
- Split nonce store from plugin route only if the integration tests require a
  reusable store abstraction.
