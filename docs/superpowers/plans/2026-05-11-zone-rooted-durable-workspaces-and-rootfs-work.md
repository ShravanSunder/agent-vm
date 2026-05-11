# Zone-Rooted Durable Workspaces And Rootfs Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-vm storage names match durability: zone data lives under `~/.agent-vm/zones/<zoneId>/`, durable workspace data is always called `workspace` from inside a VM, host collections of workspaces are always called `workspaces`, and VM-local hot scratch is always called `work`.

**Architecture:** This is a hard cutover of the storage vocabulary and OpenClaw Tool VM mount model. Host-side zones become `~/.agent-vm/zones/<zoneId>/{state,workspaces,runtime}`. Guest-side durable workspace mounts become `/workspace`; guest-side `/work` becomes rootfs/COW scratch everywhere. The OpenClaw SDK may still say `workspaceDir`; the agent-vm OpenClaw plugin translates that external SDK name into the controller's durable `workspaceMountDir`.

**Tech Stack:** TypeScript, Zod, Hono, Vitest, pnpm, OXC, OpenClaw sandbox backend, Gondolin RealFS mounts, Gondolin rootfs/COW.

---

## Non-Negotiable Naming Model

Use these meanings everywhere in this changeset.

```text
name             meaning                                      durability
──────────────   ──────────────────────────────────────────   ─────────────────────────────

zone             host/controller grouping                     container, not a guest mount

state            control state, sessions, identity, auth      durable, backed up

workspace        user/agent-authored files                    durable, backed up

work             VM-local execution area                      rootfs/COW, not durable

tmp              tiny guest memory scratch                    tmpfs, not durable

runtime          operational recovery/log/git metadata        host-visible, not normal backup

cache            rebuildable images/dependency cache          host-visible, not backup
```

Host naming is plural when a directory contains many workspaces. Guest naming is
singular when the VM is handed one active workspace mount.

```text
host:
  zones/<zoneId>/workspaces

OpenClaw gateway VM:
  /workspace/agents/<agentId>

OpenClaw Tool VM:
  /workspace
```

This matches upstream OpenClaw sandbox vocabulary: `workspaceAccess: "rw"`
mounts the writable agent workspace at `/workspace`, and workspace skills are
readable from `/workspace/skills`.

Forbidden after this cutover:

```text
/zone as an OpenClaw guest workspace mount
/work as a durable Tool VM workspace mount
zoneFilesDir as the OpenClaw durable workspace config field
workMountDir as the controller field for durable workspace mounts
```

Allowed after this cutover:

```text
/workspace   durable RealFS workspace mount
/work        rootfs/COW scratch/cache/work area
/tmp         guest tmpfs only
```

`/workspace` must never be mounted from a host path that is not already scoped by
zone id. The path backing it must resolve under:

```text
~/.agent-vm/zones/<zoneId>/workspaces
```

## Target Host Layout

```text
~/.agent-vm/
  cache/
    gateway-images/
    tool-vm-images/
    gateways/

  zones/
    <zoneId>/
      state/
        effective-openclaw.json
        gateway-runtime.json
        agents/<agentId>/agent/auth-profiles.json
        agents/<agentId>/sessions/
        skills/
        plugin-skills/
        sandboxes/

      workspaces/
        agents/<agentId>/
          AGENTS.md
          SOUL.md
          USER.md
          IDENTITY.md
          TOOLS.md
          skills/
          .agents/skills/

      runtime/
        logs/
        zone-git/
        worker-tasks/
        recovery/

~/.agent-vm-backups/
  <zoneId>/
```

`cache/` stays top-level because it is shared rebuildable cache. Backups stay outside the live runtime tree so a mistaken live-tree wipe does not delete the recovery archive.

## Zone Segregation Rules

Every durable host path owned by a zone must include that zone id before the
durability bucket.

```text
good:
  ~/.agent-vm/zones/sunfam/state
  ~/.agent-vm/zones/sunfam/workspaces
  ~/.agent-vm/zones/sunfam/runtime

bad:
  ~/.agent-vm/state/sunfam
  ~/.agent-vm/workspaces/sunfam
  ~/.agent-vm/runtime/zones/sunfam
  ~/.agent-vm/workspaces
```

The scaffolded user-dir layout must put the zone id first:

```text
~/.agent-vm/zones/<zoneId>/{state,workspaces,runtime}
```

Custom deployments may choose a different absolute root, but each configured
zone still needs its own non-overlapping `stateDir`, `workspacesDir`, and
`runtimeDir`. Validation should reject overlaps both inside a zone and across
zones. A zone may share top-level `cacheDir` with other zones because cache is
rebuildable and explicitly not backup state.

## Target Guest Layouts

OpenClaw gateway VM:

