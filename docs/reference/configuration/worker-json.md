# worker.jsonc

`worker.jsonc` configures `agent-vm-worker` inside the VM. It is zone-level:
operators use it to define defaults for how the agent plans, works, reviews,
validates, and wraps up. The controller injects generated `runtimeInstructions`
at task pre-start; do not author that field by hand in scaffolded config.
Existing `worker.json` files are still accepted.

Comments are allowed in authored worker config. The controller writes the final
`/state/effective-worker.json` as strict JSON before the worker starts.

Source schema:
`packages/agent-vm-worker/src/config/worker-config.ts`

## Sections

```
commonAgentInstructions

defaults
  provider
  model
  reasoningEffort

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
  "commonAgentInstructions": { "path": "./prompts/common-agent-instructions.md" },
  "defaults": {
    "provider": "codex",
    "model": "latest-medium",
    "reasoningEffort": "medium"
  },
  "phases": {
    "plan": {
      "model": "latest-medium",
      "reviewerExecutor": { "provider": "codex", "model": "latest-mini" },
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
| `defaults.reasoningEffort` | unset |
| `phases.plan.cycle` | `{ "kind": "review", "cycleCount": 2 }` |
| `phases.plan.agentTurnTimeoutMs` | `900000` |
| `phases.plan.reviewerTurnTimeoutMs` | `900000` |
| `phases.work.cycle` | `{ "kind": "review", "cycleCount": 4 }` |
| `phases.work.agentTurnTimeoutMs` | `2700000` |
| `phases.work.reviewerTurnTimeoutMs` | `900000` |
| `phases.wrapup.turnTimeoutMs` | `900000` |
| `verificationTimeoutMs` | `300000` |
| `branchPrefix` | `agent/` |
| `stateDir` | `/state` |

## Executor Selection

`defaults.provider` and `defaults.model` choose the executor for every phase
unless a phase overrides them with `provider` or `model`. `reasoningEffort` can
be set at `defaults.reasoningEffort` or per phase:

```json
{
  "defaults": {
    "provider": "codex",
    "model": "gpt-5.4",
    "reasoningEffort": "high"
  },
  "phases": {
    "work": {
      "model": "gpt-5.4-mini",
      "reasoningEffort": "medium"
    }
  }
}
```

Allowed `reasoningEffort` values are `minimal`, `low`, `medium`, `high`, and
`xhigh`. Built-in model aliases such as `latest`, `latest-medium`, and
`latest-mini` carry their own default reasoning effort. For explicit model IDs,
`defaults.reasoningEffort` applies unless the phase sets `reasoningEffort`.

Plan and Work reviewers can use a different executor from the agent by setting
`reviewerExecutor` on the phase:

```json
{
  "phases": {
    "plan": {
      "reviewerExecutor": {
        "provider": "codex",
        "model": "gpt-5.4-mini",
        "reasoningEffort": "low"
      }
    },
    "work": {
      "reviewerExecutor": {
        "provider": "claude",
        "model": "claude-sonnet-4-6",
        "reasoningEffort": "medium"
      }
    }
  }
}
```

`reviewerExecutor` affects only the review thread. The plan/work agent thread
continues to use the phase's top-level executor fields.

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

## Wrapup Outcomes

The wrapup phase returns a structured outcome instead of treating any nullable
PR URL as success:

```json
{
  "outcome": "pr-created",
  "summary": "Opened the PR.",
  "reason": null,
  "prUrl": "https://github.com/org/repo/pull/123",
  "branchName": "agent/task-123",
  "pushedCommits": ["abc123"]
}
```

`outcome` is one of:

| Value | Meaning |
| --- | --- |
| `pr-created` | A GitHub PR was created or found. `prUrl` is required and `reason` is `null`. |
| `no-pr-needed` | The task completed without needing a PR. `prUrl` is `null` and `reason` explains why. |
| `pr-blocked` | PR creation was required but blocked. `prUrl` is `null` and `reason` explains the blocker. |

If the wrapup agent returns unparseable JSON twice, the worker emits a
`wrapup-parse-failed` event and stores a `pr-blocked` wrapup result instead of
trusting a PR URL mentioned only in prose.

## MCP Servers

`mcpServers` exposes extra MCP endpoints to the agent. New worker scaffolds
include DeepWiki by default because it is safe to use without a bearer token:

```json
{
  "mcpServers": [
    { "name": "deepwiki", "url": "https://mcp.deepwiki.com/mcp" },
    {
      "name": "internal-docs",
      "url": "http://docs.local:3100/mcp",
      "bearerTokenEnvVar": "INTERNAL_DOCS_TOKEN"
    }
  ]
}
```

`bearerTokenEnvVar` is optional. When present, it names the VM environment
variable used by the MCP server registration layer; it must not contain a raw
token value.

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

Instruction fields accept inline strings, `null`, or zone-level prompt file
references. See [prompt-files.md](prompt-files.md) for the path rules.

## Instruction Layers

Worker prompts are compiled in this order:

1. `runtimeInstructions` generated by the controller for the current task.
2. Built-in platform instructions compiled into `agent-vm-worker`.
3. `commonAgentInstructions` from zone or repo config.
4. Role instructions from the active phase.
5. Skill content.

Operators configure `commonAgentInstructions`. The controller injects
`runtimeInstructions` after cloning repos and resolving resources, then writes
the final `/state/effective-worker.json`. Do not author
`runtimeInstructions` by hand in scaffolded config.

Agent-facing runtime files:

```text
runtimeInstructions                    generated by controller
DEFAULT_BUILTIN_AGENT_INSTRUCTIONS     compiled into agent-vm-worker
commonAgentInstructions                common-agent-instructions.md or inline text
roleInstructions                       phase-specific worker config
skillContent                           resolved skill refs

/work/repos/AGENTS.md                generated pointer to /agent-vm/agents.md
/work/repos/CLAUDE.md                symlink to /work/repos/AGENTS.md
/agent-vm/agents.md                    generated runtime index
/agent-vm/CLAUDE.md                    symlink to /agent-vm/agents.md
/agent-vm/runtime-instructions.md      generated runtime facts
/agent-vm/resources/<repoId>/          generated repo-resource output mount
/state/effective-worker.json           worker plumbing
```
