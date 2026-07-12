# Gondolin VM Layer

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Gondolin VM Layer

Deep dive into the stock Gondolin implementation: how
`@agent-vm/gondolin-vm-adapter` implements the backend-neutral
`@agent-vm/managed-vm` contracts with VFS mounts, HTTP secret mediation,
synthetic DNS, and fingerprint-cached image builds. This is the lowest
infrastructure layer -- every shipping gateway and Tool VM currently boots
through this adapter.

---

## What Gondolin Provides

Gondolin (`@earendil-works/gondolin`) is the external SDK that runs QEMU
micro-VMs on the host. The system never calls QEMU directly. Instead,
`gondolin-vm-adapter` translates neutral managed-VM requests and handles into
SDK calls. Only the adapter imports the SDK.

| Capability | SDK Surface | What It Does |
|------------|-------------|--------------|
| QEMU micro-VMs | `VM.create()` | Sub-second boot, configurable memory/CPU |
| VFS providers | `RealFSProvider`, `ReadonlyProvider`, `MemoryProvider`, `ShadowProvider` | Virtual filesystem mounts from host into guest |
| Rootfs modes | `readonly`, `memory`, `cow` | Controls whether the guest root filesystem is writable |
| HTTP mediation | `createHttpHooks()` | Intercepts outbound HTTP, injects secrets by host match |
| Synthetic DNS | `dns.mode: 'synthetic'` | Maps virtual hostnames to real TCP endpoints |
| TCP host mapping | `tcp.hosts` | Routes `hostname:port` inside VM to host-side TCP sockets |
| Ingress | `enableIngress()` | Routes inbound HTTP from host into a guest port |
| SSH access | `enableSsh()` | On-demand SSH tunnel into the VM |
| Image build | `buildAssets()` | Converts Docker OCI + build config into VM image artifacts |

---

## ManagedVm Interface

`ManagedVmFactory.createManagedVm()` returns the neutral `ManagedVm` handle
used by controller domains. The interface is defined by
`packages/managed-vm`; it deliberately exposes no Gondolin type, native VM
handle, or native filesystem object.

```
  ManagedVm
  |
  |-- id: string                         Unique VM identifier
  |-- start()                            Start the VM
  |-- getHostProcessId()                 Host PID; required after successful start
  |-- exec(command, options?)            Neutral awaitable/streaming process contract
  |-- enableSsh(options?) -> ManagedVmSshAccess
  |                                      Open SSH tunnel; returns exact server identity
  |-- enableIngress(options?) -> ManagedVmAccessHandle
  |                                      Open inbound HTTP route; returns host, port
  |-- configureIngressRoutes(routes)     Configure path-prefix routing into the VM
  |-- close()                            Shut down the VM and release all resources
```

`exec()` provides a backend-neutral awaitable and streaming contract. The
adapter translates commands, environment, PTY, signal, and stdin options to
Gondolin and translates results and output chunks back. Controller domains
cannot reach the SDK process or filesystem handles; file operations needed by
current workloads run through controlled guest commands or the Tool VM SSH
protocol.

`ManagedVmSshAccess` includes `host`, `port`, `user`, `command`,
`identityFile`, and an exact Ed25519 `serverHostKey`. `ManagedVmIngressRoute`
maps a URL prefix to a guest port with optional prefix stripping.

Gondolin ingress is for inbound HTTP from the host to guest HTTP services. The
gateway VM uses it to expose OpenClaw: agent-vm sets one route, `/` to the
OpenClaw guest gateway port, then listens on the configured host-facing gateway
port. OpenClaw's Control UI, API routes, SSE responses, readiness probes, and
WebSocket upgrades share that route.

Response buffering must stay disabled for streaming behavior such as SSE. The
Gondolin default allows WebSockets and streams response bodies; agent-vm keeps
buffering disabled explicitly when enabling gateway ingress. Timeout settings
control waiting for response headers and idle gaps between response chunks; they
do not create additional host port mappings.

Additional guest webservers require additional ingress routes from path prefixes
to guest ports. Raw TCP services remain `tcpHosts` mappings, not HTTP ingress.

---

