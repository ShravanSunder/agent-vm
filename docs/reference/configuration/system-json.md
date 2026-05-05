# system.jsonc

`system.jsonc` is the controller's top-level human-authored config file.
Relative paths are resolved relative to the directory containing the system
config. `system.json` is still accepted for existing deployments, but new
scaffolds generate `system.jsonc`.

Comments are allowed in authored config. Runtime files that the controller
writes, including effective worker config, runtime records, API bodies, and
task event logs, remain strict JSON/JSONL.

Source schema:
`packages/agent-vm/src/config/system-config.ts`

## Sections

```
host
  controllerPort
  projectNamespace
  secretsProvider
  githubToken

cacheDir

runtimeDir

imageProfiles
  gateways
  toolVms

zones[]
  id
  gateway
  resources
  secrets
  runtimeAuthHints
  allowedHosts
  websocketBypass
  defaultToolVmProfile
  agentToolVmProfiles
  agentSandboxSeeds

toolVmProfiles

tcpPool

leaseIdleTtl
```

## host

| Field | Required | Meaning |
| --- | --- | --- |
| `controllerPort` | yes | TCP port for the controller HTTP API. |
| `projectNamespace` | yes | Lowercase namespace used for runtime labels and cache separation. |
| `secretsProvider` | when using `source: "1password"` | How the host resolves 1Password-backed secrets. |
| `githubToken` | no | Host-only token for clone and push. Never enters the VM. |

`secretsProvider.tokenSource` may be:

| Type | Meaning |
| --- | --- |
| `env` | Read 1Password service account token from an env var. Defaults to `OP_SERVICE_ACCOUNT_TOKEN`. |
| `keychain` | Read the service account token from macOS Keychain. |
| `op-cli` | Resolve the service account token through the 1Password CLI. |

## cacheDir

`cacheDir` stores rebuildable artifacts. It is intentionally outside encrypted
zone backups. Current uses include Gondolin image outputs and per-zone gateway
repair/download caches.

Do not place durable secrets or user state under `cacheDir`. Do not place
rebuildable dependency trees under `stateDir` just to make them survive gateway
VM reboot; mount a cache path or bake stable dependency trees into the image
instead.

`cacheDir` may be local disk or network-backed storage in larger deployments.
Do not put active worker gitdirs here; unpushed commits are not rebuildable
cache.

## runtimeDir

`runtimeDir` stores active, non-backup runtime artifacts that are not durable
zone state and not repairable cache. It should prefer local disk because these
paths can be hot during task execution.

The primary use is worker Git metadata:

```text
<runtimeDir>/worker-tasks/<zoneId>/<taskId>/gitdirs/<repoId>.git
```

Normal `backup create` does not copy `runtimeDir`, and validation fails when
`runtimeDir` overlaps `cacheDir`, any zone `stateDir`, or any OpenClaw
`zoneFilesDir`. Worker runtime artifacts are task-lifetime data: the agent must
commit and call `git-push` before task teardown if work must survive.

## zoneFilesDir

`zoneFilesDir` is the long-lived OpenClaw household/user files directory. It is
RealFS-mounted into the OpenClaw gateway VM at `/zone` and
is included in OpenClaw zone backups.

Worker gateways do not use `zoneFilesDir`. Their repo files live in VM-local
`/work/repos/<repoId>`, and their Git metadata lives under system-level
`runtimeDir`.

Do not call this `workspaceDir`. Worker execution files live under VM-local
`/work/repos/<repoId>` and are not backed by this host path.

