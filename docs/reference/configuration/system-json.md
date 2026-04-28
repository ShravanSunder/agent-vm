# system.json

`system.json` is the controller's top-level config file. Relative paths are
resolved relative to the directory containing `system.json`.

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
  toolProfile

toolProfiles

tcpPool
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
`zoneFilesDir`. If a worker task has unpushed commits or dirty work, the
controller must preserve it through an explicit push, export, retain, or
discard decision before cleanup.

## zoneFilesDir

`zoneFilesDir` is the long-lived OpenClaw household/user files directory. It is
RealFS-mounted into the OpenClaw gateway VM at `/home/openclaw/zone-files` and
is included in OpenClaw zone backups.

Worker gateways do not use `zoneFilesDir`. Their repo files live in VM-local
`/work/repos/<repoId>`, and their Git metadata lives under system-level
`runtimeDir`.

Do not call this `workspaceDir`. Worker execution files live under VM-local
`/work/repos/<repoId>` and are not backed by this host path.

For the storage boundary model, see
[storage-model.md](../../architecture/storage-model.md).

## imageProfiles

Gateway image profiles are used by zones:

```json
{
  "imageProfiles": {
    "gateways": {
      "worker": {
        "type": "worker",
        "buildConfig": "../vm-images/gateways/worker/build-config.json",
        "dockerfile": "../vm-images/gateways/worker/Dockerfile"
      }
    }
  }
}
```

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
    "config": "./gateways/coding-agent/worker.json",
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

Worker zones do not require `toolProfile`. OpenClaw zones do.

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
    "zoneFilesDir": "../zone-files/shravan"
  },
  "toolProfile": "default"
}
```

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
    "size": 5
  }
}
```

## Cross-Field Validation

The schema rejects:

- 1Password secrets without `host.secretsProvider`.
- Zones referencing missing gateway image profiles.
- Zone gateway type mismatches against the selected image profile.
- `runtimeAuthHints` referencing missing secrets, non-mediated secrets, or hosts
  not listed on the referenced secret.
- OpenClaw zones without `toolProfile`.
- Tool profiles referencing missing tool VM image profiles.
