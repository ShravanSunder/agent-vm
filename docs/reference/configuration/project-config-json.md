# .agent-vm/config.jsonc

`.agent-vm/config.jsonc` is a repo-level Worker override. It lives in the
repository that the agent edits, not in the controller project config.
Existing `.agent-vm/config.json` files are still accepted.

The controller reads it after cloning the repo, deep-merges it over the
zone-level `worker.jsonc`, applies Zod defaults, and writes the normalized
`effective-worker.json` into `/state` before the VM boots.

## Merge Rules

| Shape | Rule |
| --- | --- |
| Objects | Merge recursively. Project values win at the leaf. |
| Arrays | Replace entirely. No concatenation. |
| Scalars | Project value replaces zone value. |

Missing `.agent-vm/config.jsonc` and `.agent-vm/config.json` is valid. The
zone-level `worker.jsonc` remains the base config.

## Common Overrides

Project-specific validation:

```json
{
  "verification": [
    { "name": "test", "command": "pnpm vitest run" },
    { "name": "lint", "command": "pnpm lint" },
    { "name": "typecheck", "command": "pnpm typecheck" }
  ]
}
```

Project-specific planning guidance:

```json
{
  "phases": {
    "plan": {
      "agentInstructions": "This repository has legacy migrations. Read docs/db.md before planning."
    }
  }
}
```

Project-specific MCP servers:

```json
{
  "mcpServers": [
    {
      "name": "project-docs",
      "url": "http://localhost:3100/mcp",
      "bearerTokenEnvVar": "PROJECT_DOCS_TOKEN"
    }
  ]
}
```

## Prompt References Are Not Allowed Here

Repo-level configs may use inline strings or `null` for instructions. They may
not use `{ "path": "./prompts/..." }` prompt file references.

Prompt file references are zone-level only because they resolve relative to
the zone-level `worker.jsonc` and must stay under that config's sibling
`prompts/` directory.
