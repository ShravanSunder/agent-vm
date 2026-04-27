# Storage Model

[Overview](../README.md) > [Architecture](overview.md) > Storage Model

agent-vm separates source config, durable state, rebuildable cache, workspaces,
and backup artifacts. Do not collapse these storage classes to fix a boot or
restore symptom; moving data between them changes backup semantics.

## Storage Classes

```text
source/config
  Owner: catalog repo
  Example: config/system.json, config/gateways/<zone>/openclaw.json, vm-images/
  Backup: git, not agent-vm backups
  Rule: human-authored desired state

durable state
  Owner: controller runtime
  Host: <stateDir>
  VM: /home/openclaw/.openclaw/state or /state
  Backup: yes
  Rule: difficult or annoying to recreate; identity, auth profiles, runtime records

rebuildable cache
  Owner: controller/runtime tooling
  Host: <cacheDir>
  VM: gateway-specific cache mounts
  Backup: no
  Rule: can be deleted and repaired; may persist across reboot for speed

workspace
  Owner: agent/user workflow
  Host: <workspaceDir>
  VM: /home/openclaw/workspace or /workspace
  Backup: yes for zone backups
  Rule: user/agent work products and checkouts

backup output
  Owner: backup commands
  Host: <backupDir>
  Backup: no; this is the backup artifact
  Rule: encrypted archives only
```

## OpenClaw Gateway Paths

```text
catalog repo
  config/gateways/<zone>/openclaw.json
  vm-images/gateways/openclaw/

host stateDir
  ~/.agent-vm/state/<zone>/
    effective-openclaw.json
    agents/main/agent/auth-profiles.json
    gateway-runtime.json
    logs/

host cacheDir
  ~/.agent-vm/cache/
    gateway-images/<imageProfile>/
    tool-vm-images/<imageProfile>/
    gateways/<zone>/
      plugin-runtime-deps/

host workspaceDir
  ~/.agent-vm/workspaces/<zone>/

host backupDir
  ~/.agent-vm-backups/<zone>/
```

OpenClaw bundled plugin runtime dependencies belong under
`cacheDir/gateways/<zone>/plugin-runtime-deps`, not under `stateDir`. They must
survive a copy-on-write VM reboot, but they are derived npm dependency trees and
should not inflate encrypted backups.

## Backup Contract

Zone backups archive:

```text
state/
workspace/
manifest.json
```

Zone backups do not archive `cacheDir`. If a cache is missing after restore,
doctor/repair flows should rebuild it rather than restoring stale dependency
trees from encrypted backup.

## Design Rule

If data is required for correctness and cannot be recreated from config,
secrets, or upstream packages, it belongs in state. If it only avoids slow
repair or rebuild work, it belongs in cache.
