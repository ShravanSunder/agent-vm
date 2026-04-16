# Worker Task Pipeline

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Worker Task Pipeline

For the in-VM pipeline (what happens after task submission), see [worker-pipeline.md](../architecture/worker-pipeline.md). For configuration fields, see [configuration-reference.md](../reference/configuration-reference.md).

Controller-side lifecycle of a worker task from HTTP submission through
VM teardown. Every step runs on the host -- the VM is an opaque compute
box that the controller boots, monitors, and destroys. GitHub tokens and
push operations never enter the sandbox.

---

## End-to-End Flow

```
  POST /zones/:zoneId/worker-tasks
    |
    v
  runWorkerTask()
    |
    |-- preStartGateway()         Host-side scaffolding
    |     |-- taskId generation
    |     |-- directory scaffold
    |     |-- repo cloning
    |     |-- config merge
    |     |-- effective-worker.json write
    |     |-- Docker service routing
    |
    |-- ActiveTaskRegistry.register()
    |
    |-- startGatewayZone()        VM boot (zone override)
    |     |-- orphan cleanup
    |     |-- image build
    |     |-- VM create + bootstrap + start
    |     |-- health check + ingress
    |
    |-- POST /tasks               Submit task to worker inside VM
    |
    |-- GET /tasks/:taskId        Poll loop (1s interval)
    |     |-- terminal: completed | failed | closed
    |     |-- 3 consecutive failures -> abort
    |     |-- 30-min timeout (configurable)
    |
    |-- finally:
    |     |-- vm.close()
    |     |-- postStopGateway()   Docker down + workspace removal
    |     |-- ActiveTaskRegistry.clear()
    |
    v
  Returns { taskId, finalState, taskRoot }
```

---

## Task Submission

The HTTP entry point is `POST /zones/:zoneId/worker-tasks`, registered
in `controller-zone-operation-routes.ts`. The request body is validated
against `controllerWorkerTaskRequestSchema`:

```
{
  prompt:  string (min 1)
  repos:   [{ repoUrl, baseBranch }]   (defaults to [])
  context: Record<string, unknown>      (defaults to {})
}
```

On validation success the route delegates to `runWorkerTask()` which is
the `runWorkerTaskWithPerTaskVm` import wired through the controller
runtime. The runtime resolves the zone from `systemConfig.zones`,
asserts `gateway.type === 'worker'`, and proceeds to pre-start.

---

## preStartGateway

`preStartGateway(taskInput, zoneConfig)` in `worker-task-runner.ts`
performs all host-side preparation before any VM exists.

### Task ID and Directory Scaffold

```
  taskId = crypto.randomUUID()

  <stateDir>/tasks/<taskId>/
    |-- workspace/          Cloned repos live here
    |-- state/              Effective config, worker tarball, event log
```

Both directories are created with `{ recursive: true }`. If the
env var `AGENT_VM_WORKER_TARBALL_PATH` is set, the tarball is copied
into `state/agent-vm-worker.tgz` for local development builds.

### Repo Cloning

Repos are cloned sequentially into `workspace/<repoDirectoryName>`:

```
  for each repo in taskInput.repos:
    repoDirectoryName = deriveRepoDirectoryName(repo.repoUrl, usedNames)
    git clone --branch <baseBranch> <repoUrl> workspace/<repoDirectoryName>
```

`deriveRepoDirectoryName` extracts the trailing path segment from the
URL, strips `.git`, sanitizes to `[a-zA-Z0-9._-]`, and deduplicates
with a numeric suffix (`repo`, `repo-2`, `repo-3`). Each cloned repo
tracks both `hostWorkspacePath` (absolute host path) and `workspacePath`
(`/workspace/<name>` -- the guest-side mount point).

### Config Merge

Two JSON files are read and deep-merged to produce the effective config:

```
  base     = zoneConfig.gateway.gatewayConfig     (zone-level worker.json)
  override = primaryRepo/.agent-vm/config.json     (project-level override)

  merged   = deepMerge(base, override)
  effective = workerConfigSchema.parse(merged)
```

`deepMerge` rules:
- Objects: recursive key-by-key merge, override wins per key
- Arrays: override replaces entirely (no element-level merge)
- Scalars: override wins

Missing files resolve to `{}` (no error for absent project config).
The merged result is validated against `workerConfigSchema` which
applies Zod defaults for every optional field.

The effective config is written atomically to
`state/effective-worker.json` with mode `0o600`.

### Docker Service Routing

After cloning and config merge, Docker compose services are started.
See the dedicated section below.

### Error Handling

If any step in pre-start fails, the catch block:
1. Stops any Docker compose stacks that were successfully started.
2. Removes `taskRoot` entirely (`rm -rf`).
3. Re-throws the original error.

The `DockerServiceRoutingError` carries `startedComposeFilePaths` so
partial Docker starts are cleaned up correctly.

---

## VM Boot

`runWorkerTask` overrides the zone config to point workspace and state
directories at the task-specific paths:

