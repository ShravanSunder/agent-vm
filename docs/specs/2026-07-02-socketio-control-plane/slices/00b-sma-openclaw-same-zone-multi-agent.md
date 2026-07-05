# Slice SMA — OpenClaw Same-Zone Multi-Agent Preservation

Status: plan-repair slice, added 2026-07-05 after the user rejected the accidental
single-agent cutover rule.

## Source

- User correction: managed OpenClaw is supposed to remain properly multi-agent.
- Existing runtime intent:
  - `zones[].agents` is the trusted declared-agent allowlist.
  - `agentToolVmProfiles` selects Tool VM images by agent id, falling back to
    `defaultToolVmProfile`.
  - caller-context registration is controller-vetted and must reject undeclared
    or forged agents.
- This slice supersedes any active docs/code text claiming that Socket.IO hard
  cutover requires exactly one trusted agent per OpenClaw zone.

## Behavior

Same-zone multi-agent managed OpenClaw must be accepted when all agents are
declared and the dependent per-agent config is consistent. The cutover must not
collapse a zone to one agent.

Before issuing `callerContextId`, the controller must validate or derive
`agentId`, `agentWorkspaceDir`, `workMountDir`, and `sessionKeyDigest` from
accepted session-scoped/controller truth. Declared-agent allowlisting alone is
not enough. A declared agent with another agent's workspace/work mount, an
ambiguous shared fallback, or a mismatched session key fails closed.

Still rejected:

- zero declared OpenClaw agents
- duplicate agent ids
- undeclared `agentToolVmProfiles`, `agentSandboxSeeds`, secret `agentAccess`,
  or MCP Portal agent ids
- caller-context registration for an undeclared or forged agent id
- Tool Portal host action without zone Tool Portal config
- cross-agent lease/profile reuse caused by changed agent/workspace/workMount/
  session-key provenance
- multi-agent scaffolds/configs whose effective workspace mapping is shared or
  ambiguous instead of distinct per declared agent

## Write Surface

- `packages/agent-vm/src/config/system-config.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- `packages/agent-vm/src/cli/init-command.ts`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `docs/reference/configuration/system-json.md`
- `docs/subsystems/controller.md`
- `docs/getting-started/openclaw-guide.md`

Proof surfaces:

- `packages/agent-vm/src/config/system-config.unit.test.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
- `packages/agent-vm/src/cli/agent-vm-entrypoint.unit.test.ts`
- `packages/agent-vm/src/cli/init-command.integration.test.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`
- `packages/agent-vm/src/controller/leases/openclaw-tool-vm-lease-create-options.unit.test.ts`
- `packages/agent-vm/src/gateway/mcp-portal-effective-config.unit.test.ts`
- `packages/agent-vm/src/operations/config-validation.integration.test.ts`

## Checkpoint

- Config load accepts a multi-agent OpenClaw zone.
- `agent-vm init --openclaw-agents a,b,c` scaffolds all requested agents in
  system config, OpenClaw `agents.list`, and MCP Portal config.
- caller-context registration accepts a declared non-default second agent,
  preserves that non-default agent downstream, and rejects undeclared,
  mismatched-session-key, wrong-workspace, and wrong-work-mount evidence.
- per-agent Tool VM profile selection and fallback are proven.
- active docs and generated manuals no longer contain the single-agent cutover
  rule.

## Proof

Canonical rows: SMA-1 through SMA-7 in `../lanes/validation-proof.md`.

Required command layers:

- `pnpm test:unit`
- targeted integration tests through `pnpm test:integration`
- generated manual smoke when manual output changes
- beta validation after local package sync, without editing `../shravan-claw`

## Split / Replan Trigger

If implementation finds that current OpenClaw adapter evidence cannot validate
or derive `agentId`, `agentWorkspaceDir`, `workMountDir`, and
`sessionKeyDigest` against accepted session/controller truth without new
protocol fields, stop and route back to spec creation before changing product
code further.
