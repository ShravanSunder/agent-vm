# Root-Derived Gateway-Zone Storage Contract

Status: Accepted for implementation
Date: 2026-07-22
Scope: Host storage-root authorship, deterministic Gateway-zone placement, controller and zone runtime ownership, configuration hard cut, and focused proof expectations

## Product Intent

An Agent VM controller deployment has one operator-selected host storage root. The controller derives every standard operational storage path from that root and validated Gateway-zone identities. Operators do not separately author cache, controller-state, controller-runtime, Gateway state, zone-files, or zone runtime paths.

This contract serves operators and deployment agents who need to answer, from the path alone:

- which controller deployment owns the data;
- which Gateway zone owns the data;
- whether the data is durable, runtime-only, rebuildable, or controller authority;
- whether it belongs in a normal zone backup; and
- whether any Gateway or Tool VM may see it.

Success means moving a deployment requires changing one root, every derived path is deterministic, and no downstream framework or plugin becomes a second host-layout authority.

## Decision Summary

The sole authored operational storage root is `storageRootDir`.

For a canonical root `<storageRootDir>` and validated Gateway zone `<zoneId>`, Agent VM derives:

```text
<storageRootDir>/
├── cache/                                  global rebuildable cache
├── controller-state/                       global durable controller authority
│   └── zones/<zoneId>/
├── controller-runtime/                     global controller-owned runtime
│   ├── vm-ownership/
│   ├── controller-health/
│   └── observability/<projectNamespace>/
└── <zoneId>/                               one Gateway zone
    ├── state/                              durable framework state
    ├── zone-files/                         durable zone/agent files when supported
    │   └── agents/<agentId>/
    └── runtime/                            zone-owned runtime, excluded from backup
        ├── logs/
        ├── gitdirs/agents/<agentId>/
        │   └── workspace.git
        ├── worker-tasks/
        └── control-sessions/
```

The internal `controllerRuntimeDir` means the derived `<storageRootDir>/controller-runtime` root. The internal `zoneRuntimeDir` means the derived `<storageRootDir>/<zoneId>/runtime` root. The explicit names identify different owners and must not be represented by one overloaded path.

The flat root namespace is intentional. `cache`, `controller-state`, and `controller-runtime` are reserved and invalid as zone IDs.

## Authority And Supersession

This specification supersedes the following parts of the accepted July 17 storage contract and July 20 wrap-up contract:

- independent authored `cacheDir`, `controllerStateDir`, and `runtimeDir`;
- independently authored `zones[].gateway.stateDir` and managed-Gateway `zones[].gateway.zoneFilesDir`;
- host placement under storage-class-first roots such as `state/<zoneId>`, `zone-files/<zoneId>`, `runtime/zones/<zoneId>`, and `runtime/worker-tasks/<zoneId>`; and
- July 17 requirement R19 only where it preserves those authored roots and host placements.

It does not supersede their storage-class ownership, durability, guest mount, backup membership, per-agent workspace, Git authority, Tool VM replacement, framework-state, controller-state, or Tool Portal contracts.

After implementation, permanent architecture and configuration documents become the canonical operational references again. They must describe this layout without retaining the superseded topology.

## Terminology

### Controller deployment

One running Agent VM controller configuration and its exclusively owned `storageRootDir`. Two independent controller deployments must not concurrently use the same canonical storage root.

### Gateway zone

The configuration unit identified by `zones[].id`. OpenClaw, Hermes, and Worker are Gateway types hosted by zones. The validated zone ID is the only input used to select the zone directory.

### Storage root

The operator-authored `storageRootDir`. It is a derivation namespace, not a mount, backup member, cleanup target, or capability granted to a VM.

### Zone root

The exact derived child `<storageRootDir>/<zoneId>`. It groups the zone's storage classes but is not itself mounted or treated as one durability class.

### Controller runtime

Controller-deployment operational data under `<storageRootDir>/controller-runtime`, including the controller ownership lock, controller-wide health evidence, and generated observability runtime files. It is non-authoritative: the ownership lock provides live mutual exclusion, while health and observability files provide diagnostic or generated operational evidence. It is excluded from backup and does not replace durable controller-state records.

### Zone runtime

Runtime data owned by exactly one zone under `<storageRootDir>/<zoneId>/runtime`, including zone logs, workspace Git databases, Worker task runtime, and zone-local control-session material.

