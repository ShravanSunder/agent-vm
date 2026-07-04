# 14 - S5c Collector Fail-Closed

Purpose:
- Ensure collector-mode observability cannot recreate managed gateway raw
  `tcpHosts` after the hard cutover.

Source anchors:
- CUT non-control raw TCP deferred decision.
- CUT stop condition for collector-mode raw tcpHosts.

Owned write surface:
- OpenClaw gateway VM spec validation for observability collector mode
- Config validation path that decides managed OpenClaw startup failure vs
  accepted later exception

Dependencies:
- OPEN-2 accepted disposition: fail closed for this hard cutover.
- S5a/S5b may be preparatory before this; final shipment cannot keep
  collector-mode raw tcpHosts shippable.

Checkpoint:
- Collector-mode raw tcpHosts fail closed before managed gateway boot.
- A future replacement transport or exception must route through a new spec
  update before implementation.

Proof rows:
- RESIDUE-2 collector branch.

Commands:
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm check`

Split trigger:
- If a future replacement transport is chosen, route back to spec/plan before
  implementation.
