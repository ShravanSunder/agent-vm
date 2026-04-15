# Controller-Side Git Push and PR Creation

## Problem

The worker VM currently handles git push and PR creation directly inside the sandbox. This requires injecting `GITHUB_TOKEN` into the VM as an environment variable, which:

- Exposes credentials inside the untrusted execution environment
- Gives the LLM agent direct access to push to any repo the token has access to
- The `git push` command embeds the raw token in the URL (`x-access-token:TOKEN@github.com`), bypassing HTTP mediation

The controller runs on the host, outside the sandbox. It already has access to the cloned repos (mounted via VFS) and can hold credentials without exposing them to the VM.

## Design Decisions

These were discussed and decided. Not open for reinterpretation.

### 1. Active task registry on the controller

**Yes.** The controller needs an in-memory registry of active worker tasks to resolve host-side workspace paths when push-branches is called.

Minimal shape:
```typescript
interface ActiveWorkerTask {
  readonly taskId: string;
  readonly zoneId: string;
  readonly taskRoot: string;
  readonly repos: readonly {
    readonly repoUrl: string;
    readonly baseBranch: string;
    readonly hostWorkspacePath: string;
    readonly vmWorkspacePath: string;
  }[];
}
```

Populated by `preStartGateway`, cleared by `postStopGateway`. Only tracks the currently running task per zone (worker zones are single-task).

### 2. GitHub auth — config preferred, env fallback

`host.githubToken` in system-config as a `SecretRef` (same discriminated union as zone secrets — `1password` or `environment`). Resolved via the composite secret resolver. Falls back to `process.env.GITHUB_TOKEN` if `host.githubToken` is not configured.

```json
{
  "host": {
    "githubToken": {
      "source": "1password",
      "ref": "op://agent-vm/github-token/credential"
    }
  }
}
```

### 3. `gh` CLI on the host — hard cutover

The controller runs `gh pr create` with `GITHUB_TOKEN` in its env. No GitHub app/plugin routing. Simple.

### 4. Reject unknown repos — strictly

Only repos that were cloned for the active task (present in the task registry) are pushable. The endpoint validates `repoUrl` against the registry. No arbitrary host-side git execution.

### 5. Partial success — per-repo results

Response includes `results[]` with per-repo success/failure. The worker decides what to do with mixed results — if a required repo's push failed, the wrapup action marks as failed.

### 6. Keep github.com in allowed hosts

**Do NOT remove `github.com` or `api.github.com` from worker allowed hosts.** The agent should be able to use `gh` CLI inside the VM for investigation — `gh pr list`, `gh issue view`, reading PR comments, etc. These API calls go through Gondolin's HTTP mediation with `GITHUB_TOKEN`, which is fine.

What we're removing is `GITHUB_TOKEN` as a VM **environment variable**. The agent can still make GitHub API calls via HTTP mediation. It just can't `git push` (which embeds the raw token in the URL, bypassing mediation). Push goes through the controller.

## Architecture

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
    ├─ git config (safe.directory + user)
    ├─ git checkout -b agent/<taskId>
    ├─ git add -A && git commit
    │       (all local, inside VM workspace)
    │
    ├─ POST controller.vm.host:18800
    │       /zones/:zone/tasks/:taskId/push-branches
    │   body: {
    │     branches: [{
    │       repoUrl: "github.com/org/repo",
    │       branchName: "agent/fix-123",
    │       title: "Fix login bug",
    │       body: "PR description..."
    │     }]
    │   }
    │                                  ├─ validate branchName starts with branchPrefix
    │                                  ├─ validate repoUrl is in task registry
    │                                  ├─ resolve hostWorkspacePath from registry
    │                                  ├─ for each branch:
    │                                  │   git push from host workspace (GITHUB_TOKEN)
    │                                  │   gh pr create from host (GITHUB_TOKEN)
    │                                  │
    │                                  ├─ return { results: [{
    │                                  │     repoUrl, branchName,
    │                                  │     success, prUrl, error
    │                                  │   }] }
    ◄──────────────────────────────────┘
    │
    ├─ record wrapup results (per-repo success/failure)
    │
wrapup complete → task-completed (or task-failed if required push failed)
```

### What stays inside the VM

- `git config` — safe.directory, user.email, user.name
- `git checkout -b` — create agent branch
- `git add`, `git commit` — stage and commit changes
- `git diff`, `git log`, `git status` — read operations
- `gh pr list`, `gh issue view`, etc. — GitHub API reads via HTTP mediation
- The agent can commit at any time during any phase — unrestricted

### What moves to the controller

- `git push` — requires raw token in URL, can't be mediated
- `gh pr create` — controller creates PR from host, returns URL to worker

### What the worker never sees

- `GITHUB_TOKEN` as an environment variable
- Direct write access to remote git repos

## Clone Configuration

The controller clones repos during `preStartGateway`. Clone behavior is configurable per-repo in the task input:

```typescript
repos: [
  {
    repoUrl: "https://github.com/org/repo",
    baseBranch: "main",
    branches: ["main", "develop"],  // or "all" for all branches. default: [baseBranch]
    depth: 10                        // shallow clone depth. default: 10. 0 = full clone
  }
]
```

- **`branches`**: Which branches to fetch. Default `[baseBranch]`. Set to `"all"` to fetch all remote branches (useful when agent needs to compare branches).
- **`depth`**: Shallow clone depth. Default `10`. Enough for diff context. `0` for full clone.

Clone commands:
```bash
# Default: single branch, shallow
git clone --depth 10 --branch main <repoUrl> <dir>

