# MCP Portal Subprocess Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the MCP Portal out of OpenClaw's in-process plugin route into a standalone Hono HTTP MCP server subprocess. The remaining OpenClaw plugin shrinks to a supervisor + two hooks (policy denial and approval-token attach). Each agent gets its own URL path and its own HMAC key.

**Architecture:** Portal runs as a subprocess inside the gateway VM, listening on `127.0.0.1:18790`. URL shape is `/agents/<agentId>/mcp` with one path per agent declared in `system.jsonc`. Each agent path has a fresh per-boot HMAC key passed to the portal via spawn env. The plugin keeps `before_tool_call` for static policy denial and for attaching HMAC-signed approval tokens through OpenClaw's existing interactive approval UI. The plugin keeps `before_prompt_build` for profile-scoped discovery hints. The `registerHttpRoute` + `runtime.app.fetch` loopback is deleted in a hard cutover.

**Tech Stack:** TypeScript, Hono, `@modelcontextprotocol/sdk` (Streamable HTTP server transport), Node `child_process`, Node `crypto` (HMAC-SHA256), Zod 4, Vitest, OXC tooling.

**Prerequisite (load-bearing):** This plan layers on top of
[`docs/superpowers/plans/2026-05-12-mcp-portal-schema-config-migration.md`](2026-05-12-mcp-portal-schema-config-migration.md).
Do not start this plan until that one is merged. The dependencies below are not
optional — every type, module, file path, and config field listed is created by
the config migration plan, and this plan imports them by name without
redefining them.

What this plan consumes from the config migration plan:

| Symbol / file                                                              | Defined in config plan task | Used here in tasks                              |
|---------------------------------------------------------------------------|------------------------------|--------------------------------------------------|
| `packages/agent-vm/src/config/system-config.ts` → `zones[].agents`        | Task that adds `zones[].agents` to `SystemConfigSchema` | Task 9 validates OpenClaw/system agent consistency |
| `packages/agent-vm/src/config/system-config.ts` → `zones[].mcp.configDir` | Same task                    | Task 7/8/9 pass the config folder to the portal subprocess |
| `@agent-vm/config-contracts` → `loadMcpConfig`, `loadMcpPortalConfig`, `resolveMcpPortalProfile` | Task that creates the shared MCP Portal config package | Task 7 (boots portal with it), Task 10/11 (lazy-loaded in handlers) |
| `@agent-vm/config-contracts` → `McpConfig`, `McpPortalConfig`, `ResolvedMcpPortalProfile` | Same task                  | Tasks 7, 10, 11 import these types directly       |
| Generated `mcp.servers.mcp_portal_<agentId>` entries written by `agent-vm init` | Task that updates `init-command.ts` to emit per-agent entries | Task 13 (replace generated URLs with `/agents/<id>/mcp` shape) |
| `config/gateways/<zone>/mcp.config.jsonc` provider catalog                 | Task that defines `mcp.config.jsonc` schema | Task 7 (portal reads upstream providers)          |
| `config/gateways/<zone>/mcp-portal.config.jsonc` portal agent/profile catalog | Task that defines `mcp-portal.config.jsonc` schema | Tasks 7, 10, 11 consume agent profile assignments and profile fields |
| Profile fields: `enabledNamespaces`, `enabledToolsByNamespace`, `hiddenToolsByNamespace`, `approval.alwaysAskTools`, `approval.allowWithoutApprovalTools`, `approval.annotationPolicy`, `promptContext.enabled`, `promptContext.maxNamespaces` | mcp-portal config schema task | Task 5 (portal token enforcement), Task 10 (policy + approval), Task 11 (prompt hint) |
| `mcp-portal.config.jsonc` → `agents.<agentId>.profile`                    | mcp-portal config task       | Tasks 7, 9, 10, 11 (agent → profile lookup)      |

If you arrive at a task and discover one of these is missing, that's a sign the
prerequisite plan has not actually landed yet — stop and complete it first
rather than building a parallel definition here.

---

## Current Evidence To Preserve

Read these before starting. They are the load-bearing facts the plan rests on:

- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts:941-1006` is the current plugin entrypoint. It calls `api.registerHttpRoute({ path: '/mcp-portal', ... })` and proxies into `runtime.app.fetch(...)`. This entire path is deleted in Task 13.
- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts:94` hardcodes `defaultGatewayBaseUrl = 'http://127.0.0.1:18789'` for the loopback URL. The new design points to `http://127.0.0.1:18790`.
- `packages/mcp-portal/src/mcp-server/portal-http-server.ts` already implements the Hono MCP app via `createPortalHttpApp(...)`. The new portal binary boots THIS app on its own listener; the app itself is refactored, not rewritten.
- `packages/mcp-portal/src/portal-session.ts` owns per-agent session state. New code keys session state on `agentId` from the URL path, with optional transport-session scoping.
- `packages/openclaw-mcp-portal-plugin/src/portal-server-manager.ts` owns the per-process portal runtime. It is replaced by a subprocess supervisor in Task 8.
- `packages/agent-vm/src/controller/leases/tcp-pool.ts:9-33` defines tool VM TCP port slots starting at `tcpPool.basePort` (default 19000). The portal MUST listen outside that range. We pick 18790.
- OpenClaw `OpenClawPluginService.start: (ctx) => void | Promise<void>` (verified in `openclaw/src/plugins/types.ts:2181`). `startPluginServices` awaits each `service.start()` sequentially (`openclaw/src/plugins/services.ts:70`). MCP clients init LAZILY on first tool dispatch (`openclaw/src/agents/pi-bundle-mcp-runtime.ts:205-241`), so spawning the portal in `service.start()` is guaranteed to complete before any MCP call is attempted.
- OpenClaw MCP server config (`openclaw/src/config/types.mcp.ts`) accepts only `stdio` or `url + transport`. There is no in-process registration API.
- OpenClaw does NOT consume MCP `prompts/list` (zero hits for `listPrompts` / `getPrompt` in `openclaw/src/agents`). Discovery via MCP prompts is not viable today. We use `before_prompt_build` instead.
- OpenClaw does NOT consume MCP `elicitation/create` either (zero hits for "elicit" in `openclaw/src`). Approval must still flow through `before_tool_call` + OpenClaw's approval UI.

## Architectural Decisions

These are locked. Do not re-derive during execution:

1. **URL shape:** `http://127.0.0.1:18790/agents/<agentId>/mcp`. No `/bindings/` prefix. `<agentId>` is the MCP Portal agent name from `mcp-portal.config.jsonc`.
2. **Portal access header:** Every MCP request to `/agents/<agentId>/mcp` must include the configured `mcp-portal.config.jsonc` `server.accessHeader`. This is transport access control. It is separate from approval HMAC tokens.
3. **Per-agent HMAC keys:** Random 32-byte keys generated per plugin boot. Passed to portal subprocess via env vars `PORTAL_HMAC_KEY__<agentId>=<hex>`. Lost across restarts; in-flight approval tokens become invalid (acceptable — they're short-lived).
4. **HMAC token shape:** Base64URL of `JSON.stringify({ agentId, calls, exp })` joined to base64URL of `hmac_sha256(key, payload)` by `.`. Carried in `event.params.portalApprovalToken`. Verified before any upstream call.
5. **Approval surface:** OpenClaw's existing `requireApproval` mechanism (UI appears wherever the user's MCP/agent client is — Claude Code, Discord, etc.). No elicitation, no separate UI.
6. **Policy denial:** Profile's `enabledNamespaces` / `enabledToolsByNamespace` / `hiddenToolsByNamespace` (from `mcp-portal.config.jsonc`) is enforced in the plugin's `before_tool_call` hook BEFORE attempting approval. Denied calls return `{ block: true, blockReason }`.
7. **Discovery hint:** `before_prompt_build` hook reads the agent's profile from `mcp-portal.config.jsonc`, lists allowed namespaces with tool counts, returns a short prompt fragment. Same shape as today's `getPromptContext` but driven by profile config.
8. **Upstream credentials:** Provider credentials live in `mcp.config.jsonc`, not in profiles and not in `system.jsonc`. Profiles in `mcp-portal.config.jsonc` only select namespaces/tools and policy. Resolution path follows the existing SecretResolver pattern (1Password / env). Portal reads these refs at boot.
9. **Port:** 18790. Validated at plugin boot to be outside `[tcpPool.basePort, tcpPool.basePort + tcpPool.size)`.
10. **Crash policy:** Plugin's subprocess supervisor watches `exit`, restarts with exponential backoff (200ms, 400ms, 800ms, capped at 5s). After 5 consecutive failures, emit a critical diagnostic and stop restart attempts. The MCP client will get connect-refused; admin must intervene.
11. **Hard cutover:** No backward compatibility. The current `registerHttpRoute` + `runtime.app.fetch` path is deleted in one task. No feature flag, no shim.

## File Structure

**Create:**
- `packages/mcp-portal/src/auth/hmac-token.ts` — sign/verify HMAC-SHA256 tokens.
- `packages/mcp-portal/src/auth/hmac-token.test.ts`
- `packages/mcp-portal/src/bin/portal-server.ts` — standalone server entrypoint.
- `packages/mcp-portal/src/bin/portal-server.test.ts` — integration smoke test booting the binary.
- `packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.ts` — per-agent HMAC key generation + env serialization.
- `packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts` — spawn, health-check, restart-with-backoff.
- `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts` — shared plugin-local runtime state for config dir, generated HMAC keys, and lazy config loads.
- `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts` — OpenClaw `before_tool_call` policy gate and approval-token injector.
- `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.ts` — OpenClaw `before_prompt_build` progressive-disclosure context injector.
- `packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.test.ts`

