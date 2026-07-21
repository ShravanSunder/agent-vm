# Agent VM Storage Layout And Agent Workspace Contract

Status: Accepted storage substrate; partially superseded for Tool VM `/agent-vm`, Hermes projection details, and backup/restore proof
Date: 2026-07-17
Scope: Host storage classes, per-agent durable workspaces, managed Tool VM and Worker guest paths, optional per-agent workspace Git, fresh Tool VM replacement, and framework-specific projections

The focused completion contract in
`docs/specs/2026-07-20-tool-portal-pr-wrapup/2026-07-20-tool-portal-pr-wrapup.md`
supersedes this document where they differ. In particular, Hermes version 1
selects the complete already-isolated per-agent source root without inventing a
child-path allowlist; managed Tool VMs expose no generic `/agent-vm` surface
until an exact generated inventory and owner exist; and simple backup plus
additive restore are required beta proof without restore publication machinery.

## Decision Summary

Agent VM separates durable agent-authored files, fast VM-local execution data, Git metadata, framework state, controller authority, rebuildable cache, runtime evidence, and backup artifacts by ownership and lifetime.

The managed Tool VM contract is:

```text
/workspace   selected agent's filtered durable workspace
/work        fast disk-backed rootfs/COW data for the Tool VM lifetime
/gitdirs     optional selected agent workspace Git database
/tmp         guest tmpfs for small temporary files and sockets
/agent-vm    reviewed read-only generated runtime inputs
```

`/workspace` and `/gitdirs` are controller-selected capabilities. `/work` is not a host mount. A Tool VM never receives a whole zone, a sibling agent workspace, a sibling Git database, framework-private state, or controller authority.

An unhealthy Tool VM is replaced from the configured trusted image while preserving the selected
`/workspace` and optional `/gitdirs/workspace.git` resources. The controller never checkpoints or
resumes the unhealthy predecessor and does not automatically reconstruct project worktrees.
Process state, installed packages, build output, untracked files, and uncommitted `/work` changes
are intentionally discarded.

The Worker VM uses the same path vocabulary where the storage category exists:

```text
/workspace   reserved empty rootfs/COW directory; no current workspace authority
/work        fast disk-backed rootfs/COW task work
/gitdirs     selected task repository Git databases
/agent-vm    reviewed read-only generated runtime inputs
/state       Worker task plumbing with separate task-lifetime semantics
```

Reserving `/workspace` in a Worker VM does not make it a durable workspace, a VFS mount, or an
agent-facing persistence promise. The directory exists so a later Worker redesign can activate the
same category without claiming that current Worker tasks already have a long-lived agent
workspace. Until that redesign, Worker repositories remain under `/work/repos`.

Each configured long-lived agent owns one durable workspace at:

```text
<zoneFilesDir>/agents/<agentId>/
```

That workspace is live-durable across Gateway and Tool VM replacement. Git is optional and configured per agent:

```text
absent   no workspace Git database or .git pointer
local    isolated local Git database; history is host-local
remote   isolated local Git database plus controller-authenticated remote push
```

The existing zone-wide `gateway.zoneGit` repository is retired. No compatibility path retains a whole-zone writable Git authority.

## Product Intent

This contract serves three related needs without collapsing them into one filesystem:

1. OpenClaw and other long-lived frameworks need durable user/agent-authored files that survive Gateway and Tool VM replacement.
2. Coding agents need rootfs/COW performance for source trees, dependency installs, searches, builds, tests, and disposable outputs.
3. Git metadata must remain host-visible so committed work can survive a Tool VM and be pushed by the controller without placing remote credentials in a VM.

Success means a maintainer can answer all of these questions from one contract:

- Who owns this directory?
- Which VM, if any, can see it?
- Can the agent mutate it?
- What backing store does it use?
- How long does it survive?
- Is Git history local-only or remotely recoverable?
- Which process may authorize a remote push?

## Historical Constraints

The design preserves the reasons the storage classes exist.

```text
RealFS OpenClaw workspace
  -> live durability across ephemeral Gateway VM lifecycles
  -> zone-files vocabulary separating durable files from hot execution data
  -> writable per-agent workspaces under zoneFilesDir
  -> optional Git history and controller-authenticated push
```

Git was not the original durability mechanism. `zoneFilesDir` remains durable and backed up when workspace Git is disabled.

Worker storage established a separate performance invariant:

```text
rootfs/COW worktree
  -> fast source reads and writes, installs, searches, builds, and tests

RealFS gitdir
  -> host-visible objects, refs, and index
  -> commit is the persistence boundary for project code
```

The managed Tool VM contract combines these ideas without pretending they are one storage class.

## Terminology

### Agent workspace

The durable, agent-authored filesystem owned by one configured long-lived agent. It contains framework-approved files such as instructions, identity, memory, persona, heartbeat material, authored skills, notes, or similar durable content.

An agent workspace does not contain controller records, credentials, sessions, framework databases, caches, dependency trees, build products, or arbitrary sibling-agent content.

### Workspace projection

The controller-selected view of one agent workspace exposed to one managed Tool VM at `/workspace`.

The projection begins from the exact per-agent source directory. Framework-specific filtering, read-only nested projections, and ShadowProvider rules add defense in depth inside that source. A broad framework home plus a deny list is not a valid workspace projection.

### Reserved workspace path

An existing `/workspace` directory without an active workspace capability. Version 1 uses this
state only in Worker VMs. It is an empty rootfs/COW directory, has no VFS provider, is not included
in backup, and is not described to the agent as durable or authoritative. Presence of the path is
not equivalent to admission of a workspace projection.

### Hot work

Disk-backed rootfs/COW data under `/work`. It survives commands and process restarts while the Tool VM lives. It does not survive Tool VM close or replacement.

### Workspace Git database

The optional Git database for one durable agent workspace. The workspace contains a `.git` text pointer; the Git database itself lives under `runtimeDir` and is mounted into the selected Tool VM at `/gitdirs/workspace.git`.

### Framework state

Gateway-owned state such as auth profiles, sessions, internal databases, framework configuration, and protected framework-home content. Framework state belongs under `stateDir` or another established framework-owned subtree, not in an agent workspace merely because the framework can display it.

### Controller authority

Approval, lifecycle, lease, cleanup, ownership, and exact-process records owned by the host controller. Controller authority belongs under `controllerStateDir`, is never VM-mounted, and is never derived from rendered instructions or agent-writable Git state.

