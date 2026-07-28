# Hermes Discord Profile Secrets

Status: reviewed and ready for implementation planning

Date: 2026-07-23

## Decision

Managed Hermes receives each Discord bot token through Agent VM's existing raw
Gateway-secret exception. No resolved secret is written to host or guest disk.

```text
1Password
  -> Agent VM controller memory
  -> finalizable Gondolin MemoryProvider boot staging
  -> protected Hermes process environment
  -> agent-vm-hermes-adapter
  -> exact RAM-shadowed profile .env
  -> stock Hermes profile SecretScope
```

The boot staging and profile files are virtual memory-backed files, not host
files. The boot environment script is unlinked immediately after the protected
service sources it. The profile `.env` files remain only in the VM's memory
shadow for the VM lifetime because stock Hermes rereads them for profile
scopes, reconnects, and cron work. Closing the Gateway VM destroys them.

Discord is the explicit raw-secret exception because stock Hermes uses the same
token for Discord HTTP and WebSocket Gateway traffic. Other application and
provider credentials remain HTTP-mediated. There is no Discord frame
rewriting, new process, upstream Hermes change, or upstream Gondolin change.

## Intent And Success

One managed Hermes Gateway VM serves two profiles:

- agent and profile `clawfest` use the Clawfest Discord bot;
- agent and profile `beta` use the Beta Discord bot.

Both bots connect concurrently, retain deterministic profile assignment across
a supported Gateway restart, and can tag or message one another in beta.

This spec owns only:

- the closed agent-to-Discord-secret mapping;
- disk-free managed Gateway boot-input delivery;
- exact RAM-only Hermes profile token files;
- focused automated and beta proof.

The broader
[Tool Portal PR wrap-up](../2026-07-20-tool-portal-pr-wrapup/2026-07-20-tool-portal-pr-wrapup.md)
continues to own the remaining PR terminal.

## Hard Security Invariant

Resolved Discord tokens may exist in:

- the controller's resolver and serialization memory;
- Gondolin's in-process `MemoryProvider`;
- the protected Hermes service environment during adapter bootstrap;
- the adapter's process-local mapping;
- the two exact RAM-shadowed profile `.env` paths;
- Hermes's per-profile in-memory secret scopes;
- TLS traffic to Discord.

Resolved tokens must not exist in:

- a host filesystem staging directory;
- the Gateway rootfs or its host-backed qcow2 overlay;
- durable Hermes `stateDir` RealFS;
- `zoneFilesDir`, `runtimeDir`, `cacheDir`, backups, or images;
- Tool Portal or Tool VM environments;
- authored configuration, packages, disk-backed or baked scripts, logs,
  errors, traces, metrics, or diagnostics.

Guest root or a compromised process with access to the shared Gateway VM can
observe both tokens. This design prevents persistence and unintended
environment inheritance; it does not claim hostile process or profile
isolation inside one shared Gateway VM.

## Authored Configuration Contract

The Hermes Gateway declares a closed mapping:

```jsonc
"gateway": {
  "type": "hermes",
  "profilesByAgent": {
    "clawfest": "clawfest",
    "beta": "beta"
  },
  "discordBotTokenSecretsByAgent": {
    "clawfest": "DISCORD_BOT_TOKEN_CLAWFEST",
    "beta": "DISCORD_BOT_TOKEN_BETA"
  }
}
```

Each mapped secret uses the existing raw Gateway environment shape:

```jsonc
"secrets": {
  "DISCORD_BOT_TOKEN_CLAWFEST": {
    "source": "1password",
    "ref": "<test-vault reference>",
    "injection": "env",
    "audience": "gateway"
  },
  "DISCORD_BOT_TOKEN_BETA": {
    "source": "1password",
    "ref": "<test-vault reference>",
    "injection": "env",
    "audience": "gateway"
  }
}
```

The example references are placeholders, not deployment values.

The contract requires:

