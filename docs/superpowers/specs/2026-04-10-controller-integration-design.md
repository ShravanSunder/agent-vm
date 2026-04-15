# Controller Integration Design — End-to-End System

**Goal:** Wire agent-vm-coding into the agent-vm controller so `agent-vm controller start` boots a coding agent in a Gondolin VM that receives tasks and produces PRs. Define the full consumption path: generic (personal Mac), Relay local (relay-background-agent on Mac), and Relay k8s (distributed via delegator).

**Scope:** Controller gateway type, VM image build, skills, stack manager, repo cloner, CLI, and E2E testing. Covers agent-vm repo (generic) and documents relay-ai-tools integration points.

**Concurrency model:** One VM at a time per controller instance. Controller creates VM on first task, reuses for followups, kills on close/timeout. Concurrent multi-VM support is future work.

**Validated by Gondolin source + DeepWiki:**
- `postBuild.copy` is a real Gondolin feature (copies host files/dirs into rootfs, src relative to config file)
- `postBuild.commands` works on macOS (automatically uses container mode for OCI images)
- Multiple VMs from same cached image are supported (each uses independent overlay)
- VM.create() with cached image has minimal overhead (<1s boot)
- Snapshots are disk-only (rootfs persists, VFS/tmpfs do not)

---

## 1. Three Consumption Modes

### Personal (no Relay, no Docker)

```
agent-vm controller start --config system.json
  → Controller reads zone type: "agent-vm-coding"
  → Resolves secrets, pre-builds/caches VM image (once, ~10-30s first time)
  → Ready to accept tasks (no VM yet — lazy creation)
  → User: curl -X POST http://localhost:18792/coding/tasks -d '{...}'
  → Controller clones repo, starts stack, creates VM, forwards task
  → VM boots in ~50ms (image cached), agent works, PR created
```

### Relay Local (relay-background-agent on Mac, no Docker)

```
relay-agent start --repo relayfinancial/payments-api --prompt "fix bug"
  → CLI reads .env for keys
  → Calls: agent-vm controller start --config relay-config
  → Controller pre-builds image (cached), ready for tasks
  → CLI submits task → controller creates VM on demand
  → Agent works with Relay skills, Relay config, Relay secrets
  → CLI streams status, prints PR URL
```

No Docker needed locally. VMs are Gondolin (QEMU), not containers. Docker is only for k8s (DinD for service stacks like pg/redis in Sysbox pods).

### Relay K8s (distributed)

```
relay-agent-delegator creates Sysbox pod
  → Pod runs relay-background-agent Docker image
  → Inside pod: Docker Compose starts pg + redis (DinD)
  → Inside pod: agent-vm controller start
  → Same flow as local, but under TCG (no KVM)
  → Delegator manages pod lifecycle
```

Docker is used ONLY in k8s for service stacks (pg, redis) that need to run alongside the VM. On Mac, services run via Docker Desktop or the project's existing dev setup.

---

## 2. Controller Gateway Type

### system.json Update

Discriminated union on `zones[].gateway.type`:

```typescript
const zoneGatewaySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('openclaw'),
    memory: z.string().regex(/^(\d+)([GgMm])$/),
    cpus: z.number().int().positive(),
    port: z.number().int().positive(),
    openclawConfig: z.string().min(1),
    stateDir: z.string().min(1),
    workspaceDir: z.string().min(1),
  }),
  z.object({
    type: z.literal('agent-vm-coding'),
    memory: z.string().regex(/^(\d+)([GgMm])$/).default('2G'),
    cpus: z.number().int().positive().default(2),
    port: z.number().int().positive(),
    stateDir: z.string().min(1),
    workspaceDir: z.string().min(1),
    codingGatewayConfigPath: z.string().min(1).optional(),
    imageBuildConfigPath: z.string().min(1).default('./images/coding-agent/build-config.json'),
  }),
]);
```

### Controller Runtime Dispatch

```typescript
// controller-runtime.ts
const zone = systemConfig.zones[0];
if (zone.gateway.type === 'openclaw') {
  gateway = await startGatewayZone({...});       // existing
} else if (zone.gateway.type === 'agent-vm-coding') {
  gateway = await startCodingGatewayZone({...}); // new
}
```

### startCodingGatewayZone()

New function in `coding-gateway-manager.ts`.

**VM lifecycle: per-PR, not per-task and not long-lived.**

