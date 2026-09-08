# Shared Image Cache Specification

Date: 2026-09-01

Requirements: [Shared Image Cache Requirements](2026-09-01-shared-image-cache-requirements.md)

## Observable Storage Contract

For a deployment storage root `<deploymentRoot>` whose parent is `<agentVmHostRoot>`, Agent VM must expose the following storage classes:

```text
<agentVmHostRoot>/cache/vm-images/<fingerprint>/
    immutable, rebuildable VM image artifacts shared by deployments

<agentVmHostRoot>/cache/deployments/<deploymentCacheKey>/docker-contexts/<family>/<profile>/
    potentially large generated Docker build contexts isolated by deployment

<agentVmHostRoot>/cache/deployments/<deploymentCacheKey>/zones/<zone>/framework-cache/
    mutable Gateway framework cache isolated by deployment and zone

<deploymentRoot>/generated/image-selections/<family>/<profile>.json
    deployment-owned selection of one shared image fingerprint

<deploymentRoot>/generated/gateway-effective/<zone>/
    deployment- and zone-owned generated effective Gateway configuration

<deploymentRoot>/<zone>/state/
<deploymentRoot>/<zone>/zone-files/
    unchanged durable data

<deploymentRoot>/<zone>/runtime/
    unchanged runtime evidence and control material
```

## Normative Requirements

### R1 — Shared content-addressed images

Agent VM must store each complete VM image artifact set exactly once per `<agentVmHostRoot>` and fingerprint. Gateway, Tool VM, and controller-execution consumers with the same effective fingerprint must resolve the same artifact directory regardless of deployment, zone, family, or profile name. [U2]

Incomplete builds must never be observable as complete cache hits. Concurrent builders for the same fingerprint must not corrupt or replace a complete artifact set.

Effective image identity includes the contents and relevant filesystem modes of declared local init scripts, copied files/directories, custom sandbox helpers, and local system expressions. Identical content under different recipe roots is reusable; changing referenced content must produce a different fingerprint. Build inputs must remain stable during preparation; detected changes reject publication. Published upstream helper/package versions and resolved OCI identity remain part of the applicable recipe/runtime inputs.

Before publication, required image assets must be regular non-empty files with a supported manifest and matching SHA-256 checksums. Cache hits and configured startup use structural validation of those files and manifest, without rehashing multi-gigabyte image contents. This avoids image-size-dependent startup reads; corruption introduced after publication that preserves valid file structure is not detected by cache admission.

### R2 — Deployment-owned image selections

Each configured image family and profile must publish a deployment-owned selection record that identifies the selected fingerprint in the configured shared artifact root. Gateway and Tool VM startup must never guess or rebuild that selection. When the record is missing, malformed, mismatched, or references an incomplete artifact, startup must fail with an instruction to run `agent-vm build`. [U1, U3]

Selection records must not make absolute authored recipe paths part of shared artifact identity.

### R3 — Effective Gateway configuration naming

Generated effective Gateway and Tool Portal configuration must be written beneath `<deploymentRoot>/generated/gateway-effective/<zone>/`. The zone identifier must remain part of the path. The former deployment-local cache paths must not be read or written. [U1, U3, U4]

Framework cache material mounted into a Gateway must remain separate from effective configuration.

### R4 — Generated Docker build contexts

Generated Dockerfiles and copied overlay inputs must live beneath the single host cache at `cache/deployments/<deploymentCacheKey>/docker-contexts/<family>/<profile>/`. They are potentially large rebuildable build inputs, isolated by canonical deployment identity but not stored beneath the deployment root. [U1, U3, U4]

### R5 — Cleanup ownership

`agent-vm cache clean --confirm` must acquire the invoking deployment's exclusive controller-ownership lock before deleting anything. While holding that lock it may remove only `cache/deployments/<deploymentCacheKey>/docker-contexts` and that deployment's zone framework caches. It must never delete deployment-generated metadata, shared image artifacts, another deployment cache scope, or any durable/runtime root. Build auto-prune must not delete from the central cache. [U2, U3, U4]

