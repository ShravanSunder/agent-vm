# Phase 5a: Full Folder Reorganization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `packages/agent-vm/src/` from a flat dump into responsibility-based modules. Split oversized files (378, 324, 317 lines) into focused units. No behavior changes — pure structural refactor.

**Architecture:** Move files into sub-folders by responsibility (cli, controller, gateway, snapshots, status). Split large files that do too much. Update all imports. Tests must still pass unchanged.

**Tech Stack:** TypeScript, pnpm workspaces

**IMPORTANT:** This is a pure refactor. No logic changes. Every test must pass before and after. If a test breaks, you moved something wrong.

---

## System Context

See `docs/superpowers/plans/2026-04-10-phase-5-review-fixes-tests-e2e.md` for full system architecture. In brief:

- **Controller** — HTTP API that manages gateway VMs and tool VM leases
- **Gateway** — Debian VM running OpenClaw with our sandbox plugin
- **CLI** — `agent-vm controller <subcommand>` entry point

The current structure dumps everything into `features/controller/` with 20+ files. The CLI is a 378-line switch statement. The gateway manager does 6 different things.

---

## Current → Target Structure

```
packages/agent-vm/src/
├── bin/
│   └── agent-vm.ts                    (378 lines — one giant switch)
├── features/
│   ├── controller/
│   │   ├── controller-client.ts
│   │   ├── controller-client.test.ts
│   │   ├── controller-runtime.ts      (317 lines — orchestrator + implementer)
│   │   ├── controller-runtime.test.ts
│   │   ├── controller-service.ts      (217 lines — all HTTP routes)
│   │   ├── controller-service.test.ts
│   │   ├── credential-manager.ts
│   │   ├── credentials-refresh.ts
│   │   ├── destroy.ts
│   │   ├── doctor.ts
│   │   ├── gateway-manager.ts         (324 lines — does everything)
│   │   ├── gateway-manager.test.ts
│   │   ├── idle-reaper.ts
│   │   ├── lease-manager.ts
│   │   ├── live-*.test.ts             (various)
│   │   ├── logs.ts
│   │   ├── production-config.test.ts
│   │   ├── snapshot-encryption.ts
│   │   ├── snapshot-manager.ts
│   │   ├── status.ts
│   │   ├── system-config.ts
│   │   ├── tcp-pool.ts
│   │   └── upgrade.ts
│   └── gateway-api-client/
│       ├── gateway-api-client.ts
│       └── gateway-websocket-client.ts
└── index.ts

BECOMES:

packages/agent-vm/src/
├── cli/
│   ├── agent-vm-entrypoint.ts          (main + arg parsing + routing)
│   ├── controller-operation-commands.ts (status, doctor, logs, destroy, upgrade, credentials)
│   ├── lease-commands.ts               (lease list, lease release)
│   ├── snapshot-commands.ts            (snapshot create/restore/list)
│   └── ssh-commands.ts                 (ssh-cmd)
├── controller/
│   ├── controller-runtime.ts           (orchestrator — ONLY wiring, no implementation)
│   ├── controller-runtime.test.ts
│   ├── controller-http-routes.ts       (Hono app creation, all route handlers)
│   ├── controller-http-routes.test.ts
│   ├── controller-client.ts            (HTTP client for calling running controller)
│   ├── controller-client.test.ts
│   ├── lease-manager.ts
│   ├── lease-manager.test.ts
│   ├── idle-reaper.ts
│   ├── idle-reaper.test.ts
│   ├── tcp-pool.ts
│   ├── tcp-pool.test.ts
│   └── system-config.ts
├── gateway/
│   ├── gateway-image-builder.ts        (image build + cache logic, extracted from gateway-manager)
│   ├── gateway-vm-setup.ts             (CA trust, /dev/fd, plugin copy, env profile, extracted from gateway-manager)
│   ├── gateway-openclaw-lifecycle.ts   (start OpenClaw, poll readiness, ingress config, extracted from gateway-manager)
│   ├── gateway-zone-orchestrator.ts    (startGatewayZone — wires the above three together)
│   ├── gateway-zone-orchestrator.test.ts
│   ├── credential-manager.ts
│   └── credential-manager.test.ts
├── tool-vm/
│   ├── tool-vm-lifecycle.ts            (create tool VM, user setup, workspace management, extracted from controller-runtime)
│   ├── tool-vm-lifecycle.test.ts
│   └── tool-vm-workspace-cleanup.ts    (clean workspace between sessions)
├── snapshots/
│   ├── snapshot-manager.ts
│   ├── snapshot-manager.test.ts
│   ├── snapshot-encryption.ts
│   └── snapshot-encryption.test.ts
├── operations/
│   ├── doctor.ts
│   ├── doctor.test.ts
│   ├── controller-status.ts
│   ├── controller-status.test.ts
│   ├── destroy-zone.ts
│   ├── destroy-zone.test.ts
│   ├── upgrade-zone.ts
│   ├── upgrade-zone.test.ts
│   ├── credentials-refresh.ts
│   ├── credentials-refresh.test.ts
│   └── zone-logs.ts
├── gateway-api-client/
│   ├── gateway-api-client.ts
│   ├── gateway-api-client.test.ts
│   ├── gateway-websocket-client.ts
│   └── gateway-websocket-client.test.ts
├── integration-tests/
│   ├── live-sandbox-e2e.integration.test.ts
│   ├── live-cross-vm-ssh.integration.test.ts
│   ├── live-api-smoke.test.ts
│   └── production-config.test.ts
└── index.ts
```

