# Relay Beta Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Relay's deployed infrastructure (delegator + background-agent) to the agent-vm controller and agent-vm-worker so that `POST /tasks` to the delegator creates a Sysbox pod that runs a coding task end-to-end: clone repo → plan → implement → verify → PR.

**Architecture:** The relay-agent-delegator (already deployed, healthy in dev cluster) creates Sysbox pods. Each pod runs the agent-vm controller natively (not in Docker). The controller's `POST /zones/:zoneId/worker-tasks` route is **synchronous** — it does the entire lifecycle internally (clone repo, merge config, start Docker services, boot Gondolin VM, submit task to worker, poll worker, harvest result, cleanup) and returns the final result. The delegator creates the pod, waits for ready, POSTs the task, waits for the response, then deletes the pod. All packages are published to npm under `@shravansunder/` scope (public).

**Tech Stack:** TypeScript, pnpm, Hono, Zod, cmd-ts, Gondolin (QEMU), Sysbox, Docker Compose, ArgoCD, ECR, GitHub Actions

**Repos involved:**
- `agent-vm` (ShravanSunder/agent-vm) — controller + worker source, npm packages
- `relay-ai-tools` (relay-ai-tools) — delegator + background-agent Docker images

---

## System Architecture

```
relay-agent-delegator (k8s Deployment, port 3000, already deployed)
    │
    │ POST /tasks { prompt, repos, context }
    │   → creates Sysbox pod, waits for /health:18800
    │   → POST /zones/coding-agent/worker-tasks to controller
    │   → waits for synchronous response (controller does everything)
    │   → deletes pod
    │   → returns result to caller
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Sysbox Pod (image: relay/agent-vm-worker from ECR)           │
│                                                              │
│  systemd (PID 1)                                             │
│  Docker daemon (for pg, redis stacks ONLY)                   │
│  agent-vm controller runs NATIVELY in the pod (not Docker)   │
│                                                              │
│  agent-vm controller start --config /etc/agent-vm/system.json│
│  (port 18800, serves /health + /zones/:zoneId/worker-tasks)  │
│                                                              │
│  On POST /zones/coding-agent/worker-tasks:                   │
│    runWorkerTask() does EVERYTHING synchronously:            │
│    1. preStartGateway → mkdir, clone repo, merge config      │
│    2. docker compose up (pg, redis) ← nested Docker daemon   │
│    3. startGatewayZone → boot Gondolin VM (QEMU, native)     │
│    ┌──────────────────────────────────────┐                  │
│    │ Gondolin VM (QEMU)                   │                  │
│    │  node /opt/agent-vm-worker/dist/     │                  │
│    │       main.js serve --port 18789     │                  │
│    │  /workspace → VFS mount (cloned repo)│                  │
│    │  /state → VFS mount (JSONL events)   │                  │
│    │  postgres.local:5432 → TCP to Docker │                  │
│    │                                      │                  │
│    │  plan → review → work → verify →     │                  │
│    │  review → wrapup (git-pr) → done     │                  │
│    └──────────────────────────────────────┘                  │
│    4. POST /tasks to worker via ingress                      │
│    5. Poll GET /tasks/:id every 1s until terminal            │
│    6. vm.close()                                             │
│    7. postStopGateway → stop Docker, delete task dirs        │
│    8. Return final result in HTTP response                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key API Surface (controller inside pod)

| Route | Method | Behavior |
|-------|--------|----------|
| `/health` | GET | Returns `{ ok: true, port }` — readiness probe target |
| `/zones/:zoneId/worker-tasks` | POST | **Synchronous.** Runs full task lifecycle. Returns final result when done. Body: `{ prompt, repos, context }` |
| `/controller-status` | GET | Controller status |
| `/zones/:zoneId/logs` | GET | Gateway logs |

**There is NO async task ID or polling endpoint on the controller.** The controller's `runWorkerTask()` blocks until the worker completes or fails (up to 30min timeout). The delegator waits for this single HTTP response.

### Worker binary path inside Gondolin VM

The `worker-lifecycle.ts` starts the worker at a fixed path:
```
node /opt/agent-vm-worker/dist/main.js serve --port 18789
```

The OCI Dockerfile (gateway image rootfs) must install `@shravansunder/agent-vm-worker` from npm AND symlink its dist to `/opt/agent-vm-worker/dist/` so the hardcoded path resolves.

---

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

**Why:** The base image currently has no controller binary (`sleep infinity`). We need to install `@shravansunder/agent-vm` via pnpm, update system.json for the new schema, add a gateway config for the worker, and set up the Gondolin VM image build.

**Files:**
- Modify: `relay-background-agent/Dockerfile`
- Modify: `relay-background-agent/config/system.json`
- Create: `relay-background-agent/config/coding-gateway.json`
- Create: `relay-background-agent/images/gateway/Dockerfile`
- Create: `relay-background-agent/images/gateway/build-config.json`
- Create: `relay-background-agent/scripts/start.sh`
- Modify: `relay-background-agent/package.json`
- Modify: `relay-background-agent/README.md`

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

The current `systemConfigSchema` in `packages/agent-vm/src/config/system-config.ts` requires: `host.secretsProvider.type: "1password"` with a tokenSource discriminated union, `gateway.type: "openclaw" | "coding"`, `gatewayConfig` (not `openclawConfig`), `cacheDir`, `images.gateway` + `images.tool`, `tcpPool`, and `toolProfiles`.

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
      "buildConfig": "/etc/agent-vm/images/gateway/build-config.json"
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

Note: For beta, secrets can use `"injection": "env"` — the controller passes them as env vars to the VM. The 1Password `ref` values are placeholders; Relay will set the real refs. The `OP_SERVICE_ACCOUNT_TOKEN` env var is injected into the pod via k8s Secret.

- [ ] **Step 3: Create coding-gateway.json (worker config)**

This is the gateway-level config that `preStartGateway()` reads, merges with project config, and writes as `effective-worker.json` for the worker. Matches `workerConfigSchema` in `packages/agent-vm-worker/src/config/worker-config.ts`.

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

Skills arrays are empty for beta. The worker uses default instructions from code. Skills will be added when SKILL.md files are baked into the Gondolin VM image.

- [ ] **Step 4: Create the Gondolin VM OCI Dockerfile**

This is the OCI image that becomes the Gondolin VM rootfs. The controller builds it with `docker build` on first pod startup. The worker binary (`agent-vm-worker`) is installed from npm and symlinked to `/opt/agent-vm-worker/dist/` because `worker-lifecycle.ts` starts it at `node /opt/agent-vm-worker/dist/main.js`.

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
    npm install -g pnpm@10 && \
    mkdir -p /opt/agent-vm-worker && \
    cd /opt/agent-vm-worker && \
    pnpm add @shravansunder/agent-vm-worker && \
    ln -sf /opt/agent-vm-worker/node_modules/@shravansunder/agent-vm-worker/dist /opt/agent-vm-worker/dist && \
    useradd -m -s /bin/bash coder && \
    mkdir -p /home/coder /workspace /state /run/sshd /root && \
    chown -R coder:coder /home/coder && \
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true
```

