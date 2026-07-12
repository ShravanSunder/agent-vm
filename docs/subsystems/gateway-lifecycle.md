# Gateway Lifecycle

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Gateway Lifecycle

The gateway lifecycle abstraction decouples "what a gateway workload needs"
from "how the controller boots it." Each gateway type (OpenClaw, Worker)
implements a single `GatewayLifecycle` interface. The lifecycle returns
backend-neutral workload requirements and process intent. The controller adds
image, resource, authority, and recovery decisions before passing a neutral
`ManagedVmCreateRequest` to the injected `ManagedVmFactory`.

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

Package ownership follows the same split:

- `@agent-vm/gateway-lifecycle` owns gateway-kind configuration projections,
  workload/lifecycle intent, process specs, and shared Node policy (with room
  for equivalent future Python policy).
- `@agent-vm/managed-vm` owns backend-neutral VM, mount, process, SSH, ingress,
  image, and owned-directory contracts.
- `@agent-vm/gondolin-vm-adapter` implements those neutral contracts for the
  shipping backend. Gateway lifecycle implementations never import it.

The application composition root selects Gondolin once and injects narrow
neutral capabilities. Controller authority -- PID/process identity admission,
lease ownership, recovery, and destructive termination fencing -- does not move
into either lifecycle packages or the adapter.

---

## GatewayLifecycle interface

Defined in `packages/gateway-lifecycle/src/gateway-lifecycle.ts`.

```
GatewayLifecycle
  |-- buildVmRequirements(options)-> GatewayVmRequirements pure data
  |-- buildProcessSpec(zone, rs)  -> GatewayProcessSpec  pure data
  |-- preflightHostState?(zone,sr)-> Promise<void>       secret preflight
  |-- prepareHostState?(zone, sr) -> Promise<void>       side effects
  |-- authConfig?                 -> GatewayAuthConfig    static
```

### buildVmRequirements

Accepts `BuildGatewayVmRequirementsOptions` and returns
`GatewayVmRequirements`. Pure
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

### preflightHostState (optional)

Async hook that resolves host-state secret dependencies without writing host
state. Protected OpenClaw restarts use this before closing a live gateway so a
1Password or environment-secret failure does not strand the zone without a VM.

### authConfig (optional)

Static property describing how interactive auth works for the gateway type.
Contains `listProvidersCommand` (shell command that lists auth providers,
one per line on stdout) and `buildLoginCommand(provider, options)` (shell
command the CLI runs via SSH with TTY).  The options object carries
provider-login target details such as agent id, profile id, and device-code.
Only OpenClaw defines this; Worker has no interactive auth.

---

## GatewayVmRequirements

Defined in `packages/gateway-lifecycle/src/gateway-vm-spec.ts`. This is guest
workload intent, not a provider create request. Image selection, CPU/memory,
owned host-directory authority, and VM construction remain controller and
composition responsibilities.

| Field              | Type                            | Purpose                                         |
|--------------------|---------------------------------|-------------------------------------------------|
| `environment`      | `Record<string, string>`        | Environment variables injected into the guest    |
| `mounts`           | `Record<string, ManagedVmMount>` | Backend-neutral host-to-guest filesystem mounts |
| `mediatedSecrets`  | `Record<string, MediatedSecretSpec>` | Gateway secret-placement intent for later provider-request translation |
| `tcpHosts`         | `Record<string, string>`        | Guest hostname:port -> host address:port mapping |
| `allowedHosts`     | `readonly string[]`             | Hostnames the VM is permitted to reach           |
| `rootfsMode`       | `'readonly' | 'memory' | 'cow'` | Root filesystem strategy (both impls use `cow`)  |
| `sessionLabel`     | `string`                        | Backend-neutral diagnostic session label         |

Controller `system.json` zones declare audience-scoped `egressHosts`; gateway
lifecycle code passes only `gateway` and `both` entries into these workload
requirements. The selected provider translates the resulting neutral request
to Gondolin policy only at the adapter boundary.

