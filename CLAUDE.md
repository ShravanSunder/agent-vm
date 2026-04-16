# agent-vm

Sandboxed QEMU micro-VM system for running LLM coding agents. Controller on host, worker inside VM, secrets injected at network layer.

## Rules

@.cursor/rules/ts-rules.mdc
@.cursor/rules/monorepo-rules.mdc

## Packages

```
gondolin-core          → VM build pipeline, adapter, secret resolver (no internal deps)
gateway-interface      → Types: GatewayLifecycle, VmSpec, ProcessSpec (→ gondolin-core)
openclaw-gateway       → OpenClaw lifecycle (→ gateway-interface, gondolin-core)
worker-gateway         → Worker lifecycle (→ gateway-interface, gondolin-core)
openclaw-agent-vm-plugin → OpenClaw sandbox backend (→ gondolin-core)
agent-vm-worker        → Worker process, runs inside VM (standalone)
agent-vm               → Controller CLI + HTTP server (→ all above)
```

npm scope: `@shravansunder/*`. Publish order: leaves → agent-vm last.

## Install + Build

```bash
pnpm install && pnpm build
```

tsdown for library packages, tsc for agent-vm + agent-vm-worker.

## Run Locally

```bash
agent-vm init my-zone --type worker
# Fix system.json: tokenSource → { "type": "env", "envVar": "OP_SERVICE_ACCOUNT_TOKEN" }
# Add: "githubToken": { "source": "1password", "ref": "op://agent-vm/github-token/credential" }
source .env && agent-vm build --config config/system.json
agent-vm controller start --config config/system.json --zone my-zone
```

## Controller API

- `GET /health` — readiness
- `POST /zones/:zoneId/worker-tasks` — synchronous, runs full task lifecycle
- `POST /zones/:zoneId/tasks/:taskId/push-branches` — controller-side git push (called by worker wrapup)

## Key Files

- `packages/agent-vm/src/controller/controller-runtime.ts` — startup, gateway type dispatch
- `packages/agent-vm/src/controller/worker-task-runner.ts` — per-task VM lifecycle
- `packages/agent-vm/src/controller/git-push-operations.ts` — host-side push + PR
- `packages/agent-vm-worker/src/coordinator/coordinator.ts` — worker loop
- `packages/agent-vm-worker/src/config/worker-config.ts` — worker config schema
- `packages/worker-gateway/src/worker-lifecycle.ts` — VM spec + process spec

## Secrets

Zone secrets: `source: "1password"` (op:// ref) or `source: "environment"` (env var).
Injection: `"http-mediation"` (proxy layer, VM never sees key) or `"env"` (VM env var).
`host.githubToken` — controller-only, for git push. Never in VM.

## Publishing

See `docs/PUBLISHING.md`. Quick: bump all versions → `pnpm publish --access public --no-git-checks` in dependency order. Use `workspace:*` not `workspace:X.X.X`.

## Architecture

```
Controller (host :18800)
  → clone repo → merge config → docker compose up
  → boot Gondolin VM
    Worker (VM :18789): plan → review → work → verify → review → wrapup
  → worker calls controller push-branches API
  → controller: git push + gh pr create (token on host)
  → cleanup: stop docker, delete task dirs
```
