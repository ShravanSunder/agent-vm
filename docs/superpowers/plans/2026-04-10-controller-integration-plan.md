# Controller Integration Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire agent-vm-coding into the agent-vm controller so `agent-vm controller start` boots a coding agent in a Gondolin VM that can receive tasks and produce PRs.

**Architecture:** One VM at a time per controller. Lazy VM creation on first task (not at startup). Per-PR lifecycle (VM lives until close/timeout). Controller owns all infrastructure: repo clone, stack management, config merge, VM creation. agent-vm-coding runs inside the VM with zero Gondolin awareness.

**Tech Stack:** TypeScript strict, Zod v4, execa, @earendil-works/gondolin, vitest. Debian OCI images (node:24-slim). postBuild.copy + commands for image packaging.

**Spec:** `docs/specs/2026-04-10-controller-integration-design.md`

**TS Rules:** No `any`, no `as` casts (use `satisfies`, `as const`, Zod `.parse()`), explicit return types, `readonly` on interfaces, descriptive names, files under 400 lines.

---

## Dependency Graph

```
T1 (system.json schema) 
  → T2 (stack manager)
  → T3 (repo cloner + project config)
  → T4 (VM image build config)
  → T5 (coding gateway manager)
  → T6 (controller runtime dispatch)
  → T7 (builtin skills)
  → T8 (E2E test)
```

---

### Task 1: system.json Schema — Discriminated Union for Gateway Type

**Why:** The controller needs to dispatch on zone.gateway.type. Currently the schema only supports OpenClaw-shaped gateways. We add a discriminated union so "openclaw" and "agent-vm-coding" zones coexist.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/system-config.ts`
- Modify: `packages/agent-vm/src/features/controller/system-config.test.ts`
- Modify: all test fixtures that create zone objects (add `type: "openclaw"`)

- [ ] **Step 1: Read current system-config.ts and identify zoneGatewaySchema**

- [ ] **Step 2: Write failing test — system.json with type: "agent-vm-coding" should parse**

```typescript
it('should parse agent-vm-coding zone type', () => {
  const config = loadSystemConfig('./test-system.json'); // fixture with type: "agent-vm-coding"
  expect(config.zones[0]?.gateway.type).toBe('agent-vm-coding');
});
```

- [ ] **Step 3: Update zoneGatewaySchema to discriminated union**

```typescript
const openclawGatewaySchema = z.object({
  type: z.literal('openclaw'),
  memory: z.string().regex(/^(\d+)([GgMm])$/),
  cpus: z.number().int().positive(),
  port: z.number().int().positive(),
  openclawConfig: z.string().min(1),
  stateDir: z.string().min(1),
  workspaceDir: z.string().min(1),
  authProfilesRef: z.string().optional(),
});

const codingGatewaySchema = z.object({
  type: z.literal('agent-vm-coding'),
  memory: z.string().regex(/^(\d+)([GgMm])$/).default('2G'),
  cpus: z.number().int().positive().default(2),
  port: z.number().int().positive(),
  stateDir: z.string().min(1),
  workspaceDir: z.string().min(1),
  codingGatewayConfigPath: z.string().optional(),
  imageBuildConfigPath: z.string().default('./images/coding-agent/build-config.json'),
});

const zoneGatewaySchema = z.discriminatedUnion('type', [
  openclawGatewaySchema,
  codingGatewaySchema,
]);
```

- [ ] **Step 4: Update ALL test fixtures to include `type: "openclaw"` in existing zone gateway objects**

Search for zone fixtures across all test files in `packages/agent-vm/src/features/controller/`. Each needs `type: "openclaw"` added.

- [ ] **Step 5: Update production system.json to include `type: "openclaw"`**

- [ ] **Step 6: Run all tests + typecheck**

Run: `pnpm --filter agent-vm typecheck && pnpm vitest run packages/agent-vm/`

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/features/controller/system-config.ts
git add packages/agent-vm/src/features/controller/system-config.test.ts
git add packages/agent-vm/src/features/controller/*.test.ts
git add system.json
git commit -m "feat(agent-vm): add discriminated union for gateway type (openclaw + agent-vm-coding)"
```

