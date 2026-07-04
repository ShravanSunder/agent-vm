# 04 - S4a Gateway Control Contract And Lease RPC

Purpose:
- Populate the full gateway domain contract.
- Move lease/use behavior to gateway_control_rpc while keeping controller
  authority.

Source anchors:
- CUT Gateway Control RPC Contract.
- CUT lease authority and trusted caller context.
- PROTO shared envelope/domain equality.

Owned write surface:
- `packages/gateway-control-contracts/**`
- Controller lease/use RPC handlers registered on S3 dispatch seam
- Remove `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend-handle-factory.ts`
- `packages/gateway-interface/src/health/controller-request-policy.ts` through
  the single-owner hot-file sequence

Dependencies:
- S1, S3.

Checkpoint:
- Gateway operation union includes every spec operation.
- Lease create/get/peek/renew/release and use start/heartbeat/end work over
  RPC.
- `caller_context_register` is the issuance path for opaque
  controller-owned `callerContextId`; it accepts only untrusted adapter
  evidence, validates it controller-side, and returns only the opaque id for
  later `lease_create`.
- Controller recomputes authority and rejects hidden control fields.
- identityPem custody uses the expanded proof expectations.
- Existing leases remain reachable when reconnect refreshes
  `callerContextId`, `sessionId`, and `connectionId` but stable
  controller-vetted provenance is unchanged. Ownership must reject a different
  agent/workspace/session-key provenance.

Proof rows:
- DOMAIN-SEP-1 gateway portion
- SURFACE-1
- DELIVERY-3, DELIVERY-4 lease portions
- SCHEMA rows for gateway domain exactness

Commands:
- `pnpm test:unit`
- `pnpm test:integration`

Split trigger:
- Split full union/schema work from lease handler implementation if the
  contract package becomes the bottleneck.
