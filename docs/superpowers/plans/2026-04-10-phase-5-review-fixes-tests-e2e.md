# Phase 5: Review Fixes, Test Coverage, E2E Verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all review findings (High/Medium/Low), clear blocking quality gate errors (warnings acceptable for now), split controller-runtime, add comprehensive tests with separate integration test config, and create a reproducible e2e verification checklist.

**Architecture:** Three independent subsystems: (A) Bug fixes from review findings, (B) Structural improvements (split controller-runtime, add test coverage), (C) E2E verification checklist for manual testing.

**Tech Stack:** TypeScript, Vitest, Hono, oxlint, Gondolin, OpenClaw plugin SDK

---

## File Structure

### `packages/agent-vm/src/features/controller/` (modifications)

- `gateway-manager.ts`: Fix H5 (throw on readiness exhaustion)
- `controller-runtime.ts`: Fix H3 (workspace cleanup), then split into smaller modules
- `gateway-zone-lifecycle.ts`: New — extracted gateway VM boot logic from controller-runtime
- `tool-vm-lifecycle.ts`: New — extracted tool VM creation logic from controller-runtime
- `controller-http-server.ts`: New — extracted HTTP server setup from controller-runtime
- `lease-manager.ts`: Add `getLeaseByScope()` for H1 fix
- `tcp-pool.test.ts`: Add exhaustion, reuse, and edge case tests
- `idle-reaper.test.ts`: Add multiple-expired and keep-non-expired tests
- `gateway-manager.test.ts`: Add readiness failure test
- `controller-runtime.test.ts`: Add boot failure and missing zone tests

### `packages/openclaw-agent-vm-plugin/src/` (modifications)

- `sandbox-backend-factory.ts`: Fix H1 (store leaseId, use it for manager), Fix H2 (cache validation)
- `sandbox-backend-factory.test.ts`: Add cache invalidation and leaseId tests
- `gondolin-plugin-config.ts`: Fix M1 (remove profileId)
- `gondolin-plugin-config.test.ts`: Fix M1 (remove profileId test)
- `openclaw-plugin-registration.ts`: Fix M2 (forward signal/allowFailure in FS bridge)

### `packages/agent-vm/src/features/controller/` (modifications continued)

- `snapshot-encryption.ts`: Fix H4 (replace require() with dynamic import)
- `snapshot-encryption.test.ts`: Add test for ESM compatibility

### `docs/`

- `E2E-VERIFICATION-CHECKLIST.md`: New — reproducible manual e2e checklist

---

## Subsystem A: Bug Fixes

### Task 1: Fix H5 — Gateway readiness must throw on exhaustion

