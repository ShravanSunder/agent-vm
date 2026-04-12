# Controller Start Progress Indicators

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tasuku progress indicators to `agent-vm controller start` so users see what's happening during the 15-120s startup instead of a frozen terminal.

**Architecture:** The startup pipeline in `controller-runtime.ts` calls several async steps sequentially. Wrap each in a tasuku task. The `startControllerRuntime` function accepts an injectable `runTask` (same pattern as build-command.ts) so tests bypass terminal rendering.

**Tech Stack:** TypeScript, tasuku (already a dependency), Vitest

**Implementation repo:** `/Users/shravansunder/Documents/dev/project-dev/agent-vm/` (branch: `live-validation-2`)

---

## Why

`agent-vm controller start` is silent during a 15-120s startup. The user sees nothing and has no idea if it's working or stuck. The startup has distinct phases that each take measurable time:

1. Resolve secrets from 1Password (2-5s — network call to 1P)
2. Build gateway image if not cached (0.1s cached, 60-90s cold)
3. Boot gateway VM via QEMU (0.2s)
4. Configure gateway runtime — write env profile (0.1s)
5. Start OpenClaw inside VM (5-15s — loads plugins, channels)
6. Wait for gateway HTTP readiness (5-15s — polling loop)
7. Start controller HTTP API (0.1s)

Target output:
```
agent-vm controller start

  ✔ Resolving secrets                          (2.1s)
  ✔ Building gateway image                     (cached)
  ✔ Booting gateway VM                         (0.2s)
  ✔ Configuring gateway                        (0.1s)
  ✔ Starting OpenClaw                          (12.3s)
  ✔ Controller API on :18800

  Gateway: http://127.0.0.1:18791
  Zone: shravan
  VM: c7759241-...
```

---

## The Startup Call Chain

```
controller-operation-commands.ts  →  startControllerRuntime()
                                       ├── createSecretResolverFromSystemConfig()   ← step 1
                                       ├── startGatewayZone()                       ← steps 2-6
                                       │     ├── resolveZoneSecrets()
                                       │     ├── buildGatewayImage()                ← step 2
                                       │     ├── createGatewayVm()                  ← step 3
                                       │     ├── setupGatewayVmRuntime()            ← step 4
                                       │     └── startOpenClawInGateway()           ← steps 5-6
                                       └── startControllerHttpServer()              ← step 7
```

The progress needs to be added at the `startControllerRuntime` level since that's the orchestrator.

---

## File Structure

| File | Change |
|------|--------|
| Modify: `packages/agent-vm/src/controller/controller-runtime.ts` | Wrap startup steps in tasuku tasks |
| Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts` | Add `runTask` to dependencies |
| Modify: `packages/agent-vm/src/cli/controller-operation-commands.ts` | No change needed — delegates to startControllerRuntime |
| Test: existing `packages/agent-vm/src/controller/controller-runtime.test.ts` | Add `runTask` bypass to test deps |

---

## Task 1: Add tasuku progress to startControllerRuntime

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Add runTask to ControllerRuntimeDependencies**

In `packages/agent-vm/src/controller/controller-runtime-types.ts`, add to the dependencies interface:

```typescript
/** Override the task runner for testing (bypasses tasuku terminal rendering). */
readonly runTask?: (title: string, fn: () => Promise<void>) => Promise<void>;
```

- [ ] **Step 2: Import tasuku and wrap startup steps in controller-runtime.ts**

In `packages/agent-vm/src/controller/controller-runtime.ts`:

```typescript
import task from 'tasuku';

