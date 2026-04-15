# Gondolin VM Layer

[Overview](../README.md) > [Architecture](../architecture.md) > Gondolin VM Layer

Deep dive into the Gondolin VM abstraction: how `gondolin-core` wraps the `@earendil-works/gondolin` SDK into a managed VM interface with VFS mounts, HTTP secret mediation, synthetic DNS, and fingerprint-cached image builds. This is the lowest infrastructure layer -- every gateway and tool VM in the system boots through this adapter.

---

## What Gondolin Provides

Gondolin (`@earendil-works/gondolin`) is the external SDK that runs QEMU micro-VMs on the host. The system never calls QEMU directly. Instead, `gondolin-core` wraps the SDK into a dependency-injectable adapter with narrower types.

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
  |-- exec(command) -> ExecResult        Run a shell command; returns exitCode, stdout, stderr
  |-- enableSsh(options?) -> SshAccess   Open SSH tunnel; returns host, port, user, identityFile
  |-- enableIngress(options?) -> IngressAccess
  |                                      Open inbound HTTP route; returns host, port
  |-- setIngressRoutes(routes)           Configure path-prefix routing into the VM
  |-- getVmInstance() -> ManagedVmInstance
  |                                      Access the underlying SDK VM handle
  |-- close()                            Shut down the VM and release all resources
```

`ExecResult` normalizes the SDK response: `stdout` and `stderr` default to `''` instead of `undefined`. `SshAccess` includes `host`, `port`, and optional `user`, `command`, `identityFile`. `IngressRoute` maps a URL prefix to a guest port with optional prefix stripping.

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
  Mode        Backing         Writes Survive VM Lifetime?    Use Case
  --------    -----------     ----------------------------    --------
  cow         Copy-on-write   Yes (within session)            Gateway VMs: install packages,
                                                              modify /etc, persist within session
  memory      RAM-backed      No (lost on close)              Tool VMs: fully ephemeral,
                                                              no state leaks between leases
  readonly    Immutable       Rejected (write fails)          Not currently used in production
```

Gateway VMs use `cow` so the bootstrap command can install packages and write config files that persist for the session. Tool VMs use `memory` so every lease starts from a clean slate.

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
  memory                MemoryProvider()                 RAM-backed: starts empty, lost
                                                        on VM close
  shadow                ShadowProvider(base, config)     Overlay with deny/tmpfs rules:
                          base = RealFS or Memory          deny: block writes to paths
                          deny paths -> writeMode:deny     tmpfs: redirect writes to RAM
                          tmpfs paths -> writeMode:tmpfs
```

Shadow mounts support two overlay behaviors configured via `shadowConfig`:
- `deny`: writes to matching paths fail with an error
- `tmpfs`: writes to matching paths go to a RAM-backed overlay (visible within session, lost on close)

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

Only hosts in the `allowedHosts` list can be reached. Requests to unlisted hosts are blocked at the proxy layer.

---

## TCP Host Mapping

TCP host mapping lets processes inside the VM reach host-side TCP services via synthetic DNS hostnames. This is how gateway VMs talk to the controller and how OpenClaw gateways reach tool VM SSH ports.

```
  Inside VM                          Host Side
  ---------                          ---------
  controller.vm.host:18800   ------> 127.0.0.1:18800   (controller HTTP API)
  tool-0.vm.host:22          ------> 127.0.0.1:19000   (tool VM 0 SSH)
  tool-1.vm.host:22          ------> 127.0.0.1:19001   (tool VM 1 SSH)
```

When `tcpHosts` is provided in `CreateVmOptions`, the adapter configures:
- `dns.mode: 'synthetic'` with `syntheticHostMapping: 'per-host'` -- Gondolin resolves virtual hostnames to loopback addresses inside the VM
- `tcp.hosts` -- maps each virtual hostname to a real host-side TCP endpoint

Worker VMs only map the controller endpoint. OpenClaw gateway VMs map the controller plus all tool VM slots from the TCP pool.

---

## Image Build Pipeline

VM images are built from a `BuildConfig` (loaded from JSON) through Gondolin's `buildAssets()`. The pipeline uses content-addressed fingerprinting to cache builds.

```
  build-config.json
    |
    v
  buildGondolinImage({ buildConfigPath, cacheDir })
    |
    |-- 1. Load config       JSON.parse(buildConfigPath) -> BuildConfig
    |-- 2. Fingerprint        SHA-256(stableSerialize(config) + gondolinVersion)
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

