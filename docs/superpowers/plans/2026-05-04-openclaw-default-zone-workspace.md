# OpenClaw Default Zone Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New `agent-vm init --type openclaw` projects should place OpenClaw-authored workspace files under `/zone/agents/default`, not directly under `/zone` or OpenClaw state.

**Architecture:** Keep agent-vm's storage classes explicit: OpenClaw runtime state stays under the mounted `stateDir`, and user/agent workspace files stay under the mounted `zoneFilesDir` at `/zone`. Change only the scaffolded OpenClaw default workspace and docs; multi-agent deployments should still use explicit `agents.list[].workspace` entries for stable paths.

**Tech Stack:** TypeScript, Vitest, oxfmt, pnpm workspace packages, OpenClaw config JSON scaffolding.

---

### Task 1: Scaffold Default Workspace

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`

- [ ] **Step 1: Write the failing test**

Change the existing OpenClaw scaffold assertion in `packages/agent-vm/src/cli/init-command.test.ts`:

```ts
expect(openClawConfig.agents.defaults.workspace).toBe('/zone/agents/default');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts -t "scaffolds control-ui allowed origins for the host ingress port"
```

Expected: FAIL with an assertion showing the generated workspace is still `/zone`.

- [ ] **Step 3: Write minimal implementation**

Change `defaultOpenClawConfig` in `packages/agent-vm/src/cli/init-command.ts`:

```ts
sandbox: { backend: 'gondolin', mode: 'all', scope: 'agent' },
workspace: '/zone/agents/default',
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts -t "scaffolds control-ui allowed origins for the host ingress port"
```

Expected: PASS.

### Task 2: Document The Storage Boundary

**Files:**
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/architecture/storage-model.md`

- [ ] **Step 1: Add docs text**

In `docs/reference/configuration/system-json.md`, add this to the OpenClaw zone section:

```md
New OpenClaw scaffolds set `agents.defaults.workspace` to
`/zone/agents/default`. This keeps the default agent's authored workspace files
under `zoneFilesDir` while leaving `/zone` itself available for shared
zone-level notes and reference material. Multi-agent deployments should set
explicit `agents.list[].workspace` values such as `/zone/agents/shravan` and
`/zone/agents/sun`; otherwise OpenClaw derives non-default agent workspaces
under the fallback path.
```

In `docs/architecture/storage-model.md`, add `/zone/agents/default` to the
OpenClaw gateway path matrix:

```text
host zoneFilesDir
  ~/.agent-vm/zone-files/<zone>/
    agents/default/          # default scaffolded OpenClaw workspace
```

- [ ] **Step 2: Verify docs mention the new path**

Run:

```bash
rg -n "/zone/agents/default|agents/default" docs/reference/configuration/system-json.md docs/architecture/storage-model.md
```

Expected: both docs contain the new default workspace path.

### Task 3: Cut Package Version

**Files:**
- Modify: `packages/agent-vm/package.json`
- Modify: `packages/agent-vm-worker/package.json`
- Modify: `packages/gateway-interface/package.json`
- Modify: `packages/gondolin-adapter/package.json`
- Modify: `packages/openclaw-agent-vm-plugin/package.json`
- Modify: `packages/openclaw-gateway/package.json`
- Modify: `packages/worker-gateway/package.json`

- [ ] **Step 1: Bump all published packages**

Change every `@agent-vm/*` package version from `0.0.38` to `0.0.39`.

- [ ] **Step 2: Verify versions are consistent**

Run:

```bash
node -e "const fs=require('node:fs'); const paths=['packages/agent-vm/package.json','packages/agent-vm-worker/package.json','packages/gateway-interface/package.json','packages/gondolin-adapter/package.json','packages/openclaw-agent-vm-plugin/package.json','packages/openclaw-gateway/package.json','packages/worker-gateway/package.json']; for (const p of paths) { const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(`${j.name} ${j.version}`); if (j.version !== '0.0.39') process.exitCode=1; }"
```

Expected: every printed package is `0.0.39`.

### Task 4: Verify And Open PR

**Files:**
- No source files beyond Tasks 1-3.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 2: Run quality checks**

Run:

```bash
pnpm lint:types
pnpm typecheck
pnpm fmt:check
git diff --check
```

Expected: all pass. If `fmt:check` reveals pre-existing unrelated files, format only touched files and report any remaining unrelated failures.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/superpowers/plans/2026-05-04-openclaw-default-zone-workspace.md docs/reference/configuration/system-json.md docs/architecture/storage-model.md packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts packages/*/package.json
git commit -m "fix: default openclaw workspace to zone files"
```

Commit body must include:

```text
Co-authored-by: Codex <noreply@openai.com>
```

- [ ] **Step 4: Push and create PR**

Run:

```bash
git push -u origin fix/openclaw-default-zone-workspace
gh pr create --title "fix: default OpenClaw workspace to zone files" --body-file <generated-pr-body-file>
```

Expected: GitHub returns the PR URL.

---

Self-review:

- Spec coverage: scaffold default, storage docs, version bump, verification, and PR are covered.
- Placeholder scan: no `TBD`, no incomplete implementation steps.
- Type consistency: the only TypeScript shape change is the existing `workspace: string` test assertion and scaffold config value.
