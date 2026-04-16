# Worker Mode Guide

[Overview](../README.md) > Getting Started > Worker Mode

How to configure and run agent-vm in Worker mode — autonomous coding that produces pull requests.

---

## What Worker Mode Does

You submit a coding task. The controller clones your repo, boots a VM, runs a 6-phase pipeline (plan → review → code → verify → review → wrapup), and opens a PR. The VM is destroyed when done.

For the full pipeline internals, see [architecture/worker-pipeline.md](../architecture/worker-pipeline.md).

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
      "gatewayConfig": "./dev-worker/worker.json",
      "stateDir": "../state/dev-worker",
      "workspaceDir": "../workspaces/dev-worker"
    },
    "secrets": { ... },
    "allowedHosts": ["api.openai.com", "api.github.com", "registry.npmjs.org"],
    "toolProfile": "standard"
  }]
}
```

For all system.json fields, see [reference/configuration-reference.md](../reference/configuration-reference.md#systemjson).

### worker.json — Pipeline Behavior

Controls which LLM models to use, how many retries, what verification commands to run. `agent-vm init --gateway-type worker` writes the built-in instruction defaults explicitly so you can edit them in place:

```json
{
  "instructions": "## Git Rules\n- You may commit at any time using git add and git commit.\n...\n## Wrapup\n- When work is complete and verified, call the git-pr tool to stage, commit, and request controller-side push and PR creation.\n- The git-pr tool handles the controller handoff - you only need to provide the title and description.",
  "defaults": { "provider": "codex", "model": "latest-medium" },
  "phases": {
    "plan": {
      "instructions": "Create an implementation plan for the task. Do not write code yet.",
      "maxReviewLoops": 2
    },
    "planReview": {
      "instructions": "Review the plan for completeness, correctness, risks, and missing edge cases."
    },
    "work": {
      "instructions": "Implement the approved plan.",
      "maxReviewLoops": 3,
      "maxVerificationRetries": 3
    },
    "workReview": {
      "instructions": "Review the code changes for correctness, bugs, style, and test coverage."
    },
    "wrapup": {
      "instructions": "Complete the task by running the configured wrapup actions. ..."
    }
  },
  "verification": [
    { "name": "test", "command": "npm test" },
    { "name": "lint", "command": "npm run lint" }
  ],
  "wrapupActions": [{ "type": "git-pr", "required": true }]
}
```

For all worker.json fields, see [reference/configuration-reference.md](../reference/configuration-reference.md#workerjson).

### .agent-vm/config.json — Per-Project Overrides

Checked into your repo root. Same schema as worker.json. Overrides zone defaults for this project:

```json
{
  "verification": [
    { "name": "test", "command": "pnpm vitest run" },
    { "name": "lint", "command": "pnpm oxlint ." }
  ],
  "phases": {
    "plan": { "instructions": "This is a legacy codebase. Take extra care." }
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
    "prompt": "Add pagination to the /api/users endpoint",
    "repos": [{ "repoUrl": "https://github.com/org/repo", "baseBranch": "main" }]
  }'
```

### What Happens

1. Controller clones your repos (shallow, single-branch)
2. Reads `.agent-vm/config.json` from repo, merges with zone config
3. Starts Docker services if `.agent-vm/docker-compose.yml` exists
4. Boots a Gondolin VM, mounts `/workspace` and `/state`
5. Submits task to worker inside VM
6. Worker runs 6-phase pipeline → see [architecture/worker-pipeline.md](../architecture/worker-pipeline.md)
7. Worker calls controller's push-branches endpoint → controller pushes from host
8. VM destroyed, Docker services stopped, workspace cleaned up

For controller-side details, see [subsystems/worker-task-pipeline.md](../subsystems/worker-task-pipeline.md).

---

## Docker Services

If your project needs a database or other services, create `.agent-vm/docker-compose.yml` in your repo:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
    ports: ["5432:5432"]
```

The controller starts the stack before booting the VM. Inside the VM, the agent connects via `postgres.local:5432` (Gondolin synthetic DNS). See [architecture/overview.md](../architecture/overview.md#how-components-interact) for the networking path.

---

## Monitoring a Task

### Poll status

```bash
curl http://localhost:18800/zones/dev-worker/worker-tasks/{taskId}
```

Returns task status: `pending`, `planning`, `working`, `verifying`, `completed`, `failed`.

### Event log

The full event history is written to `/state/tasks/{taskId}.jsonl` (JSONL format). See [architecture/worker-pipeline.md](../architecture/worker-pipeline.md#event-sourcing-how-state-works) for event types.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Task stuck in `planning` | LLM timeout or network issue | Check `allowedHosts` includes your LLM provider |
| Tests fail repeatedly | Wrong test command | Override `verification` in `.agent-vm/config.json` |
| PR not created | GitHub token missing | Configure `host.githubToken` in system.json |
| VM boot fails | Image not built | Run `agent-vm build` |
| Docker services unreachable | Missing compose file | Add `.agent-vm/docker-compose.yml` to repo |