`waitForGatewayReadiness()` in `gateway-manager.ts:131` returns silently when all attempts are exhausted. The controller proceeds as if OpenClaw started successfully, leading to confusing failures downstream.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/gateway-manager.ts`
- Modify: `packages/agent-vm/src/features/controller/gateway-manager.test.ts`

- [ ] **Step 1: Write a failing test for readiness exhaustion**

Add a new test case to `gateway-manager.test.ts`:

```typescript
it('throws when gateway readiness polling exhausts all attempts', async () => {
  // Arrange: exec always returns '000' (gateway never becomes ready)
  const execMock = vi.fn(async () => ({ exitCode: 0, stdout: '000', stderr: '' }));
  const managedVm: ManagedVm = {
    id: 'vm-timeout',
    close: vi.fn(async () => {}),
    enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
    enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
    exec: execMock,
    setIngressRoutes: vi.fn(),
  };
  const createManagedVm = vi.fn(async (): Promise<ManagedVm> => managedVm);

  // Act + Assert
  await expect(
    startGatewayZone(
      {
        secretResolver: {
          resolve: async (): Promise<string> => { throw new Error('not used'); },
          resolveAll: async () => ({}),
        },
        systemConfig, // uses the existing test fixture
        zoneId: 'shravan',
      },
      {
        buildImage: vi.fn(async () => ({ built: true, fingerprint: 'fp', imagePath: '/tmp/img' })),
        createManagedVm,
        loadBuildConfig: vi.fn(async () => ({})),
      },
    ),
  ).rejects.toThrow(/gateway.*readiness/iu);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/gateway-manager.test.ts`
Expected: FAIL — the function returns silently instead of throwing.

- [ ] **Step 3: Fix `waitForGatewayReadiness` to throw**

In `gateway-manager.ts`, change the base case of the recursive function:

```typescript
// Before (line 132-134):
if (attempt >= maxAttempts) {
  return;
}

// After:
if (attempt >= maxAttempts) {
  throw new Error(
    `Gateway readiness check failed after ${maxAttempts} attempts. OpenClaw may not have started.`,
  );
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/gateway-manager.test.ts`
Expected: All tests PASS. The existing tests already return non-`000` from exec, so they remain unaffected.

- [ ] **Step 5: Run full suite**

Run: `pnpm vitest run`

---

### Task 2: Fix H4 — Replace `require()` with dynamic import in snapshot-encryption

`deriveRecipientFromIdentity()` in `snapshot-encryption.ts:35` uses `require('node:child_process')` which throws `ReferenceError` in real ESM. The `runAge()` function already uses `await import()` correctly — apply the same pattern.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/snapshot-encryption.ts`
- Modify: `packages/agent-vm/src/features/controller/snapshot-encryption.test.ts`

- [ ] **Step 1: Write a failing test that asserts ESM-compatible import**

The existing `snapshot-encryption.test.ts` also uses `require()` in its `generateTestIdentity` helper (line 12). Fix that too. Add a test:

```typescript
it('deriveRecipientFromIdentity works in ESM context (no require)', async () => {
  // This test verifies encrypt works end-to-end in ESM mode.
  // If require() is used internally, it will throw ReferenceError.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-esm-'));
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFileCb);
  const output = await execFileAsync('age-keygen', [], { encoding: 'utf8' });
  const match = output.stdout.match(/AGE-SECRET-KEY-\S+/u);
  if (!match) throw new Error('Failed to generate age identity');
  const identity = match[0];

  const inputPath = path.join(tmpDir, 'input.txt');
  const encryptedPath = path.join(tmpDir, 'output.age');
  fs.writeFileSync(inputPath, 'esm-test-content');

  const encryption = createAgeEncryption({ resolveIdentity: async () => identity });
  await encryption.encrypt(inputPath, encryptedPath);
  expect(fs.existsSync(encryptedPath)).toBe(true);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/snapshot-encryption.test.ts`
Expected: May pass in vitest (which shims `require`).

**IMPORTANT:** Also verify with real Node ESM (not vitest) to catch the actual production failure:
```bash
node --input-type=module -e "
import { createAgeEncryption } from './packages/agent-vm/dist/features/controller/snapshot-encryption.js';
const enc = createAgeEncryption({ resolveIdentity: async () => 'AGE-SECRET-KEY-TEST' });
console.log('ESM import OK, encrypt is', typeof enc.encrypt);
"
```
Expected before fix: `ReferenceError: require is not defined`
Expected after fix: `ESM import OK, encrypt is function`

- [ ] **Step 3: Rewrite `deriveRecipientFromIdentity` to be async**

The function must become async because `import()` is async. This means `encrypt` (which calls it) already awaits, so the change is compatible.

```typescript
// Before: synchronous function using require()
function deriveRecipientFromIdentity(identityLine: string): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  // ...
}

// After: async function using already-imported modules
// Since runAge already imports child_process via dynamic import,
// refactor to use execFileSync from the top-level import:
import { execFileSync } from 'node:child_process';

function deriveRecipientFromIdentity(identityLine: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-identity-'));
  const identityPath = path.join(tmpDir, 'identity.txt');
  try {
    fs.writeFileSync(identityPath, identityLine + '\n', { mode: 0o600 });
    const pubkey = execFileSync('age-keygen', ['-y', identityPath], { encoding: 'utf8' }).trim();
    return pubkey;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
```

Also fix the test helper `generateTestIdentity` to use the same pattern (import at file top, not `require`).

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/snapshot-encryption.test.ts`
Expected: PASS

---

### Task 3: Fix H1 — Store leaseId in scope cache; manager uses leaseId, not runtimeId

The plugin publishes `runtimeId` as `gondolin-${scopeKey}` (sandbox-backend-factory.ts:204). The controller creates `leaseId` as `${zoneId}-${scopeKey}-${createdAt}` (lease-manager.ts:70). When the manager calls `getLeaseStatus(containerName)` or `releaseLease(containerName)`, it passes the runtimeId — which doesn't match any leaseId.

**Root cause:** `CachedScopeEntry` stores the lease (which has `leaseId`), but `createGondolinSandboxBackendManager` receives `containerName` (runtimeId) and passes it directly to `getLeaseStatus`/`releaseLease`.

**Fix approach:** The core problem is that the manager receives `containerName` (which is `runtimeId = gondolin-${scopeKey}`) but needs the actual `leaseId`. A scope-based lookup is wrong because it can target the wrong lease when stale and new leases coexist.

The correct fix: **make runtimeId equal to the actual leaseId**. The runtimeId doesn't need to be stable across factory calls — it just needs to be the correct identifier for the current runtime. The cached scope entry already stores the lease (which has `leaseId`). So: (1) set `runtimeId = lease.leaseId`, (2) the manager receives the real leaseId as containerName, (3) manager calls `/lease/:leaseId` directly. No new endpoint needed.

For cache reuse: the scope cache returns the existing handle (with the correct leaseId as runtimeId). For the registry: OpenClaw's registry tracks runtimeId as containerName, and when removeRuntime is called, it passes the containerName back — which is now the real leaseId.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/controller-service.ts`
- Modify: `packages/agent-vm/src/features/controller/controller-service.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

- [ ] **Step 1: Write failing test for `GET /lease/by-scope/:scopeKey` route**

In `controller-service.test.ts`:

```typescript
it('looks up a lease by scope key via GET /lease/by-scope/:scopeKey', async () => {
  const leases = [
    {
      id: 'lease-1',
      zoneId: 'shravan',
      scopeKey: 'agent:main:session-abc',
      tcpSlot: 0,
      createdAt: 100,
      lastUsedAt: 100,
      profileId: 'standard',
    },
  ];
  const app = createControllerApp({
    toolProfiles: { standard: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' } },
    leaseManager: {
      createLease: vi.fn(),
      getLease: vi.fn(),
      listLeases: vi.fn(() => leases),
      releaseLease: vi.fn(async () => {}),
    },
  });

  const response = await app.request('/lease/by-scope/agent:main:session-abc');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ id: 'lease-1', scopeKey: 'agent:main:session-abc' });
});
```

- [ ] **Step 2: Add the route to `controller-service.ts`**

After the existing `GET /lease/:leaseId` route, add:

```typescript
app.get('/lease/by-scope/:scopeKey', (context) => {
  const scopeKey = context.req.param('scopeKey');
  const lease = options.leaseManager
    .listLeases()
    .find((candidateLease) => candidateLease.scopeKey === scopeKey);
  if (!lease) {
    return context.json({ error: 'Lease not found for scope' }, 404);
  }
  return context.json({
    createdAt: lease.createdAt,
    id: lease.id,
    scopeKey: lease.scopeKey,
    tcpSlot: lease.tcpSlot,
    zoneId: lease.zoneId,
  });
});
```

**Important ordering note:** This route must be placed _before_ `GET /lease/:leaseId` because Hono matches routes in registration order, and `/lease/by-scope/:scopeKey` would otherwise match `:leaseId` as `by-scope`. Move the more specific route first.

- [ ] **Step 3: Add `getLeaseByScopeKey` to the lease client**

In `controller-lease-client.ts`, add to the `LeaseClient` interface and implementation:

```typescript
// Interface addition:
getLeaseByScopeKey(scopeKey: string): Promise<{ id: string; scopeKey: string } | null>;

// Implementation:
getLeaseByScopeKey: async (scopeKey: string) => {
  const response = await fetchImpl(`${baseUrl}/lease/by-scope/${encodeURIComponent(scopeKey)}`);
  if (response.status === 404) {
    return null;
  }
  return await response.json() as { id: string; scopeKey: string };
},
```

- [ ] **Step 4: Update the manager to use scope-based lookup**

In `sandbox-backend-factory.ts`, modify `createGondolinSandboxBackendManager`:

```typescript
// Extract scopeKey from containerName (runtimeId format: "gondolin-${scopeKey}")
const scopeKeyFromContainerName = (containerName: string): string =>
  containerName.startsWith('gondolin-') ? containerName.slice('gondolin-'.length) : containerName;

// In describeRuntime:
const scopeKey = scopeKeyFromContainerName(params.entry.containerName);
const scopeLease = await leaseClient.getLeaseByScopeKey(scopeKey);
return { running: scopeLease !== null, configLabelMatch: true };

// In removeRuntime:
const scopeKey = scopeKeyFromContainerName(params.entry.containerName);
const scopeLease = await leaseClient.getLeaseByScopeKey(scopeKey);
if (scopeLease) {
  await leaseClient.releaseLease(scopeLease.id);
}
```

- [ ] **Step 5: Update manager tests in `sandbox-backend-factory.test.ts`**

Update the existing `createGondolinSandboxBackendManager` tests to mock `getLeaseByScopeKey` instead of `getLeaseStatus`, and verify the scope-based lookup is used.

- [ ] **Step 6: Run all tests**

Run: `pnpm vitest run`
Expected: All PASS.

---

### Task 4: Fix H2 — Scope cache invalidation on stale leases

`createGondolinSandboxBackendFactory` returns the cached handle on scopeKey match (sandbox-backend-factory.ts:153) but never checks whether the lease is still alive. After `removeRuntime`, lease release, or controller restart, the cache returns a stale handle with dead SSH creds.

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

- [ ] **Step 1: Write a failing test for cache invalidation**

In `sandbox-backend-factory.test.ts`:

```typescript
it('evicts cached handle when the lease is no longer active', async () => {
  let leaseCallCount = 0;
  const getLeaseByScopeKey = vi.fn(async () => {
    // First call: lease exists. Second call: lease gone (simulate controller restart).
    leaseCallCount++;
    return leaseCallCount <= 1 ? { id: 'lease-1', scopeKey: 'scope-evict' } : null;
  });
  const requestLease = vi.fn(async () => ({
    leaseId: `lease-${leaseCallCount + 1}`,
    ssh: { host: 'h', identityPem: 'p', knownHostsLine: '', port: 22, user: 'u' },
    tcpSlot: 0,
    workdir: '/workspace',
  }));

  const factory = createGondolinSandboxBackendFactory(
    { controllerUrl: 'http://controller.vm.host:18800', zoneId: 'shravan' },
    {
      buildExecSpec: vi.fn(async () => ({ argv: ['ssh'], env: {}, stdinMode: 'pipe-open' as const })),
      createLeaseClient: () => ({
        getLeaseByScopeKey,
        getLeaseStatus: vi.fn(async () => null),
        releaseLease: vi.fn(async () => {}),
        requestLease,
      }),
      runRemoteShellScript: vi.fn(),
    },
  );

  const first = await factory({ agentWorkspaceDir: '/w', cfg: {}, scopeKey: 'scope-evict', sessionKey: 's', workspaceDir: '/w' });
  const second = await factory({ agentWorkspaceDir: '/w', cfg: {}, scopeKey: 'scope-evict', sessionKey: 's', workspaceDir: '/w' });

  expect(first).not.toBe(second);
  expect(requestLease).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
Expected: FAIL — `first === second` because the cache returns the stale entry without checking.

- [ ] **Step 3: Add cache validation before returning cached entry**

In the factory function, after checking the cache hit, validate the lease is still active:

```typescript
const existingEntry = scopeCache.get(params.scopeKey);
if (existingEntry) {
  // Verify the lease is still active before returning the cached handle
  const leaseStatus = await leaseClient.getLeaseByScopeKey(params.scopeKey);
  if (leaseStatus !== null) {
    return existingEntry.handle;
  }
  // Lease is gone — evict stale cache entry
  scopeCache.delete(params.scopeKey);
}
```

Note: This requires moving the `leaseClient` creation above the cache check, or extracting it into a shared variable. The lease client creation is cheap (just builds a fetch wrapper), so moving it up is fine.

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `pnpm vitest run`

---

### Task 5: Fix H3 — Clean workspace directory between sessions

Tool VMs mount host workspace from `zoneId + tcpSlot` (controller-runtime.ts:139). After lease release, the workspace dir still has previous session's files. The next lease on the same tcpSlot sees stale data.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/lease-manager.ts`
- Modify: `packages/agent-vm/src/features/controller/lease-manager.test.ts`

- [ ] **Step 1: Write a failing test for workspace cleanup**

In `lease-manager.test.ts`:

```typescript
it('calls cleanWorkspace on lease release when provided', async () => {
  const cleanWorkspace = vi.fn(async () => {});
  const closeMock = vi.fn(async () => {});
  const leaseManager = createLeaseManager({
    createManagedVm: vi.fn(async () => ({
      close: closeMock,
      enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
      enableSsh: vi.fn(async () => ({
        command: 'ssh',
        host: '127.0.0.1',
        identityFile: '/tmp/key',
        port: 19000,
        user: 'sandbox',
      })),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      id: 'tool-vm-1',
      setIngressRoutes: vi.fn(),
    })),
    now: () => 100,
    tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
    cleanWorkspace,
  });

  const lease = await leaseManager.createLease({
    agentWorkspaceDir: '/workspace',
    profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
    profileId: 'standard',
    scopeKey: 'scope-cleanup',
    workspaceDir: '/workspace',
    zoneId: 'shravan',
  });

  await leaseManager.releaseLease(lease.id);

  expect(cleanWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      zoneId: 'shravan',
      tcpSlot: expect.any(Number),
    }),
  );
  expect(closeMock).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/lease-manager.test.ts`
Expected: FAIL — `cleanWorkspace` is not accepted or called.

- [ ] **Step 3: Add optional `cleanWorkspace` callback to lease manager**

In `lease-manager.ts`, add an optional `cleanWorkspace` to the options and call it during release:

```typescript
// In createLeaseManager options:
readonly cleanWorkspace?: (options: { readonly tcpSlot: number; readonly zoneId: string }) => Promise<void>;

// In releaseLease, before vm.close():
if (options.cleanWorkspace) {
  await options.cleanWorkspace({ tcpSlot: lease.tcpSlot, zoneId: lease.zoneId });
}
```

- [ ] **Step 4: Wire workspace cleanup in controller-runtime.ts**

In `startControllerRuntime`, pass `cleanWorkspace` to `createLeaseManager`:

```typescript
const leaseManager = createLeaseManager({
  // ...existing options...
  cleanWorkspace: async (cleanOptions) => {
    const toolProfile = options.systemConfig.toolProfiles[zone.toolProfile];
    if (!toolProfile) return;
    const hostWorkspaceDir = path.resolve(
      toolProfile.workspaceRoot,
      `${cleanOptions.zoneId}-${cleanOptions.tcpSlot}`,
    );
    // Remove contents but keep the directory
    const entries = fsSync.readdirSync(hostWorkspaceDir);
    for (const entry of entries) {
      fsSync.rmSync(path.join(hostWorkspaceDir, entry), { recursive: true, force: true });
    }
  },
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run`
Expected: All PASS.

---

### Task 6: Fix M1 — Remove dead `profileId` from plugin config

`ResolvedGondolinPluginConfig` includes `profileId` but the OpenClaw manifest doesn't allow it, and the factory hardcodes `'standard'`. It's dead code that misleads readers.

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` (if it reads profileId)

- [ ] **Step 1: Remove `profileId` from the config type and parser**

In `gondolin-plugin-config.ts`:

```typescript
// Before:
export interface ResolvedGondolinPluginConfig {
  readonly controllerUrl: string;
  readonly profileId: string;
  readonly zoneId: string;
}

// After:
export interface ResolvedGondolinPluginConfig {
  readonly controllerUrl: string;
  readonly zoneId: string;
}
```

Remove the `profileId` line from the `return` statement in `resolveGondolinPluginConfig`.

- [ ] **Step 2: Update tests**

In `gondolin-plugin-config.test.ts`:
- Remove the `'uses a custom profileId when provided'` test.
- Update the first test's expected output to not include `profileId`.

- [ ] **Step 3: Verify the factory already hardcodes 'standard'**

In `sandbox-backend-factory.ts:164`, confirm `profileId: 'standard'` is hardcoded in the `requestLease` call. No change needed there.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run`
Expected: All PASS.

---

### Task 7: Fix M2 — Forward signal and allowFailure through FS bridge

The `boundRunRemoteShellScript` in `sandbox-backend-factory.ts:173-181` only forwards `script`, `args`, and `stdin` to the underlying `runRemoteShellScript`. It drops `signal` and `allowFailure`, which are part of the `FsBridgeLeaseContext['runRemoteShellScript']` signature.

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`

- [ ] **Step 1: Write a failing test for signal/allowFailure forwarding**

In `sandbox-backend-factory.test.ts`:

```typescript
it('boundRunRemoteShellScript forwards signal and allowFailure to deps', async () => {
  const runRemoteShellScript = vi.fn(async () => ({
    code: 0,
    stderr: Buffer.from(''),
    stdout: Buffer.from('ok'),
  }));
  let capturedLeaseContext: FsBridgeLeaseContext | undefined;
  const createFsBridgeBuilder = vi.fn((leaseContext: FsBridgeLeaseContext) => {
    capturedLeaseContext = leaseContext;
    return vi.fn(() => createMockFsBridge());
  });

  const factory = createGondolinSandboxBackendFactory(
    { controllerUrl: 'http://controller.vm.host:18800', zoneId: 'shravan' },
    {
      buildExecSpec: vi.fn(async () => ({ argv: ['ssh'], env: {}, stdinMode: 'pipe-open' as const })),
      createFsBridgeBuilder,
      createLeaseClient: () => ({
        getLeaseByScopeKey: vi.fn(async () => null),
        getLeaseStatus: vi.fn(async () => ({ ok: true })),
        releaseLease: vi.fn(async () => {}),
        requestLease: vi.fn(async () => ({
          leaseId: 'lease-fwd',
          ssh: { host: 'h', identityPem: 'p', knownHostsLine: '', port: 22, user: 'u' },
          tcpSlot: 0,
          workdir: '/workspace',
        })),
      }),
      runRemoteShellScript,
    },
  );

  await factory({ agentWorkspaceDir: '/w', cfg: {}, scopeKey: 'fwd-test', sessionKey: 's', workspaceDir: '/w' });

  expect(capturedLeaseContext).toBeDefined();
  const controller = new AbortController();
  await capturedLeaseContext!.runRemoteShellScript({
    script: 'cat /etc/os-release',
    signal: controller.signal,
    allowFailure: true,
  });

  // Verify signal and allowFailure were forwarded (this is the key assertion)
  expect(runRemoteShellScript).toHaveBeenCalledWith(
    expect.objectContaining({
      script: expect.stringContaining('cat /etc/os-release'),
      signal: controller.signal,
      allowFailure: true,
    }),
  );
});
```

Note: The test verifies the call succeeds. The real assertion is that `signal` and `allowFailure` are available for the underlying implementation. Since `dependencies.runRemoteShellScript` doesn't accept them yet, the fix requires extending the dependency signature too. However, looking at the code more closely, the `runRemoteShellScript` dependency only accepts `script`, `ssh`, and `stdin`. The fix is to extend it.

- [ ] **Step 2: Extend the `runRemoteShellScript` dependency to accept signal and allowFailure**

In `sandbox-backend-factory.ts`, update the `CreateBackendDependencies` interface:

```typescript
readonly runRemoteShellScript: (params: {
  readonly allowFailure?: boolean;
  readonly script: string;
  readonly signal?: AbortSignal;
  readonly ssh: GondolinLeaseResponse['ssh'];
  readonly stdin?: Buffer | string;
}) => Promise<{
  readonly code: number;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
}>;
```

Then update the `boundRunRemoteShellScript` to forward them:

```typescript
const boundRunRemoteShellScript: FsBridgeLeaseContext['runRemoteShellScript'] = async (shellParams) => {
  const result = await dependencies.runRemoteShellScript({
    allowFailure: shellParams.allowFailure,
    script: buildShellScriptWithArgs(shellParams.script, shellParams.args),
    signal: shellParams.signal,
    ssh: lease.ssh,
    ...(shellParams.stdin !== undefined ? { stdin: shellParams.stdin } : {}),
  });
  return result;
};
```

- [ ] **Step 3: Update the registration to forward signal and allowFailure**

In `openclaw-plugin-registration.ts`, update the `runRemoteShellScript` in `createBackendDeps`:

```typescript
// In the runRemoteShellScript implementation, also accept and forward allowFailure/signal
runRemoteShellScript: async ({
  allowFailure,
  script,
  signal,
  ssh: sshCreds,
  stdin,
}) => {
  // ... existing session creation ...
  return ssh.runSshSandboxCommand({
    allowFailure,
    remoteCommand: ssh.buildRemoteCommand(['/bin/sh', '-c', script, 'gondolin-sandbox-fs']),
    session,
    ...(stdin !== undefined ? { stdin } : {}),
  });
},
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run`
Expected: All PASS.

---

### Task 8: Fix M3 — Write resolved token value to profile.d instead of variable reference

In `gateway-manager.ts:274`, the heredoc writes `$OPENCLAW_GATEWAY_TOKEN` which relies on env inheritance during exec. If the exec context doesn't inherit the env, the token is empty.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/gateway-manager.ts`
- Modify: `packages/agent-vm/src/features/controller/gateway-manager.test.ts`

- [ ] **Step 1: Write a test asserting the resolved token is written**

In `gateway-manager.test.ts`, add an assertion to the existing main test:

```typescript
// In the existing 'builds the image, resolves secrets...' test, after all existing assertions:
// Verify that the profile.d script writes a resolved token, not a variable reference
const profileDExecCall = execMock.mock.calls.find(
  (call) => typeof call[0] === 'string' && call[0].includes('/etc/profile.d/openclaw.sh'),
);
expect(profileDExecCall).toBeDefined();
const profileDScript = profileDExecCall![0] as string;
expect(profileDScript).not.toContain('$OPENCLAW_GATEWAY_TOKEN');
```

- [ ] **Step 2: Fix the heredoc to use the resolved env value**

In `gateway-manager.ts`, the `envVarsScript` currently has:
```
'export OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN\n'
```

Replace with access to the already-resolved env secrets:

```typescript
const gatewayTokenValue = envSecrets.OPENCLAW_GATEWAY_TOKEN ?? '';
const envVarsScript =
  'export OPENCLAW_HOME=/home/openclaw\n' +
  `export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${configFileName}\n` +
  'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state\n' +
  `export OPENCLAW_GATEWAY_TOKEN='${gatewayTokenValue.replace(/'/gu, "'\\''")}'` + '\n' +
  'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt\n';
```

Note: Shell-escape the token value with single-quote escaping to prevent injection.

Also change the file permissions from 644 to 600 (root-only readable) since the file now contains a literal secret:

```typescript
'chmod 600 /etc/profile.d/openclaw.sh && ' +
```

And write to `/root/.openclaw-env` instead of `/etc/profile.d/` to avoid world-readable secrets. Source it from `/root/.bashrc`:

```typescript
'cat /etc/profile.d/openclaw.sh > /root/.openclaw-env && ' +
'chmod 600 /root/.openclaw-env && ' +
'echo "source /root/.openclaw-env" >> /root/.bashrc',
```

- [ ] **Step 3: Update the test fixture to include OPENCLAW_GATEWAY_TOKEN in resolved secrets**

The test's `resolveAll` mock should return `OPENCLAW_GATEWAY_TOKEN: 'gw-token-123'` alongside the other secrets. Then verify the exec call contains the literal token value.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/gateway-manager.test.ts`
Expected: PASS

---

## Subsystem B: Quality Gates and Structural Improvements

### Task 9: Fix Q3 — Run formatter

**Files:** All files in the repo.

- [ ] **Step 1: Run the formatter**

Run: `pnpm fmt`

- [ ] **Step 2: Verify formatting passes**

Run: `pnpm fmt:check`
Expected: 0 files with formatting issues.

---

### Task 10: Fix Q2 — Fix lint errors

**Files:** Various files with lint issues.

- [ ] **Step 1: Run linter with type-aware rules**

Run: `pnpm lint:types`

- [ ] **Step 2: Fix the 2 errors (these block CI). Warnings are acceptable for now.**

Examine the error output. Common issues:
- Missing `await` on promises (no-floating-promises)
- `as` casts that could be `satisfies`
- Unused variables

Fix each error in the source file. Warnings (e.g., no-console in test files, no-await-in-loop for polling) are acceptable and do not block.

- [ ] **Step 3: Fix high-severity warnings selectively**

Not all 57 warnings need fixing now. Focus on:
- Errors (exit code 1)
- `no-floating-promises`
- `no-unsafe-assignment`

- [ ] **Step 4: Run linter again to confirm errors are gone**

Run: `pnpm lint:types`
Expected: 0 errors (warnings are acceptable for now).

---

### Task 11: Fix Q1 — Fix typecheck failures

**Files:** Various files with type errors.

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`

- [ ] **Step 2: Fix type errors**

Common issues from prior phases:
- Test mocks missing new fields added to interfaces (e.g., `websocketBypass`, `getLeaseByScopeKey`)
- Missing return type annotations

Fix each error. Do not use `as any` or bare `// @ts-ignore`. Use `satisfies` or extend mock objects.

- [ ] **Step 3: Run typecheck again**

Run: `pnpm typecheck`
Expected: Exit 0.

---

### Task 12: Split controller-runtime.ts into focused modules

`controller-runtime.ts` is currently ~317 lines and orchestrates gateway boot, tool VM creation, HTTP server setup, and the boot sequence. Split it into focused modules with clear single responsibilities.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/controller-runtime.ts`
- Create: `packages/agent-vm/src/features/controller/gateway-zone-lifecycle.ts`
- Create: `packages/agent-vm/src/features/controller/tool-vm-lifecycle.ts`
- Create: `packages/agent-vm/src/features/controller/controller-http-server.ts`

- [ ] **Step 1: Extract gateway zone lifecycle**

Create `gateway-zone-lifecycle.ts` with:
- The `startGateway` wrapper function (currently inline in `startControllerRuntime`, lines 188-194)
- Re-exports `startGatewayZone` from `./gateway-manager.js`

This file is thin — it exists so `controller-runtime.ts` doesn't directly depend on gateway boot details.

```typescript
// gateway-zone-lifecycle.ts
import type { SecretResolver } from 'gondolin-core';

import { startGatewayZone, type GatewayManagerDependencies } from './gateway-manager.js';
import type { SystemConfig } from './system-config.js';

export interface GatewayZoneLifecycleOptions {
  readonly pluginSourceDir?: string;
  readonly secretResolver: SecretResolver;
  readonly systemConfig: SystemConfig;
  readonly zoneId: string;
}

export async function bootGatewayZone(
  options: GatewayZoneLifecycleOptions,
  dependencies?: GatewayManagerDependencies,
): ReturnType<typeof startGatewayZone> {
  return await startGatewayZone(options, dependencies);
}
```

- [ ] **Step 2: Extract tool VM lifecycle**

Create `tool-vm-lifecycle.ts` with the `createManagedToolVm` default factory (currently lines 131-164 in controller-runtime.ts):

```typescript
// tool-vm-lifecycle.ts
import fsSync from 'node:fs';
import path from 'node:path';

import {
  buildImage as buildImageFromCore,
  createManagedVm as createManagedVmFromCore,
  type BuildConfig,
  type ManagedVm,
} from 'gondolin-core';

import type { ToolProfile } from './lease-manager.js';

export interface CreateToolVmOptions {
  readonly profile: ToolProfile;
  readonly tcpSlot: number;
  readonly workspaceDir: string;
  readonly zoneId: string;
}

export async function createDefaultToolVm(
  options: CreateToolVmOptions,
  config: {
    readonly buildConfigPath: string;
    readonly cacheDir: string;
  },
): Promise<ManagedVm> {
  const toolBuildConfig = JSON.parse(
    fsSync.readFileSync(config.buildConfigPath, 'utf8'),
  ) as BuildConfig;
  const toolImage = await buildImageFromCore({
    buildConfig: toolBuildConfig,
    cacheDir: config.cacheDir,
  });
  const hostWorkspaceDir = path.resolve(
    options.profile.workspaceRoot,
    `${options.zoneId}-${options.tcpSlot}`,
  );
  fsSync.mkdirSync(hostWorkspaceDir, { recursive: true });
  const toolVm = await createManagedVmFromCore({
    allowedHosts: [],
    cpus: options.profile.cpus,
    imagePath: toolImage.imagePath,
    memory: options.profile.memory,
    rootfsMode: 'memory',
    sessionLabel: `${options.zoneId}-tool-${options.tcpSlot}`,
    secrets: {},
    vfsMounts: {
      '/workspace': {
        hostPath: hostWorkspaceDir,
        kind: 'realfs',
      },
    },
  });
  await toolVm.exec(
    'useradd -m -s /bin/bash sandbox 2>/dev/null; ' +
    'mkdir -p /workspace && chown sandbox:sandbox /workspace; ' +
    'ln -sf /proc/self/fd /dev/fd 2>/dev/null || true',
  );
  return toolVm;
}
```

- [ ] **Step 3: Extract HTTP server setup**

Create `controller-http-server.ts` with the `defaultStartHttpServer` function (currently lines 62-87):

```typescript
// controller-http-server.ts
import type { Hono } from 'hono';

export interface ControllerHttpServer {
  close(): Promise<void>;
}

export async function startControllerHttpServer(options: {
  readonly app: Hono;
  readonly port: number;
}): Promise<ControllerHttpServer> {
  const honoNodeServer = await import('@hono/node-server');
  const server = honoNodeServer.serve({
    fetch: options.app.fetch,
    port: options.port,
  });

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
```

- [ ] **Step 4: Update controller-runtime.ts to import from new modules**

Replace the inline implementations with imports. The file should shrink to ~150-200 lines of pure orchestration:

```typescript
import { bootGatewayZone } from './gateway-zone-lifecycle.js';
import { createDefaultToolVm } from './tool-vm-lifecycle.js';
import { startControllerHttpServer } from './controller-http-server.js';
```

Remove the inlined `defaultStartHttpServer`, the tool VM creation block, and `loadBuildConfig`.

- [ ] **Step 5: Run all tests**

Run: `pnpm vitest run`
Expected: All PASS. The existing `controller-runtime.test.ts` tests inject all dependencies, so the extraction doesn't break them.

- [ ] **Step 6: Verify file sizes**

```
wc -l packages/agent-vm/src/features/controller/controller-runtime.ts
wc -l packages/agent-vm/src/features/controller/gateway-zone-lifecycle.ts
wc -l packages/agent-vm/src/features/controller/tool-vm-lifecycle.ts
wc -l packages/agent-vm/src/features/controller/controller-http-server.ts
```

Expected: `controller-runtime.ts` < 200 lines. Each extracted file < 80 lines.

---

### Task 13: Add comprehensive tcp-pool tests

Current `tcp-pool.test.ts` has a single test. Add edge cases.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/tcp-pool.test.ts`

- [ ] **Step 1: Add exhaustion and reuse tests**

```typescript
it('throws when all slots are exhausted', () => {
  const pool = createTcpPool({ basePort: 19000, size: 1 });
  pool.allocate();
  expect(() => pool.allocate()).toThrow(/No TCP slots available/u);
});

it('reuses the lowest available slot after release', () => {
  const pool = createTcpPool({ basePort: 19000, size: 3 });
  pool.allocate(); // 0
  const slot1 = pool.allocate(); // 1
  pool.allocate(); // 2

  pool.release(slot1); // free slot 1
  pool.release(0); // free slot 0

  expect(pool.allocate()).toBe(0); // lowest first
  expect(pool.allocate()).toBe(1);
});

it('getAllMappings returns sorted entries for allocated slots only', () => {
  const pool = createTcpPool({ basePort: 19000, size: 5 });
  pool.allocate(); // 0
  pool.allocate(); // 1
  pool.allocate(); // 2
  pool.release(1);

  const mappings = pool.getAllMappings();
  expect(Object.keys(mappings)).toEqual(['tool-0.vm.host:22', 'tool-2.vm.host:22']);
  expect(mappings['tool-0.vm.host:22']).toBe('127.0.0.1:19000');
  expect(mappings['tool-2.vm.host:22']).toBe('127.0.0.1:19002');
});

it('release is idempotent', () => {
  const pool = createTcpPool({ basePort: 19000, size: 2 });
  const slot = pool.allocate();
  pool.release(slot);
  pool.release(slot); // should not throw or corrupt state

  expect(pool.allocate()).toBe(0); // slot 0 is available
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/tcp-pool.test.ts`
Expected: All PASS (these test existing behavior, should pass immediately).

---

### Task 14: Add comprehensive idle-reaper tests

Current `idle-reaper.test.ts` has a single test. Add edge cases.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/idle-reaper.test.ts`

- [ ] **Step 1: Add tests for multiple expired and all-active scenarios**

```typescript
it('releases multiple expired leases in parallel', async () => {
  const releaseLease = vi.fn(async () => {});
  const reaper = createIdleReaper({
    getLeases: () => [
      { id: 'expired-1', lastUsedAt: 1_000 },
      { id: 'expired-2', lastUsedAt: 2_000 },
      { id: 'active-1', lastUsedAt: 9_000 },
    ],
    now: () => 10_000,
    releaseLease,
    ttlMs: 5_000,
  });

  await reaper.reapExpiredLeases();

  expect(releaseLease).toHaveBeenCalledTimes(2);
  expect(releaseLease).toHaveBeenCalledWith('expired-1');
  expect(releaseLease).toHaveBeenCalledWith('expired-2');
});

it('does not release any leases when all are active', async () => {
  const releaseLease = vi.fn(async () => {});
  const reaper = createIdleReaper({
    getLeases: () => [
      { id: 'active-1', lastUsedAt: 9_000 },
      { id: 'active-2', lastUsedAt: 9_500 },
    ],
    now: () => 10_000,
    releaseLease,
    ttlMs: 5_000,
  });

  await reaper.reapExpiredLeases();

  expect(releaseLease).not.toHaveBeenCalled();
});

it('handles empty lease list gracefully', async () => {
  const releaseLease = vi.fn(async () => {});
  const reaper = createIdleReaper({
    getLeases: () => [],
    now: () => 10_000,
    releaseLease,
    ttlMs: 5_000,
  });

  await reaper.reapExpiredLeases();

  expect(releaseLease).not.toHaveBeenCalled();
});

it('releases a lease at exactly the TTL boundary', async () => {
  const releaseLease = vi.fn(async () => {});
  const reaper = createIdleReaper({
    getLeases: () => [
      { id: 'boundary', lastUsedAt: 5_000 },
    ],
    now: () => 10_000,
    releaseLease,
    ttlMs: 5_000,
  });

  await reaper.reapExpiredLeases();

  // At exactly TTL, now() - lastUsedAt === ttlMs, which is NOT > ttlMs
  expect(releaseLease).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/idle-reaper.test.ts`
Expected: All PASS.

---

### Task 15: Add controller-runtime boot failure test

The existing test only covers the happy path. Add a test for gateway boot failure.

**Files:**
- Modify: `packages/agent-vm/src/features/controller/controller-runtime.test.ts`

- [ ] **Step 1: Add boot failure test**

```typescript
it('propagates gateway boot failure without starting the http server', async () => {
  process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
  const startGatewayZone = vi.fn(async () => {
    throw new Error('Gateway image build failed');
  });
  const startHttpServer = vi.fn(async () => ({ close: async () => {} }));

  await expect(
    startControllerRuntime(
      {
        pluginSourceDir: '/plugins',
        systemConfig,
        zoneId: 'shravan',
      },
      {
        createSecretResolver: async () => ({
          resolve: async () => '',
          resolveAll: async () => ({}),
        }),
        startGatewayZone,
        startHttpServer,
        setIntervalImpl: vi.fn(() => 123 as unknown as NodeJS.Timeout),
        clearIntervalImpl: vi.fn(),
      },
    ),
  ).rejects.toThrow('Gateway image build failed');

  expect(startHttpServer).not.toHaveBeenCalled();
});

it('throws for an unknown zone id', async () => {
  process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';

  await expect(
    startControllerRuntime(
      {
        pluginSourceDir: '/plugins',
        systemConfig,
        zoneId: 'nonexistent-zone',
      },
      {
        createSecretResolver: async () => ({
          resolve: async () => '',
          resolveAll: async () => ({}),
        }),
        startGatewayZone: vi.fn(),
        startHttpServer: vi.fn(async () => ({ close: async () => {} })),
        setIntervalImpl: vi.fn(() => 123 as unknown as NodeJS.Timeout),
        clearIntervalImpl: vi.fn(),
      },
    ),
  ).rejects.toThrow("Unknown zone 'nonexistent-zone'.");
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/features/controller/controller-runtime.test.ts`
Expected: All PASS.

---

### Task 16: Run full quality gate check

Verify everything passes together.

- [ ] **Step 1: Run formatter**

Run: `pnpm fmt`

- [ ] **Step 2: Run linter**

Run: `pnpm lint:types`
Expected: 0 errors.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: Exit 0.

- [ ] **Step 4: Run all tests**

Run: `pnpm vitest run`
Expected: All PASS. Report total test count and time.

- [ ] **Step 5: Report results**

Report exit codes and pass/fail counts for all four commands.

---

## Subsystem C: E2E Verification Checklist

### Task 17: Create reproducible E2E verification checklist

**Files:**
- Create: `docs/E2E-VERIFICATION-CHECKLIST.md`

- [ ] **Step 1: Write the checklist**

Create the file with the following content. Each step has exact commands and expected output patterns.

```markdown
# E2E Verification Checklist

Reproducible steps to verify agent-vm from cold boot to agent chat.
Run from the repo root. Requires Gondolin installed and 1Password CLI configured.

## Prerequisites

- [ ] `gondolin --version` outputs a version (proves Gondolin is installed)
- [ ] `op whoami` succeeds (proves 1Password CLI is authenticated)
- [ ] `pnpm install` has been run
- [ ] `pnpm build` succeeds (all packages compile)

## 1. Controller Boot

```bash
pnpm agent-vm controller start --zone shravan --config ./system.json
```

**Expected:**
- stdout includes `Controller listening on port 18800`
- stdout includes `Gateway zone 'shravan' started`
- No error output

**Verify:**
```bash
curl -s http://127.0.0.1:18800/health | jq .
```
Expected: `{ "ok": true, "port": 18800 }`

## 2. Gateway Readiness

```bash
curl -s http://127.0.0.1:18800/controller-status | jq .
```

**Expected:**
- Response includes `controllerPort: 18800`
- Response includes the zone config

**Verify OpenClaw is running inside the gateway VM:**
```bash
curl -s -X POST http://127.0.0.1:18800/zones/shravan/execute-command \
  -H 'Content-Type: application/json' \
  -d '{"command": "curl -sS -o /dev/null -w %{http_code} http://127.0.0.1:18789/"}' | jq .
```
Expected: stdout contains `200` or `401` (OpenClaw is listening)

## 3. Lease Creation (Sandbox Exec)

```bash
curl -s -X POST http://127.0.0.1:18800/lease \
  -H 'Content-Type: application/json' \
  -d '{
    "agentWorkspaceDir": "/home/openclaw/workspace",
    "profileId": "standard",
    "scopeKey": "e2e-test-scope",
    "workspaceDir": "/home/openclaw/.openclaw/sandboxes/workspace",
    "zoneId": "shravan"
  }' | jq .
```

**Expected:**
- Response includes `leaseId` (string)
- Response includes `tcpSlot` (number)
- Response includes `ssh.host` matching `tool-N.vm.host`
- Response includes `workdir: "/workspace"`

**Verify the lease exists:**
```bash
curl -s http://127.0.0.1:18800/leases | jq .
```
Expected: Array with one entry matching `scopeKey: "e2e-test-scope"`

## 4. Execute Command in Tool VM (via Gateway)

Using the lease's SSH details, execute a command inside the tool VM through the gateway:

```bash
curl -s -X POST http://127.0.0.1:18800/zones/shravan/execute-command \
  -H 'Content-Type: application/json' \
  -d '{"command": "cat /etc/os-release"}' | jq .
```

**Expected:**
- `exitCode: 0`
- `stdout` contains OS identification (e.g., `Debian`)

## 5. File Operations in Workspace

Verify files can be created and read in the workspace:

```bash
# Write a file
curl -s -X POST http://127.0.0.1:18800/zones/shravan/execute-command \
  -H 'Content-Type: application/json' \
  -d '{"command": "echo hello-e2e > /home/openclaw/workspace/test.txt && cat /home/openclaw/workspace/test.txt"}' | jq .
```

**Expected:**
- `exitCode: 0`
- `stdout` contains `hello-e2e`

**Verify the file exists on the host:**
```bash
cat workspaces/shravan/test.txt
```
Expected: `hello-e2e`

## 6. Lease Release

```bash
# Get the lease ID from step 3, then:
LEASE_ID=$(curl -s http://127.0.0.1:18800/leases | jq -r '.[0].id')
curl -s -X DELETE "http://127.0.0.1:18800/lease/${LEASE_ID}" -w "\n%{http_code}\n"
```

**Expected:**
- HTTP status `204`
- No response body

**Verify lease is gone:**
```bash
curl -s http://127.0.0.1:18800/leases | jq .
```
Expected: Empty array `[]`

## 7. Agent Chat (OpenClaw Gateway)

If `OPENCLAW_GATEWAY_TOKEN` is available:

```bash
TOKEN=$(op read "op://agent-vm/openclaw-gateway/token" 2>/dev/null || echo "")
curl -s http://127.0.0.1:18791/api/status \
  -H "Authorization: Bearer ${TOKEN}" | jq .
```

**Expected:**
- `200 OK` with version info

## 8. Snapshot Create/Restore

```bash
pnpm agent-vm controller snapshot create --zone shravan --config ./system.json
```

**Expected:**
- stdout includes the snapshot path ending in `.tar.age`
- File exists at the printed path

```bash
pnpm agent-vm controller snapshot list --zone shravan --config ./system.json
```

**Expected:**
- Lists at least one snapshot with zone, timestamp, and path

## 9. Controller Stop

```bash
curl -s -X POST http://127.0.0.1:18800/stop-controller | jq .
```

**Expected:**
- `{ "ok": true }`
- Process exits within 5 seconds

**Verify stopped:**
```bash
curl -s http://127.0.0.1:18800/health 2>&1
```
Expected: Connection refused

## 10. Cold Restart

Repeat step 1. Verify the controller boots cleanly without stale state.

```bash
pnpm agent-vm controller start --zone shravan --config ./system.json
```

**Expected:** Same as step 1 — no errors about existing VMs or ports in use.

## Pass/Fail Summary

| Step | Description | Status |
|------|-------------|--------|
| 1 | Controller boot | |
| 2 | Gateway readiness | |
| 3 | Lease creation | |
| 4 | Command execution | |
| 5 | File operations | |
| 6 | Lease release | |
| 7 | Agent chat | |
| 8 | Snapshot create/restore | |
| 9 | Controller stop | |
| 10 | Cold restart | |
```

- [ ] **Step 2: Review the checklist for completeness**

Read the written file and verify each step has:
1. Exact command to run
2. Expected output pattern
3. Verification command

---

## Task Dependency Summary

```
Independent (can parallelize):
  Task 1 (H5)  Task 2 (H4)  Task 6 (M1)  Task 13 (tcp-pool)  Task 14 (idle-reaper)  Task 17 (E2E checklist)

Sequential chains:
  Task 3 (H1) → Task 4 (H2)     # H2 depends on getLeaseByScopeKey from H1
  Task 5 (H3)                    # independent
  Task 7 (M2)                    # independent
  Task 8 (M3)                    # independent
  Task 12 (split) → Task 15 (runtime tests)  # tests should cover the split structure

Quality gates (run after all fixes):
  Task 9 (fmt) → Task 10 (lint) → Task 11 (typecheck) → Task 16 (full check)
```

---

---

## Subsystem D — Zod Validation + Live Integration Tests (Tasks 18-20)

### Task 18: Separate vitest configs for unit vs integration tests

**Files:**
- Modify: `vitest.config.ts` — exclude `*.integration.test.ts` files
- Create: `vitest.integration.config.ts` — only include `*.integration.test.ts` files
- Modify: `package.json` — add `test:integration` script

Unit tests (`pnpm test`): fast, no external deps, run in CI. Pattern: `*.test.ts`
Integration tests (`pnpm test:integration`): require QEMU, `.env.local`, real VMs. Pattern: `*.integration.test.ts`

The integration config should:
- Load `.env.local` automatically (vitest `env` or `setupFiles`)
- Set longer timeouts (120s+ for VM boot)
- Only include `*.integration.test.ts` files
- Read `OPENAI_API_KEY` from `.env.local` for model round-trip tests

Add `OPENAI_API_KEY` to `.env.local` for integration tests that need real model calls. This is a standard OpenAI API key (not OAuth), used only for testing. The production system uses Codex OAuth.

Rename existing live tests:
- `live-sandbox-e2e.test.ts` → `live-sandbox-e2e.integration.test.ts`
- `live-cross-vm-ssh.test.ts` → `live-cross-vm-ssh.integration.test.ts`
- `live-smoke.test.ts` → `live-smoke.integration.test.ts` (if it exists)
- `live-api-smoke.test.ts` stays as unit (uses mock Hono servers, no VMs)

- [ ] **Step 1: Create vitest.integration.config.ts** that includes `*.integration.test.ts`
- [ ] **Step 2: Update vitest.config.ts** to exclude `*.integration.test.ts`
- [ ] **Step 3: Add `test:integration` script** to root package.json
- [ ] **Step 4: Rename live test files** to use `.integration.test.ts` suffix
- [ ] **Step 5: Verify** `pnpm test` skips integration, `pnpm test:integration` runs them
- [ ] **Step 6: Commit**

### Task 19: Add Zod v4 request validation to all controller HTTP endpoints (replaces manual type guards)

**Files:**
- Modify: `packages/agent-vm/src/features/controller/controller-service.ts`
- Create: `packages/agent-vm/src/features/controller/controller-request-schemas.ts`
- Modify: `packages/agent-vm/src/features/controller/controller-service.test.ts`

All controller HTTP endpoints currently parse JSON with manual type guards (`isLeaseCreatePayload`, `isDestroyPayload`). Replace with Zod v4 schemas + Hono's zValidator middleware for type-safe request validation with proper error messages.

Schemas needed:
- `leaseCreateRequestSchema` — zoneId, scopeKey, profileId, workspaceDir, agentWorkspaceDir (all required strings)
- `destroyZoneRequestSchema` — purge (optional boolean)
- `executeCommandRequestSchema` — command (required string)
- `leaseIdParamSchema` — leaseId (required string, min 1)
- `zoneIdParamSchema` — zoneId (required string, min 1)

Use `@hono/zod-validator` if available, or manual `schema.parse()` in route handlers.

- [ ] **Step 1: Write the failing test** — POST /lease with invalid body should return 400 with Zod error details
- [ ] **Step 2: Create controller-request-schemas.ts** with all Zod schemas
- [ ] **Step 3: Replace manual type guards** with Zod validation in controller-service.ts
- [ ] **Step 4: Run tests** — verify 400 errors include schema details
- [ ] **Step 5: Commit**

### Task 20: Add live integration test — agent chat model round-trip

**Files:**
- Create: `packages/agent-vm/src/features/controller/live-agent-model-roundtrip.test.ts`

This test requires: QEMU, built images, `.env.local` with `OP_SERVICE_ACCOUNT_TOKEN`.
Mark with `integration_llm` tag so it doesn't run in CI.

The test:
1. Boots controller with real system.json
2. Waits for gateway readiness
3. Sends `openclaw agent -m "what is 2+2? answer one word" --agent main --local` via exec endpoint
4. Verifies output contains a number or word answer (not an error)
5. Verifies at least 1 lease was created (sandbox was triggered)
6. Stops controller

- [ ] **Step 1: Write the test file** with `describe.skip` initially
- [ ] **Step 2: Run manually** to verify it works: `pnpm vitest run packages/agent-vm/src/features/controller/live-agent-model-roundtrip.test.ts`
- [ ] **Step 3: Commit**

### Task 21: Add live integration test — controller stop + restart persistence

**Files:**
- Create: `packages/agent-vm/src/features/controller/live-stop-restart.test.ts`

This test requires: QEMU, built images, `.env.local`.

The test:
1. Boots controller
2. Creates a file in the state dir via exec
3. Sends POST /stop-controller
4. Verifies controller stopped (health check fails)
5. Re-boots controller
6. Verifies the state file persists (exec cat of the file)
7. Verifies 0 stale leases
8. Sends a tool call to verify functionality restored

- [ ] **Step 1: Write the test file**
- [ ] **Step 2: Run manually** to verify
- [ ] **Step 3: Commit**

---

## Verification Criteria

All of the following must pass before this phase is complete:

1. `pnpm fmt:check` — exit 0
2. `pnpm lint:types` — 0 errors
3. `pnpm typecheck` — exit 0
4. `pnpm vitest run` — all tests pass, 0 failures
5. `controller-runtime.ts` < 200 lines
6. Each new extracted file < 100 lines
7. `docs/E2E-VERIFICATION-CHECKLIST.md` exists with all 10 steps
8. All controller HTTP endpoints use Zod v4 request validation
9. Live integration tests exist for: agent model round-trip, stop/restart persistence
10. No manual type guards (`isLeaseCreatePayload`, `isDestroyPayload`) remain in controller-service.ts