**Modify:**
- `packages/mcp-portal/src/mcp-server/portal-http-server.ts` — switch routing key from a path-segment binding ID to `agentId`. Replace per-binding header auth with one portal access header from `mcp-portal.config.jsonc`. Add HMAC-token verification in the `mcp_portal_call` tool body. Drop host-supplied binding lookup. Consumes `McpConfig`, `McpPortalConfig`, and `ResolvedMcpPortalProfile` from `@agent-vm/config-contracts`.
- `packages/mcp-portal/src/mcp-server/portal-tools.ts` (and `.test.ts`) — `mcp_portal_call` verifies root-level `portalApprovalToken` when the profile's approval policy requires it.
- `packages/mcp-portal/src/portal-session.ts` — session key is `agentScopeId + transportSessionId`.
- `packages/mcp-portal/src/portal-access-policy.ts` — use branded `PortalAgentIdentity`; remove binding-keyed lookups.
- `packages/mcp-portal/package.json` — add `bin` map entry: `"agent-vm-mcp-portal-server": "./dist/bin/portal-server.js"`.
- `packages/mcp-portal/tsdown.config.ts` — add `src/bin/portal-server.ts` to entry points.
- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts` — DELETE `registerHttpRoute` block, DELETE `createRequestFromIncomingMessage`/`writeFetchResponseToServerResponse`, DELETE `runtime.app.fetch` plumbing. ADD `registerService` that drives the new `PortalSubprocessSupervisor`. KEEP `before_tool_call` and `before_prompt_build` registrations but rewrite their handlers to use HMAC tokens + profile config.
- `packages/openclaw-mcp-portal-plugin/src/portal-server-manager.ts` — DELETE (replaced by supervisor + remote portal).
- `packages/openclaw-mcp-portal-plugin/src/portal-server-manager.test.ts` — DELETE.
- `vm-images/openclaw-gateway/build-config.jsonc` (or equivalent recipe file) — copy the portal binary into `/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server` at image build time.
- `docs/subsystems/mcp-portal.md` — rewrite runtime/transport section to describe the subprocess architecture.
- `docs/architecture/openclaw-gateway.md` — update the "MCP Portal Bindings" section.

**Delete (hard cutover):**
- `packages/openclaw-mcp-portal-plugin/src/portal-server-manager.ts` and its test.
- All `createRequestFromIncomingMessage` / `writeFetchResponseToServerResponse` / `createResponseDrainWait` helpers in `plugin-registration.ts`.
- The `path: '/mcp-portal'` route registration.

---

### Task 1: HMAC token sign/verify utility

**Files:**
- Create: `packages/mcp-portal/src/auth/hmac-token.ts`
- Create: `packages/mcp-portal/src/auth/hmac-token.test.ts`

The token format is `<payload-b64url>.<sig-b64url>` where payload is JSON `{ agentId, calls, exp }` and sig is HMAC-SHA256(key, payload-b64url) encoded as base64url. `calls` is a deterministic projection used to bind the token to specific tool calls: `[{ namespace, toolName, argumentsHash }]` where `argumentsHash` is SHA-256 of canonical JSON of the call arguments. `exp` is unix ms.

- [ ] **Step 1: Write failing tests**

Create `packages/mcp-portal/src/auth/hmac-token.test.ts` with:

```typescript
import { describe, expect, it } from 'vitest';
import {
	hashCallArguments,
	signApprovalToken,
	verifyApprovalToken,
	type ApprovalTokenCallBinding,
} from './hmac-token.js';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

const sampleBinding: ApprovalTokenCallBinding = {
	namespace: 'linear',
	toolName: 'create_issue',
	argumentsHash: hashCallArguments({ title: 'hi', team: 'core' }),
};

describe('hashCallArguments', () => {
	it('is deterministic regardless of property order', () => {
		const a = hashCallArguments({ a: 1, b: 2 });
		const b = hashCallArguments({ b: 2, a: 1 });
		expect(a).toBe(b);
	});

	it('differs when values differ', () => {
		expect(hashCallArguments({ a: 1 })).not.toBe(hashCallArguments({ a: 2 }));
	});
});