---

### Task 2: Stack Manager

**Why:** The controller needs to start/stop Docker Compose stacks (pg, redis) and resolve container IPs for TCP mapping into the VM. On Mac without Docker services, this is a no-op.

**Files:**
- Create: `packages/agent-vm/src/features/controller/stack-manager.ts`
- Create: `packages/agent-vm/src/features/controller/stack-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Tests:
- `startStack` runs `docker compose up -d --wait` via execa
- `resolveServiceIps` parses docker inspect output
- `stopStack` runs `docker compose down -v`
- Returns empty when no composePath configured
- Throws clear error when Docker not available

Use mock execa for unit tests.

- [ ] **Step 2: Implement stack-manager.ts**

```typescript
import { execa } from 'execa';

export interface StackManagerOptions {
  readonly composePath: string;
  readonly workDir: string;
}

export interface StackManager {
  readonly startStack: () => Promise<void>;
  readonly resolveServiceIps: (serviceNames: readonly string[]) => Promise<Record<string, string>>;
  readonly stopStack: () => Promise<void>;
}

export function createStackManager(options: StackManagerOptions): StackManager {
  // startStack: execa('docker', ['compose', '-f', options.composePath, 'up', '-d', '--wait'])
  // resolveServiceIps: docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
  // stopStack: execa('docker', ['compose', '-f', options.composePath, 'down', '-v'])
}

export function createNoOpStackManager(): StackManager {
  // Returns empty IPs, start/stop are no-ops
  // Used when no stack is configured
}
```

- [ ] **Step 3: Run tests + typecheck + commit**

---

### Task 3: Repo Cloner + Project Config Discovery

**Why:** The controller clones the target repo on the host side (fast, native disk) and reads `.agent-vm/config.json` for project-specific overrides.

**Files:**
- Create: `packages/agent-vm/src/features/controller/repo-cloner.ts`
- Create: `packages/agent-vm/src/features/controller/repo-cloner.test.ts`
- Create: `packages/agent-vm/src/features/controller/project-config.ts`
- Create: `packages/agent-vm/src/features/controller/project-config.test.ts`

- [ ] **Step 1: Write repo-cloner tests**

Tests:
- Clones a repo using GIT_ASKPASS (not token in URL)
- Clones into workspaceDir
- Returns clone dir path
- Throws on clone failure with sanitized error (no token in message)

Use a real temp git repo for integration-style test.

- [ ] **Step 2: Implement repo-cloner.ts**

```typescript
export interface CloneOptions {
  readonly repoUrl: string;
  readonly branch: string;
  readonly workspaceDir: string;
  readonly githubToken: string;
}

export async function cloneRepo(options: CloneOptions): Promise<string> {
  // Create GIT_ASKPASS script in temp file (token not in URL)
  // Shallow clone — fast, minimal disk:
  // execa('git', ['clone', '--depth', '1', '--single-branch', '--branch', options.branch, url, options.workspaceDir])
  // Clean up askpass script
  // Return workspaceDir
}

// --depth 1: only last commit (no history, saves disk + time)
// --single-branch: only target branch (not all refs)
// A 500MB repo with 10K commits becomes ~50MB
```

- [ ] **Step 3: Write project-config tests**

Tests:
- Returns empty config when .agent-vm/ doesn't exist
- Reads testCommand, lintCommand, branchPrefix from .agent-vm/config.json
- Finds .agent-vm/docker-compose.yml for stack override
- Handles invalid JSON gracefully (warn, use defaults)
- Merge: task > project > org (explicit precedence test)

- [ ] **Step 4: Implement project-config.ts**

```typescript
import { z } from 'zod';

const projectConfigSchema = z.object({
  testCommand: z.string().optional(),
  lintCommand: z.string().optional(),
  branchPrefix: z.string().optional(),
}).strict();