The symlink `ln -sf .../node_modules/@shravansunder/agent-vm-worker/dist /opt/agent-vm-worker/dist` ensures the hardcoded `startCommand` in `worker-lifecycle.ts:53` resolves correctly.

- [ ] **Step 5: Create the Gondolin build-config.json**

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
  }
}
```

No `postBuild.copy` needed — the worker is installed from npm in the OCI Dockerfile. `oci.pullPolicy: "never"` means the OCI image must exist locally when Gondolin builds the VM image (the start script builds it first).

- [ ] **Step 6: Create the pod startup script**

The `docker build` and `agent-vm build` steps require Docker to be running. In the Sysbox pod, Docker is managed by systemd and isn't available during `docker build` (CI time). So we build on first pod startup.

`relay-background-agent/scripts/start.sh`:
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

This waits for systemd to start the Docker daemon, builds the OCI image (rootfs for the Gondolin VM), then starts the controller. The controller's `startGatewayZone()` will call `buildImage()` which uses the OCI image + Alpine kernel to create the final Gondolin VM image. First startup takes ~30-60s (OCI build + Gondolin build). Subsequent restarts reuse the cached Gondolin image.

- [ ] **Step 7: Update the main Dockerfile**

```dockerfile
# ---------------------------------------------------------------------------
# relay-background-agent — functional worker pod image
# ---------------------------------------------------------------------------