```text
/home/openclaw/.openclaw/state       RealFS -> host zones/<zoneId>/state
/workspace                           RealFS -> host zones/<zoneId>/workspaces
/work/tmp                            rootfs/COW
/work/cache                          rootfs/COW
/tmp                                 guest tmpfs
```

Keep `OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state` for upstream OpenClaw compatibility. Do not use `/zone` as the durable workspace mount after this cutover.

OpenClaw Tool VM:

```text
/workspace                           RealFS -> selected durable workspace mount
/work/tmp                            rootfs/COW
/work/cache                          rootfs/COW
/tmp                                 guest tmpfs
```

For normal sandbox leases, `/workspace` in the Tool VM is the selected active
workspace itself, not the whole zone `workspacesDir`. Example:

```text
gateway VM path requested by OpenClaw:
  /workspace/agents/shravan

host path after controller validation:
  ~/.agent-vm/zones/sunfam/workspaces/agents/shravan

Tool VM mount:
  /workspace
```

That mirrors OpenClaw's normal Docker sandbox model, where the sandbox sees the
agent workspace at `/workspace` rather than seeing the operator's entire
workspace collection.

Worker gateway VM:

```text
/state                               RealFS -> host zones/<zoneId>/state
/work/repos/<repoId>                 rootfs/COW
/work/tmp                            rootfs/COW
/work/cache                          rootfs/COW
/gitdirs/<repoId>.git                RealFS -> host zones/<zoneId>/runtime
/tmp                                 guest tmpfs
```

Worker repo files are still only durable after commit/push/export. If uncommitted worker edits must survive VM teardown, that is a separate worker recovery feature.

## Skill Ownership Model

OpenClaw skill roots after the path cutover:

```text
OpenClaw path                         host path
────────────────────────────────      ─────────────────────────────────────────────

<workspace>/skills                    zones/<zone>/workspaces/agents/<id>/skills
<workspace>/.agents/skills            zones/<zone>/workspaces/agents/<id>/.agents/skills
~/.agents/skills                      not mounted by default
~/.openclaw/skills                    zones/<zone>/state/skills
~/.openclaw/plugin-skills             zones/<zone>/state/plugin-skills
skills.load.extraDirs                 only paths explicitly mounted into gateway VM
```

Policy:

```text
agent-authored:
  <workspace>/skills
  v2 should route this through Skill Workshop pending approval.

operator/shared:
  <state>/skills
  <workspace>/.agents/skills

OpenClaw-generated:
  <state>/plugin-skills
```

Do not add `skills.load.extraDirs` for the normal zone layout. It is only useful for an additional mounted directory.

## Data-Loss Rule

Migration must be copy-and-verify, not move-and-delete.

```text
1. inventory old paths
2. create target paths
3. copy old -> new preserving metadata and symlinks
4. verify manifests
5. update config
6. boot and health-check
7. keep old paths untouched as rollback evidence
```

Do not delete legacy `~/.agent-vm/state`, `~/.agent-vm/zone-files`, or `~/.agent-vm/runtime` in this plan. A cleanup command can be designed later after at least one successful backup/restore cycle.

## Resolved Contract Decisions

These decisions are fixed for this plan. Do not leave them as implementation
questions.

```text
lease API:
  Hard-cut controller POST /lease from workMountDir to workspaceMountDir in
  this changeset. OpenClaw SDK workspaceDir is translated only at the plugin
  boundary.

normal Tool VM lease:
  Mount the selected active durable workspace at /workspace.
  Leave /work on rootfs/COW.

zone-git Tool VM lease:
  Mount the whole zone workspacesDir at /workspace so zone Git can commit the
  full zone workspace collection.
  Mount zone Git metadata at /agent-vm/zone-git.
  Return the agent workdir as the matching child under /workspace, for example
  /workspace/agents/<agentId>.

worker task durability:
  Worker repo files remain durable only after commit/push/export.
  Migration requires zero active worker tasks and no active Tool VM leases.
  Periodic worker recovery export is a separate future feature.

skills:
  <workspace>/skills remains agent-authored in v1.
  Approval-gated skill editing is deferred to the separate v2 permissions plan.
```

---

## File Responsibility Map