## Canonical Host Storage Classes

The following established folders retain their meanings.

```text
config/
  owner        operator
  purpose      authored desired state and prompts
  durability   durable source
  VM access    no broad source mount; only reviewed derived inputs
  backup       source-controlled/operator-managed, not runtime backup state

stateDir/
  owner        selected Gateway/framework
  purpose      framework identity, auth profiles, sessions, effective state,
               and established Gateway plumbing
  durability   durable
  VM access    Gateway-specific; never treated as controller authority
  backup       included in normal zone backup

controllerStateDir/
  owner        host controller
  purpose      approval, lifecycle, cleanup, Gateway records, Tool VM records
  durability   durable controller evidence
  VM access    forbidden in every Gateway and Tool VM
  backup       excluded from normal zone backup

zoneFilesDir/
  owner        long-lived zone/user/agents
  purpose      shared zone files plus agents/<agentId> durable workspaces
  durability   durable RealFS
  VM access    Gateway sees /zone; Tool VM sees one filtered agent child only
  backup       included in normal OpenClaw and Hermes zone backup

runtimeDir/
  owner        runtime subsystems
  purpose      logs, process artifacts, workspace Git databases, and other
               explicitly classified runtime data
  durability   subtree-specific
  VM access    only narrow selected projections such as /gitdirs
  backup       excluded unless a future version names a dedicated member

cacheDir/
  owner        build/image/package cache subsystem
  purpose      rebuildable images, packages, downloads, and build cache
  durability   rebuildable
  VM access    only where an existing lifecycle explicitly mounts it
  backup       excluded

backupDir/
  owner        backup subsystem
  purpose      encrypted backup artifacts
  durability   artifact retention policy
  VM access    forbidden
  backup       never recursively backed up
```

Changing the contents or backup meaning of these folders is outside this spec unless explicitly stated below.

## Canonical Host Directory Layout

```text
<zoneFilesDir>/
├── shared zone-authored files, when configured
└── agents/
    ├── alice/
    │   ├── .git                         optional pointer file
    │   ├── AGENTS.md
    │   ├── SOUL.md
    │   ├── MEMORY.md
    │   ├── memory/
    │   ├── skills/
    │   └── other framework-approved agent files
    └── bob/
        └── ...

<runtimeDir>/zones/<zoneId>/
├── logs/                                established Gateway logs
└── gitdirs/
    └── agents/
        ├── alice/
        │   └── workspace.git            optional agent workspace Git DB
        └── bob/
            └── ...

<stateDir>/
└── established Gateway/framework state

<controllerStateDir>/
└── zones/<zoneId>/...

<cacheDir>/
└── rebuildable artifacts

<backupDir>/
└── encrypted archives
```

Every `agentId` is validated before it participates in a path. Every source root is canonicalized and proven disjoint from `stateDir`, `controllerStateDir`, `cacheDir`, `runtimeDir` parents not explicitly selected, `backupDir`, sibling agents, and the deployment source tree.

The new workspace Git subtree has an explicit lifetime despite living under `runtimeDir`:

```text
resource        survives VM replacement   deletion authority
─────────────   ───────────────────────   ─────────────────────────────
workspace.git   yes; agent lifetime       explicit agent deletion or
                                         zone purge after containment
```

Gateway restart, Tool VM replacement, lease release, ordinary zone stop, cache cleanup, and log
cleanup never delete this Git database. Removing an agent from desired config stops new admission
but does not silently delete its last local history. An explicit destructive operation must prove
no Gateway or Tool VM can access the subtree, identify what will be lost, and then delete it. Zone
purge is that explicit destructive authority for the whole zone.

## Per-Agent Workspace Git Configuration

Workspace Git is configured on the agent that owns the workspace. `workspaceGit` belongs on each
entry in the zone-scoped `zones[].agents[]` cohort used by managed long-lived Gateway types. It is
not a top-level deployment field, a Gateway-global field, or valid for the current Worker zone
type. OpenClaw and Hermes both use the same placement and may configure multiple agents.

The hard-cut shape in its real container is:

```json
{
  "zones": [
    {
      "id": "my-zone",
      "agents": [
        { "id": "alice" },
        {
          "id": "bob",
          "workspaceGit": { "mode": "local" }
        },
        {
          "id": "charlie",
          "workspaceGit": {
            "mode": "remote",
            "remote": {
              "repoUrl": "https://github.com/example/charlie-agent-files.git",
              "branch": "agent/workspace",
              "defaultBranch": "main"
            }
          }
        }
      ]
    }
  ]
}
```

The configuration contract is strict:

```text
workspaceGit absent
  Git disabled; no Git database and no .git pointer

workspaceGit { mode: "local" }
  exactly these keys; unknown keys and remote fields are rejected

workspaceGit { mode: "remote", remote: { ... } }
  mode and remote are required; both objects reject unknown keys
  repoUrl                     required
  branch                      defaults to agent/workspace
  defaultBranch               defaults to main
```

There is no `{ "mode": "disabled" }` object and no implicit Git repository. Branch names and
patterns use the existing strict safe-ref rules. Remote mode accepts the existing controller
GitHub repository spellings, rejects embedded credentials, and normalizes them to a lower-case
`github.com/<owner>/<repo>` identity with a normalized safe branch. Duplicate normalized
`(repository identity, branch)` pairs are rejected within the complete deployment, not merely one
zone. The push branch may not equal the configured default branch.
Remote mode authorizes only the sanitized controller-owned HTTPS push path.
Tool VM Git SSH remains read-only: it may admit fetch through
`git-upload-pack` and rejects push through `git-receive-pack`.

`mode: "local"` creates an isolated local Git database and pointer but no controller push
capability.

`mode: "remote"` creates the same isolated local database and enables a controller-owned push
capability using the configured remote and branch over HTTPS. Credentials come
from the existing trusted host Git credential source and remain host-only;
per-agent credentials are not introduced here. Every remote push routes through
this controller operation; the Tool VM receives no alternate push transport.

Shared Git history between agents is outside this contract. The existing zone-wide
`gateway.zoneGit` field is rejected by static configuration validation after the hard cut. Its
remote, branch, Git database, mount, Gateway Control, Tool Portal, and framework consumers used by
the beta Gateways move to agent-keyed workspace Git.

## Managed Tool VM Guest Layout

