# agent-vm docs

Start with the root [README](../README.md) for the five-minute model. This
directory is the deeper map.

## Reading Paths

| If you want to... | Read |
| --- | --- |
| Run a local Worker gateway | [getting-started/setup.md](getting-started/setup.md) |
| Configure a Hermes managed Gateway | [reference/configuration/system-json.md](reference/configuration/system-json.md) |
| Understand the Worker gateway | [architecture/agent-worker-gateway.md](architecture/agent-worker-gateway.md) |
| Understand state/cache/backup boundaries | [architecture/storage-model.md](architecture/storage-model.md) |
| Understand reusable credentialed CLI runtimes | [architecture/credentialed-runtimes.md](architecture/credentialed-runtimes.md) |
| Understand VM provider and package boundaries | [architecture/overview.md#package-dependency-graph](architecture/overview.md#package-dependency-graph) |
| Review the accepted Gateway runtime and Tool Portal contract | [specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md](specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md) and its [glossary](specs/2026-07-12-agent-vm-gateway-runtime/glossary.md) |
| Review concrete Hermes/Worker storage paths | [architecture/storage-matrix.md](architecture/storage-matrix.md) |
| Understand Gondolin rootfs/VFS performance knobs | [reference/gondolin/vfs-rootfs-performance.md](reference/gondolin/vfs-rootfs-performance.md) |
| Look up config fields | [reference/configuration/README.md](reference/configuration/README.md) |
| Set up repo or external resources | [reference/configuration/resource-contracts.md](reference/configuration/resource-contracts.md) |
| Know whether to run validate or doctor | [reference/validate-and-doctor.md](reference/validate-and-doctor.md) |

## Doc Tree

```text
docs/
  getting-started/
    setup.md
    worker-guide.md

  architecture/
    overview.md
    credentialed-runtimes.md
    storage-model.md
    storage-matrix.md
    agent-worker-gateway.md

  subsystems/
    controller.md
    gateway-lifecycle.md
    gondolin-vm-layer.md
    mcp-portal.md
    secrets-and-credentials.md
    worker-task-pipeline.md

  specs/
    2026-07-12-agent-vm-gateway-runtime/
      agent-vm-gateway-runtime.md
      glossary.md

  reference/
    gondolin/
      vfs-rootfs-performance.md
    configuration/
      README.md
      project-config-json.md
      prompt-files.md
      resource-contracts.md
      system-json.md
      worker-json.md
    validate-and-doctor.md
```
