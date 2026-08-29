# Gateway Lifecycle

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Gateway Lifecycle

The `gateway-lifecycle` package separates workload-specific requirements from
controller and VM-provider orchestration. Agent VM supports exactly two Gateway
types:

- `hermes`: a long-running managed interactive-agent Gateway;
- `worker`: an on-demand direct-process task Gateway.

The lifecycle contract produces neutral data. It does not create VMs, resolve
native Gondolin handles, own controller state, or implement Tool VM leases.

## Contract shape

```text
GatewayLifecycle
  buildVmRequirements(options)
    -> environment
    -> host-directory mount intents
    -> mediated secrets
    -> tcpHosts
    -> allowedHosts
    -> rootfs mode and optional runtime size
    -> session label

  prepareHostState?(zone, secretResolver)

  executionModel = managed-gateway
    buildFrameworkServiceBootMetadata(zone)
    buildFrameworkServiceBootInputs(options)
    interactiveSsh

  executionModel = direct-process
    buildProcessSpec(options)
```

`gatewayTypeValues` is the exhaustive `['hermes', 'worker']` vocabulary.
`gateway-lifecycle-loader.ts` statically maps those values to
`hermesLifecycle` and `workerLifecycle`; there is no dynamic framework
registry or fallback.

## Shared VM requirements

`buildVmRequirements()` receives the controller-authorized zone, resolved
secrets, derived runtime/cache roots, TCP-pool shape, and project namespace. A
lifecycle may project these inputs into:

- VM environment and private environment material;
- host-directory or filtered workspace mounts;
- HTTP-mediated secrets and audience-filtered egress hosts;
- synthetic TCP hosts;
- WebSocket upgrade rules;
- copy-on-write rootfs sizing;
- a stable Gateway session label.

The controller remains responsible for validating paths, creating owned host
directory capabilities, building/selecting images, creating the VM, recording
exact process identity, publishing ingress, recovery, and cleanup.

## Hermes implementation

`@agent-vm/hermes-gateway` implements the managed-Gateway branch.

### Host state

Before boot, Hermes preflights and materializes its protected home:

```text
stateDir/
  config.yaml
  profiles/
    <profileName>/
      config.yaml
      framework-owned durable state
```

Profile directories are controller-selected from `profilesByAgent`. Profile
`.env` paths are shadowed as temporary filesystems in the VM so secret
projections do not become durable state. The lifecycle refuses unsafe
symlinks, path-type mismatches, or unexpected profiles rather than broadening
authority.

### VM projection

Hermes mounts:

- the deployment-authored config directory read-only at `/etc/hermes`;
- `zoneRuntimeDir/logs` read/write at `/agent-vm/logs`;
- `gatewayCacheDir` read/write at `/home/hermes/.cache`;
- `stateDir` through a shadow mount at `/home/hermes/.hermes`.

It derives HTTP egress from zone audience policy, projects runtime-mediated
secrets without placing raw values in the image, maps Tool VM SSH slots through
synthetic TCP hosts, and uses a copy-on-write rootfs.

### Managed service boot

Hermes produces exact managed-framework metadata:

```text
framework    = hermes
bootEntry    = hermes-gateway
clientKind   = hermes-managed-plugin
```

The Gateway VM contains exactly the common Gateway Runtime service and the
Hermes framework service. Framework configuration and environment enter through
the managed boot contract; they are not reconstructed from a second framework
selector at runtime.

Hermes declares `nativeApprovalPresenter: true`. Its protected interactive SSH
session opens the Hermes shell environment without enabling the removed
all-secrets mode.

## Worker implementation

`@agent-vm/worker-gateway` implements the direct-process branch. A Worker zone
does not start a long-running VM at controller boot. The controller creates one
task VM when `POST /zones/:zoneId/worker-tasks` is admitted.

Worker lifecycle data includes:

- RealFS task state and Git-directory mounts;
- rootfs/COW `/work/repos` for hot source/build activity;
- the private Worker control-session ingress;
- `WORKER_CONFIG_PATH` and task runtime environment;
- optional local Worker tarball installation during bootstrap;
- `agent-vm-worker serve` as the direct process;
- the Worker HTTP health check.

Worker has no managed-framework profile material, Tool VM lease policy, or
interactive admin shell.

## Comparison

| Concern | Hermes | Worker |
| --- | --- | --- |
| Execution model | Long-running managed Gateway | Per-task direct process |
| Startup | Controller starts selected zone | Task submission starts VM |
| Framework boot | Exact Hermes managed boot contract | None |
| Host preparation | Protected profile directories | Task runner writes effective config |
| Tool VMs | Controller-authorized per-agent leases | Not used |
| Workspace | Selected durable agent workspace reaches Tool VM | VM-local rootfs/COW repos |
| Interactive SSH | Protected Hermes shell | Unsupported |
| Rootfs | Copy-on-write | Copy-on-write |

## Secret placement

Both lifecycles consume the shared secret-placement contract:

- `injection: "env"` places an explicitly allowed Gateway-audience secret in
  the runtime environment;
- `injection: "http-mediation"` gives the VM only a placeholder and allows the
  host proxy to substitute the real value for declared hosts.

Hermes profile-secret projections are a separate, profile-scoped contract. See
[Secrets and Credentials](secrets-and-credentials.md).

## Source map

| Source | Owner |
| --- | --- |
| `packages/gateway-lifecycle/src/gateway-lifecycle.ts` | Shared lifecycle and zone contracts |
| `packages/gateway-lifecycle/src/gateway-runtime-contract.ts` | Supported Gateway vocabulary |
| `packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts` | Static lifecycle composition |
| `packages/hermes-gateway/src/hermes-lifecycle.ts` | Hermes managed lifecycle |
| `packages/hermes-gateway/src/hermes-profile-directory-materialization.ts` | Protected Hermes host state |
| `packages/worker-gateway/src/worker-lifecycle.ts` | Worker direct-process lifecycle |
