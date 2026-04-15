# Controller-Side Git Push and PR Creation

## Problem

The worker VM currently handles git push and PR creation directly inside the sandbox. This requires injecting `GITHUB_TOKEN` into the VM as an environment variable, which:

- Exposes credentials inside the untrusted execution environment
- Gives the LLM agent direct access to push to any repo the token has access to
- Breaks the security model where the VM should only have access to LLM APIs via HTTP mediation

The controller runs on the host, outside the sandbox. It already has access to the cloned repos (mounted via VFS) and can hold credentials without exposing them to the VM.

## Design

Move git push and PR creation from the worker's wrapup phase to a controller-side operation. The worker requests the push via the internal controller HTTP channel (`controller.vm.host:18800`), and the controller executes it on the host.

### Flow

```
Worker (inside VM)                    Controller (host)
─────────────────                    ─────────────────
plan → work → verify → review
         │
         ▼
wrapup phase starts
  git-pr action fires
    │
    ├─ git add + commit (local, inside VM workspace)
    │
    ├─ POST controller.vm.host:18800
    │       /zones/:zone/tasks/:taskId/push-branches
    │   body: {
    │     branches: [{
    │       repoUrl: "github.com/org/repo",
    │       branchName: "agent/fix-123",
    │       baseBranch: "main",
    │       title: "Fix login bug",
    │       body: "..."
    │     }]
    │   }
    │                                  ├─ for each branch:
    │                                  │   git push from host workspace
    │                                  │   gh pr create (host has GITHUB_TOKEN)
    │                                  │
    │                                  ├─ return { results: [{
    │                                  │     repoUrl, branchName,
    │                                  │     prUrl, success
    │                                  │   }] }
    ◄──────────────────────────────────┘
    │
    ├─ record wrapup results
    │
wrapup complete
task-completed
```

### Key decisions

1. **Commits happen inside the VM.** The agent makes changes, stages, and commits in the VM workspace (`/workspace/<repo-name>/`). The commit is on the local branch in the VFS-mounted repo. The controller sees it on the host filesystem because `/workspace` is mounted via VFS from `taskRoot/workspace/`. The agent can commit at any time during any phase — this is unrestricted.

2. **Push and PR happen on the controller.** The controller reads the committed branch from the host-side workspace, pushes to the remote, and creates the PR using `gh`. `GITHUB_TOKEN` lives only on the host.

3. **Push is restricted to agent branches.** The controller validates that the branch name starts with the configured `branchPrefix` (default `agent/`). The agent cannot push to `main`, `master`, or any branch outside its prefix. This prevents accidental or malicious pushes to protected branches.

4. **The controller already knows the paths.** `preStartGateway` clones the repos and records their host-side paths in `preStartResult.repos[]`. Each entry has `{ repoUrl, baseBranch, workspacePath }` where `workspacePath` is the VM path (`/workspace/repo-name`), and the host path is `taskRoot/workspace/repo-name`. The controller maps between them — the worker doesn't need to send paths.

5. **Multiple repos supported.** The task input already supports `repos: []`. Each repo can have its own branch to push. The endpoint accepts an array of branches.

6. **The worker never sees GITHUB_TOKEN.** Remove it from zone secrets entirely. The controller resolves it separately — either from its own env or from 1Password, at the controller level (not per-zone).

### Clone configuration

The controller clones repos during `preStartGateway`. The clone behavior is configurable per-repo in the task input:

```typescript
repos: [
  {
    repoUrl: "https://github.com/org/repo",
    baseBranch: "main",
    branches: ["main", "develop"],  // or "all" for all branches
    depth: 10                        // shallow clone depth, default 10
  }
]
```

- **`branches`**: Which branches to fetch. Default is `[baseBranch]` (only the base branch). Set to `"all"` to fetch all remote branches. The agent can reference other branches for context (e.g., comparing against a feature branch).
- **`depth`**: Shallow clone depth. Default `10`. Keeps history small for large repos while providing enough context for diffs. Set to `0` for full clone.

The clone command becomes:
```
git clone --depth <depth> --branch <baseBranch> <repoUrl> <dir>
# Then for additional branches:
git fetch origin <branch>:<branch> --depth <depth>
```

Or with `branches: "all"`:
```
git clone --depth <depth> --no-single-branch <repoUrl> <dir>
```

### Controller endpoint

The controller already knows the repos and their host-side paths from `preStartGateway`. The worker only sends branch names and PR metadata.

