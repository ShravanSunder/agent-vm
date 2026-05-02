# Lease Work Mount Naming And Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace misleading controller-side `workspaceDir` lease vocabulary with `workMountDir`, keep Tool VMs consistently mounted at `/work`, and update docs/defaults so operators and agents understand the backing-directory model.

**Architecture:** This is a hard cutover of agent-vm's controller lease contract. OpenClaw may still expose `sandbox.workspaceDir` through its SDK; the agent-vm OpenClaw plugin translates that external SDK name into the controller's `workMountDir`. Inside agent-vm, distinguish the request path (`workMountDir`, a gateway VM path) from the translated host path (`hostWorkMountDir`) and from the Tool VM guest path (`/work`).

**Tech Stack:** TypeScript, Zod, Hono, Vitest, pnpm, OXC, OpenClaw sandbox backend, Gondolin RealFS mounts.

---

## Naming Model

Use these names everywhere in this changeset:

```text
OpenClaw SDK field        agent-vm controller field     Meaning
────────────────────      ─────────────────────────     ────────────────────────────────
sandbox.workspaceDir      workMountDir                  Gateway VM path chosen by OpenClaw
                          hostWorkMountDir              Controller host path after mapping
                          /work                         Tool VM guest mount path

sandbox.agentWorkspaceDir agentWorkspaceDir             OpenClaw's broader agent workspace
```

Do not introduce `/workspace` as a guest path. It is retired.

`workMountDir` examples:

```text
/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work
/zone/projects/home-agent
```

`hostWorkMountDir` examples:

```text
<zone.stateDir>/sandboxes/agent-shravan/work
<zone.zoneFilesDir>/projects/home-agent
```

Tool VM runtime path:

```text
/work
```

## File Responsibility Map

```text
packages/agent-vm/src/controller/http/controller-request-schemas.ts
  Owns the public controller lease request schema. Replace request
  field workspaceDir with workMountDir.

packages/agent-vm/src/controller/http/controller-http-routes.ts
  Owns /lease routing. Parse workMountDir, resolve it to hostWorkMountDir,
  pass hostWorkMountDir to lease manager/createToolVm, and return errors
  using workMountDir vocabulary.

packages/agent-vm/src/controller/leases/lease-workspace-paths.ts
  Rename to lease-work-mount-paths.ts. Owns gateway-path to host-path
  translation and allowed-root validation.

packages/agent-vm/src/controller/leases/lease-manager.ts
  Owns stored lease identity and reuse checks. Replace workspaceDir with
  hostWorkMountDir.

packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts
  Owns Tool VM creation. Accept hostWorkMountDir and mount it at /work.

packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts
packages/agent-vm/src/controller/controller-runtime.ts
  Own shared dependency typing and adapter between lease manager and
  Tool VM lifecycle. Replace workspaceDir with hostWorkMountDir.

packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts
  Owns HTTP client request to controller. Send workMountDir.

packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts
  Owns translation from OpenClaw SDK sandbox fields. Map
  params.workspaceDir to controller workMountDir.

docs/architecture/openclaw-gateway.md
docs/architecture/storage-matrix.md
docs/subsystems/controller.md
docs/reference/configuration/system-json.md
docs/getting-started/openclaw-guide.md
AGENTS.md
CLAUDE.md
  Own user/agent explanations. Replace naked workspaceDir with the
  three-path model: lease workMountDir, hostWorkMountDir, Tool VM /work.

docs/reference/gondolin/vfs-rootfs-performance.md
  Historical/reference doc. Remove or quarantine stale "/workspace ->
  host repo/provider" examples unless explicitly marked as legacy.
```

---