- mapping keys exactly match `profilesByAgent` keys;
- each value names one distinct same-zone secret;
- each mapped secret uses `injection: "env"` and `audience: "gateway"`;
- mapped Discord secrets declare no HTTP-mediation hosts;
- each mapped Hermes profile config includes `DISCORD_BOT_TOKEN` in
  `secrets.preserve_existing`, making the Agent VM-provided RAM `.env`
  authoritative over Hermes external-secret snapshots;
- apart from existing framework-control credentials, other Hermes application
  secrets remain HTTP-mediated.

Validation uses safe agent, profile, and secret names only. It does not resolve
or print secret values.

## Runtime Contract

At each Gateway start:

1. Agent VM validates the mapping and resolves the mapped secrets.
2. The managed-VM request declares empty, finalizable environment and
   structured-input memory mounts, not an owned or ordinary host directory.
3. The Gondolin adapter creates the two `MemoryProvider` instances while
   creating the unstarted VM. No Gondolin-native provider crosses the
   `managed-vm` boundary.
4. After VM creation establishes the exact Gateway VM identity, Agent VM builds
   and serializes the identity-dependent managed Gateway boot inputs in
   controller memory.
5. Agent VM finalizes each memory mount exactly once before VM start. The
   environment mount remains writable only so the trusted init script can
   unlink consumed entries; the structured-input mount is read-only to the
   guest. Missing or failed finalization prevents VM start.
6. The managed Gateway init script sources each service's environment script
   directly from the memory mount, requires unlink to succeed, and only then
   executes that service. Source or unlink failure is fail-closed for the
   affected service and prevents its readiness.
7. Tool Portal never sources the Hermes framework environment.
8. `agent-vm-hermes-adapter` joins each profile to its authored source name,
   captures the raw values, writes the two exact RAM-shadowed profile `.env`
   files with mode `0600`, and removes the source names from `os.environ`.
9. The adapter starts stock Hermes.
10. Stock Hermes loads each profile file into the matching `SecretScope`.

A Gateway restart repeats the flow and picks up rotated 1Password values. There
is no live rotation mechanism.

## Memory And Persistence Layout

```text
host
  controller heap
    └── resolved values and serialized boot inputs

  Gondolin MemoryProviders
    ├── environment boot staging
    │     environment scripts: source once, then unlink
    └── read-only structured boot staging
          service inputs: remain in RAM only when needed at runtime

Gateway VM
  stateDir RealFS lower
    ├── config.yaml
    ├── profiles/clawfest/      durable non-secret profile state
    └── profiles/beta/          durable non-secret profile state

  memory shadow upper
    ├── profiles/clawfest/.env
    └── profiles/beta/.env

  rootfs qcow2
    └── no resolved secret material
```

The adapter does not write, merge, copy, restore, migrate, or delete a durable
lower `.env`. Host preflight rejects a durable root `.env` or mapped profile
`.env` without reading or logging its contents. Adapter preflight also rejects
a mapped profile whose `secrets.preserve_existing` omits `DISCORD_BOT_TOKEN`;
the check uses configuration names only and does not resolve an external
secret. Removing legacy beta files is an explicit test-deployment cutover, not
migration machinery.

## Spec Boundary And Ownership

```text
deployment config
  owns: agent -> profile -> secret-name assignment
        |
        v
Agent VM controller
  owns: validation, resolution, identity-dependent in-memory serialization
        |
        | ManagedVm finalizable-memory contract
        v
Gondolin adapter
  owns: MemoryProvider binding, one-shot population, and VM mount translation
        |
        v
managed Gateway init
  owns: service-specific source-and-unlink bootstrap
        |
        v
existing agent-vm-hermes-adapter
  owns: exact profile mapping and RAM-shadowed .env materialization
        |
        v
stock Hermes
  owns: profile SecretScope, reconnect, cron, and Discord connections
```