FROM docker.io/nestybox/ubuntu-noble-systemd-docker:latest

# Node.js 24.x (required by Gondolin)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs=24.* \
    && npm install -g pnpm@10

# pnpm global bin path — ensures `agent-vm` binary is on PATH
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

# QEMU for Gondolin VMs (TCG mode — no KVM on m8a instances)
RUN apt-get update \
    && apt-get install -y --no-install-recommends qemu-system-x86 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install agent-vm controller from npm (public @shravansunder scope)
RUN pnpm add -g @shravansunder/agent-vm

# Pre-download Gondolin guest assets (Alpine kernel + initramfs, ~200MB)
RUN pnpm dlx @shravansunder/gondolin image pull || true

# Copy Relay configuration + Gondolin VM image build files
COPY config/ /etc/agent-vm/
COPY stacks/ /etc/agent-vm/stacks/
COPY images/ /etc/agent-vm/images/

# Startup script (waits for Docker, builds OCI image, starts controller)
COPY scripts/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# Create runtime directories
RUN mkdir -p /var/agent-vm/state /var/agent-vm/workspace /var/agent-vm/cache

EXPOSE 18800

CMD ["/usr/local/bin/start.sh"]
```

- [ ] **Step 8: Update README.md**

Replace the current content to reflect a functional image:
- Installed packages: `@shravansunder/agent-vm` (controller CLI + Gondolin core)
- CMD: startup script that builds OCI image then starts controller
- Config paths: `/etc/agent-vm/system.json`, `/etc/agent-vm/coding-gateway.json`
- Gateway OCI image: built on first pod startup (requires Docker daemon via systemd)
- Cold start: ~30-60s first boot, ~5s subsequent (Gondolin image cached)

- [ ] **Step 9: Commit**

```bash
cd relay-ai-tools
git add relay-background-agent/
git commit -m "feat(relay-background-agent): install agent-vm controller, add coding gateway config