```text
packages/gateway-interface/src/gateway-lifecycle.ts
  Owns the gateway lifecycle contract.
  Remove BuildGatewayVmSpecOptions.runtimeDir and expose OpenClaw
  gateway.workspacesDir plus per-zone gateway.runtimeDir.

packages/agent-vm/src/config/system-config.ts
  Owns system config schema and path overlap validation.
  Hard-cut top-level runtimeDir and OpenClaw zoneFilesDir out of the target model.
  Add per-zone gateway.runtimeDir and OpenClaw gateway.workspacesDir.

packages/agent-vm/src/controller/controller-runtime.ts
  Owns threading loaded config into gateway lifecycles, Tool VM creation,
  leases, zone-git, worker task runtime, and controller routes.
  Stop passing top-level runtimeDir into zone-owned consumers.

packages/agent-vm/src/backup/backup-create-operation.ts
packages/agent-vm/src/backup/backup-restore-operation.ts
packages/agent-vm/src/backup/backup-manager.ts
packages/agent-vm/src/cli/backup-commands.ts
  Own backup create/restore/archive CLI wiring.
  Hard-cut archive entry zone-files/ to workspaces/ and restore into
  gateway.workspacesDir.

packages/agent-vm/src/cli/init-command.ts
  Owns scaffolded path defaults.
  Generate ~/.agent-vm/zones/<zone>/{state,workspaces,runtime}.
  Generate OpenClaw workspaces under /workspace/agents/<id>.

packages/openclaw-gateway/src/openclaw-lifecycle.ts
  Owns OpenClaw gateway VM mounts and environment.
  Mount workspacesDir at /workspace.
  Keep /work unmounted so /work/tmp and /work/cache are rootfs/COW.

packages/worker-gateway/src/worker-lifecycle.ts
  Already uses /work as rootfs/COW.
  Update host runtime path inputs from system runtimeDir to zone gateway.runtimeDir.

packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts
  Rename conceptually to lease-workspace-mount-paths.ts.
  Replace /zone allowed root with /workspace.
  Return guest workspace paths under /workspace, not /work.

packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts
  Mount selected durable RealFS path at /workspace.
  Leave /work available as rootfs/COW.
  Bootstrap /work/tmp and /work/cache plus environment variables for SSH commands.

packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts
packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts
  Translate OpenClaw SDK workspaceDir to controller workspaceMountDir.
  Expect controller response workdir /workspace or /workspace/<child>.

AGENTS.md
CLAUDE.md
  Owns the first progressive-disclosure definition agents read in this repo.
  Add a short storage vocabulary that points to storage-model, storage-matrix,
  mode-specific gateway docs, and generated deployment manuals.

docs/architecture/storage-model.md
docs/architecture/storage-matrix.md
docs/architecture/overview.md
docs/architecture/openclaw-gateway.md
docs/architecture/agent-worker-gateway.md
docs/subsystems/controller.md
docs/reference/gondolin/vfs-rootfs-performance.md
docs/reference/configuration/system-json.md
docs/README.md
docs/getting-started/openclaw-guide.md
packages/agent-vm/src/cli/manual-templates.ts
  Replace the old /zone + /work durable mount vocabulary with the new model.
```

---

### Task 1: Freeze The New Vocabulary In Tests

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
- Modify: `packages/worker-gateway/src/worker-lifecycle.test.ts`

- [ ] **Step 1: Update lease path tests to reject `/zone`**

Change tests that currently expect `/zone/project` to resolve successfully. The new successful durable workspace path is:

```ts
workspaceMountDir: '/workspace/project'
```

Add a rejection case:

```ts
await expect(
	resolveLeaseWorkspaceMountDir({
		runtimeDir: '/runtime',
		workspaceMountDir: '/zone/project',
		zone,
	}),
).rejects.toThrow(/must be under .*\\/workspace/u);
```

- [ ] **Step 2: Update Tool VM mount tests**

The durable mount assertion should become:

```ts
expect(createManagedVm).toHaveBeenCalledWith(
	expect.objectContaining({
		vfsMounts: {
			'/workspace': {
				hostPath: realWorkspaceMountDir,
				kind: 'realfs',
				pinnedHostRoot: expect.objectContaining({
					realPath: realWorkspaceMountDir,
				}),
			},
		},
	}),
);
expect(capturedCreateVmOptions?.vfsMounts).not.toHaveProperty('/work');
```

- [ ] **Step 3: Assert Tool VM scratch environment**

Add expectations that Tool VM startup prepares rootfs scratch:

```ts
expect(exec).toHaveBeenCalledWith(
	expect.stringContaining('mkdir -p /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv'),
);
expect(exec).toHaveBeenCalledWith(expect.stringContaining('TMPDIR=/work/tmp'));
```

- [ ] **Step 4: Run focused tests and confirm failure**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/worker-gateway/src/worker-lifecycle.test.ts
```

Expected: failures show the old `/zone` and durable `/work` assumptions.

### Task 2: Hard-Cut System Config Paths

**Files:**
- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/cli/commands/init-definition.ts`
- Modify: `packages/agent-vm/src/cli/commands/paths-definition.ts`

- [ ] **Step 1: Change config schema names**

Target config shape:

```jsonc
{
  "cacheDir": "~/.agent-vm/cache",
  "zones": [
    {
      "id": "sunfam",
      "gateway": {
        "type": "openclaw",
        "stateDir": "~/.agent-vm/zones/sunfam/state",
        "workspacesDir": "~/.agent-vm/zones/sunfam/workspaces",
        "runtimeDir": "~/.agent-vm/zones/sunfam/runtime",
        "backupDir": "~/.agent-vm-backups/sunfam"
      }
    }
  ]
}
```