The new managed-VM surface is intentionally narrow: a declared in-memory mount
accepts one complete pre-start inventory of relative file paths, contents, and
explicit modes. VM creation binds the empty provider; finalization populates it
once; VM start fails if finalization is missing or failed. The environment
mount permits the trusted boot script to unlink consumed entries. The sibling
structured-input mount is guest-read-only. This is not a generic persistence,
synchronization, secret-manager, update, retry, or copying system.

## Why The Profile Files Remain In RAM

Hermes's supported multiplexed profile scope rebuilds a profile's secret map
from `<profile>/.env` and cached external-secret snapshots. A plugin-only
in-memory source is not robust here: Hermes cron globally clears the shared
external-source cache and reloads only the current profile, which can remove
the other profile's token from later scopes.

Keeping the two exact `.env` paths in the existing RAM shadow preserves stock
Hermes reconnect and cron behavior without persistence or new lifecycle
machinery.

## Proof Expectations

Planning must provide focused proof that:

- valid and invalid mappings behave safely;
- managed Gateway boot inputs bind empty memory staging during VM creation,
  finalize exactly once before VM start, and create no host staging directory;
- no managed Gateway boot input is copied into rootfs/qcow2;
- consumed environment scripts are unlinked during boot while structured
  service inputs remain only on the read-only memory mount;
- source or unlink failure prevents the affected service from executing or
  becoming ready;
- Tool Portal and Tool VMs do not receive the mapped Discord values;
- only the two exact profile `.env` paths are RAM-shadowed;
- the adapter writes canonical values with mode `0600`, removes source names,
  and starts stock Hermes;
- durable root and mapped-profile `.env` paths fail preflight with
  content-safe diagnostics;
- mapped profiles without `DISCORD_BOT_TOKEN` in `secrets.preserve_existing`
  fail before stock Hermes starts;
- durable state, backup inputs, logs, and telemetry contain no raw test token;
- existing HTTP-mediated secrets remain mediated;
- restart rebuilds the RAM-only files from newly resolved values.

Exact-HEAD beta acceptance must prove both bots connect concurrently through
their assigned profiles, tag or message one another, and reconnect with the
same assignments after a Gateway restart. It also proves known legacy durable
`.env` paths are absent before startup.

Proof uses non-secret canaries in automated lanes and never prints deployment
values. This is feature and beta proof, not production deployment proof.

## Non-Goals And Stop Conditions

This feature does not add:

- Discord HTTP or WebSocket mediation, frame parsing, or placeholders;
- a Hermes secret-source plugin or cache interception;
- a relay, sidecar, supervisor, new process, or controller protocol;
- a generic secret materializer;
- migration, compatibility, copy-back, recovery, or live rotation;
- upstream Hermes, Gondolin, OpenClaw, discord.py, or aiohttp changes;
- Tool Portal, Tool VM, lease, SSH, workspace, Git, backup, or observability
  redesign.

Stop and reconverge if implementation evidence requires secret persistence,
guest-rootfs copying, VM-global raw environment, upstream changes, a new
process/lifecycle owner, or adjacent redesign.

## Source Anchors

Local owners:
[system config](../../../packages/agent-vm/src/config/system-config.ts),
[Gateway orchestrator](../../../packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts),
[managed-VM contract](../../../packages/managed-vm/src/managed-vm-contracts.ts),
[Gondolin mount translation](../../../packages/gondolin-vm-adapter/src/managed-vm-provider.ts),
[managed Gateway init](../../../packages/gondolin-vm-adapter/src/rootfs-init-extra.ts),
[Hermes lifecycle](../../../packages/hermes-gateway/src/hermes-lifecycle.ts), and
[managed Hermes adapter](../../../python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py).

Validated upstream checkouts:

- Gondolin `628369764fcd2c987b4b99e5159ec90d4febe53a`;
- Hermes `5be99b6fce16e7d5304196bc9faf3f0cdfc3031f`.

No product decision remains open inside this boundary. Implementation planning
may choose exact type and helper names, but it may not widen custody,
persistence, lifecycle, or protocol ownership.