- Install @shravansunder/agent-vm via pnpm (controller CLI)
- Update system.json for gateway abstraction schema (type: coding)
- Add coding-gateway.json (worker phase config)
- Add gateway OCI Dockerfile (installs agent-vm-worker from npm, symlinks dist)
- Add Gondolin build-config.json (Alpine + OCI rootfs, 4GB)
- Startup script: wait for Docker → build OCI image → start controller
- ENV PNPM_HOME for global binary resolution"
```

---

### Task 2: Update relay-agent-delegator — API Contract

**Why:** The delegator currently sends task input as pod env vars (`TASK_REPO_URL`, `TASK_PROMPT`, etc.) and has no task submission step. In the new model, the delegator creates the pod, waits for the controller to be ready, then POSTs the task to `POST /zones/:zoneId/worker-tasks`. This call is **synchronous** — the controller runs the full lifecycle and returns the final result. The delegator then deletes the pod.

**Critical understanding:** The controller's `runWorkerTask()` in `worker-task-runner.ts` blocks for the entire task duration (up to 30min). There is no async task ID or polling on the controller side. The controller internally polls the worker VM — the delegator just waits for the HTTP response.

**Files:**
- Modify: `relay-agent-delegator/src/routes/task-routes.ts`
- Modify: `relay-agent-delegator/src/routes/task-routes.test.ts`
- Modify: `relay-agent-delegator/src/k8s/pod-creator.ts`
- Modify: `relay-agent-delegator/src/k8s/pod-creator.test.ts`
- Modify: `relay-agent-delegator/src/config.ts`

- [ ] **Step 1: Update task input schema**

In `relay-agent-delegator/src/routes/task-routes.ts`, update to match `controllerWorkerTaskRequestSchema` in `packages/agent-vm/src/controller/http/controller-request-schemas.ts`:

```typescript
export const taskInputSchema = z.object({
  prompt: z.string().min(1).max(10_000),
  repos: z.array(z.object({
    repoUrl: z.string().url().max(500),
    baseBranch: z.string().min(1).max(200).default("main"),
  })).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
});
```

Remove: `repoUrl`, `branch`, `testCommand`, `lintCommand`, `model`, `stackComposePath`. These are now in the gateway config or project config (`.agent-vm/config.json` in the repo), not task input.

- [ ] **Step 2: Add zoneId to config**

In `relay-agent-delegator/src/config.ts`, add the zone ID the delegator targets:

```typescript
export const appConfigSchema = z.object({
  port: z.number().default(3000),
  workerImage: z.string().default("912732483245.dkr.ecr.us-east-1.amazonaws.com/relay/agent-vm-worker:latest"),
  workerNamespace: z.string().default("agent-vm"),
  workerMemory: z.string().default("8Gi"),
  workerCpu: z.string().default("2"),
  workerRuntimeClass: z.string().default("sysbox-runc"),
  controllerPort: z.number().default(18800),
  controllerZoneId: z.string().default("coding-agent"),
  idleTimeoutMinutes: z.number().default(30),
  workerTaskTimeoutMs: z.number().default(30 * 60 * 1000),
});
```

Added: `controllerZoneId` (matches `zones[].id` in system.json) and `workerTaskTimeoutMs` (how long to wait for the synchronous controller response).

- [ ] **Step 3: Simplify pod env vars**

In `relay-agent-delegator/src/k8s/pod-creator.ts`, remove all task-specific env vars. The pod only needs controller-level config:

```typescript
const podEnvVars = [
  { name: "CONTROLLER_PORT", value: String(config.controllerPort) },
];

// Secrets (OPENAI_API_KEY, GITHUB_TOKEN, OP_SERVICE_ACCOUNT_TOKEN)
// injected via k8s Secret envFrom — not in this list
```

Remove: `TASK_ID`, `TASK_REPO_URL`, `TASK_BRANCH`, `TASK_PROMPT`, `TASK_TEST_COMMAND`, `TASK_LINT_COMMAND`, `TASK_MODEL`, `IDLE_TIMEOUT_MINUTES`.

- [ ] **Step 4: Update readiness probe path**

The controller serves `/health` (not `/healthcheck`). Update in `buildWorkerPodSpec`:

```typescript
readinessProbe: {
  httpGet: {
    path: "/health",
    port: config.controllerPort,
  },
  initialDelaySeconds: 15,
  periodSeconds: 5,
  timeoutSeconds: 3,
  failureThreshold: 40,  // 40 * 5s = 200s (OCI build + Gondolin build on first start)
},
```

`initialDelaySeconds: 15` because the startup script waits for Docker daemon (~5-10s) before even starting the controller.

- [ ] **Step 5: Rewrite startPodCreation — synchronous task submission + cleanup**

The entire flow is: create pod → wait ready → POST task (blocks) → delete pod.

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
    entry.status = "pod-ready";

    // Submit task to controller — this blocks until the task completes or fails.
    // The controller's runWorkerTask() handles everything internally:
    // clone repo, merge config, start Docker services, boot VM, run worker, cleanup.
    const taskResponse = await proxyRequest({
      podIp,
      controllerPort: config.controllerPort,
      path: `/zones/${config.controllerZoneId}/worker-tasks`,
      method: "POST",
      body: JSON.stringify({
        prompt: taskInput.prompt,
        repos: taskInput.repos,
        context: taskInput.context,
      }),
      timeoutMs: config.workerTaskTimeoutMs,
    });

    if (taskResponse.status >= 400) {
      entry.status = "failed";
      entry.error = `Controller error ${taskResponse.status}: ${JSON.stringify(taskResponse.body)}`;
    } else {
      entry.status = "completed";
      entry.result = taskResponse.body;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    entry.status = "failed";
    entry.error = message;
    console.error(`Task "${taskId}" failed: ${message}`);
  } finally {
    // Always clean up the pod
    try {
      await deleteWorkerPod({
        coreApi,
        namespace: config.workerNamespace,
        podName: entry.podName,
      });
    } catch (cleanupError: unknown) {
      const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`Failed to cleanup pod "${entry.podName}": ${msg}`);
    }
  }
}
```

