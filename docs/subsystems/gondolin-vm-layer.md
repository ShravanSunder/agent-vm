# Gondolin VM Layer

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Gondolin VM Layer

Deep dive into the Gondolin VM abstraction: how `gondolin-adapter` wraps the `@earendil-works/gondolin` SDK into a managed VM interface with VFS mounts, HTTP secret mediation, synthetic DNS, and fingerprint-cached image builds. This is the lowest infrastructure layer -- every gateway and tool VM in the system boots through this adapter.

---

## What Gondolin Provides

Gondolin (`@earendil-works/gondolin`) is the external SDK that runs QEMU micro-VMs on the host. The system never calls QEMU directly. Instead, `gondolin-adapter` wraps the SDK into a dependency-injectable adapter with narrower types.

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

`createManagedVm()` returns a `ManagedVm` -- the handle every consumer uses to interact with a running VM. The interface is defined in `vm-adapter.ts`.

```
  ManagedVm
  |
  |-- id: string                         Unique VM identifier
  |-- exec(command, options?)            Run via Gondolin ExecProcess:
  |                                      awaitable ExecResult and stream-capable
  |-- fs                                 Gondolin VmFs: access, mkdir, listDir, stat,
  |                                      rename, buffered and streaming read/write,
  |                                      delete
  |-- enableSsh(options?) -> SshAccess   Open SSH tunnel; returns client and exact server identity
  |-- enableIngress(options?) -> IngressAccess
  |                                      Open inbound HTTP route; returns host, port
  |-- setIngressRoutes(routes)           Configure path-prefix routing into the VM
  |-- getVmInstance() -> ManagedVmInstance
  |                                      Access the underlying SDK VM handle
  |-- close()                            Shut down the VM and release all resources
```

`exec()` intentionally preserves Gondolin's native shape: string commands run
through a login shell, array commands execute a specific binary, and options
such as `stdout: 'pipe'`, `stderr: 'pipe'`, `stdin`, `pty`, `signal`,
`windowBytes`, and `buffer: false` flow through to the SDK. Awaiting the return
value yields Gondolin's `ExecResult`; when stdout/stderr are piped, callers can
stream the process output with Gondolin's backpressure window.

`fs` is the native Gondolin filesystem surface, not a separate agent-vm RPC
protocol. It supports direct file operations and streaming reads/writes. For
VFS-mounted paths, those operations hit the host-side VFS provider. For guest
rootfs paths, Gondolin may wait for exec idle before serving file RPC, so
long-running command artifacts should be written under VFS mounts rather than
guest rootfs.

`SshAccess` includes `host`, `port`, and optional `user`, `command`,
`identityFile`. `IngressRoute` maps a URL prefix to a guest port with optional
prefix stripping.

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

## CreateVmOptions

All VM configuration flows through a single options object passed to `createManagedVm()`.

| Field | Type | Purpose |
|-------|------|---------|
| `imagePath` | `string` | Path to the Gondolin image directory (contains `rootfs.ext4`, `vmlinuz-virt`, etc.) |
| `memory` | `string` | RAM allocation (e.g., `'512M'`, `'2G'`) |
| `cpus` | `number` | Virtual CPU count |
| `rootfsMode` | `'readonly' \| 'memory' \| 'cow'` | How the root filesystem handles writes |
| `allowedHosts` | `readonly string[]` | Outbound HTTP allowlist for mediation proxy |
| `secrets` | `Record<string, SecretSpec>` | HTTP-mediated secrets: `{ hosts, value }` per secret |
| `vfsMounts` | `Record<string, VfsMountSpec>` | Guest path -> mount specification |
| `tcpHosts` | `Record<string, string>` | Synthetic DNS hostname -> host TCP endpoint |
| `env` | `Record<string, string>` | Environment variables injected into the VM |
| `sessionLabel` | `string` | Human-readable label for debugging (e.g., `'myproject:zone1:gateway'`) |
| `onRequest` | `(request) -> Promise<...>` | Optional hook: intercept outbound requests |
| `onResponse` | `(response) -> Promise<...>` | Optional hook: intercept inbound responses |

