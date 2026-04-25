# Configuration

agent-vm uses a small set of JSON files. Each file has a different owner and
scope.

## Whole Map

```
system.json
  Host/controller config.
  Defines zones, secrets, image profiles, cache, ports, and resource policy.

systemCacheIdentifier.json
  Sibling of system.json.
  Parsed JSON is hashed into every Gondolin image fingerprint.

worker.json
  Zone-level Worker behavior.
  Defines prompts, phases, verification, MCP servers, and skills.

.agent-vm/config.json
  Repo-level Worker overrides.
  Checked into the project repo that the agent edits.

.agent-vm/repo-resources.ts
  Repo-level resource contract.
  Declares TCP resources the repo requires and can provide.
```

## Assembly Flow

```
config/system.json
  |
  | zones[].gateway.config
  v
config/gateways/<zone>/worker.json
  |
  | deep merge with repo override
  v
<repo>/.agent-vm/config.json
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
| `system.json` | platform/operator | host paths, zones, secrets, image profiles, resources change |
| `systemCacheIdentifier.json` | platform/runtime | outer build environment changes |
| `worker.json` | operator/team | default agent behavior changes |
| `.agent-vm/config.json` | project repo | a repo needs different validation, MCP, or prompt overrides |
| `.agent-vm/repo-resources.ts` | project repo | a repo needs TCP resources, mocks, fixtures, or repo-local providers |

## Drill Down

| Need | Read |
| --- | --- |
| Host/controller fields | [system-json.md](system-json.md) |
| Worker phase behavior | [worker-json.md](worker-json.md) |
| Repo-level overrides | [project-config-json.md](project-config-json.md) |
| Repo/external resources | [resource-contracts.md](resource-contracts.md) |
| Image fingerprint input | [system-cache-identifier.md](system-cache-identifier.md) |
| Prompt file references | [prompt-files.md](prompt-files.md) |
| Static vs runtime checks | [../validate-and-doctor.md](../validate-and-doctor.md) |