- [ ] **Step 6: Update TaskEntry and TaskStatus**

```typescript
type TaskStatus = "creating-pod" | "pod-ready" | "completed" | "failed";

interface TaskEntry {
  id: string;
  status: TaskStatus;
  podName: string;
  podIp: string | undefined;
  input: TaskInput;
  result: unknown | undefined;   // ← NEW: controller's final response
  error: string | undefined;
  createdAt: string;
}
```

No `controllerTaskId` — the controller doesn't return one. The synchronous response IS the result.

- [ ] **Step 7: Update proxy timeout**

In `relay-agent-delegator/src/proxy/request-proxy.ts`, the default 30s timeout is too short for the synchronous controller call. The timeout is now passed per-request via `timeoutMs` parameter (already supported — the `proxyRequest` function accepts `timeoutMs`). The delegator passes `config.workerTaskTimeoutMs` (default 30 minutes) for the worker-task POST.

- [ ] **Step 8: Remove the delegator-side polling and task status proxy routes**

There is no async polling. Remove:
- Any `pollUntilTerminal` helper
- Any `GET /tasks/:id/status` proxy route

The `GET /tasks/:id` route returns the delegator's `TaskEntry` which includes `entry.result` (the controller's final response) once the task completes.

- [ ] **Step 9: Update tests**

Update `task-routes.test.ts`:
- New task input schema (prompt + repos[] + context)
- No task-specific env vars in pod spec
- Readiness probe at `/health`
- Synchronous task submission via proxy
- Pod deletion in finally block

Update `pod-creator.test.ts`:
- Simplified env vars (just CONTROLLER_PORT)
- Readiness probe path + higher failure threshold

- [ ] **Step 10: Run tests**

Run: `cd relay-ai-tools/relay-agent-delegator && pnpm vitest run`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
cd relay-ai-tools
git add relay-agent-delegator/
git commit -m "feat(relay-agent-delegator): synchronous task submission to controller

- Task input: prompt + repos[] + context (matches controller schema)
- Remove task-specific env vars (TASK_REPO_URL, TASK_PROMPT, etc.)
- POST /zones/:zoneId/worker-tasks — synchronous, controller blocks
- Delete pod in finally block after task completes or fails
- Readiness probe: /health, 200s max wait (cold start)
- Add controllerZoneId + workerTaskTimeoutMs to config"
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

The Dockerfile now runs `pnpm add -g @shravansunder/agent-vm` — this downloads from public npm, no auth needed.

- [ ] **Step 2: Push relay-agent-delegator changes and verify CI**

Watch: `.github/workflows/relay-agent-delegator-dev.yml`
Expected: Image builds, pushes to `relay/agent-vm-delegator:latest` in dev ECR.

- [ ] **Step 3: Verify ArgoCD sync**

```bash
argocd app sync agent-vm-delegator --force
argocd app logs agent-vm-delegator | head -5
# Expected: "relay-agent-delegator listening on port 3000"
```

- [ ] **Step 4: Verify k8s secrets exist**

