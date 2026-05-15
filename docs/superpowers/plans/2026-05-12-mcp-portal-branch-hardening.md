# MCP Portal Branch Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not run git commit, merge, rebase, tag, or push commands unless the user explicitly asks for git writes.

**Goal:** Address the MCP Portal branch review findings and close the remaining security, typing, approval, redaction, doctor, and test gaps before implementation continues.

**Architecture:** Keep MCP Portal as the agent-facing four-tool MCP server and upstream MCP client aggregator. Fix the current branch in place by making the existing runtime fail closed, preserving operator debugging evidence, keeping denied tools out of catalogs/search, and proving all behavior with focused unit tests before broad verification. Schema/config migration work is owned by `docs/superpowers/plans/2026-05-12-mcp-portal-schema-config-migration.md` and is not duplicated here.

**Tech Stack:** TypeScript, Zod 4, MCP TypeScript SDK, Hono Streamable HTTP, OpenClaw plugin hooks, Vitest, OXC/Oxfmt, pnpm.

---

## Scope

This plan owns:

- fail-closed portal scoping for the current config path
- per-tool allow/deny policy in the current portal access policy
- error-chain preserving redaction
- catalog redaction that does not clobber legitimate examples
- approval nonce and malformed approval input fixes
- branded identity/ref types
- structured portal result types
- doctor and Dockerfile test gaps
- SSE auth behavior test hardening
- startup error handling and normal-close observability

This plan does not own:

- `system.json` / `mcp.json` schema split
- `schemaVersion` / `$schema` rollout
- `agent-vm migrate mcp-portal`
- secure tools profiles
- general PII/content filtering

---

## File Structure

- Modify `packages/mcp-portal/src/portal-access-policy.ts`
  - Fail closed by default, add explicit `defaultPolicy`, add enabled tool selection.
- Modify `packages/mcp-portal/src/portal-session.ts`
  - Apply enabled/hidden tool policy before catalog and index construction.
- Modify `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`
  - Parse new current-branch policy knobs without waiting for the schema migration plan.
- Modify `packages/mcp-portal/src/upstream-response-middleware.ts`
  - Preserve error name/cause/stack/structured SDK fields while redacting secrets.
- Modify `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
  - Use exact-value-only catalog redaction and log/report close errors on normal close.
- Modify `packages/mcp-portal/src/catalog-types.ts`
  - Narrow forbidden metadata keys to identity-injection keys only.
- Modify `packages/mcp-portal/src/tool-ref.ts`
  - Brand `ToolRef`.
- Modify `packages/mcp-portal/src/portal-access-policy.ts`
  - Brand `PortalBindingIdentity`.
- Modify `packages/mcp-portal/src/mcp-server/portal-tools.ts`
  - Preserve discriminated result typing through handler boundaries.
- Modify `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
  - Fix approval nonce mutation check, malformed approval parsing, and startup error reporting.
- Modify `packages/mcp-portal/src/bin/mcp-portal-server.ts`
  - Either remove the dead always-401 bin or make it explicitly diagnostic-only.
- Modify `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
  - Fix zero-agent diagnostics and config-read cascade.
- Modify `packages/agent-vm/src/build/managed-image-release.test.ts`
  - Cover Tool VM Dockerfile portal helper install and no-secret invariant.
- Modify focused tests beside each source file.

---

### Task 1: Fail-Closed Scoping And Per-Tool Allow Policy

**Files:**
- Modify: `packages/mcp-portal/src/portal-access-policy.ts`
- Modify: `packages/mcp-portal/src/portal-session.ts`
- Modify: `packages/mcp-portal/src/portal-session.test.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/portal-config.test.ts`

- [ ] **Step 1: Write failing access-policy tests**

Add tests:

```ts
test('defaults to deny all namespaces when no policy is configured', async () => {
	const sessionManager = createPortalSessionManager({
		cacheTtlMs: 60_000,
		config: {
			defaultPolicy: 'deny-all',
			enabledNamespaces: [],
			enabledNamespacesByAgent: {},
			enabledToolsByAgent: {},
			hiddenToolsByAgent: {},
		},
		runtime,
	});

	const session = await sessionManager.getSession(createPortalBindingIdentity({
		agentId: 'agent-a',
		bindingId: 'binding-a',
	}));

	expect(session.catalog.namespaces).toEqual([]);
});