For worker zones:

```jsonc
{
  "gateway": {
    "type": "worker",
    "stateDir": "~/.agent-vm/zones/coding-agent/state",
    "runtimeDir": "~/.agent-vm/zones/coding-agent/runtime"
  }
}
```

- [ ] **Step 2: Remove target-schema use of top-level `runtimeDir`**

Code that currently reads `systemConfig.runtimeDir` for zone-specific artifacts should read:

```ts
zone.gateway.runtimeDir
```

Keep `cacheDir` top-level.

The lifecycle interface should no longer accept top-level `runtimeDir`:

```ts
export interface BuildGatewayVmSpecOptions {
	readonly controllerPort: number;
	readonly gatewayCacheDir: string;
	readonly projectNamespace: string;
	readonly resolvedSecrets: Record<string, string>;
	readonly tcpPool: {
		readonly basePort: number;
		readonly size: number;
	};
	readonly zone: GatewayZoneConfig;
}
```

Post-cutover OpenClaw zone gateway contract:

```ts
interface OpenClawGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'openclaw';
	readonly runtimeDir: string;
	readonly workspacesDir: string;
	readonly authProfilesByAgent?: Readonly<
		Record<string, OnePasswordGatewayAuthProfilesRef | EnvironmentGatewayAuthProfilesRef>
	>;
}
```

Post-cutover worker zone gateway contract:

```ts
interface WorkerGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'worker';
	readonly runtimeDir: string;
}
```

- [ ] **Step 3: Rename `zoneFilesDir` to `workspacesDir`**

Every OpenClaw zone reference should use:

```ts
zone.gateway.workspacesDir
```

Do not keep a compatibility shim in the target code. This is a hard cutover.

- [ ] **Step 4: Update scaffold defaults**

User-dir scaffold must emit:

```ts
cacheDir: '~/.agent-vm/cache',
gatewayStateDir: (zoneId) => `~/.agent-vm/zones/${zoneId}/state`,
gatewayWorkspacesDir: (zoneId) => `~/.agent-vm/zones/${zoneId}/workspaces`,
gatewayRuntimeDir: (zoneId) => `~/.agent-vm/zones/${zoneId}/runtime`,
gatewayBackupDir: (zoneId) => `~/.agent-vm-backups/${zoneId}`,
```

- [ ] **Step 5: Add zone path isolation validation**

The default user-dir scaffold is zone-rooted, but validation must protect custom
configs too. Add tests that reject:

```text
same-zone overlaps:
  gateway.stateDir overlaps gateway.workspacesDir
  gateway.stateDir overlaps gateway.runtimeDir
  gateway.workspacesDir overlaps gateway.runtimeDir

cross-zone overlaps:
  zone A stateDir overlaps zone B stateDir
  zone A workspacesDir overlaps zone B workspacesDir
  zone A runtimeDir overlaps zone B runtimeDir
  any zone durable/runtime path overlaps another zone durable/runtime path

top-level cache overlap:
  cacheDir overlaps any zone stateDir/workspacesDir/runtimeDir
```

Do not require custom paths to literally live under `~/.agent-vm/zones`; do
require them to be explicit, per-zone, and non-overlapping. Generated user-dir
paths remain the opinionated default.

