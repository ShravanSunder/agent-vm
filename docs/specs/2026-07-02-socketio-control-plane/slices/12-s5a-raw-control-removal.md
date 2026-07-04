# 12 - S5a Raw Control Removal

Purpose:
- Remove old raw controller control paths from delivered managed VM specs and
  generated docs.

Source anchors:
- CUT Hard Cutover Invariants.
- CUT VM spec proof and residue proof.

Owned write surface:
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts` — remove
  `controller.vm.host:18800` tcpHost (`:75`); the `:81-83` websocketBypass loop
  is a plain host→tcpHost mapping TODAY (no fail-closed check exists yet) — this
  slice ADDS/PROVES the fail-closed behavior, it does not find it. Coordinate
  with SG (SSH Git), which also edits this builder (different region: egress execPolicy).
- `packages/gateway-interface/src/audience.ts` (PC-1) — the REAL
  `controller.vm.host` injection site: literal at `:11`, unconditional
  `gatewayVmAllowedHosts` injection at `:29-31`. Removing it from `allowedHosts`
  edits HERE, not `openclaw-lifecycle.ts:1011` (a call site).
- `packages/worker-gateway/src/worker-lifecycle.ts` — `:34` `CONTROLLER_BASE_URL`,
  `:61-63` controller tcpHost; allowedHosts via the same `audience.ts` helper.
  Coordinate with SG (SSH Git).
- `packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.ts` (remove)
- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts` (remove)
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` final removal layer
- ORPHAN CLEANUP (PC-2): once `controller-lease-client.ts` (S4a) and the two
  files above are gone, the plugin re-export barrel
  `packages/openclaw-agent-vm-plugin/src/controller-request-policy.ts` + its
  `.unit`/`.integration` tests + the `export * from './controller-request-policy.js'`
  in `index.ts:3` are dead — delete them.
- `packages/agent-vm/src/cli/manual-templates.ts`

Dependencies:
- S2, S4a, S4b, S6, S7, SW.

Checkpoint:
- Delivered `tcpHosts` set contains only Tool VM SSH.
- Delivered `allowedHosts` (via `audience.ts` `gatewayVmAllowedHosts`) does not
  preserve `controller.vm.host`.
- Generated manuals no longer teach `gateway-control-link` or
  `controller.vm.host:18800` as current managed control behavior.
- No orphaned request-policy barrels/tests remain.

Proof rows:
- RESIDUE-1, RESIDUE-2 non-collector, RESIDUE-3, RESIDUE-5

Commands:
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm check`

Split trigger:
- Split docs/manual residue from VM spec residue if the audit produces too many
  allowlist decisions.