## ManagedVmCreateRequest

Controller orchestration combines `GatewayVmRequirements` with controller-owned
image and resource decisions, then passes one neutral request to the injected
factory. The adapter translates this request into Gondolin SDK options.

| Field | Type | Purpose |
|-------|------|---------|
| `imageReference` | `string` | Provider image reference selected by controller image capability |
| `resources` | `{ memory, cpuCount }` | Backend-neutral resource request |
| `rootfsMode` | `'readonly' \| 'memory' \| 'cow'` | How the root filesystem handles writes |
| `allowedHosts` | `readonly string[]` | Outbound HTTP allowlist for mediation proxy |
| `mediatedSecrets` | `ManagedVmMediatedSecretDescriptor[]` | Host-side mediation values and allowed hosts; raw values never enter guest env or images |
| `mounts` | `Record<string, ManagedVmMount>` | Guest path to neutral mount policy, including single-use owned directories |
| `tcpHosts` | `ManagedVmTcpHostMapping[]` | Synthetic hostname to host TCP endpoint |
| `environment` | `Record<string, string>` | Environment variables injected into the VM |
| `sessionLabel` | `string` | Human-readable diagnostic label |
| `mediation` | `ManagedVmRequestMediation` | Optional request/response hooks |

---

## Rootfs Modes

The `rootfsMode` controls what happens when a process inside the VM writes to the root filesystem (outside VFS mounts).

```
  Mode        Backing                         Writes Survive VM Lifetime?    Use Case
  --------    -----------------------------   ----------------------------    --------
  cow         Copy-on-write qcow2 overlay     Yes (within session)            Gateway VMs: install packages,
                                                                              modify /etc, persist within session
  memory      Backend-specific throwaway      No (lost on close)              Available neutral mode;
              rootfs mode; QEMU snapshot,                                     not used by current Tool VMs
              krun temporary qcow2 on disk
  readonly    Immutable                       Rejected (write fails)          Not currently used in production
```

Gateway, Worker, and Tool VMs currently use `cow`. Tool VM isolation comes from
a new VM lifecycle and controlled mounts per lease, not from selecting
`rootfsMode: memory`. In Gondolin docs, rootfs `memory` means a throwaway rootfs
mode, not always RAM-backed storage; guest tmpfs and VFS `MemoryProvider` are
the memory-pressure paths.

---

## VFS Mount Types

VFS mounts map host directories into guest paths. The `vfsMounts` field maps a guest path (string key) to a `VfsMountSpec`. All VFS content is exposed under the `/data` FUSE mount point inside the VM.

```
  VfsMountSpec.kind     Provider Chain                  Behavior
  ----------------      --------------                  --------
  realfs                RealFSProvider(hostPath)         Read/write: host and guest share
                                                        a live directory
  realfs-readonly       ReadonlyProvider(                Read-only: guest can read but
                          RealFSProvider(hostPath))       writes are rejected
  memory                MemoryProvider()                 Host-memory-backed VFS provider:
                                                        starts empty, lost on VM close
  shadow                ShadowProvider(base, config)     Overlay with deny/tmpfs rules:
                          base = RealFS or Memory          deny: block writes to paths
                          deny paths -> writeMode:deny     tmpfs: redirect writes to RAM
                          tmpfs paths -> writeMode:tmpfs
```

Shadow mounts support two overlay behaviors configured via `shadowConfig`:
- `deny`: writes to matching paths fail with an error
- `tmpfs`: writes to matching paths go to a MemoryProvider upper layer (visible within session, lost on close). This is a Gondolin VFS provider path, not Linux guest tmpfs.

Path normalization ensures both absolute and relative shadow paths resolve correctly inside the guest.

---

## HTTP Mediation

HTTP mediation is how secrets reach outbound API calls without the VM process ever seeing the raw secret value. The Gondolin SDK intercepts all outbound HTTP traffic from the VM via `createHttpHooks()`.

