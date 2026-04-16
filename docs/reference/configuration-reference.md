# Configuration Reference

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Configuration Reference

This is the single source of truth for every configuration field in agent-vm. All field names, types, defaults, and validation rules are derived directly from the Zod schemas in the source code.

For how-to guides on configuring each mode, see [getting-started/worker-guide.md](../getting-started/worker-guide.md) or [getting-started/openclaw-guide.md](../getting-started/openclaw-guide.md).

---

## What Controls What

```
  system.json ──────→ Controller
  (admin)             - host port, namespace
                      - secret provider (1Password / env)
                      - zones (gateway type, resources, secrets, allowedHosts)
                      - VM images (build configs)
                      - TCP pool, tool profiles
                          |
                          | zones[].gateway.gatewayConfig points to:
                          v
  worker.json ──────→ Worker Pipeline (inside VM)
  (org/team)          - LLM provider + model per phase
                      - phase retry limits
                      - verification commands (test, lint)
                      - wrapup actions (git-pr, slack)
                      - MCP servers, skills
                          |
                          | deep-merged with (project overrides zone):
                          v
  .agent-vm/          Project-specific overrides
  config.json         - different test commands
  (project dev)       - different model for planning
                      - project-specific MCP servers
                          |
                          v
                      effective-worker.json (written to /state/)
```

## Who Writes What

| File | Who writes it | Who reads it | What it controls |
|------|--------------|-------------|-----------------|
| `system.json` | System administrator (via `agent-vm init`) | Controller at startup | Host, zones, networking, secrets, images |
| `worker.json` | Org/team (zone-level defaults) | Controller during task prep | Pipeline behavior: models, phases, verification, wrapup |
| `.agent-vm/config.json` | Project developer (checked into repo) | Controller during task prep (merged over worker.json) | Project-specific overrides |

---

## Config Assembly

```
system.json (host-level, per installation)
    |
    +-> zones[].gateway.gatewayConfig -> worker.json (zone-level)

.agent-vm/config.json (repo-level, checked into each project)

Merge: worker.json (base) + .agent-vm/config.json (override) -> Zod defaults fill gaps -> effective config
```

There are three configuration files that combine to produce the final effective configuration:

| File | Scope | Created By |
|------|-------|------------|
| `system.json` | Host-level. One per installation. Controls the controller, zones, networking, and secrets. | `agent-vm init` |
| `worker.json` | Zone-level. Referenced by `zones[].gateway.gatewayConfig`. Controls worker behavior, phases, verification, and wrapup. | `agent-vm init` |
| `.agent-vm/config.json` | Repo-level. Checked into each project repository. Overrides worker.json for that specific project. | Manual |

Relative paths in `system.json` are resolved relative to the config file's directory, not the process CWD.

---

## system.json

Source: `systemConfigSchema` in `packages/agent-vm/src/config/system-config.ts`