```text
/
├── workspace/                         selected filtered durable workspace
│   └── .git                           optional pointer to /gitdirs/workspace.git
├── work/                              rootfs/COW, no VFS mount
│   ├── cache/
│   ├── builds/
│   ├── packages/
│   └── tmp/
├── gitdirs/                           selected RealFS Git database only
│   └── workspace.git                  only when workspaceGit is enabled
├── agent-vm/                          reviewed read-only generated inputs
└── tmp/                               guest tmpfs
```

### `/workspace`

- Uses an owned, controller-selected host directory capability.
- Is mounted through one backend-neutral filtered-workspace capability translated by the
  Gondolin adapter into existing RealFS, ShadowProvider, and nested read-only providers.
- Never accepts a model-, framework-, plugin-, or caller-supplied host path.
- Exposes only the selected agent's workspace source.
- May be broadly writable for OpenClaw agent-owned content.
- May be narrower for Hermes or another framework.
- May contain read-only nested managed-skill inputs when required by the framework.
- Must not depend on a deny list to separate controller or framework-private state; those files must live outside the source root.

The filtered-workspace capability has one controller-owned source and one controller-authored
projection policy:

```text
source
  one single-use OwnedHostDirectory for the canonical agent root
  canonical path is descriptive evidence, never caller authority

visibility
  whole-root writable, or a positive allowlist of relative paths
  a path outside a positive allowlist is hidden

overrides
  hidden paths
  nested read-only paths backed by owned or reviewed inputs
  explicitly writable paths inside an allowlisted projection

precedence
  hidden > read-only > writable
```

The controller selects the projection policy from the admitted Gateway kind, configured stable
agent identity, and reviewed deployment inputs. The framework plugin authenticates native agent or
profile origin, but it does not author, widen, or transmit filesystem policy. Model arguments,
framework callbacks, rendered instructions, and UDS requests never select a source, visibility
rule, override, or nested provider.

### Provider composition

The Gondolin adapter constructs `/workspace` in this order:

```text
single-use OwnedHostDirectory for one canonical agent workspace
  -> base RealFSProvider
  -> positive workspace projection, when the policy is allowlist-based
  -> ShadowProvider(writeMode = "deny") for reviewed hidden overrides
  -> ShadowProvider(writeMode = "tmpfs") for reviewed disposable overlays
  -> nested ReadonlyProvider-backed managed inputs
  -> one final /workspace provider transferred into VM creation
```

The positive projection and ShadowProvider have different responsibilities:

```text
positive projection
  decides which source paths exist in the Tool VM at all
  required for a narrower Hermes-style allowlist
  implemented inside this repository's Gondolin adapter boundary
  does not require an upstream Gondolin change

ShadowProvider deny override
  hides a reviewed path inside an already selected source
  read-like operations return ENOENT and readdir omits the entry
  writes fail with EACCES

ShadowProvider tmpfs override
  hides the host entry and allows VM-lifetime writes in a MemoryProvider upper
  useful for architecture-specific or disposable trees such as node_modules
  remains on the VFS path and is not the performance substitute for /work

nested read-only provider
  exposes a reviewed managed input at one exact destination
  cannot be replaced, renamed, removed, or shadowed by a writable child
```

ShadowProvider never establishes the primary sibling-agent, controller-state, credential, or
framework-private boundary. Those sources are absent before provider composition. A policy that
would need to hide an entire broad framework home is invalid; the controller must instead select
the canonical per-agent workspace source.

The adapter may implement the positive projection with a repository-owned provider wrapper or an
equivalent composition of existing provider primitives. The neutral `managed-vm` contract owns
the policy algebra and validation; only `gondolin-vm-adapter` sees Gondolin provider objects.

### Gateway-specific policy templates

Version 1 defines controller-owned templates rather than plugin-authored rules:

```text
OpenClaw
  source       canonical zoneFilesDir/agents/<agentId>
  visibility   whole agent workspace
  writable     agent-authored files allowed by OpenClaw workspace policy
  read-only    .git pointer; reviewed deployment-managed nested inputs
  hidden       reviewed overrides only; framework-private state is not in source
  tmpfs        only explicitly reviewed disposable overlays

Hermes
  source       canonical zoneFilesDir/agents/<agentId>
  visibility   positive allowlist of framework-approved agent-owned paths
  writable     approved portable agent-authored files and notes
  read-only    .git pointer; reviewed deployment-managed nested inputs
  hidden       native Hermes memories, skills, soul/profile files, and every
               other source entry outside the positive allowlist
  tmpfs        only explicitly reviewed disposable overlays

Worker
  source       none in version 1
  visibility   none
  backing      empty rootfs/COW /workspace directory; no VFS provider
  authority    none; current repos remain under /work/repos
```

Exact OpenClaw and Hermes path sets are materialized from strict controller-owned framework
policy, not discovered from the live framework home. Adding a newly visible or writable category
is a policy-contract change with schema, unit, real-VM, and framework proof; it is not a plugin
implementation detail.

All policy paths are normalized workspace-relative paths. Absolute paths, traversal, symlink
escape, duplicate destinations, ambiguous same-precedence overlaps, writable children below a
read-only ancestor, and projections crossing the owned source boundary are rejected before VM
creation. The complete source and projection transfer exactly once into one VM creation attempt
and closes atomically on failure or teardown. There is no raw-host-path fallback. ShadowProvider
is defense in depth inside the already selected source; it is not the sibling-agent or secret
boundary.

"No Gondolin changes" means the upstream Gondolin package and semantics remain unchanged. The
backend-neutral `managed-vm` contract and this repository's Gondolin adapter may add the owned
filtered-workspace translation required to compose existing providers.

### `/work`

- Is an ordinary rootfs/COW directory, not a mount.
- Is writable by the agent.
- Is the default location for project worktrees, dependency trees, builds, large temporary files, and package caches.
- Survives only for the current Tool VM lifetime.
- Is recreated empty from the trusted image on Tool VM replacement; the agent may recreate project
  worktrees as needed.
- Does not promise recovery of uncommitted, untracked, installed, built, or cached content.

### `/gitdirs`

- Contains only the optional workspace Git database selected for the current stable agent principal.
- Is writable by the agent because normal Git operations mutate objects, refs, and index state.
- Is untrusted input when consumed by the controller.
- Never exposes the zone Git parent, another agent's workspace Git, controller credentials, or
  arbitrary host paths.

