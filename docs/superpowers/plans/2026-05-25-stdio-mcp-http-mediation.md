# Stdio MCP HTTP Mediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the proven stdio MCP HTTP-mediation pattern first-class in agent-vm docs, generated manuals, and validation guidance.

**Architecture:** MCP Portal provider configs rewrite authored provider secrets into generated `AGENT_VM_MCP_*` environment references. When `secretPolicies.<name>.injection` is `http-mediation`, the gateway VM receives a Gondolin placeholder env value, while the raw secret stays in host-side mediated secret state and is substituted only for configured outbound hosts. Stdio MCP servers can use this safely when they read an env var and send that value in outbound HTTP headers or another Gondolin-supported substitution location.

**Tech Stack:** TypeScript, pnpm, Vitest, agent-vm gateway config, Gondolin `createHttpHooks`, OpenClaw MCP Portal.

---

## Current Evidence

Beta already tested the target deployment shape.

- Deployment repo: `../shravan-claw-beta` from the sibling worktree root
- Commit: `ed74d81 fix: mediate beta stdio mcp secrets`
- Package: `@agent-vm/agent-vm` `0.0.81`
- Config result:
  - `perplexity` stdio MCP uses `http-mediation` with host `api.perplexity.ai`
  - `firecrawl` stdio MCP uses `http-mediation` with host `api.firecrawl.dev`
  - generated MCP env names were removed from `gateway.rawEnvSecrets`
- Live Discord-origin beta result:
  - `firecrawl.firecrawl_map { url: "https://example.com" }` succeeded
  - `perplexity.perplexity_search { query: "what is Model Context Protocol MCP" }` succeeded
  - both calls succeeded in the same `mcp_portal_call` batch

This branch should not redo that beta experiment. It should encode the methodology in agent-vm so future operators do not rediscover it.

## Scope Boundary

In scope:

- Clarify repo docs for stdio MCP `http-mediation`.
- Clarify generated manuals.
- Pin manual wording with tests.
- Run targeted existing tests that already cover the code-level contract.
- Optionally mirror the proven beta config into `shravan-claw` as a separate deployment commit.

Out of scope:

- Discord WebSocket routing. Discord bot tokens stay raw gateway env because OpenClaw sends them in Gateway Identify/Resume frames after WebSocket upgrade; Gondolin cannot substitute post-upgrade WebSocket frame payloads.
- New Gondolin behavior.
- New live upstream API smoke inside `doctor`.
- Publishing a new package unless code/manual changes require it and the user explicitly asks for release.

## Existing Code-Level Coverage

The product code already has the core contract covered:

- `packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts`
  - proves stdio provider secrets with `http-mediation` become generated env references and `runtimeMediatedSecrets`, not raw runtime env.
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
  - proves gateway VM options split raw env secrets from mediated secrets.
- `packages/gondolin-adapter/src/vm-adapter.test.ts`
  - proves `hookBundle.env` is passed into `VM.create` and caller env overlays hook env.
- `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`
  - proves stdio MCP env values are passed through to the transport.

Do not add duplicate tests unless inspection finds one of these assertions missing or too weak.

## Validate vs Doctor Decision

Keep this split:

- `agent-vm validate --config config/system.jsonc`
  - static schema and cross-field checks
  - MCP materialization checks
  - raw-env escape checks
  - mediated host and stdio `requiredEgressHosts` checks

- `agent-vm validate --config config/system.jsonc --mcp-live`
  - secret resolution
  - provider startup
  - live `tools/list`
  - namespace/profile/tool-name mismatch feedback

- `agent-vm doctor --config config/system.jsonc`
  - host/runtime readiness
  - ports, QEMU, OpenClaw CLI, OpenClaw plugin wiring, plugin approval route

Do not move real upstream MCP API calls into `doctor`. If live MCP provider proof is needed, use `validate --mcp-live` and deployment-level Discord/API smoke.

---

## Task 1: Pin Generated Manual Guidance