### Task 1: Public Lease Schema Hard Cutover

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts`
- Modify: `packages/agent-vm/src/integration-tests/live-sandbox-e2e.integration.test.ts`

Hard-cutover request schemas must reject legacy fields. `z.object()` strips
unknown keys by default, which would allow a request containing both the new
`workMountDir` field and the legacy `workspaceDir` field to parse
successfully. Use `z.strictObject()` for this lease request schema.

- [ ] **Step 1: Write failing schema tests**

In `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`, update the `/lease` request tests so they use `workMountDir`:

```ts
const validLeasePayload = {
	agentWorkspaceDir: '/home/openclaw/work',
	profileId: 'default',
	scopeKey: 'agent:shravan',
	workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
	zoneId: 'shravan',
};
```

Add a rejection test for the old field:

```ts
it('rejects the old workspaceDir lease field', async () => {
	const response = await app.request('/lease', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'default',
			scopeKey: 'agent:shravan',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
			zoneId: 'shravan',
		}),
	});

	expect(response.status).toBe(400);
	const body = await response.json();
expect(body.error).toBe('invalid-lease-request');
});
```

Add the stricter hard-cutover regression test where the new field is present
but the old field is also present:

```ts
it('rejects requests that include legacy workspaceDir even with workMountDir', async () => {
	const response = await app.request('/lease', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'default',
			scopeKey: 'agent:shravan',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/legacy/work',
			zoneId: 'shravan',
		}),
	});

	expect(response.status).toBe(400);
	const body = await response.json();
	expect(body.error).toBe('invalid-lease-request');
});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: tests fail because the schema still expects `workspaceDir`.

- [ ] **Step 3: Change the Zod schema**

In `controller-request-schemas.ts`, replace the loose object schema:

```ts
export const controllerLeaseCreateRequestSchema = z.object({
	agentWorkspaceDir: z.string().min(1),
	profileId: z.string().min(1),
	scopeKey: z.string().min(1),
	workspaceDir: z.string().min(1),
	zoneId: z.string().min(1),
});
```

with:

```ts
export const controllerLeaseCreateRequestSchema = z.strictObject({
	agentWorkspaceDir: z.string().min(1),
	profileId: z.string().min(1),
	scopeKey: z.string().min(1),
	workMountDir: z.string().min(1),
	zoneId: z.string().min(1),
});
```

- [ ] **Step 4: Update route parsing**

In `controller-http-routes.ts`, replace the route-local `workspaceDir` variable with `hostWorkMountDir`:

```ts
const hostWorkMountDir = await options.resolveLeaseWorkMountDir({
	scopeKey: payload.scopeKey,
	workMountDir: payload.workMountDir,
	zoneId: payload.zoneId,
});
```

Pass the translated path to the lease manager:

```ts
const lease = await options.leaseManager.createLease({
	agentWorkspaceDir: payload.agentWorkspaceDir,
	profile: defaultToolVmProfile,
	profileId: resolvedProfileId,
	scopeKey: payload.scopeKey,
	hostWorkMountDir,
	zoneId: payload.zoneId,
});
```

Update the `createControllerApp` dependency type:

```ts
readonly resolveLeaseWorkMountDir: (options: {
	readonly scopeKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}) => Promise<string>;
```

Do not keep a production fallback from `workMountDir` to `hostWorkMountDir`.
The `/lease` route is a security boundary: a gateway VM path must be resolved
through the allowed-root mapper before it can become the host path passed to
`LeaseManager.createLease()`. Unit tests that do not exercise path mapping may
pass an explicit identity resolver:

```ts
resolveLeaseWorkMountDir: async ({ workMountDir }) => workMountDir,
```

but real controller startup must pass the zone-aware resolver.

- [ ] **Step 5: Update integration and smoke tests**

Update lease request payloads in:

```text
packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts
packages/agent-vm/src/integration-tests/live-sandbox-e2e.integration.test.ts
```

Replace:

```ts
workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
```

with:

```ts
workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
```

For shell-embedded JSON payloads, replace:

```json
{"zoneId":"shravan","scopeKey":"test","profileId":"standard","workspaceDir":"/tmp","agentWorkspaceDir":"/tmp"}
```

with:

```json
{"zoneId":"shravan","scopeKey":"test","profileId":"standard","workMountDir":"/tmp","agentWorkspaceDir":"/tmp"}
```