## Authored Configuration Contract

The hard-cut system configuration shape uses schema version 2:

```jsonc
{
  "$schema": "./schemas/system.schema.json",
  "schemaVersion": 2,
  "storageRootDir": "~/.agent-vm",
  "zones": [
    {
      "id": "beta",
      "gateway": {
        "type": "openclaw",
        "config": "./gateways/beta/openclaw.json"
      }
    }
  ]
}
```

`storageRootDir` supports the existing absolute, config-relative, and home-relative path syntax. When omitted, it defaults to `~/.agent-vm`. Generated scaffolds always emit the selected root explicitly so the deployment location is inspectable.

Scaffold path profiles remain convenience choices and emit one root:

```text
local       storageRootDir resolves to <deploymentProjectRoot>/.agent-vm
user-dir    storageRootDir resolves to ~/.agent-vm
pod         storageRootDir resolves to /var/agent-vm
```

Independent controller deployments on one host must select distinct roots. A deployment-specific root such as `~/.agent-vm/shravan-claw-beta` is valid when multiple controllers coexist.

The authored schema rejects these superseded fields as unknown:

```text
cacheDir
controllerStateDir
runtimeDir
zones[].gateway.stateDir
zones[].gateway.zoneFilesDir
```

There is no alias, fallback, precedence rule, environment override, legacy mode, or mixed old/new configuration shape.

The existing optional `zones[].gateway.backupDir` remains independently authored because backup artifacts are a separate recovery domain and may need to survive loss of `storageRootDir`. Managed observability `host.observability.dataDir` also remains independent because it has its own durability and retention policy.

## Internal Resolved Storage Contract

Authored configuration and controller-resolved storage are different types. Config loading resolves and canonicalizes the storage root once, then produces an immutable storage projection:

```ts
interface ResolvedDeploymentStorage {
	readonly storageRootDir: string;
	readonly cacheDir: string;
	readonly controllerStateDir: string;
	readonly controllerRuntimeDir: string;
	readonly zonesById: ReadonlyMap<string, ResolvedZoneStorage>;
}

interface ResolvedZoneStorage {
	readonly zoneId: string;
	readonly zoneRootDir: string;
	readonly stateDir: string;
	readonly zoneFilesDir?: string;
	readonly zoneRuntimeDir: string;
}
```

The interfaces above describe the required path meanings; they are not a requirement to introduce a new storage subsystem or public abstraction. Implementation reuses the existing loaded-configuration and controller-composition shapes where practical, computes the derived leaves at that existing boundary, and preserves downstream concrete-path contracts. A small type split or helper is allowed only where the authored and loaded shapes must differ; it must not trigger a wholesale consumer refactor.

The following semantic distinctions remain mandatory:

- `controllerRuntimeDir` is controller-deployment-owned;
- `zoneRuntimeDir` is zone-owned;
- Worker zones have no active `zoneFilesDir` capability;
- resolved leaves are controller-authored values, never authored config overrides; and
- downstream consumers receive only the narrow leaf paths they own.

Framework lifecycle packages, Gateway Runtime, Tool Portal, plugins, and managed VM adapters do not receive `storageRootDir` and do not reconstruct host paths.

## Ownership Contract

### Global storage

```text
<storageRootDir>/cache
  owner        build, image, and dependency cache subsystems
  durability   rebuildable
  VM access    only through existing narrow cache behavior
  backup       excluded

<storageRootDir>/controller-state
  owner        host controller
  durability   durable controller authority across controller restarts
  contents     approvals, Gateway identity/cleanup records, Tool lease records,
               Worker task identity/cleanup records
  VM access    forbidden
  backup       excluded from normal zone backup

<storageRootDir>/controller-runtime
  owner        controller deployment operational subsystems
  authority    non-authoritative; never replaces controller-state records
  durability   recreated operational files plus retained diagnostic evidence
  contents     ownership lock, health event log, generated observability files
  VM access    forbidden as a broad root
  backup       excluded
```

### Per-zone storage

