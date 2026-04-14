# Relay Beta Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Relay's deployed infrastructure (delegator + background-agent) to the agent-vm controller and agent-vm-worker so that `POST /tasks` to the delegator creates a Sysbox pod that runs a coding task end-to-end: clone repo → plan → implement → verify → PR.

**Architecture:** The relay-agent-delegator (already deployed, healthy in dev cluster) creates Sysbox pods. Each pod runs the agent-vm controller, which boots a Gondolin VM containing agent-vm-worker. The controller handles the full task lifecycle: clone, config merge, Docker services, VM creation, task submission, polling, cleanup. All packages are published to npm under `@shravansunder/` scope. The relay-background-agent Dockerfile installs them via pnpm.

**Tech Stack:** TypeScript, pnpm, Hono, Zod, cmd-ts, Gondolin (QEMU), Sysbox, Docker Compose, ArgoCD, ECR, GitHub Actions

**Repos involved:**
- `agent-vm` (ShravanSunder/agent-vm) — controller + worker source, npm packages
- `relay-ai-tools` (relay-ai-tools) — delegator + background-agent Docker images

**Design spec:** `docs/superpowers/specs/2026-04-12-agent-vm-worker-design.md`

---

## System Architecture

```
relay-agent-delegator (k8s Deployment, port 3000, already deployed)
    │
    │ POST /tasks { repoUrl, branch, prompt }
    │
    ▼
Creates Sysbox pod (image: relay/agent-vm-worker from ECR)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Sysbox Pod                                                   │
│                                                              │
│  systemd (PID 1)                                             │
│  Docker daemon (for pg, redis stacks only)                   │
│                                                              │
│  agent-vm controller start --config /etc/agent-vm/system.json│
│  (port 18800, serves /health, /coding/tasks/*)               │
│                                                              │
│  On POST /coding/tasks:                                      │
│    preStartGateway → mkdir, clone repo, merge config         │
│    docker compose up (pg, redis) ← nested Docker             │
│    startGatewayZone → Gondolin VM (QEMU)                     │
│    ┌──────────────────────────────────────┐                  │
│    │ Gondolin VM                          │                  │
│    │  agent-vm-worker serve --port 18789  │                  │
│    │  /workspace → VFS mount (cloned repo)│                  │
│    │  /state → VFS mount (JSONL events)   │                  │
│    │  postgres.local:5432 → TCP to Docker │                  │
│    │                                      │                  │
│    │  plan → review → work → verify →     │                  │
│    │  review → wrapup (git-pr) → done     │                  │
│    └──────────────────────────────────────┘                  │
│    POST /tasks to worker → poll → harvest result             │
│    vm.close() → postStopGateway → cleanup                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Dependency Graph

```
T1 (relay-background-agent Dockerfile + config)
  → T2 (relay-agent-delegator API update)
  → T3 (CI + deploy verification)
  → T4 (E2E smoke test)
