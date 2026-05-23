# system.jsonc

`system.jsonc` is the controller's top-level human-authored config file.
Relative paths are resolved relative to the directory containing the system
config. `system.json` is still accepted for existing deployments, but new
scaffolds generate `system.jsonc`.

Comments are allowed in authored config. Runtime files that the controller
writes, including effective worker config, runtime records, API bodies, and
task event logs, remain strict JSON/JSONL.

New scaffolds write deployment-local JSON Schema files under `config/schemas/`:

- `system.schema.json`
- `mcp.schema.json`
- `mcp-portal.schema.json`

The `$schema` fields in authored JSONC files point at those local files for
editor tooling. Runtime compatibility is controlled by `schemaVersion`, not by
fetching schema URLs.

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
  agents
  gateway
    ingress
  resources
  secrets
  runtimeAuthHints
  egressHosts
  websocketBypass
  mcpPortal
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

`githubToken` uses the same secret source shape as zone secrets:
`{ "source": "environment", "envVar": "..." }`,
`{ "source": "1password", "ref": "..." }`, or
`{ "source": "config", "value": "..." }`. `source: "config"` embeds a
host-side write token directly in `system.jsonc`; use it only for local or
intentionally checked-in test deployments.

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

`agent-vm build` automatically prunes old image-cache generations after every
successful build. For each gateway or Tool VM image profile, it keeps the
current fingerprint plus the two newest previous fingerprint directories. The
retention count is fixed; there is no `system.jsonc` cache retention field.
Failed builds do not prune cache entries. Manual `agent-vm cache clean
--confirm` remains more aggressive and deletes every stale image generation.
When multiple image profiles share the same resolved build config path and
effective Gondolin fingerprint in one build, the first profile performs the
expensive asset build and later profiles materialize profile-local cache entries
from those assets.

## runtimeDir

`runtimeDir` stores active, non-backup runtime artifacts that are not durable
zone state and not repairable cache. It should prefer local disk because these
paths can be hot during task execution.

Current uses include OpenClaw gateway logs and worker Git metadata:

```text
<runtimeDir>/zones/<zoneId>/logs/
<runtimeDir>/worker-tasks/<zoneId>/<taskId>/gitdirs/<repoId>.git
```

Normal `backup create` does not copy `runtimeDir`, and validation fails when
`runtimeDir` overlaps `cacheDir`, any zone `stateDir`, or any OpenClaw
`zoneFilesDir`. Worker runtime artifacts are task-lifetime data: the agent must
commit and call `git-push` before task teardown if work must survive. OpenClaw
gateway logs are runtime evidence for post-mortems and performance debugging;
they persist across gateway VM restarts but are intentionally excluded from
normal zone backups.

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
Tool VM lease workdir: /workspace
Tool VM rootfs/COW scratch: /work
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
`egressHosts`, and `websocketBypass` entries in `config/system.jsonc`.
Managed OpenClaw image profiles install known extracted channel packages, such
as `@openclaw/discord`, from the OpenClaw channel config.

## gateway.ingress

`zones[].gateway.ingress` customizes the host-facing Gondolin ingress timeout
behavior for the gateway VM. Omit it for Gondolin defaults.

| Field | Required | Meaning |
| --- | --- | --- |
| `upstreamHeaderTimeoutMs` | no | Timeout while waiting for response headers from the guest gateway process. |
| `upstreamResponseTimeoutMs` | no | Timeout between upstream response body chunks from the guest gateway process. |

agent-vm exposes the OpenClaw gateway through one host-facing Gondolin ingress
listener at `zones[].gateway.port`. The current OpenClaw gateway route maps `/`
to the OpenClaw guest gateway port, so the Control UI, `/healthz`, `/readyz`,
OpenAI-compatible HTTP endpoints, SSE streaming, and WebSocket traffic share the
same route.

agent-vm keeps Gondolin response buffering disabled for gateway ingress so
streaming responses can pass through incrementally. Long-running non-streaming
gateway requests, such as direct agent API calls, may need a larger
`upstreamResponseTimeoutMs` than Gondolin's default. Streaming responses are less
sensitive because each emitted chunk resets the response-body idle timer.

These timeout settings do not open additional guest webserver ports. Additional
guest HTTP services require explicit Gondolin ingress routes from non-root path
prefixes to guest ports. Raw TCP services belong in `tcpHosts`, not HTTP
ingress.

## OpenClaw MCP Portal Defaults

Managed OpenClaw gateway images install `@agent-vm/openclaw-mcp-portal-plugin`
and `@agent-vm/mcp-portal`. New OpenClaw scaffolds allow and enable the
`mcp-portal` plugin, set
`plugins.entries.mcp-portal.hooks.allowPromptInjection=true`, add
`/home/openclaw/.openclaw/extensions/mcp-portal` to `plugins.load.paths`, and
configure the plugin with the gateway MCP config directory.