```
Task arrives → clone repo → create VM → agent works → PR created
  VM stays alive (awaiting-followup)
PR review comment → POST /followup to same VM → agent fixes → push
  VM stays alive
PR merged (or timeout) → POST /coding/tasks/:id/close → controller kills VM → cleanup
```

The VM lives for the duration of the PR/workstream. Followups go to the same VM (same Codex threads, same state). A new PR means a new VM (clean slate, no state leakage).

On Mac: idle reaper kills the VM after `idleTimeoutMs`.
In k8s: the pod = the VM lifetime. Pod dies when PR merges or times out.

**Controller startup (runs once, no VM, no stack):**

1. Resolve secrets via SecretResolver
2. Load coding-gateway.json (CodingGatewayConfig) if path provided
3. Build/cache Gondolin VM image (Debian OCI + Codex + skills). Uses cached image if available (~50ms). First build takes ~10-30s. In development, pass `fullReset: true` to force rebuild.
4. Ready to accept tasks (no VM, no stack running yet)

**On first task (creates stack + VM):**

1. Clone repo (shallow: `--depth 1 --single-branch`) into host workspace dir using GIT_ASKPASS
2. Read `.agent-vm/config.json` from cloned repo (if exists)
3. Merge config: task body > project `.agent-vm/` > org config defaults
4. Start Docker Compose stack: use project's `.agent-vm/docker-compose.yml` if exists, else zone default, else no stack
5. Resolve Docker container IPs → tcp.hosts (if stack started)
6. Create Gondolin VM with:
   - `sandbox: { imagePath }` (the cached image)
   - VFS: `/workspace` → host repo clone (RealFSProvider)
   - VFS: `/state` → host state dir (RealFSProvider)
   - TCP: postgres, redis → Docker container IPs (if stack configured)
   - MITM: CODEX_API_KEY, GITHUB_TOKEN → allowed hosts
   - Env: `PORT=8080`, coding-gateway config as mounted JSON
6. Wait for agent-vm-coding healthcheck (`GET /health` via ingress)
7. Forward task to `POST /tasks` on coding gateway (port 8080 via ingress)

**On followup (same VM):**

1. Forward to `POST /tasks/:id/followup` on the coding gateway via ingress
2. Same VM, same workspace, same Codex threads

**On close (kills VM):**

1. Forward `POST /tasks/:id/close` to coding gateway
2. Close Gondolin VM
3. Stop Docker Compose stack (if started)
4. Clean up host workspace dir

**Image packaging:** agent-vm-coding is `private: true` (not published to npm). Two approaches for the VM image build:

**Approach A: postBuild.copy + commands (works on Mac via container mode)**

Gondolin automatically uses a container for postBuild on macOS. `src` is resolved relative to the build-config.json file location. Copies run before commands.

```json
{
  "postBuild": {
    "copy": [
      { "src": "../../packages/agent-vm-coding/dist", "dest": "/opt/agent-vm-coding" },
      { "src": "../../skills/builtin", "dest": "/root/.agents/skills" },
      { "src": "../../skills/superpowers", "dest": "/root/.agents/skills" }
    ],
    "commands": [
      "npm install -g @openai/codex",
      "chmod +x /opt/agent-vm-coding/main.js",
      "ln -s /opt/agent-vm-coding/main.js /usr/local/bin/agent-vm-coding"
    ]
  }
}
```

**Approach B: Commands-only with npm pack**

Build a tarball, copy it in, install from tarball inside the image:

```json
{
  "postBuild": {
    "copy": [
      { "src": "../../packages/agent-vm-coding/agent-vm-coding-0.1.0.tgz", "dest": "/tmp/agent-vm-coding.tgz" }
    ],
    "commands": [
      "npm install -g /tmp/agent-vm-coding.tgz @openai/codex",
      "rm /tmp/agent-vm-coding.tgz"
    ]
  }
}
```

**Recommended: Approach A for POC.** Simpler, no tarball step. If `src` doesn't exist, Gondolin throws `postBuild.copy source not found` — clear error.

---

## 3. New Controller Modules

### Stack Manager (`stack-manager.ts`)

Manages Docker Compose lifecycle for service stacks.

```typescript
interface StackManager {
  startStack(composePath: string): Promise<void>;
  resolveServiceIps(serviceNames: string[]): Promise<Record<string, string>>;
  stopStack(): Promise<void>;
}
```

- `startStack`: runs `docker compose -f <path> up -d --wait`
- `resolveServiceIps`: runs `docker inspect` to get container IPs
- `stopStack`: runs `docker compose -f <path> down -v`
- Error handling: retry transient failures, clean up on fatal
- Wired into zone destroy for cleanup

