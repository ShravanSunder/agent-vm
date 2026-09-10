# System Architecture

[Overview](../README.md) > Architecture

System architecture covering all packages, the Hermes Gateway, the controller,
and the Gondolin VM layer. For mode-specific details:
[Hermes configuration](../reference/configuration/system-json.md) |
[Credentialed Managed Runtimes](credentialed-runtimes.md) |
[Storage Model](storage-model.md).

---

## How Components Interact

The system is nested containers. A caller reaches the managed Hermes agent
runtime. The controller manages Gateway and Tool VMs, secrets, authorization,
and durable state. The inner Gondolin VMs are the sandbox boundary.

```
  Caller (CLI / CI / API)
       |
       v
  +----------------------------------------------------+
  | Agent Runtime (host process)                        |
  |                                                     |
  |  +----------------------+                           |
  |  | Controller :18800    |                           |
  |  | - secret resolver    |                           |
  |  | - VM lifecycle       |                           |
  |  | - lease manager      |                           |
  |  +----------------------+                           |
  |          |                                          |
  |          v (boot VM)                                |
  |  +------------------------------------------+       |
  |  | Gondolin VM                              |       |
  |  |                                          |       |
  |  |  +------------------------------------+  |       |
  |  |  | Managed Hermes agent               |  |       |
  |  |  +------------------------------------+  |       |
  |  |                                          |       |
  |  |  /home/hermes/.hermes (durable state)    |       |
  |  |  /agent-vm/logs       (runtime logs)      |       |
  |  +------------------------------------------+       |
  +----------------------------------------------------+
```

### Controller ↔ Managed VM Provider

The `agent-vm` composition root selects `gondolin-vm-adapter` and projects its
provider into narrow `managed-vm` capabilities for VM creation, owned host
directories, images, and diagnostics. Gateway lifecycles supply neutral
`GatewayVmRequirements`; the controller authorizes paths, resolves resources,
and constructs a neutral VM request. Domain code receives a `ManagedVm` handle
with structural operations such as `exec()`, `enableSsh()`, `enableIngress()`,
and `close()`—never a native Gondolin instance or filesystem object. Zone config
uses audience-scoped `egressHosts`; lifecycle code derives the per-VM
`allowedHosts` list from that higher-level policy.