```
POST /zones/:zoneId/tasks/:taskId/push-branches

Request:
{
  "branches": [
    {
      "repoUrl": "https://github.com/ShravanSunder/experiments-gh-cli-repo",
      "branchName": "agent/add-multiply",
      "title": "Add multiply function",
      "body": "Added multiply.js and multiply.test.js"
    }
  ]
}

Response:
{
  "results": [
    {
      "repoUrl": "https://github.com/ShravanSunder/experiments-gh-cli-repo",
      "branchName": "agent/add-multiply",
      "success": true,
      "prUrl": "https://github.com/ShravanSunder/experiments-gh-cli-repo/pull/42"
    }
  ]
}
```

The controller resolves `repoUrl` to the host-side workspace path via the task's `preStartResult.repos[]` mapping. It runs `git push` from that directory using `GITHUB_TOKEN` from its own environment. The `baseBranch` is already known from the task input — no need to repeat it.

### Worker-side git-pr action change

The `git-pr-action.ts` currently:
1. Configures git user
2. Creates branch
3. Stages and commits
4. Pushes branch (uses `GITHUB_TOKEN` from env)
5. Creates PR (uses `gh` with `GITHUB_TOKEN`)

After this change:
1. Configures git user
2. Creates branch
3. Stages and commits
4. Calls `POST controller.vm.host:18800/zones/:zone/tasks/:taskId/push-branches`
5. Controller handles push + PR creation
6. Returns PR URL

Steps 1-3 stay in the VM. Steps 4-5 move to the controller.

### GITHUB_TOKEN handling

Remove `GITHUB_TOKEN` from zone secrets. Add it as a controller-level credential:

```json
{
  "host": {
    "controllerPort": 18800,
    "projectNamespace": "...",
    "secretsProvider": { ... },
    "githubToken": {
      "source": "1password",
      "ref": "op://agent-vm/github-token/credential"
    }
  }
}
```

Or resolve it from the controller's own environment (`process.env.GITHUB_TOKEN`). The controller is trusted — it doesn't need sandbox isolation for its own credentials.

### What the worker needs to know

The worker needs:
- The controller URL (already available via `controller.vm.host:18800`)
- The zone ID (available from task config or environment)
- The task ID (available from task state)

It does NOT need:
- GITHUB_TOKEN
- Git remote access
- Network access to github.com (only to the controller)

### Allowed hosts change

With controller-side push, the worker zone's `allowedHosts` no longer needs `github.com` or `api.github.com`. The VM only talks to:
- `api.openai.com` (for Codex, via HTTP mediation)
- `controller.vm.host:18800` (internal, via tcpHosts)

This tightens the sandbox significantly.

## Files to Change

| File | Change |
|------|--------|
| `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts` | Add `POST /zones/:zoneId/tasks/:taskId/push-branches` endpoint |
| `packages/agent-vm/src/controller/http/controller-request-schemas.ts` | Add request/response schemas for push-branches |
| `packages/agent-vm/src/controller/worker-task-runner.ts` | Add `pushBranches` operation using host-side git + gh |
| `packages/agent-vm/src/controller/controller-runtime.ts` | Wire push-branches endpoint to worker task runner |
| `packages/agent-vm-worker/src/wrapup/git-pr-action.ts` | Replace direct push/PR with controller HTTP call |
| `packages/agent-vm-worker/src/git/git-operations.ts` | Remove `pushBranch` and `createPullRequest` (move to controller). Keep `configureGit`, `createBranch`, `stageAndCommit`. |
| `packages/agent-vm/src/config/system-config.ts` | Add optional `host.githubToken` as SecretRef |
| Config files | Remove GITHUB_TOKEN from zone secrets, add to host config |

**No changes to:** gondolin-core, gateway-interface, worker-gateway, openclaw-gateway.

## Testing

- Unit: push-branches endpoint validates request, calls git operations, returns results
- Unit: git-pr action calls controller instead of pushing directly
- Unit: controller pushes from host-side workspace path
- Integration: worker task completes with PR created via controller
- Security: verify GITHUB_TOKEN is not in VM environment (`env | grep GITHUB` returns nothing)

## Breaking Changes

Hard cutover.

1. `GITHUB_TOKEN` removed from zone secrets — configs must remove it
2. `host.githubToken` added — configs must add it if PR creation is needed
3. Worker `allowedHosts` can remove `github.com` and `api.github.com`
4. git-pr wrapup action now requires controller connectivity (already available via tcpHosts)
