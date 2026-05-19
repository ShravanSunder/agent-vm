# @agent-vm/openclaw-mcp-portal-plugin

OpenClaw plugin that registers native MCP Portal tools and wires portal calls
directly into the OpenClaw agent loop.

## What This Package Owns

- Registers native OpenClaw tools for `mcp_portal_list`,
  `mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call`.
- Loads `/core` from the controller-materialized effective config directory.
- Registers `before_tool_call` to deny disallowed portal calls and request
  OpenClaw approval when policy requires it.
- Registers `before_prompt_build` to inject scoped progressive-disclosure hints.

## Runtime Config

The OpenClaw plugin config should only carry the effective config directory:

```json
{
	"configDir": "/home/openclaw/.openclaw/cache/mcp-portal-effective"
}
```

Namespace/tool policy does not live in OpenClaw plugin config. It lives in
`mcp-portal.config.jsonc` inside the configured directory.

## Start Reading

- `src/plugin-registration.ts` for native tool and hook registration.
- `src/before-tool-call-handler.ts` for policy and approval behavior.
- `src/before-prompt-build-handler.ts` for prompt context injection.
