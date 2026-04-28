# Gateway Lifecycle

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Gateway Lifecycle

The gateway lifecycle abstraction decouples "what a gateway needs" from
"how the controller boots it."  Each gateway type (OpenClaw, Worker)
implements a single `GatewayLifecycle` interface.  The controller never
knows which type it is driving -- it calls the same four methods and gets
back pure data specs that Gondolin consumes.

```
                        GatewayLifecycle
                        (interface)
                              |
          +-------------------+-------------------+
          |                                       |
   openclawLifecycle                      workerLifecycle
   (openclaw-gateway)                     (worker-gateway)
          |                                       |
          +-------------------+-------------------+
                              |
                   gateway-lifecycle-loader.ts
                   lifecycleByType dispatch map
                              |
                        Controller
```

---

## GatewayLifecycle interface

Defined in `packages/gateway-interface/src/gateway-lifecycle.ts`.

```
GatewayLifecycle
  |-- buildVmSpec(options)        -> GatewayVmSpec       pure data
  |-- buildProcessSpec(zone, rs)  -> GatewayProcessSpec  pure data
  |-- prepareHostState?(zone, sr) -> Promise<void>       side effects
  |-- authConfig?                 -> GatewayAuthConfig    static
```

### buildVmSpec

Accepts `BuildGatewayVmSpecOptions` and returns a `GatewayVmSpec`.  Pure
data assembly -- no side effects.  The options carry:

| Field              | Type                          | Purpose                                  |
|--------------------|-------------------------------|------------------------------------------|
| `controllerPort`   | `number`                      | Host port the controller listens on      |
| `gatewayCacheDir`  | `string`                      | Per-zone runtime cache directory         |
| `projectNamespace` | `string`                      | Namespace prefix for session labels      |
| `resolvedSecrets`  | `Record<string, string>`      | Pre-resolved secret values               |
| `tcpPool`          | `{ basePort, size }`          | Port range for tool VM SSH tunnels       |
| `zone`             | `GatewayZoneConfig`           | Full zone configuration                  |

### buildProcessSpec

Takes the zone config and resolved secrets, returns a `GatewayProcessSpec`.
Pure data -- describes bootstrap, startup, health checking, and logging.

### prepareHostState (optional)

Async hook that runs before the VM boots.  Performs host-side side effects
such as writing config files or resolving secrets to disk.  Only OpenClaw
implements this; Worker does not.

### authConfig (optional)

Static property describing how interactive auth works for the gateway type.
Contains `listProvidersCommand` (shell command that lists auth providers,
one per line on stdout) and `buildLoginCommand(provider, options)` (shell
command the CLI runs via SSH with TTY).  The options object carries
provider-login flags such as device-code and set-default.  Only OpenClaw
defines this; Worker has no interactive auth.

---

## GatewayVmSpec

Defined in `packages/gateway-interface/src/gateway-vm-spec.ts`.  This is
the full Gondolin-facing contract -- everything needed to create a VM.

| Field              | Type                            | Purpose                                         |
|--------------------|---------------------------------|-------------------------------------------------|
| `environment`      | `Record<string, string>`        | Environment variables injected into the guest    |
| `vfsMounts`        | `Record<string, VfsMountSpec>`  | Host-to-guest filesystem mounts                  |
| `mediatedSecrets`  | `Record<string, SecretSpec>`    | Secrets delivered via HTTP mediation (not env)    |
| `tcpHosts`         | `Record<string, string>`        | Guest hostname:port -> host address:port mapping |
| `allowedHosts`     | `readonly string[]`             | Hostnames the VM is permitted to reach           |
| `rootfsMode`       | `'readonly' | 'memory' | 'cow'` | Root filesystem strategy (both impls use `cow`)  |
| `sessionLabel`     | `string`                        | Gondolin session identifier                      |

Secrets are split by `splitResolvedGatewaySecrets` based on the zone config's
`injection` field per secret: `'env'` secrets land in `environment`,
`'http-mediation'` secrets land in `mediatedSecrets`.

---

## GatewayProcessSpec

Defined in `packages/gateway-interface/src/gateway-process-spec.ts`.

| Field              | Type                  | Purpose                                      |
|--------------------|-----------------------|----------------------------------------------|
| `bootstrapCommand` | `string`              | Runs once after VM boot, before start        |
| `startCommand`     | `string`              | Launches the gateway process (backgrounded)  |
| `healthCheck`      | `GatewayHealthCheck`  | HTTP or command-based health check           |
| `guestListenPort`  | `number`              | Port the gateway listens on inside the guest |
| `logPath`          | `string`              | Guest-side path to the process log file      |