When `agents.list` is configured, agent-vm scaffolds sibling MCP config files in
`config/gateways/<zone>/`:

- `mcp.config.jsonc` describes upstream MCP providers and discovery.
- `mcp-portal.config.jsonc` describes agent profile assignments, profile
  policies, and optional external `/mcp-proxy` auth.

Managed OpenClaw does not generate OpenClaw MCP server entries for MCP Portal.
The plugin registers the four native portal tools directly and calls
`@agent-vm/mcp-portal/core` in the gateway VM with OpenClaw's trusted
`ctx.agentId`. Operator-authored upstream MCP servers live in
`mcp.config.jsonc`; agent-vm materializes an effective gateway config that turns
configured 1Password secrets into runtime environment references or
runtime-mediated bindings before gateway boot.

`zones[].mcpPortal.configDir` points at the directory containing those two
authored files. In managed OpenClaw mode, `externalAuth` and `mcpProxy` are
stripped from the gateway effective config; they are only used by the external
`mcp-portal mcp-proxy serve` adapter.

Important fields in `mcp-portal.config.jsonc`:

- `agents.<agentId>.profile` selects a profile.
- `agents.<agentId>.credentialVersion` revokes previously printed external
  `/mcp-proxy` bearer credentials for that agent.
- `agents.<agentId>.hmacKey` is used for OpenClaw approval-token verification
  and is stripped before managed gateway config enters the VM.
- `externalAuth.masterKey` is required only for external `/mcp-proxy` bearer
  auth and client-config generation.
- `mcpProxy.server.host`, `mcpProxy.server.port`, and
  `mcpProxy.auth.headerName` configure the loopback Hono MCP proxy.
- `profiles.<name>.enabledNamespaces`, `enabledToolsByNamespace`,
  `hiddenToolsByNamespace`, and `approval` define the agent's portal policy.

Important fields in `mcp.config.jsonc` provider entries:

- `transport.kind` may be `streamable-http`, `sse`, or `stdio`.
- Remote provider `transport.url` must use `http` or `https`.
- Stdio providers must declare `transport.networkAccess`.
- `transport.networkAccess: "declared"` requires non-empty
  `transport.requiredEgressHosts`.
- Every secret in `transport.env` or `transport.headers` needs a matching
  `secretPolicies.<name>` entry.
- `secretPolicies.<name>.injection` is either `env` or `http-mediation`;
  mediated secrets must list allowed `hosts`.

Local smoke coverage uses a fake Streamable HTTP MCP provider and the
controller smoke harness `tcpHostsOverride` path to make that host-side provider
reachable from inside the OpenClaw gateway VM. The smoke does not require
DeepWiki, Tavily, 1Password, or real upstream MCP credentials; credentialed
upstream providers belong in an explicit deployment smoke outside the default
local suite.

`agent-vm init --type openclaw --openclaw-agents sun,shravan,alevtina` scaffolds
`agents.list` entries with `/zone/agents/<id>` workspaces. It deliberately does
not scaffold channel bindings or Discord guild allowlists because those are
deployment-owned IDs.

OpenClaw `web_fetch` in Gondolin deployments needs fake-IP SSRF policy for
mediated DNS and proxy-style environments:

```json
{
  "tools": {
    "web": {
      "fetch": {
        "ssrfPolicy": {
          "allowRfc2544BenchmarkRange": true,
          "allowIpv6UniqueLocalRange": true
        }
      }
    }
  }
}
```

This is separate from `zones[].egressHosts`. The SSRF policy lets OpenClaw
connect to Gondolin's synthetic addresses; `egressHosts` still decides which
real destinations Gondolin may fetch.

Agent-vm's Gondolin adapter uses RFC2544 synthetic IPv4 answers and
`::ffff:198.18.0.1` for synthetic AAAA when `tcpHosts` are enabled. That value
is accepted by OpenClaw when `allowRfc2544BenchmarkRange` is true. Do not use
`browser.ssrfPolicy.allowedHostnames` as the first fix for Discord media; that
exact-host bypass skips private-IP checks for the named host and is broader
than the adapter-level synthetic DNS fix.

Gondolin `allowedInternalHosts` is also not the first fix for this symptom. It
relaxes Gondolin HTTP hook internal-IP blocking for matching hostnames, while
the observed Discord media failure happens earlier in OpenClaw's own SSRF guard
as it validates synthetic DNS answers.

The scaffold also includes `tools.sandbox.tools.alsoAllow` for `web_search`,
`web_fetch`, `message`, and `group:plugins`. That does not configure a search
provider by itself; it prevents sandbox tool policy from hiding web tools after
the deployment adds a provider, keeps OpenClaw's `message_tool_only` group reply
mode usable by exposing the explicit channel reply tool, and exposes optional
plugin-owned tools such as MCP Portal's `mcp_portal_*` tools to sandboxed
agents.

