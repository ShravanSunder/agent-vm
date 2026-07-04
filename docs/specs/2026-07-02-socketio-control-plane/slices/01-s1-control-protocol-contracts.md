# 01 - S1 Control Protocol Contracts

Purpose:
- Create shared Zod v4/JSON Schema control contracts and constants.
- Scaffold gateway and worker contract packages so shared wiring happens once.

Source anchors:
- PROTO Shared Package Contract, Shared Envelope, Delivery, Backpressure,
  Close Reasons, Security Contract, Proof Expectations.

Owned write surface:
- `packages/control-protocol-contracts/**`
- `packages/gateway-control-contracts/**` empty shell with placeholder exports
- `packages/worker-control-contracts/**` empty shell with placeholder exports
- `tsconfig.base.json`
- `scripts/verify-portal-package-exports.ts`
- `scripts/audit-portal-architecture.ts`

Dependencies:
- None. Runs after GATE-0a succeeds.

Checkpoint:
- Three new packages build, typecheck, and export.
- Shared constant module carries chosen timing and queue constants.
- JSON Schema export is generated from Zod schemas.
- Every `ControlMessageKindSchema` value resolves to an owning payload/handler
  (AF-3): resync is via `control:hello` (no `resync_request`/`resync_response`
  kind); snapshot/heartbeat/observation each mapped per the PROTO kind
  disposition.
- Delivery class is bound to `(operation, payload)` in contract, so the
  receiver derives it and never trusts the sender's envelope `deliveryPolicy`
  (AF-2).

Proof rows:
- SCHEMA-1, SCHEMA-2, SCHEMA-3, SCHEMA-4, SCHEMA-5, SCHEMA-6
- DELIVERY-1, DELIVERY-2
- KIND-EXACT (AF-3), DP-TRUST S1 portion (AF-2)
- BP-4, BP-5
- HANDSHAKE-1
- DOMAIN-SEP-1 package-shell portion

Commands:
- `pnpm test:unit`
- `pnpm check`

Split trigger:
- Split JSON Schema exporter if artifact generation crosses package boundaries
  or becomes larger than the schema work.
