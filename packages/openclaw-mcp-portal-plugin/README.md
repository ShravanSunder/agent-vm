# @agent-vm/openclaw-mcp-portal-plugin

OpenClaw plugin that supervises the MCP Portal subprocess and wires portal calls
into the OpenClaw agent loop.

## What This Package Owns

- Starts and stops the `agent-vm-mcp-portal-server` subprocess through
  OpenClaw `registerService`.
- Generates per-agent HMAC keys for each plugin boot and passes them to the
  portal subprocess as environment variables.
- Registers `before_tool_call` to deny disallowed portal calls and attach
  approval tokens to approved calls.
- Registers `before_prompt_build` to inject scoped progressive-disclosure hints.

## Runtime Config

The OpenClaw plugin config should only carry runtime process settings:

```json
{
	"configDir": "/home/openclaw/.openclaw/config",
	"binPath": "/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server"
}
```

Namespace/tool policy does not live in OpenClaw plugin config. It lives in
`mcp-portal.config.jsonc` inside the configured directory.

## Start Reading

- `src/plugin-registration.ts` for OpenClaw service and hook registration.
- `src/portal-subprocess-supervisor.ts` for process lifecycle.
- `src/before-tool-call-handler.ts` for policy and approval-token behavior.
- `src/before-prompt-build-handler.ts` for prompt context injection.
