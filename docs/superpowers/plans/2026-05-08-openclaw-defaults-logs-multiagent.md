# OpenClaw Defaults, Logs, Doctor, And Multi-Agent Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make fresh OpenClaw/Gondolin deployments match the working `shravan-claw` defaults and expose the operational feedback needed to debug them.

**Architecture:** Keep the first patch set small and directly tied to the deployment lessons: scaffold OpenClaw defaults for `web_fetch` fake-IP SSRF policy and `openai-codex/gpt-5.5`, expand existing zone logs to include runtime OpenClaw logs, improve doctor output/checks, and add a multi-agent scaffold flag. Defer provider-mediated public web fetch and tool-scoped `webFetchAllowlist` to a separate design because that changes the network trust boundary.

**Tech Stack:** TypeScript, pnpm, Vitest, OpenClaw config JSON, agent-vm controller HTTP/CLI.

---

### Task 1: OpenClaw Scaffold Defaults

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [x] **Step 1: Add failing tests for gpt-5.5 and web_fetch SSRF defaults**

Add assertions to the existing OpenClaw scaffold test so it expects:

```ts
expect(openClawConfig.agents.defaults.model.primary).toBe('openai-codex/gpt-5.5');
expect(openClawConfig.agents.defaults.thinkingDefault).toBe('low');
expect(openClawConfig.tools.web.fetch.ssrfPolicy).toEqual({
	allowRfc2544BenchmarkRange: true,
	allowIpv6UniqueLocalRange: true,
});
```

- [x] **Step 2: Run the focused failing test**

Run:

```sh
pnpm test:unit -- packages/agent-vm/src/cli/init-command.test.ts
```

Expected: FAIL because scaffold still uses `openai-codex/gpt-5.4` and lacks `tools.web.fetch.ssrfPolicy`.

- [x] **Step 3: Update `defaultOpenClawConfig()`**

Set:

```ts
model: { primary: 'openai-codex/gpt-5.5' },
thinkingDefault: 'low',
tools: {
	elevated: { enabled: false },
	web: {
		fetch: {
			ssrfPolicy: {
				allowRfc2544BenchmarkRange: true,
				allowIpv6UniqueLocalRange: true,
			},
		},
	},
},
```

Remove stale `openai-codex/gpt-5.4` model params from the scaffold unless the test shows OpenClaw still requires the `models` block.

- [x] **Step 4: Re-run test**

Expected: PASS.

### Task 2: Runtime Logs In Existing Logs API/CLI

**Files:**
- Modify: `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
- Modify: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts` if needed

- [x] **Step 1: Add failing test for runtime log command**

Update the OpenClaw runtime logs test to expect the VM command reads both:

```sh
/tmp/openclaw.log
/tmp/openclaw/openclaw-*.log
```

Expected command shape:

```sh
{ echo '===== gateway boot log (/tmp/openclaw.log) ====='; cat /tmp/openclaw.log 2>/dev/null || true; echo; echo '===== openclaw runtime logs (/tmp/openclaw/openclaw-*.log) ====='; tail -n 400 /tmp/openclaw/openclaw-*.log 2>/dev/null || true; }
```

- [x] **Step 2: Run focused failing test**

Run:

```sh
pnpm test:unit -- packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

Expected: FAIL because current code only cats `/tmp/openclaw.log`.

- [x] **Step 3: Implement combined logs command**

Change `getLogs()` in `openclaw-zone-runtime.ts` to read gateway boot logs and OpenClaw runtime log tails through the existing `runControllerLogs()` dependency.

- [x] **Step 4: Re-run focused test**

Expected: PASS.

### Task 3: Doctor Success Output And Per-Agent Auth Warning

**Files:**
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
- Modify: `packages/agent-vm/src/cli/controller-operation-commands.ts`
- Modify: `packages/agent-vm/src/cli/controller-operation-commands.test.ts`

- [x] **Step 1: Add failing deployment doctor test**

Given an OpenClaw config with:

```json
{
	"agents": {
		"defaults": { "model": { "primary": "openai-codex/gpt-5.5" } },
		"list": [{ "id": "shravan" }]
	}
}
```

and no matching `authProfilesByAgent.shravan` in system config, expect a failed check named:

```txt
openclaw-agent-auth-profile-shravan-shravan
```

- [x] **Step 2: Add failing CLI doctor summary test**

Expect `controller doctor` output to include a summary shape such as:

```json
{
	"ok": true,
	"summary": "all checks passed",
	"passed": 23,
	"failed": 0,
	"checks": [...]
}
```

- [x] **Step 3: Implement auth-profile checks**

Thread the loaded system config into OpenClaw deployment checks or add the check in the existing config validation/doctor layer. The check should warn for each configured `agents.list[].id` without an entry in `zone.gateway.authProfilesByAgent`.

- [x] **Step 4: Implement doctor summary**

Keep existing JSON output but add `summary`, `passed`, and `failed` fields.

- [x] **Step 5: Run focused tests**

Run:

```sh
pnpm test:unit -- packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts packages/agent-vm/src/cli/controller-operation-commands.test.ts
```

Expected: PASS.

### Task 4: Multi-Agent Init Scaffold

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/cli/commands/init-definition.ts` if CLI option definitions live there
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [x] **Step 1: Add failing init test for `--openclaw-agents`**

Run scaffold with `--openclaw-agents sun,shravan,alevtina` and expect:

```ts
agents.list = [
	{ id: 'sun', workspace: '/zone/agents/sun', identity: { name: 'Sun' } },
	{ id: 'shravan', workspace: '/zone/agents/shravan', identity: { name: 'Shravan' } },
	{ id: 'alevtina', workspace: '/zone/agents/alevtina', identity: { name: 'Alevtina' } },
];
```

- [x] **Step 2: Run focused failing test**

Run:

```sh
pnpm test:unit -- packages/agent-vm/src/cli/init-command.test.ts
```

Expected: FAIL because `--openclaw-agents` is not parsed.

- [x] **Step 3: Implement `agents` option**

Add `agents?: readonly string[]` to scaffold options. Parse comma-separated values at the CLI boundary. Sanitize by trimming and rejecting empty IDs.

- [x] **Step 4: Update manual docs**

Document `agent-vm init --openclaw-agents sun,shravan,alevtina` as the multi-agent starting point. Do not add Discord scaffold behavior in this patch.

- [x] **Step 5: Re-run tests**

Expected: PASS.

### Task 5: Documentation Updates

**Files:**
- Modify: `docs/getting-started/openclaw-guide.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/architecture/openclaw-gateway.md` if needed

- [x] **Step 1: Document web_fetch fake-IP policy**

Explain that Gondolin synthetic DNS uses `198.18.0.1` and `fc00::1`, and scaffolded OpenClaw config enables the corresponding `web_fetch` SSRF policy by default.

- [x] **Step 2: Document logs behavior**

Explain that `agent-vm controller logs --zone <id>` includes gateway boot output plus OpenClaw runtime log tail.

- [x] **Step 3: Document multi-agent scaffold**

Show `agent-vm init --openclaw-agents sun,shravan,alevtina`.

### Task 6: Verification

**Files:**
- No code files.

- [x] **Step 1: Format**

Run:

```sh
pnpm fmt
```

- [x] **Step 2: Focused tests**

Run:

```sh
pnpm test:unit -- packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/controller-operation-commands.test.ts packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
```

- [x] **Step 3: Full quality gate**

Run:

```sh
pnpm check
```

- [x] **Step 4: Commit**

Commit with trailer:

```txt
Co-authored-by: Codex <noreply@openai.com>
```