---

## Tasks

### Task 1: Create folder structure and move files (no splits yet)

Move files to their new locations. Update all imports. No file content changes.

**Moves:**

| From                                            | To                                                            |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `bin/agent-vm.ts`                               | `cli/agent-vm-entrypoint.ts`                                  |
| `features/controller/controller-runtime.ts`     | `controller/controller-runtime.ts`                            |
| `features/controller/controller-service.ts`     | `controller/controller-http-routes.ts`                        |
| `features/controller/controller-client.ts`      | `controller/controller-client.ts`                             |
| `features/controller/lease-manager.ts`          | `controller/lease-manager.ts`                                 |
| `features/controller/idle-reaper.ts`            | `controller/idle-reaper.ts`                                   |
| `features/controller/tcp-pool.ts`               | `controller/tcp-pool.ts`                                      |
| `features/controller/system-config.ts`          | `controller/system-config.ts`                                 |
| `features/controller/gateway-manager.ts`        | `gateway/gateway-zone-orchestrator.ts`                        |
| `features/controller/credential-manager.ts`     | `gateway/credential-manager.ts`                               |
| `features/controller/snapshot-manager.ts`       | `snapshots/snapshot-manager.ts`                               |
| `features/controller/snapshot-encryption.ts`    | `snapshots/snapshot-encryption.ts`                            |
| `features/controller/doctor.ts`                 | `operations/doctor.ts`                                        |
| `features/controller/status.ts`                 | `operations/controller-status.ts`                             |
| `features/controller/destroy.ts`                | `operations/destroy-zone.ts`                                  |
| `features/controller/upgrade.ts`                | `operations/upgrade-zone.ts`                                  |
| `features/controller/credentials-refresh.ts`    | `operations/credentials-refresh.ts`                           |
| `features/controller/logs.ts`                   | `operations/zone-logs.ts`                                     |
| `features/controller/live-sandbox-e2e.test.ts`  | `integration-tests/live-sandbox-e2e.integration.test.ts`      |
| `features/controller/live-cross-vm-ssh.test.ts` | `integration-tests/live-cross-vm-ssh.integration.test.ts`     |
| `features/controller/live-api-smoke.test.ts`    | `integration-tests/live-api-smoke.test.ts`                    |
| `features/controller/production-config.test.ts` | `integration-tests/production-config.test.ts`                 |
| `features/gateway-api-client/*`                 | `gateway-api-client/*` (same, just remove `features/` prefix) |

Move all corresponding `.test.ts` files alongside their source.

- [ ] **Step 1: Create target directories**

```bash
mkdir -p packages/agent-vm/src/{cli,controller,gateway,tool-vm,snapshots,operations,integration-tests,gateway-api-client}
```

- [ ] **Step 2: Move files with git mv**

Use `git mv` for each file to preserve history. Do NOT copy — move.

- [ ] **Step 3: Update all imports**

Search for every import path that references the old location and update. Key patterns:

- `../features/controller/` → `../controller/` or `../gateway/` etc.
- `../../agent-vm/src/features/controller/` → `../../agent-vm/src/controller/`
- `./controller-service.js` → `./controller-http-routes.js`

Check imports in:

- All moved files (internal imports)
- `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts` (cross-package import)
- `packages/agent-vm/src/index.ts`

- [ ] **Step 4: Update package.json bin entry**

```json
"bin": {
  "agent-vm": "./dist/cli/agent-vm-entrypoint.js"
}
```

- [ ] **Step 5: Update tsconfig paths if needed**

- [ ] **Step 6: Verify**

```bash
pnpm build
pnpm vitest run
```