describe('signApprovalToken / verifyApprovalToken', () => {
	it('verifies a freshly signed token', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			expiresAtMs: Date.now() + 60_000,
			key: TEST_KEY,
		});
		const result = verifyApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			key: TEST_KEY,
			nowMs: Date.now(),
			token,
		});
		expect(result.ok).toBe(true);
	});

	it('rejects wrong key', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			expiresAtMs: Date.now() + 60_000,
			key: TEST_KEY,
		});
		const result = verifyApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			key: Buffer.from('different-key-different-key-aaaa', 'utf8'),
			nowMs: Date.now(),
			token,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('signature-mismatch');
	});

	it('rejects expired token', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			expiresAtMs: 1_000,
			key: TEST_KEY,
		});
		const result = verifyApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			key: TEST_KEY,
			nowMs: 5_000,
			token,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('expired');
	});

	it('rejects when agentId does not match', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			expiresAtMs: Date.now() + 60_000,
			key: TEST_KEY,
		});
		const result = verifyApprovalToken({
			agentId: 'alevtina',
			calls: [sampleBinding],
			key: TEST_KEY,
			nowMs: Date.now(),
			token,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('agent-mismatch');
	});

	it('rejects when call binding differs', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			expiresAtMs: Date.now() + 60_000,
			key: TEST_KEY,
		});
		const other: ApprovalTokenCallBinding = {
			...sampleBinding,
			toolName: 'delete_issue',
		};
		const result = verifyApprovalToken({
			agentId: 'shravan',
			calls: [other],
			key: TEST_KEY,
			nowMs: Date.now(),
			token,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('call-mismatch');
	});

	it('rejects garbage tokens', () => {
		const result = verifyApprovalToken({
			agentId: 'shravan',
			calls: [sampleBinding],
			key: TEST_KEY,
			nowMs: Date.now(),
			token: 'not.a.valid.token',
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('malformed');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/mcp-portal/src/auth/hmac-token.test.ts`

Expected: FAIL with module-not-found error for `./hmac-token.js`.

- [ ] **Step 3: Implement hmac-token.ts**

Create `packages/mcp-portal/src/auth/hmac-token.ts`:

```typescript
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface ApprovalTokenCallBinding {
	readonly namespace: string;
	readonly toolName: string;
	readonly argumentsHash: string;
}

interface ApprovalTokenPayload {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallBinding[];
	readonly exp: number;
}

export interface SignApprovalTokenProps {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallBinding[];
	readonly expiresAtMs: number;
	readonly key: Buffer;
}

export interface VerifyApprovalTokenProps {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallBinding[];
	readonly key: Buffer;
	readonly nowMs: number;
	readonly token: string;
}

export type VerifyApprovalTokenResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason:
				| 'malformed'
				| 'signature-mismatch'
				| 'expired'
				| 'agent-mismatch'
				| 'call-mismatch';
	  };

function base64UrlEncode(value: Buffer | string): string {
	const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
	return buffer.toString('base64url');
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
	return `{${entries.join(',')}}`;
}

export function hashCallArguments(args: unknown): string {
	return createHash('sha256').update(canonicalize(args)).digest('base64url');
}

export function signApprovalToken(props: SignApprovalTokenProps): string {
	const payload: ApprovalTokenPayload = {
		agentId: props.agentId,
		calls: props.calls,
		exp: props.expiresAtMs,
	};
	const payloadEncoded = base64UrlEncode(canonicalize(payload));
	const sig = createHmac('sha256', props.key).update(payloadEncoded).digest('base64url');
	return `${payloadEncoded}.${sig}`;
}

function parseToken(token: string): ApprovalTokenPayload | null {
	const parts = token.split('.');
	if (parts.length !== 2) {
		return null;
	}
	try {
		const raw = Buffer.from(parts[0], 'base64url').toString('utf8');
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			typeof (parsed as ApprovalTokenPayload).agentId !== 'string' ||
			typeof (parsed as ApprovalTokenPayload).exp !== 'number' ||
			!Array.isArray((parsed as ApprovalTokenPayload).calls)
		) {
			return null;
		}
		return parsed as ApprovalTokenPayload;
	} catch {
		return null;
	}
}

export function verifyApprovalToken(props: VerifyApprovalTokenProps): VerifyApprovalTokenResult {
	const parts = props.token.split('.');
	if (parts.length !== 2) {
		return { ok: false, reason: 'malformed' };
	}
	const [payloadEncoded, providedSig] = parts;
	const expectedSig = createHmac('sha256', props.key).update(payloadEncoded).digest();
	const providedBuf = Buffer.from(providedSig, 'base64url');
	if (providedBuf.length !== expectedSig.length || !timingSafeEqual(providedBuf, expectedSig)) {
		return { ok: false, reason: 'signature-mismatch' };
	}
	const payload = parseToken(props.token);
	if (!payload) {
		return { ok: false, reason: 'malformed' };
	}
	if (payload.exp <= props.nowMs) {
		return { ok: false, reason: 'expired' };
	}
	if (payload.agentId !== props.agentId) {
		return { ok: false, reason: 'agent-mismatch' };
	}
	if (payload.calls.length !== props.calls.length) {
		return { ok: false, reason: 'call-mismatch' };
	}
	for (let i = 0; i < payload.calls.length; i += 1) {
		const a = payload.calls[i];
		const b = props.calls[i];
		if (
			a.namespace !== b.namespace ||
			a.toolName !== b.toolName ||
			a.argumentsHash !== b.argumentsHash
		) {
			return { ok: false, reason: 'call-mismatch' };
		}
	}
	return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/mcp-portal/src/auth/hmac-token.test.ts`

Expected: 7 tests pass.

- [ ] **Step 5: Lint, format, typecheck**

Run: `pnpm oxlint packages/mcp-portal/src/auth/ && pnpm oxfmt packages/mcp-portal/src/auth/`

Run: `pnpm typecheck`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-portal/src/auth/
git commit -m "feat(mcp-portal): add HMAC-SHA256 approval token utility"
```

---

### Task 2: Per-agent HMAC key registry (plugin side)

**Files:**
- Create: `packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.test.ts`

The registry holds one 32-byte random key per agent, generated at plugin boot. It exposes `getKey(agentId)` for the plugin (used when signing approval tokens) and `serializeForEnv()` which returns `Record<string, string>` ready to merge into the subprocess `env`.

- [ ] **Step 1: Write failing tests**

Create `packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseHmacKeysFromEnv } from '@agent-vm/mcp-portal';
import { createHmacKeyRegistry } from './hmac-key-registry.js';

describe('createHmacKeyRegistry', () => {
	it('generates one key per agent', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['shravan', 'alevtina'] });
		expect(registry.agentIds).toEqual(['shravan', 'alevtina']);
		expect(registry.getKey('shravan').length).toBe(32);
		expect(registry.getKey('alevtina').length).toBe(32);
	});

	it('generates DIFFERENT keys for each agent', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['a', 'b'] });
		expect(registry.getKey('a').equals(registry.getKey('b'))).toBe(false);
	});

	it('throws when asking for an unknown agent', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['shravan'] });
		expect(() => registry.getKey('alevtina')).toThrow(/unknown agent/i);
	});

	it('serializes to env-var record', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['shravan'] });
		const env = registry.serializeForEnv();
		expect(Object.keys(env)).toEqual(['PORTAL_HMAC_KEY__shravan']);
		expect(env.PORTAL_HMAC_KEY__shravan).toMatch(/^[0-9a-f]{64}$/);
	});

	it('handles agent IDs with hyphens by replacing with double-underscore separator', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['agent-a'] });
		const env = registry.serializeForEnv();
		expect(Object.keys(env)).toEqual(['PORTAL_HMAC_KEY__agent-a']);
	});
});

describe('parseHmacKeysFromEnv', () => {
	it('parses serialized keys back to a Map', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['shravan', 'alev'] });
		const env = registry.serializeForEnv();
		const parsed = parseHmacKeysFromEnv(env);
		expect(parsed.get('shravan')?.equals(registry.getKey('shravan'))).toBe(true);
		expect(parsed.get('alev')?.equals(registry.getKey('alev'))).toBe(true);
	});

	it('ignores unrelated env vars', () => {
		const parsed = parseHmacKeysFromEnv({ NODE_ENV: 'production', HOME: '/root' });
		expect(parsed.size).toBe(0);
	});

	it('throws on malformed key hex', () => {
		expect(() => parseHmacKeysFromEnv({ PORTAL_HMAC_KEY__shravan: 'not-hex' })).toThrow(
			/PORTAL_HMAC_KEY__shravan/,
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.test.ts`

Expected: module not found.

- [ ] **Step 3: Implement hmac-key-registry.ts**

Create `packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.ts`:

```typescript
import { randomBytes } from 'node:crypto';

const ENV_PREFIX = 'PORTAL_HMAC_KEY__';
const KEY_BYTES = 32;

export interface CreateHmacKeyRegistryProps {
	readonly agentIds: readonly string[];
}

export interface HmacKeyRegistry {
	readonly agentIds: readonly string[];
	readonly getKey: (agentId: string) => Buffer;
	readonly serializeForEnv: () => Record<string, string>;
}

export function createHmacKeyRegistry(props: CreateHmacKeyRegistryProps): HmacKeyRegistry {
	const keys = new Map<string, Buffer>();
	for (const agentId of props.agentIds) {
		keys.set(agentId, randomBytes(KEY_BYTES));
	}
	return {
		agentIds: [...props.agentIds],
		getKey: (agentId) => {
			const key = keys.get(agentId);
			if (!key) {
				throw new Error(`HMAC key registry: unknown agent "${agentId}".`);
			}
			return key;
		},
		serializeForEnv: () => {
			const out: Record<string, string> = {};
			for (const [agentId, key] of keys) {
				out[`${ENV_PREFIX}${agentId}`] = key.toString('hex');
			}
			return out;
		},
	};
}

// parseHmacKeysFromEnv lives in packages/mcp-portal/src/auth/hmac-env.ts and is
// exported by @agent-vm/mcp-portal. The plugin imports it from the portal package
// in tests only; production plugin code only generates per-boot keys and serializes
// them for the subprocess environment.
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.test.ts`

Expected: 7 tests pass.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm oxlint packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.* && pnpm typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-mcp-portal-plugin/src/hmac-key-registry.*
git commit -m "feat(openclaw-portal-plugin): add per-agent HMAC key registry"
```

---

### Task 3: Refactor portal session/policy to be agent-scope keyed

**Files:**
- Modify: `packages/mcp-portal/src/portal-session.ts`
- Modify: `packages/mcp-portal/src/portal-access-policy.ts`
- Modify: `packages/mcp-portal/src/portal-session.test.ts`

Today the portal keys session state by generated binding IDs. With agent-in-path,
the agent ID is the routing key, and session/runtime caches use `agentScopeId`
plus optional transport session ID. Replace the old binding identity type with a
branded `PortalAgentIdentity`.

- [ ] **Step 1: Read current shapes**

Read both files end-to-end. Confirm the field name. The structural rename should
be straightforward but the test fixtures embed old scope strings — update them
too.

- [ ] **Step 2: Update test fixtures FIRST (TDD)**

In `packages/mcp-portal/src/portal-session.test.ts`, rename every old binding
literal to `agentScopeId` and every test description that says "binding" to
"agent scope". Run tests to confirm they fail in the expected way:

Run: `pnpm vitest run packages/mcp-portal/src/portal-session.test.ts`

Expected: type errors and assertion mismatches on old binding references.

- [ ] **Step 3: Update portal-session.ts**

In `packages/mcp-portal/src/portal-session.ts`, replace every binding ID field
with `agentScopeId: string`. Update the session key generator from the old
binding key to `${agentScopeId}\\n${transportSessionId}`. Keep `getSession` and
`invalidateSession`, and rename the scope teardown API to
`invalidateAgentScope(agentScopeId)`.

- [ ] **Step 4: Update portal-access-policy.ts**

In `packages/mcp-portal/src/portal-access-policy.ts`, replace binding-keyed
lookups with `agentId` and branded `PortalAgentIdentity`. The policy already
takes agent-facing config — confirm callers pass the agent ID from the route.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run packages/mcp-portal/src/portal-session.test.ts packages/mcp-portal/src/portal-access-policy.ts`

Run: `pnpm typecheck`

Fix any remaining type errors by following the rename through call sites.

Expected: tests pass; typecheck clean except for callers we have not yet updated (those land in Tasks 4 and 10).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-portal/src/portal-session.* packages/mcp-portal/src/portal-access-policy.ts
git commit -m "refactor(mcp-portal): key portal sessions by agentId"
```

---

### Task 4: Switch portal Hono app routing to /agents/:agentId/mcp

**Files:**
- Modify: `packages/mcp-portal/src/mcp-server/portal-http-server.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-http-server.test.ts`

- [ ] **Step 1: Update tests to use new path**

In `portal-http-server.test.ts`, search for every legacy `/mcp-portal/bindings/`
route and replace with `/agents/`. Replace old binding test variable names with
agent/agent-scope identity claims.

Run: `pnpm vitest run packages/mcp-portal/src/mcp-server/portal-http-server.test.ts`

Expected: tests fail — current code routes `/mcp-portal/bindings/:bindingId/mcp`.

- [ ] **Step 2: Refactor portal-http-server.ts route**

In `portal-http-server.ts`, change the Hono route from:

```typescript
app.all('/mcp-portal/bindings/:bindingId/mcp', async (c) => { ... })
```

to:

```typescript
app.all('/agents/:agentId/mcp', async (c) => { ... })
```

Inside the handler, replace `const bindingId = c.req.param('bindingId')` with `const agentId = c.req.param('agentId')`. Replace every downstream use of the parameter accordingly. The `getBinding(...)` callback that the host plugin previously supplied is renamed to `resolveAgentIdentity(agentId): AgentIdentity | null` and returns the resolved profile + HMAC verifier closure for that agent.

The new `AgentIdentity` shape:

```typescript
export interface AgentIdentity {
	readonly agentId: string;
	readonly profileName: string;
	readonly verifyApprovalToken: (props: {
		readonly token: string;
		readonly calls: readonly { namespace: string; toolName: string; argumentsHash: string }[];
		readonly nowMs: number;
	}) => VerifyApprovalTokenResult;
}
```

(import `VerifyApprovalTokenResult` from Task 1).

- [ ] **Step 3: Replace binding-secret gate with portal access-header gate**

The old design used a per-binding `x-mcp-portal-binding-secret`. Delete that binding-specific check, but keep a single portal-server access header loaded from `mcp-portal.config.jsonc` `server.accessHeader`.

Add `serverAccess` to `createPortalHttpApp` props:

```typescript
export interface PortalServerAccess {
	readonly headerName: string;
	readonly expectedValue: string;
}
```

At the start of the `/agents/:agentId/mcp` handler:

```typescript
const providedSecret = c.req.header(props.serverAccess.headerName);
if (providedSecret !== props.serverAccess.expectedValue) {
	return c.json({ ok: false, error: { kind: 'unauthorized' } }, 401);
}
```

Tests must cover:

- Missing portal access header returns `401`.
- Wrong portal access header returns `401`.
- Correct portal access header reaches `resolveAgentIdentity(agentId)`.

Keep the route check that returns 404 when `resolveAgentIdentity` returns null.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run packages/mcp-portal/src/mcp-server/`

Run: `pnpm typecheck`

Expected: portal-http-server tests pass. Other test files in `mcp-portal/` may still type-error if they refer to the old factory shape — fix call sites in those tests too.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-portal/src/mcp-server/
git commit -m "refactor(mcp-portal): expose /agents/:agentId/mcp route shape"
```

---

### Task 5: Add HMAC token verification to mcp_portal_call

**Files:**
- Modify: `packages/mcp-portal/src/mcp-server/portal-tools.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-tools.test.ts`

The `mcp_portal_call` tool body, after policy check and before upstream dispatch, calls `agentIdentity.verifyApprovalToken({ token, calls, nowMs })` for every batch where the resolved profile says "approval required." If verification fails, return a per-call error with reason `approval-token-invalid:<reason>` (e.g. `approval-token-invalid:expired`). Tools that the profile marks "allow without approval" do not require a token at all.

The token comes from root-level `params.portalApprovalToken` (a string) beside
the `calls` array, not from any upstream tool argument object. If missing when
required, return `approval_token_missing`.

- [ ] **Step 1: Write failing tests**

Add to `portal-tools.test.ts`:

```typescript
import { hashCallArguments, signApprovalToken } from '../auth/hmac-token.js';

describe('mcp_portal_call approval token enforcement', () => {
	const key = Buffer.from('11111111111111111111111111111111', 'utf8');

	function buildIdentity(): AgentIdentity {
		return {
			agentId: 'shravan',
			profileName: 'builder',
			verifyApprovalToken: ({ token, calls, nowMs }) =>
				verifyApprovalToken({
					agentId: 'shravan',
					calls,
					key,
					nowMs,
					token,
				}),
		};
	}

	it('returns approval-token-missing when profile requires approval but none provided', async () => {
		// Arrange: profile marks linear.create_issue as alwaysAskTools.
		const runtime = createTestRuntimeWithApprovalRequiredTool();
		// Act
		const result = await runtime.callPortalCall({
			identity: buildIdentity(),
			calls: [{ id: '1', namespace: 'linear', toolName: 'create_issue', arguments: {} }],
		});
		// Assert
		expect(result.results['1'].ok).toBe(false);
		expect(result.results['1'].error).toContain('approval-token-missing');
	});

	it('accepts a valid token and proceeds to upstream', async () => {
		const args = { title: 'hi' };
		const calls = [
			{
				namespace: 'linear',
				toolName: 'create_issue',
				argumentsHash: hashCallArguments(args),
			},
		];
		const token = signApprovalToken({
			agentId: 'shravan',
			calls,
			expiresAtMs: Date.now() + 60_000,
			key,
		});
		const runtime = createTestRuntimeWithApprovalRequiredTool();
			const result = await runtime.callPortalCall({
				identity: buildIdentity(),
				portalApprovalToken: token,
				calls: [
					{
						id: '1',
						namespace: 'linear',
						toolName: 'create_issue',
						arguments: args,
					},
				],
			});
		expect(result.results['1'].ok).toBe(true);
	});

	it('rejects expired tokens with approval-token-invalid:expired', async () => {
		const args = { title: 'hi' };
		const calls = [
			{
				namespace: 'linear',
				toolName: 'create_issue',
				argumentsHash: hashCallArguments(args),
			},
		];
		const token = signApprovalToken({
			agentId: 'shravan',
			calls,
			expiresAtMs: Date.now() - 1_000,
			key,
		});
		const runtime = createTestRuntimeWithApprovalRequiredTool();
			const result = await runtime.callPortalCall({
				identity: buildIdentity(),
				portalApprovalToken: token,
				calls: [
					{
						id: '1',
						namespace: 'linear',
						toolName: 'create_issue',
						arguments: args,
					},
				],
			});
		expect(result.results['1'].ok).toBe(false);
		expect(result.results['1'].error).toContain('approval-token-invalid:expired');
	});

	it('does not require token for tools in allowWithoutApprovalTools', async () => {
		const runtime = createTestRuntimeWithReadonlyTool();
		const result = await runtime.callPortalCall({
			identity: buildIdentity(),
			calls: [{ id: '1', namespace: 'linear', toolName: 'list_issues', arguments: {} }],
		});
		expect(result.results['1'].ok).toBe(true);
	});
});
```

The helper `createTestRuntimeWithApprovalRequiredTool()` (and the readonly variant) live in the existing test scaffolding. If absent, create them adjacent to existing builders in the same file — keep the test arrangement compact.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/mcp-portal/src/mcp-server/portal-tools.test.ts -t "approval token enforcement"`

Expected: FAIL — no token check exists yet.

- [ ] **Step 3: Implement token enforcement in portal-tools.ts**

Inside the `mcp_portal_call` handler, after policy resolution and before calling upstream:

```typescript
const approvalDecisions = resolveApprovalDecisions({
	calls,
	profile,
});

const requiringApproval = approvalDecisions
	.map((decision, index) => ({ decision, index, call: calls[index] }))
	.filter((entry) => entry.decision.kind === 'approval_required');

if (requiringApproval.length > 0) {
	const tokenArg = extractApprovalToken(params);
	if (!tokenArg) {
		return failAllAsApprovalMissing(requiringApproval);
	}
	const verifyResult = identity.verifyApprovalToken({
			calls: requiringApproval.map((entry) => ({
				namespace: entry.call.namespace,
				toolName: entry.call.toolName,
				argumentsHash: hashCallArguments(entry.call.arguments),
			})),
		nowMs: Date.now(),
		token: tokenArg,
	});
	if (!verifyResult.ok) {
		return failAllAsApprovalInvalid(requiringApproval, verifyResult.reason);
	}
}
```

Add helpers:

```typescript
function extractApprovalToken(params: unknown): string | undefined {
	if (typeof params !== 'object' || params === null) return undefined;
	const value = (params as Record<string, unknown>).portalApprovalToken;
	return typeof value === 'string' ? value : undefined;
}

function failAllAsApprovalMissing(...) { /* build result map */ }
function failAllAsApprovalInvalid(..., reason: string) { /* build result map */ }
```

Make sure `portalApprovalToken` is not in the advertised tool schema and is not
copied into any upstream call's `arguments` object — upstream never sees the
token.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/mcp-portal/src/mcp-server/portal-tools.test.ts`

Expected: pass.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm oxlint packages/mcp-portal/src/mcp-server/ && pnpm typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-portal/src/mcp-server/
git commit -m "feat(mcp-portal): enforce HMAC approval tokens in mcp_portal_call"
```

---

### Task 6: Add /health endpoint to portal Hono app

**Files:**
- Modify: `packages/mcp-portal/src/mcp-server/portal-http-server.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-http-server.test.ts`

The plugin supervisor will poll `GET /health` to confirm the subprocess is ready. The endpoint returns 200 JSON `{ ok: true, agents: string[] }` once routes are registered.

- [ ] **Step 1: Write failing test**

Add to `portal-http-server.test.ts`:

```typescript
it('GET /health returns 200 with agent list', async () => {
	const { app } = createPortalHttpAppForTest({ agentIds: ['shravan', 'alev'] });
	const res = await app.fetch(new Request('http://test/health'));
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; agents: string[] };
	expect(body.ok).toBe(true);
	expect(body.agents).toEqual(['shravan', 'alev']);
});
```

`createPortalHttpAppForTest({ agentIds })` is a fixture builder you add adjacent to the existing fixtures in the same test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/mcp-portal/src/mcp-server/portal-http-server.test.ts -t "/health"`

Expected: 404.

- [ ] **Step 3: Add /health route**

In `portal-http-server.ts`'s `createPortalHttpApp`, register before the `/agents/:agentId/mcp` route:

```typescript
app.get('/health', (c) =>
	c.json({ ok: true, agents: [...registeredAgentIds].toSorted() }),
);
```

Where `registeredAgentIds` is a `Set<string>` of agents resolved at app construction time (passed in via `createPortalHttpApp` props).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/mcp-portal/src/mcp-server/portal-http-server.test.ts -t "/health"`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-portal/src/mcp-server/
git commit -m "feat(mcp-portal): add /health endpoint"
```

---

### Task 7: Standalone portal CLI entrypoint

**Files:**
- Create: `packages/mcp-portal/src/bin/portal-server.ts`
- Create: `packages/mcp-portal/src/bin/portal-server.test.ts`
- Create: `packages/mcp-portal/src/bin/secret-value-resolver.ts`
- Create: `packages/mcp-portal/src/bin/secret-value-resolver.test.ts`
- Modify: `packages/mcp-portal/package.json`
- Modify: `packages/mcp-portal/tsdown.config.ts`

The entrypoint:
1. Parses CLI flags: optional `--port <n>`, required `--config-dir <path>`, and optional repeated `--agent <agentId>=<profile>` overrides.
2. Loads `mcp.config.jsonc` and `mcp-portal.config.jsonc` from `--config-dir` by convention.
3. Uses `mcp-portal.config.jsonc` `agents.<agentId>.profile` as the default agent → profile mapping.
4. Applies optional CLI `--agent` overrides after file load. Overrides are launch-only and do not rewrite config files.
5. Resolves `mcp-portal.config.jsonc` `server.accessHeader.secret` using `secret-value-resolver.ts`.
6. Reads HMAC keys from `process.env` via `parseHmacKeysFromEnv` (Task 2), or optional standalone secret refs in `mcp-portal.config.jsonc` when present.
7. Builds `resolveAgentIdentity(agentId)` from the loaded profile + key registry.
8. Calls `createPortalHttpApp(...)` → Hono app, passing `serverAccess`.
9. Starts a Node HTTP server bound to `mcp-portal.config.jsonc` `server.host` and either CLI `--port` or `server.port`.
10. Wires SIGTERM/SIGINT handlers for graceful shutdown (drain Hono sessions, close upstream MCP clients, then exit).

The portal package must not import `@agent-vm/agent-vm`. Standalone mode uses only `--config-dir`; OpenClaw plugin mode also uses `--config-dir` and passes ephemeral HMAC keys through env.

- [ ] **Step 1: Write failing smoke test**

Create `packages/mcp-portal/src/bin/portal-server.test.ts`:

```typescript
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('portal-server CLI', () => {
	const children: import('node:child_process').ChildProcess[] = [];

	afterEach(() => {
		while (children.length > 0) {
			const c = children.pop();
			if (c && !c.killed) c.kill('SIGTERM');
		}
	});

	it('starts, answers /health, then shuts down on SIGTERM', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'portal-server-test-'));
		const configDir = dir;
		const mcpPath = join(dir, 'mcp.config.jsonc');
		const portalPath = join(dir, 'mcp-portal.config.jsonc');
		await writeFile(
			mcpPath,
			JSON.stringify({
				schemaVersion: 1,
				providers: {},
			}),
		);
		await writeFile(
			portalPath,
			JSON.stringify({
				schemaVersion: 1,
				server: {
					host: '127.0.0.1',
					port: 18790,
					accessHeader: {
						name: 'x-agent-vm-mcp-portal-secret',
						secret: { source: 'environment', name: 'MCP_PORTAL_SERVER_SECRET' },
					},
				},
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						enabledNamespaces: [],
						enabledToolsByNamespace: {},
						hiddenToolsByNamespace: {},
						approval: {
							allowWithoutApprovalTools: [],
							alwaysAskTools: [],
							annotationPolicy: 'destructive-requires-approval',
							trustedAnnotationNamespaces: [],
							writeTools: [],
						},
						logging: { enabled: false },
						promptContext: { enabled: true, maxNamespaces: 12 },
						cache: { catalogTtlMs: 60000 },
					},
				},
			}),
		);

		const binPath = require.resolve('../../dist/bin/portal-server.js');
		const child = spawn(process.execPath, [binPath, '--port', '0', '--config-dir', configDir], {
			env: {
				HOME: process.env.HOME,
				MCP_PORTAL_SERVER_SECRET: 'test-portal-secret',
				PORTAL_HMAC_KEY__shravan: '00'.repeat(32),
				PATH: process.env.PATH,
				NODE_ENV: 'test',
			},
		});
		children.push(child);

		// Read the listening port from stdout (the bin should print "listening port=<n>")
		const port = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
			child.stdout?.on('data', (chunk: Buffer) => {
				const m = /listening port=(\d+)/.exec(chunk.toString());
				if (m) {
					clearTimeout(timer);
					resolve(Number(m[1]));
				}
			});
			child.on('error', reject);
		});

		const res = await fetch(`http://127.0.0.1:${port}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; agents: string[] };
		expect(body.ok).toBe(true);
		expect(body.agents).toEqual(['shravan']);

		child.kill('SIGTERM');
		const exitCode = await new Promise<number>((resolve) => {
			child.on('exit', (code) => resolve(code ?? -1));
		});
		expect(exitCode).toBe(0);
	}, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/mcp-portal/src/bin/portal-server.test.ts`

Expected: fails because the dist binary doesn't exist yet.

- [ ] **Step 3: Implement portal-server.ts**

Create `packages/mcp-portal/src/bin/portal-server.ts`:

```typescript
#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import {
	loadMcpConfig,
	loadMcpPortalConfig,
	type McpPortalAgentBinding,
} from '@agent-vm/config-contracts';
import { parseHmacKeysFromEnv } from './-shared-hmac-env.js'; // re-exported below
import { resolveSecretValue } from './secret-value-resolver.js';

import { createPortalHttpApp } from '../mcp-server/portal-http-server.js';
import { resolveAgentIdentityFactory } from '../mcp-server/resolve-agent-identity.js';

interface CliArgs {
	readonly port?: number;
	readonly configDir: string;
	readonly agentOverrides: readonly string[];
}

function parseCliArgs(argv: readonly string[]): CliArgs {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			port: { type: 'string', short: 'p' },
			'config-dir': { type: 'string' },
			agent: { type: 'string', multiple: true },
		},
		strict: true,
	});
	const port = values.port === undefined ? undefined : Number(values.port);
	const configDir = values['config-dir'];
	if (typeof configDir !== 'string' || configDir.length === 0) {
		throw new Error('--config-dir <path> is required');
	}
	return {
		port,
		configDir,
		agentOverrides: Array.isArray(values.agent) ? values.agent : [],
	};
}

function applyAgentOverrides(
	agents: Readonly<Record<string, McpPortalAgentBinding>>,
	overrides: readonly string[],
): Readonly<Record<string, McpPortalAgentBinding>> {
	const nextAgents: Record<string, McpPortalAgentBinding> = { ...agents };
	for (const override of overrides) {
		const [agentId, profileName] = override.split('=', 2);
		if (!agentId || !profileName) {
			throw new Error(`Invalid --agent override "${override}". Expected <agentId>=<profile>`);
		}
		nextAgents[agentId] = {
			...(nextAgents[agentId] ?? {}),
			profile: profileName,
		};
	}
	return nextAgents;
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	const mcpConfig = await loadMcpConfig(join(args.configDir, 'mcp.config.jsonc'));
	const portalConfig = await loadMcpPortalConfig(join(args.configDir, 'mcp-portal.config.jsonc'));
	const serverAccessSecret = await resolveSecretValue(portalConfig.server.accessHeader.secret, {
		env: process.env,
	});
	const agents = applyAgentOverrides(portalConfig.agents, args.agentOverrides);
	const keys = await resolveAgentHmacKeys({
		agents,
		envKeys: parseHmacKeysFromEnv(process.env),
		resolveSecret: (secret) => resolveSecretValue(secret, { env: process.env }),
	});
	const resolveAgentIdentity = resolveAgentIdentityFactory({
		agents,
		mcpConfig,
		portalConfig,
		keys,
	});
	const { app } = createPortalHttpApp({
		registeredAgentIds: new Set(Object.keys(portalConfig.agents)),
		resolveAgentIdentity,
		serverAccess: {
			headerName: portalConfig.server.accessHeader.name,
			expectedValue: serverAccessSecret,
		},
	});
	const server = serve(
		{
			fetch: app.fetch,
			hostname: portalConfig.server.host,
			port: args.port ?? portalConfig.server.port,
		},
		(info) => {
			console.log(`listening port=${info.port}`);
		},
	);

	const shutdown = async (): Promise<void> => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown());
	process.on('SIGINT', () => void shutdown());
}

void main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
```

Also create `packages/mcp-portal/src/bin/-shared-hmac-env.ts` that re-exports `parseHmacKeysFromEnv` from `@agent-vm/openclaw-mcp-portal-plugin/hmac-key-registry` — OR move `parseHmacKeysFromEnv` to a neutral location both packages can import from. Pick the layered location: `packages/mcp-portal/src/auth/hmac-env.ts`. Update Task 2 imports accordingly if needed.

Create `packages/mcp-portal/src/bin/secret-value-resolver.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretValue } from '@agent-vm/config-contracts';

const execFileAsync = promisify(execFile);

export interface ResolveSecretValueProps {
	readonly env: NodeJS.ProcessEnv;
	readonly readOnePasswordSecret?: (ref: string) => Promise<string>;
}

export async function resolveSecretValue(
	secret: SecretValue,
	props: ResolveSecretValueProps,
): Promise<string> {
	if (secret.source === 'environment') {
		const value = props.env[secret.name];
		if (value === undefined || value.length === 0) {
			throw new Error(`Missing environment secret ${secret.name}`);
		}
		return value;
	}
	const readOnePasswordSecret = props.readOnePasswordSecret ?? readOnePasswordCliSecret;
	return readOnePasswordSecret(secret.ref);
}

async function readOnePasswordCliSecret(ref: string): Promise<string> {
	const { stdout } = await execFileAsync('op', ['read', ref], { encoding: 'utf8' });
	return stdout.trimEnd();
}
```

`secret-value-resolver.test.ts` must cover environment success, missing environment failure, and a 1Password ref using an injected `readOnePasswordSecret` function so tests do not require the real `op` CLI.

Also create `packages/mcp-portal/src/mcp-server/resolve-agent-identity.ts` exporting `resolveAgentIdentityFactory` that consumes the loaded profile + keys map and returns the `(agentId) => AgentIdentity | null` callback used by the route handler. Each returned `AgentIdentity.verifyApprovalToken` closes over that agent's key.

Add `resolveAgentHmacKeys` next to `resolveAgentIdentityFactory`:

```typescript
import type { McpPortalAgentBinding, SecretValue } from '@agent-vm/config-contracts';

export interface ResolveAgentHmacKeysProps {
	readonly agents: Readonly<Record<string, McpPortalAgentBinding>>;
	readonly envKeys: ReadonlyMap<string, Buffer>;
	readonly resolveSecret: (secret: SecretValue) => Promise<string>;
}

export async function resolveAgentHmacKeys(
	props: ResolveAgentHmacKeysProps,
): Promise<ReadonlyMap<string, Buffer>> {
	const keys = new Map<string, Buffer>();
	for (const [agentId, agent] of Object.entries(props.agents)) {
		const envKey = props.envKeys.get(agentId);
		if (envKey) {
			keys.set(agentId, envKey);
			continue;
		}
		if (!agent.hmacKey) {
			throw new Error(`Missing HMAC key for MCP Portal agent "${agentId}"`);
		}
		const secretValue = await props.resolveSecret(agent.hmacKey);
		keys.set(agentId, Buffer.from(secretValue, 'hex'));
	}
	return keys;
}
```

- [ ] **Step 4: Add bin entry to package.json**

Edit `packages/mcp-portal/package.json` to add:

```json
"bin": {
	"agent-vm-mcp-portal-server": "./dist/bin/portal-server.js"
}
```

And confirm `exports`/`files` include `dist/bin/**` (no manual change needed if a glob pattern already covers `dist/**`).

- [ ] **Step 5: Add tsdown entry**

Edit `packages/mcp-portal/tsdown.config.ts` to add `src/bin/portal-server.ts` to the entry list. Confirm bundling is correct (Node target, no ESM/CJS issues with the shebang).

- [ ] **Step 6: Build the package**

Run: `pnpm --filter @agent-vm/mcp-portal build`

Expected: `dist/bin/portal-server.js` exists with the shebang preserved.

- [ ] **Step 7: Run smoke test**

Run: `pnpm vitest run packages/mcp-portal/src/bin/portal-server.test.ts`

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-portal/src/bin/ packages/mcp-portal/src/auth/ packages/mcp-portal/src/mcp-server/resolve-agent-identity.ts packages/mcp-portal/package.json packages/mcp-portal/tsdown.config.ts
git commit -m "feat(mcp-portal): add standalone portal-server CLI entrypoint"
```

---

### Task 8: Portal subprocess supervisor

**Files:**
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.test.ts`

The supervisor:
- Spawns the portal binary at a configured absolute path (image-baked location).
- Passes per-agent HMAC keys via env, port via `--port`, and config folder via `--config-dir`.
- Polls `/health` until 200 (timeout 10s, interval 200ms).
- Watches the child for `exit` and restarts with exponential backoff (200ms → 400ms → 800ms → 1.6s → 3.2s → 5s cap), capped at 5 attempts in a 60s window. After the cap, emits a fatal diagnostic and stops.
- Exposes `start()`, `stop()` (graceful SIGTERM + 5s grace + SIGKILL fallback), `isAlive()`.

- [ ] **Step 1: Write failing tests**

Create `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { createPortalSubprocessSupervisor } from './portal-subprocess-supervisor.js';

describe('createPortalSubprocessSupervisor', () => {
	it('start() spawns the child with expected args and env', async () => {
		const spawn = vi.fn(() => fakeChild({ healthDelayMs: 0 }));
		const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, agents: ['a'] })));
		const supervisor = createPortalSubprocessSupervisor({
			binPath: '/opt/portal/bin/portal-server',
			port: 18790,
			configDir: '/config/gateways/sunclaw',
			hmacEnv: { PORTAL_HMAC_KEY__a: 'deadbeef' },
			spawnFn: spawn,
			fetchFn: fetch,
			logger: silentLogger(),
		});
		await supervisor.start();
		expect(spawn).toHaveBeenCalledWith(
			'/opt/portal/bin/portal-server',
			['--port', '18790', '--config-dir', '/config/gateways/sunclaw'],
			expect.objectContaining({
				env: expect.objectContaining({ PORTAL_HMAC_KEY__a: 'deadbeef' }),
			}),
		);
		expect(supervisor.isAlive()).toBe(true);
		await supervisor.stop();
	});

	it('start() polls /health until 200', async () => {
		// First two fetches throw, third returns 200
		let attempts = 0;
		const fetch = vi.fn(async () => {
			attempts += 1;
			if (attempts < 3) throw new Error('econnrefused');
			return new Response(JSON.stringify({ ok: true, agents: ['a'] }));
		});
		const supervisor = createPortalSubprocessSupervisor({
			binPath: '/x',
			port: 18790,
			configDir: '/y',
			hmacEnv: {},
			spawnFn: () => fakeChild({}),
			fetchFn: fetch,
			logger: silentLogger(),
			healthPollIntervalMs: 5,
		});
		await supervisor.start();
		expect(attempts).toBe(3);
		await supervisor.stop();
	});

	it('restarts the child on exit with exponential backoff', async () => {
		const calls: number[] = [];
		const spawn = vi.fn(() => {
			calls.push(Date.now());
			return fakeChild({ exitAfterMs: 10 });
		});
		const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, agents: [] })));
		const supervisor = createPortalSubprocessSupervisor({
			binPath: '/x',
			port: 18790,
			configDir: '/y',
			hmacEnv: {},
			spawnFn: spawn,
			fetchFn: fetch,
			logger: silentLogger(),
			healthPollIntervalMs: 1,
			backoffSteps: [5, 10, 20],
		});
		await supervisor.start();
		await new Promise((r) => setTimeout(r, 200));
		expect(spawn.mock.calls.length).toBeGreaterThan(2);
		await supervisor.stop();
	});

	it('emits a fatal diagnostic when backoff cap is exhausted', async () => {
		const onFatal = vi.fn();
		const supervisor = createPortalSubprocessSupervisor({
			binPath: '/x',
			port: 18790,
			configDir: '/y',
			hmacEnv: {},
			spawnFn: () => fakeChild({ exitAfterMs: 1 }),
			fetchFn: async () => new Response(JSON.stringify({ ok: true, agents: [] })),
			logger: silentLogger(),
			backoffSteps: [1, 1, 1],
			maxRestarts: 3,
			onFatal,
		});
		await supervisor.start();
		await new Promise((r) => setTimeout(r, 200));
		expect(onFatal).toHaveBeenCalled();
		expect(supervisor.isAlive()).toBe(false);
	});
});

function silentLogger() {
	return { info: () => {}, warn: () => {}, error: () => {} };
}

function fakeChild(opts: { exitAfterMs?: number; healthDelayMs?: number }) {
	const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
	const child = {
		killed: false,
		stdout: { on: () => {} },
		stderr: { on: () => {} },
		kill: function () {
			this.killed = true;
			setTimeout(() => listeners.get('exit')?.forEach((cb) => cb(0)), 1);
		},
		on: (event: string, cb: (...a: unknown[]) => void) => {
			const arr = listeners.get(event) ?? [];
			arr.push(cb);
			listeners.set(event, arr);
		},
	};
	if (opts.exitAfterMs !== undefined) {
		setTimeout(() => {
			if (!child.killed) listeners.get('exit')?.forEach((cb) => cb(1));
		}, opts.exitAfterMs);
	}
	return child as unknown as import('node:child_process').ChildProcess;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.test.ts`

Expected: module not found.

- [ ] **Step 3: Implement portal-subprocess-supervisor.ts**

Create `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts`. Use the spawn signature exactly as the tests assert. The default `backoffSteps` are `[200, 400, 800, 1600, 3200, 5000]`. Default `maxRestarts` is 5 within a rolling 60s window. The implementation interface:

```typescript
export interface CreatePortalSubprocessSupervisorProps {
	readonly binPath: string;
	readonly port: number;
	readonly configDir: string;
	readonly hmacEnv: Readonly<Record<string, string>>;
	readonly logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
	readonly spawnFn?: typeof import('node:child_process').spawn;
	readonly fetchFn?: typeof fetch;
	readonly healthPollIntervalMs?: number;
	readonly healthTimeoutMs?: number;
	readonly backoffSteps?: readonly number[];
	readonly maxRestarts?: number;
	readonly onFatal?: (reason: string) => void;
}

export interface PortalSubprocessSupervisor {
	readonly start: () => Promise<void>;
	readonly stop: () => Promise<void>;
	readonly isAlive: () => boolean;
}
```

Implementation outline:
1. Internal state: `child | null`, `restartCount`, `restartWindowStart`, `stopped: boolean`.
2. `start()`: spawn child, attach `exit` listener that, if `!stopped`, schedules `restart()`. Poll `/health` until ok or timeout.
3. `restart()`: increment `restartCount`. If `restartCount > maxRestarts` within window, call `onFatal('backoff-exhausted')` and stop. Otherwise wait `backoffSteps[Math.min(restartCount-1, last)]` ms, then spawn.
4. `stop()`: set `stopped`, send SIGTERM, wait 5s, SIGKILL if still alive.
5. `isAlive()`: `child !== null && !child.killed && !stopped`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.test.ts`

Expected: all pass.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm oxlint packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.* && pnpm typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.*
git commit -m "feat(openclaw-portal-plugin): add portal subprocess supervisor"
```

---

### Task 9: Rewrite plugin-registration.ts — register the service

**Files:**
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.test.ts`
- Delete: `packages/openclaw-mcp-portal-plugin/src/portal-server-manager.ts` and its `.test.ts`

This is the heart of the cutover. The plugin's `register()` function:

1. Resolves the gateway MCP config directory from `api.config.zones[0].mcp.configDir` (single-zone gateway).
2. Validates the configured portal port is outside `[tcpPool.basePort, tcpPool.basePort + tcpPool.size)`.
3. Loads `mcp-portal.config.jsonc` from that folder to discover portal agents.
4. Creates the HMAC key registry for those portal agents.
5. Creates the supervisor with the resolved bin path (from plugin config, default `/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server`) and the config folder path.
6. Calls `api.registerService({ id: 'mcp-portal-subprocess', start, stop })`.
7. Registers `before_tool_call` (Task 10) and `before_prompt_build` (Task 11) hooks.

`portal-plugin-runtime-state.ts` is deliberately small: it stores the resolved `configDir`, the generated `HmacKeyRegistry`, and lazy config loaders shared by the service and hooks. It does not own policy decisions. It exists so the hooks do not reach into `plugin-registration.ts` state or reload keys independently.

- [ ] **Step 1: Update existing plugin-registration tests**

Replace assertions that touched `registerHttpRoute`, `app.fetch`, or `createPortalRuntimeBundle` with assertions on `registerService`, supervisor start/stop, and hook registration.

Specifically: rename or rewrite `validatePortalPluginApi` to require `registerService` (not `registerHttpRoute`). The new test list:

```typescript
it('throws when registerService is missing', () => {
	expect(() => validatePortalPluginApi({ /* missing registerService */ } as ...)).toThrow();
});
it('throws when before_tool_call hook registration API is missing', () => { ... });
it('refuses a portal port inside the tcp pool range', () => { ... });
it('emits exactly one mcp-portal-subprocess service registration', () => { ... });
it('registers before_tool_call and before_prompt_build', () => { ... });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`

Expected: many failures — the current implementation still uses registerHttpRoute.

- [ ] **Step 3: Rewrite the registration function**

Replace the body of `registerMcpPortalPlugin(api)` with:

```typescript
export function registerMcpPortalPlugin(api: OpenClawPortalPluginApi): void {
	if (api.registrationMode && api.registrationMode !== 'full') return;
	validatePortalPluginApi(api);

	const zone = resolveSingleZone(api.config);
	const portalConfig = getPortalPluginConfig(api.config, api.pluginConfig);
	validatePortalPortAgainstTcpPool({
		port: portalConfig.port,
		tcpPool: api.config.tcpPool,
	});

	const runtimeState = createPortalPluginRuntimeState({ configDir: zone.mcp.configDir });
	let supervisor: PortalSubprocessSupervisor | null = null;

	api.registerService({
		id: 'mcp-portal-subprocess',
		start: async () => {
			const mcpPortalConfig = await runtimeState.loadPortalConfig();
			const keyRegistry = createHmacKeyRegistry({
				agentIds: Object.keys(mcpPortalConfig.agents),
			});
			runtimeState.setKeyRegistry(keyRegistry);
			supervisor = createPortalSubprocessSupervisor({
				binPath: portalConfig.binPath,
				port: portalConfig.port,
				configDir: zone.mcp.configDir,
				hmacEnv: keyRegistry.serializeForEnv(),
				logger: makeLoggerAdapter(api.logger),
				onFatal: (reason) => {
					api.logger?.error?.(`[mcp-portal] subprocess supervisor fatal: ${reason}`);
				},
			});
			await supervisor.start();
		},
		stop: async () => {
			await supervisor?.stop();
		},
	});

	api.on?.('before_tool_call', createBeforeToolCallHandler({
		agentZone: zone,
		configDir: zone.mcp.configDir,
		runtimeState,
	}), { priority: 80 });

	api.on?.('before_prompt_build', createBeforePromptBuildHandler({
		agentZone: zone,
		configDir: zone.mcp.configDir,
	}), { priority: 80 });

	api.onDispose?.(() => void supervisor?.stop());
}
```

Delete:
- The `registerHttpRoute` call.
- `createRequestFromIncomingMessage`, `headersFromIncomingMessage`, `requestBodyStreamFromIncomingMessage`, `writeFetchResponseToServerResponse`, `createResponseDrainWait` (and any tests in `plugin-registration.test.ts` that exercise them).
- `createPortalRuntimeBundle`, `createPortalRuntimeReloader`, and the `runtime.app.fetch` indirection.
- All imports of `Hono` / `IncomingMessage` / `ServerResponse` from this file.

The hook handler factories `createBeforeToolCallHandler` and `createBeforePromptBuildHandler` are implemented in Tasks 10 and 11.

- [ ] **Step 4: Delete portal-server-manager.{ts,test.ts}**

```bash
git rm packages/openclaw-mcp-portal-plugin/src/portal-server-manager.ts
git rm packages/openclaw-mcp-portal-plugin/src/portal-server-manager.test.ts
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`

Expected: passes once Task 10 and Task 11 hook stubs exist. If you are executing tasks in order, stub the hook factory functions to return no-op handlers and finish them in later tasks; the registration test is satisfied by registration, not handler behavior.

- [ ] **Step 6: Lint + typecheck**

Run: `pnpm oxlint packages/openclaw-mcp-portal-plugin/src/ && pnpm typecheck`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/openclaw-mcp-portal-plugin/src/
git commit -m "refactor(openclaw-portal-plugin): switch to subprocess service + drop in-process route"
```

---

### Task 10: before_tool_call handler (policy denial + approval token attach)

**Files:**
- Create: `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts`

The handler runs for every tool call. It only acts when `event.toolName` is a materialized portal tool name (matches the regex `^portal_(?<agentId>[A-Za-z0-9_-]+)__mcp_portal_call$` or `__mcp_portal_describe/list/search$`). For non-portal tools it returns `undefined` immediately.

The handler lazily loads `mcp-portal.config.jsonc` on first call via `loadMcpPortalConfig` from `@agent-vm/config-contracts`. The path is `path.join(configDir, 'mcp-portal.config.jsonc')`.

For portal tool calls:
1. Look up the agent's profile name from `mcp-portal.config.jsonc` `agents.<agentId>.profile`.
2. Resolve the profile object with `resolveMcpPortalProfile(profileConfig, profileName)` from `@agent-vm/config-contracts`.
3. For each call in `event.params.calls`:
   - If the profile's `enabledNamespaces` / `enabledToolsByNamespace` / `hiddenToolsByNamespace` (config-migration-plan fields) DOES NOT include the namespace/tool → return `{ block: true, blockReason: 'policy: <agent>/<namespace>/<toolName> not enabled' }`.
   - If the profile includes the tool and it is in `approval.alwaysAskTools` (or matches `approval.annotationPolicy`) → mark as requiring approval.
3. If ANY call requires approval:
   - Build the call digests (namespace, toolName, argumentsHash).
   - Sign an approval token with the agent's HMAC key, expiry now+60s.
   - Inject root-level `event.params.portalApprovalToken = <token>` for the batch.
   - Return `{ requireApproval: { reason: 'portal call requires user approval', kind: 'mcp-portal' } }`.
4. Otherwise return `undefined`.

- [ ] **Step 1: Write failing tests**

Create the test file. Test cases (one per behavior):
- `it('passes through non-portal tools')` — return undefined when toolName doesn't match.
- `it('blocks when namespace not in profile.enabledNamespaces')`.
- `it('blocks when tool not in profile.enabledToolsByNamespace[ns]')`.
- `it('returns requireApproval and attaches a signed token when tool is in alwaysAskTools')`.
- `it('does NOT attach a token when no call requires approval')`.
- `it('multi-call batch: blocks if any single call is denied (does not partial-allow)')`.
- `it('multi-call batch: signs ONE token covering all approval-required calls')`.

Use the existing helpers in current `plugin-registration.test.ts` where they apply, and the HMAC verify utility from Task 1 to assert token validity:

```typescript
const token = event.params.portalApprovalToken;
const result = verifyApprovalToken({
	agentId: 'shravan',
	calls: [{ namespace: 'linear', toolName: 'create_issue', argumentsHash: hashCallArguments(...) }],
	key: keyRegistry.getKey('shravan'),
	nowMs: Date.now(),
	token,
});
expect(result.ok).toBe(true);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts`

Expected: file/function not found.

- [ ] **Step 3: Implement before-tool-call-handler.ts**

```typescript
import { hashCallArguments, signApprovalToken } from '@agent-vm/mcp-portal/auth/hmac-token';
import { join } from 'node:path';
import {
	loadMcpPortalConfig,
	resolveMcpPortalProfile,
	type McpPortalConfig,
} from '@agent-vm/config-contracts';
import type {
	OpenClawBeforeToolCallEvent,
	OpenClawBeforeToolCallResult,
	OpenClawHookContext,
} from './openclaw-plugin-api.js';
import type { PortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

const TOKEN_TTL_MS = 60_000;
const PORTAL_TOOL_PATTERN =
	/^portal_(?<agentId>[A-Za-z0-9_-]+)__mcp_portal_(?:call|describe|list|search)$/;

export interface CreateBeforeToolCallHandlerProps {
	readonly configDir: string;
	readonly runtimeState: PortalPluginRuntimeState;
}

export function createBeforeToolCallHandler(
	props: CreateBeforeToolCallHandlerProps,
): (
	event: OpenClawBeforeToolCallEvent,
	context: OpenClawHookContext,
) => Promise<OpenClawBeforeToolCallResult | undefined> {
	let cachedProfileConfig: McpPortalConfig | null = null;
	const loadProfileConfig = async (): Promise<McpPortalConfig> => {
		if (!cachedProfileConfig) {
			cachedProfileConfig = await loadMcpPortalConfig(join(props.configDir, 'mcp-portal.config.jsonc'));
		}
		return cachedProfileConfig;
	};

	return async (event, context) => {
		const match = PORTAL_TOOL_PATTERN.exec(event.toolName);
		if (!match) return undefined;
		const pathAgentId = match.groups?.agentId;
		if (!pathAgentId) return undefined;
		if (context.agentId !== undefined && context.agentId !== pathAgentId) return undefined;

		const profileConfig = await loadProfileConfig();
		const agent = profileConfig.agents[pathAgentId];
		if (!agent) {
			return {
				block: true,
				blockReason: `mcp-portal: agent "${pathAgentId}" is not configured`,
			};
		}
		const profile = resolveMcpPortalProfile(profileConfig, agent.profile);

		const calls = extractCallsFromParams(event.params);
		if (calls.length === 0) return undefined;

		// 1. Policy check: deny if any call's namespace/tool not enabled.
		for (const call of calls) {
			if (!profileAllowsCall(profile, call.namespace, call.toolName)) {
				return {
					block: true,
					blockReason: `policy: ${pathAgentId}/${call.namespace}/${call.toolName} not enabled`,
				};
			}
		}

		// 2. Approval check.
		const requiresApproval = calls.filter((call) =>
			profileRequiresApproval(profile, call.namespace, call.toolName),
		);
		if (requiresApproval.length === 0) return undefined;

			// 3. Sign token and inject it at the portal envelope root.
			const callDigests = requiresApproval.map((call) => ({
				namespace: call.namespace,
				toolName: call.toolName,
				argumentsHash: hashCallArguments(call.arguments),
			}));
			const token = signApprovalToken({
				agentId: pathAgentId,
				calls: callDigests,
				expiresAtMs: Date.now() + TOKEN_TTL_MS,
				key: props.runtimeState.getKeyRegistry().getKey(pathAgentId),
			});
			event.params.portalApprovalToken = token;

		return {
			requireApproval: {
				reason: 'mcp-portal call requires user approval',
				kind: 'mcp-portal',
			},
		};
	};
}
```

Add the helper functions `profileAllowsCall`, `profileRequiresApproval`, `extractCallsFromParams` adjacent in the same file. The first two read from the loaded profile shape (defined in the config-migration plan). `extractCallsFromParams` parses `event.params.calls` with defensive checks.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts`

Expected: pass.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm oxlint packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.* && pnpm typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.*
git commit -m "feat(openclaw-portal-plugin): rewrite before_tool_call with HMAC approval tokens"
```

---

### Task 11: before_prompt_build handler (profile-scoped discovery hint)

**Files:**
- Create: `packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.test.ts`

The handler reads the profile for the current `context.agentId` from `mcp-portal.config.jsonc` via `@agent-vm/config-contracts`, lists `profile.enabledNamespaces` (capped at `profile.promptContext.maxNamespaces`), and returns `{ appendSystemContext: "<text>" }`. If `profile.promptContext.enabled === false`, returns `undefined`.

Like the `before_tool_call` handler in Task 10, this handler resolves the profile name from `mcp-portal.config.jsonc` `agents.<agentId>.profile`. `system.jsonc` is not consulted for MCP profile selection.

- [ ] **Step 1: Write failing tests**

Test cases:
- `it('returns undefined when agentId is missing from context')`.
- `it('returns undefined when profile.promptContext.enabled is false')`.
- `it('appends a system context listing enabled namespaces')`.
- `it('truncates to maxNamespaces')`.
- `it('produces empty list when profile has no enabled namespaces')`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.test.ts`

Expected: module not found.

- [ ] **Step 3: Implement before-prompt-build-handler.ts**

```typescript
import type {
	OpenClawBeforePromptBuildEvent,
	OpenClawBeforePromptBuildResult,
	OpenClawHookContext,
} from './openclaw-plugin-api.js';
import { join } from 'node:path';
import {
	loadMcpPortalConfig,
	resolveMcpPortalProfile,
	type McpPortalConfig,
} from '@agent-vm/config-contracts';

export interface CreateBeforePromptBuildHandlerProps {
	readonly configDir: string;
}

export function createBeforePromptBuildHandler(
	props: CreateBeforePromptBuildHandlerProps,
): (
	event: OpenClawBeforePromptBuildEvent,
	context: OpenClawHookContext,
) => Promise<OpenClawBeforePromptBuildResult | undefined> {
	let cached: McpPortalConfig | null = null;
	return async (_event, context) => {
		const agentId = context.agentId;
		if (!agentId) return undefined;
		cached = cached ?? (await loadMcpPortalConfig(join(props.configDir, 'mcp-portal.config.jsonc')));
		const agent = cached.agents[agentId];
		if (!agent) return undefined;
		const profile = resolveMcpPortalProfile(cached, agent.profile);
		if (profile.promptContext.enabled === false) return undefined;
		const namespaces = [...profile.enabledNamespaces]
			.toSorted()
			.slice(0, profile.promptContext.maxNamespaces);
		if (namespaces.length === 0) {
			return { appendSystemContext: 'Portal namespaces available: (none in your profile)' };
		}
		const text = [
			'Portal namespaces available:',
			...namespaces.map((ns) => `  ${ns}`),
			'Use mcp_portal_search to find tools by intent.',
		].join('\n');
		return { appendSystemContext: text };
	};
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.test.ts`

Expected: pass.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm oxlint packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.* && pnpm typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.* packages/openclaw-mcp-portal-plugin/src/portal-config.ts
git commit -m "feat(openclaw-portal-plugin): rewrite before_prompt_build to read profile config from disk"
```

---

### Task 12: Bake portal binary into gateway VM image

**Files:**
- Modify: `vm-images/openclaw-gateway/build-config.jsonc` (or the actual gateway image recipe; check `docs/architecture/openclaw-gateway.md` for the canonical location).
- Modify: `packages/agent-vm/src/build/managed-image-release.ts` if image release packaging needs to ship the portal binary alongside the existing OpenClaw plugin runtime deps.

The portal binary must be at `/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server` inside the gateway VM. Build pipeline:
1. `pnpm --filter @agent-vm/mcp-portal build` produces `dist/bin/portal-server.js` and its dependencies.
2. The image build step copies the entire `dist/` tree plus `package.json` and `node_modules` for `@agent-vm/mcp-portal` into `/opt/agent-vm/portal/`.
3. A small wrapper at `/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server` does `exec node /opt/agent-vm/portal/dist/bin/portal-server.js "$@"`.

- [ ] **Step 1: Update image recipe**

In the gateway image build config, add a `copy` directive (or equivalent — match the existing convention in the repo for `OPENCLAW_PLUGIN_STAGE_DIR`) that installs the portal package contents to `/opt/agent-vm/portal/`. Mode 0755 for executables, 0644 for everything else.

- [ ] **Step 2: Add a wrapper script**

Inside the image, create `/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server`:

```bash
#!/bin/sh
exec node /opt/agent-vm/portal/dist/bin/portal-server.js "$@"
```

Permissions 0755.

- [ ] **Step 3: Wire the bin path into plugin config defaults**

In `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`, set the default `binPath` to `/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server`. Allow override via plugin config for dev (so a developer can run the binary from a checkout instead).

- [ ] **Step 4: Add image build smoke test**

Run: `pnpm --filter @agent-vm/agent-vm test:smoke -- managed-image-release`

Confirm the smoke harness for the gateway image build includes a check that `/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server` exists in the produced image. If not, add it next to existing image-content assertions.

- [ ] **Step 5: Commit**

```bash
git add vm-images/openclaw-gateway/ packages/openclaw-mcp-portal-plugin/src/portal-config.ts packages/agent-vm/src/build/managed-image-release.test.ts
git commit -m "build(openclaw-gateway): bake mcp-portal subprocess binary into gateway image"
```

---

### Task 13: Hard cutover — delete legacy in-process portal path

**Files:**
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts` (already done in Task 9, this is a sweep).
- Delete remaining dead code anywhere in `packages/openclaw-mcp-portal-plugin/src/` and `packages/mcp-portal/src/` that only existed to bridge the registerHttpRoute path.
- Modify: any test that mocks `runtime.app.fetch` or `registerHttpRoute` to use the new shape, OR delete that test if it covers behavior that has been replaced.
- Modify: `packages/agent-vm/src/cli/init-command.ts` (init-command-generated portal entries; the emission logic was added by the config migration plan — this task only changes the emitted URL string).
- Modify: `packages/agent-vm/src/cli/migrate-commands.ts` `runMigrateMcpPortalConfigCommand` (introduced by the config migration plan) so the migration emits the new URL shape.

- [ ] **Step 1: Grep for dead references**

```bash
grep -rn "registerHttpRoute\|runtime\.app\.fetch\|createPortalRuntimeBundle\|createPortalRuntimeReloader\|createRequestFromIncomingMessage\|writeFetchResponseToServerResponse\|x-mcp-portal-binding-secret\|mcp-portal/bindings" packages/openclaw-mcp-portal-plugin/ packages/mcp-portal/
```

For each hit:
- If in source code outside the test directories: delete or replace.
- If in tests: rewrite to the new contract, or delete if obsolete.

- [ ] **Step 2: Grep config templates and docs for legacy paths**

```bash
grep -rn "mcp-portal/bindings\|/mcp-portal/" config/ docs/ packages/agent-vm/src/cli/manual-templates.ts
```

Replace generated `mcp.servers.<portalServerName>.url` literals with `http://127.0.0.1:18790/agents/<agentId>/mcp`, and replace `x-mcp-portal-binding-secret` headers with the configured `mcp-portal.config.jsonc` `server.accessHeader.name`.

If `agent-vm init` / `agent-vm migrate mcp-portal` (introduced in the config-migration plan) emits these URLs, update both the emitter and any test snapshots.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test:unit`

Expected: green. Fix any remaining call sites that haven't been migrated.

- [ ] **Step 4: Run integration tests**

Run: `pnpm test:integration`

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(mcp-portal): delete in-process registerHttpRoute path (hard cutover)"
```

---

### Task 14: End-to-end integration test

**Files:**
- Create: `packages/openclaw-mcp-portal-plugin/src/plugin-subprocess-wiring.test.ts`
- Create: `packages/mcp-portal/src/bin/portal-server.integration.test.ts`

Two tests split by ownership:

1. `plugin-subprocess-wiring.test.ts` is a unit-style plugin wiring test. It constructs the
   plugin programmatically, verifies the plugin registers the subprocess service, passes the configured
   `binPath` / `configDir` / HMAC env to the supervisor, and signs approved `mcp_portal_call` batches.
2. `portal-server.integration.test.ts` is the real process/transport test. It runs in the explicit
   integration lane after `pnpm build`, spawns the built portal binary, starts a real Hono upstream MCP
   server, and connects through the MCP SDK Streamable HTTP client.

The real subprocess integration test:
1. Creates a temp dir with `mcp.config.jsonc` and `mcp-portal.config.jsonc`.
2. Stubs a tiny upstream MCP server (HTTP) that echoes calls.
3. Spawns the real built portal binary at `packages/mcp-portal/dist/bin/portal-server.js`.
4. Connects to the spawned portal via the MCP SDK Streamable HTTP client, hitting `/agents/shravan/mcp`.
5. Calls `mcp_portal_list` — confirms it returns at least the upstream's tool.
6. Calls `mcp_portal_call` for an `allowWithoutApproval` tool — confirms upstream runs.
7. Calls `mcp_portal_call` for an `alwaysAsk` tool WITHOUT a token — confirms `approval-token-missing`.
8. Signs a token externally using the same HMAC key shape the plugin passes to the portal and calls
   again — confirms success.
9. Tears down: kills the portal subprocess and closes the upstream server.

This is a real subprocess + real Hono + real MCP SDK client integration. Slow (a few seconds) but high-confidence.

- [ ] **Step 1: Write the test**

```typescript
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { hashCallArguments, signApprovalToken } from '@agent-vm/mcp-portal/auth/hmac-token';

describe('portal subprocess integration', () => {
	let tmp: string;
	let portalChild: import('node:child_process').ChildProcess;
	let portalPort: number;
	const hmacKey = Buffer.from('a'.repeat(64), 'hex');
	const portalServerSecret = 'test-portal-secret';

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), 'portal-int-'));
		// ... write mcp.config.jsonc, mcp-portal.config.jsonc, fixture upstream server config
		// ... start tiny upstream mock
		const binPath = require.resolve('@agent-vm/mcp-portal/dist/bin/portal-server.js');
		portalChild = spawn(process.execPath, [
			binPath,
			'--port',
			'0',
		'--config-dir',
		tmp,
	], {
		env: {
			HOME: process.env.HOME,
			MCP_PORTAL_SERVER_SECRET: portalServerSecret,
			PATH: process.env.PATH,
			PORTAL_HMAC_KEY__shravan: hmacKey.toString('hex'),
		},
	});
		portalPort = await readListeningPort(portalChild);
	}, 30_000);

	afterAll(async () => {
		portalChild.kill('SIGTERM');
		await new Promise((r) => portalChild.on('exit', r));
	});

	it('serves /agents/shravan/mcp with a real MCP client', async () => {
		const transport = new StreamableHTTPClientTransport(
			new URL(`http://127.0.0.1:${portalPort}/agents/shravan/mcp`),
			{
				requestInit: {
					headers: { 'x-agent-vm-mcp-portal-secret': portalServerSecret },
				},
			},
		);
		const client = new Client({ name: 'test', version: '0.0.0' }, {});
		await client.connect(transport);
		const tools = await client.listTools();
		expect(tools.tools.some((t) => t.name === 'mcp_portal_list')).toBe(true);
		await client.close();
	});

	it('rejects unsigned approval-required calls', async () => {
		// ... open client, call mcp_portal_call with no token, expect approval-token-missing
	});

	it('accepts signed approval-required calls', async () => {
		const argsHash = hashCallArguments({ title: 'hi' });
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [{ namespace: 'upstream-mock', toolName: 'write_thing', argumentsHash: argsHash }],
			expiresAtMs: Date.now() + 30_000,
			key: hmacKey,
		});
		// ... call with root-level portalApprovalToken = token, expect success
	});
});
```

Fill in `readListeningPort`, the upstream mock, and the omitted call detail. Reuse helpers from existing tests where possible.

- [ ] **Step 2: Run the integration test**

Run: `pnpm vitest run packages/openclaw-mcp-portal-plugin/src/plugin-subprocess-wiring.test.ts`

Expected: all three assertions pass.

- [ ] **Step 3: Commit**

```bash
git add packages/openclaw-mcp-portal-plugin/src/plugin-subprocess-wiring.test.ts
git commit -m "test(openclaw-portal-plugin): end-to-end subprocess integration"
```

---

### Task 15: Documentation update

**Files:**
- Modify: `docs/subsystems/mcp-portal.md`
- Modify: `docs/architecture/openclaw-gateway.md` (the "MCP Portal Bindings" section)
- Modify: `packages/mcp-portal/README.md` if present, otherwise create one
- Modify: `packages/openclaw-mcp-portal-plugin/README.md` if present, otherwise create one

The architecture changed materially. Update docs to reflect:
- Portal runs as a subprocess at `127.0.0.1:18790` inside the gateway VM.
- URL shape: `/agents/<agentId>/mcp`.
- Portal access header comes from `mcp-portal.config.jsonc` `server.accessHeader`; this gates MCP transport access and is separate from approval tokens.
- Per-agent HMAC keys, regenerated per plugin boot.
- Plugin's job: subprocess supervision + `before_tool_call` + `before_prompt_build`.
- Approval via OpenClaw's existing UI through `requireApproval`.
- Profile-driven policy; per-profile upstream credentials.

- [ ] **Step 1: Rewrite `docs/subsystems/mcp-portal.md`**

Replace the "Model" and "Auth, Approval, And Redaction" sections to describe the subprocess split. Keep the "Agent-Facing Tools", "Catalog And Search Isolation", and "Schema Contract" sections — those are unchanged.

- [ ] **Step 2: Update `docs/architecture/openclaw-gateway.md`**

Find the "MCP Portal Bindings" section (~line 197) and rewrite to describe the subprocess shape. Update the diagram if there is one.

- [ ] **Step 3: Add a short README to each package**

For `packages/mcp-portal/README.md` and `packages/openclaw-mcp-portal-plugin/README.md`, write a 30-line summary: what the package does, key entry points, where to start reading.

- [ ] **Step 4: Run docs lint if present**

Run: `pnpm fmt:check` and `pnpm lint`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add docs/ packages/mcp-portal/README.md packages/openclaw-mcp-portal-plugin/README.md
git commit -m "docs(mcp-portal): document subprocess architecture and per-agent paths"
```