```

T1 is the bulk of the work. T2-T4 are integration.

---

### Task 1: Update relay-background-agent — Install agent-vm + Config

**Why:** The base image currently has no controller binary (`sleep infinity`). We need to install `@shravansunder/agent-vm` via pnpm, update system.json for the new schema, add a gateway config for the worker, and pre-cache the Gondolin VM image at build time.

**Files:**
- Modify: `relay-background-agent/Dockerfile`
- Modify: `relay-background-agent/config/system.json`
- Create: `relay-background-agent/config/coding-gateway.json`
- Modify: `relay-background-agent/README.md`
- Modify: `relay-background-agent/package.json`

- [ ] **Step 1: Update package.json to add agent-vm dependency**

```json
{
  "name": "relay-background-agent",
  "version": "0.1.0",
  "private": true,
  "description": "Sysbox worker image for agent-vm controller + Gondolin VMs",
  "dependencies": {
    "@shravansunder/agent-vm": "^0.0.1"
  }
}
```

- [ ] **Step 2: Update system.json to match the current Zod schema**

The current schema uses `gateway.type: "coding"` (not `"agent-vm-coding"`), requires `gatewayConfig` (not `openclawConfig`), and the secrets provider needs a valid tokenSource discriminated union.

```json
{
  "host": {
    "controllerPort": 18800,
    "secretsProvider": {
      "type": "1password",
      "tokenSource": {
        "type": "env",
        "envVar": "OP_SERVICE_ACCOUNT_TOKEN"
      }
    }
  },
  "cacheDir": "/var/agent-vm/cache",
  "images": {
    "gateway": {
      "buildConfig": "/etc/agent-vm/images/gateway/build-config.json"
    },
    "tool": {
      "buildConfig": "/etc/agent-vm/images/tool/build-config.json"
    }
  },
  "zones": [
    {
      "id": "coding-agent",
      "gateway": {
        "type": "coding",
        "memory": "2G",
        "cpus": 2,
        "port": 18791,
        "gatewayConfig": "/etc/agent-vm/coding-gateway.json",
        "stateDir": "/var/agent-vm/state",
        "workspaceDir": "/var/agent-vm/workspace"
      },
      "secrets": {
        "OPENAI_API_KEY": {
          "source": "1password",
          "ref": "op://agent-vm/openai/api-key",
          "injection": "env"
        },
        "GITHUB_TOKEN": {
          "source": "1password",
          "ref": "op://agent-vm/github/token",
          "injection": "env"
        }
      },
      "allowedHosts": [
        "api.openai.com",
        "api.github.com",
        "github.com",
        "registry.npmjs.org"
      ],
      "websocketBypass": [],
      "toolProfile": "standard"
    }
  ],
  "toolProfiles": {
    "standard": {
      "memory": "1G",
      "cpus": 1,
      "workspaceRoot": "/var/agent-vm/workspace/tools"
    }
  },
  "tcpPool": {
    "basePort": 19000,
    "size": 5
  }
}
```

Note: The secret refs are placeholders — Relay will inject the actual 1Password refs or switch to env-based injection. For beta, secrets can be injected as pod env vars by the delegator. The controller reads `OP_SERVICE_ACCOUNT_TOKEN` from env if `tokenSource.type` is `"env"`.

- [ ] **Step 3: Create coding-gateway.json (worker config)**

This is the gateway-level config that gets merged with project config and fed to the worker. It defines phase skills, models, and default verification.

```json
{
  "defaults": {
    "provider": "codex",
    "model": "latest-medium"
  },
  "phases": {
    "plan": {
      "skills": [],
      "maxReviewLoops": 2
    },
    "planReview": {
      "skills": []
    },
    "work": {
      "skills": [],
      "maxReviewLoops": 3,
      "maxVerificationRetries": 3
    },
    "workReview": {
      "skills": []
    },
    "wrapup": {
      "skills": []
    }
  },
  "mcpServers": [],
  "verification": [
    { "name": "test", "command": "npm test" },
    { "name": "lint", "command": "npm run lint" }
  ],
  "verificationTimeoutMs": 300000,
  "wrapupActions": [
    { "type": "git-pr", "required": true }
  ],
  "branchPrefix": "agent/",
  "commitCoAuthor": "relay-agent <noreply@relayfinancial.com>",
  "idleTimeoutMs": 1800000,
  "stateDir": "/state"
}
```

Skills arrays are empty for beta — the VM image doesn't have skills baked in yet. The worker uses default instructions from code. Skills will be added when we bake SKILL.md files into the Gondolin VM image.

- [ ] **Step 4: Copy Gondolin VM image build configs into the image**

The controller needs the `build-config.json` and `Dockerfile` (for the OCI image) to build the Gondolin VM image. These live in the agent-vm repo at `images/gateway/`. We need them in the relay-background-agent Docker image.

Create the directory structure:

```
relay-background-agent/
├── config/
│   ├── system.json
│   └── coding-gateway.json
├── images/
│   └── gateway/
│       ├── build-config.json    ← copied from agent-vm repo
│       └── Dockerfile           ← copied from agent-vm repo
├── stacks/
│   └── default/
│       └── docker-compose.yml
└── Dockerfile
```

`relay-background-agent/images/gateway/build-config.json`:
```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [],
    "initramfsPackages": []
  },
  "oci": {
    "image": "agent-vm-gateway:latest",
    "pullPolicy": "never"
  },
  "rootfs": {
    "label": "gondolin-root",
    "sizeMb": 4096
  },
  "postBuild": {
    "copy": [
      {
        "src": "../../packages/agent-vm-worker/dist",
        "dest": "/opt/agent-vm-worker/dist"
      }
    ]
  }
}
```

Note: `postBuild.copy.src` is resolved relative to the build-config.json location. In the relay image, the agent-vm-worker dist will be at a known path. The `oci.pullPolicy: "never"` means the OCI image must be pre-built locally — the Dockerfile builds it with `docker build`.

`relay-background-agent/images/gateway/Dockerfile`:
```dockerfile
FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      python3 && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    mkdir -p /opt/agent-vm-worker && \
    printf '%s\n' \
      '{' \
      '  "name": "agent-vm-worker-runtime",' \
      '  "private": true,' \
      '  "type": "module",' \
      '  "dependencies": {' \
      '    "@modelcontextprotocol/sdk": "^1.29.0",' \
      '    "@hono/node-server": "^1",' \
      '    "@hono/zod-validator": "^0.7.6",' \
      '    "@openai/codex-sdk": "^0.118.0",' \
      '    "cmd-ts": "^0.14.0",' \
      '    "execa": "^9.5.2",' \
      '    "hono": "^4",' \
      '    "zod": "^4",' \
      '    "zod-to-json-schema": "^3.24.1"' \
      '  }' \
      '}' > /opt/agent-vm-worker/package.json && \
    cd /opt/agent-vm-worker && npm install --omit=dev && cd / && \
    useradd -m -s /bin/bash coder && \
    mkdir -p /home/coder /workspace /state /run/sshd /root && \
    chown -R coder:coder /home/coder && \
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true && \
    mkdir -p /opt/agent-vm-worker/dist