export interface ProjectConfig {
  readonly testCommand?: string;
  readonly lintCommand?: string;
  readonly branchPrefix?: string;
  readonly stackComposePath?: string;
}

export function readProjectConfig(workspaceDir: string): ProjectConfig {
  // Check .agent-vm/config.json
  // Check .agent-vm/docker-compose.yml
  // Return merged config
}

export function mergeConfigs(
  orgConfig: CodingGatewayConfig,
  projectConfig: ProjectConfig,
  taskOverrides: { testCommand?: string; lintCommand?: string },
): MergedTaskConfig {
  // task > project > org
}
```

- [ ] **Step 5: Run tests + typecheck + commit**

---

### Task 4: VM Image Build Config

**Why:** The coding agent VM needs Debian + Codex CLI + agent-vm-coding + skills baked in. Update the existing build-config.json with postBuild.copy and commands.

**Files:**
- Modify: `images/coding-agent/build-config.json`
- Create: `skills/builtin/generic-plan-review/SKILL.md`
- Create: `skills/builtin/generic-code-review/SKILL.md`
- Create: `skills/superpowers/writing-plans/SKILL.md` (vendored from obra/superpowers)
- Create: `skills/superpowers/brainstorming/SKILL.md` (vendored)
- Create: `skills/superpowers/test-driven-development/SKILL.md` (vendored)
- Create: `skills/superpowers/verification-before-completion/SKILL.md` (vendored)
- Create: `skills/superpowers/systematic-debugging/SKILL.md` (vendored)

- [ ] **Step 1: Update build-config.json**

```json
{
  "$comment": "Debian OCI image for coding agent. distro=alpine required for kernel/initramfs.",
  "arch": "aarch64",
  "distro": "alpine",
  "oci": {
    "image": "docker.io/library/node:24-slim",
    "pullPolicy": "if-not-present"
  },
  "rootfs": {
    "label": "coding-agent-root",
    "sizeMb": 2048
  },
  "postBuild": {
    "copy": [
      { "src": "../../packages/agent-vm-coding/dist", "dest": "/opt/agent-vm-coding" },
      { "src": "../../skills/builtin", "dest": "/root/.agents/skills" },
      { "src": "../../skills/superpowers", "dest": "/root/.agents/skills" }
    ],
    "commands": [
      "apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates",
      "npm install -g @openai/codex",
      "chmod +x /opt/agent-vm-coding/main.js || true",
      "ln -sf /opt/agent-vm-coding/main.js /usr/local/bin/agent-vm-coding",
      "apt-get clean && rm -rf /var/lib/apt/lists/*"
    ]
  }
}
```

- [ ] **Step 2: Write generic-plan-review SKILL.md**

```markdown
---
name: generic-plan-review
description: Use when reviewing an implementation plan for completeness, correctness, risks, and missing edge cases.
---

# Plan Review

Review the implementation plan provided. Assess:

1. **Completeness** — Does the plan cover all requirements from the task?
2. **Correctness** — Is the approach technically sound?
3. **Risks** — What could go wrong? What assumptions are untested?
4. **Missing edge cases** — What scenarios are not addressed?
5. **Testability** — Can the planned changes be verified?

Respond with structured JSON:
{
  "approved": boolean,
  "comments": [{ "file": "", "severity": "critical|suggestion|nitpick", "comment": "..." }],
  "summary": "Brief overall assessment"
}
```

- [ ] **Step 3: Write generic-code-review SKILL.md**

```markdown
---
name: generic-code-review
description: Use when reviewing code changes (diffs) for correctness, style, test coverage, and potential bugs.
---

# Code Review

Review the code diff provided. Assess:

1. **Correctness** — Does the code do what the plan specified?
2. **Bugs** — Any logic errors, off-by-ones, null handling issues?
3. **Style** — Does it follow the project's conventions (check CLAUDE.md if available)?
4. **Test coverage** — Are the changes adequately tested?
5. **Security** — Any injection risks, credential leaks, or unsafe operations?