- [ ] **Step 6: Run config and init tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts
```

Expected: all updated schema/scaffold tests pass.

### Task 3: Change OpenClaw Gateway Durable Workspace Mount

**Files:**
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Replace `/zone` with `/workspace` in the gateway VM spec**

The OpenClaw gateway VM should mount:

```ts
'/workspace': {
	hostPath: zone.gateway.workspacesDir,
	kind: 'realfs',
}
```

It should not mount `/zone`.

- [ ] **Step 2: Keep `/work` unmounted**

Assert:

```ts
expect(vmSpec.vfsMounts['/work']).toBeUndefined();
```

The gateway bootstrap should still create:

```text
/work/tmp
/work/cache/npm
/work/cache/pnpm/store
/work/cache/pip
/work/cache/uv
```

- [ ] **Step 3: Change OpenClaw default workspaces**

Generated OpenClaw config should become:

```ts
workspace: '/workspace/agents/default'
```

Agent list entries should become:

```ts
workspace: `/workspace/agents/${agentId}`
```

- [ ] **Step 4: Run OpenClaw gateway tests**

Run:

```bash
pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts packages/agent-vm/src/cli/init-command.test.ts
```

Expected: gateway mount tests and scaffold tests pass.

### Task 4: Change Tool VM Durable Mount From `/work` To `/workspace`

**Files:**
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
- Modify: `packages/agent-vm/src/controller/zone-git/zone-git-paths.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
- Rename: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts` -> `packages/agent-vm/src/controller/leases/lease-workspace-mount-paths.ts`
- Modify all imports of the renamed file.

- [ ] **Step 1: Rename lease vocabulary**

Use these internal names:

```ts
workspaceMountDir       // gateway VM path requested by OpenClaw/plugin
hostWorkspaceMountDir   // controller-trusted host path
guestWorkspaceDir       // Tool VM path, usually /workspace
```

- [ ] **Step 2: Map gateway `/workspace` to host `workspacesDir`**

Allowed durable workspace root:

```ts
const OPENCLAW_WORKSPACE_VM_ROOT = '/workspace';
```

Allowed sandbox root remains:

```ts
const OPENCLAW_STATE_SANDBOXES_VM_ROOT = '/home/openclaw/.openclaw/state/sandboxes';
```

- [ ] **Step 3: Mount selected durable workspace at `/workspace`**

Tool VM VFS mount should be:

```ts
vfsMounts = {
	'/workspace': {
		hostPath: hostWorkspaceMountDirectory,
		kind: 'realfs',
		pinnedHostRoot: pinnedWorkspaceMountRoot,
	},
};
```

- [ ] **Step 4: Preserve zone-git as a whole-zone workspaces mount**

For normal leases, `/workspace` is the selected active workspace. For zone-git
special leases, `/workspace` is the whole zone `workspacesDir`, and the returned
workdir is the selected child under it.

Rename the zone-git mount type:

```ts
export interface ZoneGitToolVmMount {
	readonly hostWorkspacesDir: string;
	readonly hostZoneGitRoot: string;
}
```

In the zone-git branch of Tool VM creation, mount:

```ts
vfsMounts = {
	[OPENCLAW_ZONE_GIT_GUEST_ROOT]: {
		hostPath: hostZoneGitRoot,
		kind: 'realfs',
		pinnedHostRoot: pinnedZoneGitRoot,
	},
	'/workspace': {
		hostPath: hostWorkspacesDirectory,
		kind: 'realfs',
		pinnedHostRoot: pinnedWorkspacesRoot,
	},
};
```

Do not keep `/zone` as a guest mount.

- [ ] **Step 5: Bootstrap rootfs `/work` scratch for Tool VMs**

After VM creation and before returning the lease, run:

```sh
mkdir -p /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv
cat >/etc/profile.d/agent-vm-work-env.sh <<'ENVEOF'
export TMPDIR=/work/tmp
export TMP=/work/tmp
export TEMP=/work/tmp
export npm_config_cache=/work/cache/npm
export pnpm_config_store_dir=/work/cache/pnpm/store
export PIP_CACHE_DIR=/work/cache/pip
export UV_CACHE_DIR=/work/cache/uv
ENVEOF
```

This makes SSH-launched tool commands inherit the scratch/cache contract.

- [ ] **Step 6: Run Tool VM and lease tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts \
  packages/agent-vm/src/controller/leases/lease-workspace-mount-paths.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: all pass with durable workspace mounted at `/workspace` and rootfs scratch under `/work`.

### Task 5: Update OpenClaw Plugin Boundary

**Files:**
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts`

- [ ] **Step 1: Keep OpenClaw SDK compatibility at the edge**

OpenClaw may still call the selected sandbox path `workspaceDir`. Translate at the plugin boundary:

```ts
workspaceMountDir: params.workspaceDir
```

Do not let SDK vocabulary leak into controller internals.

- [ ] **Step 2: Update controller request type**

Controller lease requests should send:

```ts
{
	agentWorkspaceDir: request.agentWorkspaceDir,
	profileId: request.profileId,
	scopeKey: request.scopeKey,
	workspaceMountDir: request.workspaceMountDir,
	zoneId: request.zoneId,
}
```

- [ ] **Step 3: Expect `/workspace` in lease responses**

Tests that currently expect:

```ts
workdir: '/work'
```

should expect:

```ts
workdir: '/workspace'
```

or a child such as:

```ts
workdir: '/workspace/agents/shravan'
```

- [ ] **Step 4: Run plugin tests**

Run:

```bash
pnpm vitest run \
  packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
  packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts \
  packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: all pass with `/workspace` as the durable Tool VM workdir.

### Task 6: Update Runtime Path Consumers

**Files:**
- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`
- Modify: `packages/agent-vm/src/controller/zone-git/zone-git-paths.ts`
- Modify: `packages/agent-vm/src/controller/worker-task-runner.ts`
- Modify: `packages/agent-vm/src/cli/backup-commands.ts`
- Modify: `packages/agent-vm/src/cli/backup-commands.test.ts`
- Modify: `packages/agent-vm/src/backup/backup-manager.ts`
- Modify: `packages/agent-vm/src/backup/backup-manager.test.ts`
- Modify: `packages/agent-vm/src/backup/backup-create-operation.ts`
- Modify: `packages/agent-vm/src/backup/backup-create-operation.test.ts`
- Modify: `packages/agent-vm/src/backup/backup-restore-operation.ts`
- Modify related tests under `packages/agent-vm/src/**`