# Additional branches
git fetch origin develop:develop --depth 10

# All branches
git clone --depth 10 --no-single-branch <repoUrl> <dir>
```

## Push Restrictions

The controller validates every push request:

1. **Branch prefix**: `branchName` must start with `branchPrefix` (default `agent/`). Reject pushes to `main`, `master`, or any branch outside the prefix.
2. **Known repo**: `repoUrl` must match a repo in the active task registry. No arbitrary repos.
3. **Active task**: `taskId` must be the currently active task for the zone. No pushing for completed/failed tasks.

## Controller Endpoint

```
POST /zones/:zoneId/tasks/:taskId/push-branches

Request:
{
  "branches": [
    {
      "repoUrl": "https://github.com/org/repo",
      "branchName": "agent/add-multiply",
      "title": "Add multiply function",
      "body": "Added multiply.js and multiply.test.js with full test coverage."
    }
  ]
}

Response:
{
  "results": [
    {
      "repoUrl": "https://github.com/org/repo",
      "branchName": "agent/add-multiply",
      "success": true,
      "prUrl": "https://github.com/org/repo/pull/42"
    }
  ]
}

Error response (per-repo):
{
  "results": [
    {
      "repoUrl": "https://github.com/org/repo",
      "branchName": "agent/add-multiply",
      "success": false,
      "error": "git push failed: remote rejected (protected branch)"
    }
  ]
}
```

Validation errors (bad branch prefix, unknown repo, inactive task) return 400 with an error message before attempting any push.

## Agent Instructions

Every worker task should include base instructions that the agent receives with every prompt. These are injected by the prompt assembler as a base layer, with phase-specific instructions layered on top.

### Default agent instructions (injected by prompt assembler):

```
## Git Rules
- You may commit at any time using git add and git commit.
- Always commit to a branch prefixed with "agent/" — never commit to main or master.
- Do NOT run git push. Push is handled by the system after wrapup.
- Do NOT modify or delete the .git directory.
- Use conventional commit messages: "feat:", "fix:", "refactor:", "test:", "docs:".

## Workspace Rules
- Work only inside the workspace directories provided in the task repos.
- Do not create files outside the workspace.
- Do not modify system files or configuration outside the workspace.

## Verification
- Run verification commands before requesting wrapup.
- If verification fails, fix the issue and re-verify.

