# 2026-05-23 OpenClaw 2026.5.20 MCP Portal, Gondolin, And Ingress Debugging

## Status

This note captures the debugging model for the `agent-vm` 0.0.72 to 0.0.73
fix line against OpenClaw 2026.5.20. It is intentionally broader than one bug:
three independent failures showed up together and made each hypothesis test
ambiguous.

Confirmed deployment symptom in `shravan-claw-beta` before the fixes:

- Pulse could see MCP Portal prompt context such as available namespaces.
- Pulse could not call `mcp_portal_list`, `mcp_portal_search`,
  `mcp_portal_describe`, or `mcp_portal_call`.
- Direct non-streaming HTTP debugging sometimes returned `502 bad gateway`.
- VM startup/build diagnostics sometimes pointed at Gondolin helper version
  mismatch or sandbox helper failures.

The fixes are split across dependency pinning, plugin registration behavior,
and ingress timeout/configuration documentation.

## Issue 1: Gondolin Helper Version Mismatch

### Symptom

Build-time or boot-time logs can include:

```text
Cause: sandbox helper gondolinVersion mismatch
expected: 0.12.0
got:      0.9.1
```

Runtime fallout can look like:

```text
mount ... Transport endpoint is not connected
sandboxd: invalid exec_request: EndOfBuffer
vm startup timed out ... waiting for guest readiness
```

### Root Cause

OpenClaw 2026.5.20 expects the Gondolin 0.12.x sandbox helper/runtime behavior.
`agent-vm` 0.0.72 pulled `@earendil-works/gondolin` 0.9.1 through
`@agent-vm/gondolin-adapter`.

This is not a peer-dependency choice for deployments. `agent-vm` owns the
Gondolin adapter and must pin the compatible Gondolin SDK version it builds and
ships against.

### Release-Line Fix

`packages/gondolin-adapter/package.json` pins:

```json
"@earendil-works/gondolin": "0.12.0"
```

The 0.0.73 release line must retain that pin, root lockfile entry, and package
patch entry. Publish all `@agent-vm/*` packages together so the adapter,
controller, plugins, and published package metadata stay in sync.

### Deployment Workaround For 0.0.72

For deployments that cannot upgrade immediately:

```jsonc
{
  "pnpm": {
    "overrides": {
      "@earendil-works/gondolin": "0.12.0"
    }
  }
}
```

Then rebuild with source-built helpers if the published helper binary still
self-identifies as the old version:

```bash
GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1 pnpm build
```

## Issue 2: MCP Portal Plugin Skipped Tool Discovery

### Symptom

The confusing split:

- `openclaw plugins inspect mcp-portal --json` shows `contracts.tools`
  populated with the four MCP Portal tool names.
- Prompt context says MCP Portal namespaces are available.
- The model request's actual tool list does not contain `mcp_portal_*`.

That means the manifest and prompt hook are not enough proof. The ground truth is
the tool array sent to the model for the current turn.

### Root Cause

OpenClaw 2026.5.20 uses `registrationMode: "tool-discovery"` for executable
tool capability discovery. Older plugin code guarded registration as if only
`full` mattered:

```ts
if (api.registrationMode !== undefined && api.registrationMode !== 'full') {
	return;
}
```

That silently skipped the tool-discovery pass. MCP Portal's runtime prompt hook
could still run during full registration, so the system looked partially alive
while the descriptor/tool surface stayed empty.

OpenClaw's plugin registry marks capability handlers available in `full`,
`discovery`, and `tool-discovery`. Plugin authors should register executable
tool descriptors/factories whenever OpenClaw provides `registerTool`; runtime
side effects still belong in `full`.

### Source Fix

`@agent-vm/openclaw-mcp-portal-plugin` now separates native tool registration
from runtime hooks:

- Native portal tools register whenever OpenClaw provides `registerTool`.
- Runtime hooks/services only run during `full`.

The current behavior is covered by
`packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`.

### Other Plugin Impact

Audit command:

```bash
rg -n "registrationMode\\s*!==\\s*['\\\"]full|api\\.registrationMode|registrationMode" packages --glob '*.ts'
```

Current package audit:

- `@agent-vm/openclaw-mcp-portal-plugin`: registers `mcp_portal_*` whenever
  OpenClaw provides `registerTool`; full runtime hooks remain full-only.
- `@agent-vm/openclaw-agent-vm-plugin`: registers `zone_git_push` whenever
  OpenClaw provides `registerTool`, including discovery passes; full sandbox
  backend/status work remains full-only.

Any future plugin with executable tools should follow the same pattern: register
tool descriptors/factories whenever `api.registerTool` is present; defer
long-lived side effects, sockets, workers, and runtime hydration to `full`.

