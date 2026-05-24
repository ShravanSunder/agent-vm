# MCP Portal Error DX And Live Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP Portal configuration easier to author, make upstream MCP failures actionable, keep local stdio MCP servers reliable in Gondolin, and surface the same structured diagnostics through OpenClaw plugin tools and the direct MCP proxy mode.

**Architecture:** Keep MCP Portal core as the single truth for catalog discovery, upstream calls, diagnostics, and result shaping. Fix stdio provider process startup first by preserving the narrow Node/npm gateway runtime environment proven necessary for `npx` MCP launchers. Add progressive-disclosure hints to list/search/describe results so agents know when to describe before calling, then add a typed upstream failure contract at the MCP runtime boundary, carry it through `PortalSession` discovery failures and `PortalCoreResult.auditEvents`, and let both OpenClaw native plugin tools and direct MCP proxy tools reuse that same core result. Hard-cut authored MCP Portal profiles to a per-namespace shape so visibility and approval policy live together, then add live validation that starts configured upstream MCP providers and compares actual tool names against profile policy.

**Tech Stack:** TypeScript, Zod, Vitest, `@modelcontextprotocol/sdk`, `cmd-ts`, `pnpm`, Oxfmt/Oxlint.

---

## File Structure

### Research Notes

Live beta debugging on 2026-05-23 proved the stdio failure is not that `npx` is absent and not that the MCP SDK protocol cannot speak stdio.

- Gateway VM has `node`, `npm`, and `npx`; `npx -y -p @perplexity-ai/mcp-server sh -c 'command -v perplexity-mcp'` resolves the binary.
- A tiny hand-written stdio MCP server works through `mcp-portal` for `tools/list` and `tools/call`.
- Real `npx` MCP servers fail through MCP Portal with `MCP stdio connect for namespace "perplexity" timed out after 30000ms`.
- Raw `npx -y -p @perplexity-ai/mcp-server perplexity-mcp` responds to MCP `initialize` when launched with the full gateway environment.
- The same raw command hangs when launched with the MCP SDK Unix default env shape: `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`, plus provider secrets.
- Adding back only `NODE_EXTRA_CA_CERTS` and `NODE_OPTIONS` makes the Perplexity npx server respond immediately.

Design consequence: MCP Portal must own a narrow stdio runtime env allowlist. Do not inherit the whole gateway environment. This PR only preserves the Node/Gondolin runtime env that is proven necessary for `npx` MCPs. Python/`uv` launcher support is a follow-up and should prefer remote MCPs unless a concrete local `uv run` provider is required.

Out of scope for this PR:

- Installing `uv` or `uvx` in the managed OpenClaw gateway image.
- Preserving Python/`uv` runtime env such as `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, or `UV_CACHE_DIR`.
- Adding a model-callable MCP Portal health or smoke tool. Live validation belongs in `agent-vm validate --mcp-live`.

Configuration boundary:

- `config/system.jsonc` wires the agent-vm controller, gateway VM, secrets, egress, and `zones[].mcpPortal.configDir`.
- `config/gateways/<zone>/openclaw.json` wires OpenClaw agents, sandbox tool policy, plugins, Discord, sessions, and runtime behavior.
- `config/gateways/<zone>/mcp.config.jsonc` defines upstream MCP providers, transports, and provider credentials.
- `config/gateways/<zone>/mcp-portal.config.jsonc` defines which upstream MCP namespaces/tools an agent may see and call, plus approval policy.

The config UX change is only for `mcp-portal.config.jsonc`. The runtime should still compile the authored per-namespace shape into the existing internal `ResolvedMcpPortalProfile` so OpenClaw plugin registration and MCP Portal core access policy do not need a second mental model.

### New Files

- `packages/mcp-portal/src/upstream-mcp-errors.ts`
  - Owns structured, redacted upstream MCP failure types.
  - Converts unknown thrown values into a stable diagnostic object.
  - Contains hint generation for common failures such as timeout, wrong `npx` bin, remote auth failure, and unknown namespace.

- `packages/agent-vm/src/operations/mcp-portal-live-validation.ts`
  - Owns live MCP provider discovery for `agent-vm validate --mcp-live`.
  - Resolves effective MCP Portal config with real secrets, starts each provider, calls `tools/list`, and compares actual tool names to profile selectors.
  - Returns `ConfigValidationCheck[]`; it does not print directly.

### Modified Files

- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
  - Preserves a narrow allowlist of gateway runtime env vars for stdio MCP child processes.
  - Keeps provider secrets in `transport.env`; keeps runtime env inheritance separate from provider auth.
  - Wraps connect, `listTools`, and `callTool` failures in structured upstream errors.
  - Includes namespace, phase, transport summary, timeout, elapsed time, and redacted cause message.

- `packages/mcp-portal/src/index.ts`
  - Exports structured upstream error helpers.
  - Does not re-export provider runtime helpers; agent-vm live validation should import those from `@agent-vm/mcp-portal/core`.

- `packages/mcp-portal/src/portal-session.ts`
  - Extends `PortalDiscoveryFailure` beyond plain `{ namespace, message }`.
  - Converts rejected `runtime.listTools` calls into structured discovery failures.

- `packages/mcp-portal/src/core/portal-tools.ts`
	- Extends `PortalBatchDiagnostic` with optional structured fields.
	- Preserves structured discovery diagnostics in list/search/describe/call responses.
	- Preserves structured upstream call failures in per-item errors.
	- Adds `schemaHint` to list/search/describe result items so agents know when a full schema is required before calling.

- `packages/mcp-portal/src/core/portal-core.ts`
	- Makes only `mcp_portal_list` advertise configured namespace names in its tool description and input-schema property descriptions.
	- Avoids repeating the same namespace list across every MCP Portal wrapper tool.
	- Carries structured diagnostic fields into `PortalAuditEvent`.
	- Emits one final core result shape that both plugin and MCP proxy mode can render.

- `packages/mcp-portal/src/mcp-proxy/portal-mcp-server.ts`
  - Keeps direct/non-plugin MCP proxy responses as JSON, with structured diagnostics in the payload.
  - Marks truly failed portal tool results as `isError: true`; degraded discovery remains a successful response with explicit diagnostics.

- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
  - Keeps returning `{ content, details }`, but logs and forwards structured diagnostic/progress events when core emits them.

- `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.ts`
  - Updates prompt diagnostics wording so agents see namespace, phase, and hint when discovery is degraded.

- `packages/config-contracts/src/mcp-portal-config.ts`
  - Hard-cut authored profile shape from split global fields to per-namespace policy.
  - Keeps `ResolvedMcpPortalProfile` as the internal compiled shape used by existing core code.

- `packages/agent-vm/src/operations/config-validation.ts`
  - Adds `mcpLive` option plumbing and composes static checks with live MCP checks.

- `packages/agent-vm/src/cli/commands/validate-definition.ts`
  - Adds `--mcp-live` flag.

- `packages/agent-vm/src/cli/init-command.ts`
  - Updates generated MCP Portal config to the new per-namespace profile shape.

- `packages/agent-vm/src/cli/manual-templates.ts`
  - Documents the new config shape, `validate --mcp-live`, and how to read runtime diagnostics.

- `docs/subsystems/mcp-portal.md`
  - Documents authored profile shape, live validation, structured diagnostics, and the plugin/proxy surface contract.

### Modified Tests

- `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`
- `packages/mcp-portal/src/portal-session.test.ts`
- `packages/mcp-portal/src/core/portal-tools.test.ts`
- `packages/mcp-portal/src/core/portal-core.test.ts`
- `packages/mcp-portal/src/mcp-proxy/portal-mcp-server.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.test.ts`
- `packages/config-contracts/src/mcp-portal-config.test.ts`
- `packages/agent-vm/src/operations/config-validation.test.ts`
- `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`
- `packages/agent-vm/src/cli/init-command.test.ts`
- `packages/agent-vm/src/cli/manual-templates.test.ts`
- `packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts`

The existing integration test file uses "smoke" in its filename. This plan does not add a model-callable `mcp_portal_smoke` or status-matrix tool.

---

## Task 1: Preserve Gateway Runtime Env For Stdio MCP Providers

**Files:**
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`
- Modify: `docs/subsystems/mcp-portal.md`

- [ ] **Step 1: Write the failing npx runtime-env test**

Add this import change in `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
```

Add this environment reset block inside `describe('upstream MCP client runtime', () => {` before the first test:

```ts
	afterEach(() => {
		vi.unstubAllEnvs();
	});
```

Add this test after `pages listTools until nextCursor is absent`:

```ts
	it('preserves gateway Node runtime env for stdio MCP servers', async () => {
		vi.stubEnv('NODE_EXTRA_CA_CERTS', '/run/gondolin/ca-certificates.crt');
		vi.stubEnv('NODE_OPTIONS', '--dns-result-order=ipv4first');
		const createTransport = vi.fn(() => ({}));
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport,
			servers: [
				{
					args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
					command: 'npx',
					env: { PERPLEXITY_API_KEY: 'secret-token-value' },
					namespace: 'perplexity',
					transport: 'stdio',
				},
			],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'perplexity' }),
		).resolves.toEqual([]);

		expect(createTransport).toHaveBeenCalledWith(
			{
				args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
				command: 'npx',
				env: {
					NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
					NODE_OPTIONS: '--dns-result-order=ipv4first',
					PERPLEXITY_API_KEY: 'secret-token-value',
				},
				namespace: 'perplexity',
				transport: 'stdio',
			},
			'stdio',
		);
	});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
```

Expected: FAIL because stdio transport creation receives only provider `env`, not inherited runtime env.

- [ ] **Step 3: Add stdio runtime env inheritance**

In `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`, add these constants after `defaultMaxResponseBytes`:

```ts
const inheritedStdioRuntimeEnvNames = [
	'NODE_EXTRA_CA_CERTS',
	'NODE_OPTIONS',
] as const;
```

Add these helpers after `createSdkClient()`:

```ts
function inheritedStdioRuntimeEnv(): Readonly<Record<string, string>> {
	const inheritedEnv: Record<string, string> = {};
	for (const name of inheritedStdioRuntimeEnvNames) {
		const value = process.env[name];
		if (value !== undefined && value.length > 0) {
			inheritedEnv[name] = value;
		}
	}
	return inheritedEnv;
}

function withStdioRuntimeEnv(server: NormalizedUpstreamMcpServer): NormalizedUpstreamMcpServer {
	if (server.transport !== 'stdio') {
		return server;
	}

	return {
		...server,
		env: { ...inheritedStdioRuntimeEnv(), ...server.env },
	};
}
```

In `createConnectedClient`, replace the transport server selection with:

```ts
			const transportServer =
				transportKind === 'sse' && server.transport !== 'stdio'
					? withRemoteHeaders(server)
					: withStdioRuntimeEnv(server);
```

Do not inherit the whole process environment. Provider-specific secrets must remain explicit in `transport.env` and continue to be redacted through `redactionValuesFromServer`.

- [ ] **Step 4: Document stdio runtime env behavior**

In `docs/subsystems/mcp-portal.md`, add a subsection under the stdio provider section:

```md
### Stdio runtime environment

MCP Portal starts stdio providers with explicit provider secrets plus a narrow
gateway runtime environment allowlist. This avoids leaking arbitrary gateway
environment variables while preserving runtime settings required by package
launchers inside Gondolin.

Inherited runtime variables:

- `NODE_EXTRA_CA_CERTS`
- `NODE_OPTIONS`

Use `transport.env` for provider credentials such as `PERPLEXITY_API_KEY` or
`TAVILY_API_KEY`. Do not rely on whole-process environment inheritance.

Python/`uv` launchers are intentionally out of scope for this PR. Prefer remote
MCP providers unless a concrete local `uv run` provider is required, then add a
separate managed-image and stdio-env change with live evidence.
```

- [ ] **Step 5: Run targeted verification**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
mise run lint
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-portal/src/upstream-mcp-client-runtime.ts \
	packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts \
	docs/subsystems/mcp-portal.md
git commit -m "fix: preserve stdio mcp runtime environment"
```

## Task 2: Add Structured Upstream MCP Error Contract

**Files:**
- Create: `packages/mcp-portal/src/upstream-mcp-errors.ts`
- Modify: `packages/mcp-portal/src/index.ts`
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`

- [ ] **Step 1: Write failing tests for structured errors**

Add these tests to `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts` inside `describe('upstream MCP client runtime', () => { ... })`.

```ts
it('wraps listTools timeout with structured upstream diagnostics', async () => {
	const neverListingClient: UpstreamMcpClientLike = {
		callTool: vi.fn(),
		close: vi.fn(),
		connect: vi.fn(),
		listTools: vi.fn(async () => await new Promise(() => undefined)),
	};
	const runtime = createUpstreamMcpClientRuntime({
		createClient: () => neverListingClient,
		createTransport: vi.fn(() => ({})),
		servers: [
			createServer({
				connectionTimeoutMs: 5,
				headers: { Authorization: 'secret-token-value' },
			}),
		],
	});

	await expect(
		runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
	).rejects.toMatchObject({
		details: {
			causeMessage: expect.stringContaining('MCP listTools timed out after 5ms'),
			kind: 'upstream_mcp_failed',
			namespace: 'linear',
			phase: 'list_tools',
			timeoutMs: 5,
			transport: { kind: 'streamable-http', url: 'https://mcp.example.test' },
		},
	});
	await expect(
		runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
	).rejects.not.toThrow(/secret-token-value/u);
});

it('wraps stdio connect failures with command and args diagnostics', async () => {
	const runtime = createUpstreamMcpClientRuntime({
		createClient: () => ({
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(async () => {
				throw new Error('spawn ENOENT');
			}),
			listTools: vi.fn(),
		}),
		createTransport: vi.fn(() => ({})),
		servers: [
			{
				args: ['-y', '-p', '@perplexity-ai/mcp-server', 'wrong-bin'],
				command: 'npx',
				env: { PERPLEXITY_API_KEY: 'secret-token-value' },
				namespace: 'perplexity',
				transport: 'stdio',
			},
		],
	});

	await expect(
		runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'perplexity' }),
	).rejects.toMatchObject({
		details: {
			causeMessage: 'spawn ENOENT',
			hint: expect.stringContaining('stdio MCP command failed before tool discovery'),
			kind: 'upstream_mcp_failed',
			namespace: 'perplexity',
			phase: 'connect',
			transport: {
				args: ['-y', '-p', '@perplexity-ai/mcp-server', 'wrong-bin'],
				command: 'npx',
				kind: 'stdio',
			},
		},
	});
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/upstream-mcp-client-runtime.test.ts
```

Expected: FAIL because thrown errors do not yet have a `details` property.

- [ ] **Step 3: Create structured error module**

Create `packages/mcp-portal/src/upstream-mcp-errors.ts` with:

```ts
import type { NormalizedUpstreamMcpServer, UpstreamMcpTransportKind } from './upstream-mcp-client-runtime.js';

export type UpstreamMcpFailurePhase = 'call_tool' | 'connect' | 'list_tools';

export type UpstreamMcpTransportSummary =
	| {
			readonly argCount: number;
			readonly command: string;
			readonly cwd?: string;
			readonly kind: 'stdio';
	  }
	| {
			readonly kind: Exclude<UpstreamMcpTransportKind, 'auto-http' | 'stdio'>;
			readonly url: string;
	  };

export interface UpstreamMcpFailureDetails {
	readonly attemptTransport?: Exclude<UpstreamMcpTransportKind, 'auto-http'>;
	readonly causeMessage: string;
	readonly elapsedMs: number;
	readonly hint?: string;
	readonly kind: 'upstream_mcp_failed';
	readonly namespace: string;
	readonly operation: string;
	readonly phase: UpstreamMcpFailurePhase;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport: UpstreamMcpTransportSummary;
}

export class UpstreamMcpError extends Error {
	readonly details: UpstreamMcpFailureDetails;

	constructor(details: UpstreamMcpFailureDetails) {
		super(formatUpstreamMcpFailureMessage(details));
		this.name = 'UpstreamMcpError';
		this.details = details;
	}
}

export function messageFromUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	return String(error);
}

export function isUpstreamMcpError(error: unknown): error is UpstreamMcpError {
	return error instanceof UpstreamMcpError;
}

export function transportSummaryFromServer(
	server: NormalizedUpstreamMcpServer,
	attemptTransport?: Exclude<UpstreamMcpTransportKind, 'auto-http'>,
): UpstreamMcpTransportSummary {
	if (server.transport === 'stdio') {
		return {
			argCount: server.args?.length ?? 0,
			command: server.command,
			...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
			kind: 'stdio',
		};
	}
	return {
		kind: attemptTransport === 'sse' ? 'sse' : 'streamable-http',
		url: server.url,
	};
}

function hintForFailure(details: Omit<UpstreamMcpFailureDetails, 'hint' | 'kind'>): string | undefined {
	if (details.phase === 'connect' && details.transport.kind === 'stdio') {
		return 'stdio MCP command failed before tool discovery; verify command, args, package bin name, and gateway PATH.';
	}
	if (details.phase === 'connect' && details.transport.kind !== 'stdio') {
		return 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.';
	}
	if (details.phase === 'list_tools') {
		return 'MCP provider connected but tool discovery failed; run agent-vm validate --mcp-live for the configured namespace.';
	}
	if (details.phase === 'call_tool') {
		return 'MCP provider accepted discovery but the tool call failed; inspect the tool arguments and upstream provider response.';
	}
	return undefined;
}

export function createUpstreamMcpError(
	details: Omit<UpstreamMcpFailureDetails, 'hint' | 'kind'>,
): UpstreamMcpError {
	return new UpstreamMcpError({
		...details,
		...(hintForFailure(details) !== undefined ? { hint: hintForFailure(details) } : {}),
		kind: 'upstream_mcp_failed',
	});
}

export function upstreamMcpFailureDetailsFromUnknown(
	error: unknown,
): UpstreamMcpFailureDetails | null {
	return isUpstreamMcpError(error) ? error.details : null;
}

export function formatUpstreamMcpFailureMessage(details: UpstreamMcpFailureDetails): string {
	const toolSuffix = details.toolName === undefined ? '' : ` ${details.toolName}`;
	return `${details.namespace}: ${details.phase}${toolSuffix} failed: ${details.causeMessage}`;
}
```

- [ ] **Step 4: Run tests and verify new module compiles only after runtime is wired**

Export the new module from `packages/mcp-portal/src/index.ts`:

```ts
export * from './upstream-mcp-errors.js';
```

Run:

```bash
pnpm --filter @agent-vm/mcp-portal typecheck
```

Expected: FAIL because the runtime does not yet construct `UpstreamMcpError` at connect/list/call failure boundaries. `NormalizedUpstreamMcpServer` and `UpstreamMcpTransportKind` are already exported by `upstream-mcp-client-runtime.ts`; do not add duplicate type exports.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/mcp-portal/src/upstream-mcp-errors.ts packages/mcp-portal/src/index.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
git commit -m "test: specify structured MCP upstream failures"
```

---

## Task 3: Wrap Runtime Connect, Discovery, And Call Failures

**Files:**
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
- Test: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`

- [ ] **Step 1: Export runtime server types and import error helpers**

In `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`, keep `NormalizedUpstreamMcpServer` and `UpstreamMcpTransportKind` exported and add:

```ts
import {
	createUpstreamMcpError,
	messageFromUnknownError,
	transportSummaryFromServer,
} from './upstream-mcp-errors.js';
```

- [ ] **Step 2: Add elapsed-time helper**

Add near `timeoutMsForServer`:

```ts
function elapsedMsSince(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}
```

- [ ] **Step 3: Wrap connect attempt failures**

Inside `createConnectedClient`, in `tryAttempt`, replace the current catch body with this shape:

```ts
			} catch (error) {
				const redactedError = redactThrownError(error, { exactValues: redactionValues });
				await closeClientAfterFailureOnce(client);
				const structuredError = createUpstreamMcpError({
					attemptTransport: transportKind,
					causeMessage: messageFromUnknownError(redactedError),
					elapsedMs: elapsedMsSince(startedAt),
					namespace: server.namespace,
					operation: `MCP ${transportKind} connect for namespace "${server.namespace}"`,
					phase: 'connect',
					timeoutMs: timeoutMsForServer(server),
					transport: transportSummaryFromServer(server, transportKind),
				});
				return tryAttempt(attemptIndex + 1, structuredError);
```

Add `const startedAt = Date.now();` immediately before `await withTimeout(...)`.

- [ ] **Step 4: Wrap listTools failures**

In the `listTools` catch block, replace the thrown error with:

```ts
				const redactedError = redactThrownError(error, { exactValues: redactionValues });
				const server = serversByNamespace.get(call.namespace);
				if (server !== undefined) {
					throw createUpstreamMcpError({
						causeMessage: messageFromUnknownError(redactedError),
						elapsedMs: elapsedMsSince(startedAt),
						namespace: call.namespace,
						operation: 'MCP listTools',
						phase: 'list_tools',
						timeoutMs: timeoutMsForServer(server),
						transport: transportSummaryFromServer(server),
					});
				}
				throw redactedError;
```

Add `const startedAt = Date.now();` before `client = await getClient(...)`.

- [ ] **Step 5: Wrap callTool failures**

In the `callTool` catch block, keep caller-abort behavior, then throw structured errors for known servers:

```ts
				const redactedError = redactThrownError(error, { exactValues: redactionValues });
				const server = serversByNamespace.get(call.namespace);
				if (server !== undefined) {
					throw createUpstreamMcpError({
						causeMessage: messageFromUnknownError(redactedError),
						elapsedMs: elapsedMsSince(startedAt),
						namespace: call.namespace,
						operation: `MCP callTool ${call.namespace}.${call.toolName}`,
						phase: 'call_tool',
						timeoutMs: timeoutMsForServer(server),
						toolName: call.toolName,
						transport: transportSummaryFromServer(server),
					});
				}
				throw redactedError;
```

Add `const startedAt = Date.now();` before `client = await getClient(...)`.