### `/agent-vm`

- Contains reviewed, controller-generated runtime facts and resources.
- Is read-only.
- Is not a durable agent workspace.
- Does not contain raw credentials, host paths, controller records, or authorization decisions.
- May be delivered differently by frameworks that have native prompt or profile injection; the semantic facts remain controller-authored.

### Retired Tool VM paths

Managed Tool VMs do not expose durable `/agent`, durable `/work`, `/self`, or `/scratch` aliases. The cut is atomic across contracts, runtime mapping, documentation, generated instructions, fixtures, tests, and consumers.

This deliberately un-retires `/workspace` with a new, single meaning: the durable selected-agent
projection. Current managed OpenClaw semantics instead use RealFS `/work`, rootfs `/scratch`, and
reject `/workspace`; all three change together. At the OpenClaw plugin boundary, SDK
`workspaceDir` remains a Gateway path under `/zone/agents/<agentId>` and is validated only to
identify the configured agent. It immediately becomes an `agentId`-keyed capability request; it
does not cross Gateway Control as a host path or guest path. The current controller
`workMountDir`/`hostWorkMountDir` raw-path lease vocabulary is retired for managed-agent Tool VMs
and replaced by controller-selected workspace capability binding. Worker retains `/work/repos`,
`/gitdirs`, `/agent-vm`, and `/state` semantics while adding only the reserved empty `/workspace`
rootfs/COW directory.

## Framework Views

Gateway and Tool VMs receive independently authored Gondolin mount configurations. A framework
home or broad Gateway mount is never inherited by a Tool VM merely because both VMs serve the same
agent. Agent VM selects both configurations from the admitted Gateway kind and stable agent
identity.

```text
OpenClaw Gateway VM
  /zone              whole zoneFilesDir at its established path
  framework state    established stateDir-backed OpenClaw paths, unchanged
  /work              Gateway VM rootfs/COW only
  absent              Tool VM /workspace and /gitdirs capabilities

OpenClaw Tool VM for one agent
  /workspace         filtered zoneFilesDir/agents/<agentId>
  /work              Tool VM rootfs/COW
  /gitdirs           optional selected workspace Git database
  /agent-vm          reviewed read-only generated inputs
  absent             /zone, stateDir, controllerStateDir, and OpenClaw private state

Hermes Gateway VM
  Hermes root         complete default profile HERMES_HOME plus configured
                      profiles/<profileName> homes
  Gateway process     multiplexes the configured profiles
  /work               Gateway VM rootfs/COW only
  absent              Tool VM /workspace and /gitdirs capabilities

Hermes Tool VM for one agent
  /workspace         filtered zoneFilesDir/agents/<agentId>; native Hermes memories,
                     skills, soul/profile files, and HERMES_HOME content are absent
  /work              Tool VM rootfs/COW
  /gitdirs           optional selected workspace Git database
  /agent-vm          reviewed read-only generated inputs
  absent             HERMES_HOME, stateDir, controllerStateDir, sessions, credentials,
                     framework configuration, logs, caches, and databases
```

The Gateway configuration and Tool VM configuration are separate controller-authored inputs. The
framework plugin authenticates the native OpenClaw agent or Hermes profile and supplies its stable
identity; it does not copy Gateway mounts into the Tool VM or author filesystem policy.

### Tool execution locations

When a managed Tool Portal Capability API backend or direct SSH Sandbox API
operation executes in a Tool VM, both use the same selected-agent guest-path
contract. The request surfaces remain distinct through admission and converge
only at the current agent-specific Tool VM binding and ToolPortalService-owned
SSH connection:

```text
terminal, process, and non-local code execution
  selected Tool VM with default cwd /work

project worktrees, dependency installs, builds, and large temporary data
  /work

durable agent-authored file operations
  /workspace

optional workspace Git database
  /gitdirs/workspace.git

framework-native memory, skill, identity, and profile operations
  authoritative Gateway framework location; not a second Tool VM copy
```

An agent may name granted guest paths such as `/workspace` and `/work`; those are ordinary paths
inside its Tool VM. Neither a guest path nor a framework `workspaceDir` becomes host-path authority.

### OpenClaw Gateway

The long-lived OpenClaw Gateway VM retains its native `/zone` view of `zoneFilesDir`. It may host multiple configured agents and therefore does not use one global `/workspace` as its framework workspace.

For one selected agent's Tool VM:

```text
Gateway /zone/agents/<agentId>
  -> host <zoneFilesDir>/agents/<agentId>
  -> filtered Tool VM /workspace
```

OpenClaw keeps its native ordinary file behavior for memory, persona, heartbeat, authored files, and other workspace content. This spec does not introduce Agent VM-specific semantic memory or persona tools.

OpenClaw coding and filesystem tools may operate on both `/workspace` and `/work` according to framework policy. Runtime instructions must distinguish durable workspace edits from VM-lifetime repository/build data.

OpenClaw private auth profiles, sessions, internal databases, credentials, logs, and controller records do not enter `/workspace`.

The durable workspace `.git` pointer names the Tool VM `/gitdirs/workspace.git` projection. In the
Gateway `/zone` view it is opaque metadata and is not resolved by Gateway-host Git. Framework Git
work routes to the selected Tool VM; controller Git uses trusted explicit Git-directory/worktree
bindings and ignores the pointer as authority.
Inside that Tool VM, normal local branch, commit, merge, and fetch work remains
available, but Git SSH is fetch-only. Remote push is exposed only through the
controller-owned workspace push operation.

### Hermes Gateway

The Hermes Gateway VM retains the complete Hermes root: the default profile's `HERMES_HOME` and
every configured named profile home under `profiles/<profileName>`. Managed mode enables Hermes
profile multiplexing so one Gateway process can serve multiple configured agents while resolving
each invocation inside exactly one authenticated profile home. Each profile retains its own
configuration, memory, skills, soul/profile state, sessions, credentials, Gateway state, cron,
logs, caches, and databases.

The framework plugin supplies the authenticated Hermes `profileName`. The controller binds that
native identity to exactly one stable Agent VM `agentId`, profile-assignment revision, Tool Portal
profile, workspace capability, and selected Git capabilities. `agentId` and `profileName` are
distinct identifiers and are never assumed to have equal spelling. Native memory, skill,
soul/profile, and identity-management tools continue operating against the selected profile home
inside the Gateway VM.