Expected: All 109 tests pass, 0 build errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: reorganize agent-vm by responsibility — cli, controller, gateway, tool-vm, snapshots, operations"
```

---

### Task 2: Split agent-vm-entrypoint.ts (378 lines → ~5 focused files)

The CLI is one giant switch statement. Split each command group into its own file. The entrypoint only does argument parsing and routing.

- [ ] **Step 1: Extract controller-operation-commands.ts**

Move these cases from the switch: `status`, `stop`, `doctor`, `logs`, `destroy`, `upgrade`, `credentials refresh`.

Each becomes an exported async function:

```typescript
export async function runStatusCommand(systemConfig: SystemConfig, dependencies: CliDependencies, io: CliIo): Promise<void> { ... }
```

- [ ] **Step 2: Extract lease-commands.ts**

Move the `lease` case (list, release subcommands).

- [ ] **Step 3: Extract snapshot-commands.ts**

Move the `snapshot` case (create, restore, list subcommands).

- [ ] **Step 4: Extract ssh-commands.ts**

Move the `ssh-cmd` case.

- [ ] **Step 5: Slim down agent-vm-entrypoint.ts**

The entrypoint should:

1. Parse args (commandGroup, subcommand)
2. Load system config
3. Route to the correct command function
4. Handle errors

Target: < 80 lines.

- [ ] **Step 6: Verify**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 7: Commit**

---

### Task 3: Split gateway-zone-orchestrator.ts (324 lines → 3 focused files)

The gateway manager does image building, VM setup, OpenClaw lifecycle, and orchestration. Split by responsibility.

- [ ] **Step 1: Extract gateway-image-builder.ts**

Move: `loadJsonFile`, image build logic, `buildImage` call, `loadBuildConfig`.
Single function: `buildGatewayImage(options) → BuildImageResult`.

- [ ] **Step 2: Extract gateway-vm-setup.ts**

Move: `/dev/fd` symlink, CA trust update, env profile writing, plugin copy.
Single function: `setupGatewayVmRuntime(vm, options) → void`.

- [ ] **Step 3: Extract gateway-openclaw-lifecycle.ts**

Move: Start OpenClaw command, `waitForGatewayReadiness`, ingress route config, ingress enable.
Single function: `startOpenClawInGateway(vm, options) → { ingress }`.

- [ ] **Step 4: Slim down gateway-zone-orchestrator.ts**

Orchestrator calls: `findZone` → `resolveSecrets` → `buildImage` → `createVM` → `setupRuntime` → `startOpenClaw`.
Target: < 80 lines.

- [ ] **Step 5: Verify**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 6: Commit**

---

### Task 4: Extract tool-vm-lifecycle.ts from controller-runtime.ts

The `createManagedToolVm` closure in controller-runtime.ts creates tool VMs, sets up users, enables SSH, manages workspaces. Extract it.

- [ ] **Step 1: Create tool-vm-lifecycle.ts**

Export: `createToolVm(options) → ManagedVm` — builds image, creates VM, runs Debian setup, returns VM.
Export: `cleanToolVmWorkspace(workspaceDir) → void` — removes workspace contents between sessions.

- [ ] **Step 2: Slim down controller-runtime.ts**

The runtime should only wire: secret resolver → gateway zone → lease manager → idle reaper → HTTP server → close handler.
Target: < 150 lines.

- [ ] **Step 3: Verify**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 4: Commit**

---

### Task 5: Split sandbox-backend-factory.ts in openclaw-agent-vm-plugin (290 lines → focused files)

`packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.ts` mixes: factory + scope cache + manager + FS bridge builder + shell script helper. Split by responsibility.

**Current structure:**

```
packages/openclaw-agent-vm-plugin/src/
├── sandbox-backend-factory.ts          (290 lines — factory + cache + manager + FS bridge)
├── openclaw-plugin-registration.ts     (253 lines — SDK wiring + SSH helpers)
├── controller-lease-client.ts
├── gondolin-plugin-config.ts
└── index.ts
```

**Target structure:**

```
packages/openclaw-agent-vm-plugin/src/
├── sandbox-backend-factory.ts          (< 100 lines — factory only, creates handle)
├── sandbox-scope-cache.ts              (scope-based handle caching + invalidation)
├── sandbox-backend-manager.ts          (describeRuntime + removeRuntime)
├── sandbox-fs-bridge-builder.ts        (FS bridge construction from lease context)
├── openclaw-plugin-registration.ts     (SDK wiring — unchanged or slightly trimmed)
├── controller-lease-client.ts          (unchanged)
├── gondolin-plugin-config.ts           (unchanged)
└── index.ts
```

- [ ] **Step 1: Extract sandbox-scope-cache.ts**

Move the `CachedScopeEntry` type and the scope cache `Map` + lookup/store/invalidation logic into its own module. Export:

- `ScopeCache` type (the Map)
- `getCachedHandle(cache, scopeKey)` — returns cached handle or undefined
- `setCachedHandle(cache, scopeKey, entry)` — stores handle + leaseId
- `invalidateCachedHandle(cache, scopeKey)` — removes entry

- [ ] **Step 2: Extract sandbox-backend-manager.ts**

Move `createGondolinSandboxBackendManager` into its own file. It depends on the lease client — pass via options.

- [ ] **Step 3: Extract sandbox-fs-bridge-builder.ts**

Move `FsBridgeLeaseContext`, `GondolinFsBridge`, `buildShellScriptWithArgs`, and the `boundRunRemoteShellScript` + `createFsBridgeBuilder` logic.

- [ ] **Step 4: Slim down sandbox-backend-factory.ts**

The factory should: check cache → create lease → build handle → store in cache → return. No FS bridge or manager logic.
Target: < 100 lines.

- [ ] **Step 5: Update imports in openclaw-plugin-registration.ts and tests**

- [ ] **Step 6: Verify**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 7: Commit**

---

### Task 6: Verify rename controller-service.ts → controller-http-routes.ts

Already moved in Task 1. Verify the name is correct and all imports work. This is a no-op if Task 1 did it correctly.

---

### Task 7: Final verification

- [ ] **Step 1: Run full build and test suite**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 2: Verify no file > 200 lines**

```bash
find packages/agent-vm/src -name "*.ts" -not -name "*.test.ts" -not -name "*.d.ts" -exec wc -l {} + | sort -rn | head -10
```

No source file should exceed 200 lines (excluding tests).

- [ ] **Step 3: Verify folder structure matches target**

```bash
find packages/agent-vm/src -type d | sort
```

Should show: `cli/`, `controller/`, `gateway/`, `tool-vm/`, `snapshots/`, `operations/`, `gateway-api-client/`, `integration-tests/`.

- [ ] **Step 4: Update Phase 5 plan file paths**

After the reorg, `docs/superpowers/plans/2026-04-10-phase-5-review-fixes-tests-e2e.md` references old paths. Do a find-and-replace across the Phase 5 plan:

| Old path                                     | New path                                                   |
| -------------------------------------------- | ---------------------------------------------------------- |
| `features/controller/gateway-manager.ts`     | `gateway/gateway-zone-orchestrator.ts` (or the split file) |
| `features/controller/controller-runtime.ts`  | `controller/controller-runtime.ts`                         |
| `features/controller/controller-service.ts`  | `controller/controller-http-routes.ts`                     |
| `features/controller/lease-manager.ts`       | `controller/lease-manager.ts`                              |
| `features/controller/snapshot-encryption.ts` | `snapshots/snapshot-encryption.ts`                         |
| `features/controller/snapshot-manager.ts`    | `snapshots/snapshot-manager.ts`                            |
| `features/controller/doctor.ts`              | `operations/doctor.ts`                                     |
| `features/controller/tcp-pool.ts`            | `controller/tcp-pool.ts`                                   |
| `features/controller/idle-reaper.ts`         | `controller/idle-reaper.ts`                                |
| `features/controller/system-config.ts`       | `controller/system-config.ts`                              |
| `features/controller/credential-manager.ts`  | `gateway/credential-manager.ts`                            |
| `bin/agent-vm.ts`                            | `cli/agent-vm-entrypoint.ts`                               |

Also update the File Structure section at the top of the Phase 5 plan to match the new layout.

- [ ] **Step 5: Commit final state**

---

## Verification Criteria

1. `pnpm build` — exit 0
2. `pnpm vitest run` — all tests pass
3. No source file > 200 lines
4. Each folder has a clear single responsibility
5. `agent-vm-entrypoint.ts` is < 80 lines (routing only)
6. `gateway-zone-orchestrator.ts` is < 80 lines (orchestration only)
7. `controller-runtime.ts` is < 150 lines (wiring only)
8. `sandbox-backend-factory.ts` is < 100 lines (factory only)
9. All `git mv` used (history preserved)
10. Commits at each task checkpoint (not one giant commit)

## Dependency Note

This plan (5a) must complete BEFORE Phase 5 (review fixes). The review fixes plan references the OLD file paths — after this reorg, those paths change. Either: (a) run 5a first then update 5 paths, or (b) an agent doing Phase 5 should use the new paths from this plan.