```text
<storageRootDir>/<zoneId>/state
  owner        selected Gateway/framework
  durability   durable
  VM access    existing framework-specific state mount
  backup       included

<storageRootDir>/<zoneId>/zone-files
  owner        managed zone and long-lived agents
  durability   durable RealFS
  VM access    Gateway /zone where applicable; selected Tool VM child /workspace
  backup       included for OpenClaw and Hermes

<storageRootDir>/<zoneId>/runtime
  owner        runtime subsystems acting for one zone
  durability   subtree-specific; never normal backup input
  contents     logs, workspace Git databases, Worker task runtime,
               zone-local control-session material
  VM access    only established narrow projections such as logs or /gitdirs
  backup       excluded
```

Workspace Git databases remain agent-lifetime resources despite living under zone runtime. Gateway restart, Tool VM replacement, lease release, ordinary stop, log cleanup, and cache cleanup never delete them.

## Spec Boundary And Separability Map

```text
human-authored system.jsonc
  owns: storageRootDir, zone IDs, desired Gateway configuration
  excludes: derived operational storage leaves
                         |
                         v
agent-vm config/storage-layout authority
  owns: root resolution, deterministic derivation, reserved names
  exposes: immutable global and per-zone resolved storage leaves
                         |
          +--------------+----------------+
          |              |                |
          v              v                v
controller owners   Gateway mapping   backup manager
  exact global and    exact leaf        state + managed
  zone authority      capabilities      zone-files only
          |              |
          |              v
          |         Gateway lifecycle / managed VM composition
          |              |
          +--- never ---> storageRootDir or sibling-zone authority
```

The config/storage-layout boundary is the only topology owner. Downstream code receives exact leaf paths; framework packages, plugins, Tool Portal, Gateway Runtime, and VMs never derive from or receive the storage root or a sibling zone.

## Runtime Classification

The current mixed runtime tree is split by ownership, not by filename alone.

Controller-owned runtime moves under `<storageRootDir>/controller-runtime`:

```text
vm-ownership/controller-ownership.lock
controller-health/events.jsonl
observability/<projectNamespace>/docker-compose.observability.yml
observability/<projectNamespace>/otel-collector-config.yaml
```

Zone-owned runtime moves under `<storageRootDir>/<zoneId>/runtime`:

```text
logs/
gitdirs/agents/<agentId>/workspace.git
worker-tasks/<taskId>/...
control-sessions/...
other runtime material whose trusted owner is exactly one zone
```

No code appends `zones/<zoneId>` to a `zoneRuntimeDir`; that namespace has already been selected. No controller-runtime artifact is placed under an arbitrary zone.

## Filesystem And Security Invariants

1. Resolve `storageRootDir` with the existing absolute, config-relative, and home-relative path behavior.
2. Derive every child from fixed literal segments and schema-validated identifiers only.
3. Reserve `cache`, `controller-state`, and `controller-runtime` as invalid zone IDs.
4. Each zone root is one exact child of the storage root; `state`, `zone-files`, and `runtime` are exact children of that zone root.
5. Preserve the existing canonical-path, symlink, containment, and mount checks at the operations that already enforce them. This storage reorganization introduces no new filesystem authority or revalidation subsystem.
6. Never mount, back up, delete, or expose `storageRootDir`, a whole zone root, controller-state, or a sibling zone as a broad capability.
7. One controller deployment exclusively owns one resolved storage root through the existing controller ownership lock.
8. Zone destruction keeps its current behavior and changes only to consume the new derived zone leaves. It does not gain ownership of controller-state, global cache, controller-runtime, backups, observability data, or sibling zones.

## Guest And Framework Contracts Preserved

This host-layout change does not alter:

- OpenClaw Gateway state paths or its `/zone` mount;
- Hermes direct `stateDir` RealFS mount;
- managed Tool VM `/workspace`, rootfs/COW `/work`, or conditional `/gitdirs`;
- Worker `/state`, `/work/repos`, `/gitdirs`, or reserved empty `/workspace`;
- per-agent workspace selection and identity binding;
- Tool Portal, Gateway Runtime, controller control links, SSH, lease, or replacement architecture;
- controller HTTPS Git push authority; or
- backup archive member names and additive restore behavior.

Only the host source paths backing those existing contracts change.

## Backup And Restore Contract

A zone directory is an ownership container, not one backup unit. Normal backup selects members explicitly:

```text
OpenClaw/Hermes
  include  <zoneRoot>/state
  include  <zoneRoot>/zone-files
  exclude  <zoneRoot>/runtime

Worker
  include  <zoneRoot>/state
  exclude  <zoneRoot>/runtime
  no active zone-files member
```