## Issue 3: Gondolin Ingress Timeout During Non-Streaming HTTP Debugging

### Symptom

Direct `POST /v1/chat/completions` debugging can return:

```text
502 bad gateway
```

while the model is still thinking.

### Root Cause

Gondolin ingress has separate timeouts for:

- waiting for upstream response headers
- idle gaps between upstream response body chunks

Slow non-streaming model calls may exceed the body/response idle window because
the model emits no response chunks until the whole answer is ready.

### Source Fix

`zones[].gateway.ingress` now exposes:

- `upstreamHeaderTimeoutMs`
- `upstreamResponseTimeoutMs`

`agent-vm` keeps gateway ingress response buffering disabled so SSE can stream
incrementally. The generated manual now explains that this is a timeout/serving
surface, not a generic open-ports mechanism.

### Workaround

For HTTP debugging, prefer streaming:

```json
{ "stream": true }
```

SSE chunks reset the response-body idle timer when the model emits regularly.

## Serving And Port Model

Keep these layers separate:

```text
host client/browser
  -> zones[].gateway.port              host-facing Gondolin ingress listener
  -> Gondolin route table              path prefix -> guest loopback port
  -> OpenClaw guest gateway port       Control UI, WS, /readyz, /v1/*
```

The current OpenClaw gateway route is:

```text
/ -> processSpec.guestListenPort
```

That one route is enough for the OpenClaw Control UI, OpenAI-compatible APIs,
readiness probes, plugin HTTP routes, SSE, and WebSocket traffic when OpenClaw
is the only guest web server exposed.

Serving additional guest webservers, such as a Vite preview, sidecar dashboard,
or app server, is a separate ingress-route feature. It should use explicit
non-root path prefixes to guest ports and must not shadow OpenClaw's `/` route,
API routes, Control UI assets, or WebSocket endpoint.

Raw TCP services belong in `tcpHosts`, not HTTP ingress.

## Diagnostic Ladder For Next Time

1. Check gateway build/boot logs first.
   If there is a Gondolin helper version mismatch, fix the substrate before
   debugging plugin policy.

2. Confirm what reaches the model.
   The model request tool list is the ground truth. Prompt text and plugin
   manifests are not proof that tools are callable.

3. Split manifest from runtime.
   `contracts.tools` proves the manifest was read. Missing model tools with
   populated `contracts.tools` points at registration mode, descriptor cache,
   policy filtering, or runtime tool construction.

4. Inspect plugin registration modes.
   Temporary instrumentation should log each plugin id and registration mode:
   `full`, `tool-discovery`, `discovery`, `setup-only`, `setup-runtime`, or
   `cli-metadata`.

5. Use streaming for HTTP debug requests unless the test is specifically about
   non-streaming behavior.

## Observability And Doctor Improvements

These are not all required for the 0.0.73 package fix, but they should be fed
to the OTEL/diagnostics lane.

- Surface plugin registry diagnostics in gateway logs at boot. Silent
  diagnostics made missing contracts/registration failures too easy to miss.
- Emit plugin registration spans/logs with plugin id, registration mode,
  registered tool names, registered hook names, and whether capability handlers
  were active.
- Add an operator command or doctor subcheck that prints the effective model
  tool surface for an agent, with provenance: builtin, OpenClaw plugin,
  agent-vm plugin, MCP Portal, or client tool.
- Add a doctor check that compares plugin `contracts.tools` with runtime
  registered tools during OpenClaw capability discovery, when OpenClaw exposes
  enough state to do so safely.
- Log Gondolin SDK/helper versions during gateway image build and gateway boot.
  Version mismatches should fail fast with the expected and actual versions.
- For HTTP ingress diagnostics, log when upstream header or body idle timeouts
  fire and include route prefix, guest port, timeout kind, and elapsed time.

## Validation Checklist Before Publishing

- `pnpm check`
- Targeted plugin tests:
  `pnpm exec vitest run --config vitest.config.ts packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`
- Targeted ingress/config tests:
  `pnpm exec vitest run --config vitest.config.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts packages/agent-vm/src/config/system-config.test.ts`
- Pack and inspect `@agent-vm/agent-vm`; confirm sibling `@agent-vm/*`
  dependencies are the intended synced version.
- Test a deployment against OpenClaw 2026.5.20 and confirm:
  - gateway boots without Gondolin helper mismatch
  - `mcp_portal_list/search/describe/call` reach the model tool surface
  - a real `mcp_portal_call` can call an allowed namespace/tool
  - streaming `/v1/chat/completions` works through gateway ingress
  - non-streaming timeout behavior matches configured
    `zones[].gateway.ingress`