Secrets are split by `splitResolvedGatewaySecrets` based on each zone secret's
`audience` and `injection` fields. Gateway VMs receive only `gateway` and
`both` secrets: `'env'` secrets land in `environment`, and
`'http-mediation'` secrets land in `mediatedSecrets`.

---

## GatewayProcessSpec

Defined in `packages/gateway-lifecycle/src/gateway-process-spec.ts`.

| Field              | Type                  | Purpose                                      |
|--------------------|-----------------------|----------------------------------------------|
| `bootstrapCommand` | `string`              | Runs once after VM boot, before start        |
| `startCommand`     | `string`              | Launches the gateway process (backgrounded)  |
| `healthCheck`      | `GatewayHealthCheck`  | HTTP or command-based health check           |
| `serviceHealthCheck` | `GatewayHealthCheck` | Optional liveness check for controller health monitors |
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

1. **Effective config** -- reads the base OpenClaw JSON config, configures
   `gateway.auth.token` as an env SecretRef for the secret named by
   `gateway.controlAuth.secret`, and writes the result atomically to
   `<stateDir>/effective-openclaw.json` with mode 0600. The plaintext gateway
   token is not written to this file.

2. **Auth profiles** -- if `gateway.authProfilesByAgent` is configured on the
   zone, resolves each agent's secret and writes `auth-profiles.json` to
   `<stateDir>/agents/<agentId>/agent/` with mode 0600. Legacy
   `authProfilesRef` is still accepted as a shared single-agent fallback and
   writes only `<stateDir>/agents/main/agent/auth-profiles.json`.

### preflightHostState

Resolves configured auth-profile secrets without writing the corresponding
`auth-profiles.json` files. This mirrors the secret-resolution part of
`prepareHostState` for protected restart preflight.

### buildVmRequirements

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
  + allowed env-injected secrets, including gateway.controlAuth.secret

mounts:
  /home/openclaw/.openclaw/config    -> configDirectory  (realfs)
  /home/openclaw/.openclaw/cache     -> gatewayCacheDir  (realfs)
  /home/openclaw/.openclaw/state     -> stateDir         (realfs)
  /agent-vm/logs                     -> runtimeDir/zones/<zone>/logs (realfs)
  /zone           -> zoneFilesDir (realfs)

tcpHosts:
  tool-N.vm.host:22                  -> 127.0.0.1:<basePort+N>  (per tcpPool)