`GatewayHealthCheck` is a discriminated union:

```
{ type: 'http',    port: number, path: string }
{ type: 'command', command: string }
```

Both current implementations use HTTP health checks.

---

## OpenClaw implementation

Defined in `packages/openclaw-gateway/src/openclaw-lifecycle.ts`.

### prepareHostState

Two host-side writes before VM boot:

1. **Effective config** -- reads the base OpenClaw JSON config, injects the
   resolved `OPENCLAW_GATEWAY_TOKEN` into `gateway.auth.{mode,token}`, and
   writes the result atomically to `<stateDir>/effective-openclaw.json`
   with mode 0600.

2. **Auth profiles** -- if `authProfilesRef` is configured on the zone,
   resolves the secret and writes `auth-profiles.json` to
   `<stateDir>/agents/main/agent/` with mode 0600.

### buildVmSpec

```
environment:
  HOME                  = /home/openclaw
  OPENCLAW_HOME         = /home/openclaw
  OPENCLAW_CONFIG_PATH  = /home/openclaw/.openclaw/state/effective-openclaw.json
  OPENCLAW_STATE_DIR    = /home/openclaw/.openclaw/state
  OPENCLAW_PLUGIN_STAGE_DIR = /opt/openclaw/plugin-runtime-deps
  TMPDIR                = /work/tmp
  TMP                   = /work/tmp
  TEMP                  = /work/tmp
  npm_config_cache      = /work/cache/npm
  pnpm_config_store_dir = /work/cache/pnpm/store
  PIP_CACHE_DIR         = /work/cache/pip
  UV_CACHE_DIR          = /work/cache/uv
  NODE_EXTRA_CA_CERTS   = /run/gondolin/ca-certificates.crt
  + env-injected secrets (minus OPENCLAW_GATEWAY_TOKEN)

vfsMounts:
  /home/openclaw/.openclaw/config    -> configDirectory  (realfs)
  /home/openclaw/.openclaw/cache     -> gatewayCacheDir  (realfs)
  /home/openclaw/.openclaw/state     -> stateDir         (realfs)
  /home/openclaw/zone-files           -> zoneFilesDir (realfs)

tcpHosts:
  controller.vm.host:18800           -> 127.0.0.1:<controllerPort>
  tool-N.vm.host:22                  -> 127.0.0.1:<basePort+N>  (per tcpPool)
  + websocketBypass entries           -> pass-through

rootfsMode: cow
```

The `OPENCLAW_GATEWAY_TOKEN` is explicitly excluded from environment secrets
because it is already embedded in the effective config file.

Bundled OpenClaw plugin runtime dependencies are staged under
`OPENCLAW_PLUGIN_STAGE_DIR`. Target state is image/rootfs-local staging at
`/opt/openclaw/plugin-runtime-deps`, populated during image build. Do not put
this under `OPENCLAW_STATE_DIR`: staged plugin `node_modules` trees are
rebuildable and must not be included in encrypted zone backups.

### buildProcessSpec

- **bootstrap**: creates `/work/tmp` and `/work/cache/*`, writes
  `/etc/profile.d/openclaw-env.sh` with environment exports, and sources it
  from `/root/.bashrc` and `/root/.bash_profile`.
- **start**: `cd /home/openclaw && nohup openclaw gateway --port 18789`
- **healthCheck**: HTTP on port 18789, path `/`
- **guestListenPort**: 18789
- **logPath**: `/tmp/openclaw.log`

### authConfig

- **listProvidersCommand**: `openclaw models auth list --format plain`
- **buildLoginCommand**: `openclaw models auth login --provider '<provider>'`

---

## Worker implementation

Defined in `packages/worker-gateway/src/worker-lifecycle.ts`.

### prepareHostState

Not implemented.  Worker has no host-side preparation.

### buildVmSpec