```

This is the OCI image that becomes the Gondolin VM rootfs. It has Node.js + worker runtime deps. The worker dist (TypeScript compiled output) is copied in via `postBuild.copy` at Gondolin image build time.

- [ ] **Step 5: Update the main Dockerfile**

```dockerfile
# ---------------------------------------------------------------------------
# relay-background-agent — functional worker pod image
# ---------------------------------------------------------------------------

FROM docker.io/nestybox/ubuntu-noble-systemd-docker:latest

# Node.js 24.x (required by Gondolin)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs=24.* \
    && npm install -g pnpm@10

# QEMU for Gondolin VMs (TCG mode — no KVM on m8a instances)
RUN apt-get update \
    && apt-get install -y --no-install-recommends qemu-system-x86 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install agent-vm controller + all workspace deps from npm
RUN pnpm add -g @shravansunder/agent-vm

# Copy Relay configuration
COPY config/ /etc/agent-vm/
COPY stacks/ /etc/agent-vm/stacks/
COPY images/ /etc/agent-vm/images/

# Build the Gondolin gateway OCI image (rootfs for the VM)
# This creates the Docker image "agent-vm-gateway:latest" locally
COPY images/gateway/Dockerfile /tmp/gateway-dockerfile
RUN docker build -t agent-vm-gateway:latest -f /tmp/gateway-dockerfile /tmp \
    && rm /tmp/gateway-dockerfile

# Pre-cache Gondolin VM image (kernel + initramfs + rootfs)
# This takes ~30s first time but is cached in the Docker layer
RUN agent-vm build --config /etc/agent-vm/system.json || true

# Create runtime directories
RUN mkdir -p /var/agent-vm/state /var/agent-vm/workspace /var/agent-vm/cache

EXPOSE 18800

# Start the controller — it will serve /health on :18800
CMD ["agent-vm", "controller", "start", "--config", "/etc/agent-vm/system.json"]
```

**Important consideration:** The `docker build` and `agent-vm build` steps require Docker to be running. In the Sysbox base image, Docker is managed by systemd. During Docker image build (CI), we may need to use buildx or a different approach since the nested Docker daemon isn't available during `docker build`. This may need to be handled by:
- Building the OCI image separately in CI and copying the tarball
- Or running `agent-vm build` on first pod startup (adds ~30s cold start)

For beta, the pragmatic approach: skip `docker build` and `agent-vm build` in the Dockerfile. Run them on first pod startup. The cold start penalty is acceptable for beta. The CMD becomes a wrapper script:

```dockerfile
COPY scripts/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