Hermes may project only explicitly agent-owned, framework-approved portable files into
`/workspace`. Native Hermes memories, skills, soul/profile files, complete `HERMES_HOME`,
configuration, credentials, sessions, logs, caches, and databases are forbidden. Agent VM applies
the Hermes projection policy when constructing the Tool VM; Hermes does not reuse its Gateway
mount configuration for that VM.

Hermes `BaseEnvironment` terminal, file, process, and non-local code execution use the selected Tool VM. Project worktrees and hot execution data live under `/work`; admitted Git databases live under `/gitdirs`.

### Agent Worker Gateway

Worker keeps its current rootfs/COW worktrees under `/work/repos`, separate RealFS Git databases
under `/gitdirs`, generated read-only runtime inputs under `/agent-vm`, and task plumbing under
`/state`. Its task lifetime, teardown, commit boundary, and backup behavior remain distinct from a
long-lived managed Gateway.

Worker boot additionally creates an empty `/workspace` directory on rootfs/COW. It is not a VFS
mount, is not host-backed, is not durable, receives no workspace capability, and is not included
in backup. Current Worker instructions and repo placement continue to use `/work/repos`; the
reserved directory is not advertised as a current persistence surface.

A later Worker redesign may activate `/workspace` only by defining its source, durability,
visibility policy, authority, backup behavior, and migration. It may not silently reinterpret the
reserved rootfs directory as durable state.

## Runtime Filesystem Facts And Instructions

The controller owns normalized runtime filesystem facts:

```text
workspace path, access, backing, durability, and visible categories
workspace activation state: projected | reserved | absent
hot-work path, backing, and loss boundary
selected Git resource identities and guest paths
generated runtime-input path and access
available controller operations, Tool Portal capabilities, and SSH Sandbox API
operations
```

Framework-specific renderers translate those facts into native instruction surfaces:

```text
Worker     reserved /workspace fact plus runtimeInstructions and read-only /agent-vm files
OpenClaw   native workspace/bootstrap/prompt integration
Hermes     native profile/system-prompt integration
```

Renderers describe granted capabilities. They do not select mounts, widen authorization, resolve credentials, emit host paths, or turn instructions into authority.

## Lifecycle And Replacement

Each current Tool VM binding is agent-specific and contains:

```text
stable agent principal
workspace capability and exact directory identity
selected Git resource capabilities and exact directory identities
Tool VM generation
SSH generation and server identity
framework attachment generation
```

ToolPortalService uses that controller-authorized binding to proactively
establish and own one maintained SSH connection for exactly that agent.
Capability API backends that target the Tool VM and direct SSH Sandbox API
operations may share that connection only within the same binding and
generation. A connection, environment, process, stream, terminal, cwd,
filesystem handle, or retained result never crosses agents. Connection
readiness alone is not active use and does not prevent controller idle reap.
Agent-scoped connection, environment, process, stream, terminal,
filesystem-handle, and retained-result registries are fenced by the complete
principal, binding, and generation. Foreign-agent and stale-generation lookup,
status, wait, log, cancel, attach, and close fail closed.

Tool VM replacement prioritizes restoring agent tool access while preventing overlapping active
writers to the same persistent workspace or Git resources:

1. Retire the old lease from routing and reject every request carrying its stale generation.
2. Revalidate and acquire fresh successor capabilities for the selected `/workspace` and
   `/gitdirs` sources.
3. Begin exact-target old-VM termination and successor boot concurrently. Successor image
   preparation, VM creation, boot, SSH endpoint readiness, ToolPortalService establishment of the
   successor agent's maintained SSH connection, and agent-specific connection readiness may overlap
   old-VM teardown. The successor remains non-routable and does not mutate the selected persistent
   workspace or workspace Git resource during this overlap.
   Controller seeding/materialization and Git ref resolution that can read or write those resources
   also wait for the exact-process fence; this is sequencing inside the existing lease flow, not a
   new service or filesystem authority.
4. Terminate only the old VM's recorded exact process through the managed-VM boundary: request
   graceful termination, wait for a short bounded interval, then signal that same identity with
   `SIGKILL` only if it remains alive. Exact runner absence is the persistent-write fence. Old-VM
   Gondolin handle, provider, transfer, SSH, listener, record, and telemetry cleanup then continue
   concurrently. A per-VM teardown must never invoke a backend-global child kill that can terminate
   the Gateway VM, the successor, or sibling Tool VMs.
5. Before routing an agent request to the successor or admitting writes against selected persistent
   resources, prove the retired exact process is absent and continue rejecting its stale
   generation. Listener, provider, transfer, port, record, and telemetry disposal are cleanup, not
   additional admission gates or a separate controller service.
6. Finish required post-fence workspace and workspace-Git materialization, then route the agent to
   the successor. The controller performs no automatic project-worktree reconstruction.
7. Complete record deletion, logs, telemetry finalization, and other non-authoritative old-lease
   cleanup asynchronously; those tasks do not delay successor tool access.

The agent need not know that replacement occurred. It observes the same durable workspace and
optional workspace Git state. All `/work` content is lost.

Replacement does not wait for every old-lease cleanup effect. Its only admission gate is that the
retired VM is no longer an active writer or routable tool target for the selected agent. A stuck
graceful termination escalates only against the recorded exact process; it does not create a
second supervisor topology, invoke backend-global sibling cleanup, or indefinitely deny the agent
a replacement Tool VM.

This version has exactly one unhealthy-leaf replacement strategy:

```text
replacementStrategy = fresh-trusted-image

preserved
  /workspace
  optional /gitdirs/workspace.git and its Git state

recreated
  trusted-image VM, process identity, SSH identity, listener, and lease generation
  empty rootfs/COW /work

discarded
  predecessor rootfs/COW /work
  processes, RAM, sockets, streams, cwd, environment snapshots, and installed packages
  uncommitted, untracked, built, cached, or otherwise rootfs-only content
```

Checkpointing or resuming an unhealthy predecessor is outside this contract.

### Replacement observability

Every replacement emits one correlated trace and bounded transition logs that let an operator
reconstruct the complete handoff. Trace/log evidence includes:

```text
replacementId, traceId, zoneId, agentId, reason
old/new leaseId
old/new VM id and Tool VM generation
old/new TCP slot
replacementStrategy = fresh-trusted-image
workspacePreserved = true
workspaceGitPreserved = true
rootfsWorkPreserved = false
boot, access-fence, post-fence materialization, handoff, and cleanup durations
```