- [ ] **Step 6: Run targeted route and smoke compile tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts
```

Expected: route tests and the lightweight live API smoke test pass. The
QEMU-backed `live-sandbox-e2e.integration.test.ts` should compile through
`pnpm typecheck` and can be run manually when the live sandbox prerequisites
are available.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/controller/http/controller-request-schemas.ts packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/integration-tests/live-api-smoke.integration.test.ts packages/agent-vm/src/integration-tests/live-sandbox-e2e.integration.test.ts
git commit -m "refactor: rename lease request work mount field" -m "Replace the controller lease request field workspaceDir with workMountDir so the API names the directory that backs Tool VM /work instead of implying a guest /workspace path." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Lease Path Resolver Rename

**Files:**
- Rename: `packages/agent-vm/src/controller/leases/lease-workspace-paths.ts` -> `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
- Rename: `packages/agent-vm/src/controller/leases/lease-workspace-paths.test.ts` -> `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`
- Modify import sites under `packages/agent-vm/src/controller/**` and `packages/agent-vm/src/tool-vm/**`

- [ ] **Step 1: Rename tests first**

In the renamed test file, replace helper/test names so they assert `workMountDir` vocabulary:

```ts
it('maps state sandbox workMountDir from gateway path to host path', async () => {
	const result = await resolveLeaseWorkMountDir({
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
		zone,
	});

	expect(result).toBe(path.join(zone.gateway.stateDir, 'sandboxes', 'agent', 'work'));
});
```

Add one explicit message assertion:

```ts
await expect(
	resolveLeaseWorkMountDir({
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/../../../etc',
		zone,
	}),
).rejects.toThrow("Lease workMountDir");
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
```

Expected: import/function failures until the implementation is renamed.

- [ ] **Step 3: Rename implementation symbols**

In `lease-work-mount-paths.ts`, use these exports:

```ts
export class LeaseWorkMountValidationError extends Error {}

export async function validateResolvedToolWorkMountDir(options: {
	readonly hostWorkMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<string> {
	// same validation behavior, renamed inputs/messages
}

export async function resolveLeaseWorkMountDir(options: {
	readonly workMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<string> {
	// maps gateway workMountDir to validated hostWorkMountDir
}
```

Inside the file, rename local variables:

```ts
const normalizedWorkMountDir = path.posix.normalize(options.workMountDir);
const hostWorkMountDir = mapGuestPathToHostPath(...);
```

Use error messages that teach the model:

```ts
`Lease workMountDir '${options.workMountDir}' must be under ${OPENCLAW_STATE_SANDBOXES_VM_ROOT} or ${OPENCLAW_ZONE_FILES_VM_ROOT}.`
```

- [ ] **Step 4: Update imports**

Replace imports of:

```ts
LeaseWorkspaceValidationError
resolveLeaseWorkspaceDir
validateResolvedToolWorkspaceDir
```

with:

```ts
LeaseWorkMountValidationError
resolveLeaseWorkMountDir
validateResolvedToolWorkMountDir
```