- [ ] **Step 6: Run targeted runtime tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/upstream-mcp-client-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/mcp-portal/src/upstream-mcp-client-runtime.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
git commit -m "feat: structure MCP upstream runtime errors"
```

---

## Task 4: Carry Structured Discovery Diagnostics Through Sessions And Portal Tools

**Files:**
- Modify: `packages/mcp-portal/src/portal-session.ts`
- Modify: `packages/mcp-portal/src/core/portal-tools.ts`
- Test: `packages/mcp-portal/src/portal-session.test.ts`
- Test: `packages/mcp-portal/src/core/portal-tools.test.ts`

- [ ] **Step 1: Write failing session diagnostic test**

Add to `packages/mcp-portal/src/portal-session.test.ts`:

```ts
it('preserves structured upstream discovery diagnostics', async () => {
	const manager = createPortalSessionManager({
		accessPolicy: {
			enabledNamespaces: ['perplexity'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
		catalogTtlMs: 60_000,
		runtime: {
			closeAgentScope: vi.fn(),
			listTools: vi.fn(async () => {
				throw new UpstreamMcpError({
					causeMessage: 'spawn ENOENT',
					elapsedMs: 12,
					hint: 'stdio MCP command failed before tool discovery; verify command, args, package bin name, and gateway PATH.',
					kind: 'upstream_mcp_failed',
					namespace: 'perplexity',
					operation: 'MCP stdio connect for namespace "perplexity"',
					phase: 'connect',
					timeoutMs: 30_000,
					transport: {
						args: ['-y', '-p', '@perplexity-ai/mcp-server', 'wrong-bin'],
						command: 'npx',
						kind: 'stdio',
					},
				});
			}),
		},
		upstreamNamespaces: ['perplexity'],
	});

	const session = await manager.getSession(
		createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
	);

	expect(session.catalog.discoveryFailures).toEqual([
		{
			causeMessage: 'spawn ENOENT',
			elapsedMs: 12,
			hint: 'stdio MCP command failed before tool discovery; verify command, args, package bin name, and gateway PATH.',
			kind: 'upstream_mcp_failed',
			message: 'perplexity: connect failed: spawn ENOENT',
			namespace: 'perplexity',
			operation: 'MCP stdio connect for namespace "perplexity"',
			phase: 'connect',
			timeoutMs: 30_000,
			transport: {
				argCount: 4,
				command: 'npx',
				kind: 'stdio',
			},
		},
	]);
});
```

Also import:

```ts
import { UpstreamMcpError } from './upstream-mcp-errors.js';
```

- [ ] **Step 2: Write failing portal-tools diagnostic test**

In `packages/mcp-portal/src/core/portal-tools.test.ts`, add:

```ts
it('returns structured discovery diagnostics in portal tool responses', async () => {
	const structuredDegradedSession = {
		...session,
		catalog: {
			...session.catalog,
			discoveryFailures: [
				{
					causeMessage: 'Authentication failed',
					elapsedMs: 44,
					hint: 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.',
					kind: 'upstream_mcp_failed',
					message: 'tavily: connect failed: Authentication failed',
					namespace: 'tavily',
					operation: 'MCP streamable-http connect for namespace "tavily"',
					phase: 'connect',
					timeoutMs: 30_000,
					transport: { kind: 'streamable-http', url: 'https://mcp.tavily.com/mcp/' },
				},
			],
		},
	} satisfies PortalSession;
	const handlers = createPortalToolHandlers({
		callUpstreamTool: vi.fn(),
		getSession: vi.fn(async () => structuredDegradedSession),
	});

	await expect(
		handlers.list({
			identity: session.identity,
			input: { requests: [{ id: 'list-tools' }] },
		}),
	).resolves.toMatchObject({
		diagnostics: [
			{
				causeMessage: 'Authentication failed',
				hint: expect.stringContaining('verify URL'),
				kind: 'upstream_mcp_failed',
				namespace: 'tavily',
				phase: 'connect',
				transport: { kind: 'streamable-http', url: 'https://mcp.tavily.com/mcp/' },
			},
		],
		ok: true,
	});
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/portal-session.test.ts src/core/portal-tools.test.ts
```

Expected: FAIL because discovery failures and diagnostics only preserve `message` and `namespace`.

- [ ] **Step 4: Extend `PortalDiscoveryFailure`**

In `packages/mcp-portal/src/portal-session.ts`, replace `PortalDiscoveryFailure` with:

```ts
export interface PortalDiscoveryFailure {
	readonly causeMessage?: string;
	readonly elapsedMs?: number;
	readonly hint?: string;
	readonly kind: string;
	readonly message: string;
	readonly namespace: string;
	readonly operation?: string;
	readonly phase?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport?: unknown;
}
```

Add imports:

```ts
import {
	formatUpstreamMcpFailureMessage,
	messageFromUnknownError,
	upstreamMcpFailureDetailsFromUnknown,
} from './upstream-mcp-errors.js';
```

Replace `messageFromError` with:

```ts
function discoveryFailureFromError(namespace: string, error: unknown): PortalDiscoveryFailure {
	const upstreamDetails = upstreamMcpFailureDetailsFromUnknown(error);
	if (upstreamDetails !== null) {
		return {
			...upstreamDetails,
			message: formatUpstreamMcpFailureMessage(upstreamDetails),
			namespace,
		};
	}
	return {
		kind: 'upstream_discovery_failed',
		message: messageFromUnknownError(error),
		namespace,
	};
}
```

Do not put raw `server.args` into `UpstreamMcpTransportSummary`. Arguments can contain credentials such as `--api-key=...`; the structured diagnostic should expose only `command`, optional `cwd`, and `argCount`.

Then replace:

```ts
discoveryFailures.push({ message: messageFromError(namespaceToolGroup.reason), namespace });
```

with:

```ts
discoveryFailures.push(discoveryFailureFromError(namespace, namespaceToolGroup.reason));
```

- [ ] **Step 5: Extend `PortalBatchDiagnostic` and mapping**

In `packages/mcp-portal/src/core/portal-tools.ts`, replace `PortalBatchDiagnostic` with:

```ts
export interface PortalBatchDiagnostic {
	readonly causeMessage?: string;
	readonly elapsedMs?: number;
	readonly hint?: string;
	readonly kind: string;
	readonly message: string;
	readonly namespace?: string;
	readonly operation?: string;
	readonly phase?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport?: unknown;
}
```

Replace `discoveryDiagnostics` with:

```ts
function discoveryDiagnostics(session: PortalSession): readonly PortalBatchDiagnostic[] {
	return session.catalog.discoveryFailures.map((failure) => ({
		...failure,
		kind:
			failure.kind === 'upstream_mcp_failed'
				? 'upstream_mcp_failed'
				: 'upstream_discovery_failed',
	}));
}
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/portal-session.test.ts src/core/portal-tools.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/mcp-portal/src/portal-session.ts packages/mcp-portal/src/portal-session.test.ts packages/mcp-portal/src/core/portal-tools.ts packages/mcp-portal/src/core/portal-tools.test.ts
git commit -m "feat: propagate MCP discovery diagnostics"
```

---

## Task 5: Add Progressive-Disclosure Schema Hints

**Files:**
- Modify: `packages/mcp-portal/src/tool-summary.ts`
- Modify: `packages/mcp-portal/src/core/portal-tools.ts`
- Modify: `packages/mcp-portal/src/core/portal-core.ts`
- Test: `packages/mcp-portal/src/core/portal-tools.test.ts`
- Test: `packages/mcp-portal/src/core/portal-core.test.ts`

- [ ] **Step 1: Write failing tests for list/search schema hints**

In `packages/mcp-portal/src/core/portal-tools.test.ts`, add a test that calls both
`handlers.list` and `handlers.search` with `schemaDetail: 'summary'` and expects
each returned tool item to include:

```ts
schemaHint: {
	next: 'describe_before_call',
	message: 'Use mcp_portal_describe for exact input schema before calling.',
}
```

Use the existing fixture session and at least one fixture tool. The assertion
must prove the hint appears on each summarized result item, not only at the
batch response level.

- [ ] **Step 2: Write failing tests for describe/full-schema hints**

In `packages/mcp-portal/src/core/portal-tools.test.ts`, add a test that calls
`handlers.describe` and expects the described tool response to include:

```ts
schemaHint: {
	next: 'call_ready',
	message: 'Full input schema included.',
}
```

Also add a `handlers.search` test with `schemaDetail: 'full'` and assert that
full-schema search results use the same `call_ready` hint.

- [ ] **Step 3: Write failing test for namespace disclosure on list only**

In `packages/mcp-portal/src/core/portal-core.test.ts`, add a descriptor test for
`listPortalCoreToolDescriptors(['deepwiki', 'tavily', 'perplexity'])` that proves:

```ts
const listDescriptor = descriptors.find((descriptor) => descriptor.name === 'mcp_portal_list');
const searchDescriptor = descriptors.find((descriptor) => descriptor.name === 'mcp_portal_search');

expect(listDescriptor?.description).toContain('Allowed namespaces for this agent: deepwiki, tavily, perplexity');
expect(searchDescriptor?.description).not.toContain('Allowed namespaces for this agent:');
```

Also inspect `listDescriptor.inputSchema` and assert the nested `namespaces`
property description contains the same namespace list. This is the model-facing
schema note that tells the agent what namespace filters are available without
repeating it across every wrapper tool.

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/core/portal-tools.test.ts src/core/portal-core.test.ts
```

Expected: FAIL because `schemaHint` does not exist and all wrapper descriptors
currently repeat the namespace scope text.

- [ ] **Step 5: Add schema hint types**

In `packages/mcp-portal/src/tool-summary.ts`, add:

```ts
export type ToolSchemaHintNext = 'call_ready' | 'describe_before_call';

export interface ToolSchemaHint {
	readonly message: string;
	readonly next: ToolSchemaHintNext;
}
```

Add this field to `ToolSummary`:

```ts
readonly schemaHint?: ToolSchemaHint;
```

- [ ] **Step 6: Add schema hint constants and attach them**

In `packages/mcp-portal/src/core/portal-tools.ts`, add:

```ts
const describeBeforeCallSchemaHint = {
	message: 'Use mcp_portal_describe for exact input schema before calling.',
	next: 'describe_before_call',
} as const;

const callReadySchemaHint = {
	message: 'Full input schema included.',
	next: 'call_ready',
} as const;
```

When `listRequestResult` and summary `searchRequestResult` create tool summaries,
spread in:

```ts
schemaHint: describeBeforeCallSchemaHint,
```

When `describeRequestResult` returns a described tool, and when
`searchRequestResult` returns `schemaDetail: 'full'`, spread in:

```ts
schemaHint: callReadySchemaHint,
```

Keep `detail` out of this object. The agent only needs the next action and a
short reminder.

`ToolSummary.schemaHint` applies to list and search-summary results. Describe
results and search-full results return richer output records, so attach the same
`schemaHint` object at the output-record level there. Tests must pin both shapes.

- [ ] **Step 7: Move namespace scope text to list only**

In `packages/mcp-portal/src/core/portal-core.ts`, change
`listPortalCoreToolDescriptors(namespaces)` so only `mcp_portal_list` gets:

```text
	Allowed namespaces for this agent: deepwiki, tavily, perplexity.
```

Remove the repeated namespace sentence from `mcp_portal_search`,
`mcp_portal_describe`, and `mcp_portal_call`.

Also clone the `mcp_portal_list` input schema before returning descriptors and
add a description to the nested `requests.items.properties.namespaces` schema:

```text
Optional namespace filter. Allowed namespaces for this agent: deepwiki, tavily, perplexity. Omit to list all currently discovered authorized namespaces.
```

Do not mutate the shared static schema object. Add a small helper such as
`withListNamespaceSchemaDescription(inputSchema, namespaces)` that returns a
new plain object.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/core/portal-tools.test.ts src/core/portal-core.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add packages/mcp-portal/src/tool-summary.ts packages/mcp-portal/src/core/portal-tools.ts packages/mcp-portal/src/core/portal-tools.test.ts packages/mcp-portal/src/core/portal-core.ts packages/mcp-portal/src/core/portal-core.test.ts
git commit -m "feat: guide MCP Portal schema disclosure"
```

---

## Task 6: Push Structured Errors Through Core, OpenClaw Plugin, And MCP Proxy Mode

**Files:**
- Modify: `packages/mcp-portal/src/core/portal-core.ts`
- Modify: `packages/mcp-portal/src/mcp-proxy/portal-mcp-server.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.ts`
- Test: `packages/mcp-portal/src/core/portal-core.test.ts`
- Test: `packages/mcp-portal/src/mcp-proxy/portal-mcp-server.test.ts`
- Test: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`
- Test: `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.test.ts`

- [ ] **Step 1: Write failing core audit event test**

Add to `packages/mcp-portal/src/core/portal-core.test.ts`:

```ts
it('carries structured discovery diagnostics into core audit events', async () => {
	const core = createPortalCore({
		accessPolicy: {
			enabledNamespaces: ['tavily'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
		approval: () => ({ kind: 'allow' }),
		catalogTtlMs: 60_000,
		runtime: {
			callUpstreamTool: vi.fn(),
			closeAgentScope: vi.fn(),
			closeSession: vi.fn(),
			listTools: vi.fn(async () => {
				throw new UpstreamMcpError({
					causeMessage: 'Authentication failed',
					elapsedMs: 31,
					hint: 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.',
					kind: 'upstream_mcp_failed',
					namespace: 'tavily',
					operation: 'MCP streamable-http connect for namespace "tavily"',
					phase: 'connect',
					timeoutMs: 30_000,
					transport: { kind: 'streamable-http', url: 'https://mcp.tavily.com/mcp/' },
				});
			}),
		},
		upstreamNamespaces: ['tavily'],
	});
	const scope = core.createAgentScope({
		agentId: 'agent-a',
		agentScopeId: 'agent-a',
		source: 'cli-operator',
	});

	const result = await core.collectPortalCoreResult(
		core.callStream({
			input: { requests: [{ id: 'list' }] },
			scope,
			toolName: 'mcp_portal_list',
		}),
	);

	expect(result.auditEvents).toEqual([
		expect.objectContaining({
			causeMessage: 'Authentication failed',
			hint: expect.stringContaining('verify URL'),
			kind: 'upstream_mcp_failed',
			namespace: 'tavily',
			phase: 'connect',
		}),
	]);
});
```

Import `UpstreamMcpError` from `../upstream-mcp-errors.js`.

- [ ] **Step 2: Write failing MCP proxy test**

Add to `packages/mcp-portal/src/mcp-proxy/portal-mcp-server.test.ts`:

```ts
it('returns structured diagnostics through direct MCP proxy calls', async () => {
	const core = createPortalCore({
		accessPolicy: {
			enabledNamespaces: ['firecrawl'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
		approval: () => ({ kind: 'allow' }),
		catalogTtlMs: 60_000,
		runtime: {
			callUpstreamTool: vi.fn(),
			closeAgentScope: vi.fn(),
			closeSession: vi.fn(),
			listTools: vi.fn(async () => {
				throw new UpstreamMcpError({
					causeMessage: 'operation timed out',
					elapsedMs: 30_001,
					hint: 'MCP provider connected but tool discovery failed; run agent-vm validate --mcp-live for the configured namespace.',
					kind: 'upstream_mcp_failed',
					namespace: 'firecrawl',
					operation: 'MCP listTools',
					phase: 'list_tools',
					timeoutMs: 30_000,
					transport: { argCount: 2, command: 'npx', kind: 'stdio' },
				});
			}),
		},
		upstreamNamespaces: ['firecrawl'],
	});
	const scope = core.createAgentScope({
		agentId: 'agent-a',
		agentScopeId: 'agent-a',
		source: 'cli-operator',
	});
	const callToolHandler = captureCallToolHandler(() => {
		createPortalMcpServer({
			core,
			scope,
		}),
	});

	const result = await callToolHandler({
		method: 'tools/call',
		params: {
			arguments: { requests: [{ id: 'list' }] },
			name: 'mcp_portal_list',
		},
	});

	expect(result.isError).toBeUndefined();
	expect(JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}')).toMatchObject({
		auditEvents: [
			{
				kind: 'upstream_mcp_failed',
				namespace: 'firecrawl',
				phase: 'list_tools',
			},
		],
		structuredContent: {
			diagnostics: [
				{
					hint: expect.stringContaining('validate --mcp-live'),
					namespace: 'firecrawl',
					phase: 'list_tools',
				},
			],
		},
	});
});
```

Add the local `captureCallToolHandler` helper in the same test file. It should use `vi.spyOn(Server.prototype, 'setRequestHandler')` and capture the handler passed with `CallToolRequestSchema` while `createPortalMcpServer(...)` runs. Do not reference helper names that are not already defined or introduced in this task.

- [ ] **Step 3: Write failing OpenClaw plugin prompt-context test**

In `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.test.ts`, add:

```ts
it('includes phase and hint in prompt diagnostics', () => {
	const context = createPortalPromptContext({
		diagnostics: [
			{
				hint: 'stdio MCP command failed before tool discovery; verify command, args, package bin name, and gateway PATH.',
				message: 'perplexity: connect failed: spawn ENOENT',
				namespace: 'perplexity',
				phase: 'connect',
			},
		],
		namespaces: [],
	});

	expect(context).toContain(
		'Discovery diagnostics: perplexity connect: perplexity: connect failed: spawn ENOENT',
	);
	expect(context).toContain('Hint: stdio MCP command failed before tool discovery');
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/core/portal-core.test.ts src/mcp-proxy/portal-mcp-server.test.ts
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin test -- src/plugin-registration.test.ts src/portal-prompt-context.test.ts
```

Expected: FAIL because structured fields are not yet copied into audit events and prompt diagnostics.

- [ ] **Step 5: Extend `PortalAuditEvent` and mapping**

In `packages/mcp-portal/src/core/portal-core.ts`, replace `PortalAuditEvent` with:

```ts
export interface PortalAuditEvent {
	readonly causeMessage?: string;
	readonly elapsedMs?: number;
	readonly hint?: string;
	readonly kind: string;
	readonly message: string;
	readonly namespace?: string;
	readonly operation?: string;
	readonly phase?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport?: unknown;
}
```

Replace `diagnosticsToAuditEvents` with:

```ts
function diagnosticsToAuditEvents(
	diagnostics: readonly PortalBatchDiagnostic[],
): readonly PortalAuditEvent[] {
	return diagnostics.map((diagnostic) => ({
		...diagnostic,
		...(diagnostic.namespace !== undefined ? { namespace: diagnostic.namespace } : {}),
	}));
}
```

- [ ] **Step 6: Keep plugin diagnostics on the final tool result**

Do not emit a separate completed-event `mcp_portal_diagnostics` update. OpenClaw native tools already return the full `PortalCoreResult` in `details`, and the same result is serialized into `content`. Adding a completed-event update would create two user-visible diagnostic surfaces for the same result.

In `packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`, add a failing assertion that an MCP Portal tool result with `auditEvents` returns:

```ts
expect(result.details.auditEvents).toContainEqual(
	expect.objectContaining({
		kind: 'upstream_mcp_failed',
		namespace: 'tavily',
		phase: 'connect',
	}),
);
```

- [ ] **Step 7: Extend prompt diagnostic type and text**

In `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.ts`, replace `PortalPromptDiagnostic` with:

```ts
export interface PortalPromptDiagnostic {
	readonly hint?: string;
	readonly message: string;
	readonly namespace: string;
	readonly phase?: string;
}
```

Add:

```ts
function formatDiagnostic(entry: PortalPromptDiagnostic): string {
	const phase = entry.phase === undefined ? '' : ` ${entry.phase}`;
	const hint = entry.hint === undefined ? '' : ` Hint: ${entry.hint}`;
	return `${entry.namespace}${phase}: ${entry.message}.${hint}`;
}
```

Then change the diagnostics construction to:

```ts
	const diagnostics =
		props.diagnostics !== undefined && props.diagnostics.length > 0
			? [`Discovery diagnostics: ${props.diagnostics.map(formatDiagnostic).join('; ')}`]
			: [];
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test -- src/core/portal-core.test.ts src/mcp-proxy/portal-mcp-server.test.ts
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin test -- src/plugin-registration.test.ts src/portal-prompt-context.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 6**

```bash
git add packages/mcp-portal/src/core/portal-core.ts packages/mcp-portal/src/core/portal-core.test.ts packages/mcp-portal/src/mcp-proxy/portal-mcp-server.ts packages/mcp-portal/src/mcp-proxy/portal-mcp-server.test.ts packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.ts packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.test.ts
git commit -m "feat: surface MCP Portal diagnostics on plugin and proxy paths"
```

---

## Task 7: Hard-Cut Authored MCP Portal Profiles To Per-Namespace Policy

**Files:**
- Modify: `packages/config-contracts/src/mcp-portal-config.ts`
- Test: `packages/config-contracts/src/mcp-portal-config.test.ts`
- Modify test fixtures that still use `enabledNamespaces`, `enabledToolsByNamespace`, or `hiddenToolsByNamespace`.

- [ ] **Step 1: Write failing config-contract tests for the new authored shape**

Add to `packages/config-contracts/src/mcp-portal-config.test.ts`:

```ts
it('resolves per-namespace authored portal policy into the internal profile shape', async () => {
	const configPath = await writeConfigFile(`{
		"schemaVersion": 1,
		"agents": { "beta": { "profile": "default" } },
		"profiles": {
			"default": {
				"namespaces": {
					"deepwiki": {
						"tools": {
							"enabled": ["read_wiki_structure", "ask_question"]
						},
						"approval": {
							"allowWithoutApproval": ["read_wiki_structure", "ask_question"],
							"trustedAnnotations": true
						}
					},
					"tavily": {
						"tools": {
							"enabled": ["tavily_search", "tavily_extract"]
						},
						"approval": {
							"allowWithoutApproval": ["tavily_search", "tavily_extract"]
						}
					}
				},
				"logging": { "enabled": true }
			}
		}
	}`);

	const config = await loadMcpPortalConfig(configPath);
	const profile = resolveMcpPortalProfile(config, 'default');

	expect(profile.enabledNamespaces).toEqual(['deepwiki', 'tavily']);
	expect(profile.enabledToolsByNamespace).toEqual({
		deepwiki: ['read_wiki_structure', 'ask_question'],
		tavily: ['tavily_search', 'tavily_extract'],
	});
	expect(profile.approval.allowWithoutApprovalTools).toEqual([
		{ namespace: 'deepwiki', toolName: 'read_wiki_structure' },
		{ namespace: 'deepwiki', toolName: 'ask_question' },
		{ namespace: 'tavily', toolName: 'tavily_search' },
		{ namespace: 'tavily', toolName: 'tavily_extract' },
	]);
	expect(profile.approval.trustedAnnotationNamespaces).toEqual(['deepwiki']);
	expect(profile.logging.enabled).toBe(true);
});

it('rejects split legacy namespace and approval profile fields', async () => {
	const configPath = await writeConfigFile(`{
		"schemaVersion": 1,
		"agents": { "beta": { "profile": "default" } },
		"profiles": {
			"default": {
				"enabledNamespaces": ["deepwiki"],
				"enabledToolsByNamespace": { "deepwiki": ["ask_question"] }
			}
		}
	}`);

	await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/enabledNamespaces/u);
});

it('uses only the selected profile as the complete MCP Portal policy', async () => {
	const configPath = await writeConfigFile(`{
		"schemaVersion": 1,
		"agents": { "beta": { "profile": "child" } },
		"profiles": {
			"base": {
				"namespaces": {
					"deepwiki": {
						"tools": { "enabled": ["ask_question"] },
						"approval": { "allowWithoutApproval": ["ask_question"] }
					}
				}
			},
			"child": {
				"namespaces": {
					"deepwiki": {
						"tools": { "hidden": ["read_wiki_contents"] },
						"approval": { "alwaysAsk": ["admin_tool"] }
					}
				}
			}
		}
	}`);

	const config = await loadMcpPortalConfig(configPath);
	const profile = resolveMcpPortalProfile(config, 'child');

	expect(profile.enabledNamespaces).toEqual(['deepwiki']);
	expect(profile.enabledToolsByNamespace).toEqual({});
	expect(profile.hiddenToolsByNamespace).toEqual({
		deepwiki: ['read_wiki_contents'],
	});
	expect(profile.approval.allowWithoutApprovalTools).toEqual([]);
	expect(profile.approval.alwaysAskTools).toEqual([
		{ namespace: 'deepwiki', toolName: 'admin_tool' },
	]);
});
```

- [ ] **Step 2: Run config tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/config-contracts test -- src/mcp-portal-config.test.ts
```

Expected: FAIL because the schema does not accept `namespaces`.

- [ ] **Step 3: Add authored namespace schema**

In `packages/config-contracts/src/mcp-portal-config.ts`, add near `portalApprovalConfigSchema`:

```ts
const portalNamespaceToolsSchema = z
	.object({
		enabled: z.array(z.string().min(1)).optional(),
		hidden: z.array(z.string().min(1)).default([]),
	})
	.strict();

const portalNamespaceApprovalSchema = z
	.object({
		allowWithoutApproval: z.array(z.string().min(1)).default([]),
		alwaysAsk: z.array(z.string().min(1)).default([]),
		trustedAnnotations: z.boolean().default(false),
		write: z.array(z.string().min(1)).default([]),
	})
	.strict();

const portalNamespacePolicySchema = z
	.object({
		approval: portalNamespaceApprovalSchema.default({}),
		tools: portalNamespaceToolsSchema.default({}),
	})
	.strict();
```

Replace the old profile namespace fields with:

```ts
		namespaces: z.record(z.string().min(1), portalNamespacePolicySchema).default({}),
```

Remove these old authored fields from `mcpPortalProfileDefinitionSchema`:

```ts
enabledNamespaces
enabledToolsByNamespace
hiddenToolsByNamespace
```

Keep `approval.annotationPolicy` as the only profile-wide approval field. The
tool lists move under `namespaces.<namespace>.approval`.

- [ ] **Step 4: Compile the selected profile directly**

Add:

```ts
function namespaceToolRefs(
	namespaces: Readonly<Record<string, z.infer<typeof portalNamespacePolicySchema>>>,
	selector: (policy: z.infer<typeof portalNamespacePolicySchema>) => readonly string[],
): readonly NamespaceToolRef[] {
	return Object.entries(namespaces).flatMap(([namespace, policy]) =>
		selector(policy).map((toolName) => ({ namespace, toolName })),
	);
}

function compileNamespaceApproval(
	namespaces: Readonly<Record<string, z.infer<typeof portalNamespacePolicySchema>>>,
	annotationPolicy: PortalApprovalConfig['annotationPolicy'],
): PortalApprovalConfig {
	return portalApprovalConfigSchema.parse({
		allowWithoutApprovalTools: namespaceToolRefs(
			namespaces,
			(policy) => policy.approval.allowWithoutApproval,
		),
		annotationPolicy,
		alwaysAskTools: namespaceToolRefs(namespaces, (policy) => policy.approval.alwaysAsk),
		trustedAnnotationNamespaces: Object.entries(namespaces)
			.filter(([, policy]) => policy.approval.trustedAnnotations)
			.map(([namespace]) => namespace),
		writeTools: namespaceToolRefs(namespaces, (policy) => policy.approval.write),
	});
}

function compileEnabledToolsByNamespace(
	namespaces: Readonly<Record<string, z.infer<typeof portalNamespacePolicySchema>>>,
): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(namespaces)
			.filter(([, policy]) => policy.tools.enabled !== undefined)
			.map(([namespace, policy]) => [namespace, policy.tools.enabled ?? []]),
	);
}

function compileHiddenToolsByNamespace(
	namespaces: Readonly<Record<string, z.infer<typeof portalNamespacePolicySchema>>>,
): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(namespaces)
			.filter(([, policy]) => policy.tools.hidden.length > 0)
			.map(([namespace, policy]) => [namespace, policy.tools.hidden]),
	);
}
```

Compile the selected profile directly:

```ts
type AuthoredPortalNamespaces = z.infer<typeof mcpPortalProfileDefinitionSchema>['namespaces'];

function compileProfileFromNamespaces(
	namespaces: AuthoredPortalNamespaces,
	profile: McpPortalProfileDefinition,
): ResolvedMcpPortalProfile {
	const annotationPolicy =
		profile.approval?.annotationPolicy ?? defaultProfile.approval.annotationPolicy;
	return resolvedMcpPortalProfileSchema.parse({
		approval: compileNamespaceApproval(namespaces, annotationPolicy),
		cache: profile.cache ?? defaultProfile.cache,
		enabledNamespaces: Object.keys(namespaces),
		enabledToolsByNamespace: compileEnabledToolsByNamespace(namespaces),
		hiddenToolsByNamespace: compileHiddenToolsByNamespace(namespaces),
		logging: profile.logging ?? defaultProfile.logging,
		promptContext: profile.promptContext ?? defaultProfile.promptContext,
	});
}

export function resolveMcpPortalProfile(
	config: McpPortalConfig,
	profileName: string,
): ResolvedMcpPortalProfile {
	const profile = config.profiles[profileName];
	if (profile === undefined) {
		throw new Error(`unknown MCP profile '${profileName}'`);
	}
	return compileProfileFromNamespaces(profile.namespaces, profile);
}
```

Profiles are complete policies. Do not add `extends`, recursion, parent profile
merge logic, or a default-profile merge.

- [ ] **Step 5: Update fixture configs in tests**

Replace authored profile snippets like:

```jsonc
{
	"enabledNamespaces": ["deepwiki"],
	"enabledToolsByNamespace": { "deepwiki": ["ask_question"] },
	"approval": {
		"allowWithoutApprovalTools": [
			{ "namespace": "deepwiki", "toolName": "ask_question" }
		]
	}
}
```

with:

```jsonc
{
	"namespaces": {
		"deepwiki": {
			"tools": { "enabled": ["ask_question"] },
			"approval": {
				"allowWithoutApproval": ["ask_question"],
				"trustedAnnotations": true
			}
		}
	}
}
```

Use `rg -n "enabledNamespaces|enabledToolsByNamespace|hiddenToolsByNamespace|allowWithoutApprovalTools" packages docs -g '*.{ts,md,json,jsonc}'` and update all authored config examples. Keep `ResolvedMcpPortalProfile` internals unchanged.

- [ ] **Step 6: Run config and dependent tests**

Run:

```bash
pnpm --filter @agent-vm/config-contracts test -- src/mcp-portal-config.test.ts
pnpm --filter @agent-vm/agent-vm test -- src/gateway/mcp-portal-effective-config.test.ts src/operations/config-validation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add packages/config-contracts/src/mcp-portal-config.ts packages/config-contracts/src/mcp-portal-config.test.ts packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts packages/agent-vm/src/operations/config-validation.test.ts
git commit -m "feat: colocate MCP Portal namespace policy"
```

---

## Task 8: Add `agent-vm validate --mcp-live`

**Files:**
- Create: `packages/agent-vm/src/operations/mcp-portal-live-validation.ts`
- Modify: `packages/mcp-portal/src/index.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Modify: `packages/agent-vm/src/cli/commands/validate-definition.ts`
- Test: `packages/agent-vm/src/operations/config-validation.test.ts`
- Test: `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`

- [ ] **Step 1: Write failing operation tests**

Add to `packages/agent-vm/src/operations/config-validation.test.ts`:

```ts
it('skips live MCP discovery unless --mcp-live is requested', async () => {
	const systemConfig = createOpenClawSystemConfigWithMcpPortal();
	const runLiveMcpPortalValidation = vi.fn(async () => [
		{ hint: 'deepwiki discovered 2 tools', name: 'mcp-live-deepwiki', ok: true },
	]);

	const result = await runConfigValidation({
		runLiveMcpPortalValidation,
		systemConfig,
	});

	expect(runLiveMcpPortalValidation).not.toHaveBeenCalled();
	expect(result.checks.map((check) => check.name)).not.toContain('mcp-live-deepwiki');
});

it('includes live MCP discovery checks when requested', async () => {
	const systemConfig = createOpenClawSystemConfigWithMcpPortal();
	const secretResolver = {
		resolve: vi.fn(),
		resolveAll: vi.fn(),
	};
	const runLiveMcpPortalValidation = vi.fn(async () => [
		{
			hint: 'perplexity connect failed: stdio MCP command failed before tool discovery; verify command, args, package bin name, and gateway PATH.',
			name: 'mcp-live-beta-perplexity',
			ok: false,
		},
	]);

	const result = await runConfigValidation({
		mcpLive: true,
		runLiveMcpPortalValidation,
		secretResolver,
		systemConfig,
	});

	expect(runLiveMcpPortalValidation).toHaveBeenCalledWith({
		secretResolver,
		systemConfig,
	});
	expect(result.ok).toBe(false);
	expect(result.checks).toContainEqual({
		hint: 'perplexity connect failed: stdio MCP command failed before tool discovery; verify command, args, package bin name, and gateway PATH.',
		name: 'mcp-live-beta-perplexity',
		ok: false,
	});
});

it('fails when a portal profile references a namespace without an MCP provider', async () => {
	const systemConfig = await createSystemConfigWithLiveMcpFiles({
		mcpConfig: {
			schemaVersion: 1,
			providers: {},
		},
		portalConfig: {
			schemaVersion: 1,
			agents: { beta: { profile: 'default' } },
			profiles: {
				default: {
					namespaces: {
						deepwiki: {
							tools: { enabled: ['ask_question'] },
						},
					},
				},
			},
		},
	});

	await expect(
		runLiveMcpPortalValidation({
			createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
			secretResolver: createTestSecretResolver(),
			systemConfig,
		}),
	).resolves.toContainEqual({
		hint: "Agent 'beta' profile 'default' references MCP namespace 'deepwiki', but no provider with that namespace exists in mcp.config.jsonc.",
		name: 'mcp-live-profile-namespace-beta-beta-deepwiki',
		ok: false,
	});
});

it('checks hidden and approval tool names, not only enabled tools', async () => {
	const systemConfig = await createSystemConfigWithLiveMcpFiles({
		mcpConfig: createSingleToolMcpConfig({ namespace: 'deepwiki', toolName: 'ask_question' }),
		portalConfig: {
			schemaVersion: 1,
			agents: { beta: { profile: 'default' } },
			profiles: {
				default: {
					namespaces: {
						deepwiki: {
							tools: {
								enabled: ['ask_question'],
								hidden: ['missing_hidden_tool'],
							},
							approval: {
								allowWithoutApproval: ['missing_approval_tool'],
							},
						},
					},
				},
			},
		},
	});

	await expect(
		runLiveMcpPortalValidation({
			createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
			secretResolver: createTestSecretResolver(),
			systemConfig,
		}),
	).resolves.toContainEqual({
		hint: "Agent 'beta' profile 'default' references missing deepwiki tools: missing_approval_tool, missing_hidden_tool. Actual tools: ask_question.",
		name: 'mcp-live-profile-tools-beta-beta-deepwiki',
		ok: false,
	});
});
```

Add local helpers in the test file:

- `createOpenClawSystemConfigWithMcpPortal` returns the smallest `LoadedSystemConfig` already used by the existing MCP Portal validation tests.
- `createSystemConfigWithLiveMcpFiles` writes temporary `mcp.config.jsonc` and `mcp-portal.config.jsonc` files under a temporary zone config directory and returns a `LoadedSystemConfig` whose `zones[].mcpPortal.configDir` points there.
- `createSingleToolMcpConfig` creates a fake provider config for the namespace under test.
- `createFakeMcpRuntime` returns an `UpstreamMcpClientRuntime` whose `listTools` returns deterministic tool names without network.
- `createTestSecretResolver` returns a `SecretResolver` with deterministic fake values.

Live validation should only start providers referenced by at least one portal profile. Extra provider entries in `mcp.config.jsonc` are allowed and should not be started just because they are configured. Deduplicate provider namespaces before calling `runtime.listTools`, and hoist each namespace's `actualToolNames` set outside the per-agent loop.

- [ ] **Step 2: Write failing CLI routing test**

Add to `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts` near the existing validate test:

```ts
it('routes validate --mcp-live to config validation', async () => {
	const runConfigValidation = vi.fn(async () => ({ checks: [], ok: true }));
	const secretResolver = {
		resolve: vi.fn(),
		resolveAll: vi.fn(),
	};
	const createSecretResolver = vi.fn(async () => secretResolver);

	await runCliWithArgs(['validate', '--config', './custom-system.json', '--mcp-live'], {
		createSecretResolver,
		loadSystemConfig: async () => minimalSystemConfig,
		runConfigValidation,
	});

	expect(runConfigValidation).toHaveBeenCalledWith(
		expect.objectContaining({
			mcpLive: true,
			secretResolver,
			systemConfig: minimalSystemConfig,
		}),
	);
});
```

Use the existing CLI test helper names in this file; keep the expected object shape exactly as the existing validate routing test expects.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/agent-vm test -- src/operations/config-validation.test.ts src/cli/agent-vm-entrypoint.test.ts
```

Expected: FAIL because `mcpLive` and `runLiveMcpPortalValidation` do not exist.

- [ ] **Step 4: Create live validation operation**

Create `packages/agent-vm/src/operations/mcp-portal-live-validation.ts`:

```ts
import path from 'node:path';

import { createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal';
import { resolveUpstreamServers } from '@agent-vm/mcp-portal/core';
import {
	loadMcpConfig,
	loadMcpPortalConfig,
	resolveMcpPortalProfile,
	type ResolvedMcpPortalProfile,
	type SecretValue,
} from '@agent-vm/config-contracts';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { resolveProjectCheckoutPath } from './config-validation.js';
import type { ConfigValidationCheck } from './config-validation.js';

export interface RunLiveMcpPortalValidationOptions {
	readonly createRuntime?: typeof createUpstreamMcpClientRuntime;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}

function secretRefFromSecretValue(secret: SecretValue): SecretRef {
	if (secret.source === 'environment') {
		return { ref: secret.name, source: 'environment' };
	}
	return { ref: secret.ref, source: '1password' };
}

async function resolveProviderSecret(
	secret: SecretValue,
	secretResolver: SecretResolver,
): Promise<string> {
	return await secretResolver.resolve(secretRefFromSecretValue(secret));
}

function profileNamespaces(profile: ResolvedMcpPortalProfile): readonly string[] {
	return Array.from(
		new Set([
			...profile.enabledNamespaces,
			...Object.keys(profile.enabledToolsByNamespace),
			...Object.keys(profile.hiddenToolsByNamespace),
			...profile.approval.allowWithoutApprovalTools.map((tool) => tool.namespace),
			...profile.approval.alwaysAskTools.map((tool) => tool.namespace),
			...profile.approval.writeTools.map((tool) => tool.namespace),
		]),
	).toSorted();
}

function profileToolNamesForNamespace(
	profile: ResolvedMcpPortalProfile,
	namespace: string,
): readonly string[] {
	return Array.from(
		new Set([
			...(profile.enabledToolsByNamespace[namespace] ?? []),
			...(profile.hiddenToolsByNamespace[namespace] ?? []),
			...profile.approval.allowWithoutApprovalTools
				.filter((tool) => tool.namespace === namespace)
				.map((tool) => tool.toolName),
			...profile.approval.alwaysAskTools
				.filter((tool) => tool.namespace === namespace)
				.map((tool) => tool.toolName),
			...profile.approval.writeTools
				.filter((tool) => tool.namespace === namespace)
				.map((tool) => tool.toolName),
		]),
	).toSorted();
}

export async function runLiveMcpPortalValidation(
	options: RunLiveMcpPortalValidationOptions,
): Promise<readonly ConfigValidationCheck[]> {
	const checks: ConfigValidationCheck[] = [];
	for (const zone of options.systemConfig.zones) {
		if (zone.gateway.type !== 'openclaw' || zone.mcpPortal === undefined) {
			continue;
		}
		const configDir = resolveProjectCheckoutPath(options.systemConfig, zone.mcpPortal.configDir);
			const mcpConfig = await loadMcpConfig(path.join(configDir, 'mcp.config.jsonc'));
			const portalConfig = await loadMcpPortalConfig(path.join(configDir, 'mcp-portal.config.jsonc'));
			const servers = await resolveUpstreamServers({
				config: mcpConfig,
				resolveSecret: async (secret) =>
					await resolveProviderSecret(secret, options.secretResolver),
			});
			const serverNamespaces = new Set(servers.map((server) => server.namespace));
			for (const [agentId, agent] of Object.entries(portalConfig.agents)) {
				const profile = resolveMcpPortalProfile(portalConfig, agent.profile);
				for (const namespace of profileNamespaces(profile)) {
					if (!serverNamespaces.has(namespace)) {
						checks.push({
							hint: `Agent '${agentId}' profile '${agent.profile}' references MCP namespace '${namespace}', but no provider with that namespace exists in mcp.config.jsonc.`,
							name: `mcp-live-profile-namespace-${zone.id}-${agentId}-${namespace}`,
							ok: false,
						});
					}
				}
			}
			const referencedNamespaces = new Set(
				Object.values(portalConfig.agents).flatMap((agent) =>
					profileNamespaces(resolveMcpPortalProfile(portalConfig, agent.profile)),
				),
			);
			const namespacesToValidate = [...serverNamespaces]
				.filter((namespace) => referencedNamespaces.has(namespace))
				.toSorted();
			const runtime = (options.createRuntime ?? createUpstreamMcpClientRuntime)({ servers });
			try {
				for (const namespace of namespacesToValidate) {
					try {
						const tools = await runtime.listTools({
							agentScopeId: `validate:${zone.id}`,
							namespace,
						});
						const actualToolNames = new Set(tools.map((tool) => tool.name));
						const actualToolNameList = tools.map((tool) => tool.name).toSorted();
						checks.push({
							hint: `${namespace} discovered ${String(tools.length)} tools.`,
							name: `mcp-live-${zone.id}-${namespace}`,
						ok: true,
						});
						for (const [agentId, agent] of Object.entries(portalConfig.agents)) {
							const profile = resolveMcpPortalProfile(portalConfig, agent.profile);
							const configuredTools = profileToolNamesForNamespace(profile, namespace);
							const missingTools = configuredTools.filter((toolName) => !actualToolNames.has(toolName));
							if (missingTools.length > 0) {
								checks.push({
									hint: `Agent '${agentId}' profile '${agent.profile}' references missing ${namespace} tools: ${missingTools.join(', ')}. Actual tools: ${actualToolNameList.join(', ')}.`,
								name: `mcp-live-profile-tools-${zone.id}-${agentId}-${namespace}`,
								ok: false,
							});
						}
					}
				} catch (error) {
					checks.push({
						hint: error instanceof Error ? error.message : String(error),
						name: `mcp-live-${zone.id}-${namespace}`,
						ok: false,
					});
				}
			}
		} finally {
			await runtime.closeAgentScope(`validate:${zone.id}`);
		}
	}
	return checks;
}
```

Do not add a root `@agent-vm/mcp-portal` re-export for provider runtime helpers. The package already exposes the `@agent-vm/mcp-portal/core` subpath, and existing plugin code imports `resolveUpstreamServers` from that subpath.

- [ ] **Step 5: Wire validation options**

In `packages/agent-vm/src/operations/config-validation.ts`, update `RunConfigValidationOptions`:

```ts
export interface RunConfigValidationOptions {
	readonly mcpLive?: boolean;
	readonly runCommand?: ConfigValidationCommandRunner;
	readonly runLiveMcpPortalValidation?: typeof runLiveMcpPortalValidation;
	readonly secretResolver?: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}
```

Import `SecretResolver` and `runLiveMcpPortalValidation`.

In `runConfigValidation`, after static MCP Portal checks:

```ts
	const liveMcpPortalChecks =
		options.mcpLive === true
			? await (options.runLiveMcpPortalValidation ?? runLiveMcpPortalValidation)({
					secretResolver:
						options.secretResolver ??
						(() => {
							throw new Error('agent-vm validate --mcp-live requires a secret resolver.');
						})(),
					systemConfig,
				})
			: [];
```

Do not fall back to `validationOnlySecretResolver` for live MCP validation. Static validation may use empty secret placeholders, but live validation must resolve real provider credentials.

Remove any fallback that substitutes the static-validation placeholder secret resolver for live MCP checks.

Include `...liveMcpPortalChecks` in the final checks array.

- [ ] **Step 6: Wire CLI flag**

In `packages/agent-vm/src/cli/commands/validate-definition.ts`, import `flag` from `cmd-ts` and `createResolverFromSystemConfig` from `../agent-vm-cli-support.js`. Then add:

```ts
			mcpLive: flag({
				long: 'mcp-live',
				description: 'Start configured MCP Portal providers, run tools/list, and verify profile tool names.',
			}),
```

Pass it into `runConfigValidation`. Only create a real secret resolver when `--mcp-live` is set:

```ts
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					const secretResolver =
						mcpLive === true
							? await createResolverFromSystemConfig(systemConfig, dependencies)
							: undefined;
					writeJson(
						io,
						await (dependencies.runConfigValidation ?? runConfigValidation)({
							...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
							...(mcpLive ? { mcpLive: true } : {}),
							...(secretResolver === undefined ? {} : { secretResolver }),
							systemConfig,
						}),
					);
```

- [ ] **Step 7: Run targeted tests**

Run:

```bash
pnpm --filter @agent-vm/agent-vm test -- src/operations/config-validation.test.ts src/cli/agent-vm-entrypoint.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 8**

```bash
git add packages/mcp-portal/src/index.ts packages/agent-vm/src/operations/mcp-portal-live-validation.ts packages/agent-vm/src/operations/config-validation.ts packages/agent-vm/src/operations/config-validation.test.ts packages/agent-vm/src/cli/commands/validate-definition.ts packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts
git commit -m "feat: add live MCP Portal validation"
```

---

## Task 9: Update Generated Defaults, Docs, And Smokes

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`
- Modify: `docs/subsystems/mcp-portal.md`
- Modify: `packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts`

- [ ] **Step 1: Write failing scaffold/default tests**

In `packages/agent-vm/src/cli/init-command.test.ts`, update the MCP Portal scaffold assertion to expect:

```ts
expect(mcpPortalConfig.profiles.default.namespaces).toEqual({
	deepwiki: {
		approval: {
			allowWithoutApproval: ['read_wiki_structure', 'ask_question'],
			trustedAnnotations: true,
		},
		tools: {
			enabled: ['read_wiki_structure', 'ask_question'],
		},
	},
});
expect(mcpPortalConfig.profiles.default).not.toHaveProperty('enabledNamespaces');
expect(mcpPortalConfig.profiles.default).not.toHaveProperty('enabledToolsByNamespace');
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/agent-vm test -- src/cli/init-command.test.ts src/cli/manual-templates.test.ts src/integration-tests/openclaw-mcp-portal.smoke.test.ts
```

Expected: FAIL because generated docs and fixtures still use old authored fields.

- [ ] **Step 3: Update generated scaffold**

In `packages/agent-vm/src/cli/init-command.ts`, replace default MCP Portal profile output with:

```ts
profiles: {
	default: {
		namespaces: {
			deepwiki: {
				approval: {
					allowWithoutApproval: ['read_wiki_structure', 'ask_question'],
					trustedAnnotations: true,
				},
				tools: {
					enabled: ['read_wiki_structure', 'ask_question'],
				},
			},
		},
	},
},
```

- [ ] **Step 4: Update docs and manual wording**

In `docs/subsystems/mcp-portal.md`, add a section:

```md
### Runtime diagnostics

MCP Portal returns one result shape in both OpenClaw native plugin mode and direct MCP proxy mode:

```json
{
  "auditEvents": [
    {
      "kind": "upstream_mcp_failed",
      "namespace": "tavily",
      "phase": "connect",
      "message": "tavily: connect failed: Authentication failed",
      "hint": "remote MCP connection failed; verify URL, auth header, network egress, and transport kind."
    }
  ],
  "structuredContent": {
    "diagnostics": []
  }
}
```

OpenClaw native tools return this value in `details`. Direct MCP proxy tools return the same value as JSON text content. Use `agent-vm validate --mcp-live` after changing providers, secrets, or profile tool names.
```

In `packages/agent-vm/src/cli/manual-templates.ts`, update the MCP Portal section so it says:

```text
Run agent-vm validate --mcp-live after editing MCP providers or MCP Portal profiles. Static validate checks schema and materialization. Live validate starts each configured MCP provider, runs tools/list, and reports namespace, transport, phase, and hints for failures.
```

- [ ] **Step 5: Update smoke fixtures**

In `packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts`, replace old profile config with:

```ts
profiles: {
	default: {
		namespaces: {
			[fakeUpstreamNamespace]: {
				approval: {
					allowWithoutApproval: ['echo'],
					trustedAnnotations: true,
				},
				tools: {
					enabled: ['echo'],
				},
			},
		},
	},
},
```

- [ ] **Step 7: Run targeted docs/scaffold/smoke tests**

Run:

```bash
pnpm --filter @agent-vm/agent-vm test -- src/cli/init-command.test.ts src/cli/manual-templates.test.ts src/integration-tests/openclaw-mcp-portal.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 9**

```bash
git add packages/config-contracts/src/mcp-portal-config.test.ts packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts docs/subsystems/mcp-portal.md packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts
git commit -m "docs: update MCP Portal diagnostics and defaults"
```

---

## Task 10: Full Verification And Beta Proof

**Files:**
- Modify only if previous verification exposes a concrete bug.

- [ ] **Step 1: Run package tests**

Run:

```bash
pnpm --filter @agent-vm/config-contracts test -- src/mcp-portal-config.test.ts
pnpm --filter @agent-vm/mcp-portal test -- src/upstream-mcp-client-runtime.test.ts src/portal-session.test.ts src/core/portal-tools.test.ts src/core/portal-core.test.ts src/mcp-proxy/portal-mcp-server.test.ts
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin test -- src/plugin-registration.test.ts src/portal-prompt-context.test.ts
pnpm --filter @agent-vm/agent-vm test -- src/operations/config-validation.test.ts src/cli/agent-vm-entrypoint.test.ts src/cli/init-command.test.ts src/cli/manual-templates.test.ts src/integration-tests/openclaw-mcp-portal.smoke.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 2: Run repo quality gates**

Run:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm check
```

Expected: all commands exit 0.

- [ ] **Step 3: Run local generated-config validation**

Run from the repo root:

```bash
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-vm-mcp-portal-dx.XXXXXX")"
(
	cd "$tmp_dir"
	pnpm exec agent-vm init beta --type openclaw --secrets environment --paths local --overwrite
)
pnpm exec agent-vm validate --config "$tmp_dir/config/system.jsonc"
```

Expected:

```text
"ok": true
```

Then inspect:

```bash
node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify(cfg.profiles.default.namespaces,null,2));' "$tmp_dir/config/gateways/beta/mcp-portal.config.jsonc"
```

Expected output contains `deepwiki.tools.enabled` and no `enabledNamespaces`.

- [ ] **Step 4: Install local packages into beta without publishing**

From the agent-vm repo root:

```bash
pnpm build
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-vm-local-beta-packages.XXXXXX")"
mkdir -p tmp
printf '%s\n' "$pack_dir" > tmp/local-beta-packages-dir
pnpm --filter @agent-vm/secret-management pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/gondolin-adapter pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/gateway-interface pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/openclaw-gateway pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/worker-gateway pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/openclaw-agent-vm-plugin pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/agent-vm-worker pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/config-contracts pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/mcp-portal pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/agent-vm pack --pack-destination "$pack_dir"
ls -1 "$pack_dir"
```

Expected: one `.tgz` tarball for each `@agent-vm/*` package.

From `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`, install the local tarballs:

```bash
pack_dir="$(cat /Users/shravansunder/Documents/dev/project-dev/agent-vm.fix-mcp-portal-profile-dx/tmp/local-beta-packages-dir)"
node - "$pack_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const packDir = process.argv[2];
const packageJsonPath = path.resolve('package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
const packages = [
	'@agent-vm/agent-vm',
	'@agent-vm/agent-vm-worker',
	'@agent-vm/config-contracts',
	'@agent-vm/gateway-interface',
	'@agent-vm/gondolin-adapter',
	'@agent-vm/mcp-portal',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/openclaw-gateway',
	'@agent-vm/openclaw-mcp-portal-plugin',
	'@agent-vm/secret-management',
	'@agent-vm/worker-gateway',
];

function tarballForPackage(packageName) {
	const unscoped = packageName.replace('@agent-vm/', '');
	const prefix = `agent-vm-${unscoped}-`;
	const match = tarballs.find((name) => name.startsWith(prefix));
	if (match === undefined) {
		throw new Error(`Missing local tarball for ${packageName}`);
	}
	return `file:${path.join(packDir, match)}`;
}

packageJson.dependencies ??= {};
packageJson.dependencies['@agent-vm/agent-vm'] = tarballForPackage('@agent-vm/agent-vm');
packageJson.pnpm ??= {};
packageJson.pnpm.overrides ??= {};
for (const packageName of packages) {
	packageJson.pnpm.overrides[packageName] = tarballForPackage(packageName);
}
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`);
NODE
pnpm install --force
pnpm list @agent-vm/agent-vm @agent-vm/mcp-portal @agent-vm/openclaw-mcp-portal-plugin --depth 0
node -e 'const p=require("./package.json"); for (const [name, spec] of Object.entries(p.pnpm.overrides)) { if (name.startsWith("@agent-vm/") && !String(spec).startsWith("file:")) throw new Error(`${name} did not resolve to local file tarball: ${spec}`); }'
```

Expected: beta `package.json` dependency and `pnpm.overrides` resolve every `@agent-vm/*` package to the just-packed local tarballs, without publishing a new npm package version.

- [ ] **Step 5: Update beta MCP Portal config**

From `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`, edit the beta MCP Portal config directly to the new authored profile shape:

```bash
pnpm exec agent-vm validate --config config/system.jsonc
```

Expected: `config/gateways/beta/mcp-portal.config.jsonc` now uses `profiles.*.namespaces.*`, and static validation returns `"ok": true`.

- [ ] **Step 6: Run beta live validation with real secrets**

From `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta` after updating beta config to the new authored shape:

```bash
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
```

Expected:

```text
"ok": true
```

If a provider fails, expected failure hints include:

```text
namespace
phase
transport
hint
```

For Tavily remote MCP, expected actual tool names are:

```text
tavily_search
tavily_extract
tavily_crawl
tavily_map
tavily_research
```

- [ ] **Step 7: Restart beta and ask Pulse to test plugin behavior**

Restart beta with the repo-native command used by the deployment. Then verify:

```bash
curl -fsS http://127.0.0.1:18900/health
curl -fsS http://127.0.0.1:18900/zones/beta/health
```

Expected: both commands return healthy JSON.

In beta Discord, ask Pulse to run:

```text
mcp_portal_list for deepwiki, tavily, perplexity, firecrawl
mcp_portal_describe for tavily.tavily_search
mcp_portal_call tavily.tavily_search with a harmless query
```

Expected:

```text
OpenClaw plugin mode returns details.auditEvents when degraded.
OpenClaw plugin mode returns details.structuredContent.diagnostics when degraded.
Successful Tavily search returns a normal result with ok true.
```

- [ ] **Step 8: Test direct/non-plugin MCP proxy diagnostics**

Run a local proxy validation using an intentionally bad provider config and verify:

```text
CallToolResult.content[0].text is JSON.
JSON.auditEvents[0].kind is upstream_mcp_failed.
JSON.auditEvents[0].hint is actionable.
CallToolResult.isError is true only for failed calls, not partial discovery degradation.
```

- [ ] **Step 9: Final commit**

```bash
git status --short
git add .
git commit -m "feat: improve MCP Portal diagnostics and profile DX"
```

---

## Self-Review

### Spec Coverage

- Per-namespace config DX is covered by Task 5 and Task 7.
- Structured provider failures are covered by Task 1 and Task 2.
- Discovery diagnostics through `mcp_portal_list`, `search`, `describe`, and `call` are covered by Task 3.
- OpenClaw plugin surface is covered by Task 4 and Task 8.
- Direct/non-plugin MCP proxy surface is covered by Task 4 and Task 8.
- Live validation that catches wrong package/bin/tool names is covered by Task 6 and Task 8.
- Generated defaults and docs are covered by Task 7.

### Placeholder Scan

The plan has no deferred implementation markers and no instruction to add unspecified error handling. Each task names exact files, exact tests, exact code shapes, and exact verification commands.

### Type Consistency

- Runtime failures use `UpstreamMcpFailureDetails`.
- Session discovery uses `PortalDiscoveryFailure`.
- Tool responses use `PortalBatchDiagnostic`.
- Core output uses `PortalAuditEvent`.
- Authored config uses `profiles.*.namespaces.*`.
- Internal compiled config remains `ResolvedMcpPortalProfile`.