Respond with structured JSON:
{
  "approved": boolean,
  "comments": [{ "file": "path", "line": N, "severity": "critical|suggestion|nitpick", "comment": "..." }],
  "summary": "Brief overall assessment"
}
```

- [ ] **Step 4: Commit**

```bash
git add images/coding-agent/build-config.json skills/
git commit -m "feat: update coding agent image config with postBuild + add builtin skills"
```

---

### Task 5: Coding Gateway Manager

**Why:** This is the core new module — `startCodingGatewayZone()`. It creates the VM lazily on first task, manages per-PR lifecycle, and handles followup/close.

**Files:**
- Create: `packages/agent-vm/src/features/controller/coding-gateway-manager.ts`
- Create: `packages/agent-vm/src/features/controller/coding-gateway-manager.test.ts`

- [ ] **Step 1: Read existing gateway-manager.ts for patterns**

Understand how `startGatewayZone()` creates a VM, sets up VFS mounts, TCP hosts, HTTP hooks, secrets, ingress. The coding gateway follows the same pattern.

- [ ] **Step 2: Write failing tests**

Tests with mock gondolin-core (no real VMs):
- `initCodingGateway()` pre-builds/caches image only (no stack, no VM), returns handle
- `createCodingVm()` creates VM with correct mounts/secrets/TCP on first task
- VM healthcheck waits for `GET /health` 200
- `forwardTask()` POSTs to coding gateway via ingress
- `forwardFollowup()` POSTs to same VM
- `closeCodingVm()` stops VM + stack + cleans workspace
- Config merge applies task > project > org precedence
- Idle reaper integration (close on timeout)

- [ ] **Step 3: Implement coding-gateway-manager.ts**

```typescript
export interface CodingGatewayHandle {
  readonly initGateway: () => Promise<void>; // pre-build image only (no stack, no VM)
  readonly submitTask: (task: CodingTask) => Promise<CodingTaskResult>;
  readonly submitFollowup: (taskId: string, prompt: string) => Promise<void>;
  readonly closeTask: (taskId: string) => Promise<void>;
  readonly getTaskStatus: (taskId: string) => Promise<TaskStatusResponse>;
  readonly getStatus: () => CodingGatewayStatus;
  readonly destroy: () => Promise<void>;
}

export interface CodingTask {
  readonly prompt: string;
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly testCommand?: string;
  readonly lintCommand?: string;
}

export async function createCodingGateway(
  options: CodingGatewayOptions,
  dependencies: CodingGatewayDependencies,
): Promise<CodingGatewayHandle> {
  // State: currentVm, currentTaskId, stackManager, ingressInfo
  
  // initGateway: build/cache image only (no stack, no VM). Pass fullReset=true in dev.
  // submitTask: clone repo → read .agent-vm/ → start stack → merge config → create VM → healthcheck → POST /tasks
  // submitFollowup: verify taskId matches → POST /tasks/:id/followup via ingress
  // closeTask: POST /tasks/:id/close → close VM → stop stack → cleanup
  // destroy: close everything
}
```

- [ ] **Step 4: Run tests + typecheck + commit**

---

### Task 6: Controller Runtime Dispatch

**Why:** The controller runtime needs to dispatch on zone.gateway.type — start OpenClaw for "openclaw" zones, start the coding gateway for "agent-vm-coding" zones.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/features/controller/controller-runtime.test.ts`
- Modify: `packages/agent-vm/src/features/controller/controller-service.ts`
- Modify: `packages/agent-vm/src/features/controller/controller-service.test.ts`
- Modify: `packages/agent-vm/src/bin/agent-vm.ts` (CLI start command — handle lazy gateway)

- [ ] **Step 1: Update controller-runtime.ts**

Add dispatch logic:
```typescript
if (zone.gateway.type === 'openclaw') {
  gateway = await startGatewayZone({...}); // existing
} else if (zone.gateway.type === 'agent-vm-coding') {
  codingGateway = await createCodingGateway({...}); // new
  await codingGateway.initGateway();
}
```