→ Deep dive: [subsystems/gondolin-vm-layer.md](../subsystems/gondolin-vm-layer.md)
→ Upstream Gondolin sandbox example:
[Quick Example](https://github.com/earendil-works/gondolin/blob/main/README.md#quick-example)

### Controller ↔ Hermes (managed Gateway)

The Gateway VM runs long-term. The Hermes adapter reaches Gateway Runtime over
its private managed boundary. When an agent needs tool execution, Gateway
Runtime asks the controller for a Tool VM capability over the private control
session. The controller boots a Tool VM and returns fenced access details; the
Gateway VM does not call the controller's public HTTP lease routes.

→ Configuration: [system-json.md](../reference/configuration/system-json.md)
→ Lease manager: [subsystems/controller.md](../subsystems/controller.md#lease-manager)

### Capability Portals

Agent-facing capability calls are separate from VM execution. Tool Portal is the
managed Hermes capability facade and exposes the native
`tool_portal_list/search/describe/call` surface. MCP Portal is the MCP-specific
provider backend for Tool Portal and also remains available through the separate
`mcp-portal mcp-proxy serve` adapter for external MCP clients.

Tool Portal is the cross-backend contract layer for capabilities that may come
from MCP providers, controller-owned host actions, or Tool VM runner-backed
execution. It uses portal-neutral Zod v4 contracts from
`@agent-vm/agent-portal-sdk` and composes MCP-backed capabilities through
`@agent-vm/mcp-portal/mcp-provider-backend`. Managed Hermes does not reuse the
standalone model-visible `mcp_portal_*` tool names.

Today, Tool Portal is the managed Hermes model-visible portal surface and the
package-level composition layer for backends. MCP Portal remains the MCP
provider/runtime backend instead of a second policy
authority.

→ Deep dive: [subsystems/mcp-portal.md](../subsystems/mcp-portal.md)

### Credentialed Managed Runtimes

A Tool Portal `controller_execution` configured CLI may target a reusable
credentialed Managed VM. The controller owns exactly one current runtime per
zone and authenticated agent; each call is authorized independently, while a
compatible healthy VM may retain CLI state across calls for up to 15 idle
minutes. File credentials are finalized into read-only memory before boot, HTTP
credentials remain host-side behind opaque placeholders, and CLI
config/state/cache stays on disposable COW rootfs.

The credentialed runtime remains separate from leased Tool VMs. A configured
CLI may instead select `executionTarget.kind: "tool_vm"`; the Gateway then uses
the same current Tool VM lease and direct strict-pinned SSH path as
`tool_vm_runner` and framework Sandbox APIs. That target authors its Portal-call
policy with `suggest*` names because direct terminal, Python, SSH, or other Tool
VM execution bypasses the Tool Portal route.

→ Deep dive: [credentialed-runtimes.md](credentialed-runtimes.md)

### Controller-Owned OAuth Broker

An optional `oauth.config.jsonc` beside a managed Hermes zone's Tool Portal config
enables human-owned Google accounts with separate agent/account/application
authorizations. Clerk authenticates the person using Google identity sign-in only;
it never supplies Google resource credentials. Tailscale admits the browser's
network connection but does not establish account ownership. The controller owns
direct tailnet HTTPS on port `18900`, stores envelope-encrypted credentials and
account policy in controller state, and gives Gog only a short-lived access-token
placeholder through the authenticated agent's singleton credentialed Managed
runtime.

Google callbacks retain `no-referrer` and redirect to clean, browser-bound
confirmation or retry pages. Those pages use `same-origin` so native forms send
the Origin required by the controller without retaining the callback query in
the form URL. Reauthorization confirmation compares verified previous permission
groups with the proposed groups before the owner confirms the change.

Tool Portal resolves each admitted Gog call against the exact account, application,
service effects, current grant, and account-specific Read/Write policy. Explicit
website overrides win independently over live config defaults; `Deny`, `Ask`, and
`Allow` are all supported, so writes are not universally forced to Ask. The
account owner must also be a configured editor for lasting policy changes.
Invocation approval still authorizes only one exact call and cannot expand OAuth
consent or standing policy. Local `disconnect` replaces provider `revoke`: it
stops future use of one authorization without calling Google or affecting another
agent's authorization.

→ Design: [Agent account authorization and Gog execution](../specs/2026-09-04-agent-account-and-tool-permissions/program-design.md)
→ File path: [Shared staging for Gog files](../specs/2026-09-04-agent-account-and-tool-permissions/file-delivery.md)

### Secrets Flow

Secrets are resolved on the host and split into two channels:

```mermaid
flowchart TB
    config["system.json
zone.secrets"]
    resolver["composite resolver"]
    split["split resolved secrets"]
    env["VM env vars"]
    mediation["HTTP mediation"]
    external["external APIs"]

    config --> resolver
    resolver --> split
    split -->|"injection: env"| env
    split -->|"injection: http-mediation"| mediation
    mediation --> external
```

→ Deep dive: [subsystems/secrets-and-credentials.md](../subsystems/secrets-and-credentials.md)
→ Upstream mediation reference:
[Quick Example](https://github.com/earendil-works/gondolin/blob/main/README.md#quick-example)

### Gateway Lifecycle Contract

Hermes implements the `GatewayLifecycle` interface. The controller gets neutral
VM requirements plus managed-framework boot metadata and protected inputs.

→ Deep dive: [subsystems/gateway-lifecycle.md](../subsystems/gateway-lifecycle.md)

---

## Package Dependency Graph

Workspace packages compose the system. Dependencies flow downward.

```
  hermes-gateway ----------> gateway-lifecycle --> managed-vm
                                                   |
  agent-vm -----------------------------------------+
      |
      +--> gondolin-vm-adapter ---------------------+
                 |
                 v
         @earendil-works/gondolin

  control-protocol-contracts
        |
        +--> gateway-control-contracts
        |          |
        |          v
        |        agent-vm
        |          |
        |          v
        |       agent-vm
  agent-portal-sdk ---> mcp-portal
            |              |
            |              v
            +---------> tool-portal
                            ^
                            |
             controller-execution-contracts

  gateway-runtime ---> agent-portal-sdk
          |-----------> gateway-control-contracts
          |-----------> mcp-portal
          +-----------> tool-portal

  config-contracts and secret-management provide shared contracts used by the
  controller, gateways, MCP Portal, Tool Portal, and plugins.

  The Hermes Python adapter reaches Gateway Runtime over its private managed
  attachment and uses controller-authorized Tool VMs.
```

| Package | Responsibility |
|---------|----------------|
| **secret-management** | Shared secret contracts and resolvers for environment and 1Password-backed references. |
| **config-contracts** | Zod-owned configuration contracts and generated schema sources for system, MCP Portal, and Tool Portal config. |
| **control-protocol-contracts** | Shared Socket.IO control-session envelope, identity, fencing, delivery, sequencing, close reason, and ack/result Zod contracts. |
| **gateway-control-contracts** | Gateway-domain control RPC Zod contracts for gateway readiness, lease intent/observation, health, recovery, and controller-host-action requests. |
| **managed-vm** | Backend-neutral structural contracts for VM creation/runtime, images, diagnostics, and owned host-directory capabilities. It exposes no native provider handle or filesystem escape hatch. |
| **gondolin-vm-adapter** | Implements `managed-vm` with the Gondolin SDK, including VM translation, owned host directories, image builds, VFS, ingress, SSH, and HTTP mediation. |
| **gateway-lifecycle** | The managed gateway contract: `GatewayLifecycle`, neutral `GatewayVmRequirements`, managed-framework boot inputs, shared runtime policy, and secret-placement intent. |
| **hermes-gateway** | Hermes lifecycle and immutable managed image recipe: profile directories, exact managed-framework boot inputs, protected interactive SSH, Tool VM TCP hosts, and telemetry projection. |
| **agent-portal-sdk** | Portal-neutral Zod v4 contracts for list/search/describe/call results, capability descriptions, approvals, artifacts, diagnostics, and adapter envelopes. |
| **mcp-portal** | MCP-specific capability facade, upstream MCP client runtime, scoped catalog/search, schema validation, approval evaluation, external MCP proxy, and MCP provider backend for Tool Portal composition. |
| **tool-portal** | Cross-backend capability portal contracts, CLI allowance validation, and in-process entrypoint that dispatches MCP-backed capabilities through the MCP Portal backend and controller-owned host actions. |
| **gateway-runtime** | Private managed-Gateway attachment, Gateway Control coordination, Tool Portal composition, and common sandbox/process/filesystem/stream execution over controller-authorized Tool VMs. |
| **controller-execution-contracts** | Zod contracts for controller dispatch, controller host-action, and Tool VM runner boundaries. |
| **agent-vm** | The controller and application composition root. Its regular Gondolin adapter dependency is confined to the provider-composition and build-tooling modules; controller domains consume narrow `managed-vm` projections. |

---

## Controller Architecture

The controller is the host-side process that owns VM lifecycles, serves the HTTP API, and never executes untrusted code. It runs on the host machine and communicates with gateway VMs over HTTP.

### Startup Sequence

`startControllerRuntime()` in `controller-runtime.ts` executes these steps in order:

```
  1. Resolve secrets         createSecretResolver() -> composite resolver
  2. Create TCP pool         createTcpPool(config.tcpPool)
  3. Create lease manager    createLeaseManager({ tcpPool, createManagedVm })
	4. Create credential manager and recover recorded child runtimes
	5. Start idle reapers      Tool VM policy + fixed credential-runtime TTL
	6. Create zone registry    one runtime per selected configured zone
	7. Start selected zones    Hermes Gateways at boot
	8. Wire HTTP routes        createControllerService() -> Hono app
	9. Bind HTTP server        startControllerHttpServer({ port: config.host.controllerPort })
```

Hermes routes dispatch through the requested `zoneId`; unknown-zone operations
return typed HTTP errors instead of using one process-wide active zone.

### HTTP API (Hono on :18800)

The controller exposes a REST API. Routes are split across core health routes,
private control-session owned lease handling, and zone operation routes in
`controller-zone-operation-routes.ts`.

| Method | Path | Purpose | Mode |
|--------|------|---------|------|
| `GET` | `/health` | Controller liveness check | Controller |
| `GET` | `/controller-status` | Controller operational status | Managed Gateway |
| `GET` | `/zones/:zoneId/health` | Live gateway health probe | Hermes |
| `GET` | `/zones/:zoneId/logs` | Fetch gateway VM logs | Hermes |
| `POST` | `/zones/:zoneId/credentials/refresh` | Re-resolve zone secrets and restart | Hermes |
| `POST` | `/zones/:zoneId/destroy` | Stop and destroy a gateway zone | Hermes |
| `POST` | `/zones/:zoneId/upgrade` | Restart gateway zone with fresh image | Hermes |
| `POST` | `/zones/:zoneId/enable-ssh` | Enable SSH access to the gateway VM | Hermes |
| `POST` | `/zones/:zoneId/execute-command` | Execute a shell command in the gateway VM; requires zone admin token when adminAccess is configured | Hermes |
| `POST` | `/stop-controller` | Graceful shutdown: release leases, stop gateway, close server | Controller |

### Key Subsystems

**TCP Pool** (`tcp-pool.ts`): Manages a fixed pool of TCP port slots. Each tool VM gets a unique slot mapped to `127.0.0.1:{basePort + slot}`. The gateway VM sees these as `tool-{slot}.vm.host:22` via Gondolin's synthetic DNS. Pool size is configured in `systemConfig.tcpPool.size`.

**Lease Manager** (`lease-manager.ts`): Creates, tracks, and releases Tool VM
leases. Each lease holds a `ManagedVm`, TCP slot, SSH access details, agent
identity, work-mount identity, and timestamps. Live leases are reused by
`zoneId` and `agentId` when the requested profile and validated work mount
match, so one Hermes agent can keep using the same Tool VM while the idle TTL
keeps capacity bounded.

**Idle Reaper** (`idle-reaper.ts`): Runs on a 60-second interval. Any lease
with `lastUsedAt` older than its resolved TTL is automatically released. The
policy uses the single `leaseIdleTtl.defaultMs` value, bounded request overrides,
and the default 100 minute fallback.

**Credentialed Runtime Manager** (`credentialed-runtime/`): Creates or reuses
one compatible Managed VM per zone and authenticated agent, enforces one active
command without queueing, projects credentials only during creation, retires
after 15 idle minutes, and performs exact crash recovery and operator
retirement.

---

## Gateway Abstraction

The `GatewayLifecycle` interface (`gateway-lifecycle` package) is the contract
the Hermes Gateway implements. The controller consumes neutral lifecycle data
rather than framework-native VM handles.

### Interface

```
  GatewayLifecycle
  |
  |-- buildVmRequirements(options)   Pure data -> GatewayVmRequirements
  |     environment                    Env vars for the VM
  |     vfsMounts                      Host-to-guest folder mappings
  |     mediatedSecrets                Secrets injected via HTTP mediation
  |     tcpHosts                       Synthetic DNS -> TCP host mappings
  |     allowedHosts                   Derived outbound HTTP allowlist
  |     rootfsMode                     cow | memory | readonly
  |     sessionLabel                   {namespace}:{zone}:gateway
  |
  |-- executionModel = managed-gateway
  |     buildFrameworkServiceBootMetadata()
  |     buildFrameworkServiceBootInputs()
  |     interactiveSsh
  |
  |-- prepareHostState?(zone, resolver)
```

### Lifecycle Loader

`gateway-lifecycle-loader.ts` accepts the Hermes gateway type and returns the
statically imported Hermes lifecycle; there is no dynamic loading.

### Hermes Implementation

Hermes uses the managed-Gateway execution model, protected profile and zone
files, controller-authored framework environment, Tool VM SSH slots, and the
exact-two-role Gateway Runtime plus Hermes service boot. It calls
`splitResolvedGatewaySecrets()` to partition resolved secrets into environment
variables (`injection: env`) and HTTP-mediated secrets (`injection:
http-mediation` with required `hosts[]`). See the Secrets Flow section below.

---

## Gondolin VM Layer

Gondolin (`@earendil-works/gondolin`) provides QEMU micro-VMs with sub-second boot times and strong host isolation. The `gondolin-vm-adapter` package implements the neutral `managed-vm` contracts with that SDK.

### What Gondolin Provides

| Capability | Description |
|-----------|-------------|
| **QEMU micro-VMs** | Lightweight VMs with configurable memory and CPU |
| **VFS mounts** | `RealFSProvider` (read/write), `ReadonlyProvider`, `MemoryProvider`, `ShadowProvider` (deny/tmpfs overlays) |
| **Rootfs modes** | `readonly` (immutable), `memory` (RAM-backed, ephemeral), `cow` (copy-on-write, persists within session) |
| **HTTP mediation** | `createHttpHooks` intercepts outbound HTTP, injects secrets into request headers by host match |
| **Synthetic DNS** | Maps selected virtual hostnames such as `tool-0.vm.host:22` to real TCP endpoints |
| **Ingress** | Routes external HTTP traffic into the VM at a specified guest port |
| **SSH** | On-demand SSH access into the VM for debugging |
| **Image build** | `buildAssets()` converts a build config into a VM image: `rootfs.ext4`, `initramfs.cpio.lz4`, `vmlinuz-virt` |

### gondolin-vm-adapter Provider

The `gondolin-vm-adapter` package keeps raw SDK operations behind the neutral provider:

- **VM provider** -- translates neutral creation requests into Gondolin VFS,
  mediation, networking, ingress, SSH, and runtime operations.
- **Owned directories** -- pins and revalidates security-sensitive host
  directories without exporting native filesystem handles.
- **Image tooling** -- performs fingerprint-cached Gondolin image builds and
  projects only the primitive build metadata needed by `agent-vm`.

`agent-vm` imports this package only from
`packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts` and
`packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts`. Gateway
orchestration, Tool VM orchestration, leases, health, runtime records, recovery,
and supervision use `managed-vm` contracts and cannot call a backend escape
hatch such as `getVmInstance()`.

### VFS Mount Types

```
  Mount Kind        Provider           Behavior
  -----------       --------           --------
  realfs            RealFSProvider     Host directory shared read/write with VM
  realfs-readonly   ReadonlyProvider   Host directory shared read-only
  memory            MemoryProvider     RAM-backed, ephemeral (lost on VM close)
  shadow            ShadowProvider     Overlay: deny writes to specific paths,
                                       or redirect writes to tmpfs
```

---

## Gateway Zone Orchestrator

`gateway-zone-orchestrator.ts` is the boot sequence for any gateway VM, regardless of type. It coordinates the lifecycle, neutral image capability, and injected `ManagedVmFactory`.

Before successor admission, controller startup performs record-based cleanup
from Gateway and Tool VM runtime records; controller restart never adopts an
existing VM. `startGatewayZone` then owns the new Gateway epoch and its exact
runner identity. See [Controller](../subsystems/controller.md), [Gateway
Lifecycle](../subsystems/gateway-lifecycle.md), and [Gondolin VM
Layer](../subsystems/gondolin-vm-layer.md) for the subsystem contracts.

```
  startGatewayZone(options)
    |
    |-- 1. Resolve startup inputs     lifecycle, config, secrets, image, host state
    |-- 2. Allocate Gateway epoch     controller-owned identity seed
    |-- 3. Construct VM handle        createManagedVm(vmSpec) -> unstarted ManagedVm
    |-- 4. Attach VM identity         gateway epoch seed + vm.id
    |-- 5. Start VM                   vm.start()
    |-- 6. Capture runner identity    exact host PID + process identity
    |-- 7. Persist runtime record     schema v2, before guest bootstrap or publication
    |-- 8. Start Gateway service      bootstrap, process start, service-health proof
    |-- 9. Publish ingress            configure routes, enable ingress, enrich runtime record
    |-- 10. Establish control link    connect control session and publish started result
    |
    v
  Returns controller-owned runtime handles, including terminateVm

  startup failure
    -> exact-terminate the captured runner through controller-managed termination
    -> close the stock Gondolin handle directly only when no runner exists
```

---

## Hermes managed Gateway

Hermes runs as the long-lived managed interactive-agent Gateway. Its Gateway VM
persists across requests and contains exactly the common Gateway Runtime service
and the Hermes framework service.

```
  Controller (:18800)
       |
       |-- Gateway VM (Hermes, long-running)
       |      |-- Gateway Runtime service
       |      |-- Hermes framework service
       |      |-- protected Hermes home and per-profile zone files
       |      |
       |      |-- Serves private control session via Gondolin ingress
       |      |-- Requests tool VM leases through gateway_control_rpc
       |
       |-- Tool VM 0 (on-demand via lease, tool-0.vm.host:22)
       |-- Tool VM 1 (on-demand via lease, tool-1.vm.host:22)
       |-- ...up to tcpPool.size
```

The Gateway VM boots at controller startup and stays running. Tool VMs are
created on demand through the private Gateway control session. Each receives a
TCP slot, fenced SSH access, the controller-selected workspace at `/work`, and
reviewed read-only `/agent-vm` inputs. Stable Hermes profile identity and
trusted controller configuration select those capabilities; callers do not
provide host mount paths. `prepareHostState()` creates protected profile
directories before boot. The Gateway reaches Tool VMs through synthetic DNS
(`tool-{n}.vm.host:22`).

---

## Secrets Flow

Secrets are resolved on the host and delivered to VMs through two channels. Host-only secrets (e.g., `githubToken` for controller-owned git push) never enter any VM.

```
  system.jsonc
    |
    |  host.secretsProvider.tokenSource
    |    -> resolve 1Password service account token (env | keychain)
    v
  Composite Secret Resolver
    |  Dispatches by SecretRef.source:
    |    '1password' -> onePasswordResolver.resolve(ref)
    |    'environment' -> process.env[ref.ref]
    |    'config' -> ref.value
    |
    +---> resolveZoneSecrets(zone, resolver)
    |       |  For each zone.secrets[name]: resolve to plain text
    |       v
    |     splitResolvedGatewaySecrets(zone, resolvedSecrets)
    |       |
    |       +---> injection: 'env'            -> VM environment variable
    |       +---> injection: 'http-mediation' -> Gondolin HTTP hooks inject
    |                                            secret for matching hosts[]
    |
    +---> resolveControllerGithubToken()
            HOST-ONLY: never enters any VM
            Used by controller-owned git operations from the host
```

```mermaid
flowchart TB
    config["system.jsonc
zone.secrets"]
    resolver["composite resolver"]
    split["split resolved secrets"]
    env["VM env vars"]
    mediation["HTTP mediation"]
    external["external APIs"]

    config --> resolver
    resolver --> split
    split -->|"env"| env
    split -->|"http-mediation"| mediation
    mediation --> external
```

### Secret Injection Modes

| Mode | Config | How It Works | Use Case |
|------|--------|-------------|----------|
| `env` | `injection: 'env'` | Secret set as environment variable in VM | API keys the process reads from env |
| `http-mediation` | `injection: 'http-mediation', hosts: [...]` | Gondolin intercepts outbound HTTP to listed hosts and injects secret into request headers | API keys for specific services (OpenAI, Anthropic) -- the VM process never sees the raw secret |
| Host-only | `host.githubToken` | Resolved on controller, never passed to VM | Git push operations from the controller |

---

## VM Image Build

VM images are built from Docker OCI base images via Gondolin's build pipeline. Images are cached by a content-addressed fingerprint.

### Build Pipeline

```
  build-config.jsonc (referenced from system.jsonc)
    |
    v
  buildGatewayImage() / buildGondolinImage()
    |-- 1. Load authored build config JSONC
    |-- 2. Fingerprint: SHA-256(content-normalized buildConfig + runtimeBuildVersionTag + fingerprintInput), truncated to 16 hex
    |-- 3. Cache hit?  cacheDir/vm-images/{fingerprint}/ passes manifest and file-structure validation -> return cached
    |-- 4. Cache miss: staged Gondolin build -> verify checksums -> native no-replace publication
    |-- 5. Output: { imagePath, fingerprint, built: true|false }
    v
  cacheDir/vm-images/{fingerprint}/
    manifest.json, rootfs.ext4, initramfs.cpio.lz4, vmlinuz-virt
```

Referenced local build inputs contribute their content and relevant file modes,
not their placement on the host, to the effective fingerprint. Python 3 provides
the standard-library bridge to native no-replace publication on macOS/Linux.
Reuse avoids rehashing large image assets; new publication verifies full hashes.

The identifier file is shared by all image profiles because it represents
the system build environment, not an individual gateway or tool VM.

### Two Image Types

| Image | Config Path | Used By | Rootfs Mode |
|-------|-------------|---------|-------------|
| Gateway | `imageProfiles.gateways.<name>.buildConfig` | Hermes Gateway VMs | `cow` |
| Tool | `imageProfiles.toolVms.<name>.buildConfig` | Tool VMs (on-demand code execution) | `cow` |

Gateway and Tool VM images use copy-on-write rootfs so their processes can
modify the filesystem within the session without mutating the base image. Tool
VM teardown still discards that session-local copy-on-write state.

---

## Configuration Overview

The system is configured by `system.json` plus gateway-specific config files.
All relative paths in `system.json` are resolved relative to the config file's
directory.

```
  system.json
  |-- host              Controller port, project namespace, secrets provider, GitHub token
  |-- storageRootDir    Sole authored standard operational storage root
  |                      Derives global cache/controller paths and each zone's
  |                      state, zone-files, and runtime leaves
  |-- images            Build config paths for gateway and tool VM images
  |-- zones[]           Zone definitions: gateway type, secrets, audience-scoped egress hosts
  |                      and managed Tool Portal agent credential bindings
  |-- toolVmProfiles    Named Tool VM profiles (memory, cpus, image profile)
  |-- tcpPool           Port range and pool size for tool VM TCP slots
  |-- leaseIdleTtl      Optional lease idle TTL policy
```

Each zone declares `gateway.type: "hermes"`, resource limits, secret references,
and audience-scoped outbound `egressHosts`.
Gateway VMs receive `gateway | both` egress hosts and secrets; Hermes Tool VMs
receive only `tool-vm | both` mediated secrets and egress hosts. Hermes
zones also declare a fallback `defaultToolVmProfile` and an explicit
`agentToolVmProfiles` map. `agentToolVmProfiles` can override that fallback for
`agent:<agentId>` tool leases inside the same zone. The schema validates image
profile references and requires
`host.secretsProvider` when any secret uses the `1password` source.

For the field-by-field reference, see
[configuration/README.md](../reference/configuration/README.md).

For state/cache/workspace/gitdir/backup boundaries, see
[storage-model.md](storage-model.md) and [storage-matrix.md](storage-matrix.md).
Do not move rebuildable dependency trees into `stateDir` just to make them
survive VM reboot; use image/rootfs or cache instead.

For upstream Gondolin image-build capabilities and sandbox features, see
[Feature Highlights](https://github.com/earendil-works/gondolin/blob/main/README.md#feature-highlights).

---

## Trust Zones

The system operates across three trust boundaries:

```
  +====================================================================+
  |  ZONE 1: HOST  (fully trusted)                                      |
  |                                                                     |
  |  Controller process, secret resolver, GitHub token, Docker daemon   |
  |  Can: resolve secrets, push branches, manage VMs                    |
  |  Never: runs untrusted code                                         |
  |                                                                     |
  |  +---------------------------------------------------------------+  |
  |  |  ZONE 2: GATEWAY VM  (partially trusted)                      |  |
  |  |                                                                |  |
  |  |  Long-running Hermes process                                   |  |
  |  |  Has: gateway-audience env and HTTP-mediated secrets            |  |
  |  |  Can: make outbound HTTP to gateway-audience hosts, reach       |  |
  |  |       controller                                                |  |
  |  |  Cannot: access host filesystem outside VFS mounts             |  |
  |  |                                                                |  |
  |  |  +----------------------------------------------------------+  |  |
  |  |  |  ZONE 3b: CREDENTIALED MANAGED VM  (untrusted)          |  |  |
  |  |  |  Per-agent reusable CLI runtime; no Tool VM lease/SSH.   |  |  |
  |  |  |  Read-only credential memory + disposable COW rootfs.    |  |  |
  |  |  +----------------------------------------------------------+  |  |
  |  |  |  ZONE 3: TOOL VM  (untrusted)                            |  |  |
  |  |  |                                                           |  |  |
  |  |  |  Ephemeral, per-lease. Runs LLM-generated code.           |  |  |
  |  |  |  Has: filtered /workspace, rootfs /work, no net            |  |  |
  |  |  |  Can: edit its workspace, use /work, run commands          |  |  |
  |  |  |  Cannot: reach the internet, access secrets, persist      |  |  |
  |  |  +----------------------------------------------------------+  |  |
  |  +---------------------------------------------------------------+  |
  +=====================================================================+
```

---

## Go Deeper

| Document | Scope |
|----------|-------|
| [reference/configuration/system-json.md](../reference/configuration/system-json.md) | Hermes managed Gateway configuration, profiles, secrets, ingress, and Tool VM policy |
| [credentialed-runtimes.md](credentialed-runtimes.md) | Per-agent configured CLI runtime ownership, admission, credentials, reuse, and retirement |
| [reference/configuration/README.md](../reference/configuration/README.md) | Progressive configuration reference |
| [getting-started/setup.md](../getting-started/setup.md) | Prerequisites, installation, first-run instructions |
| [subsystems/controller.md](../subsystems/controller.md) | Controller internals: lease lifecycle, TCP pool, idle reaper |
| [subsystems/secrets-and-credentials.md](../subsystems/secrets-and-credentials.md) | Secret resolution, 1Password integration, HTTP mediation details |
| [subsystems/gondolin-vm-layer.md](../subsystems/gondolin-vm-layer.md) | Gondolin VM adapter, VFS mounts, rootfs modes, HTTP mediation, image build pipeline |
| [subsystems/gateway-lifecycle.md](../subsystems/gateway-lifecycle.md) | Gateway abstraction: GatewayLifecycle interface and Hermes managed Gateway |