---

## Rootfs Modes

The `rootfsMode` controls what happens when a process inside the VM writes to the root filesystem (outside VFS mounts).

```
  Mode        Backing                         Writes Survive VM Lifetime?    Use Case
  --------    -----------------------------   ----------------------------    --------
  cow         Copy-on-write qcow2 overlay     Yes (within session)            Gateway VMs: install packages,
                                                                              modify /etc, persist within session
  memory      Backend-specific throwaway      No (lost on close)              Tool VMs: fully ephemeral,
              rootfs mode; QEMU snapshot,                                     no state leaks between leases
              krun temporary qcow2 on disk
  readonly    Immutable                       Rejected (write fails)          Not currently used in production
```

Gateway VMs use `cow` so the bootstrap command can install packages and write config files that persist for the session. Tool VMs use `memory` so every lease starts from a clean slate. In Gondolin docs, rootfs `memory` means throwaway rootfs mode, not always RAM-backed storage; guest tmpfs and VFS `MemoryProvider` are the memory-pressure paths.

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

The `secrets` parameter in `CreateVmOptions` is a `Record<string, SecretSpec>` where each `SecretSpec` contains:
- `hosts`: list of hostnames this secret applies to (e.g., `['api.openai.com']`)
- `value`: the resolved secret plaintext

The hook bundle also sets environment variables (`hookBundle.env`) that configure the in-VM HTTP client to route through the mediation proxy. The VM process makes normal HTTP requests -- it never knows secrets are being injected.

For mediated secrets that are consumed through environment variables, such as
stdio MCP provider API keys, `hookBundle.env` also contains generated
placeholder values. `createManagedVm()` must pass both `httpHooks` and
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

When `tcpHosts` is provided in `CreateVmOptions`, the adapter configures:
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

`gateway-interface` defines the small shared lease vocabulary for VM
capabilities: `VmCapabilityLease<TTransport>`, reusable SSH endpoint types, and
the current `ToolVmSshLease` specialization.

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
work. `gondolin-rpc` should mean controller-owned execution through `ManagedVm`
using native `vm.exec()` and `vm.fs`, which is the preferred shape for typed,
controlled workloads such as credentialed CLI execution. `ingress-service`
should mean a warm HTTP service inside a VM exposed through Gondolin ingress.
Neither is part of the current Tool VM SSH path.

OpenClaw's filesystem bridge remains plugin-owned. It is an OpenClaw
remote-shell filesystem protocol implemented over SSH; it is not a generic
Tool VM filesystem API. Controlled non-OpenClaw workloads should use Gondolin
`vm.fs` directly once they own the `ManagedVm` handle.

---

## Image Build Pipeline

VM images are built from a `BuildConfig` (loaded from JSON) through Gondolin's `buildAssets()`. The pipeline uses content-addressed fingerprinting to cache builds.