- [ ] **Step 1: Change zone Git paths to per-zone runtime**

Instead of:

```ts
path.join(systemConfig.runtimeDir, 'zones', zoneId, 'zone-git')
```

use:

```ts
path.join(zone.gateway.runtimeDir, 'zone-git')
```

- [ ] **Step 2: Change gateway logs to per-zone runtime**

Instead of:

```ts
path.join(runtimeDir, 'zones', zone.id, 'logs')
```

use:

```ts
path.join(zone.gateway.runtimeDir, 'logs')
```

- [ ] **Step 3: Change worker task runtime to per-zone runtime**

Instead of:

```ts
path.join(systemConfig.runtimeDir, 'worker-tasks', zoneId, taskId)
```

use:

```ts
path.join(zone.gateway.runtimeDir, 'worker-tasks', taskId)
```

- [ ] **Step 4: Keep backups scoped to durable state and workspaces**

OpenClaw backup archive layout becomes:

```text
state/
workspaces/
manifest.json
```

Do not archive `runtime/` or `cache/`.

Hard-cut backup create and restore together. Do not produce archives that
restore still expects as `zone-files/`.

```ts
// create
await execFileAsync('cp', [
	'-a',
	options.workspacesDir,
	path.join(stagingDirectory, 'workspaces'),
]);

const tarEntries =
	options.workspacesDir !== undefined
		? ['state', 'workspaces', 'manifest.json']
		: ['state', 'manifest.json'];
```

```ts
// restore
await copyExtractedDirectoryContents(
	path.join(extractDirectory, 'workspaces'),
	options.workspacesDir,
);
```

Update backup result names and test fixtures from `zoneFilesDir` to
`workspacesDir`. Worker zones do not have `workspacesDir`; their backups include
`state/` and `manifest.json` only.

- [ ] **Step 5: Update zone-git whole-workspaces special lease**

Zone-git remains a whole-zone workspace collection operation. Replace old
`zoneFilesDir` naming, but preserve the whole-tree behavior:

```ts
const zoneGitPaths = resolveZoneGitPaths({
	runtimeDir: zone.gateway.runtimeDir,
	zoneId: zone.id,
});

const zoneGitMount = {
	hostWorkspacesDir: zone.gateway.workspacesDir,
	hostZoneGitRoot: zoneGitPaths.hostZoneGitRoot,
};
```

In Tool VM creation, the zone-git branch should mount:

```ts
vfsMounts = {
	'/agent-vm/zone-git': {
		hostPath: hostZoneGitRoot,
		kind: 'realfs',
		pinnedHostRoot: pinnedZoneGitRoot,
	},
	'/workspace': {
		hostPath: hostWorkspacesDirectory,
		kind: 'realfs',
		pinnedHostRoot: pinnedWorkspacesRoot,
	},
};
```

The lease response workdir for a zone-git lease should be the matching child
under `/workspace`, such as `/workspace/agents/shravan`, not `/workspace` root.

- [ ] **Step 6: Run backup and zone-git tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/backup \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/operations/zone-git-doctor.test.ts \
  packages/agent-vm/src/cli/zone-git-commands.test.ts
```

Expected: all pass with `workspacesDir` and per-zone `runtimeDir`.

### Task 7: Write The Manual Data Migration Runbook

**Files:**
- Create: `docs/wip/debugging/2026-05-11-zone-rooted-storage-migration-runbook.md`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Write the no-delete runbook**

The durable file move is intentionally manual and operator-assisted. Do not add
an automatic migration command in this plan. The runbook must include this exact
migration policy:

```text
No legacy directory deletion in the migration.
No move-only migration.
Manual copy, verify, config cutover, boot check, then keep legacy paths.
```

- [ ] **Step 2: Define source and target paths**

The runbook must split OpenClaw zones from Worker zones.

For each OpenClaw zone:

```text
old state              ~/.agent-vm/state/<zone>
old workspaces         ~/.agent-vm/zone-files/<zone>
old gateway runtime    ~/.agent-vm/runtime/zones/<zone>
old worker-task runtime ~/.agent-vm/runtime/worker-tasks/<zone>

new state              ~/.agent-vm/zones/<zone>/state
new workspaces         ~/.agent-vm/zones/<zone>/workspaces
new runtime            ~/.agent-vm/zones/<zone>/runtime
```

For each Worker zone:

```text
old state              ~/.agent-vm/state/<zone>
old gateway runtime    ~/.agent-vm/runtime/zones/<zone>
old worker-task runtime ~/.agent-vm/runtime/worker-tasks/<zone>