```
  +-------------------+          +---------------------+          +------------------+
  | VM Process        |          | Gondolin HTTP Proxy  |          | External API     |
  |                   |          | (host-side)          |          |                  |
  | fetch("https://   | -------> | 1. Match request     | -------> | Receives request |
  |   api.openai.com  |          |    host against       |          | with secret in   |
  |   /v1/chat")      |          |    secrets[].hosts    |          | Authorization    |
  |                   |          | 2. If match: inject   |          | header           |
  |                   |          |    secret value into   |          |                  |
  |                   |          |    request headers     |          |                  |
  |                   |          | 3. Forward to target   |          |                  |
  +-------------------+          +---------------------+          +------------------+
```

Each neutral mediated-secret descriptor carries an environment-variable name,
an allowed-host list, and a value resolved at the trusted host boundary. The
adapter converts these descriptors to Gondolin HTTP hooks. The resolved value
may enter the trusted provider request for mediation, but never the guest
environment or image.

The hook bundle also sets environment variables (`hookBundle.env`) that configure the in-VM HTTP client to route through the mediation proxy. The VM process makes normal HTTP requests -- it never knows secrets are being injected.

For mediated secrets that are consumed through environment variables, such as
stdio MCP provider API keys, `hookBundle.env` also contains generated
placeholder values. The Gondolin adapter passes both `httpHooks` and
`hookBundle.env` into `VM.create()`: the hooks know how to substitute the
placeholder, and the env bundle is how the gateway process and its stdio
children receive the placeholder instead of the raw secret.

Only hosts in the `allowedHosts` list can be reached. Requests to unlisted hosts are blocked at the proxy layer. At the controller configuration layer, zones declare audience-scoped `egressHosts`; gateway and Tool VM lifecycle code translate that higher-level policy into the low-level Gondolin `allowedHosts` list for each VM.

---

## TCP Host Mapping

TCP host mapping lets processes inside the VM reach selected host-side TCP
services via synthetic DNS hostnames. In the managed control-plane cutover, this
is reserved for OpenClaw gateway access to Tool VM SSH ports. Gateway and Worker
control traffic uses controller-initiated Gondolin ingress WebSocket upgrades
instead of raw mapped TCP.

```
  Inside VM                          Host Side
  ---------                          ---------
  tool-0.vm.host:22          ------> 127.0.0.1:19000   (tool VM 0 SSH)
  tool-1.vm.host:22          ------> 127.0.0.1:19001   (tool VM 1 SSH)
```

When neutral `tcpHosts` mappings are provided, the adapter configures:
- `dns.mode: 'synthetic'` with `syntheticHostMapping: 'per-host'` -- Gondolin resolves virtual hostnames to per-host RFC2544 IPv4 answers such as `198.19.x.y`
- `dns.syntheticIPv4: '198.18.0.1'` -- fallback synthetic A answer when no per-host mapping applies
- `dns.syntheticIPv6: '::ffff:198.18.0.1'` -- shared IPv4-mapped RFC2544 AAAA answer so OpenClaw SSRF checks that validate all A/AAAA answers can accept the fake address under `allowRfc2544BenchmarkRange`
- `tcp.hosts` -- maps each virtual hostname to a real host-side TCP endpoint

The IPv4-mapped AAAA answer is an SSRF-validation compatibility value, not a
promise of general guest IPv6 egress. Raw TCP mappings such as
`tool-0.vm.host` still depend on the per-host IPv4 answer because Gondolin
derives mapped-TCP identity from the synthetic IPv4 host map. WebSocket traffic
uses Gondolin's HTTP upgrade bridge and the `websocketUpgrades` policy instead
of raw TCP mappings.

`allowedInternalHosts` is a Gondolin HTTP-hook escape hatch, not the fix for
Discord media SSRF failures. It can relax Gondolin's host-side HTTP internal-IP
block for matching request hostnames, but it does not change OpenClaw's own
Discord media SSRF resolver and does not apply to raw mapped TCP.

Worker VMs do not map the agent-vm controller endpoint for control traffic.
OpenClaw Gateway VMs map Tool VM SSH slots from the TCP pool.

The managed raw TCP exception is Tool VM SSH:

```text
gateway VM -> Tool VM SSH
  tool-<slot>.vm.host:22 -> 127.0.0.1:<tcpPool slot port>
  Used by OpenClaw command execution, filesystem bridge operations, finalize,
  and cached-lease probes.
```

