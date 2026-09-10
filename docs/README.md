# agent-vm docs

Start with the root [README](../README.md) for the five-minute model. This
directory is the deeper map for the Hermes-only controller and runtime.

## Reading Paths

| If you want to... | Read |
| --- | --- |
| Set up a local or container Hermes deployment | [getting-started/setup.md](getting-started/setup.md) |
| Invite family to Google-first website login | [getting-started/google-onboarding.md](getting-started/google-onboarding.md) |
| Configure a Hermes managed Gateway | [reference/configuration/system-json.md](reference/configuration/system-json.md) |
| Understand state, cache, and backup boundaries | [architecture/storage-model.md](architecture/storage-model.md) |
| Understand reusable credentialed CLI runtimes | [architecture/credentialed-runtimes.md](architecture/credentialed-runtimes.md) |
| Understand Google account policy and RealFS file delivery | [specs/2026-09-04-agent-account-and-tool-permissions/program-design.md](specs/2026-09-04-agent-account-and-tool-permissions/program-design.md) and [file delivery](specs/2026-09-04-agent-account-and-tool-permissions/file-delivery.md) |
| Understand VM provider and package boundaries | [architecture/overview.md#package-dependency-graph](architecture/overview.md#package-dependency-graph) |
| Understand Gondolin rootfs/VFS performance knobs | [reference/gondolin/vfs-rootfs-performance.md](reference/gondolin/vfs-rootfs-performance.md) |
| Inspect Gondolin patches and their approval/distribution rules | [architecture/gondolin-patches.md](architecture/gondolin-patches.md) |
| Review the accepted Gateway Runtime and Tool Portal contract | [specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md](specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md) |
| Review concrete Hermes and Tool VM storage paths | [architecture/storage-matrix.md](architecture/storage-matrix.md) |
| Look up configuration fields | [reference/configuration/README.md](reference/configuration/README.md) |
| Decide whether to run validate or doctor | [reference/validate-and-doctor.md](reference/validate-and-doctor.md) |

## Current Documentation

```text
docs/
  getting-started/setup.md
  architecture/
    overview.md
    credentialed-runtimes.md
    storage-model.md
    storage-matrix.md
  subsystems/
    controller.md
    gateway-lifecycle.md
    gondolin-vm-layer.md
    mcp-portal.md
    secrets-and-credentials.md
  reference/
    configuration/
      README.md
      system-json.md
    gondolin/vfs-rootfs-performance.md
    validate-and-doctor.md
```