new state              ~/.agent-vm/zones/<zone>/state
new runtime            ~/.agent-vm/zones/<zone>/runtime
```

Worker zones do not have `workspacesDir`; do not invent a workspaces directory
for them. The migration must require zero active worker tasks and no active Tool
VM leases before copying runtime paths.

- [ ] **Step 3: Require pre-copy and post-copy manifests**

The runbook must record a manifest before and after manual copy:

```text
path
type
mode
size
mtime
sha256 for regular files
symlink target for symlinks
```

- [ ] **Step 4: Add explicit manual copy guidance**

The runbook should describe the safe operator workflow without deleting the
source paths:

```text
1. stop the zone gateway
2. confirm there are no active Tool VM leases and no active worker tasks
3. generate source manifests
4. create the new target directories
5. copy state, OpenClaw workspaces when present, and runtime with metadata preserved
6. copy both legacy runtime roots when present:
   ~/.agent-vm/runtime/zones/<zone>
   ~/.agent-vm/runtime/worker-tasks/<zone>
7. generate target manifests
8. compare manifests
9. update config paths
10. start the zone gateway
11. verify OpenClaw, Tool VM leases, skills, and sessions for OpenClaw zones
12. verify worker task acceptance/status for Worker zones
13. leave old paths untouched for rollback
```

Use `rsync` examples only as examples for the future operator session; do not
run them as part of this implementation plan.

- [ ] **Step 5: Add a smoke check**

After config cutover:

```bash
config_path=/path/to/system.jsonc
zone_id=sunfam

pnpm agent-vm validate --config "$config_path"
pnpm agent-vm paths show --config "$config_path" --sizes

pnpm agent-vm controller start --config "$config_path" --zone "$zone_id" \
  > /tmp/agent-vm-controller-start.json \
  2> /tmp/agent-vm-controller-start.log &
controller_pid=$!

sleep 5
controller_port="$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('/tmp/agent-vm-controller-start.json','utf8')); console.log(p.controllerPort)")"
curl -fsS "http://127.0.0.1:${controller_port}/health"
curl -fsS "http://127.0.0.1:${controller_port}/zones/${zone_id}/health"

pnpm agent-vm controller stop --config "$config_path"
```

Expected: OpenClaw gateway starts, `/workspace/agents/<agentId>` exists, and `plugin-skills` remains visible under state.

### Task 8: Update Documentation And Generated Manuals

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/architecture/storage-matrix.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/architecture/agent-worker-gateway.md`
- Modify: `docs/subsystems/controller.md`
- Modify: `docs/reference/gondolin/vfs-rootfs-performance.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/getting-started/openclaw-guide.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Add the short definition to `AGENTS.md` and `CLAUDE.md`**

Insert this section immediately after `## Agent Orientation`, before the
progressive-disclosure reading list in both root agent instruction files:

```markdown
### Storage Vocabulary

Use these definitions before changing cache, state, workspace, work, runtime, or backup behavior:

- `state`: durable zone control state under `gateway.stateDir`; default user-dir path is `~/.agent-vm/zones/<zoneId>/state`; included in backups.
- `workspaces`: durable user/agent-authored zone files under `gateway.workspacesDir`; default user-dir path is `~/.agent-vm/zones/<zoneId>/workspaces`; included in backups.
- `/workspace`: guest RealFS mount for durable workspace data. The OpenClaw gateway VM sees the zone workspace collection at `/workspace`; normal OpenClaw Tool VM leases see the selected active workspace mounted at `/workspace`.
- `/work`: guest rootfs/COW scratch for hot, disposable execution work such as worker repos, package-manager cache, scripts, and temp files that should not survive VM teardown unless explicitly exported.
- `/tmp`: guest tmpfs for tiny process-local temporary files.
- `runtime`: host-visible operational metadata under `gateway.runtimeDir`; default user-dir path is `~/.agent-vm/zones/<zoneId>/runtime`; not part of normal backups.
- `cache`: rebuildable top-level artifacts under `cacheDir`; default user-dir path is `~/.agent-vm/cache`; not part of backups.

Progressive disclosure for storage questions:

1. Read this section for vocabulary.
2. Read `docs/architecture/storage-model.md` for the canonical durability and backup model.
3. Read `docs/architecture/storage-matrix.md` for concrete host and guest paths.
4. Read `docs/architecture/openclaw-gateway.md` or `docs/architecture/agent-worker-gateway.md` for mode-specific behavior.
5. Read generated `docs/manual/runtime-paths.md` in a deployment repo for operator-facing path guidance.
```

In the existing `## Layout` section, replace the legacy paragraph that says
Tool VMs always see the selected mount at `/work` with the new terms in both
files:

```markdown
Storage boundaries are load-bearing. Durable zone state belongs in
`gateway.stateDir`, durable user/agent-authored files belong in
`gateway.workspacesDir`, and zone runtime metadata belongs in
`gateway.runtimeDir`. Rebuildable artifacts belong in `cacheDir` and must not be
made backup state just to survive a copy-on-write VM reboot. See
`docs/architecture/storage-model.md` before moving generated files between repo
config, state, workspaces, runtime, cache, or backup directories.

Lease path vocabulary is intentionally layered; see
[Lease Path Vocabulary](docs/architecture/storage-model.md#lease-path-vocabulary)
before renaming or threading these fields. OpenClaw SDK `workspaceDir` exists
only at the plugin boundary and must be translated immediately to controller
`workspaceMountDir`. The controller validates that requested gateway VM path,
maps it to `hostWorkspaceMountDir`, and Tool VMs see the selected durable mount
at `/workspace`. `/work` is rootfs/COW scratch, not durable workspace data.
```

- [ ] **Step 2: Replace the old path summary across docs**

Every doc should express this model:

```text
host zone root:
  ~/.agent-vm/zones/<zone>/{state,workspaces,runtime}

guest durable workspace:
  /workspace

guest rootfs work:
  /work
```

- [ ] **Step 3: Update docs in progressive-disclosure order**

Update docs from broad to narrow so agents encounter the same model everywhere:

```text
1. AGENTS.md
2. CLAUDE.md
3. docs/README.md
4. docs/architecture/storage-model.md
5. docs/architecture/storage-matrix.md
6. docs/architecture/overview.md
7. docs/architecture/openclaw-gateway.md
8. docs/architecture/agent-worker-gateway.md
9. docs/subsystems/controller.md
10. docs/reference/configuration/system-json.md
11. docs/reference/gondolin/vfs-rootfs-performance.md
12. docs/getting-started/openclaw-guide.md
13. packages/agent-vm/src/cli/manual-templates.ts
14. packages/agent-vm/src/cli/manual-templates.test.ts
```

- [ ] **Step 4: Remove stale target vocabulary**

Run:

```bash
rg -n "/zone|zoneFilesDir|workMountDir|hostWorkMountDir|/home/openclaw/zone-files|/home/openclaw/workspace" AGENTS.md CLAUDE.md docs packages/agent-vm/src/cli/manual-templates.ts
```

Expected: remaining matches are either migration notes, historical references, or explicit "legacy before cutover" mentions.

- [ ] **Step 5: Regenerate manual smoke output**

Run the built CLI manual update smoke in a temporary directory after build:

```bash
pnpm build
tmpdir="$(mktemp -d)"
pnpm agent-vm init --type openclaw --paths user-dir --zone sunfam --agents shravan --output "$tmpdir"
pnpm agent-vm manual update --config "$tmpdir/config/system.jsonc"
rg -n "/workspace|/work|zones/sunfam" "$tmpdir/docs/manual"
```

Expected: generated manuals mention `/workspace` for durable data and `/work` for rootfs scratch.

### Task 9: Full Verification Gate

**Files:**
- No new files beyond prior tasks.

- [ ] **Step 1: Run focused unit suites**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/worker-gateway/src/worker-lifecycle.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run integration smoke tests that exercise leases**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/integration-tests/live-sandbox-e2e.integration.test.ts \
  packages/agent-vm/src/integration-tests/openclaw-zone-git.smoke.test.ts
```

Expected: Tool VM leases mount durable workspace at `/workspace`; `/work` remains rootfs scratch.

- [ ] **Step 3: Run broad quality gate**

Run:

```bash
pnpm check
```

Expected: lint, typecheck, tests, and package version sync checks pass.

---

## Decisions And Deferrals

Resolved in this plan:

```text
lease API rename:
  workMountDir -> workspaceMountDir happens in this changeset.

normal Tool VM lease:
  /workspace is the selected active durable workspace.

zone-git Tool VM lease:
  /workspace is the whole zone workspacesDir, with workdir set to the selected
  agent child under /workspace.

backup archive:
  OpenClaw backups use workspaces/, not zone-files/.

manual migration:
  copy-and-verify only; no legacy directory deletion.
```

Deferred:

```text
worker uncommitted repo recovery:
  no periodic export in this plan; commit/push/export remains the durability
  boundary.

skill approval/protection:
  v2 permissions plan; <workspace>/skills remains agent-authored in this plan.
```

## Self-Review

Coverage:

```text
zone-rooted host paths                  Task 2, Task 7, Task 8
/work rootfs invariant                  Task 3, Task 4, Task 8
/workspace durable invariant            Task 3, Task 4, Task 5, Task 8
OpenClaw skills placement               Skill Ownership Model, Task 8
AGENTS.md progressive disclosure        File Responsibility Map, Task 8
backup create/restore consistency       Task 6, Task 7
manual no-data-loss migration           Data-Loss Rule, Task 7
worker/gateway/tool consistency         Target Guest Layouts, Task 3, Task 4, Task 6
```

Known intentional deferral:

```text
persona edit gates                      separate plan
skill approval/protection v2            separate plan
worker uncommitted-file recovery         separate plan unless required before cutover
legacy directory deletion                explicitly out of scope
automatic durable-file migration command explicitly out of scope
```