### Repo Cloner (`repo-cloner.ts`)

Clones the target repo on the host side (fast, native disk).

```typescript
interface RepoCloner {
  cloneRepo(options: CloneOptions): Promise<string>; // returns clone dir path
}

interface CloneOptions {
  readonly repoUrl: string;
  readonly branch: string;
  readonly workspaceDir: string;
  readonly githubToken: string;
}
```

- Uses GIT_ASKPASS for token (not embedded in URL on host side)
- Clones into `workspaceDir/` 
- Returns the clone path for VFS mounting

### Project Config Discovery

After cloning, check for `.agent-vm/` in the repo:

```typescript
interface ProjectConfig {
  readonly testCommand?: string;
  readonly lintCommand?: string;
  readonly branchPrefix?: string;
  readonly stackComposePath?: string;  // .agent-vm/docker-compose.yml
}
```

If `.agent-vm/config.json` exists, merge project config with org config:
- Project sets: testCommand, lintCommand, branchPrefix, stack
- Org sets: model, skills, loop limits, secrets, allowedHosts
- Task sets: prompt, repoUrl, baseBranch

---

## 4. VM Image

### Build Config (`images/coding-agent/build-config.json`)

Already exists. Debian OCI with node:24-slim, 2GB rootfs.

At build time, bake in via postBuild.copy + commands (works on Mac — Gondolin uses container mode automatically for OCI images):
- Codex CLI (`npm install -g @openai/codex` in postBuild.commands)
- agent-vm-coding (copy dist/ via postBuild.copy, symlink to /usr/local/bin)
- Generic skills (copy superpowers skills via postBuild.copy to `~/.agents/skills/`)
- Builtin skills (copy generic-plan-review, generic-code-review to `~/.agents/skills/`)

Image is built once and cached by fingerprint (SHA256 of config + gondolin version). Subsequent builds skip if config hasn't changed.

**postBuild mechanics (validated against Gondolin source):**

```typescript
// gondolin/host/src/build/config.ts
interface PostBuildCopyEntry {
  src: string;   // resolved relative to build config file
  dest: string;  // absolute path inside guest rootfs
}

interface PostBuildConfig {
  copy?: PostBuildCopyEntry[];    // runs BEFORE commands
  commands?: string[];            // runs AFTER copy, via /bin/sh -lc in chroot
}
```

- On macOS: postBuild.commands automatically use container mode for OCI images
- Directories can be copied (contents merged into dest)
- Throws `postBuild.copy source not found` if src missing
- **Cache limitation:** fingerprint is computed from the JSON config only. Changes to copied files (dist/, skills/) without changing the JSON will NOT invalidate the cache. In development, always pass `fullReset: true` to force rebuild. Production CI builds clean (no cache).

For Relay: relay-background-agent's downstream Dockerfile adds:
- Relay-specific skills (code-reviewer, silent-failure-hunter, pr-test-analyzer)
- Relay coding-gateway.json

### Skills Installation

Skills are directories with SKILL.md, baked into `~/.agents/skills/` in the image:

```
~/.agents/skills/
├── writing-plans/SKILL.md             # superpowers
├── brainstorming/SKILL.md             # superpowers
├── test-driven-development/SKILL.md   # superpowers
├── verification-before-completion/SKILL.md
├── generic-plan-review/SKILL.md       # builtin (we write these)
├── generic-code-review/SKILL.md       # builtin (we write these)
├── code-reviewer/SKILL.md             # relay only (from relay-ai)
├── silent-failure-hunter/SKILL.md     # relay only
└── pr-test-analyzer/SKILL.md          # relay only
```

Superpowers skills are vendored into `skills/superpowers/` in this repo (just the 5 SKILL.md files we use, not the entire obra/superpowers repo). Update manually when superpowers updates.

Generic image has superpowers + builtin. Relay image adds relay-ai skills on top.

---

## 5. Config Ownership

```
FIELD                    OWNER                  SET WHERE
─────────────────────    ─────────────────      ──────────────────
model                    Org (Relay config)     coding-gateway.json
reviewModel              Org (Relay config)     coding-gateway.json
skills (all 4 agents)    Org (Relay config)     coding-gateway.json
loop limits              Org (Relay config)     coding-gateway.json
allowedHosts             Org (Relay config)     system.json
secrets                  Org (Relay config)     system.json / env vars
testCommand              Project                .agent-vm/config.json
lintCommand              Project                .agent-vm/config.json
branchPrefix             Project                .agent-vm/config.json
stack (docker-compose)   Project                .agent-vm/docker-compose.yml
prompt                   Task                   POST /tasks body
repoUrl                  Task                   POST /tasks body
baseBranch               Task                   POST /tasks body
```