Mapped TCP is raw forwarding. It does not go through Gondolin HTTP hooks,
egress header rewriting, or HTTP secret substitution. Keep mappings narrow and
debug timeouts as control-link or SSH-path failures, not as HTTP ingress
failures.

`enableSsh()` generates one Ed25519 server identity under the live VM's
ephemeral `/run` state and starts `sshd` with that key explicitly. Reopening
SSH on the same live VM preserves the identity; replacing the VM produces a
different identity. `SshAccess.serverHostKey` exposes only the validated public
algorithm/blob. Agent VM composes the Gateway-visible known-hosts alias and
fails closed if the field is missing or malformed.

## VM Capability Transports

`gateway-lifecycle` defines the shared lease vocabulary used by gateway kinds,
while `managed-vm` owns the neutral SSH access and server-identity contracts.
The current Tool VM lease specialization uses those contracts without exposing
the Gondolin SDK.

Only `ssh-sandbox` is implemented today. It means VM-to-VM SSH over `tcpHosts`:
the controller creates or reuses the Tool VM, calls `enableSsh()`, returns an
SSH capability to the OpenClaw gateway, and then leaves command I/O on the
gateway-to-Tool-VM SSH data path. The controller is the control plane, not a
command/file proxy.

The raw mapping remains byte-transparent. Server authentication is therefore
end-to-end between the Gateway SSH client and the exact Tool VM `sshd`, even
though the host-side TCP slot is reusable. A replacement Tool VM on the same
slot cannot satisfy the old lease's pinned server identity.

`gondolin-rpc` and `ingress-service` are reserved names for future capability
work. `gondolin-rpc` would require a separately designed controller-owned
execution and filesystem contract; the current neutral `ManagedVm` deliberately
has no native filesystem escape hatch. `ingress-service`
should mean a warm HTTP service inside a VM exposed through Gondolin ingress.
Neither is part of the current Tool VM SSH path.

OpenClaw's filesystem bridge remains plugin-owned. It is an OpenClaw
remote-shell filesystem protocol implemented over SSH; it is not a generic
Tool VM filesystem API.

---

## Image Build Pipeline

VM images are built from a `BuildConfig` (loaded from JSON) through Gondolin's `buildAssets()`. The pipeline uses content-addressed fingerprinting to cache builds.

```
  build-config.jsonc
    |
    v
  buildManagedVmImage({ buildConfigPath, cacheDir, fingerprintInput? })
    |
    |-- 1. Load config       JSON.parse(buildConfigPath) -> BuildConfig
    |-- 2. Fingerprint        SHA-256(stableSerialize(config) + fingerprintInput
    |                                      + gondolinVersion)
    |                         Truncated to 16 hex chars
    |-- 3. Cache check        Does cacheDir/{fingerprint}/ contain all 4 assets?
    |       |
    |       +-- HIT:  Return { imagePath, fingerprint, built: false }
    |       |
    |       +-- MISS: Continue to step 4
    |
    |-- 4. Build assets       gondolin.buildAssets(config, outputDir)
    |                         Docker OCI pull -> extract -> build rootfs
    |-- 5. Verify             Check manifest.json, rootfs.ext4,
    |                         initramfs.cpio.lz4, vmlinuz-virt all exist
    |-- 6. Return             { imagePath, fingerprint, built: true }
    v
  cacheDir/{fingerprint}/
    manifest.json
    rootfs.ext4
    initramfs.cpio.lz4
    vmlinuz-virt
```

`computeBuildFingerprint()` uses stable JSON serialization (sorted keys, no undefined values) to ensure the same config and fingerprint input always produce the same fingerprint regardless of property order. Docker-backed profiles pass the inspected Docker rootfs layer identity as fingerprint input, so unchanged Docker outputs can reuse Gondolin assets and changed Docker layers naturally produce a new generation.

