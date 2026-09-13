# Storage Matrix

[Overview](../README.md) > [Architecture](overview.md) > Storage Matrix

This matrix is the concrete path policy for Hermes Gateway VMs and Tool VMs. It
applies the broader storage classes from [Storage Model](storage-model.md) to
the actual paths each VM should use.

The core rule is that storage location defines both performance and backup
semantics. Do not move files between these classes without explicitly reviewing
the backup and VFS consequences.

## Hermes Gateway VM

Hermes is a long-lived managed service. Its framework home and profile state
are durable. Stable boot-time dependencies belong in the managed image recipe;
repair caches and runtime logs stay outside backup.

```text
path or data                           backing                backup
──────────────────────────────         ─────────────────      ─────────

config/gateways/<zone>/
hermes config, prompts                 git/catalog repo       git only
                                       desired config         not backup

Hermes managed image recipe             @agent-vm/hermes-      no
and immutable upstream pin               gateway package        release-owned

/home/hermes/.hermes                     Shadow -> stateDir      yes
root config, profiles, framework         durable framework home
state; profile .env paths are tmpfs

/home/hermes/.cache                      RealFS deployment     no
repair/download caches                  rebuildable
                                       cache scope

zoneFilesDir/agents/<agentId>           host durable RealFS    yes
selected agent workspace                projected to Tool VM
                                       at /workspace

/agent-vm/logs                          RealFS zoneRuntimeDir  no
gateway-boot-latest.log,                zone-lifetime, wiped by
Hermes and Gateway Runtime logs         destroy-zone --purge

/work/tmp                               rootfs/COW             no
large temp, TMPDIR target               disposable disk

/work/cache                             rootfs/COW or cache    no
runtime package cache                   disposable or repairable

/tmp, /run, /var/log                    guest tmpfs            no
sockets, pid files, tiny scratch        memory-pressure only

gateway-runtime.json                    controllerStateDir     no
host runtime record                     controller-only

tool-leases/<recordId>.json             controllerStateDir     no
Tool VM recovery record                 controller-only
recordId UUID; keeps agentId,
leaseId, vmId, qemuPid; never
stores framework scope keys
```

Hermes Gateways are long-lived, so rootfs/COW scratch can accumulate across
requests. Size `runtimeRootfsSize` explicitly and use an operational restart
window where necessary. Tool VMs are shorter-lived and shed their rootfs state
at lease teardown. Hermes does not mount a broad
`zoneFilesDir` root; the controller projects only the selected agent workspace
into its Tool VM at `/workspace`.

## Tool VM

Tool VMs are lease-local execution sandboxes. The controller selects one stable
agent identity and grants only that agent's filtered durable workspace and
optional workspace Git database. Callers never supply a host mount path.
`/work` is fast rootfs/COW execution space and is discarded when the Tool VM
closes or is replaced.

For the canonical name/location/storage vocabulary, see
[Lease Path Vocabulary](storage-model.md#lease-path-vocabulary).

```text
path or data                           backing                backup
──────────────────────────────         ─────────────────      ─────────

/workspace                             filtered RealFS         yes
selected durable agent workspace      zoneFilesDir child

/work                                  rootfs/COW              no
repos, builds, packages, temp work     deleted with Tool VM

/agent-vm/files                       read-only RealFS         no
temporary Gog publications            controller receiver root;
                                      one hour or Tool VM close

/gitdirs/workspace.git                 selected RealFS         no
optional workspace Git database       controller runtime

/agent-vm                              reviewed read-only      generated
runtime instructions and metadata     narrow inputs only

/tmp, /run, /var/log                   guest tmpfs            no
tiny scratch only                      memory-pressure
```

`/agent-vm/files` is a fixed, narrow exception to the generic generated
`/agent-vm` inventory. It contains only publications bound to this exact Tool VM
generation. Gog writes instead to its isolated fixed producer mount at
`/agent-vm/gog-work`; the controller publishes bounded independent-inode copies.
Input paths still resolve from disposable `/work`, and agents copy wanted output
to durable `/workspace` before expiry. Producer closure or Google disconnect does
not recall a published file. Cleanup uses normal unlink semantics, so already-open
or cached bytes are not forcibly revoked.