- [ ] **Step 5: Run resolver and route tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/leases packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts
git commit -m "refactor: rename lease work mount resolver" -m "Rename lease workspace path helpers to work mount helpers and use hostWorkMountDir for the translated host directory that backs Tool VM /work." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Lease Manager And Tool VM Internal Types

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
- Modify: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`

- [ ] **Step 1: Update failing lease-manager tests**

Replace `workspaceDir` with `hostWorkMountDir` in lease-manager tests:

```ts
const leaseOptions = {
	agentWorkspaceDir: '/host/agent-work',
	hostWorkMountDir: '/host/state/sandboxes/agent/work',
	profile,
	profileId: 'default',
	scopeKey: 'agent:shravan',
	zoneId: 'shravan',
};
```

Conflict expectations should say:

```ts
"existing hostWorkMountDir '/host/state/sandboxes/agent/work' does not match requested hostWorkMountDir '/host/state/sandboxes/other/work'"
```

- [ ] **Step 2: Verify targeted tests fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected: TypeScript/test failures until implementation fields are renamed.

- [ ] **Step 3: Rename lease fields**

In `lease-manager.ts`, replace stored lease field:

```ts
readonly hostWorkMountDir: string;
```

Update `LeaseManager.createLease()` and `createLeaseManager({ createManagedVm })` option types to accept `hostWorkMountDir`.

Update conflict check:

```ts
if (existingLease.hostWorkMountDir !== requestedLease.hostWorkMountDir) {
	throw new LeaseScopeConflictError(
		`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing hostWorkMountDir '${existingLease.hostWorkMountDir}' does not match requested hostWorkMountDir '${requestedLease.hostWorkMountDir}'.`,
	);
}
```

- [ ] **Step 4: Rename Tool VM lifecycle input**

In `tool-vm-lifecycle.ts`, update `createToolVm` options:

```ts
readonly hostWorkMountDir: string;
```

Validate/pin with the new helper:

```ts
await validateResolvedToolWorkMountDir({
	hostWorkMountDir: options.hostWorkMountDir,
	zone,
});

const pinnedWorkMountRoot = pinRealFsRoot(options.hostWorkMountDir);
```

Mount at `/work` exactly as today:

```ts
vfsMounts: {
	'/work': {
		hostPath: options.hostWorkMountDir,
		kind: 'realfs',
		pinnedHostRoot: pinnedWorkMountRoot,
	},
},
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts packages/agent-vm/src/controller/controller-runtime-support.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/leases/lease-manager.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
git commit -m "refactor: name translated tool work mount paths" -m "Use hostWorkMountDir for the validated host directory passed from the lease manager into Tool VM creation, while keeping the Tool VM guest mount fixed at /work." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: OpenClaw Plugin Translation Boundary

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`

- [ ] **Step 1: Write client tests for the new request body**

In `controller-lease-client.test.ts`, assert the POST body uses `workMountDir` and does not include `workspaceDir`:

```ts
expect(JSON.parse(requests[0].body as string)).toEqual({
	agentWorkspaceDir: '/home/openclaw/work',
	profileId: 'default',
	scopeKey: 'agent:shravan',
	workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
	zoneId: 'shravan',
});
```

- [ ] **Step 2: Verify plugin tests fail**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
```

Expected: failures because client still sends `workspaceDir`.

- [ ] **Step 3: Update controller lease client types**

In `controller-lease-client.ts`, change create lease options:

```ts
readonly workMountDir: string;
```

and POST body:

```ts
body: JSON.stringify({
	agentWorkspaceDir: options.agentWorkspaceDir,
	profileId: options.profileId,
	scopeKey: options.scopeKey,
	workMountDir: options.workMountDir,
	zoneId: options.zoneId,
}),
```

- [ ] **Step 4: Keep OpenClaw SDK vocabulary only at the boundary**

In `sandbox-backend-handle-factory.ts`, keep the incoming OpenClaw SDK field names in the boundary parameter type:

```ts
readonly agentWorkspaceDir: string;
readonly workspaceDir: string;
```

Translate immediately when creating the controller lease:

```ts
const lease = await params.leaseClient.requestLease({
	agentWorkspaceDir: params.agentWorkspaceDir,
	profileId: params.profileId,
	scopeKey: params.scopeKey,
	workMountDir: params.workspaceDir,
	zoneId: params.zoneId,
});
```

Add a short comment:

```ts
// OpenClaw SDK still names the selected sandbox path `workspaceDir`.
// agent-vm's controller calls the same value `workMountDir` because it
// backs the Tool VM /work mount.
```

- [ ] **Step 5: Run plugin tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-agent-vm-plugin/src
git commit -m "refactor: translate OpenClaw workspace to work mount" -m "Keep OpenClaw SDK workspaceDir vocabulary at the plugin boundary, but send workMountDir to the agent-vm controller lease API." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Agent Sandbox Seeding Vocabulary

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts`
- Modify: `packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`

- [ ] **Step 1: Update seeding tests**

Rename local variables in `agent-sandbox-seeding.test.ts`:

```ts
const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
await mkdir(hostWorkMountDir, { recursive: true });