```
  taskZoneConfig = {
    ...zone,
    gateway: {
      ...zone.gateway,
      workspaceDir: preStartResult.workspaceDir,
      stateDir:     preStartResult.stateDir,
    }
  }
```

Then calls `startGatewayZone()` with `zoneOverride: taskZoneConfig` and
`tcpHostsOverride: preStartResult.tcpHosts` (Docker service IPs). The
full orchestration sequence runs: orphan cleanup, image build, VM
creation, bootstrap, process start, health check, ingress enable.

### Worker VmSpec (from worker-lifecycle.ts)

```
  environment:
    HOME                = /home/coder
    CONTROLLER_BASE_URL = http://controller.vm.host:18800
    NODE_EXTRA_CA_CERTS = /run/gondolin/ca-certificates.crt
    AGENT_VM_ZONE_ID    = <zone.id>
    STATE_DIR           = /state
    WORKER_CONFIG_PATH  = /state/effective-worker.json
    WORKSPACE_DIR       = /workspace
    + env-injected secrets

  vfsMounts:
    /state      -> taskRoot/state/       (realfs)
    /workspace  -> taskRoot/workspace/   (realfs)

  tcpHosts:
    controller.vm.host:18800 -> 127.0.0.1:<controllerPort>
    + Docker service tcpHosts (e.g. postgres.local:5432 -> 172.17.0.2:5432)
```

### Worker ProcessSpec

```
  bootstrap:  npm install -g @openai/codex /state/agent-vm-worker.tgz
              (conditional on tarball existing)
  start:      cd /workspace && nohup agent-vm-worker serve
                --port 18789 --config /state/effective-worker.json
                --state-dir /state
  healthCheck: HTTP GET :18789/health
  logPath:     /tmp/agent-vm-worker.log
```

---

## Task Monitoring

Once the VM is healthy and ingress is available, the controller submits
the task and enters a poll loop.

### Task Submission

```
  POST http://<ingress.host>:<ingress.port>/tasks
  {
    taskId:  <preStartResult.taskId>,
    prompt:  <input.prompt>,
    repos:   <preStartResult.repos>,
    context: <input.context>
  }
```

### Poll Loop

```
  while (elapsed < timeoutMs):
    response = GET /tasks/<taskId>
    parse response against { status: string }

    if status in [completed, failed, closed]:
      return { taskId, finalState: response, taskRoot }

    if ZodError:
      throw immediately (schema violation is not retryable)

    if network/HTTP error:
      consecutivePollFailures++
      log to stderr
      if consecutivePollFailures >= 3: throw

    sleep 1 second
```

Default `timeoutMs` is 30 minutes (1,800,000 ms), configurable via
`options.timeoutMs`. The poll response is validated with a passthrough
Zod schema that requires `status: string` but preserves all other
fields for the caller.

---

## Controller-Side Push

After a task completes, the worker inside the VM can request the
controller to push branches and open PRs. This keeps GitHub tokens
on the host and out of the sandbox.

### HTTP Endpoint

```
  POST /zones/:zoneId/tasks/:taskId/push-branches
  {
    branches: [{
      repoUrl:    string,
      branchName: string,
      title:      string,
      body:       string
    }]
  }
```

### Validation

`pushBranchesForTask()` enforces two security constraints:

1. **Branch prefix**: every `branchName` must start with the task's
   `branchPrefix` (default `"agent/"`). Rejects with
   `PushBranchesValidationError` otherwise.

2. **Repo registration**: every `repoUrl` must match a repo registered
   for the active task. Prevents the VM from pushing to repos it was
   not given access to.

### Execution

For each branch (sequential, not parallel):

```
  1. git push <token-authenticated-url> <sanitized-branch>
     cwd = repo.hostWorkspacePath (host-side clone)

  2. gh pr create --repo <owner/repo> --title <title>
       --body <body> --base <baseBranch> --head <branch>
     GITHUB_TOKEN injected via env
```

Token values are scrubbed from error messages before surfacing:
`https://x-access-token:***@github.com/...`.

Results are collected per-branch with `{ success, prUrl?, error? }`.
A failure on one branch does not abort the remaining branches.

### Active Task Registry

`ActiveTaskRegistry` is an in-memory `Map<zoneId, ActiveWorkerTask>`
that enforces one active task per zone. The push-branches route uses
it to look up the task and validate the request.

```
  register(task)        Throws if zone already has a different task
  get(zoneId, taskId)   Returns task or null
  clear(zoneId, taskId) Removes only if IDs match
```

The controller runtime registers the task via `onTaskPrepared` (after
pre-start) and clears it via `onTaskFinished` (in the finally block).

---

## Teardown

The finally block in `runWorkerTask` always runs, even on timeout or
poll failure. Three phases, each in its own try/finally:

```
  1. vm.close()
     Sends shutdown signal to the Gondolin VM.

  2. postStopGateway(taskId, zone, composeFilePaths)
     a. docker compose down --remove-orphans  (for each compose file)
     b. rm -rf taskRoot/workspace/
     NOTE: taskRoot/state/ is retained for diagnostic inspection.
     Errors from both steps are collected; if both fail, throws
     AggregateError.

  3. onTaskFinished(zoneId, taskId)
     Calls activeTaskRegistry.clear(zoneId, taskId).
```