test('explicit allow-all exposes configured upstream namespaces', async () => {
	const policy = resolvePortalAccessPolicy({
		config: {
			defaultPolicy: 'allow-all',
			enabledNamespaces: [],
			enabledNamespacesByAgent: {},
			enabledToolsByAgent: {},
			hiddenToolsByAgent: {},
		},
		identity: createPortalBindingIdentity({ agentId: 'agent-a', bindingId: 'binding-a' }),
		upstreamNamespaces: ['linear', 'github'],
	});

	expect(policy.allowedNamespaces).toEqual(['github', 'linear']);
});

test('enabledToolsByAgent removes tools before catalog construction', async () => {
	const session = await sessionManager.getSession(identity);

	expect(session.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`)).toEqual([
		'linear.search_issues',
	]);
});
```

Run:

```bash
pnpm vitest run packages/mcp-portal/src/portal-session.test.ts packages/openclaw-mcp-portal-plugin/src/portal-config.test.ts
```

Expected: FAIL because `defaultPolicy`, `enabledToolsByAgent`, and branded identity helpers do not exist yet.

- [ ] **Step 2: Implement fail-closed policy**

Add:

```ts
export type PortalDefaultPolicy = 'allow-all' | 'deny-all';

export interface PortalAccessPolicyConfig {
	readonly defaultPolicy: PortalDefaultPolicy;
	readonly enabledNamespaces?: readonly string[];
	readonly enabledNamespacesByAgent: Readonly<Record<string, readonly string[]>>;
	readonly enabledToolsByAgent: Readonly<Record<string, readonly PortalToolSelector[]>>;
	readonly hiddenToolsByAgent: Readonly<Record<string, readonly PortalToolSelector[]>>;
}
```

Resolver rule:

```ts
const selectedNamespaces =
	agentNamespaces ??
	(globalNamespaces.length > 0
		? globalNamespaces
		: props.config.defaultPolicy === 'allow-all'
			? props.upstreamNamespaces
			: []);
```

- [ ] **Step 3: Apply tool policy before catalog/index**

In `portal-session.ts`, filter tools by `enabledToolsByAgent` and `hiddenToolsByAgent` before graph/search index construction. A denied tool must not appear in:

- `session.catalog.tools`
- `mcp_portal_list`
- `mcp_portal_search`
- `mcp_portal_describe`
- `mcp_portal_call`

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/portal-session.test.ts packages/mcp-portal/src/mcp-server/portal-tools.test.ts packages/openclaw-mcp-portal-plugin/src/portal-config.test.ts
```

Expected: PASS.

---

### Task 2: Brand Portal Identity And ToolRef

**Files:**
- Modify: `packages/mcp-portal/src/portal-access-policy.ts`
- Modify: `packages/mcp-portal/src/tool-ref.ts`
- Modify: all call sites in `packages/mcp-portal/src/**`
- Modify: all call sites in `packages/openclaw-mcp-portal-plugin/src/**`
- Modify: `packages/mcp-portal/src/tool-ref.test.ts`
- Modify: `packages/mcp-portal/src/portal-session.test.ts`

- [ ] **Step 1: Write failing brand tests**

Add compile/runtime oriented tests:

```ts
test('constructs portal binding identity only through trusted helper', () => {
	const identity = createPortalBindingIdentity({ agentId: 'agent-a', bindingId: 'binding-a' });

	expect(portalBindingScopeKey(identity)).toBe('binding-a');
});

test('decodeToolRef returns a branded ToolRef identity', () => {
	const toolRef = encodeToolRef({ namespace: 'linear', toolName: 'create_issue' });

	expect(decodeToolRef(toolRef)).toEqual({ namespace: 'linear', toolName: 'create_issue' });
});
```

Run:

```bash
pnpm vitest run packages/mcp-portal/src/tool-ref.test.ts packages/mcp-portal/src/portal-session.test.ts
```

Expected: FAIL because constructors/brands are absent.

- [ ] **Step 2: Add brands without non-null assertions**

Use module-private unique symbols:

```ts
declare const portalBindingIdentityBrand: unique symbol;

export type PortalBindingIdentity = {
	readonly agentId: string;
	readonly bindingId: string;
	readonly sessionId?: string;
	readonly [portalBindingIdentityBrand]: true;
};
```

Add `createPortalBindingIdentity`.

For tool refs:

```ts
declare const toolRefBrand: unique symbol;
export type ToolRef = string & { readonly [toolRefBrand]: true };
```

`encodeToolRef` returns `ToolRef`; `decodeToolRef` accepts `string` and returns a typed identity.

- [ ] **Step 3: Update call sites**

Replace object literals with `createPortalBindingIdentity`.
Do not use `as` casts except inside the trusted brand constructor.

- [ ] **Step 4: Run typecheck and focused tests**

Run:

```bash
pnpm typecheck
pnpm vitest run packages/mcp-portal/src/tool-ref.test.ts packages/mcp-portal/src/portal-session.test.ts packages/openclaw-mcp-portal-plugin/src
```

Expected: PASS.

---

### Task 3: Preserve Error Chains And Fix Catalog Redaction

**Files:**
- Modify: `packages/mcp-portal/src/upstream-response-middleware.ts`
- Modify: `packages/mcp-portal/src/upstream-response-middleware.test.ts`
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`

- [ ] **Step 1: Write failing redaction tests**

Add tests:

```ts
test('redactThrownError preserves name cause stack and structured fields', () => {
	const cause = new Error('dns root cause');
	const error = Object.assign(new Error('Bearer secret-token failed', { cause }), {
		name: 'McpError',
		code: -32001,
		data: { message: 'api_key=secret-token' },
	});
	error.stack = 'McpError: Bearer secret-token failed\n    at connect';

	const redacted = redactThrownError(error, { exactValues: ['secret-token'] });

	expect(redacted.name).toBe('McpError');
	expect(redacted.cause).toBe(error);
	expect(redacted.stack).toContain('[REDACTED]');
	expect(readErrorField(redacted, 'code')).toBe(-32001);
	expect(JSON.stringify(readErrorField(redacted, 'data'))).not.toContain('secret-token');
});

test('catalog redaction keeps credential-shaped examples but removes exact configured secrets', () => {
	const catalog = redactToolCatalogForTest(toolCatalogWithBearerExample, ['real-secret']);

	expect(JSON.stringify(catalog)).toContain('Bearer example-token');
	expect(JSON.stringify(catalog)).not.toContain('real-secret');
});
```

Run:

```bash
pnpm vitest run packages/mcp-portal/src/upstream-response-middleware.test.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Preserve error chain**

Implement `redactThrownError` so it:

- creates `new Error(redactedMessage, { cause: originalError })`
- preserves `name`
- preserves redacted `stack`
- copies redacted `code` and `data` if present
- does not use `any`

- [ ] **Step 3: Split catalog redaction**

Keep regex redaction for upstream responses/errors.
Use exact configured secret value redaction only for tool catalog text.
Tool docs/examples containing `Bearer example-token` must remain intact.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/upstream-response-middleware.test.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
```

Expected: PASS.

---

### Task 4: Fix Approval Nonce And Malformed Approval Input

**Files:**
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-tools.test.ts`

- [ ] **Step 1: Write failing approval tests**

Add tests:

```ts
test('blocks approval-required calls when params are immutable', async () => {
	const decision = await maybeRequireApprovalForTest({
		params: Object.freeze({
			calls: [{ id: 'call-1', namespace: 'linear', toolName: 'delete_issue', arguments: { issueId: 'A' } }],
		}),
	});

	expect(decision).toMatchObject({
		block: true,
		blockReason: expect.stringContaining('approval nonce'),
	});
});

test('blocks malformed portal call input in approval hook', async () => {
	const decision = await maybeRequireApprovalForTest({
		params: { calls: 'not-an-array' },
	});

	expect(decision).toMatchObject({
		block: true,
		blockReason: expect.stringContaining('Invalid MCP Portal call arguments'),
	});
});
```

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts packages/mcp-portal/src/mcp-server/portal-tools.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Replace dead nonce check**

Use:

```ts
try {
	event.params.portalApprovalNonce = approvalNonce;
} catch {
	return { block: true, blockReason: 'MCP Portal approval nonce could not be injected.' };
}

if (event.params.portalApprovalNonce !== approvalNonce) {
	return { block: true, blockReason: 'MCP Portal approval nonce could not be verified.' };
}
```

- [ ] **Step 3: Return invalid parse as blocked**

Change approval parsing to distinguish:

```ts
type PortalApprovalParseResult =
	| { readonly kind: 'not-portal-call' }
	| { readonly kind: 'invalid'; readonly message: string }
	| { readonly kind: 'valid'; readonly requests: readonly PortalApprovalRequest[] };
```

Malformed `mcp_portal_call` input returns `block: true`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts packages/mcp-portal/src/mcp-server/portal-tools.test.ts
```

Expected: PASS.

---

### Task 5: Tighten Metadata And Portal Result Types

**Files:**
- Modify: `packages/mcp-portal/src/catalog-types.ts`
- Modify: `packages/mcp-portal/src/catalog-types.test.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-tools.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests:

```ts
test('tool metadata allows legitimate schema-adjacent words', () => {
	const parsed = safeToolMetadataSchema.parse({
		headers: 'documented input field',
		authorization: 'documentation only',
		apiKey: 'schema field name',
	});

	expect(parsed).toMatchObject({ headers: 'documented input field' });
});

test('tool metadata rejects identity injection keys', () => {
	expect(() => safeToolMetadataSchema.parse({ agentId: 'agent-a' })).toThrow(/agentId/u);
	expect(() => safeToolMetadataSchema.parse({ bindingId: 'binding-a' })).toThrow(/bindingId/u);
});
```

Run:

```bash
pnpm vitest run packages/mcp-portal/src/catalog-types.test.ts packages/mcp-portal/src/mcp-server/portal-tools.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Narrow forbidden metadata keys**

Only block:

```ts
agentId
bindingId
sessionId
runId
authProfile
portalApprovalNonce
```

Do not block:

```ts
headers
authorization
secret
token
apiKey
env
```

Credential values are handled by redaction, not metadata key bans.

- [ ] **Step 3: Preserve portal result unions**

Replace broad boundary types with:

```ts
export type PortalToolResult<TOutput = unknown, TInput = unknown> =
	| { readonly ok: true; readonly input: TInput; readonly output: TOutput }
	| { readonly ok: false; readonly input: TInput; readonly error: PortalToolError };
```

Keep `results` as `Readonly<Record<string, PortalToolResult>>`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/catalog-types.test.ts packages/mcp-portal/src/mcp-server/portal-tools.test.ts
pnpm typecheck
```

Expected: PASS.

---

### Task 6: Runtime Startup, Close Errors, And Dead Bin

**Files:**
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts`
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`
- Modify: `packages/mcp-portal/src/bin/mcp-portal-server.ts`
- Modify: `packages/mcp-portal/src/bin/agent-vm-mcp-portal.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests:

```ts
test('reports initial portal runtime construction failures', async () => {
	await registerOpenClawMcpPortalPlugin(api);

	expect(api.logger.error).toHaveBeenCalledWith(expect.stringContaining('MCP Portal startup failed'));
});

test('normal close reports close failures', async () => {
	await runtime.closeBinding(identity);

	expect(closeErrors).toEqual([expect.stringContaining('close failed')]);
});
```

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Add startup catch**

Change:

```ts
void runtimeReloader.get().then(...)
```

to:

```ts
void runtimeReloader
	.get()
	.then(...)
	.catch((error: unknown) => {
		api.logger.error(`MCP Portal startup failed: ${getErrorMessage(error)}`);
	});
```

- [ ] **Step 3: Add normal close error callback**

Replace `closeClientAfterFailure` with two paths:

- failure cleanup: best effort, preserve original error
- normal close: report via `onCloseError`

- [ ] **Step 4: Resolve `mcp-portal-server` bin decision**

If keeping the bin, make it fail clearly unless a config path is supplied:

```text
mcp-portal-server requires a binding config file; the OpenClaw plugin is the managed production transport.
```

If removing the bin, remove it from `package.json` and tests. Pick one path and document it in the test name.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts packages/mcp-portal/src/bin
```

Expected: PASS.

---

### Task 7: Doctor And Managed Image Test Gaps

**Files:**
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
- Modify: `packages/agent-vm/src/operations/doctor.ts`
- Modify: `packages/agent-vm/src/operations/doctor.test.ts`
- Modify: `packages/agent-vm/src/build/managed-image-release.test.ts`

- [ ] **Step 1: Write failing doctor and Dockerfile tests**

Add tests:

```ts
it('fails MCP Portal agent binding checks when no OpenClaw agents are configured', () => {
	const result = runOpenClawDeploymentDoctor(config);

	expect(result.checks).toContainEqual({
		name: 'mcp-portal-agent-bindings:shravan',
		ok: false,
		hint: expect.stringContaining('No OpenClaw agents are configured'),
	});
});

it('reports config read failure without cascading misleading portal checks', () => {
	const result = runOpenClawDeploymentDoctor(configWithUnreadableOpenClawJson);

	expect(result.checks.filter((check) => check.name.includes('mcp-portal'))).toEqual([]);
});

it('generates Tool VM Dockerfile with MCP Portal helper and no auth literals', () => {
	const dockerfile = buildManagedImageDockerfile({ base: 'tool-vm', mcpPortalPackageSpec: '@agent-vm/mcp-portal@0.0.58' });

	expect(dockerfile).toContain('pnpm add -g "@agent-vm/mcp-portal@');
	expect(dockerfile).not.toMatch(/TOKEN|Authorization|\\.npmrc|\\.netrc|_authToken|Bearer/u);
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts packages/agent-vm/src/operations/doctor.test.ts packages/agent-vm/src/build/managed-image-release.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Fix diagnostics**

Rules:

- zero agents is a failed MCP Portal binding check when the portal plugin is enabled
- config read failure emits the root read/parse failure and skips dependent checks
- Tool VM Dockerfile branch is covered by no-secret assertions

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts packages/agent-vm/src/operations/doctor.test.ts packages/agent-vm/src/build/managed-image-release.test.ts
```

Expected: PASS.

---

### Task 8: SSE Header Behavior And Call Handler Coverage

**Files:**
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-tools.test.ts`

- [ ] **Step 1: Write failing behavior tests**

Add tests:

```ts
test('SSE auth headers are applied to stream GET and recurring POST', async () => {
	const recordedRequests = await runFakeSseServerScenario({
		headers: { Authorization: 'Bearer secret-token' },
	});

	expect(recordedRequests).toEqual([
		expect.objectContaining({ method: 'GET', authorization: 'Bearer secret-token' }),
		expect.objectContaining({ method: 'POST', authorization: 'Bearer secret-token' }),
	]);
});

test('call handler blocks upstream call when schema validation is unavailable', async () => {
	const result = await portalTools.mcp_portal_call({ calls: [unsupportedSchemaCall] });

	expect(result.results['call-1']).toMatchObject({
		ok: false,
		error: { kind: 'schema_validation_unavailable' },
	});
	expect(runtime.callUpstreamTool).not.toHaveBeenCalled();
});
```

Run:

```bash
pnpm vitest run packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts packages/mcp-portal/src/mcp-server/portal-tools.test.ts
```

Expected: FAIL for the missing behavior tests.

- [ ] **Step 2: Add fake SSE behavior harness**

Use an in-process HTTP server or injectable transport seam that records both verbs. Do not rely on shape-only `requestInit.headers` assertions.

- [ ] **Step 3: Add handler-layer schema-unavailable fixture**

Use a catalog tool whose input schema intentionally fails Zod reconstruction. Assert the portal call does not reach upstream.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts packages/mcp-portal/src/mcp-server/portal-tools.test.ts
```

Expected: PASS.

---

### Task 9: Documentation And Plan Cleanup

**Files:**
- Modify: `docs/subsystems/mcp-portal.md`
- Modify: `docs/superpowers/plans/2026-05-10-mcp-capability-portal.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Write failing manual/doc tests**

Add assertions that generated manual text contains:

```text
MCP Portal defaults to deny-all namespace exposure unless the deployment config enables namespaces.
MCP Portal logging is controlled separately from content filtering.
Use agent-vm migrate mcp-portal for the schema/config split.
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Update docs**

Docs must state:

- deny-all default
- per-agent namespace and tool policy
- exact-secret-only catalog redaction
- annotation trust is opt-in by namespace
- logging is audit logging, not response filtering
- schema/config migration is in the separate schema plan
- no general content filtering in v1

- [ ] **Step 3: Remove stale plan cruft**

In `2026-05-10-mcp-capability-portal.md`, update or remove claims that conflict with current decisions:

- `enabledNamespaces: [] means all configured upstream servers`
- old stdio-first language
- any claim that OpenClaw `agents.list` is the canonical agent registry after the schema migration lands

- [ ] **Step 4: Run docs tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

---

### Task 10: Final Verification

**Files:**
- No planned source edits except fixes discovered by verification.

- [ ] **Step 1: Run focused MCP Portal tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src packages/openclaw-mcp-portal-plugin/src
```

Expected: PASS.

- [ ] **Step 2: Run focused agent-vm tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/build/managed-image-release.test.ts packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts packages/agent-vm/src/operations/doctor.test.ts packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run unit tests**

Run:

```bash
pnpm test:unit
```

Expected: PASS.

- [ ] **Step 5: Run build**

Run:

```bash
pnpm -r build
```

Expected: PASS.

- [ ] **Step 6: Run full check**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 7: Run smoke tests**

Run:

```bash
pnpm test:smoke
```

Expected: PASS.

- [ ] **Step 8: Record integration status**

Run only if the environment is ready for live VM tests:

```bash
pnpm test:integration
```

Expected: PASS, or explicitly report known live-environment failures by test name, assertion, and exit code.

---

## Self-Review

- Spec coverage: This plan covers the branch hardening checklist and leaves schema/config migration to the separate schema plan.
- Placeholder scan: No placeholder tasks remain; every task names exact files and commands.
- Type consistency: The plan consistently uses `PortalBindingIdentity`, `ToolRef`, `defaultPolicy`, `enabledToolsByAgent`, `hiddenToolsByAgent`, and `PortalToolResult`.