const result = await seedAgentSandboxWorkspace({
	hostWorkMountDir,
	scopeKey: 'agent:shravan',
	secretResolver,
	zone,
});
```

Expected result shapes should expose `hostWorkMountDir`:

```ts
expect(result).toMatchObject({
	kind: 'seeded',
	hostWorkMountDir,
});
```

- [ ] **Step 2: Verify seeding tests fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts
```

Expected: compile/test failures until implementation fields are renamed.

- [ ] **Step 3: Rename result fields**

In `agent-sandbox-seeding.ts`, replace input/result fields named `workspaceDir` with `hostWorkMountDir`.

Logging in `controller-http-routes.ts` should say:

```ts
`skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': work mount '${result.hostWorkMountDir}' does not exist`
```

and:

```ts
`skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': work mount '${result.hostWorkMountDir}' is outside sandbox root '${result.sandboxRoot}'`
```

- [ ] **Step 4: Run seeding and route tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/leases/agent-sandbox-seeding.ts packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts packages/agent-vm/src/controller/http/controller-http-routes.ts
git commit -m "refactor: clarify sandbox seeding work mount paths" -m "Rename sandbox seeding inputs and diagnostics from workspaceDir to hostWorkMountDir so seed writes are described as writes into the host directory backing Tool VM /work." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Config Defaults And Generated Manual Text

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/architecture/storage-matrix.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/subsystems/controller.md`
- Modify: `docs/getting-started/openclaw-guide.md`
- Modify: `docs/reference/gondolin/vfs-rootfs-performance.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write docs/defaults assertions**

In `init-command.test.ts`, keep existing `/work` assertions and add assertions that generated files do not mention `/workspace`:

```ts
expect(gatewayDockerfile).toContain('WORKDIR /work');
expect(gatewayDockerfile).not.toContain('/workspace');
expect(systemJsonText).not.toContain('workspaceDir');
```

If init generates AGENTS/README/manual content in this branch, assert:

```ts
expect(agentInstructionsText).toContain('Tool VM /work');
expect(agentInstructionsText).toContain('workMountDir');
expect(agentInstructionsText).not.toContain('/workspace');
```

- [ ] **Step 2: Verify targeted init tests fail if stale docs/defaults remain**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: fail if generated defaults still contain stale workspace vocabulary.

- [ ] **Step 3: Update generated text**

Use this wording wherever generated agent-facing or human-facing text explains Tool VM paths:

```text
OpenClaw Tool VMs always see their mounted working directory at /work.
The controller lease request calls the selected gateway path workMountDir.
The controller validates and translates that gateway path to a host
hostWorkMountDir before creating the RealFS mount.
```

Do not write:

```text
workspaceDir is mounted at /work
/workspace
workspace path
```

unless the text is explicitly describing the OpenClaw SDK boundary:

```text
OpenClaw SDK compatibility note: OpenClaw currently names the selected
sandbox path workspaceDir. The agent-vm plugin translates that field to
workMountDir before calling the controller.
```

- [ ] **Step 4: Update configuration docs**

In `docs/reference/configuration/system-json.md`, explain that there is no static `workMountDir` in `system.json`:

```text
`workMountDir` is not a system.json field. It is selected dynamically by
OpenClaw when a tool lease is requested. Static config defines the allowed
roots: the OpenClaw state sandbox root and `zoneFilesDir`.
```

Document defaults:

```text
Tool VM guest path: /work
OpenClaw gateway zone files: /zone
OpenClaw state sandboxes: /home/openclaw/.openclaw/state/sandboxes
```

- [ ] **Step 5: Update architecture docs**

In `docs/architecture/openclaw-gateway.md`, `docs/subsystems/controller.md`,
and `docs/architecture/storage-matrix.md`, replace:

```text
POST /lease { zoneId, scopeKey, profileId, agentWorkspaceDir, workspaceDir }
```

with:

```text
POST /lease { zoneId, scopeKey, profileId, agentWorkspaceDir, workMountDir }
```

Add the translation flow:

```text
workMountDir, gateway path
  -> hostWorkMountDir, controller host path
  -> Tool VM /work, RealFS guest mount