The workspace is removed but the state directory (containing
`effective-worker.json`, event logs, and task artifacts) survives for
post-mortem analysis.

---

## Config Merge Deep Dive

The effective config controls the entire worker pipeline: phase
executors, verification commands, wrapup actions, branch naming, and
idle timeouts.

### Source Priority

```
  +----------------------------+
  | Zone gateway config        |   base layer
  | (gatewayConfig path)       |   operator-controlled defaults
  +----------------------------+
              |
              v  deepMerge
  +----------------------------+
  | .agent-vm/config.json      |   override layer
  | (primary repo root)        |   project-specific customization
  +----------------------------+
              |
              v  workerConfigSchema.parse()
  +----------------------------+
  | Effective config           |   Zod defaults fill gaps
  | (state/effective-worker.json)
  +----------------------------+
```

### Key Config Fields (workerConfigSchema)

| Field                 | Default                              | Purpose                                    |
|-----------------------|--------------------------------------|--------------------------------------------|
| `defaults.provider`   | `codex`                              | LLM provider for all phases                |
| `defaults.model`      | `latest-medium`                      | Model alias resolved at runtime            |
| `phases.*`            | Phase-specific defaults              | Per-phase executor, skills, instructions   |
| `verification`        | `[{test, npm test}, {lint, npm run lint}]` | Commands run after work phase        |
| `branchPrefix`        | `agent/`                             | Required prefix for push-branches          |
| `commitCoAuthor`      | `agent-vm-worker <noreply@agent-vm>` | Git co-author trailer                      |
| `idleTimeoutMs`       | `1,800,000` (30 min)                 | Worker idle shutdown                       |
| `mcpServers`          | `[]`                                 | MCP servers available to the agent         |
| `wrapupActions`       | `[{ type: 'git-pr', required: true }]` | Post-task actions                        |

---

## Docker Service Routing

The Docker service routing subsystem discovers compose files in the
workspace, starts them, inspects running containers, and produces a
`tcpHosts` map that Gondolin injects into the VM's synthetic DNS.

### Compose File Discovery

```
  findComposeFiles(workspaceDir, repoHostDirs)

  Searches for .agent-vm/docker-compose.yml in:
    1. workspaceDir                (task workspace root)
    2. each cloned repo directory  (individual repos)

  Returns paths to all discovered compose files.
```

### Service Startup

Each compose file is started sequentially:

```
  for each composeFile:
    docker compose -f <composeFile> up -d --wait
      cwd = parent of parent of compose file
            (i.e. the repo or workspace root)
```

Sequential startup is deliberate -- compose stacks may share Docker
resources and parallel starts risk port conflicts.

### Container IP Extraction

After each stack starts, containers are discovered and inspected:

```
  docker compose -f <composeFile> ps -q    -> container IDs
  docker inspect <containerId>             -> NetworkSettings, Config

  For each container:
    serviceName = Labels["com.docker.compose.service"]
    ipAddress   = first non-empty IPAddress from Networks
    ports       = keys of Config.ExposedPorts

    For each exposed port:
      tcpHosts["<serviceName>.local:<port>"] = "<ipAddress>:<port>"
```

Container inspection runs in parallel per stack (after the sequential
compose-up).

### Resulting tcpHosts

The tcpHosts map is merged into the VM spec, making Docker services
reachable from inside the VM via Gondolin's synthetic DNS:

```
  Inside the VM:
    postgres.local:5432  -> 172.17.0.2:5432  (host Docker network)
    redis.local:6379     -> 172.17.0.3:6379
```

### Teardown

`stopDockerServicesForTask` runs `docker compose down --remove-orphans`
for each compose file. Errors are collected but only the first is
thrown -- all stacks are attempted regardless of individual failures.

---

## Source Files

### Controller (packages/agent-vm/src/controller/)

| File | Responsibility |
|------|----------------|
| `worker-task-runner.ts` | `preStartGateway`, `postStopGateway`, `runWorkerTask` -- full task lifecycle |
| `active-task-registry.ts` | In-memory one-task-per-zone registry |
| `git-push-operations.ts` | Host-side `git push` + `gh pr create` with token scrubbing |
| `docker-service-routing.ts` | Compose discovery, startup, container IP extraction, teardown |
| `controller-runtime.ts` | Wires task runner, push operations, and registry into the Hono app |
| `http/controller-zone-operation-routes.ts` | HTTP route registration for worker-tasks and push-branches |
| `http/controller-request-schemas.ts` | Zod schemas for request validation |

### Worker Gateway (packages/worker-gateway/src/)

| File | Responsibility |
|------|----------------|
| `worker-lifecycle.ts` | `buildVmSpec` and `buildProcessSpec` for worker VMs |

### Worker Config (packages/agent-vm-worker/src/config/)

| File | Responsibility |
|------|----------------|
| `worker-config.ts` | `workerConfigSchema` Zod schema, model alias resolution, config loading |