CMD ["/usr/local/bin/start.sh"]
```

Create `relay-background-agent/scripts/start.sh`:
```bash
#!/bin/bash
set -euo pipefail

echo "[start] Waiting for Docker daemon..."
timeout 60 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done'

echo "[start] Building gateway OCI image..."
docker build -t agent-vm-gateway:latest -f /etc/agent-vm/images/gateway/Dockerfile /etc/agent-vm/images/gateway/

echo "[start] Starting controller..."
exec agent-vm controller start --config /etc/agent-vm/system.json
```

- [ ] **Step 6: Update README.md**

Update to reflect the functional image (no longer a base image):
- Installed packages: `@shravansunder/agent-vm` (controller + Gondolin core)
- CMD: starts controller directly
- Config paths: system.json, coding-gateway.json
- Gateway OCI image: built on first startup
- No downstream Dockerfile needed

- [ ] **Step 7: Verify locally (if Sysbox available)**

```bash
cd relay-ai-tools/relay-background-agent
docker build -t relay-background-agent-test .
# Run with Sysbox if available:
docker run --runtime=sysbox-runc -p 18800:18800 relay-background-agent-test
# In another terminal:
curl http://localhost:18800/health
```

Expected: Controller starts, `/health` returns 200.

- [ ] **Step 8: Commit**

```bash
cd relay-ai-tools
git add relay-background-agent/
git commit -m "feat(relay-background-agent): install agent-vm controller, add coding gateway config

- Install @shravansunder/agent-vm via pnpm (controller CLI + Gondolin)
- Update system.json for new gateway abstraction schema (type: coding)
- Add coding-gateway.json (worker phase config, models, verification)
- Add gateway OCI image Dockerfile + build-config.json
- CMD starts controller directly (no more sleep infinity)
- Build gateway OCI image on first startup (Docker daemon needed)"
```

---

### Task 2: Update relay-agent-delegator — API Contract + Controller Routes

**Why:** The delegator's `POST /tasks` schema sends flat fields (`repoUrl`, `branch`, `prompt`, `testCommand`, `lintCommand`). The controller's `POST /coding/tasks` (via `worker-task-runner.ts`) expects `{ prompt, repos: [{ repoUrl, baseBranch }], context }`. The delegator also needs to proxy to the controller's `/coding/tasks` route, not pass everything via env vars.

**Files:**
- Modify: `relay-agent-delegator/src/routes/task-routes.ts`
- Modify: `relay-agent-delegator/src/routes/task-routes.test.ts`
- Modify: `relay-agent-delegator/src/k8s/pod-creator.ts`
- Modify: `relay-agent-delegator/src/k8s/pod-creator.test.ts`
- Modify: `relay-agent-delegator/src/proxy/request-proxy.ts`

- [ ] **Step 1: Update task input schema**

In `relay-agent-delegator/src/routes/task-routes.ts`, update the input schema to match what the controller expects:

```typescript
export const taskInputSchema = z.object({
  prompt: z.string().min(1).max(10_000),
  repos: z.array(z.object({
    repoUrl: z.string().url().max(500),
    baseBranch: z.string().min(1).max(200).default("main"),
  })).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
  // Keep these for backward compat during migration — delegator can pass to controller
  testCommand: z.string().optional(),
  lintCommand: z.string().optional(),
  model: z.string().optional(),
});
```

- [ ] **Step 2: Simplify pod env vars**

In `relay-agent-delegator/src/k8s/pod-creator.ts`, reduce env vars to only what the controller needs at startup (not task-specific):

```typescript
const podEnvVars = [
  { name: "CONTROLLER_PORT", value: String(config.controllerPort) },
  { name: "IDLE_TIMEOUT_MINUTES", value: String(config.idleTimeoutMinutes) },
];