## Wrapup
- When work is complete and verified, call the git-pr tool to stage, commit, and create a PR.
- The git-pr tool handles push and PR creation — you only need to provide the title and description.
```

These instructions should be:
- Defined as a constant in the prompt assembler module
- Overridable per-zone via worker config (`instructions` field at the top level)
- Included in every phase's prompt as a preamble

The prompt assembler already has per-phase `instructions` fields. The base instructions are a new addition — they apply to ALL phases.

## Worker-Side git-pr Action Change

Current `git-pr-action.ts`:
1. `configureGit` — safe.directory, user.email, user.name
2. `createBranch` — `git checkout -b agent/<taskId>`
3. `stageAndCommit` — `git add -A && git commit`
4. `pushBranch` — `git push` with token in URL ← **REMOVE**
5. `createPullRequest` — `gh pr create` ← **REMOVE**

After this change:
1. `configureGit` — same
2. `createBranch` — same
3. `stageAndCommit` — same
4. `POST controller.vm.host:18800/zones/:zone/tasks/:taskId/push-branches` ← **NEW**
5. Parse response, return PR URL or error

### git-operations.ts changes

Keep:
- `configureGit` (with safe.directory fix)
- `createBranch`
- `stageAndCommit`
- `sanitizeBranchName`
- `getDiff`, `getDiffStat`

Move to controller (new file `packages/agent-vm/src/controller/git-push-operations.ts`):
- `pushBranch` (uses GITHUB_TOKEN from host env)
- `createPullRequest` (uses `gh` on host)
- `buildPushUrl`
- `parseRepoFromUrl`

## GITHUB_TOKEN Handling

### Config

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

`host.githubToken` is optional. If absent, falls back to `process.env.GITHUB_TOKEN`. If neither is set, push-branches returns an error.

The `githubToken` field uses the same `SecretRef` discriminated union as zone secrets (`1password` | `environment`), resolved via the composite secret resolver.

### Zone secrets

Remove `GITHUB_TOKEN` from zone secrets. It should NOT be in `zone.secrets` at all — it's a controller-level credential, not a per-zone secret.

The init command's `defaultSecretsForGatewayType` for worker type should NOT scaffold `GITHUB_TOKEN`.

### HTTP mediation for GitHub API

The agent can still make GitHub API calls (read PRs, issues, etc.) via HTTP mediation. To enable this, add a zone secret for GitHub API access:

```json
"secrets": {
  "GITHUB_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/github-token/credential",
    "hosts": ["api.github.com"],
    "injection": "http-mediation"
  }
}
```

This gives the agent read/write access to the GitHub API without exposing the raw token. The agent can run `gh pr list`, `gh issue view`, etc. — the HTTP mediation proxy injects the token into API requests.

`git push` doesn't go through HTTP mediation (it uses the token in the URL), so the agent can't push even with this secret configured. Push is controller-only.

## Files to Change

| File | Change |
|------|--------|
| **Controller-side (agent-vm package):** | |
| `packages/agent-vm/src/controller/active-task-registry.ts` | **New.** In-memory registry of active worker tasks with host paths. |
| `packages/agent-vm/src/controller/git-push-operations.ts` | **New.** `pushBranch` and `createPullRequest` moved from worker, uses host-side GITHUB_TOKEN. |
| `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts` | Add `POST /zones/:zoneId/tasks/:taskId/push-branches` endpoint. |
| `packages/agent-vm/src/controller/http/controller-request-schemas.ts` | Add Zod schemas for push-branches request/response. |
| `packages/agent-vm/src/controller/worker-task-runner.ts` | Register task in registry during `preStartGateway`, clear in `postStopGateway`. Pass registry to push endpoint. |
| `packages/agent-vm/src/controller/controller-runtime.ts` | Wire push-branches endpoint, create registry, resolve githubToken. |
| `packages/agent-vm/src/config/system-config.ts` | Add optional `host.githubToken` as `SecretRef`. |
| `packages/agent-vm/src/cli/init-command.ts` | Remove GITHUB_TOKEN from worker zone secrets scaffold. Add `host.githubToken` scaffold. |
| **Worker-side (agent-vm-worker package):** | |
| `packages/agent-vm-worker/src/wrapup/git-pr-action.ts` | Replace `pushBranch` + `createPullRequest` with HTTP call to controller. |
| `packages/agent-vm-worker/src/git/git-operations.ts` | Remove `pushBranch`, `createPullRequest`, `buildPushUrl`. Keep local git operations. |
| `packages/agent-vm-worker/src/prompt/prompt-assembler.ts` | Add base agent instructions as default preamble for all phases. |
| `packages/agent-vm-worker/src/config/worker-config.ts` | Add optional top-level `instructions` field for base instruction override. |

**No changes to:** gondolin-core, gateway-interface, worker-gateway, openclaw-gateway.

## Testing

- Unit: `active-task-registry` — register, lookup, clear, reject unknown
- Unit: push-branches endpoint — validates branch prefix, rejects unknown repos, rejects inactive tasks
- Unit: push-branches — calls git push + gh pr create from host workspace path
- Unit: git-pr action — calls controller HTTP endpoint instead of pushing directly
- Unit: prompt assembler — includes base instructions in every phase prompt
- Unit: partial success — one repo push succeeds, another fails, returns mixed results
- Integration: worker task completes with PR created via controller push-branches
- Security: verify GITHUB_TOKEN is not in VM environment (`env | grep GITHUB` returns nothing inside VM)
- Security: verify push to `main` is rejected by controller

## Breaking Changes

Hard cutover. No backward compatibility.

1. `GITHUB_TOKEN` as env-injected zone secret no longer works for push — must use controller-side push
2. `host.githubToken` added to system config — required for PR creation
3. `git-pr` wrapup action now calls controller endpoint instead of pushing directly
4. Worker `git-operations.ts` no longer exports `pushBranch` or `createPullRequest`
5. Base agent instructions added to all phase prompts

## Implementation Notes for Other Agent

### Critical context

- The `git config` `safe.directory` fix is already committed — VFS-mounted repos are owned by host uid 501 but the VM runs as root. Without `safe.directory`, git refuses to operate. This is in `git-operations.ts:configureGit`.
- The tarball approach (`AGENT_VM_WORKER_TARBALL_PATH`) lets you test local worker changes without publishing to npm. The controller copies the tarball into the task state dir, the VM bootstrap installs it.
- The tcpHostsOverride bug (docker service routes not merged into VM spec) needs fixing in the same PR. See `startGatewayZone` — it accepts `options.tcpHostsOverride` but never passes it to `createManagedVm`.
- The `deriveRepoDirectoryName` collision path uses raw basename instead of sanitized — small bug, fix alongside.

### E2E validation results

The full worker pipeline runs successfully:
- Plan → Plan review (approved) → Work → Verification (passed) → Work review (approved) → Wrapup
- The only failure is git push (403 because no GITHUB_TOKEN in VM)
- Agent successfully creates branches, commits code, passes tests
- This spec's implementation is the final piece to complete the pipeline