// Add default task runner (same pattern as build-command.ts)
async function defaultRunTask(title: string, fn: () => Promise<void>): Promise<void> {
  await task(title, async ({ startTime, setTitle }) => {
    startTime();
    await fn();
    setTitle(`${title} done`);
  });
}
```

Then wrap each major step in the `startControllerRuntime` function:

```typescript
export async function startControllerRuntime(
  options: StartControllerRuntimeOptions,
  dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
  const runTaskStep = dependencies.runTask ?? defaultRunTask;
  const now = dependencies.now ?? Date.now;

  let secretResolver!: SecretResolver;
  await runTaskStep('Resolving secrets', async () => {
    secretResolver = await createSecretResolverFromSystemConfig(
      options.systemConfig,
      dependencies.createSecretResolver ?? createSecretResolver,
    );
  });

  // ... lease manager, tcp pool, idle reaper setup (fast, no progress needed) ...

  let gateway!: Awaited<ReturnType<typeof startGatewayZone>>;
  await runTaskStep('Starting gateway zone', async () => {
    gateway = await (dependencies.startGatewayZone ?? startGatewayZone)({
      secretResolver,
      systemConfig: options.systemConfig,
      zoneId: options.zoneId,
    });
  });

  // ... controller app setup (fast) ...

  await runTaskStep(`Controller API on :${options.systemConfig.host.controllerPort}`, async () => {
    serverRef.current = await (dependencies.startHttpServer ?? startControllerHttpServer)({
      app: controllerApp,
      port: options.systemConfig.host.controllerPort,
    });
  });

  await idleReaper.reapExpiredLeases();

  return { ... };
}
```

**Key decision:** The gateway zone startup (buildImage + createVm + setupRuntime + startOpenClaw) is a single `startGatewayZone()` call. We have two options:

**Option A:** One task for the whole gateway startup — simple, shows "Starting gateway zone... (45s)"
**Option B:** Pass `runTask` into `startGatewayZone` and wrap each sub-step — shows individual progress

Start with **Option A**. If the gateway startup is still too opaque, break it down in a follow-up. The important thing is the user sees SOMETHING during the long wait.

- [ ] **Step 3: Add runTask bypass to all test fixtures**

In `packages/agent-vm/src/controller/controller-runtime.test.ts`, add to every test's dependencies:

```typescript
runTask: async (_title: string, fn: () => Promise<void>) => fn(),
```

This is the same pattern used in build-command tests.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime`
Expected: PASS

- [ ] **Step 5: Run full check**

Run: `pnpm check`
Expected: 0 errors

- [ ] **Step 6: Test live**

Run `agent-vm controller start` and verify spinner → checkmark output appears for each step.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/controller/
git commit -m "feat: add tasuku progress to controller start — no more frozen terminal"
```

---

## Task 2: Also check for cached images before start

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts` or `packages/agent-vm/src/cli/controller-operation-commands.ts`

If images aren't cached when `controller start` runs, the Gondolin build happens inline (60-90s with no output). Better UX: check before starting and suggest `agent-vm build` if the cache is cold.

- [ ] **Step 1: Add image cache check before starting**

In `controller-operation-commands.ts`, before calling `startControllerRuntime`:

```typescript
import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import fs from 'node:fs';
import path from 'node:path';

// Check if gateway image is cached
const gatewayFingerprint = await computeFingerprintFromConfigPath(
  systemConfig.images.gateway.buildConfig,
);
const gatewayCachePath = path.join(
  systemConfig.cacheDir, 'images', 'gateway', gatewayFingerprint,
);
if (!fs.existsSync(path.join(gatewayCachePath, 'manifest.json'))) {
  io.stderr.write(
    '[start] Gateway image not cached. Run `agent-vm build` first for faster startup.\n' +
    '[start] Building inline...\n',
  );
}
```

This doesn't block startup — just warns. The build still happens inline via `startGatewayZone → buildGatewayImage`. But the user knows why it's slow.

- [ ] **Step 2: Run tests + commit**

```bash
git add packages/agent-vm/src/cli/controller-operation-commands.ts
git commit -m "feat: warn if images not cached on controller start"
```

---

## Summary

| Task | What | Impact |
|------|------|--------|
| 1 | Tasuku progress on controller start | User sees what's happening during 15-120s startup |
| 2 | Cache check before start | User knows to run `agent-vm build` first |

After both tasks:
```bash
pnpm check
agent-vm build
agent-vm controller start  # should show progress steps
```
