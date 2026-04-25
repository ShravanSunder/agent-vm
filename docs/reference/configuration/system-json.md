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

imageProfiles
  gateways
  toolVms

zones[]
  id
  gateway
  resources
  secrets
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
    "stateDir": "../state/coding-agent",
    "workspaceDir": "../workspaces/coding-agent"
  },
  "resources": {
    "allowRepoResources": false
  },
  "secrets": {},
  "allowedHosts": ["api.openai.com", "api.github.com", "github.com"]
}
```

Worker zones do not require `toolProfile`. OpenClaw zones do.

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
- OpenClaw zones without `toolProfile`.
- Tool profiles referencing missing tool VM image profiles.