```
  build-config.jsonc
    |
    v
  buildGondolinImage({ buildConfigPath, cacheDir, fingerprintInput? })
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

`buildGatewayImage()` in `gateway-image-builder.ts` first checks the profile-local prepared-image record written by `agent-vm build`; if the build config, fingerprint input, fingerprint, and asset files still match, startup reuses that image path without invoking Gondolin. Otherwise it loads the config and delegates to `buildGondolinImage()`, supporting dependency injection for testing. Tool VM startup uses the same prepared-image record contract.

`agent-vm build` dedupes repeated resolved build config path + effective
fingerprint pairs across configured image profiles in the same invocation. The
canonical profile runs the Gondolin asset build; duplicate profiles get
profile-local cache entries materialized from the canonical assets, preserving
runtime profile cache hits without repeating the Docker-to-ext4 conversion.

The `fullReset` option deletes the cached image directory before building, forcing a clean rebuild.

---

## gondolin-adapter Exports

The `gondolin-adapter` package (`packages/gondolin-adapter/src/index.ts`) re-exports everything the rest of the system needs from the Gondolin layer.

| Export | Source | Purpose |
|--------|--------|---------|
| `createManagedVm` | `vm-adapter.ts` | Boot a VM and return a `ManagedVm` handle |
| `ManagedVm`, `ManagedVmInstance` | `vm-adapter.ts` | VM handle interfaces |
| `CreateVmOptions`, `VfsMountSpec` | `vm-adapter.ts` | VM configuration types |
| `ManagedExecResult`, `SshAccess`, `IngressAccess`, `IngressRoute` | `vm-adapter.ts` | Result types |
| `SecretResolver`, `createSecretResolver`, `createOpCliSecretResolver` | `@agent-vm/secret-management` | Resolve `SecretRef` values from 1Password SDK or `op` CLI |
| `resolveServiceAccountToken`, `TokenSource` | `@agent-vm/secret-management` | Obtain 1Password service account token from env or macOS Keychain |
| `SecretSpec` | `types.ts` | `{ hosts, value }` -- resolved secret with host binding |
| `SecretRef` | `types.ts` | Discriminated union: `{ source: '1password', ref }`, `{ source: 'environment', ref }`, or `{ source: 'config', value }` |
| `writeFileAtomically` | `write-file-atomically.ts` | Write-then-rename for crash-safe file updates |
| `buildImage`, `computeBuildFingerprint` | `build-pipeline.ts` | Fingerprint-cached image builds |
| `BuildConfig`, `BuildImageOptions`, `BuildImageResult` | `build-pipeline.ts` | Build configuration and result types |
| `getDefaultBuildConfig` | `@earendil-works/gondolin` | SDK default build config (re-exported) |
| `compilePolicy`, `PolicySources` | `policy-compiler.ts` | Merge and dedupe VM host allowlists from multiple sources |
| `validateWritableMount`, `validateRuntimeMountPolicy` | `mount-policy.ts` | Enforce writable mount restrictions and auth path protection |
| `ensureVolumeDir`, `resolveVolumeDirs` | `volume-manager.ts` | Create and resolve persistent volume directories |

---

## Source Files

| File | Lines | Responsibility |
|------|-------|----------------|
| `packages/gondolin-adapter/src/vm-adapter.ts` | 287 | `ManagedVm` interface, `createManagedVm()`, VFS provider assembly, HTTP hooks wiring |
| `packages/secret-management/src/contracts.ts` | 28 | `SecretRef`, `SecretResolver`, and `MediatedSecretSpec` shared contracts |
| `packages/secret-management/src/onepassword-secret-resolver.ts` | 657 | 1Password SDK client with isolated `op inject` fallback and token source resolution |
| `packages/secret-management/src/redacted-exec-file.ts` | 216 | Child-process execution with redacted failure formatting |
| `packages/secret-management/src/op-cli-service-account-env.ts` | 65 | Isolated service-account environment for `op` CLI fallback |
| `packages/gondolin-adapter/src/build-pipeline.ts` | 132 | `buildImage()`, `computeBuildFingerprint()`, asset verification |
| `packages/gondolin-adapter/src/mount-policy.ts` | 117 | Writable mount validation, auth path protection |
| `packages/gondolin-adapter/src/policy-compiler.ts` | 33 | VM host allowlist compilation and deduplication |
| `packages/gondolin-adapter/src/volume-manager.ts` | 39 | Persistent volume directory management |
| `packages/gondolin-adapter/src/write-file-atomically.ts` | 29 | Atomic file write via write-then-rename |
| `packages/gondolin-adapter/src/index.ts` | 11 | Barrel re-exports |
| `packages/agent-vm/src/build/gondolin-image-builder.ts` | 47 | `buildGondolinImage()` wrapper with config loading |
| `packages/agent-vm/src/gateway/gateway-image-builder.ts` | 41 | `buildGatewayImage()` thin wrapper for gateway-specific builds |