---

## Final Verification

After Task 15, run the full quality gate from a clean state:

```bash
pnpm install
pnpm build
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:smoke
pnpm check
```

Expected: every command exits 0. The full gate is the merge criterion.

Boot a real gateway zone end-to-end and confirm:
1. `service.start` blocks on portal `/health`.
2. First agent turn reaches the portal via `http://127.0.0.1:18790/agents/<agentId>/mcp`.
3. A policy-denied call returns the LLM a blocked message (no user prompt).
4. An approval-required call surfaces OpenClaw's approval UI; approving completes the call.
5. Killing the portal subprocess externally triggers the supervisor's restart-with-backoff. Logs show the new spawn.

## Out Of Scope

The following are deferred:

- **Per-agent upstream OAuth.** Day-one is per-profile shared tokens. Per-agent isolation will need a follow-up plan once an operational use case appears.
- **MCP elicitation as the approval surface.** OpenClaw doesn't consume elicitation yet. When it does, the approval flow can move out of `before_tool_call` and into the portal itself. Note this in `docs/subsystems/mcp-portal.md` as the escape hatch.
- **Hot config reload without restart.** Today the supervisor restarts the portal on any `mcp.config.jsonc` / `mcp-portal.config.jsonc` change (via the existing reload entrypoint in OpenClaw). A signal-based reload is a later optimization.
- **Migrating the schema/config layout.** That's `2026-05-12-mcp-portal-schema-config-migration.md` and is a prerequisite for this plan.