`workMountDir` is not a `system.json` field. It is selected dynamically by
OpenClaw when a tool lease is requested. Static config defines the allowed
roots: the OpenClaw state sandbox root and `zoneFilesDir`. A lease
`workMountDir` must be a concrete child path under one of those roots; the roots
themselves are validation boundaries and are rejected as mount targets.
For the canonical name/location/storage vocabulary, see
[Lease Path Vocabulary](../../architecture/storage-model.md#lease-path-vocabulary).

```text
Tool VM guest path: /work
OpenClaw gateway zone files: /zone
OpenClaw state sandboxes: /home/openclaw/.openclaw/state/sandboxes
```

For the storage boundary model, see
[storage-model.md](../../architecture/storage-model.md).

## OpenClaw Channel Defaults

`agent-vm init --type openclaw` scaffolds framework primitives: Gondolin,
memory-core, VM lifecycle, Tool VM lease plumbing, and runtime auth wiring. It
does not enable Discord or any other channel-specific surface by default.

Channel config is deployment-owned. Enable channels in
`config/gateways/<zone>/openclaw.json`, then declare the matching secrets,
`allowedHosts`, and `websocketBypass` entries in `config/system.jsonc`.
Managed OpenClaw image profiles install known extracted channel packages, such
as `@openclaw/discord`, from the OpenClaw channel config.

OpenClaw Tool VMs mount their validated lease work mount at `/work`. Worker task VMs keep
repo edits under `/work/repos/<repoId>`.

## imageProfiles

Gateway image profiles are used by zones:

```json
{
  "imageProfiles": {
    "gateways": {
      "worker": {
        "type": "worker",
        "buildConfig": "../vm-images/gateways/worker/build-config.jsonc",
        "source": {
          "kind": "managedBase",
          "base": "worker-gateway",
          "overlay": "../vm-images/gateways/worker/overlay.jsonc"
        }
      }
    }
  }
}
```

`source.kind = "managedBase"` means `agent-vm build` generates the Dockerfile
from the installed `@agent-vm/agent-vm` package and the managed GHCR base image
version pinned by that package.
The deployment overlay is intentionally small; use it for extra apt packages,
copy steps, and post-base commands. Legacy `dockerfile` profiles are reported by
`agent-vm doctor`; migrate them with `agent-vm migrate images`.

OpenClaw tool VMs use `imageProfiles.toolVms`. Worker-only configs normally
omit tool VM image profiles.

## zones

Each zone selects one gateway image profile and one gateway behavior config:

```json
{
  "id": "coding-agent",
  "gateway": {
    "type": "worker",
    "memory": "2G",
    "cpus": 2,
    "port": 18791,
    "config": "./gateways/coding-agent/worker.jsonc",
    "imageProfile": "worker",
    "stateDir": "../state/coding-agent"
  },
  "resources": {
    "allowRepoResources": false
  },
  "secrets": {
    "GITHUB_TOKEN": {
      "source": "environment",
      "envVar": "GITHUB_TOKEN",
      "injection": "http-mediation",
      "hosts": ["api.github.com", "github.com"]
    }
  },
  "runtimeAuthHints": [
    {
      "kind": "service-token",
      "secret": "GITHUB_TOKEN",
      "service": "github",
      "hosts": ["api.github.com", "github.com"],
      "tools": ["gh"]
    }
  ],
  "allowedHosts": ["api.openai.com", "api.github.com", "github.com", "mcp.deepwiki.com"]
}
```

Worker zones do not declare Tool VM profile fields. OpenClaw zones must declare
`defaultToolVmProfile` and `agentToolVmProfiles`, even when the agent mapping is
empty. This makes the Tool VM image policy visible in generated configs instead
of hiding it behind defaults.

OpenClaw zones add `zoneFilesDir` because they own long-lived household/user
files:

```json
{
  "id": "shravan",
  "gateway": {
    "type": "openclaw",
    "memory": "4G",
    "cpus": 4,
    "port": 18791,
    "config": "./gateways/shravan/openclaw.json",
    "imageProfile": "openclaw",
    "stateDir": "../state/shravan",
    "zoneFilesDir": "../zone-files/shravan",
    "authProfilesByAgent": {
      "shravan": { "source": "environment", "envVar": "SHRAVAN_AUTH_PROFILES" }
    }
  },
  "defaultToolVmProfile": "standard",
  "agentToolVmProfiles": {
    "shravan": "tools-dev",
    "alevtina": "tools-light"
  },
  "agentSandboxSeeds": {
    "shravan": [
      {
        "source": { "source": "environment", "envVar": "SHRAVAN_GCLOUD_CONFIG" },
        "target": ".config/gcloud/configurations/config_default",
        "mode": 384
      }
    ]
  }
}
```

New OpenClaw scaffolds set `agents.defaults.workspace` to
`/zone/agents/default`. This keeps the default agent's authored workspace files
under `zoneFilesDir` while leaving `/zone` itself available for shared
zone-level notes and reference material. Multi-agent deployments should set
explicit `agents.list[].workspace` values such as `/zone/agents/shravan` and
`/zone/agents/sun`; otherwise OpenClaw derives non-default agent workspaces
under the fallback path.

`agentToolVmProfiles` values must reference entries in top-level `toolVmProfiles`.
Unmapped agents use the zone fallback `defaultToolVmProfile`.

`gateway.authProfilesByAgent` writes OpenClaw auth profiles to
`<stateDir>/agents/<agentId>/agent/auth-profiles.json` before the gateway VM
boots. There is no shared per-agent fallback; configure each agent that needs an
auth profile.

`agentSandboxSeeds` writes first-boot files into the agent's scoped sandbox work
mount before the Tool VM starts. Targets are relative to the sandbox
`/work` backing directory, cannot use `..`, and are not written for shared
`/zone` work mounts. Existing files are preserved so a user's edited credentials
or config are not overwritten on later leases.

The important path model is:

```text
OpenClaw gateway durable zone files:
  guest /zone  ->  host gateway.zoneFilesDir

Tool VM selected work mount:
  guest /work  ->  host path chosen by OpenClaw lease request

That Tool VM /work backing path may be an agent sandbox work directory under
stateDir, or a subpath of zoneFilesDir. The Tool VM root filesystem itself is
disposable.
```

## toolVmProfiles

`toolVmProfiles` names the Tool VM runtime profiles available to OpenClaw
zones. The name is intentionally explicit: these are profiles for disposable
Tool VMs, not gateway profiles and not OpenClaw user profiles.

```json
{
  "toolVmProfiles": {
    "standard": {
      "memory": "1G",
      "cpus": 1,
      "imageProfile": "default"
    },
    "tools-dev": {
      "memory": "2G",
      "cpus": 2,
      "imageProfile": "tools-dev"
    }
  },
  "imageProfiles": {
    "toolVms": {
      "default": { "type": "toolVm", "buildConfig": "../vm-images/tool-vms/default/build-config.json" },
      "tools-dev": { "type": "toolVm", "buildConfig": "../vm-images/tool-vms/dev/build-config.json" }
    }
  }
}
```

`toolVmProfiles[*].imageProfile` must reference
`imageProfiles.toolVms[*]`. The build pipeline can build multiple Tool VM image
profiles from one config.

## zones[].resources

`resources` controls whether repo-local providers may satisfy logical
resources. If omitted, `allowRepoResources` behaves as `true`.

```json
{
  "resources": {
    "allowRepoResources": [
      "https://github.com/example/example-repo"
    ]
  }
}
```

| Value | Meaning |
| --- | --- |
| `false` | Repo-local providers are disabled; required resources must be supplied externally. |
| `true` | Any requested repo may provide resources. This is the default. |
| `string[]` | Only matching repo URLs may provide resources. |

Repo resources are TCP-only and compile to Gondolin `tcpHosts`, env, and
read-only VFS mounts. They do not modify `allowedHosts`; HTTP egress remains a
zone-level policy.

`allowRepoResources` gates provider selection. Requested repos may still run
their `.agent-vm/run-setup.sh` and `finalizeRepoResourceSetup(input)`
after resource resolution, for example to publish generated fixtures or derive
env from selected external resources. See
[resource-contracts.md](resource-contracts.md).

## secrets

Zone secrets support two sources:

| Source | Fields |
| --- | --- |
| `environment` | `envVar` |
| `1password` | `ref` |

Secrets support two injection modes:

| Injection | Meaning |
| --- | --- |
| `http-mediation` | Gondolin injects the secret into outbound HTTP requests for listed `hosts`. The VM process does not see the raw secret. |
| `env` | Secret is exposed as a VM environment variable. |

For `http-mediation`, `hosts` is required.

## runtimeAuthHints

Zones may declare `runtimeAuthHints` to describe mediated service tokens to the
agent. These hints generate runtime instructions only; they do not mount config
files and do not expose real secret values. They name the service, mediated host
list, tool names, and placeholder env var so the agent can use normal tooling
without guessing which token exists.

Known services get setup recipes in the generated runtime instructions. Current
recipes cover `github`, `npm`, and Python package indexes (`pypi`,
`pypi-private`, `python`, or `python-package-index`). Unknown services are still
listed, but the generated guidance tells the agent to report an auth setup gap
if the correct toolchain setup is not known.

```json
{
  "runtimeAuthHints": [
    {
      "kind": "service-token",
      "secret": "GITHUB_TOKEN",
      "service": "github",
      "hosts": ["api.github.com"],
      "tools": ["gh"]
    },
    {
      "kind": "service-token",
      "secret": "NPM_AUTH_TOKEN",
      "service": "npm",
      "hosts": ["registry.npmjs.org"],
      "tools": ["npm", "pnpm", "yarn"]
    }
  ]
}
```

Each hint must reference a zone secret with `injection: "http-mediation"`, and
every hint host must also appear in that secret's `hosts`.

Generated auth guidance appears in `/agent-vm/agents.md`,
`/agent-vm/runtime-instructions.md`, and the prompt's `runtimeInstructions`
layer.

## tcpPool

The TCP pool reserves host ports for VM networking. Agent Worker Gateway uses the
controller mapping. OpenClaw Gateway also uses it for tool VM SSH slots.

```json
{
  "tcpPool": {
    "basePort": 19000,
    "size": 12
  }
}
```

Generated configs use `size: 12` so one controller can run multiple agents and
zones without exhausting Tool VM SSH slots immediately.

## leaseIdleTtl

`leaseIdleTtl` is optional. When omitted, every lease uses the default 30 minute
idle timeout. OpenClaw deployments that mix agent, session, and workspace-scope
leases can override by scope kind or by scope-key prefix:

```json
{
  "leaseIdleTtl": {
    "defaultMs": 1800000,
    "byScopeKind": {
      "agent": 7200000,
      "workspace": 900000
    },
    "byScopePrefix": {
      "agent:shravan": 21600000
    }
  }
}
```

Selection order is exact or longest prefix match in `byScopePrefix`, then
`byScopeKind`, then `defaultMs`.

## Cross-Field Validation

The schema rejects:

- 1Password secrets without `host.secretsProvider`.
- Zones referencing missing gateway image profiles.
- Zone gateway type mismatches against the selected image profile.
- `runtimeAuthHints` referencing missing secrets, non-mediated secrets, or hosts
  not listed on the referenced secret.
- OpenClaw zones without `defaultToolVmProfile`.
- OpenClaw zones without explicit `agentToolVmProfiles`.
- Worker zones declaring Tool VM profile or sandbox seed fields.
- `agentToolVmProfiles` values referencing missing `toolVmProfiles`.
- `agentSandboxSeeds` targets that are absolute or escape the sandbox work mount.
- Tool VM profiles referencing missing Tool VM image profiles.
