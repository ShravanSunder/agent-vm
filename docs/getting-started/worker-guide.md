# Agent Worker Gateway Guide

[Overview](../README.md) > Getting Started > Agent Worker Gateway

How to configure and run agent-vm in Agent Worker Gateway — autonomous coding that produces pull requests.

---

## What Agent Worker Gateway Does

You submit a coding task. The controller clones your repo, boots a VM, runs a 6-phase pipeline (plan → review → code → verify → review → wrapup), and opens a PR. The VM is destroyed when done.

For the full pipeline internals, see [architecture/agent-worker-gateway.md](../architecture/agent-worker-gateway.md).

---

## Configuration

Three config files compose together. Project overrides zone, Zod defaults fill gaps.

```
  zone worker.json          (team defaults, lives next to system.json)
       |
       v  deep merge
  .agent-vm/config.json     (project overrides, checked into the PROJECT repo root)
       |
       v  Zod defaults fill gaps
  effective-worker.json     (written to /state/ before VM boots)
```

**Merge rules:** Objects merge recursively (project wins per key). Arrays replace entirely (no concatenation). Missing `.agent-vm/config.json` is fine — zone defaults apply. The controller reads `.agent-vm/config.json` from the cloned repo during task prep, NOT from the zone folder.

### system.json — Define a Worker Zone

In your `system.json`, add a zone with `gateway.type: "worker"`:

```json
{
  "zones": [{
    "id": "dev-worker",
    "gateway": {
      "type": "worker",
      "memory": "2G",
      "cpus": 2,
      "port": 18791,
      "config": "./dev-worker/worker.json",
      "stateDir": "../state/dev-worker",
      "workspaceDir": "../workspaces/dev-worker"
    },
    "secrets": { ... },
    "allowedHosts": ["api.openai.com", "api.github.com", "registry.npmjs.org", "mcp.deepwiki.com"],
    "toolProfile": "standard"
  }]
}
```

For all system.json fields, see
[reference/configuration/system-json.md](../reference/configuration/system-json.md).

### worker.json — Pipeline Behavior

Controls which LLM models to use, how review cycles run, and what verification commands are available. `agent-vm init --type worker ...` writes the built-in prompt defaults as editable markdown files and references them from `worker.json`:

```json
{
  "commonAgentInstructions": { "path": "./prompts/common-agent-instructions.md" },
  "defaults": { "provider": "codex", "model": "latest-medium" },
  "phases": {
    "plan": {
      "cycle": { "kind": "review", "cycleCount": 2 },
      "agentInstructions": { "path": "./prompts/plan-agent.md" },
      "reviewerInstructions": { "path": "./prompts/plan-reviewer.md" }
    },
    "work": {
      "cycle": { "kind": "review", "cycleCount": 4 },
      "agentInstructions": { "path": "./prompts/work-agent.md" },
      "reviewerInstructions": { "path": "./prompts/work-reviewer.md" }
    },
    "wrapup": {
      "instructions": { "path": "./prompts/wrapup.md" }
    }
  },
  "verification": [
    { "name": "test", "command": "npm test" },
    { "name": "lint", "command": "npm run lint" }
  ]
}
```

Prompt paths are zone-level only: they are supported in zone-level `worker.json`,
not in repo-level `.agent-vm/config.json`. Paths are relative to `worker.json`
and must stay under its sibling `prompts/` directory. Missing prompt files,
absolute paths, `../` escapes, and symlink escapes fail fast during config
loading, task pre-start, `agent-vm validate`, and `agent-vm doctor`.

For all worker.json fields, see
[reference/configuration/worker-json.md](../reference/configuration/worker-json.md).

### .agent-vm/config.json — Per-Project Overrides

Checked into your repo root. Same schema as worker.json. Overrides zone defaults for this project:

Use inline strings for project-specific instruction overrides; `{ "path": ... }` prompt references are rejected from project configs.

```json
{
  "verification": [
    { "name": "test", "command": "pnpm vitest run" },
    { "name": "lint", "command": "pnpm oxlint ." }
  ],
  "phases": {
    "plan": { "agentInstructions": "This is a legacy codebase. Take extra care." }
  }
}
```

---

## Submitting a Task

### HTTP API

```bash
curl -X POST http://localhost:18800/zones/dev-worker/worker-tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "requestTaskId": "task-001",
    "prompt": "Add pagination to the /api/users endpoint",
    "repos": [{ "repoUrl": "https://github.com/org/repo", "baseBranch": "main" }]
  }'
```

### What Happens

1. Controller clones your repos in parallel
2. Reads `.agent-vm/config.json` from repo, merges with zone config
3. Resolves repo resources from `.agent-vm/repo-resources.ts`
   when the zone allows repo resources
4. Boots a Gondolin VM, mounts `/workspace` and `/state`
5. Submits task to worker inside VM
6. Worker runs 6-phase pipeline → see [architecture/agent-worker-gateway.md](../architecture/agent-worker-gateway.md)
7. Worker calls controller's push-branches endpoint → controller pushes from host
8. Worker runs `gh pr create` after the push succeeds
9. VM destroyed, selected repo resource providers stopped, workspace cleaned up

For controller-side details, see [subsystems/worker-task-pipeline.md](../subsystems/worker-task-pipeline.md).

---

## Repo Resources

If your project needs a database or other repo-local services, initialize
the typed repo-resource contract:

```bash
agent-vm resources init
agent-vm resources validate
```

This creates `.agent-vm/repo-resources.ts`,
`.agent-vm/repo-resources.d.ts`, `.agent-vm/run-setup.sh`,
and `.agent-vm/docker-compose.yml`. Edit the TypeScript contract to
declare what the repo requires and provides. `agent-vm resources update`
refreshes only generated support files (`repo-resources.d.ts`, `AGENTS.md`,
and `README.md`), not your TypeScript, shell, or Compose files.

The controller resolves logical resource names once per task. If multiple repos
require `pg`, one provider or external resource satisfies that logical `pg`;
`pg` and `pg-blah` remain distinct. Compose services are repo-local and run
under separate project namespaces, so two repos can both define a Compose
service named `pg`.

Repo-resource Compose services must not publish host ports. Use internal
service ports and let the controller inject TCP host mappings into Gondolin.

For full schema and lifecycle details, see
[resource-contracts.md](../reference/configuration/resource-contracts.md).

---

## Monitoring a Task

### Poll status

```bash
curl http://localhost:18800/zones/dev-worker/tasks/{taskId}
```

Returns task status: `pending`, `planning`, `working`, `verifying`, `completed`, `failed`.

### Event log

The full event history is written to `/state/tasks/{taskId}.jsonl` (JSONL format). See [architecture/agent-worker-gateway.md](../architecture/agent-worker-gateway.md#event-sourcing-how-state-works) for event types.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Task stuck in `planning` | LLM timeout or network issue | Check `allowedHosts` includes your LLM provider |
| Tests fail repeatedly | Wrong test command | Override `verification` in `.agent-vm/config.json` |
| PR not created | GitHub token missing | Configure `host.githubToken` in system.json |
| VM boot fails | Image not built | Run `agent-vm build` |
| Repo resources unreachable | Missing or invalid contract | Run `agent-vm resources validate` |