`computeBuildFingerprint()` uses stable JSON serialization (sorted keys, no undefined values) to ensure the same config always produces the same fingerprint regardless of property order.

`buildGatewayImage()` in `gateway-image-builder.ts` is a thin wrapper that loads the config and delegates to `buildGondolinImage()`, supporting dependency injection for testing.

The `fullReset` option deletes the cached image directory before building, forcing a clean rebuild.

---

## gondolin-core Exports

The `gondolin-core` package (`packages/gondolin-core/src/index.ts`) re-exports everything the rest of the system needs from the Gondolin layer.

| Export | Source | Purpose |
|--------|--------|---------|
| `createManagedVm` | `vm-adapter.ts` | Boot a VM and return a `ManagedVm` handle |
| `ManagedVm`, `ManagedVmInstance` | `vm-adapter.ts` | VM handle interfaces |
| `CreateVmOptions`, `VfsMountSpec` | `vm-adapter.ts` | VM configuration types |
| `ExecResult`, `SshAccess`, `IngressAccess`, `IngressRoute` | `vm-adapter.ts` | Result types |
| `SecretResolver`, `createSecretResolver`, `createOpCliSecretResolver` | `secret-resolver.ts` | Resolve `SecretRef` values from 1Password SDK or `op` CLI |
| `resolveServiceAccountToken`, `TokenSource` | `secret-resolver.ts` | Obtain 1Password service account token from op-cli, env, or macOS Keychain |
| `SecretSpec` | `types.ts` | `{ hosts, value }` -- resolved secret with host binding |
| `SecretRef` | `types.ts` | Discriminated union: `{ source: '1password', ref }` or `{ source: 'environment', ref }` |
| `writeFileAtomically` | `write-file-atomically.ts` | Write-then-rename for crash-safe file updates |
| `buildImage`, `computeBuildFingerprint` | `build-pipeline.ts` | Fingerprint-cached image builds |
| `BuildConfig`, `BuildImageOptions`, `BuildImageResult` | `build-pipeline.ts` | Build configuration and result types |
| `getDefaultBuildConfig` | `@earendil-works/gondolin` | SDK default build config (re-exported) |
| `compilePolicy`, `PolicySources` | `policy-compiler.ts` | Merge and dedupe host allowlists from multiple sources |
| `validateWritableMount`, `validateRuntimeMountPolicy` | `mount-policy.ts` | Enforce writable mount restrictions and auth path protection |
| `ensureVolumeDir`, `resolveVolumeDirs` | `volume-manager.ts` | Create and resolve persistent volume directories |

---

## Source Files

| File | Lines | Responsibility |
|------|-------|----------------|
| `packages/gondolin-core/src/vm-adapter.ts` | 287 | `ManagedVm` interface, `createManagedVm()`, VFS provider assembly, HTTP hooks wiring |
| `packages/gondolin-core/src/secret-resolver.ts` | 278 | `SecretResolver` interface, 1Password SDK client with op-cli fallback, token source resolution |
| `packages/gondolin-core/src/types.ts` | 14 | `SecretSpec` and `SecretRef` type definitions |
| `packages/gondolin-core/src/build-pipeline.ts` | 132 | `buildImage()`, `computeBuildFingerprint()`, asset verification |
| `packages/gondolin-core/src/mount-policy.ts` | 117 | Writable mount validation, auth path protection |
| `packages/gondolin-core/src/policy-compiler.ts` | 33 | Host allowlist compilation and deduplication |
| `packages/gondolin-core/src/volume-manager.ts` | 39 | Persistent volume directory management |
| `packages/gondolin-core/src/write-file-atomically.ts` | 29 | Atomic file write via write-then-rename |
| `packages/gondolin-core/src/index.ts` | 11 | Barrel re-exports |
| `packages/agent-vm/src/build/gondolin-image-builder.ts` | 47 | `buildGondolinImage()` wrapper with config loading |
| `packages/agent-vm/src/gateway/gateway-image-builder.ts` | 41 | `buildGatewayImage()` thin wrapper for gateway-specific builds |