`buildGatewayImage()` in `gateway-image-builder.ts` delegates through the
injected neutral `ManagedVmImageCapability`. The composition projection first
checks the profile-local prepared-image record written by `agent-vm build`; if
the build config, fingerprint input, fingerprint, and asset files still match,
startup reuses that image reference without invoking Gondolin. Otherwise the
selected capability loads and builds the image through backend tooling. Tool VM
startup uses the same prepared-image record contract.

`agent-vm build` dedupes repeated resolved build config path + effective
fingerprint pairs across configured image profiles in the same invocation. The
canonical profile runs the Gondolin asset build; duplicate profiles get
profile-local cache entries materialized from the canonical assets, preserving
runtime profile cache hits without repeating the Docker-to-ext4 conversion.

The `fullReset` option deletes the cached image directory before building, forcing a clean rebuild.

---

## gondolin-vm-adapter Exports

The `gondolin-vm-adapter` package
(`packages/gondolin-vm-adapter/src/index.ts`) has a deliberately narrow public
surface. It constructs a neutral provider plus primitive build/tooling
projections; it does not export SDK handles or adapter-native VM types.

| Export | Source | Purpose |
|--------|--------|---------|
| `createGondolinManagedVmProvider` | `managed-vm-provider.ts` | Construct the neutral aggregate provider at composition |
| `configureHostNetworkDefaults` | `host-network-defaults.ts` | Apply required host Node network defaults before VM construction |
| `createGondolinImageBuildTooling` | `build-pipeline.ts` | Create fingerprint-cached image build tooling |
| `buildImageAssetFileNames`, `hasBuiltImageAssets` | `build-pipeline.ts` | Primitive asset inventory and presence projection |
| `resolveGondolinMinimumZigVersion`, `resolveGondolinPackageSpec` | `gondolin-package.ts` | Primitive build/release provenance projections |

The shipping application imports this package in exactly two production
modules:

- `packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts` constructs
  one `ManagedVmProvider`, keeps the aggregate local, and injects only the
  factory, image, and owned-directory capabilities required downstream.
- `packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts` projects
  the selected backend's build metadata and tooling.

All controller domain, Gateway orchestration, Tool VM lifecycle, lease, health,
runtime-record, and recovery code imports `@agent-vm/managed-vm`, never the
adapter. Destructive recovery and process-identity fencing remain controller
authority; `ManagedVm.close()` is mechanical provider cleanup.

---

## Source Files

| File | Responsibility |
|------|----------------|
| `packages/managed-vm/src/managed-vm-contracts.ts` | Neutral `ManagedVm`, factory, provider capabilities, mounts, process, SSH, and ingress contracts |
| `packages/gondolin-vm-adapter/src/managed-vm-provider.ts` | Gondolin translation, VFS provider assembly, HTTP hooks, and neutral handle implementation |
| `packages/secret-management/src/contracts.ts` | `SecretRef`, `SecretResolver`, and `MediatedSecretSpec` shared contracts |
| `packages/secret-management/src/onepassword-secret-resolver.ts` | 1Password SDK client with isolated `op inject` fallback and token source resolution |
| `packages/secret-management/src/redacted-exec-file.ts` | Child-process execution with redacted failure formatting |
| `packages/secret-management/src/op-cli-service-account-env.ts` | Isolated service-account environment for `op` CLI fallback |
| `packages/gondolin-vm-adapter/src/vm-adapter.ts` | SDK translation and neutral VM handle implementation |
| `packages/gondolin-vm-adapter/src/pinned-realfs.ts` | Final-component no-follow open, identity revalidation, exact-once owned-directory cleanup |
| `packages/gondolin-vm-adapter/src/build-pipeline.ts` | Fingerprint-cached image build tooling and asset verification |
| `packages/gondolin-vm-adapter/src/mount-policy.ts` | Writable mount validation and auth path protection |
| `packages/gondolin-vm-adapter/src/policy-compiler.ts` | VM host allowlist compilation and deduplication |
| `packages/gondolin-vm-adapter/src/volume-manager.ts` | Persistent volume directory management |
| `packages/gondolin-vm-adapter/src/index.ts` | Narrow public exports |
| `packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts` | Runtime provider composition and narrow capability injection |
| `packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts` | Build/tooling composition projection |
