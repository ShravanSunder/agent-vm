# agent-vm

Sandboxed QEMU micro-VM controller and worker packages for autonomous coding agents.

## Rules

@.cursor/rules/ts-rules.md
@.cursor/rules/monorepo-rules.md

## Agent Orientation

Use progressive disclosure when learning this repo:

1. Start with `README.md` for the five-minute mental model.
2. Use `docs/README.md` as the docs map.
3. Use `docs/architecture/overview.md` for the system model.
4. Use mode-specific gateway docs only when needed:
   - `docs/architecture/agent-worker-gateway.md` — Agent Worker Gateway, in-VM pipeline, event log, executors.
   - `docs/architecture/openclaw-gateway.md` — OpenClaw Gateway, long-running gateway VM, tool VM leases.
5. Use subsystem docs for implementation details:
   - `docs/subsystems/controller.md` — HTTP routes, controller runtime, lease manager.
   - `docs/subsystems/gateway-lifecycle.md` — `GatewayLifecycle`, Agent Worker Gateway vs OpenClaw Gateway implementations.
   - `docs/subsystems/gondolin-vm-layer.md` — Gondolin adapter, VFS, `tcpHosts`, image build.
   - `docs/subsystems/worker-task-pipeline.md` — host-side Agent Worker task lifecycle, repo resources, teardown.

For configuration questions, start at `docs/reference/configuration/README.md`,
then drill down:

- `docs/reference/configuration/system-json.md` — host/controller config, zones, gateway config, secrets, resource policy.
- `docs/reference/configuration/worker-json.md` — Agent Worker Gateway phases, prompts, verification, MCP servers.
- `docs/reference/configuration/project-config-json.md` — repo-local `.agent-vm/config.json` overrides.
- `docs/reference/configuration/resource-contracts.md` — `.agent-vm/` repo resources and task external resources.
- `docs/reference/configuration/system-cache-identifier.md` — cache fingerprint inputs.
- `docs/reference/configuration/prompt-files.md` — prompt file references and resolution.

For package ownership, use the package map below first, then inspect the package
README/source. Keep boundaries explicit: gateway packages produce VM/process
specs; `agent-vm` owns controller/CLI orchestration; `agent-vm-worker` owns the
in-VM task loop.

## Repo Tooling

This is a pnpm TypeScript monorepo targeting Node 24. It uses the OXC stack for
fast formatting and linting.

- Install/build: `pnpm install`, then `pnpm build`.
- Unit tests: `pnpm test:unit`.
- Integration tests: `pnpm test:integration`.
- Smoke tests: `pnpm test:smoke`.
- Full quality gate: `pnpm check`.
- OXC formatting: `pnpm fmt:check` to verify, `pnpm fmt` to apply Oxfmt.
- OXC linting: `pnpm lint` for Oxlint, `pnpm lint:types` for type-aware Oxlint.
- Typecheck: `pnpm typecheck`.

Prefer targeted commands while iterating, then run the broad gate before
claiming done. Do not use `npm` or `yarn` in this repo.

For CLI, scaffold, default-value, and generated-config changes, add a local
black-box smoke test in a temporary directory. Exercise the actual command a
user would run, inspect the generated files, and run the relevant validation
command against that generated output before claiming the default is safe.

## TypeScript Standards

Follow `.cursor/rules/ts-rules.md`; key points:

- No `any`; use explicit, narrow types or generics.
- Prefer `satisfies` over `as` casts.
- Explicit parameter and return types.
- Use discriminated unions for variants.
- Use `readonly` for immutable arrays/properties.
- Use descriptive multi-word file and folder names.
- Use tabs and Oxfmt formatting.
- Keep Zod schemas and inferred types in sync; derive schema variants with Zod helpers.

## Packages

```text
gondolin-adapter          → VM build pipeline, adapter, secret resolver (no internal deps)
gateway-interface         → Types: GatewayLifecycle, VmSpec, ProcessSpec (→ gondolin-adapter)
openclaw-gateway          → OpenClaw lifecycle (→ gateway-interface, gondolin-adapter)
worker-gateway            → Worker lifecycle (→ gateway-interface, gondolin-adapter)
openclaw-agent-vm-plugin  → OpenClaw sandbox backend (→ gondolin-adapter)
agent-vm-worker           → Worker process, runs inside VM (standalone)
agent-vm                  → Controller CLI + HTTP server (→ all above)
```

## Layout

`config/` holds `system.json`, `systemCacheIdentifier.json`, gateway config, and prompts.

`vm-images/` holds Gondolin VM image recipes.

`vm-host-system/` is optional boot plumbing for a generic container host that
runs Docker, QEMU, Zig, and the controller.

## Controller API

- `GET /health` — readiness
- `POST /zones/:zoneId/worker-tasks` — start worker task, returns `202 { taskId, status: "accepted" }`
- `GET /zones/:zoneId/tasks/:taskId` — replayed worker task state snapshot
- `POST /zones/:zoneId/tasks/:taskId/push-branches` — controller-side git push
- `POST /zones/:zoneId/tasks/:taskId/pull-default` — controller-side default-branch pull
- `POST /zones/:zoneId/tasks/:taskId/close` — request task cancellation

## Key Files

- `packages/agent-vm/src/controller/controller-runtime.ts` — startup, gateway type dispatch
- `packages/agent-vm/src/controller/worker-task-runner.ts` — per-task VM lifecycle
- `packages/agent-vm/src/controller/git-push-operations.ts` — host-side push
- `packages/agent-vm-worker/src/coordinator/coordinator.ts` — worker loop
- `packages/agent-vm-worker/src/config/worker-config.ts` — worker config schema
- `packages/worker-gateway/src/worker-lifecycle.ts` — VM spec + process spec

## Secrets

Zone secrets: `source: "1password"` (op:// ref) or `source: "environment"`
(env var). Injection is either `"http-mediation"` (proxy layer, VM never sees
the raw value) or `"env"` (VM environment variable). `host.githubToken` is
controller-only for git operations and never enters the VM.

## Gateway Image Security Boundary

Do not bake auth tokens or credential material into gateway images. Runtime
auth must flow through controller HTTP mediation. Keep token env names,
registry auth files, and build args out of every generated gateway Dockerfile
so a future edit cannot accidentally turn a runtime secret into image state.

Forbidden in gateway Dockerfiles:

- `ARG`, `ENV`, or `RUN` referencing token names, even with escaped `${VAR}`
- writing or copying `.npmrc`, `.docker/config.json`, `.netrc`, or auth files
- `_authToken`, `_password`, or `_secret` literal substrings

Allowed runtime auth path:

1. `system.json` declares the secret with `injection: "http-mediation"` and the
   allowed `hosts`.
2. `system.json` declares `runtimeAuthHints` for service tokens the agent should
   know about.
3. The controller generates `runtimeInstructions` and the agent-facing
   `/agent-vm/agents.md` runtime index at task boot. `/workspace/CLAUDE.md` and
   `/agent-vm/CLAUDE.md` are symlinks to generated agent indexes for
   Claude-compatible discovery.
4. Gondolin runtime puts a placeholder in the VM env at boot; the proxy swaps it
   for the real token only on outbound calls to allowed hosts.

Common prompt defaults live in `common-agent-instructions.md`. Runtime
paths/auth/resources are generated by the controller into `runtimeInstructions`
and `/agent-vm/agents.md`. `/state` is mounted in the VM for worker/controller
plumbing, not as the primary agent documentation surface. Gateway images must
stay redistributable without secret pinning.