Update `ControllerRuntime` interface:
```typescript
export interface ControllerRuntime {
  readonly controllerPort: number;
  readonly gateway?: { ... };            // OpenClaw (optional now)
  readonly codingGateway?: CodingGatewayHandle;  // coding agent (optional)
  readonly close: () => Promise<void>;
}
```

- [ ] **Step 2: Update controller-service.ts**

Add routes for coding gateway (controller-side API → proxies to VM-side API):
```
POST /coding/tasks → codingGateway.submitTask(body)        # proxies to VM POST /tasks
GET /coding/tasks/:id → codingGateway.getTaskStatus(id)    # proxies to VM GET /tasks/:id
POST /coding/tasks/:id/followup → codingGateway.submitFollowup(id, body.prompt)
POST /coding/tasks/:id/close → codingGateway.closeTask(id)
GET /coding/status → codingGateway.getStatus()             # controller-level status (VM exists? active task?)
```

Note: two API layers exist:
- **Controller API** (host): `/coding/tasks/...` — what external callers use
- **VM API** (inside Gondolin): `/tasks/...` — what the controller forwards to via ingress

- [ ] **Step 3: Update tests**

- [ ] **Step 4: Run all tests + typecheck + commit**

---

### Task 7: Wire Idle Reaper for Coding Gateway

**Why:** The coding gateway VM should be killed after idleTimeoutMs if no activity. Wire the existing idle-reaper to the new coding gateway.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/controller-runtime.ts`

- [ ] **Step 1: Wire idle reaper**

After coding gateway is created, set up idle monitoring:
```typescript
// On task completion (awaiting-followup), start idle timer
// On followup, reset timer
// On timeout, call codingGateway.closeTask()
```

- [ ] **Step 2: Test + commit**

---

### Task 8: E2E Test

**Why:** Prove the full flow works: controller start → POST /tasks → agent plans/implements/pushes → PR URL returned → close.

**Files:**
- Create: `packages/agent-vm/src/features/controller/coding-gateway-e2e.test.ts`

- [ ] **Step 1: Write E2E test**

This test uses REAL Gondolin VMs (requires QEMU, e2fsprogs). Skip without them.

```typescript
const hasQemu = existsSync('/opt/homebrew/bin/qemu-system-aarch64');
const hasApiKey = Boolean(process.env['CODEX_API_KEY']);

describe.skipIf(!hasQemu || !hasApiKey)('coding gateway E2E', () => {
  it('should complete a task end-to-end', async () => {
    // 1. Create system.json with type: "agent-vm-coding"
    // 2. Start controller runtime
    // 3. POST /coding/tasks with prompt + repo
    // 4. Poll status until awaiting-followup (max 5 min)
    // 5. Verify: task has prUrl
    // 6. POST /coding/tasks/:id/close
    // 7. Stop controller
  }, 300_000);
});
```

- [ ] **Step 2: Run locally with API key**

```bash
source .env && CODEX_API_KEY="$OPENAI_API_KEY" pnpm vitest run packages/agent-vm/src/features/controller/coding-gateway-e2e.test.ts
```

- [ ] **Step 3: Commit**

---

## Self-Review

- [x] **Spec coverage:** T1=schema (§2), T2=stack (§3), T3=clone+config (§3), T4=image (§4), T5=gateway (§2.3), T6=dispatch (§2.2), T7=reaper (§11.P2-11), T8=E2E (§7)
- [x] **No placeholders:** All tasks have concrete types, interfaces, and test descriptions
- [x] **Type consistency:** `CodingGatewayHandle`, `CodingTask`, `StackManager`, `ProjectConfig` used consistently
- [x] **Missing:** Builtin skills content is in T4 (not a separate task — they're just SKILL.md files)
- [x] **Debian OCI:** build-config.json uses node:24-slim throughout