Global cache, controller-runtime, controller-state, backup artifacts, observability data, and configuration/catalog roots remain excluded.

The existing optional external `backupDir` remains the output authority. Archive format, encryption, naming, create/list behavior, and additive restore semantics do not change.

Restore targets the exact derived durable leaves. It never publishes runtime Git reconstruction, migrates old layouts, or treats the zone root as an atomic restore target.

## Configuration Hard Cut

System configuration schema version 2 accepts `storageRootDir` and rejects every superseded authored leaf field. Agent VM does not read the old shape, search old paths, copy data, transform directories, or provide compatibility or migration behavior.

## Requirements

R1. Schema version 2 authors only `storageRootDir` for standard operational storage and rejects the removed leaf fields.

R2. The existing absolute, config-relative, and home-relative resolution behavior produces the selected root; scaffolds emit that root explicitly.

R3. Cache, controller-state, controller-runtime, and every zone leaf derive exactly as shown in the decision tree, using only validated zone IDs and fixed segments.

R4. Existing consumers receive only their derived leaf paths. They never receive the storage root, reconstruct siblings, or append a second zone namespace.

R5. Implementation reuses existing loaded-config, composition, and concrete-path contracts where practical. It adds no new storage subsystem or wholesale consumer refactor.

R6. Existing filesystem checks and single-controller ownership remain at their current boundaries; no new filesystem authority mechanism is added.

R7. Existing Gateway, Tool VM, Worker, Tool Portal, Git, backup/restore, and zone-destruction behavior remains unchanged except for the host paths supplied to it.

R8. Worker still has no active `zone-files`; backup output and durable observability data remain independently configured.

R9. Version 2 has no old-layout reader, compatibility path, or migration behavior, and all maintained configuration/docs surfaces show the same new tree.

## Validation Boundary

This is a mechanical storage-path change. Validation is intentionally small:

- focused schema and path-derivation tests prove the exact tree and rejection of the removed fields;
- existing affected tests update their path fixtures and expectations, without adding new behavior scenarios; and
- the normal repository validation and existing beta OpenClaw/Hermes startup smoke confirm the reorganized paths work in the current runtime.

No new proof framework, lifecycle journey, migration test, backup test matrix, purge test matrix, mount test matrix, lease/replacement acceptance, or unrelated Tool Portal E2E is required by this specification.

## Non-Goals

- Renaming `zone-files` or changing per-agent workspace contents.
- Changing Gateway or Tool VM guest paths.
- Changing backup archive format, encryption, create/list behavior, or additive restore semantics.
- Moving durable Victoria observability data into the storage root.
- Giving operators per-leaf path overrides or path templates.
- Supporting two configuration path models simultaneously.
- Introducing migration code, compatibility handling, a coordinator, supervisor, state machine, receipt protocol, or recovery subsystem.
- Introducing a new storage subsystem, broad ownership abstraction, or wholesale downstream consumer refactor.
- Changing Tool Portal, Gateway Runtime, controller control links, SSH, lease, replacement, or Git push architecture.
- Changing Gondolin or upstream OpenClaw/Hermes.
- Reorganizing source modules merely to satisfy historical file-size targets.

## Accepted Tradeoffs

Gain:

- one operator-owned storage location;
- deterministic ownership visible from paths;
- no per-field topology drift or precedence rules;
- simpler deployment relocation, inspection, purge, and documentation; and
- a smaller configurable host-path attack surface.

Cost:

- cache, controller runtime, framework state, and zone runtime share one filesystem ancestor;
- operators lose independent per-leaf placement through Agent VM configuration;
- multiple controllers on one host must select distinct storage roots;
- flat zone placement reserves global sibling names; and
- old configurations are rejected without compatibility behavior.

Independent child mountpoints remain a host-operations option, but Agent VM does not model or authorize them as per-leaf configuration.

## Open Decisions

None required for implementation planning. The contract fixes:

- `storageRootDir` as the authored field;
- global `controllerRuntimeDir` at `<storageRootDir>/controller-runtime`;
- per-zone `zoneRuntimeDir` at `<storageRootDir>/<zoneId>/runtime`;
- flat zone roots directly below the storage root;
- independent backup and observability destinations; and
- a schema-version-2 hard cut without compatibility behavior.