**Files:**
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`

- [x] **Step 1: Write failing manual assertions**

Add assertions that `docs/manual/mcp-portal.md` contains:

```ts
expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
	'Prefer http-mediation for MCP provider API keys, including stdio providers',
);
expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
	'Use raw env injection only as an explicit exception',
);
```

- [x] **Step 2: Verify red**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected before template edit: fail because the manual does not contain the new stdio mediation guidance.

- [x] **Step 3: Update manual template**

Add concise MCP Portal manual guidance:

```text
Prefer http-mediation for MCP provider API keys, including stdio providers,
when the provider sends the env value in outbound HTTP headers or other
Gondolin-supported request locations. The MCP server sees a placeholder env
value; Gondolin swaps it for the real secret only for configured hosts. Use raw
env injection only as an explicit exception for providers that cannot operate
with placeholders.
```

- [x] **Step 4: Verify green**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: pass.

---

## Task 2: Update Canonical Docs

**Files:**
- Modify: `docs/subsystems/mcp-portal.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/subsystems/gondolin-vm-layer.md`
- Modify: `docs/reference/configuration/system-json.md`

- [x] **Step 1: Clarify MCP Portal stdio environment docs**

Update `docs/subsystems/mcp-portal.md` so the stdio runtime section says:

- use `transport.env` for provider credentials
- prefer `secretPolicies.<name>.injection: "http-mediation"` for env-read, HTTP-header-auth stdio providers
- the gateway process and stdio child receive placeholders, not raw secrets
- raw `env` injection is an explicit exception

Remove duplicate stale stdio runtime sections while editing.

- [x] **Step 2: Clarify secrets docs**

Update `docs/subsystems/secrets-and-credentials.md` so `http-mediation` says the raw value never enters the VM, but mediated env consumers may receive a generated placeholder.

- [x] **Step 3: Clarify Gondolin adapter docs**

Update `docs/subsystems/gondolin-vm-layer.md` so it explicitly says mediated stdio MCP depends on passing both:

- `httpHooks`
- `hookBundle.env`

into `VM.create()`.

- [x] **Step 4: Clarify configuration reference**

Update `docs/reference/configuration/system-json.md` so MCP provider entries explain the stdio `http-mediation` pattern and generated `AGENT_VM_MCP_*` placeholder env names.

---

## Task 3: Verify Existing Contract Tests

**Files:**
- No edits unless tests reveal missing coverage.

- [x] **Step 1: Run targeted code-contract tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts \
  packages/gondolin-adapter/src/vm-adapter.test.ts \
  packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts \
  packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: pass.

- [ ] **Step 2: Add a missing test only if one contract is not covered**

If inspection or the targeted run reveals a gap, use TDD:

1. add one failing focused test
2. verify red
3. implement the minimum code/doc template change
4. verify green

Do not add duplicate tests for already-covered behavior.

---

## Task 4: Deployment Follow-Up

**Files:**
- Optional modify: `../shravan-claw/config/gateways/sunfam/mcp.config.jsonc`
- Optional modify: `../shravan-claw/config/system.jsonc`

- [ ] **Step 1: Compare `shravan-claw` with beta**

Run:

```bash
rg -n 'perplexity|firecrawl|rawEnvSecrets|AGENT_VM_MCP_PERPLEXITY|AGENT_VM_MCP_FIRECRAWL' \
  ../shravan-claw/config
```

- [ ] **Step 2: Mirror beta only if sunfam still uses raw env**

Apply the proven beta shape:

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

Remove generated MCP env names from `gateway.rawEnvSecrets` if present.

- [ ] **Step 3: Validate deployment config**

Run from `../shravan-claw`:

```bash
pnpm validate
pnpm doctor
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
```

Expected: exit 0 for each command, or document exact blocker.

---

## Task 5: Final Verification And PR

**Files:**
- All changed files.

- [ ] **Step 1: Run focused tests**

Run the targeted command from Task 3.

- [ ] **Step 2: Run full quality gate if the branch has code/test changes**

Run:

```bash
pnpm check
```

Expected: exit 0.

- [ ] **Step 3: Inspect git state**

Run:

```bash
git status --short --branch
git diff --stat
git diff --check
```

Expected: only intended docs, manual template, manual test, and plan changes.

- [ ] **Step 4: Commit and open PR**

Commit message:

```bash
git add \
  docs/reference/configuration/system-json.md \
  docs/subsystems/gondolin-vm-layer.md \
  docs/subsystems/mcp-portal.md \
  docs/subsystems/secrets-and-credentials.md \
  docs/superpowers/plans/2026-05-25-stdio-mcp-http-mediation.md \
  packages/agent-vm/src/cli/manual-templates.test.ts \
  packages/agent-vm/src/cli/manual-templates.ts
git commit -m "docs: clarify stdio mcp secret mediation"
```

Open a PR from `feat/stdio-mcp-http-mediation`.

PR summary should include:

```text
What changed:
- Documented the stdio MCP http-mediation methodology.
- Updated generated MCP Portal manual guidance.
- Cleaned stale plan instructions now that beta has live proof.

Validation:
- pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
- targeted MCP Portal/Gondolin contract tests
- pnpm check

Deployment evidence:
- beta commit ed74d81 uses mediated Perplexity and Firecrawl stdio secrets
- beta Discord-origin MCP calls succeeded for firecrawl_map and perplexity_search
```

---

## Self-Review

- Spec coverage: The plan covers docs, manuals, validation boundary, existing test coverage, and optional deployment mirroring.
- Placeholder scan: No TBD/TODO/fill-later placeholders.
- Type consistency: The same generated env-name pattern is used throughout: `AGENT_VM_MCP_*`.