High-cardinality identities belong only in bounded traces and logs. Metrics use bounded labels such
as outcome, reason class, replacement strategy, and component kind; they never label `zoneId`,
`agentId`, lease/VM/generation IDs, TCP slots, paths, trace IDs, or replacement IDs. All
controller, ToolPortalService binding/connection, OpenClaw/Hermes, and Tool VM replacement signals
use the same configured OTEL sink and preserve cross-boundary trace context without treating it as
authority.

The evidence must prove these ordering and isolation invariants:

```text
successor.bootStartedAt       may precede predecessor.persistentAccessFencedAt
successor.persistentMaterializationStartedAt >= predecessor.persistentAccessFencedAt
successor.routedAt                 >= predecessor.persistentAccessFencedAt

no old-generation request succeeds after predecessor retirement
exactly one current route exists for each (zoneId, agentId)
post-fence predecessor cleanup failure does not unroute the successor
terminating the predecessor does not terminate the Gateway, successor, or sibling Tool VMs
```

## Git Trust And Controller Operations

Every agent-writable Git database is hostile input to the controller.

The controller:

- Derives Git directory, worktree, agent identity, remote, and branch from trusted configuration and current projection.
- Uses only the sanitized controller-owned HTTPS credential path for remote
  push; Tool VM Git SSH remains read-only.
- Ignores guest `.git` pointer content as authority.
- Binds push authorization to zone, agent, Git resource kind, repository identity, configured remote, configured branch, and expected head.
- Never accepts a host path, remote URL, branch policy, credential, or agent identity from a model request.
- Disables hooks and all executable or external-command Git configuration when invoking host Git.
- Prevents credential helpers, filters, external diff tools, filesystem monitors, alternates, and related repository-controlled execution from becoming controller code execution.
- Validates refs and object identities before and after mutation-sensitive operations.
- Serializes controller operations per Git resource while allowing unrelated agents and repositories to proceed independently.
- Scrubs credentials from errors, logs, telemetry, results, and archives.

This is a closed security contract, not a best-effort `core.hooksPath` override. Host Git runs
through a controller-owned sanitized repository view and controlled environment that does not load
agent-writable local, worktree, global, system, conditional-include, or included configuration.
The controller supplies the exact Git directory, worktree, object/ref inputs, remote, branch, and
credential transport it authorizes. At minimum it neutralizes hooks; aliases; pagers and editors;
credential helpers and askpass; `include`/`includeIf`; `url.*`; `remote.*` command overrides;
filters and text-conversion commands; diff/merge drivers; signing programs; filesystem monitors;
SSH commands; protocol helpers; alternates and object-directory indirection; and template or exec
paths. Ambient `GIT_*`, `SSH_*`, `HOME`, executable search path, and configuration environment
cannot widen the controlled invocation. Unknown future repository configuration is ignored by
construction rather than presumed safe.

The agent may corrupt its own workspace or selected Git databases. Protecting an agent from its own destructive authorized edits is not a security goal. Such corruption must not cross into controller execution or another agent.

## Existing Backup, Restore, And Legacy Data

The later Tool Portal wrap-up contract supersedes this section for backup and
restore. Backup remains a direct live copy of `stateDir` plus managed
`zoneFilesDir`; restore remains a simple additive copy. Both are beta proof
gates. Restore publication, transactional swap, runtime coordination, archive
conversion, Git reconstruction, and migration remain excluded.

## Security Context

### Assets

- Durable agent files and authored identity.
- Per-agent workspace Git history.
- Remote repository credentials.
- Encrypted backup archives.
- Framework auth/session state.
- Controller lifecycle and approval authority.

### Trust boundaries

```text
host config and controller authority
  -> exact canonical per-agent workspace capability
  -> exact selected Git capabilities
  -> rootfs/COW Tool VM

Gateway/framework identity
  -> stable controller-vetted agent principal
  -> one Tool VM projection

agent/model/tool code
  -> untrusted writes within granted workspace, work, and Git resources
```

The long-running Gateway VM remains trusted above individual Tool VMs and may see framework-required zone state. This spec does not claim protection from a compromised Gateway VM.

### Required negative invariants

- No sibling workspace or Git database is present in a Tool VM.
- No whole `zoneFilesDir` or `/zone` mount is present in an agent Tool VM.
- No `stateDir`, `controllerStateDir`, complete framework home, credential store, session database, cache parent, runtime parent, or backup directory is present.
- No raw remote credential enters a VM, image, Git config, archive, log, trace, metric, result, or generated instruction.
- No agent-controlled Git hook or executable Git configuration runs on the controller.
- No ShadowProvider deny list serves as the primary boundary around secrets or sibling files.
- No instruction renderer selects or widens authority.

## Requirements

R1. Every configured long-lived agent has exactly one canonical durable workspace under `zoneFilesDir/agents/<agentId>`.

R2. The workspace survives Gateway and Tool VM replacement independently of Git configuration.

R3. `zones[].agents[].workspaceGit` is a strict optional per-agent discriminated configuration;
absence, local, and remote have the exact schema and normalization semantics defined above.

R4. Enabled workspace Git uses one isolated Git database per agent and one `.git` pointer inside that agent's workspace.

R5. The existing whole-zone Git configuration, mount, authority, and compatibility behavior are rejected after cutover.

R6. A managed Tool VM exposes the selected agent workspace at `/workspace` through one
controller-owned filtered-workspace capability. The neutral policy defines positive visibility,
hidden, tmpfs, and nested read-only rules; the Gondolin adapter composes the positive projection,
ShadowProvider overrides, and read-only providers in the declared precedence order.

R7. `/work` is rootfs/COW and has no host VFS mount.

R8. `/gitdirs` exposes only the optional selected workspace Git database for the stable agent
principal.

R9. `/agent-vm` is read-only generated input and cannot carry authority or raw secrets.

R10. Tool VMs expose no durable `/agent`, durable `/work`, `/self`, `/scratch`, whole `/zone`, or compatibility aliases.

R11. OpenClaw retains native ordinary workspace file behavior against the durable `/workspace` projection.

R12. One managed Hermes Gateway may serve multiple configured profiles through native profile
multiplexing. Every invocation binds one authenticated `profileName` to one stable Agent VM
`agentId`; native profile state remains Gateway-owned, and only managed execution work routes to
that agent's Tool VM.

