# CLI Redesign Implementation Checklist

Source spec: `docs/superpowers/plans/2026-04-11-cli-redesign.md`

Legend:

- `[x]` implemented and verified
- `[~]` implemented, but live verification is blocked by host/runtime environment
- `[ ]` not implemented

## Goal

- `[x]` `cmd-ts` replaced the manual CLI parser in [agent-vm-entrypoint.ts](../../packages/agent-vm/src/cli/agent-vm-entrypoint.ts)
- `[x]` long-running operations now go through a CLI-owned progress runner in [run-task.ts](../../packages/agent-vm/src/cli/run-task.ts)
- `[x]` `init --type openclaw|coding` is implemented in [init-definition.ts](../../packages/agent-vm/src/cli/commands/init-definition.ts) and [init-command.ts](../../packages/agent-vm/src/cli/init-command.ts)
- `[x]` structured output stays on stdout and progress/prompt text stays off stdout in non-TTY mode

## CLI Hierarchy

- `[x]` top-level `init`
- `[x]` top-level `build`
- `[x]` top-level `doctor`
- `[x]` top-level `cache list|clean`
- `[x]` top-level `backup create|list|restore`
- `[x]` top-level `openclaw auth`
- `[x]` `controller start|stop|status|ssh|destroy|upgrade|logs`
- `[x]` `controller credentials refresh`
- `[x]` `controller lease list|release`
- `[x]` typo suggestions work for unknown top-level commands
- `[x]` `coding` remains intentionally out of scope for this changeset

## Testing Seam

- `[x]` `runAgentVmCli(argv, io, dependencies)` still exists as the test adapter in [agent-vm-entrypoint.ts](../../packages/agent-vm/src/cli/agent-vm-entrypoint.ts)
- `[x]` `createAgentVmApp(io, dependencies)` preserves DI in [create-app.ts](../../packages/agent-vm/src/cli/commands/create-app.ts)
- `[x]` CLI tests still exercise injected dependencies via [agent-vm-entrypoint.test.ts](../../packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts)

## Output Contract

- `[x]` `controller start` writes final JSON to stdout in [controller-definition.ts](../../packages/agent-vm/src/cli/commands/controller-definition.ts)
- `[x]` `build` progress is supplied via CLI-owned `runTask` dependency in [build-definition.ts](../../packages/agent-vm/src/cli/commands/build-definition.ts)
- `[x]` `init` result JSON stays on stdout
- `[x]` `init` prompt/status text moved to stderr in [init-command.ts](../../packages/agent-vm/src/cli/init-command.ts)
- `[x]` non-TTY progress goes to stderr only in [run-task.ts](../../packages/agent-vm/src/cli/run-task.ts)
- `[x]` non-TTY runner behavior is covered by [run-task.test.ts](../../packages/agent-vm/src/cli/run-task.test.ts)

## Progress Granularity

- `[x]` gateway startup progress is threaded into [gateway-zone-orchestrator.ts](../../packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
- `[x]` gateway steps are visible individually:
  - `[x]` resolving zone secrets
  - `[x]` building gateway image
  - `[x]` booting gateway VM
  - `[x]` configuring gateway
  - `[x]` starting OpenClaw
- `[x]` controller runtime progress is threaded into [controller-runtime.ts](../../packages/agent-vm/src/controller/controller-runtime.ts)
- `[x]` controller runtime steps are visible individually:
  - `[x]` resolving 1Password secrets
  - `[x]` starting gateway zone
  - `[x]` starting controller HTTP API
- `[x]` gateway step ordering is tested in [gateway-zone-orchestrator.test.ts](../../packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts)
- `[x]` controller step ordering is tested in [controller-runtime.test.ts](../../packages/agent-vm/src/controller/controller-runtime.test.ts)

## Gateway Types

- `[x]` `gateway.type` exists in the system config schema in [system-config.ts](../../packages/agent-vm/src/controller/system-config.ts)
- `[x]` `init` defaults to `openclaw`
- `[x]` `init --type coding` is effective for scaffolding
- `[x]` coding scaffolding writes `config/<zone>/coding.json`
- `[x]` coding scaffolding writes a gateway Dockerfile with `@openai/codex-cli`
- `[x]` openclaw scaffolding still writes `config/<zone>/openclaw.json`
- `[x]` gateway-type scaffolding is covered by [init-command.test.ts](../../packages/agent-vm/src/cli/init-command.test.ts)
- `[x]` config loading accepts `gateway.type` in [system-config.test.ts](../../packages/agent-vm/src/controller/system-config.test.ts)
- `[x]` `controller start` now reads `gateway.type` and throws a clear unsupported error for `coding` zones in [gateway-zone-orchestrator.ts](../../packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)

## Behavioral Preservation

- `[x]` `init` zone is still optional and defaults to `default`
- `[x]` `--zone` resolution still follows system config defaults for auth/backup/controller helpers
- `[x]` `controller credentials refresh` stayed nested
- `[x]` `--config` defaults to `system.json`
- `[x]` `controller ssh-cmd` was intentionally renamed to `controller ssh` per spec
- `[x]` `auth` moved under `openclaw auth` per spec
- `[x]` `doctor` moved to top-level per spec

## Validation Checks From Spec

- `[x]` `agent-vm --help` works
- `[x]` `agent-vm controller --help` works
- `[x]` `agent-vm contorller start` suggests `controller`
- `[x]` `agent-vm openclaw auth --help` works
- `[x]` `agent-vm init test-zone --type coding` scaffolds a coding gateway in live CLI smoke checks
- `[x]` `pnpm check` passes
- `[x]` `pnpm test` passes
- `[~]` live `agent-vm controller start` shows the new progress path and now gets past initial 1Password SDK initialization, but full boot still stalls/fails in zone secret resolution on this machine
- `[~]` live `agent-vm controller start | jq .ingress` remains blocked by that unresolved runtime secret-resolution failure before final JSON is emitted

## Current Remaining Delta

- `[~]` The implemented CLI redesign is complete at code/test level.
- `[~]` The remaining gap against the plan is live controller boot verification. The branch fixed two code-level 1Password fallback gaps, but the full runtime still fails during zone secret resolution in this environment.
