# agent-vm

Sandboxed QEMU micro-VM controller and worker packages for autonomous coding agents.

## Rules

@.cursor/rules/ts-rules.md
@.cursor/rules/monorepo-rules.md

## Orientation

Use progressive disclosure when learning the repo:

1. Start with `README.md`.
2. Use `docs/README.md` as the docs map.
3. Use `docs/architecture/overview.md` for the system model.
4. Use mode-specific gateway docs only when needed:
   - `docs/architecture/agent-worker-gateway.md`
   - `docs/architecture/openclaw-gateway.md`
5. Use subsystem docs for implementation details:
   - `docs/subsystems/controller.md`
   - `docs/subsystems/gateway-lifecycle.md`
   - `docs/subsystems/gondolin-vm-layer.md`
   - `docs/subsystems/worker-task-pipeline.md`

For configuration questions, start at `docs/reference/configuration/README.md`.

## Tooling

- Install/build: `pnpm install`, then `pnpm build`
- Unit tests: `pnpm test:unit`
- Integration tests: `pnpm test:integration`
- Smoke tests: `pnpm test:smoke`
- Full quality gate: `pnpm check`
- Typecheck: `pnpm typecheck`

Prefer targeted commands while iterating, then run the broad gate before
claiming done.

## Packages

```text
gondolin-adapter         → VM build pipeline, adapter, secret resolver
gateway-interface        → GatewayLifecycle, VmSpec, ProcessSpec
openclaw-gateway         → OpenClaw lifecycle
worker-gateway           → Worker lifecycle
openclaw-agent-vm-plugin → OpenClaw sandbox backend
agent-vm-worker          → Worker process, runs inside VM
agent-vm                 → Controller CLI + HTTP server
```

## Layout

`config/` holds `system.json`, `systemCacheIdentifier.json`, gateway config, and prompts.

`vm-images/` holds Gondolin VM image recipes.

`vm-host-system/` is optional boot plumbing for a generic container host that
runs Docker, QEMU, Zig, and the controller.

## Controller API

- `GET /health`
- `POST /zones/:zoneId/worker-tasks`
- `GET /zones/:zoneId/tasks/:taskId`
- `POST /zones/:zoneId/tasks/:taskId/push-branches`
- `POST /zones/:zoneId/tasks/:taskId/pull-default`
- `POST /zones/:zoneId/tasks/:taskId/close`

## Key Files

- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/controller/worker-task-runner.ts`
- `packages/agent-vm/src/controller/git-push-operations.ts`
- `packages/agent-vm-worker/src/coordinator/coordinator.ts`
- `packages/agent-vm-worker/src/config/worker-config.ts`
- `packages/worker-gateway/src/worker-lifecycle.ts`

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

1. `system.json` declares the secret with `injection: "http-mediation"` and allowed hosts.
2. Gondolin runtime places a placeholder in the VM env at boot.
3. The agent or its tooling consumes the placeholder env var; the proxy swaps it for the real token only on outbound calls to allowed hosts.

The worker base prompt documents how to use placeholder env vars per tool. The
gateway image must stay redistributable without secret pinning.
