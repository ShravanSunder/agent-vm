# Configuration

agent-vm uses a small set of config files. Human-authored agent-vm configs may
be JSONC (`.jsonc`) so operators can leave short comments beside load-bearing
settings. Runtime, effective, API, backup, and event-log files stay strict JSON
or JSONL.

## Whole Map

```
system.jsonc / system.json
  Host/controller config.
  Defines zones, secrets, image profiles, cache, ports, and resource policy.

worker.jsonc / worker.json
  Zone-level Worker behavior.
  Defines prompts, phases, verification, MCP servers, and skills.

.agent-vm/config.jsonc / .agent-vm/config.json
  Repo-level Worker overrides.
  Checked into the project repo that the agent edits.

.agent-vm/repo-resources.ts
  Repo-level resource contract.
  Declares TCP resources the repo requires and can provide.
```

## Assembly Flow

```
config/system.jsonc
  |
  | zones[].gateway.config
  v
config/gateways/<zone>/worker.jsonc
  |
  | deep merge with repo override
  v
<repo>/.agent-vm/config.jsonc
  |
  | Zod defaults fill missing fields
  v
/state/effective-worker.json

<repo>/.agent-vm/repo-resources.ts
  |
  | resolve once per logical resource name
  v
Gondolin tcpHosts + env + /agent-vm/resources/<repoId>
```

The controller writes `effective-worker.json` before booting the Worker VM.
Prompt file references are resolved before the worker starts.

## Ownership

| File | Owner | Changes when |
| --- | --- | --- |
| `system.jsonc` / `system.json` | platform/operator | host paths, zones, secrets, image profiles, resources change |
| `worker.jsonc` / `worker.json` | operator/team | default agent behavior changes |
| `.agent-vm/config.jsonc` / `.agent-vm/config.json` | project repo | a repo needs different validation, MCP, or prompt overrides |
| `.agent-vm/repo-resources.ts` | project repo | a repo needs TCP resources, mocks, fixtures, or repo-local providers |

## Drill Down

| Need | Read |
| --- | --- |
| Host/controller fields | [system-json.md](system-json.md) |
| Worker phase behavior | [worker-json.md](worker-json.md) |
| Repo-level overrides | [project-config-json.md](project-config-json.md) |
| Repo/external resources | [resource-contracts.md](resource-contracts.md) |
| Prompt file references | [prompt-files.md](prompt-files.md) |
| Static vs runtime checks | [../validate-and-doctor.md](../validate-and-doctor.md) |
