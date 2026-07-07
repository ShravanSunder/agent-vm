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
- `causationId`, `correlationId`, `requestId`, `traceId`, `runId`,
  `sessionKeyDigest`, `toolCallId`, and request/message ids survive to operator
  evidence when supplied by the owning call surface.
- Raw `sessionKey` and non-allowlisted fields are rejected or stripped.
- This slice proves allowlisted correlation attributes. It does not claim W3C
  `traceparent` propagation or OTel parent/child span joining. If the control
  plane needs true distributed traces, add a separate trace-context slice that
  owns the envelope carrier, Tool VM/worker propagation boundaries, OTel context
  extraction, and linked-trace proof.

Proof rows:
- CORR-1
- DELIVERY-5 append-only observation storage with S1/S3 as needed

Commands:
- `pnpm test:unit`
- Targeted integration only when a runtime path, not only an allowlist/filter,
  is edited.

Split trigger:
- Split telemetry export proof if it requires separate harnessing.
- Split true trace context propagation from correlation attributes; do not
  smuggle it into this slice as a `traceId` field rename.
