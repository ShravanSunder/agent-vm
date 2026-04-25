# Prompt Files

Worker prompt defaults can be stored as markdown files next to zone-level
`worker.json`.

Generated Worker projects use this shape:

```
config/gateways/<zone>/
  worker.json
  prompts/
    common-agent-instructions.md
    plan-agent.md
    plan-reviewer.md
    work-agent.md
    work-reviewer.md
    wrapup.md
```

`worker.json` references those files:

```json
{
  "commonAgentInstructions": { "path": "./prompts/common-agent-instructions.md" },
  "phases": {
    "plan": {
      "agentInstructions": { "path": "./prompts/plan-agent.md" },
      "reviewerInstructions": { "path": "./prompts/plan-reviewer.md" }
    }
  }
}
```

## Rules

- Prompt paths are relative to the `worker.json` file that contains them.
- Prompt files must stay under that config's sibling `prompts/` directory.
- Absolute paths are rejected.
- `../` escapes are rejected.
- Symlink escapes are rejected.
- Missing files fail fast during config loading, task pre-start, validate, and
  doctor.
- Repo-level `.agent-vm/config.json` may not use prompt file references.

## Why Files Instead Of JSON Strings

Large prompts are easier to read, review, and edit as markdown files. JSON is
kept as the wiring layer: it says which prompt file a phase uses.

## Resetting Defaults

Use:

```bash
agent-vm config reset-instructions --config config/system.json --zone <zone> --phase all
```

This updates scaffolded prompt defaults while preserving file references for
phases that were not reset.