### host

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `host.controllerPort` | `number` (int, positive) | Yes | -- | TCP port the controller listens on. |
| `host.projectNamespace` | `string` | Yes | -- | Identifies this installation. Must match `^[a-z0-9][a-z0-9-]*$` (lowercase letters, numbers, hyphens; must start with letter or digit). |
| `host.secretsProvider` | `object` | Conditional | -- | Required when any zone secret or host credential uses `source: "1password"`. See [secretsProvider](#hostsecretsprovider). |
| `host.githubToken` | `SecretRef` | No | -- | Token for controller-side git push operations. See [SecretRef (host)](#secretref-host). |

#### host.secretsProvider

Only `1password` is supported as a provider type. The `tokenSource` field is a discriminated union on `type`:

| tokenSource.type | Fields | Description |
|------------------|--------|-------------|
| `op-cli` | `ref` (string, required) | 1Password CLI secret reference, e.g. `op://vault/item/field`. |
| `env` | `envVar` (string, optional) | Read token from an environment variable. |
| `keychain` | `service` (string, required), `account` (string, required) | Read token from macOS Keychain. |

```json
"secretsProvider": {
  "type": "1password",
  "tokenSource": {
    "type": "keychain",
    "service": "agent-vm",
    "account": "op-service-account-token"
  }
}
```

#### SecretRef (host)

Used by `host.githubToken`. Discriminated union on `source`:

| source | Fields | Description |
|--------|--------|-------------|
| `1password` | `ref` (string, required) | 1Password secret reference. |
| `environment` | `envVar` (string, required) | Environment variable name. |

### cacheDir

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `cacheDir` | `string` | No | `"./cache"` | Directory for build cache and image artifacts. Resolved relative to the config file directory. |

### images

Build configuration for VM images. Both `gateway` and `tool` are required.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `images.gateway.buildConfig` | `string` | Yes | -- | Path to the gateway image build-config.json. Resolved relative to config file. |
| `images.gateway.dockerfile` | `string` | No | -- | Path to a custom gateway Dockerfile. Resolved relative to config file. |
| `images.tool.buildConfig` | `string` | Yes | -- | Path to the tool image build-config.json. Resolved relative to config file. |
| `images.tool.dockerfile` | `string` | No | -- | Path to a custom tool Dockerfile. Resolved relative to config file. |

### zones

Array of zone definitions. Minimum 1 zone required.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `zones[].id` | `string` | Yes | -- | Unique zone identifier. |
| `zones[].gateway` | `object` | Yes | -- | Gateway VM configuration. See [zone gateway](#zone-gateway). |
| `zones[].secrets` | `Record<string, SecretReference>` | Yes | -- | Named secrets available to the zone. See [zone secrets](#zone-secrets). |
| `zones[].allowedHosts` | `string[]` | Yes | -- | Hostnames the gateway is allowed to reach. Minimum 1 entry. |
| `zones[].websocketBypass` | `string[]` | No | `[]` | Host:port pairs that bypass HTTP mediation for raw WebSocket traffic. |
| `zones[].toolProfile` | `string` | Yes | -- | Key into `toolProfiles`. Must reference a defined profile (cross-field validation). |

#### Zone gateway

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `gateway.type` | `"openclaw" \| "worker"` | No | `"openclaw"` | Gateway mode. `openclaw` runs the OpenClaw agent platform; `worker` runs the agent-vm-worker directly. |
| `gateway.memory` | `string` | Yes | -- | Memory allocation for the gateway VM, e.g. `"2G"`. |
| `gateway.cpus` | `number` (int, positive) | Yes | -- | CPU count for the gateway VM. |
| `gateway.port` | `number` (int, positive) | Yes | -- | Ingress port exposed by the gateway VM. |
| `gateway.gatewayConfig` | `string` | Yes | -- | Path to the gateway's own config file (worker.json or openclaw.json). Resolved relative to config file. |
| `gateway.stateDir` | `string` | Yes | -- | Directory for persistent zone state. Resolved relative to config file. |
| `gateway.workspaceDir` | `string` | Yes | -- | Directory for zone workspaces. Resolved relative to config file. |
| `gateway.authProfilesRef` | `AuthProfilesSecret` | No | -- | Secret reference for auth profiles. See [authProfilesRef](#authprofilesref). |

#### authProfilesRef

Discriminated union on `source`:

| source | Fields | Description |
|--------|--------|-------------|
| `1password` | `ref` (string, required) | 1Password secret reference. |
| `environment` | `envVar` (string, required) | Environment variable name. |

#### Zone secrets

Each entry in `zones[].secrets` is keyed by secret name (e.g. `GITHUB_TOKEN`) and uses a discriminated union on `source`:

| source | Fields | Description |
|--------|--------|-------------|
| `1password` | `ref` (string, required) | 1Password secret reference, e.g. `op://vault/item/field`. |
| `environment` | `envVar` (string, required) | Environment variable name containing the secret value. |

Both source types share these fields:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `injection` | `"env" \| "http-mediation"` | No | `"http-mediation"` | How the secret is delivered to the VM. `env` injects as an environment variable. `http-mediation` intercepts outbound HTTP and attaches the secret as a header. |
| `hosts` | `string[]` | Conditional | -- | Required when `injection` is `"http-mediation"`. List of hostnames the secret applies to. At least one host must be specified. |

Example:

```json
"OPENAI_API_KEY": {
  "ref": "op://agent-vm/workers-openai/credential",
  "source": "1password",
  "hosts": ["api.openai.com"],
  "injection": "http-mediation"
}
```

### toolProfiles

Record keyed by profile name. Each zone references a profile by name via `zones[].toolProfile`.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `toolProfiles[name].memory` | `string` | Yes | -- | Memory allocation for tool containers, e.g. `"1G"`. |
| `toolProfiles[name].cpus` | `number` (int, positive) | Yes | -- | CPU count for tool containers. |
| `toolProfiles[name].workspaceRoot` | `string` | Yes | -- | Root directory for tool workspaces. Resolved relative to config file. |

### tcpPool

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tcpPool.basePort` | `number` (int, positive) | Yes | -- | Starting port number for the TCP connection pool. |
| `tcpPool.size` | `number` (int, positive) | Yes | -- | Number of ports in the pool. |

### Cross-field validations

The `systemConfigSchema` enforces two cross-field rules at parse time:

1. **secretsProvider required for 1Password secrets**: If any `zones[].secrets` entry, any `zones[].gateway.authProfilesRef`, or `host.githubToken` uses `source: "1password"`, then `host.secretsProvider` must be defined.
2. **toolProfile must exist**: Every `zones[].toolProfile` value must be a key in the top-level `toolProfiles` record.

---

## worker.json

Source: `workerConfigSchema` in `packages/agent-vm-worker/src/config/worker-config.ts`

This configures the agent-vm-worker behavior: which LLM to use, how phases execute, what verification commands to run, and what happens after work completes.

The worker scaffold generated by `agent-vm init --gateway-type worker` writes the current built-in `instructions` and `phases.*.instructions` values explicitly so teams can edit them in-place without reading runtime source.

### Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `instructions` | `string` | No | -- | Base instructions prepended to all phase prompts. The scaffolded `worker.json` includes the current built-in value explicitly. |
| `branchPrefix` | `string` | No | `"agent/"` | Prefix for branches created by the worker. |
| `commitCoAuthor` | `string` | No | `"agent-vm-worker <noreply@agent-vm>"` | Co-author line added to commits. |
| `idleTimeoutMs` | `number` (positive) | No | `1800000` (30 min) | Time in milliseconds before an idle worker shuts down. |
| `stateDir` | `string` | No | `"/state"` | Directory inside the VM where the worker reads config and stores state. |
| `verificationTimeoutMs` | `number` (positive) | No | `300000` (5 min) | Maximum time in milliseconds for each verification command. |

### defaults

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `defaults.provider` | `string` | No | `"codex"` | Default LLM provider for all phases. |
| `defaults.model` | `string` | No | `"latest-medium"` | Default model alias for all phases. See [model aliases](#model-aliases). |

### phases

All phases share a common base shape (`phaseExecutorSchema`):

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `provider` | `string` | No | -- | Override `defaults.provider` for this phase. |
| `model` | `string` | No | -- | Override `defaults.model` for this phase. |
| `skills` | `SkillReference[]` | No | `[]` | Skills available during this phase. Each entry: `{ name: string, path: string }`. |
| `instructions` | `string` | No | -- | Phase-specific instructions appended to the base instructions. The scaffolded `worker.json` includes the current built-in values explicitly for every phase. |

Individual phases add these extra fields:

| Phase | Extra Fields | Defaults |
|-------|-------------|----------|
| `phases.plan` | `maxReviewLoops` (int, non-negative) | `maxReviewLoops: 2` |
| `phases.planReview` | -- | -- |
| `phases.work` | `maxReviewLoops` (int, non-negative), `maxVerificationRetries` (int, non-negative) | `maxReviewLoops: 3`, `maxVerificationRetries: 3` |
| `phases.workReview` | -- | -- |
| `phases.wrapup` | -- | -- |

If the entire `phases` key is omitted, all phases use their defaults.

### mcpServers

Array of MCP server endpoints available to the worker.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mcpServers[].name` | `string` | Yes | -- | Display name for the MCP server. |
| `mcpServers[].url` | `string` | Yes | -- | URL of the MCP server endpoint. |

Default: `[]` (empty array).

### verification

Array of commands the worker runs to verify its work (tests, lint, type checks).

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `verification[].name` | `string` | Yes | -- | Display name for the verification step. |
| `verification[].command` | `string` | Yes | -- | Shell command to execute. |

Default:

```json
[
  { "name": "test", "command": "npm test" },
  { "name": "lint", "command": "npm run lint" }
]
```

### wrapupActions

Array of actions performed after the worker completes. Discriminated union on `type`:

| type | Fields | Defaults | Description |
|------|--------|----------|-------------|
| `git-pr` | `required` (boolean) | `required: true` | Create a pull request from the agent's branch. |
| `slack-post` | `webhookUrl` (string, URL), `channel` (string, optional), `required` (boolean) | `required: false` | Post a summary to a Slack channel. |

Default: `[{ "type": "git-pr", "required": true }]`

### Model aliases

When `defaults.model` or a phase-level `model` is set to an alias, the worker resolves it to a concrete model and reasoning effort based on the provider:

| Alias | Codex Model | Codex Effort | Claude Model | Claude Effort |
|-------|------------|--------------|-------------|---------------|
| `latest` | gpt-5.4 | high | claude-opus-4-6 | high |
| `latest-medium` | gpt-5.4 | low | claude-sonnet-4-6 | medium |
| `latest-mini` | gpt-5.4-mini | medium | claude-haiku-4-5 | medium |

If a model string is not a recognized alias, it passes through as-is with `medium` reasoning effort.

---

## .agent-vm/config.json

This file lives in the root of a project repository and uses the same schema as `worker.json` (`workerConfigSchema`). It lets individual projects customize worker behavior without changing the zone-level config.

### Merge behavior

The effective worker config is produced by deep-merging `worker.json` (base) with `.agent-vm/config.json` (override):

- **Objects**: merged recursively. Override fields replace base fields at the leaf level.
- **Arrays**: replaced entirely. The override array replaces the base array (no concatenation).
- **Zod defaults**: fill any remaining gaps after the merge.

### Common overrides

**Override verification commands** for a project that uses a different test runner:

```json
{
  "verification": [
    { "name": "test", "command": "pnpm vitest run" },
    { "name": "lint", "command": "pnpm oxlint ." },
    { "name": "typecheck", "command": "pnpm tsc --noEmit" }
  ]
}
```

**Change model for a specific phase** (e.g. use a stronger model for planning):

```json
{
  "phases": {
    "plan": {
      "model": "latest",
      "instructions": "This is a complex legacy codebase. Take extra care with dependency analysis."
    }
  }
}
```

**Add project-specific MCP servers**:

```json
{
  "mcpServers": [
    { "name": "project-docs", "url": "http://localhost:3100/mcp" }
  ]
}
```

---

## Environment Variables

| Variable | Context | Description |
|----------|---------|-------------|
| `OP_SERVICE_ACCOUNT_TOKEN` | Host | 1Password service account token. Used when `tokenSource.type` is `"env"` (defaults to this variable if `envVar` is not specified). Alternatively stored in macOS Keychain via `agent-vm init`. |
| `GITHUB_TOKEN` | Host | Fallback for controller-side git push when `host.githubToken` is not configured. |
| `AGENT_VM_WORKER_TARBALL_PATH` | Host | Dev override: path to a local worker tarball that gets injected into the gateway VM instead of the published npm package. |
| `STATE_DIR` | Inside VM | Directory where the worker reads its config and writes state. Default: `/state`. |
| `WORKSPACE_DIR` | Inside VM | Directory where repositories are mounted. Default: `/workspace`. |

---

## Annotated Example

A complete `system.json` for a worker-type zone:

```jsonc
{
  // --- Host configuration ---
  "host": {
    "controllerPort": 18800,             // Controller listens here
    "projectNamespace": "my-project",     // Must match ^[a-z0-9][a-z0-9-]*$

    // 1Password integration for secret resolution
    "secretsProvider": {
      "type": "1password",
      "tokenSource": {
        "type": "keychain",              // Reads SA token from macOS Keychain
        "service": "agent-vm",
        "account": "op-service-account-token"
      }
    },

    // Controller-side git push token
    "githubToken": {
      "source": "1password",
      "ref": "op://agent-vm/github-token/credential"
    }
  },

  // Build cache directory (resolved relative to this file)
  "cacheDir": "../cache",

  // --- VM image build configs ---
  "images": {
    "gateway": {
      "buildConfig": "../images/gateway/build-config.json",
      "dockerfile": "../images/gateway/Dockerfile"
    },
    "tool": {
      "buildConfig": "../images/tool/build-config.json",
      "dockerfile": "../images/tool/Dockerfile"
    }
  },

  // --- Zones (at least one required) ---
  "zones": [
    {
      "id": "dev-worker",

      "gateway": {
        "type": "worker",                // Runs agent-vm-worker directly
        "memory": "2G",
        "cpus": 2,
        "port": 18791,                   // Ingress port
        "gatewayConfig": "./dev-worker/worker.json",
        "stateDir": "../state/dev-worker",
        "workspaceDir": "../workspaces/dev-worker"
      },

      // Per-zone secrets — each key becomes available inside the VM
      "secrets": {
        "GITHUB_TOKEN": {
          "source": "1password",
          "ref": "op://agent-vm/github-token/credential",
          "injection": "http-mediation",  // Default; intercepts outbound HTTP
          "hosts": ["api.github.com"]     // Required for http-mediation
        },
        "OPENAI_API_KEY": {
          "source": "1password",
          "ref": "op://agent-vm/workers-openai/credential",
          "injection": "http-mediation",
          "hosts": ["api.openai.com"]
        }
      },

      // Hostnames the gateway VM is allowed to reach
      "allowedHosts": [
        "api.anthropic.com",
        "api.openai.com",
        "auth.openai.com",
        "api.github.com",
        "registry.npmjs.org"
      ],

      // WebSocket passthrough (empty for worker zones)
      "websocketBypass": [],

      // Must match a key in toolProfiles below
      "toolProfile": "standard"
    }
  ],

  // --- Tool container profiles ---
  "toolProfiles": {
    "standard": {
      "memory": "1G",
      "cpus": 1,
      "workspaceRoot": "../workspaces/tools"
    }
  },

  // --- TCP connection pool for VM networking ---
  "tcpPool": {
    "basePort": 19000,
    "size": 5
  }
}
```

---

## Quick Reference: Defaults at a Glance

For operator convenience, here are all fields that have Zod `.default()` values:

### system.json defaults

| Field | Default |
|-------|---------|
| `cacheDir` | `"./cache"` |
| `zones[].gateway.type` | `"openclaw"` |
| `zones[].websocketBypass` | `[]` |
| `zones[].secrets[].injection` | `"http-mediation"` |

### worker.json defaults

| Field | Default |
|-------|---------|
| `defaults.provider` | `"codex"` |
| `defaults.model` | `"latest-medium"` |
| `phases.plan.maxReviewLoops` | `2` |
| `phases.plan.skills` | `[]` |
| `phases.planReview.skills` | `[]` |
| `phases.work.maxReviewLoops` | `3` |
| `phases.work.maxVerificationRetries` | `3` |
| `phases.work.skills` | `[]` |
| `phases.workReview.skills` | `[]` |
| `phases.wrapup.skills` | `[]` |
| `mcpServers` | `[]` |
| `verification` | `[{ name: "test", command: "npm test" }, { name: "lint", command: "npm run lint" }]` |
| `verificationTimeoutMs` | `300000` (5 min) |
| `wrapupActions` | `[{ type: "git-pr", required: true }]` |
| `branchPrefix` | `"agent/"` |
| `commitCoAuthor` | `"agent-vm-worker <noreply@agent-vm>"` |
| `idleTimeoutMs` | `1800000` (30 min) |
| `stateDir` | `"/state"` |