rootfsMode: cow
```

The effective config references the configured `gateway.controlAuth.secret`
through OpenClaw's env SecretRef shape. The gateway VM receives that token as
an env-injected secret so the daemon can resolve the SecretRef at startup
without storing the plaintext token in persistent state.

OpenClaw raw env secrets are intentionally narrow. The configured
`gateway.controlAuth.secret` is allowed by default; additional gateway env
secrets must be listed in `gateway.rawEnvSecrets`. Provider API tokens should
use Gondolin `http-mediation` unless the integration cannot be mediated at the
HTTP boundary. Generated runtime env secrets, such as zone-git capability env
vars, must also be listed when enabled.

Bundled OpenClaw plugin runtime dependencies are staged under
`OPENCLAW_PLUGIN_STAGE_DIR`. Target state is image/rootfs-local staging at
`/opt/openclaw/plugin-runtime-deps`, populated during image build. Do not put
this under `OPENCLAW_STATE_DIR`: staged plugin `node_modules` trees are
rebuildable and must not be included in encrypted zone backups.

### buildProcessSpec

- **bootstrap**: creates `/work/tmp` and `/work/cache/*`, writes
  `/etc/profile.d/openclaw-env.sh` with non-secret environment exports, writes
  runtime-only secret env files under `/run/openclaw`, including
  `/run/openclaw/secrets.env` for the gateway daemon and token-only
  `/run/openclaw/gateway-token.env` for controller SSH admin shells.
- **start**: sources `/run/openclaw/secrets.env`, then runs
  `cd /home/openclaw && nohup openclaw gateway --port 18789`
- **healthCheck**: HTTP on port 18789, path `/readyz` for explicit readiness probes
- **serviceHealthCheck**: HTTP on port 18789, path `/health` for startup and controller liveness monitoring
- **guestListenPort**: 18789
- **logPath**: `/agent-vm/logs/gateway-boot-latest.log`

### authConfig

- **listProvidersCommand**: `openclaw models auth list --format plain`
- **buildLoginCommand**: `openclaw models auth login --provider '<provider>'`

---

## Worker implementation

Defined in `packages/worker-gateway/src/worker-lifecycle.ts`.

### prepareHostState

Not implemented.  Worker has no host-side preparation.

### buildVmRequirements

```
environment:
  HOME                  = /home/coder
  NODE_EXTRA_CA_CERTS   = /run/gondolin/ca-certificates.crt
  AGENT_VM_ZONE_ID      = <zone.id>
  STATE_DIR             = /state
  WORKER_CONFIG_PATH    = /state/effective-worker.json
  WORK_DIR              = /work
  REPOS_DIR             = /work/repos
  TMPDIR                = /work/tmp
  TMP                   = /work/tmp
  TEMP                  = /work/tmp
  npm_config_cache      = /work/cache/npm
  pnpm_config_store_dir = /work/cache/pnpm/store
  PIP_CACHE_DIR         = /work/cache/pip
  UV_CACHE_DIR          = /work/cache/uv
  + env-injected secrets

mounts:
  /state                -> task stateDir       (realfs)
  /gitdirs              -> runtimeDir task root (realfs)

rootfs/COW paths:
  /work/repos            -> repo files, package installs, builds, tests
  /work/tmp              -> TMPDIR/TMP/TEMP target
  /work/cache            -> disposable package-manager cache

rootfsMode: cow
```

Worker does not use tcpPool slots. Controller/Worker control traffic uses the
private Worker control session over Gondolin ingress.

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
| **mounts**            | config, cache, state, logs, zone files          | state + task gitdirs; `/work/repos` is rootfs/COW |
| **tcpHosts**          | Tool VM SSH + explicit TCP resources             | explicit TCP resources only                    |
| **bootstrap**         | Shell env file in `/etc/profile.d/`              | `npm install -g` codex + worker tarball         |
| **startCommand**      | `openclaw gateway --port 18789`                  | `agent-vm-worker serve --port 18789`            |
| **healthCheck path**  | `/readyz`                                        | `/health`                                       |
| **serviceHealthCheck path** | `/health`                                 | `/health`                                       |
| **guestListenPort**   | 18789                                            | 18789                                           |
| **logPath**           | `/agent-vm/logs/gateway-boot-latest.log`         | `/tmp/agent-vm-worker.log`                      |
| **rootfsMode**        | `cow`                                            | `cow`                                            |
| **secret handling**   | Allows only explicit raw env secrets             | Passes gateway env secrets through             |

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

Defined in `packages/gateway-lifecycle/src/gateway-runtime-contract.ts`.

Two naming conventions for backend-neutral diagnostic session labels:

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
| `packages/gateway-lifecycle/src/gateway-lifecycle.ts` | gateway-lifecycle |
| `packages/gateway-lifecycle/src/gateway-runtime-contract.ts` | gateway-lifecycle |
| `packages/gateway-lifecycle/src/gateway-vm-spec.ts` | gateway-lifecycle |
| `packages/gateway-lifecycle/src/gateway-process-spec.ts` | gateway-lifecycle |
| `packages/gateway-lifecycle/src/split-resolved-gateway-secrets.ts` | gateway-lifecycle |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | openclaw-gateway |
| `packages/worker-gateway/src/worker-lifecycle.ts` | worker-gateway |
| `packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts` | agent-vm |