**Precedence for shared fields:** `task body > project .agent-vm/ > org config defaults`

testCommand and lintCommand exist as defaults in org config (CodingGatewayConfig). Projects can override them in `.agent-vm/config.json`. Tasks can override testCommand and lintCommand in the POST body. branchPrefix is org/project only (not per-task). The controller merges all sources before forwarding to the coding gateway — the gateway just sees final values.

**Image caching note:** Gondolin's `buildImage()` fingerprints from the JSON config only. Changes to copied files (dist/, skills/) without changing the JSON will NOT invalidate the cache. In development, always pass `fullReset: true` to force rebuild. Production CI builds clean (no cache). This is a known limitation, not a bug.

---

## 6. CLI (relay-background-agent)

cmd-ts CLI in `relay-background-agent/src/bin/relay-agent.ts`:

```
relay-agent start
  --repo <owner/repo>
  --prompt <string>
  --branch <string>          (default: main)
  --config <path>            (default: ./config/system.json)
  --gateway-config <path>    (default: ./config/coding-gateway.json)
  
  1. Load .env for keys
  2. Call: agent-vm controller start (in-process or subprocess)
  3. Wait for healthcheck
  4. POST /coding/tasks with repo, prompt, branch
  5. Stream status until awaiting-followup
  6. Print PR URL

relay-agent stop
  1. POST /coding/tasks/:id/close if active task
  2. agent-vm controller stop

relay-agent status
  GET /coding/tasks/:id → print state

relay-agent logs
  Tail JSONL event log from state dir

relay-agent doctor
  Check: Gondolin installed, QEMU available, keys in .env, disk space
```

Same patterns as agent-vm CLI (cmd-ts, Zod, Hono). TypeScript all the way.

---

## 7. E2E Testing

### Generic E2E (agent-vm repo)

```
1. agent-vm controller start with type: "agent-vm-coding"
2. Controller pre-builds image (cached), ready for tasks
3. POST /coding/tasks (small test repo, "add multiply function")
4. Controller creates VM on demand, forwards task
5. Wait for awaiting-followup
6. Verify: PR URL set, sum.js has multiply, tests pass
7. POST /coding/tasks/:id/close
8. agent-vm controller stop
```

### Relay Local E2E (relay-ai-tools repo)

```
1. relay-agent start --repo test/repo --prompt "add multiply"
2. CLI calls agent-vm controller → POST /coding/tasks
3. Wait for PR URL (streams status)
4. Verify PR on GitHub
5. relay-agent stop (POST /coding/tasks/:id/close)
```

### Relay K8s E2E (relay-ai-tools + helm-charts)

```
1. Delegator creates Sysbox pod
2. POST /coding/tasks to pod controller (via port-forward)
3. Wait for callback (PR created)
4. Verify PR on GitHub
5. POST /coding/tasks/:id/close
6. Pod torn down
```

---

## 8. What to Build (this repo, Phase 1)

1. **system.json schema** — add discriminated union for gateway type
2. **startCodingGatewayZone()** — new gateway manager function
3. **stack-manager.ts** — Docker Compose lifecycle
4. **repo-cloner.ts** — git clone on host side
5. **Project config discovery** — read `.agent-vm/` from cloned repo
6. **Builtin skills** — generic-plan-review/SKILL.md, generic-code-review/SKILL.md
7. **VM image build** — update build-config.json to bake in skills + agent-vm-coding
8. **E2E test** — controller start → POST /coding/tasks → verify PR → POST /coding/tasks/:id/close → stop
9. **Update controller runtime** — dispatch on zone type

---

## 9. What to Build (relay-ai-tools, Phase 2)

1. **relay-agent CLI** — cmd-ts in relay-background-agent
2. **Relay skills** — extract from relay-ai into skills/ directory
3. **coding-gateway.json** — Relay-specific config
4. **Downstream Dockerfile** — layers agent-vm + skills onto base
5. **Local E2E test** — relay-agent start → PR → stop

---

## 10. What to Build (relay-ai-tools + helm-charts, Phase 3)

1. **Wire delegator** — create pods with new image
2. **Merge helm charts PR** — #23862
3. **K8s E2E** — delegator → pod → PR
4. **GitHub webhook** — PR merged → POST /coding/tasks/:id/close

