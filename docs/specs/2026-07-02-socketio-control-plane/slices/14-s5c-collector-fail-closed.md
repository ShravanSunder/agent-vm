# 14 - S5c Collector Mediated OTLP Replacement

Purpose:
- Preserve enabled OpenClaw zone observability during the Socket.IO hard
  cutover without recreating managed gateway raw collector `tcpHosts`.
- Route OpenClaw diagnostics OTLP HTTP through Gondolin HTTP mediation to the
  configured loopback collector.

Source anchors:
- CUT non-control raw TCP deferred decision.
- CUT stop condition for collector-mode raw tcpHosts.
- User correction: hard cutover must replace observability, not disable it.

Owned write surface:
- OpenClaw gateway VM spec for observability collector mode.
- Controller gateway boot path that composes the WebSocket upgrade guard with
  the collector mediation rewrite.
- Config validation path for enabled zone observability.
- System configuration docs and generated observability manual.

Dependencies:
- Host observability must still be enabled for zone observability.
- Managed OpenClaw observability still requires the managed `openclaw-gateway`
  base so `@openclaw/diagnostics-otel` is installed.
- Final shipment cannot keep collector-mode raw tcpHosts shippable and cannot
  reject enabled zone observability merely because of the cutover.

Checkpoint:
- `zones[].observability.enabled=true` is accepted when host observability is
  enabled and the OpenClaw managed-image/safety checks pass.
- OpenClaw effective diagnostics point to the synthetic collector host.
- Gateway VM `allowedHosts` includes the synthetic collector host.
- Gateway VM `tcpHosts` contains only Tool VM SSH entries.
- The controller passes an HTTP mediation `onRequest` hook that rewrites the
  synthetic collector host to the configured loopback collector target while
  retaining the WebSocket upgrade guard.

Proof rows:
- RESIDUE-2 collector branch.
- OBS-1 mediated OpenClaw observability.

Commands:
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:e2e:host`
- `pnpm check`

Split trigger:
- If OTLP gRPC support is required for OpenClaw diagnostics, split a new
  transport slice before enabling gRPC. This slice owns OTLP HTTP/protobuf only.