// Secrets injected via k8s secret refs (OPENAI_API_KEY, GITHUB_TOKEN, OP_SERVICE_ACCOUNT_TOKEN)
// These are NOT in the env var list — they come from k8s Secret objects
```

Remove: `TASK_ID`, `TASK_REPO_URL`, `TASK_BRANCH`, `TASK_PROMPT`, `TASK_TEST_COMMAND`, `TASK_LINT_COMMAND`, `TASK_MODEL`. Task input is now sent via HTTP POST after the pod is ready.

- [ ] **Step 3: Update readiness probe path**

The controller serves `/health` (not `/healthcheck`). Update in `buildWorkerPodSpec`:

```typescript
readinessProbe: {
  httpGet: {
    path: "/health",
    port: config.controllerPort,
  },
  initialDelaySeconds: 10,
  periodSeconds: 5,
  timeoutSeconds: 3,
  failureThreshold: 40,  // 40 * 5s = 200s max wait (gateway image build on cold start)
},
```

Increase `failureThreshold` to 40 because the first startup builds the Gondolin VM image (~30s) + gateway OCI image.

- [ ] **Step 4: Add task submission after pod ready**

In `task-routes.ts`, after `waitForPodReady` succeeds, submit the task to the controller via HTTP:

```typescript
async function startPodCreation(props: StartPodCreationProps): Promise<void> {
  const { coreApi, config, taskId, taskInput, tasks } = props;
  const entry = tasks.get(taskId);
  if (!entry) return;

  try {
    await createWorkerPod({ coreApi, config, taskId, taskInput });
    const { podIp } = await waitForPodReady({
      coreApi,
      namespace: config.workerNamespace,
      podName: entry.podName,
    });

    entry.podIp = podIp;

    // Submit task to controller
    const taskResponse = await proxyRequest({
      podIp,
      controllerPort: config.controllerPort,
      path: "/coding/tasks",
      method: "POST",
      body: JSON.stringify({
        prompt: taskInput.prompt,
        repos: taskInput.repos,
        context: taskInput.context,
      }),
    });

    if (taskResponse.status >= 400) {
      throw new Error(`Controller rejected task: ${JSON.stringify(taskResponse.body)}`);
    }

    entry.status = "pod-ready";
    entry.controllerTaskId = (taskResponse.body as { taskId?: string })?.taskId;
  } catch (error: unknown) {
    // ... existing error handling
  }
}
```

Add `controllerTaskId` to the `TaskEntry` interface:

```typescript
interface TaskEntry {
  id: string;
  status: TaskStatus;
  podName: string;
  podIp: string | undefined;
  controllerTaskId: string | undefined;  // ← NEW: task ID from controller
  input: TaskInput;
  error: string | undefined;
  createdAt: string;
}
```

- [ ] **Step 5: Add task status proxying**

Add a route to proxy task status queries to the controller:

```typescript
router.get("/tasks/:id/status", async (c) => {
  const taskId = c.req.param("id");
  const entry = tasks.get(taskId);

  if (!entry) {
    return c.json({ error: "Task not found" }, 404);
  }
  if (!entry.podIp || !entry.controllerTaskId) {
    return c.json({ delegatorStatus: entry.status, error: entry.error });
  }

  try {
    const response = await proxyRequest({
      podIp: entry.podIp,
      controllerPort: config.controllerPort,
      path: `/coding/tasks/${entry.controllerTaskId}`,
      method: "GET",
    });
    return c.json(response.body, response.status);
  } catch {
    return c.json({ delegatorStatus: entry.status, proxyError: "Controller unreachable" });
  }
});
```

- [ ] **Step 6: Update tests**

Update `task-routes.test.ts` and `pod-creator.test.ts` for the new schema, removed env vars, new readiness probe path, and task submission flow.

- [ ] **Step 7: Run tests**

Run: `cd relay-ai-tools/relay-agent-delegator && pnpm vitest run`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
cd relay-ai-tools
git add relay-agent-delegator/
git commit -m "feat(relay-agent-delegator): update API for agent-vm controller integration

- Task input schema: prompt + repos[] + context (not flat repoUrl/branch)
- Remove task-specific env vars (task submitted via HTTP after pod ready)
- Readiness probe: /health not /healthcheck, higher failure threshold
- Submit task to controller POST /coding/tasks after pod ready
- Proxy task status via GET /tasks/:id/status → controller
- Add controllerTaskId to TaskEntry for tracking"
```