```
environment:
  HOME                  = /home/coder
  CONTROLLER_BASE_URL   = http://controller.vm.host:18800
  NODE_EXTRA_CA_CERTS   = /run/gondolin/ca-certificates.crt
  AGENT_VM_ZONE_ID      = <zone.id>
  STATE_DIR             = /state
  WORKER_CONFIG_PATH    = /state/effective-worker.json
  WORK_ROOT             = /work
  REPO_ROOT             = /work/repos
  TMPDIR                = /work/tmp
  TMP                   = /work/tmp
  TEMP                  = /work/tmp
  npm_config_cache      = /work/cache/npm
  pnpm_config_store_dir = /work/cache/pnpm/store
  PIP_CACHE_DIR         = /work/cache/pip
  UV_CACHE_DIR          = /work/cache/uv
  + env-injected secrets

vfsMounts:
  /state                -> task stateDir       (realfs)
  /gitdirs              -> runtimeDir task root (realfs)
  /work/repos            -> VM rootfs/COW, not a RealFS mount

tcpHosts:
  controller.vm.host:18800 -> 127.0.0.1:<controllerPort>

rootfsMode: cow
```

Worker does not use tcpPool slots or websocket bypass -- it only tunnels to
the controller.

### buildProcessSpec

- **bootstrap**: creates `/work/tmp` and `/work/cache/*`, then runs
  `npm install -g @openai/codex /state/agent-vm-worker.tgz` (conditional on
  tarball existing in /state)
- **start**: `cd /work && nohup agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state`
- **healthCheck**: HTTP on port 18789, path `/health`
- **guestListenPort**: 18789
- **logPath**: `/tmp/agent-vm-worker.log`

### authConfig

Not implemented.  Worker has no interactive auth.

---

## Comparison table

| Aspect                | OpenClaw                                        | Worker                                          |
|-----------------------|-------------------------------------------------|-------------------------------------------------|
| **prepareHostState**  | Writes effective config + auth profiles          | None                                            |
| **authConfig**        | list providers / login command                   | None                                            |
| **HOME**              | `/home/openclaw`                                 | `/home/coder`                                   |
| **vfsMounts**         | config, cache, state, zone files (4 mounts)    | state + task gitdirs; `/work/repos` is rootfs/COW |
| **tcpHosts**          | controller + tool pool + WS bypass               | controller only                                 |
| **bootstrap**         | Shell env file in `/etc/profile.d/`              | `npm install -g` codex + worker tarball         |
| **startCommand**      | `openclaw gateway --port 18789`                  | `agent-vm-worker serve --port 18789`            |
| **healthCheck path**  | `/`                                              | `/health`                                       |
| **guestListenPort**   | 18789                                            | 18789                                           |
| **logPath**           | `/tmp/openclaw.log`                              | `/tmp/agent-vm-worker.log`                      |
| **rootfsMode**        | `cow`                                            | `cow`                                            |
| **secret handling**   | Strips OPENCLAW_GATEWAY_TOKEN from env           | Passes all env secrets through                  |

---

## Lifecycle loader

Defined in `packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts`.

The loader is a static dispatch map with compile-time exhaustiveness
checking:

```typescript
const lifecycleByType = {
  worker:   workerLifecycle,
  openclaw: openclawLifecycle,
} satisfies Record<string, GatewayLifecycle>;
```

`satisfies Record<string, GatewayLifecycle>` ensures every value conforms
to the interface without widening the key type.  The controller calls
`loadGatewayLifecycle(zone.gateway.type)` and gets back the correct
implementation.  Adding a new gateway type requires adding an entry here
and the TypeScript compiler will enforce the contract.

---

## Session labels

Defined in `packages/gateway-interface/src/gateway-runtime-contract.ts`.

Two naming conventions for Gondolin session identifiers:

```
Gateway:  <projectNamespace>:<zoneId>:gateway
Tool:     <projectNamespace>:<zoneId>:tool:<tcpSlot>
```

Built by `buildGatewaySessionLabel` and `buildToolSessionLabel`.  The
three-segment gateway label uniquely identifies a gateway VM within a
project.  The four-segment tool label extends this with the TCP slot
index for tool VMs attached to that gateway.

The valid gateway types are defined as `gatewayTypeValues = ['openclaw', 'worker']`
with `GatewayType` derived as the union of those literal strings.

---

## Source files

| File | Package |
|------|---------|
| `packages/gateway-interface/src/gateway-lifecycle.ts` | gateway-interface |
| `packages/gateway-interface/src/gateway-runtime-contract.ts` | gateway-interface |
| `packages/gateway-interface/src/gateway-vm-spec.ts` | gateway-interface |
| `packages/gateway-interface/src/gateway-process-spec.ts` | gateway-interface |
| `packages/gateway-interface/src/split-resolved-gateway-secrets.ts` | gateway-interface |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | openclaw-gateway |
| `packages/worker-gateway/src/worker-lifecycle.ts` | worker-gateway |
| `packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts` | agent-vm |
