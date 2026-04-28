# agent-vm docs

Start with the root [README](../README.md) for the five-minute model. This
directory is the deeper map.

## Reading Paths

| If you want to... | Read |
| --- | --- |
| Run a local Worker gateway | [getting-started/setup.md](getting-started/setup.md) |
| Understand the Worker gateway | [architecture/agent-worker-gateway.md](architecture/agent-worker-gateway.md) |
| Understand state/cache/backup boundaries | [architecture/storage-model.md](architecture/storage-model.md) |
| Review concrete OpenClaw/Worker storage paths | [architecture/storage-matrix.md](architecture/storage-matrix.md) |
| Understand Gondolin rootfs/VFS performance knobs | [reference/gondolin/vfs-rootfs-performance.md](reference/gondolin/vfs-rootfs-performance.md) |
| Look up config fields | [reference/configuration/README.md](reference/configuration/README.md) |
| Set up repo or external resources | [reference/configuration/resource-contracts.md](reference/configuration/resource-contracts.md) |
| Know whether to run validate or doctor | [reference/validate-and-doctor.md](reference/validate-and-doctor.md) |
| Use OpenClaw Gateway | [getting-started/openclaw-guide.md](getting-started/openclaw-guide.md) |

## Doc Tree

```text
docs/
  getting-started/
    setup.md
    worker-guide.md
    openclaw-guide.md

  architecture/
    overview.md
    storage-model.md
    storage-matrix.md
    agent-worker-gateway.md
    openclaw-gateway.md

  subsystems/
    controller.md
    gateway-lifecycle.md
    gondolin-vm-layer.md
    secrets-and-credentials.md
    worker-task-pipeline.md

  reference/
    gondolin/
      vfs-rootfs-performance.md
    configuration/
      README.md
      project-config-json.md
      prompt-files.md
      resource-contracts.md
      system-cache-identifier.md
      system-json.md
      worker-json.md
    validate-and-doctor.md
```