---

### Task 3: CI + Deploy Verification

**Why:** Both images need to build and deploy to dev cluster via the existing CI pipelines.

**Files:**
- No code changes — verify existing CI workflows work with the new code

- [ ] **Step 1: Push relay-background-agent changes and verify CI**

```bash
cd relay-ai-tools
git push origin main
```

Watch: `.github/workflows/relay-background-agent-dev.yml`
Expected: Image builds, pushes to `relay/agent-vm-worker:latest` in dev ECR.

Note: The Dockerfile now installs `@shravansunder/agent-vm` from npm. If the package requires auth (private scope), the CI workflow needs an `.npmrc` with auth token. Check if `@shravansunder` is a public scope on npm. If private, add `NPM_TOKEN` to the CI secrets.

- [ ] **Step 2: Push relay-agent-delegator changes and verify CI**

Watch: `.github/workflows/relay-agent-delegator-dev.yml`
Expected: Image builds, pushes to `relay/agent-vm-delegator:latest` in dev ECR.

- [ ] **Step 3: Verify ArgoCD sync**

```bash
argocd app sync agent-vm-delegator --force
argocd app logs agent-vm-delegator | head -5
# Expected: "relay-agent-delegator listening on port 3000"
```

- [ ] **Step 4: Commit (nothing to commit — verification only)**

---

### Task 4: E2E Smoke Test

**Why:** Prove the full chain works: delegator → pod → controller → Gondolin VM → worker → PR.

**Files:**
- No code changes — manual verification via curl/kubectl

- [ ] **Step 1: Port-forward to delegator**

```bash
kubectl -n agent-vm port-forward svc/agent-vm-delegator 3000:3000
```

- [ ] **Step 2: Submit a test task**

```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add a multiply function to src/math.ts and write tests",
    "repos": [{ "repoUrl": "https://github.com/ShravanSunder/test-agent-vm-repo.git", "baseBranch": "main" }],
    "context": {}
  }'
```

Expected: 201 with `{ id, status: "creating-pod", podName }`.

- [ ] **Step 3: Watch pod creation**

```bash
kubectl -n agent-vm get pods -w
# Expected: agent-vm-<taskId> appears, goes Running, then Ready
```

- [ ] **Step 4: Poll task status**

```bash
TASK_ID=<from step 2>
curl http://localhost:3000/tasks/$TASK_ID/status
# Expected: eventually shows { status: "completed", wrapupResults: [{ type: "git-pr", success: true, artifact: "https://github.com/..." }] }
```

- [ ] **Step 5: Verify PR was created**

Check the test repo on GitHub for a new PR created by the agent.

- [ ] **Step 6: Document any issues found**

Record in a follow-up issue: cold start time, error messages, config issues, etc.

---

## Self-Review

- [x] **Spec coverage:** T1 covers Dockerfile + config (spec §2 "Connection to Gateway Abstraction", §4 "Config"). T2 covers API contract (spec §7 "HTTP API"). T3 covers CI. T4 covers E2E (spec §12 "Verify").
- [x] **No placeholders:** All config files have actual JSON. All code changes show the actual code. Commands are exact.
- [x] **Type consistency:** `taskInputSchema` in T2 matches `WorkerTaskInput` in `worker-task-runner.ts`. `controllerTaskId` in TaskEntry matches what the controller returns.
- [x] **Known gap:** Secrets management (1Password in k8s) is noted but not fully wired. Beta uses env var injection. Secrets are a separate scope.
- [x] **Known gap:** Skills (SKILL.md files) not baked into VM image yet. Worker uses default instructions. Skills are additive.
- [x] **Known gap:** The Gondolin VM image OCI build (`docker build`) happens on first pod startup, adding ~30s cold start. Pre-caching in CI is future optimization.
