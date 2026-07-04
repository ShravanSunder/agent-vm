# 08 - S7 Tool Portal Backend Taxonomy

Purpose:
- Align Tool Portal backend taxonomy with the hard-cutover architecture.
- Replace model-visible `zone_git_push` with Tool Portal capability backed by
  `controller_host_action`.

Source anchors:
- CUT Backend Taxonomy.
- CUT managed OpenClaw residue rules.

Owned write surface:
- `packages/config-contracts/src/tool-portal-config.ts`
- Tool Portal consumers and testing helpers
- `scripts/audit-portal-architecture.ts`
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
  additive registration layer
- Zone git push Tool Portal/controller_host_action handler path

Dependencies:
- S1.

Checkpoint:
- Backend enum uses `mcp_provider`, `tool_vm_runner`,
  `controller_host_action`.
- Managed model-visible tools are only `tool_portal_*`.
- zone git push is no longer a model-visible direct tool.
- Session-keyed managed Tool Portal entrypoints are bounded. Evicting an
  entrypoint or closing the runtime retires the corresponding session-scoped MCP
  provider backend/session.

Proof rows:
- RESIDUE-4
- DOMAIN-SEP-1 tool action portion
- GIT-2 gateway domain policy portion
- Managed runtime MCP session-retirement unit proof

Commands:
- `pnpm test:unit`
- `pnpm check`

Split trigger:
- Split taxonomy rename from zone git push handler if both touch too many
  consumers at once.