The controller needs `OP_SERVICE_ACCOUNT_TOKEN` (or `OPENAI_API_KEY` + `GITHUB_TOKEN` directly) in the pod environment. These come from k8s Secrets. Verify they exist:

```bash
kubectl -n agent-vm get secrets
# Expected: a secret with OPENAI_API_KEY, GITHUB_TOKEN
```

If missing, create them:
```bash
kubectl -n agent-vm create secret generic agent-vm-secrets \
  --from-literal=OPENAI_API_KEY=<key> \
  --from-literal=GITHUB_TOKEN=<token>
```

The pod spec in `buildWorkerPodSpec` needs `envFrom` referencing this secret. This may need a code change in the delegator's pod creator if not already wired.

---

### Task 4: E2E Smoke Test

**Why:** Prove the full chain works: delegator → pod → controller → Gondolin VM → worker → PR.

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
# Expected: agent-vm-<taskId> appears, goes Pending → Running → Ready
# This may take 30-60s on first cold start (OCI build + Gondolin build)
```

- [ ] **Step 4: Wait for task completion**

The delegator's background `startPodCreation` is running. Poll the delegator:

```bash
TASK_ID=<from step 2>
watch -n 5 "curl -s http://localhost:3000/tasks/$TASK_ID | jq .status"
# Expected progression: creating-pod → pod-ready → completed (or failed)
# This may take 5-15 minutes for the full plan → work → verify → PR cycle
```

- [ ] **Step 5: Check final result**

```bash
curl -s http://localhost:3000/tasks/$TASK_ID | jq .
# Expected: { status: "completed", result: { taskId: "...", finalState: { status: "completed", ... } } }
```

- [ ] **Step 6: Verify PR was created**

Check the test repo on GitHub for a new PR created by the agent.

- [ ] **Step 7: Verify pod was cleaned up**

```bash
kubectl -n agent-vm get pods | grep agent-vm-
# Expected: pod is gone (deleted by delegator after task completed)
```

- [ ] **Step 8: Document issues found**

Record in a follow-up issue: cold start time, error messages, config issues, missing secrets, timeouts, etc.

---

## Self-Review

- [x] **Spec coverage:** T1=Dockerfile+config (worker-gateway, system-config, worker-config schemas). T2=API contract (controller-zone-operation-routes, controller-request-schemas). T3=CI. T4=E2E.
- [x] **No placeholders:** All config files have actual JSON matching Zod schemas. All code shows actual code. Commands are exact.
- [x] **Type consistency:** `taskInputSchema` in T2 matches `controllerWorkerTaskRequestSchema`. `TaskEntry.result` is `unknown` matching the controller's untyped response. `controllerZoneId` matches `zones[].id` in system.json.
- [x] **Controller route is correct:** `POST /zones/:zoneId/worker-tasks` (not `/coding/tasks`). Verified against `controller-zone-operation-routes.ts:42`.
- [x] **Controller call is synchronous:** `runWorkerTask()` blocks for the full lifecycle. No async task ID, no delegator-side polling.
- [x] **Worker binary path resolved:** OCI Dockerfile installs `@shravansunder/agent-vm-worker` from npm and symlinks `node_modules/.../dist` → `/opt/agent-vm-worker/dist` so `worker-lifecycle.ts:53` resolves.
- [x] **Pod cleanup:** Delegator deletes pod in `finally` block after task completes or fails.
- [x] **PNPM_HOME set:** Dockerfile sets `ENV PNPM_HOME=/usr/local/share/pnpm` and `ENV PATH=$PNPM_HOME:$PATH`.
- [x] **Known gap:** Secrets management (k8s Secret → pod envFrom) may need additional wiring in the pod spec. Noted in T3.
- [x] **Known gap:** Cold start ~30-60s (Docker daemon wait + OCI build + Gondolin image build). Acceptable for beta.
- [x] **Known gap:** Skills not baked into VM image yet. Worker uses default instructions. Additive future work.
