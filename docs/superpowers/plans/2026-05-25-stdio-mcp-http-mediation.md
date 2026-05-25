# Stdio MCP HTTP Mediation Validation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove whether stdio MCP servers such as Perplexity and Firecrawl can safely use Gondolin HTTP-mediated placeholder env vars instead of raw secret env injection, then update beta/sunfam config and docs only if the live evidence supports it.

**Architecture:** MCP Portal provider configs always rewrite authored provider secrets into generated environment references. The injection policy decides whether the gateway VM receives the generated env var as a raw secret (`env`) or as a Gondolin placeholder (`http-mediation`). For stdio MCP, the server process still reads an env var in both cases; the difference is whether the value is the real API key or a placeholder that Gondolin substitutes only on allowed outbound hosts.

**Tech Stack:** TypeScript, pnpm, Vitest, agent-vm gateway config, Gondolin `createHttpHooks`, OpenClaw MCP Portal.

---

## Related Validation Lanes

This plan owns the stdio MCP secret-mediation lane for Perplexity and Firecrawl.
It also includes a beta-only Discord WebSocket routing experiment because the
same Gondolin WebSocket capability prompted the security-model question.

The MCP Portal proxy/approval behavior is covered by the separate plan
`docs/superpowers/plans/2026-05-25-mcp-portal-item-level-approval.md`.
Do not mix those implementation changes into this plan. Reuse its beta smoke
steps when validating that the published/installed MCP Portal package still
handles mixed batches and homogeneous approval retries correctly.

## Current Mental Model

`http-mediation` is not only for remote HTTP transports. It can also work for stdio MCP providers when the upstream server reads an env var and later places that value into an HTTP header that Gondolin supports for substitution.

The critical path is:

```text
authored mcp.config.jsonc
  secretPolicies.NAME.injection = "http-mediation"
        │
        ▼
packages/agent-vm/src/gateway/mcp-portal-effective-config.ts
  rewrites provider secret to { source: "environment", name: AGENT_VM_MCP_* }
  puts resolved real secret in runtimeMediatedSecrets, not runtimeEnvironment
        │
        ▼
packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts
  passes runtimeMediatedSecrets into gateway VM options
        │
        ▼
packages/gondolin-adapter/src/vm-adapter.ts
  createHttpHooks({ secrets }) returns { httpHooks, env }
  VM.create receives both httpHooks and placeholder env
        │
        ▼
packages/mcp-portal/src/upstream-mcp-client-runtime.ts
  stdio MCP process receives provider env value
        │
        ▼
upstream API request
  Authorization/API header contains placeholder
  Gondolin swaps placeholder for real secret only for allowed hosts
```

The live beta config currently does not test that path for Perplexity and Firecrawl. It uses `injection: "env"` for both, so successful discovery/calls only prove raw env works.

---

## Files

### Code And Tests

- Modify: `packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts`
  - Add focused unit coverage that a stdio provider with `http-mediation` materializes as a generated env reference plus `runtimeMediatedSecrets`, with no raw runtime env.

- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
  - Add or adjust gateway-start coverage to assert stdio MCP mediated provider secrets are passed to VM `secrets` under the generated `AGENT_VM_MCP_*` name and are not present in VM `env`.

- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`
  - Add a unit assertion that `createManagedVm` passes both `httpHooks` and the hook-generated placeholder env into `VM.create`, and that caller env is layered separately.

- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`
  - Add a regression assertion that stdio provider env values are passed through exactly to `StdioClientTransport`; this covers placeholder strings just as much as raw strings.

- Optional Modify: `packages/agent-vm/src/integration-tests/live-http-mediation.integration.test.ts`
  - Add a live VM check that a subprocess sees a `GONDOLIN_SECRET_*` placeholder env var and can use it in an outbound `Authorization` header. This is gated by the existing live integration environment.

### Docs

- Modify if mediation succeeds: `docs/subsystems/secrets-and-credentials.md`
  - Clarify that stdio MCP can use `http-mediation` when the server sends the env value in supported outbound header/query locations.

- Modify if mediation succeeds: `docs/subsystems/gondolin-vm-layer.md`
  - Add the exact boundary: the gateway process and its stdio children see placeholders, not real values.

- Modify if mediation succeeds: `packages/agent-vm/src/cli/manual-templates.ts`
  - Update generated MCP Portal guidance so deployment agents prefer `http-mediation` for stdio MCP API keys when the upstream server uses header auth.

- Modify if manuals change: `packages/agent-vm/src/cli/manual-templates.test.ts`
  - Pin the new manual text.