R13. Worker retains its current `/work/repos`, `/gitdirs`, `/agent-vm`, `/state`, task lifetime,
teardown, commit, and backup semantics, and additionally creates one empty reserved rootfs/COW
`/workspace` directory with no VFS mount, host backing, durability, current workspace authority,
or agent-facing persistence claim.

R14. Tool VM replacement retires the predecessor from routing immediately, overlaps safe successor
boot with predecessor teardown, and routes the agent to the successor as soon as the predecessor
can no longer receive requests or write the selected persistent workspace and Git resources.
Predecessor termination targets only its recorded exact process and escalates from graceful
termination to forced termination after a short bound; per-VM teardown never uses a backend-global
child kill. Non-authoritative cleanup continues asynchronously and does not delay replacement tool
access.

R15. Tool VM replacement performs no automatic project-worktree reconstruction and does not
promise any `/work` recovery.

R16. Controller Git operations derive all authority from trusted config and current principal binding, never from guest pointer content or caller paths.

R17. Superseded for backup proof by the Tool Portal wrap-up contract; simple
create/list/additive restore behavior remains unchanged.

R18. Superseded: beta acceptance requires simple backup and isolated additive
restore proof, but not archive conversion, migration, or restore publication.

R19. Existing `stateDir`, `controllerStateDir`, `runtimeDir`, `cacheDir`, `backupDir`, and config
ownership meanings remain unchanged except for the named per-agent Git subtree under `runtimeDir`
and the controller-state per-zone child hard cut from `gateways/<zoneId>` to `zones/<zoneId>`.

R20. Concrete Gondolin providers and handles remain confined to the Gondolin adapter and approved composition boundary.

R21. Framework-specific runtime instruction rendering describes immutable controller facts without selecting or widening capabilities.

R22. Every beta-used workspace, Git, Tool VM, Tool Portal, OpenClaw, and Hermes consumer moves to
the current contract. Unrelated administrative and historical consumers are not a beta gate.

R23. Legacy whole-zone Git migration and old-archive conversion are outside this contract.

R24. Host Git ignores agent-writable configuration and ambient Git/SSH
execution authority by construction through the sanitized repository-view
contract. Remote push uses only the controller-owned HTTPS credential path;
Tool VM Git SSH may fetch but rejects push.

R25. Unhealthy Tool VM replacement uses only the fresh-trusted-image strategy: the successor boots
from the configured trusted image, retains selected `/workspace` and optional
`/gitdirs/workspace.git` data, performs no automatic project-worktree reconstruction, and never
checkpoints or resumes predecessor rootfs state. Correlated shared-sink OTEL evidence proves
boot/teardown overlap, access-fence-before-persistent-write/routing, exactly one current route,
data survival/loss, and isolation from Gateway/successor/sibling termination.

## Separability Map

```text
operator configuration
  owns: desired agents, workspace Git modes, remotes, branch policy
  exposes: validated per-agent storage policy
            |
            v
controller storage authority
  owns: canonical host roots, owned directory capabilities, backup, Git push
  exposes: workspace + Git capability binding
            |
            v
managed-vm contracts
  owns: backend-neutral mount, rootfs, process, and lifecycle contracts
  exposes: filtered workspace and selected Git mount request
            |
            v
gondolin-vm-adapter
  owns: RealFS, ShadowProvider, ReadonlyProvider, rootfs/COW translation
  exposes: running managed VM only

framework adapter <---- private UDS ----> ToolPortalService
  owns: native-origin authentication      owns: controller relationship,
        and instruction delivery                Capability API,
                                                SSH Sandbox API,
                                                per-agent binding/SSH/status
             |                                      |
             +------ selected agent identity -------+
                                                    |
                                                    v
                                      current agent-specific binding
                                      maintained SSH connection
                                                    |
                                                    v
                                      selected agent's Tool VM
                                      /workspace /work /gitdirs
```

Gateway Runtime supplies the Gateway-local implementation mechanics inside
ToolPortalService's ownership boundary. It is not a second service owner,
request surface, or authority.

Gateway kind is an input to controller policy selection, not to the Gondolin provider API. The
controller resolves one strict OpenClaw, Hermes, or reserved-Worker policy before VM creation;
framework plugins authenticate identity but cannot widen that policy.

Allowed dependency direction is downward through these contracts. Frameworks
and controller domains do not import Gondolin filesystem objects.
ToolPortalService consumes only controller-authorized agent-specific bindings
and does not choose host paths. Rendered instructions do not authorize mounts
or Git operations.

## Alternatives Rejected

### Whole-zone Git retained beside per-agent Git

Rejected because it leaves two authorities, re-exposes sibling agent content, and makes backup/push status ambiguous.

### Durable `/agent` plus durable `/work`

Rejected because it invents a split not required by the frameworks, conflicts with rootfs hot-work performance, and creates atomic two-root coherence burden.

### All Tool VM files on RealFS

Rejected because it pays VFS overhead on source edits, installs, searches, builds, and tests.

### All Tool VM files on rootfs

Rejected because OpenClaw agent-authored memory, identity, persona, and related workspace files must survive without a Git commit or Tool VM lifetime.

### Shadow a broad framework home

Rejected because deny lists do not safely classify unknown future secrets and framework-private files. The source directory itself must already contain agent-owned content only.

### Back up local Git object databases in this version

Rejected to preserve the established archive boundary and avoid unbounded Git object growth in encrypted backups. Local mode restores files, not history; remote mode provides portable history.

## Non-Goals

- Reorganizing deployment roots under a future `deployments/<deployment>/zones/<zone>` hierarchy.
- Changing Gondolin.
- Redesigning Agent Worker lifecycle, repo placement, teardown, or `/state` exposure beyond
  reserving the empty rootfs/COW `/workspace` directory.
- Adding independently selectable per-agent backup, export, or restore; archives remain zone-wide.
- Preserving uncommitted `/work` content across Tool VM replacement.
- Giving controller authority to arbitrary guest-selected host paths, remotes, or repository
  attachments.
- Protecting an authorized agent from destructive edits to its own workspace or Git databases.
- Providing confidentiality from the host controller or a compromised Gateway VM.
- Moving protected OpenClaw or Hermes framework state into agent workspaces.
- Introducing Agent VM-specific OpenClaw memory, persona, or heartbeat tools.
- Maintaining aliases or compatibility readers for the retired path/config contract.
- Redesigning backup, restore, archive formats, legacy migration, or destructive administrative
  consumers.