Automatic shared-image pruning is disabled. `build --force` may rebuild upstream Docker inputs, but it must not replace a complete immutable shared artifact when the effective fingerprint is unchanged. Host-wide shared-image garbage collection is outside this change.

### R6 — Hard cut and protected data

Agent VM must not migrate, adopt, or fall back to deployment-local fingerprint directories or the former effective-configuration path. `agent-vm build` recreates shared images, Docker contexts, and image selections in the new layout. Preflight/startup may recreate only Gateway-effective configuration and runtime-owned framework cache directories; a missing configured image selection fails before VM creation. [U1, U3]

The change must not move, delete, reinterpret, or broaden access to controller state, zone state, zone files, zone runtime, backups, secrets, or authored configuration.

### R7 — One cache root and size boundary

`<agentVmHostRoot>/cache` must be the only directory named `cache` that Agent VM derives as an operational storage class. Potentially large disposable content belongs beneath it. Deployment-local generated metadata must live beneath `<deploymentRoot>/generated`, and no `<deploymentRoot>/cache` directory may be created or consumed. [U1, U4]

## Failure Contract

If the shared artifact root is unavailable or unsafe, build and startup fail with the affected path and do not fall back to a deployment-local image copy.

If an image build fails, no selection record is advanced to the incomplete fingerprint. Existing complete artifacts and selections remain usable. A final fingerprint directory that fails structural validation fails closed with its exact path; automatic preparation does not delete, quarantine, or replace it. Publication-time checksum failure rejects the staged image and leaves prior selections unchanged.

If configured Gateway or Tool VM startup cannot validate its deployment selection, no VM is created and the error identifies the affected family/profile and instructs the operator to run `agent-vm build`.

Concurrent publishers may duplicate build work. The first complete staging directory published to an absent fingerprint path wins. A losing publisher must validate and consume the winner; if the winner is not complete, the operation fails closed and preserves both evidence paths for diagnosis.

## Proof Obligations

| ID | Evidence |
| --- | --- |
| V1 | Automated behavior proving equivalent profiles and deployments resolve one shared fingerprint directory |
| V2 | Cross-process or production-shaped host proof that concurrent same-fingerprint preparation publishes one complete artifact |
| V3 | Automated behavior proving missing, malformed, mismatched, escaped, and incomplete selections reject configured Gateway and Tool VM startup with a build instruction |
| V4 | Integration proof that effective configuration is written only to `generated/gateway-effective/<zone>` |
| V5 | CLI/state inspection proving Docker contexts and framework caches use the central cache while durable storage paths remain unchanged |
| V6 | Cache-clean and force-build behavior proving the ownership lock gates deletion, only the invoking deployment cache scope is removed, and complete shared artifacts are never deleted or replaced |
| V7 | Built-CLI path inspection proving one cache root, one deployment-generated root, and no deployment-local cache directory |
| V8 | Beta deployment proof using worktree tarball sync, beta validation/build/start, resolved-path inspection, controller health, configured Gateway health, and clean stop. The proof harness must not directly write or delete beta `state`, `zone-files`, `controller-state`, or backups; normal production runtime writes to framework/controller state are allowed. Agent work is not invoked, `zone-files/agents/**` and existing backup artifacts must remain byte-identical, and clean stop must leave no new live runtime record. |

## Non-Goals

- Sharing mutable Gateway framework caches across deployments or zones.
- Content-addressing mutable framework caches or generated Docker contexts.
- Changing image contents, except for the existing runtime recipe contract. Completing the identity of declared local build inputs is required for safe cross-deployment reuse.
- Migrating old rebuildable cache entries.
- Host-wide shared-image garbage collection or online replacement of a complete fingerprint.
- Changing backup contents or guest mount paths.