### Deployment Configs

- Modify for beta experiment: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/gateways/beta/mcp.config.jsonc`
  - Change Perplexity and Firecrawl from raw env injection to HTTP mediation.

- Modify for beta experiment: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc`
  - Remove the raw-env exceptions for generated Perplexity and Firecrawl MCP env names if no other provider still needs them.

- Modify after beta proof: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/config/gateways/sunfam/mcp.config.jsonc`
  - Apply the same Perplexity and Firecrawl `http-mediation` config.

- Modify after beta proof: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/config/system.jsonc`
  - Remove the matching raw-env exceptions if present.

### Discord WebSocket Routing Experiment

- Modify for beta experiment only: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc`
  - Keep `DISCORD_BOT_TOKEN_PULSE` as raw env.
  - Remove `gateway.discord.gg:443` from `websocketBypass`.
  - Add `gateway.discord.gg` to gateway egress if it is not already present.

- Modify after beta proof only: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/config/system.jsonc`
  - Apply the same `websocketBypass` removal and `gateway.discord.gg` egress host if beta proves normal Gondolin WebSocket egress works.

---

## Task 1: Pin The Existing Contract With Tests

**Files:**
- Modify: `packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`
- Modify: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`

- [ ] **Step 1: Add a failing effective-config test for stdio HTTP mediation**

Add a test to `packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts` near the existing secret materialization tests:

```ts
it('materializes stdio provider http-mediation secrets as placeholder environment references', async () => {
	const authoredDir = await createAuthoredDir({
		mcpConfig: {
			providers: {
				perplexity: {
					kind: 'mcp',
					namespace: 'perplexity',
					secretPolicies: {
						PERPLEXITY_API_KEY: {
							hosts: ['api.perplexity.ai'],
							injection: 'http-mediation',
						},
					},
					transport: {
						args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
						command: 'npx',
						env: {
							PERPLEXITY_API_KEY: {
								ref: 'op://agent-vm/sunfam-perplexity/credential',
								source: '1password',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.perplexity.ai'],
					},
				},
			},
			schemaVersion: 1,
		},
	});
	const effectiveDir = path.join(authoredDir, 'effective');
	const secretResolver = createSecretResolver({
		'op://agent-vm/sunfam-perplexity/credential': 'resolved-pplx-key',
	});

	const result = await writeMcpPortalEffectiveConfig({
		authoredConfigDir: authoredDir,
		effectiveHostConfigDir: effectiveDir,
		effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
		secretResolver,
		zoneId: 'beta',
	});
	const effectiveMcpConfig = await readEffectiveMcpConfig<{
		readonly providers: Record<string, { readonly transport: { readonly env: unknown } }>;
	}>(effectiveDir);

	expect(effectiveMcpConfig.providers.perplexity?.transport.env).toEqual({
		PERPLEXITY_API_KEY: {
			name: 'AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY',
			source: 'environment',
		},
	});
	expect(result.runtimeEnvironment).toEqual({});
	expect(result.runtimeMediatedSecrets).toEqual({
		AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: {
			hosts: ['api.perplexity.ai'],
			value: 'resolved-pplx-key',
		},
	});
});
```

- [ ] **Step 2: Run the focused effective-config test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts
```

Expected before implementation changes: the new test should pass if the current code already implements the contract. If it fails, stop and inspect the actual materialization path before changing deployment config.

- [ ] **Step 3: Add gateway VM option coverage**

In `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`, either extend the existing `splits env secrets from http-mediation secrets based on injection config` test or add a sibling test. The assertion must prove this shape for a stdio MCP provider:

```ts
expect(vmOptions.secrets).toMatchObject({
	AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: {
		hosts: ['api.perplexity.ai'],
		value: 'pplx-key',
	},
});
expect(vmOptions.env).not.toHaveProperty('AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY');
```

This test prevents a future regression where stdio mediated secrets accidentally become raw env again.

- [ ] **Step 4: Add VM adapter placeholder env coverage**

In `packages/gondolin-adapter/src/vm-adapter.test.ts`, add or extend a test so the fake `createHttpHooks` returns a secret placeholder env and `VM.create` receives it:

```ts
const dependencies = {
	...createBaseDependencies({
		createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
			capturedVmOptions = vmOptions;
			return createFakeVmInstance();
		}),
	}),
	createHttpHooks: vi.fn(() => ({
		env: { AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder' },
		httpHooks: {} satisfies HttpHooks,
	})),
} satisfies ManagedVmDependencies;
```

Assert:

```ts
expect(capturedVmOptions?.env).toMatchObject({
	AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder',
	OPENCLAW_LOG_LEVEL: 'debug',
});
```

- [ ] **Step 5: Add MCP Portal stdio env pass-through coverage**

In `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`, add a regression test next to the existing stdio env preservation tests:

```ts
it('passes mediated placeholder env values through to stdio MCP transports', async () => {
	const transportFactory = vi.fn(() => fakeTransport);
	const runtime = createUpstreamMcpClientRuntime({
		clientFactory,
		transportFactory,
	});

	await runtime.discoverTools({
		args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
		command: 'npx',
		env: {
			PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder',
		},
		namespace: 'perplexity',
		transport: 'stdio',
	});

	expect(transportFactory).toHaveBeenCalledWith(
		expect.objectContaining({
			env: expect.objectContaining({
				PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder',
			}),
			transport: 'stdio',
		}),
	);
});
```

If the test helper names differ from this snippet, use the helper names already present in that file and preserve the same assertion.

- [ ] **Step 6: Run the targeted tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts \
  packages/gondolin-adapter/src/vm-adapter.test.ts \
  packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 7: Commit the code-level contract tests**

Run:

```bash
git add \
  packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts \
  packages/gondolin-adapter/src/vm-adapter.test.ts \
  packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts
git commit -m "test: pin stdio mcp mediation contract"
```

---

## Task 2: Run A Beta-Only Mediation Experiment

**Files:**
- Modify: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/gateways/beta/mcp.config.jsonc`
- Modify: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc`

- [ ] **Step 1: Confirm current beta is using raw env for Perplexity and Firecrawl**

Run:

```bash
rg -n '"perplexity"|"firecrawl"|"rawEnvSecrets"|AGENT_VM_MCP_PERPLEXITY|AGENT_VM_MCP_FIRECRAWL' \
  /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config
```

Expected: `mcp.config.jsonc` shows `injection: "env"` for both provider API keys, and `system.jsonc` allowlists the generated raw env names.

- [ ] **Step 2: Change Perplexity to HTTP mediation**

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/gateways/beta/mcp.config.jsonc`, change:

```jsonc
"PERPLEXITY_API_KEY": {
	"injection": "env",
	"hosts": []
}
```

to:

```jsonc
"PERPLEXITY_API_KEY": {
	"injection": "http-mediation",
	"hosts": ["api.perplexity.ai"]
}
```

Keep the stdio transport env reference unchanged:

```jsonc
"PERPLEXITY_API_KEY": {
	"source": "1password",
	"ref": "op://agent-vm/sunfam-perplexity/credential"
}
```

- [ ] **Step 3: Change Firecrawl to HTTP mediation**

In the same file, change:

```jsonc
"FIRECRAWL_API_KEY": {
	"injection": "env",
	"hosts": []
}
```

to:

```jsonc
"FIRECRAWL_API_KEY": {
	"injection": "http-mediation",
	"hosts": ["api.firecrawl.dev"]
}
```

Keep the stdio transport env reference unchanged:

```jsonc
"FIRECRAWL_API_KEY": {
	"source": "1password",
	"ref": "op://agent-vm/sunfam-firecrawl/credential"
}
```

- [ ] **Step 4: Remove raw env exceptions from beta system config**

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc`, remove these entries from `zones[].gateway.rawEnvSecrets` if present:

```jsonc
"AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY",
"AGENT_VM_MCP_FIRECRAWL_FIRECRAWL_API_KEY"
```

Leave unrelated raw env entries alone.

- [ ] **Step 5: Validate beta config before restart**

Run from `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`:

```bash
pnpm validate
pnpm doctor
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
```

Expected:

```text
pnpm validate                                exit 0
pnpm doctor                                  exit 0
agent-vm validate --mcp-live                 exit 0
```

The live validation should still discover at least these namespaces:

```text
deepwiki
firecrawl
linear
perplexity
tavily
```

- [ ] **Step 6: Restart beta using the deployment’s normal start/stop flow**

Run from `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`:

```bash
pnpm stop
pnpm start
pnpm exec agent-vm controller status
```

Expected: beta is running, with the installed package still on the intended published version.

- [ ] **Step 7: Inspect the effective generated MCP config**

Run:

```bash
manifest=/Users/shravansunder/.agent-vm/cache/gateways/beta/mcp-portal-effective/mcp-portal-effective-manifest.json
mcp_file=$(node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(m.mcpConfigFile)' "$manifest")
sed -n '1,220p' "/Users/shravansunder/.agent-vm/cache/gateways/beta/mcp-portal-effective/$mcp_file"
```

Expected:

```jsonc
"PERPLEXITY_API_KEY": { "name": "AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY", "source": "environment" }
"FIRECRAWL_API_KEY": { "name": "AGENT_VM_MCP_FIRECRAWL_FIRECRAWL_API_KEY", "source": "environment" }
```

Do not expect the real API key to appear in the effective config.

- [ ] **Step 8: Ask beta to run the live MCP calls**

Send beta this exact request:

```text
Describe then call these MCP Portal tools serially:

1. perplexity.perplexity_ask with the smallest valid input from describe. Ask: "Reply with exactly: mediated-perplexity-ok"
2. firecrawl.firecrawl_map with url "https://example.com"

Then run one parallel batch with both calls together.

Report:
- whether list/describe worked
- exact call success/failure per tool
- whether either error looks like missing API key, blocked egress, input validation, or upstream service failure
```

Expected success condition:

```text
perplexity call succeeds
firecrawl call succeeds
parallel batch returns itemized results
no missing API key error
no forbidden egress error
```

- [ ] **Step 9: Inspect logs after beta runs the calls**

Run:

```bash
rg -n \
  'perplexity|firecrawl|api\.perplexity\.ai|api\.firecrawl\.dev|AGENT_VM_MCP_PERPLEXITY|AGENT_VM_MCP_FIRECRAWL|GONDOLIN_SECRET|mcp_portal' \
  /Users/shravansunder/.agent-vm/state/beta \
  /Users/shravansunder/.agent-vm/runtime/zones/beta \
  -g '*.log' -g '*.jsonl' -g '*.json' \
  | tail -200
```

Expected:

```text
No real API key values in logs.
Enough MCP Portal call evidence to correlate beta’s report with runtime logs.
If there is a failure, the log points to one of:
  auth rejected
  egress blocked
  upstream timeout
  stdio connect failure
  MCP input validation
```

- [ ] **Step 10: Commit beta experiment only if it works**

If both providers work with mediation, run from `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`:

```bash
git status --short
git add config/gateways/beta/mcp.config.jsonc config/system.jsonc
git commit -m "chore: mediate stdio mcp secrets in beta"
git push
```

If either provider fails because its upstream MCP server cannot use placeholder env values in supported outbound request locations, do not commit the beta config. Revert only the beta experiment edits you made in this task.

---

## Task 3: Decide The Product Default

**Files:**
- No code files unless the beta experiment succeeds.

- [ ] **Step 1: Classify beta result**

Use this decision table:

```text
Observed result                                      Decision
───────────────────────────────────────────────────  ─────────────────────────────
Both Perplexity and Firecrawl calls succeed           Prefer http-mediation for these stdio MCP providers.
Discovery succeeds, calls fail missing API key        Upstream server did not put placeholder in a substituted header/query.
Call fails forbidden egress                           Fix hosts/requiredEgressHosts, then retest.
Call fails input_validation                           Keep mediation question open; fix/test schema separately.
Call fails stdio connect/spawn                        Not a mediation result; fix npx/runtime path separately.
Firecrawl upstream 5xx only                           Not a mediation result; mark provider flaky and retest later.
```

- [ ] **Step 2: If mediation succeeds, apply the same config to sunfam**

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/config/gateways/sunfam/mcp.config.jsonc`, apply the same secret policy changes:

```jsonc
"PERPLEXITY_API_KEY": {
	"injection": "http-mediation",
	"hosts": ["api.perplexity.ai"]
}
```

```jsonc
"FIRECRAWL_API_KEY": {
	"injection": "http-mediation",
	"hosts": ["api.firecrawl.dev"]
}
```

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/config/system.jsonc`, remove matching raw env exceptions if present:

```jsonc
"AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY",
"AGENT_VM_MCP_FIRECRAWL_FIRECRAWL_API_KEY"
```

- [ ] **Step 3: Validate sunfam config**

Run from `/Users/shravansunder/Documents/dev/project-dev/shravan-claw`:

```bash
pnpm validate
pnpm doctor
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
```

Expected:

```text
pnpm validate                                exit 0
pnpm doctor                                  exit 0
agent-vm validate --mcp-live                 exit 0
```

- [ ] **Step 4: Commit sunfam config if validation passes**

Run from `/Users/shravansunder/Documents/dev/project-dev/shravan-claw`:

```bash
git status --short
git add config/gateways/sunfam/mcp.config.jsonc config/system.jsonc
git commit -m "chore: mediate stdio mcp secrets"
git push
```

---

## Task 4: Update Agent-VM Docs If The New Default Is Proven

**Files:**
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/subsystems/gondolin-vm-layer.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Update subsystem docs**

In `docs/subsystems/secrets-and-credentials.md`, add this operational rule near the MCP Portal secret policy section:

```markdown
For stdio MCP providers, prefer `injection: "http-mediation"` when the upstream
server reads an API key from env and sends it in an outbound header supported by
Gondolin substitution. The stdio process receives a placeholder env value, not
the real secret. Use raw `env` injection only when the upstream server cannot
operate with a placeholder, such as when it validates token shape locally or
sends the secret in a request body/path that Gondolin does not substitute.
```

In `docs/subsystems/gondolin-vm-layer.md`, add this boundary note near the HTTP mediation section:

```markdown
Gateway processes and their stdio children receive generated placeholder env
values for mediated secrets. Gondolin substitutes the real value only on
matching outbound requests. Passing both `httpHooks` and the generated `env`
bundle to `VM.create` is therefore required for mediated stdio MCP secrets.
```

- [ ] **Step 2: Update generated manuals**

In `packages/agent-vm/src/cli/manual-templates.ts`, update the MCP Portal manual template so it says:

```markdown
Prefer `http-mediation` for MCP provider API keys, including stdio providers,
when the provider sends the env value in outbound headers. The MCP server sees
a placeholder env var; Gondolin swaps it for the real secret only for the
configured hosts. Use raw `env` injection only as an explicit exception.
```

- [ ] **Step 3: Update manual template tests**

In `packages/agent-vm/src/cli/manual-templates.test.ts`, add assertions that the generated MCP Portal manual contains:

```ts
expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
	'Prefer `http-mediation` for MCP provider API keys, including stdio providers',
);
expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
	'Use raw `env` injection only as an explicit exception',
);
```

- [ ] **Step 4: Run docs/manual tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add \
  docs/subsystems/secrets-and-credentials.md \
  docs/subsystems/gondolin-vm-layer.md \
  packages/agent-vm/src/cli/manual-templates.ts \
  packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs: clarify stdio mcp secret mediation"
```

---

## Task 5: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run the full agent-vm quality gate**

Run from `/Users/shravansunder/Documents/dev/project-dev/agent-vm.mcp-portal-debugging`:

```bash
pnpm check
```

Expected: exit 0.

- [ ] **Step 2: Run targeted smoke if live VM gates are available**

Run:

```bash
mise exec -- pnpm test:smoke
```

Expected: exit 0, or documented skips only for unavailable live gates.

- [ ] **Step 3: Inspect git state**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: only intended commits are present; no unrelated dirty files were committed.

- [ ] **Step 4: Prepare merge or PR summary**

Include:

```text
What changed:
- Added tests pinning stdio MCP HTTP mediation contract.
- If beta proved it: moved Perplexity/Firecrawl from raw env to http-mediation.
- If beta proved it: updated docs/manuals to recommend mediation for stdio header-auth MCP providers.

Validation:
- Targeted Vitest commands and pass/fail counts.
- pnpm check result.
- Beta validate/doctor/mcp-live result.
- Beta call result for Perplexity and Firecrawl.

Security outcome:
- Real API keys are not placed in gateway env for Perplexity/Firecrawl.
- Gateway stdio MCP receives Gondolin placeholders.
- Substitution is host-scoped to api.perplexity.ai and api.firecrawl.dev.
```

---

## Self-Review

- Spec coverage: The plan separates the code-level mediation contract, beta-only live experiment, product-default decision, deployment config rollout, and docs/manual follow-up.
- Placeholder scan: No task uses TODO/TBD. The only conditional work is explicitly gated on beta evidence.
- Type consistency: The same generated env names are used throughout:
  - `AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY`
  - `AGENT_VM_MCP_FIRECRAWL_FIRECRAWL_API_KEY`

---

## Task 6: Beta-Only Discord WebSocket Routing Experiment

**Files:**
- Modify: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc`
- Modify after beta proof: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/config/system.jsonc`
- Modify after beta proof: `docs/subsystems/gondolin-vm-layer.md`
- Modify after beta proof: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify after beta proof: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Confirm the OpenClaw Discord token path stays raw env**

Run:

```bash
rg -n 'DISCORD_BOT_TOKEN|rawEnvSecrets|gateway\.discord|websocketBypass' \
  /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc \
  /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/gateways/beta/openclaw.json
```

Expected:

```text
DISCORD_BOT_TOKEN_PULSE is a gateway env secret.
DISCORD_BOT_TOKEN_PULSE is listed in gateway.rawEnvSecrets.
OpenClaw config references DISCORD_BOT_TOKEN_PULSE through env SecretRef.
```

Do not change this token to `http-mediation`. OpenClaw sends the Discord bot
token in Gateway Identify/Resume JSON frames after the WebSocket opens, and
Gondolin cannot substitute inside opaque post-upgrade WebSocket frames.

- [ ] **Step 2: Confirm current beta WebSocket bypass shape**

Run:

```bash
rg -n 'websocketBypass|gateway\.discord\.gg|egressHosts' \
  /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc
```

Expected before the experiment:

```text
websocketBypass contains gateway.discord.gg:443.
egressHosts may not contain gateway.discord.gg as a normal HTTP/WebSocket egress host.
```

- [ ] **Step 3: Remove only the raw TCP WebSocket bypass in beta**

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc`, remove:

```jsonc
"gateway.discord.gg:443"
```

from `websocketBypass`.

Do not remove Discord REST/media egress hosts.

- [ ] **Step 4: Add normal gateway egress for Discord Gateway**

In the same beta system config, add this entry to `egressHosts` if it is not
already present:

```jsonc
{ "host": "gateway.discord.gg", "audience": "gateway" }
```

This tests Gondolin's normal HTTP/1.1 WebSocket upgrade path instead of the
explicit raw TCP bypass path.

- [ ] **Step 5: Validate and restart beta**

Run from `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`:

```bash
pnpm validate
pnpm doctor
pnpm stop
pnpm start
pnpm exec agent-vm controller status
```

Expected:

```text
pnpm validate                 exit 0
pnpm doctor                   exit 0
controller status             beta running
```

- [ ] **Step 6: Ask beta to prove Discord receive/send still works**

Send one normal Discord message to Pulse-beta and ask it:

```text
Please reply once, then run session_status. Keep it short.
```

Expected:

```text
Pulse-beta receives the message.
Pulse-beta replies in Discord.
session_status works.
No fatal Discord gateway close appears.
```

- [ ] **Step 7: Check beta logs for WebSocket failures**

Run:

```bash
rg -n 'gateway\.discord\.gg|websocket|Gateway websocket|IDENTIFY|Identify|READY|ready|4004|Fatal gateway close|blocked|Forbidden' \
  /Users/shravansunder/.agent-vm/state/beta \
  /Users/shravansunder/.agent-vm/runtime/zones/beta \
  -g '*.log' -g '*.jsonl' -g '*.json' \
  | tail -200
```

Expected success:

```text
No 4004 authentication failure.
No "websocket upgrade blocked" style failure.
No repeated READY timeout loop.
Normal Discord receive/send behavior remains intact.
```

- [ ] **Step 8: Decide whether to apply to sunfam**

Use this decision table:

```text
Observed result                                      Decision
───────────────────────────────────────────────────  ─────────────────────────────
Discord works without websocketBypass                Remove websocketBypass from sunfam too.
WebSocket blocked before 101                         Keep bypass; document current Gondolin limit.
WebSocket opens but 4004 auth failure                Revert immediately; unexpected token path issue.
READY timeout / reconnect loop                       Revert beta; inspect OpenClaw gateway logs.
```

- [ ] **Step 9: If beta succeeds, apply the same routing change to sunfam**

In `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/config/system.jsonc`:

```text
Remove gateway.discord.gg:443 from websocketBypass.
Add { "host": "gateway.discord.gg", "audience": "gateway" } to egressHosts if missing.
Keep all DISCORD_BOT_TOKEN_* raw env exceptions.
```

Then run:

```bash
pnpm validate
pnpm doctor
git status --short
git add config/system.jsonc
git commit -m "chore: route discord gateway through mediated websocket egress"
git push
```

- [ ] **Step 10: If beta succeeds, update docs/manuals**

Update docs to distinguish the two Discord boundaries:

```text
Discord bot tokens remain raw gateway env secrets because OpenClaw sends them
inside Discord Gateway Identify/Resume frames after WebSocket upgrade.

Discord Gateway network routing can use normal Gondolin WebSocket egress when
gateway.discord.gg is allowlisted; raw websocketBypass is only needed if normal
WebSocket egress fails in the deployed Gondolin version.
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
pnpm check
```