## Proof Expectations

### Schema and structural proof

- Absent, exact-local, and exact-remote per-agent Git shapes validate strictly; defaults,
  normalization, configured-default-branch denial, unknown keys, embedded credentials, and duplicate normalized
  identities have positive and negative fixtures.
- Legacy whole-zone Git is rejected.
- Agent, workspace, Git, state, controller, runtime, cache, and backup roots are canonically disjoint.
- Filtered-workspace policy proves positive visibility, precedence, overlap rejection, nested
  read-only behavior, single-use ownership, and no raw-path fallback.
- Provider-composition proof distinguishes positive projection, ShadowProvider deny, ShadowProvider
  tmpfs, and nested read-only responsibilities; verifies their exact order; and proves no plugin,
  callback, instruction, model argument, or UDS request can author or widen policy.
- OpenClaw whole-workspace and Hermes positive-allowlist templates have strict positive/negative
  fixtures. Unknown categories and framework-home discoveries are not admitted implicitly.
- Concrete Gondolin imports remain confined to approved files.

### Host Git proof

- Two agents receive distinct workspace Git databases and cannot collide.
- Workspace `.git` pointers resolve to the selected guest Git path.
- Controller operations ignore pointer authority, ignore hostile repository/ambient configuration,
  and run through the sanitized repository view.
- Remote push binds exact agent, repository, expected head, remote, and branch,
  and uses only the controller-owned HTTPS credential path.
- Real Tool VM Git SSH permits `git-upload-pack` and rejects
  `git-receive-pack`; every remote push routes through the controller operation.
- Local mode has no push capability.

### Real VM proof

- `/workspace` is the selected filtered RealFS workspace.
- `/work` is rootfs/COW and disappears with Tool VM replacement.
- `/gitdirs` contains only selected Git databases.
- Denied paths, siblings, framework state, controller state, and whole-zone parents are absent.
- Capability API execution and direct SSH Sandbox API operations that target the Tool VM converge
  on ToolPortalService's maintained connection only after their distinct admission paths. They use
  only the current agent-specific binding and generation and reject cross-agent connection or
  handle reuse.
- Stale predecessor handles cannot mutate rebound persistent state.
- Replacement proof starts successor boot before predecessor teardown completes, rejects stale
  predecessor generations, escalates only against the predecessor's exact recorded process after a
  short graceful bound, and never routes both predecessor and successor as active writers to the
  same persistent workspace or Git resources.
- A stuck predecessor teardown does not terminate the Gateway VM, the booting successor, or any
  sibling Tool VM; no per-VM replacement path invokes a backend-global child kill.
- Shared-sink trace/log evidence carries the replacement cohort and duration fields above, proves
  fresh-trusted-image replacement without automatic project reconstruction, and establishes that
  successor persistent writes and routing occur no earlier than predecessor persistent-access
  fencing.

### Framework proof

- At least two OpenClaw agents preserve native workspace behavior, memory/core-file durability, per-agent isolation, and optional workspace Git.
- One multiplexed Hermes Gateway serves at least two configured profiles. Each authenticated
  `profileName` binds to its configured `agentId`, preserves native memory/skill behavior, exposes
  only approved durable files, and shares the common hot-work/Git execution contract without
  cross-profile leakage.
- Worker regression proof preserves its current rootfs `/work/repos`, RealFS `/gitdirs`, read-only
  `/agent-vm`, `/state`, task teardown, and commit behavior while proving `/workspace` exists as an
  empty rootfs/COW directory with no VFS mount, host backing, backup member, or current authority.
- Generated runtime facts distinguish available controller operations, Tool Portal capabilities,
  and SSH Sandbox API operations and match actual mounts, backing, durability, and admission.
- OpenClaw SDK `workspaceDir` resolves only to a configured agent identity and never crosses the
  controller boundary as raw `workMountDir`, `hostWorkMountDir`, or host-path authority.

### Beta acceptance

- Real OpenClaw and Hermes zones exercise the same storage vocabulary through their native framework paths.
- A Tool VM performs durable workspace edits, rootfs project work, workspace commits, replacement,
  and controller push.
- Traces, logs, and metrics from controller, Tool Portal service, framework, and Tool VM operations reach the configured shared sink without file contents, credentials, or unbounded path labels.

## Relationship To Existing Specifications

This spec is the design source of truth for the cutover. After implementation,
`docs/architecture/storage-model.md` and `docs/architecture/storage-matrix.md` resume their role as
the permanent canonical storage documentation. The hard cut must reconcile this complete contract
inventory:

```text
permanent architecture and routing
  docs/architecture/storage-model.md
  docs/architecture/storage-matrix.md
  docs/architecture/openclaw-gateway.md
  docs/README.md
  AGENTS.md orientation and lease-path vocabulary

active Gateway Runtime design
  docs/specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md
  docs/specs/2026-07-12-agent-vm-gateway-runtime/glossary.md
  docs/specs/2026-07-12-agent-vm-gateway-runtime/plans/
    2026-07-13-gateway-runtime-sibling-services-implementation.md

configuration and generated operator surfaces
  system schema, scaffolds, examples, static/live validation
  CLI commands and command definitions
  generated manual templates and snapshots
  beta-used workspace, Git, Tool VM, and Gateway consumers

runtime and protocol consumers
  managed-agent root materialization and lease path translation
  managed-vm contracts and Gondolin adapter translation
  Tool VM lifecycle, mount inventory, ownership, and containment
  Gateway Control schemas/snapshots and authorization
  ToolPortalService Capability API, SSH Sandbox API, controller relationship, and per-agent Tool VM
  binding/connection/status
  OpenClaw plugin/config/runtime instructions
  Hermes plugin/profile/runtime instructions
  shared OTEL attributes that name storage classes

proof and fixtures
  schema, unit, integration, host e2e, real VM, OpenClaw, Hermes, Worker,
  beta, focused docs, and retired-token negative searches for touched paths
```

After maintainer acceptance, the implementation plan maps requirements to tasks and proof gates.
Planning may choose internal type and function names, staging mechanics, and bounded task order,
but may not reintroduce whole-zone Git, durable `/agent`, durable RealFS `/work`, a second writable
copy of agent files, raw host-path lease authority, or controller authority in a VM.