OpenClaw Tool VMs mount their validated lease work mount at `/workspace`.
`/work` remains Tool VM rootfs/COW scratch. Worker task VMs keep repo edits
under `/work/repos/<repoId>`; worker `/work` is per-task rootfs and is unrelated
to the Tool VM scratch path above.

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
tag pinned by that package's `managed-images.json` manifest. Managed image tags
use their own release line and are intentionally separate from npm package
versions.
The deployment overlay is intentionally small; use it for extra apt packages,
copy steps, post-base commands, and runtime OpenClaw packages. `agent-vm build`
regenerates Dockerfiles under `cacheDir/generated-dockerfiles/...`; do not edit
generated Dockerfiles by hand. OpenClaw gateway deployments that need specific
OpenClaw package versions should pin them in the overlay's
`extraOpenClawPackages`. Overlay package pins override managed default companion
packages during Dockerfile generation. If the overlay pins `openclaw@X` and an
`@openclaw/*@Y` package with a different version, build output warns before
Docker and Gondolin work begin.

Legacy `dockerfile` profiles are reported by `agent-vm doctor`; migrate them
with `agent-vm migrate images`.

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
      "audience": "gateway",
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
  "egressHosts": [
    { "host": "api.openai.com", "audience": "gateway" },
    { "host": "api.github.com", "audience": "gateway" },
    { "host": "github.com", "audience": "gateway" },
    { "host": "mcp.deepwiki.com", "audience": "gateway" }
  ]
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
    "runtimeRootfsSize": "12G",
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
auth profile. `gateway.authProfilesRef` and `gateway.authProfilesByAgent`
support `environment`, `1password`, and `config` sources. Inline `config`
values here are plaintext OpenClaw auth profiles and should be limited to local
or test deployments.

`gateway.controlAuth` is required for OpenClaw gateways and names the
gateway env secret OpenClaw uses to authenticate controller API calls. The
referenced secret must exist in `zone.secrets` with `injection: "env"` and
`audience: "gateway"`. New scaffolds use:

```json
"controlAuth": { "mode": "token", "secret": "OPENCLAW_GATEWAY_TOKEN" }
```

`gateway.rawEnvSecrets` is the explicit escape hatch for other OpenClaw secrets
that must reach the gateway VM as raw environment variables. Other provider or
service tokens should use `http-mediation` unless the integration cannot work
with HTTP mediation, such as a non-HTTP or websocket credential flow. Generated
runtime env secrets also need to be named here when a feature requires them, for
example `AGENT_VM_ZONE_GIT_TOKEN`.

`zones[].gateway.runtimeRootfsSize` optionally requests a minimum runtime root
disk size for the gateway VM, using Gondolin `rootfs.size`. The base image is
not rebuilt for this value; Gondolin grows the writable root disk and runs
`resize2fs` in the guest before startup completes. The guest image must contain
`resize2fs`.

`agentSandboxSeeds` writes first-boot files into the agent's scoped sandbox work
mount before the Tool VM starts. Targets are relative to the sandbox
backing directory exposed at `/workspace` in Tool VMs, cannot use `..`, and are
not written for shared `/zone` work mounts. Existing files are preserved so a
user's edited credentials or config are not overwritten on later leases. Seed
sources support `environment`, `1password`, and `config`; inline seed values are
written as plaintext files into the sandbox work mount on first boot.

The important path model is:

```text
OpenClaw gateway durable zone files:
  guest /zone  ->  host gateway.zoneFilesDir

Tool VM selected work mount:
  guest /workspace  ->  host path chosen by OpenClaw lease request
  guest /work       ->  Tool VM rootfs/COW scratch

That Tool VM `/workspace` backing path may be an agent sandbox work directory
under stateDir, or a subpath of zoneFilesDir. The Tool VM root filesystem
itself is disposable, including `/work`.
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
      "imageProfile": "default",
      "runtimeRootfsSize": "16G"
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
profiles from one config. Image profiles with the same resolved build config
path and identical effective image fingerprints are deduped during
`agent-vm build`, so separate profile names do not by themselves force separate
Gondolin asset conversion work.

`toolVmProfiles[*].runtimeRootfsSize` applies the same runtime root disk sizing
to Tool VMs created from that profile. Use the image build config
`rootfs.sizeMb` for packages baked into the base image; use
`runtimeRootfsSize` for writable runtime capacity such as agent caches,
temporary installs, browser artifacts, and command output generated after boot.

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
read-only VFS mounts. They do not modify `egressHosts`; HTTP egress remains a
zone-level policy.

`allowRepoResources: false` disables the entire repo-local resource contract
pipeline. The controller does not load `.agent-vm/repo-resources.ts`, does not
run `.agent-vm/run-setup.sh`, and does not call
`finalizeRepoResourceSetup(input)`. Required resources must be supplied as
task external resources. `true` and `string[]` allow matching repos with a
contract file to run setup/finalization after resource resolution.

## secrets

Zone secrets support three sources:

| Source | Fields |
| --- | --- |
| `environment` | `envVar` |
| `1password` | `ref` |
| `config` | `value` |

`source: "config"` embeds the secret value directly in `system.json`; use it
only for local or intentionally checked-in test credentials.

The same secret source union is also used by host/controller fields such as
`host.githubToken`, `zones[].adminAccess.secret`,
`zones[].gateway.authProfilesRef`, `zones[].gateway.authProfilesByAgent`, and
`zones[].agentSandboxSeeds[].source`. Inline `config` on those fields is still
plaintext in the authored config and may include host write credentials or
controller admin credentials, so treat it as a local/test convenience rather
than a production secret store.

Secrets support two injection modes:

| Injection | Meaning |
| --- | --- |
| `http-mediation` | Gondolin injects the secret into outbound HTTP requests for listed `hosts`. The VM process does not see the raw secret. |
| `env` | Secret is exposed as a VM environment variable. |

For `http-mediation`, `hosts` is required and must be non-empty. For `env`,
`audience` must be `gateway` and `hosts` must be omitted. Tool VM secrets are
always mediated. `source: "environment"` is allowed for a Tool VM secret only
when `injection` is `http-mediation`; in that case the controller reads the
environment variable and Gondolin mediates the value.

OpenClaw zones allow raw gateway env secrets only when the secret is referenced
by `gateway.controlAuth.secret` or is listed in `gateway.rawEnvSecrets`. This
keeps provider API tokens on the mediated path by default and makes every
raw-env exception visible in deployment config.

Secret names must be valid environment variable identifiers. This keeps
gateway env-file rendering and runtime placeholder names safe and predictable.

## runtimeAuthHints

Worker zones may declare `runtimeAuthHints` to describe mediated service tokens
to the worker agent. These hints generate worker runtime instructions only; they
do not mount config files and do not expose real secret values. They name the
service, mediated host list, tool names, and placeholder env var so the worker
agent can use normal tooling without guessing which token exists. OpenClaw zones
must not declare `runtimeAuthHints`; Tool VM auth is controlled by Tool
VM-audience mediated secrets and `egressHosts`.

Known services get setup recipes in the generated runtime instructions. Current
recipes cover `github`, `npm`, Linear, Readwise, and Python package indexes
(`pypi`, `pypi-private`, `python`, or `python-package-index`). Unknown services
are still listed, but the generated guidance tells the agent to report an auth
setup gap if the correct toolchain setup is not known.

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

Each hint must reference a worker-zone secret with `injection:
"http-mediation"` and an audience that reaches the worker gateway runtime
(`"gateway"` or `"both"`). Every hint host must also appear in that secret's
`hosts`.

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

`leaseIdleTtl` is optional. When omitted, every lease uses the default 100 minute
idle timeout. OpenClaw deployments that mix agent, session, and workspace-scope
leases can override by scope kind or by scope-key prefix:

```json
{
  "leaseIdleTtl": {
    "defaultMs": 6000000,
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
- Legacy `allowedHosts`; use `egressHosts` with explicit `audience`.
- Zone secrets without explicit `audience`.
- Env-injected zone secrets with non-gateway audience or declared `hosts`.
- OpenClaw env-injected zone secrets not listed in `gateway.rawEnvSecrets`,
  except the configured `gateway.controlAuth.secret`.
- Mediated secret hosts not declared in `egressHosts` for the same audience.
- OpenClaw zones without `gateway.controlAuth` or without the referenced
  gateway-only env secret.
- Zones referencing missing gateway image profiles.
- Zone gateway type mismatches against the selected image profile.
- OpenClaw zones declaring `runtimeAuthHints`.
- Worker `runtimeAuthHints` referencing missing secrets, non-mediated secrets,
  Tool VM-only secrets, or hosts not listed on the referenced secret.
- OpenClaw zones without `defaultToolVmProfile`.
- OpenClaw zones without explicit `agentToolVmProfiles`.
- Worker zones declaring Tool VM profile or sandbox seed fields.
- `agentToolVmProfiles` values referencing missing `toolVmProfiles`.
- `agentSandboxSeeds` targets that are absolute or escape the sandbox work mount.
- Tool VM profiles referencing missing Tool VM image profiles.
- OpenClaw MCP Portal configs that fail materialization semantics, including
  missing stdio `networkAccess`, missing provider `secretPolicies`, invalid
  mediated hosts, and generated secret environment-name collisions.