```

- [ ] **Step 6: Run doc vocabulary scan**

Run:

```bash
rg -n "workspaceDir|/workspace" AGENTS.md CLAUDE.md docs packages
```

Expected remaining matches are only:

```text
OpenClaw SDK compatibility notes
historical docs explicitly marked legacy
older completed plan files under docs/superpowers/plans
test fixture comments that intentionally mention rejected legacy input
```

- [ ] **Step 7: Run targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts docs/reference/configuration/system-json.md docs/architecture/storage-model.md docs/architecture/storage-matrix.md docs/architecture/openclaw-gateway.md docs/subsystems/controller.md docs/getting-started/openclaw-guide.md docs/reference/gondolin/vfs-rootfs-performance.md AGENTS.md CLAUDE.md
git commit -m "docs: explain tool work mount defaults" -m "Update generated defaults and docs to describe workMountDir as the lease-selected backing directory for Tool VM /work, while keeping /workspace retired." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Type Sweep And Exhaustive Compilation

**Files:**
- Modify any remaining TypeScript files reported by `rg` or `pnpm typecheck`.

- [ ] **Step 1: Sweep source vocabulary**

Run:

```bash
rg -n "workspaceDir|WorkspaceDir|lease-workspace|LeaseWorkspace" packages
```

Expected allowed source matches:

```text
packages/openclaw-agent-vm-plugin/... comments or boundary params that refer to OpenClaw SDK workspaceDir
tests that assert old workspaceDir is rejected
```

No `packages/agent-vm/src/controller/**` runtime field should still be named `workspaceDir`.

- [ ] **Step 2: Typecheck**

Run:

```bash
pnpm typecheck
```

Expected: pass.

- [ ] **Step 3: Lint types**

Run:

```bash
pnpm lint:types
```

Expected: pass. If OXC reports unsafe casts or implicit `any`, fix with explicit interfaces, `satisfies`, or Zod-derived types.

- [ ] **Step 4: Commit**

Only commit if type/lint fixes were needed:

```bash
git add packages
git commit -m "chore: finish work mount type sweep" -m "Complete the TypeScript cleanup after the lease workMountDir hard cutover." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Full Verification

**Files:**
- No planned code changes.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts packages/agent-vm/src/controller/leases/agent-sandbox-seeding.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts packages/agent-vm/src/cli/init-command.test.ts
```

Expected: pass.

- [ ] **Step 2: Run repo quality gate**

Run:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm check
```

Expected: all pass with exit code 0.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short --branch
git diff --stat origin/master...HEAD
rg -n "workspaceDir|/workspace" AGENTS.md CLAUDE.md docs packages
```

Expected:

```text
status shows only committed branch differences
diff is limited to lease naming, docs/defaults, and related tests
remaining workspaceDir matches are intentional OpenClaw SDK boundary notes,
legacy rejection tests, or old completed plans
```

- [ ] **Step 4: Final commit if verification changed files**

```bash
git add .
git commit -m "test: verify work mount naming cutover" -m "Capture any final fixture or formatting updates required by the full verification gate." -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Self-Review Notes

Spec coverage:

```text
Rename workspaceDir nomenclature      Task 1, Task 2, Task 3, Task 4, Task 5
Make it make sense                    Naming Model, Task 6 docs/defaults
Configs/defaults                      Task 6
No old /workspace mental model        Task 6, Task 7
Hard cutover                          Task 1 rejects old field
OpenClaw SDK boundary preserved       Task 4
Tests                                 Every task starts with failing tests
```

Out of scope:

```text
True fd-rooted/openat RealFS provider support.
This changes storage safety semantics, not lease naming.
```
