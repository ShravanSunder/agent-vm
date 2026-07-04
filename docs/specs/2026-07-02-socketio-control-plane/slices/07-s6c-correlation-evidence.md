# 07 - S6c Correlation And Operator Evidence

Purpose:
- Preserve allowlisted correlation from call surface through control RPC,
  health event, and operator evidence.

Source anchors:
- PROTO Correlation And Trace Propagation.
- CUT Health And Operator Contract.

Owned write surface:
- Correlation allowlist helpers
- Health reducer/operator evidence paths
- Control RPC row/event propagation points

Dependencies:
- S3.

Checkpoint:
- `traceId`, `runId`, `sessionKeyDigest`, `toolCallId`, and request/message
  ids survive to operator evidence.
- Raw `sessionKey` and non-allowlisted fields are rejected or stripped.

Proof rows:
- CORR-1
- DELIVERY-5 append-only observation storage with S1/S3 as needed

Commands:
- `pnpm test:unit`
- `pnpm test:integration`

Split trigger:
- Split telemetry export proof if it requires separate harnessing.
