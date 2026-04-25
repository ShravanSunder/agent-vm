# worker.json

`worker.json` configures `agent-vm-worker` inside the VM. It is zone-level:
catalog owners use it to define team defaults for how the agent plans, works,
reviews, validates, and wraps up.

Source schema:
`packages/agent-vm-worker/src/config/worker-config.ts`

## Sections

```
instructions

defaults
  provider
  model

phases
  plan
  work
  wrapup

mcpServers
skills
verification
verificationTimeoutMs
branchPrefix
stateDir
```

## Minimal Shape

```json
{
  "instructions": { "path": "./prompts/base.md" },
  "defaults": {
    "provider": "codex",
    "model": "latest-medium"
  },
  "phases": {
    "plan": {
      "cycle": { "kind": "review", "cycleCount": 1 },
      "agentInstructions": { "path": "./prompts/plan-agent.md" },
      "reviewerInstructions": { "path": "./prompts/plan-reviewer.md" }
    },
    "work": {
      "cycle": { "kind": "review", "cycleCount": 2 },
      "agentInstructions": { "path": "./prompts/work-agent.md" },
      "reviewerInstructions": { "path": "./prompts/work-reviewer.md" }
    },
    "wrapup": {
      "instructions": { "path": "./prompts/wrapup.md" }
    }
  }
}
```

`agent-vm init --type worker` writes explicit defaults for phase timeouts,
`mcpServers`, `verification`, `verificationTimeoutMs`, `branchPrefix`, and
`stateDir` so operators can see and tune them.

## Phase Defaults

| Field | Default |
| --- | --- |
| `defaults.provider` | `codex` |
| `defaults.model` | `latest-medium` |
| `phases.plan.agentTurnTimeoutMs` | `900000` |
| `phases.plan.reviewerTurnTimeoutMs` | `900000` |
| `phases.work.agentTurnTimeoutMs` | `2700000` |
| `phases.work.reviewerTurnTimeoutMs` | `900000` |
| `phases.wrapup.turnTimeoutMs` | `900000` |
| `verificationTimeoutMs` | `300000` |
| `branchPrefix` | `agent/` |
| `stateDir` | `/state` |

## Validation Commands

`verification` is the command list exposed through the worker's
`run_validation` tool:

```json
{
  "verification": [
    { "name": "test", "command": "pnpm test:unit" },
    { "name": "typecheck", "command": "pnpm typecheck" }
  ]
}
```

During Work review, the reviewer is instructed to call `run_validation` and
return the command results. The worker records raw command logs under its state
directory.

## MCP Servers

`mcpServers` exposes extra MCP endpoints to the agent:

```json
{
  "mcpServers": [
    { "name": "internal-docs", "url": "http://docs.local:3100/mcp" }
  ]
}
```

## Skills

Phase skills are optional references made available to a phase:

```json
{
  "phases": {
    "work": {
      "skills": [{ "name": "repo-guide", "path": "/state/skills/repo-guide/SKILL.md" }]
    }
  }
}
```

## Prompt Fields

Instruction fields accept inline strings, `null`, or catalog prompt file
references. See [prompt-files.md](prompt-files.md) for the path rules.
