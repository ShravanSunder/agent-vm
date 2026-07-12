# 05 - S4b Controller Route Disposition

Purpose:
- Remove or operator-auth-gate the old managed VM HTTP mutation routes.
- Prevent shippable fallback after caller-side migration.

Source anchors:
- CUT HTTP route disposition.
- S4b route table in root implementation plan.

Owned write surface:
- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- `packages/agent-vm/src/controller/http/controller-health-event-routes.ts`
- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`

Dependencies:
- Per family after caller move:
  - `/lease*` after S4a
  - health/runtime after S6a/S6b/S6c as appropriate
  - zone-git push after S7

Q1 decision:
- Default is delete VM-mutation routes.
- Retain only with explicit operator-auth-gate choice.

Checkpoint:
- `/lease*`, health-events, runtime-status, and zone-git push are not
  unauthenticated VM-reachable mutation routes.
- `GET /leases` is deleted in this cutover. Any future operator lease diagnostic
  must be a separate authenticated/admin design.
- identityPem custody: it is emitted by THREE lease routes today, not one —
  `POST /lease` (`controller-http-routes.ts:386`), `GET /lease/:leaseId` (`:536`),
  and `POST /lease/:leaseId/renew` (`:548`), all via
  `serializeLeaseForResponse` (`controller-http-route-support.ts:145,155`). All
  three must be disposed (delete or operator-gate), not just `POST /lease`.

Proof rows:
- RESIDUE-6.

Commands:
- `pnpm test:integration`

Split trigger:
- Split per route family if auth policy differs by family.
