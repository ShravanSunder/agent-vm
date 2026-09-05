# Shared Image Cache Program Design

Date: 2026-09-01

Requirements: [Shared Image Cache Requirements](2026-09-01-shared-image-cache-requirements.md)  
Specification: [Shared Image Cache Specification](2026-09-01-shared-image-cache.md)

## Target Composition

```text
resolved storage layout
├── host cache owner
│   ├── vm-images/<fingerprint>
│   └── deployments/<deploymentCacheKey>/
│       ├── docker-contexts/<family>/<profile>
│       └── zones/<zone>/framework-cache
└── deployment generated owner
    ├── image-selections/<family>/<profile>.json
    └── gateway-effective/<zone>
```

The system-config boundary derives both roots from the canonical deployment storage root:

```text
deploymentRoot       = storageRootDir
agentVmHostRoot      = dirname(storageRootDir)
cacheDir             = agentVmHostRoot/cache
sharedImageCacheDir  = cacheDir/vm-images
deploymentCacheKey   = sha256(canonical storageRootDir)
deploymentCacheDir   = cacheDir/deployments/<deploymentCacheKey>
deploymentGeneratedDir = deploymentRoot/generated
```

The loader rejects a canonical deployment root that equals, contains, or is contained by the host cache root. Scaffolding also rejects `cache` as `projectNamespace`, while canonical-path checks remain authoritative for manually authored roots and symlink-equivalent paths. No deployment-local `cache` leaf is derived.

## Ownership And Interfaces

### Resolved storage layout

The system-config loader exclusively owns path derivation and isolation checks. `cacheDir` means the one host cache root. The full lowercase hexadecimal SHA-256 of canonical `storageRootDir` is the deployment cache identity; two distinct canonical roots therefore cannot claim one mutable cache scope even when they share `projectNamespace`. Central helpers derive the shared image store, deployment cache scope, zone framework cache, and deployment-generated root; downstream callers never reconstruct those paths ad hoc.

### Host image store

The Gondolin image builder owns immutable artifact publication at `<sharedImageCacheDir>/<fingerprint>`. A complete artifact directory is a cache hit. Builds occur in a unique sibling staging directory and publish by rename only after every required asset exists. A losing concurrent publisher validates the complete winner, discards its staging directory, and consumes the winner.

The image-artifact validator owns the admission predicate. It requires regular non-empty assets, a supported version-one manifest, fixed required asset filenames, and well-formed checksum entries. It rejects asset symlinks and path traversal. Publication additionally streams each asset through SHA-256 and compares the manifest checksum before rename. Cache hits, losing-publisher admission, and selection reads reuse only the structural predicate; they do not rescan large binary contents. Later same-structure binary corruption is outside this fast-path guarantee.

```text
staged build -> structural validation -> streamed checksums -> atomic publication
published image -> structural validation -> cache hit / selection admission
local build failure -> remove owned staging, even if another publisher won
incomplete-winner publication failure -> preserve final and staging evidence
```

Only the atomic absent-to-complete transition is supported. An incomplete final fingerprint directory is corrupt evidence: preparation fails with the exact path and does not delete or quarantine it. `forceRebuild` may refresh upstream Docker inputs and thereby produce a different fingerprint, but it never replaces a complete shared artifact with the same fingerprint.

### Deployment image selections

The prepared-image selection module owns one schema-versioned record per image family and profile beneath `<deploymentGeneratedDir>/image-selections`. A record contains the canonical recipe identity, effective fingerprint inputs, fingerprint, and managed-Gateway boot projection when applicable. It does not store an authoritative artifact path. The reader derives `<sharedImageCacheDir>/<fingerprint>` from trusted configuration.

Configured Gateway and Tool VM startup reads the deployment selection. The reader requires the current schema, exact canonical recipe identity, valid fingerprint shape, recomputed fingerprint agreement using the recorded effective inputs and boot projection, and a complete derived artifact directory whose canonical identity remains contained by `sharedImageCacheDir`. A missing or invalid selection fails before VM construction and instructs the operator to run `agent-vm build`; startup never owns Docker build or image-selection publication.

Selection records use this structural contract:

```text
schemaVersion        exact current version
recipeIdentity       canonical real path of the configured recipe
fingerprint          16 lowercase hexadecimal characters
fingerprintInput     optional effective Docker/rootfs input
managedGatewayBoot   optional validated managed-Gateway projection
```

The record path is derived from validated family and profile identifiers. The artifact path is never accepted from the record.

### Effective Gateway configuration

The Gateway orchestrator owns `<deploymentGeneratedDir>/gateway-effective/<zone>`. Tool Portal materialization writes small effective configuration and admission files there. The mutable Gateway framework cache is separately mounted from `<deploymentCacheDir>/zones/<zone>/framework-cache`.

Controller-execution recipes are the explicit exception: effective-config materialization prepares those recipe-referenced images directly into the shared image store and embeds their prepared identity in the zone-owned effective configuration. They are not configured Gateway or Tool VM profiles and do not use deployment profile-selection records.

### Generated Docker contexts

The managed Dockerfile generator owns `<deploymentCacheDir>/docker-contexts/<family>/<profile>`. It recreates this potentially large deployment-scoped build context from managed image metadata and authored overlays.

## Call-Path Changes

### Profile build

```text
current
agent-vm build
  ──► derive deployment/profile image directory
  ──► build fingerprint directory there
  ──► materialize duplicate profile aliases
  ──► write profile-local prepared-image.json
  ──► prune from current deployment fingerprints

proposed
agent-vm build
  ──► derive shared image store plus deployment selection path
  ──► build or reuse one shared fingerprint directory
  ──► write deployment selection record
  ──► retain shared artifacts; build has no deletion authority
```

### Gateway and Tool VM startup

```text
current
startup ──► profile-local prepared receipt ──► profile-local image

proposed
startup ──► deployment selection ──► shared fingerprint image
        └── invalid selection ──► fail: run agent-vm build
```

### Effective configuration

```text
current   <deployment>/cache/gateways/<zone>/tool-portal-effective
proposed  <deployment>/generated/gateway-effective/<zone>
```

There is no fallback read from the current path.

## Failure And Concurrency

The shared fingerprint directory has this publication state model:

| Final path | Staging path | Result |
| --- | --- | --- |
| absent | absent | cache miss; create unique staging path |
| absent | complete | atomically rename staging to final; publisher wins |
| complete | any | validate final, remove owned staging, return cache hit |
| incomplete or corrupt | any | fail closed; preserve final and owned staging for diagnosis |
| appears complete after rename loses | complete | validate winner, remove owned staging, return winner |
| appears incomplete after rename loses | any | fail closed; preserve evidence |

Only the process that created a staging path may remove that staging path. No process removes or replaces a final fingerprint directory in this design.

| Situation | Owner response |
| --- | --- |
| Build fails in staging | Remove staging; preserve published artifact and selection |
| Two processes build one fingerprint | Both may perform work; one publishes, the other validates and consumes the winner |
| Selection write fails during build | Preserve shared artifact; keep the prior selection; build reports failure |
| Configured startup selection is missing or invalid | Fail before VM creation with a `run agent-vm build` instruction |
| Shared artifact final path is incomplete | Fail closed with its exact path; preserve it for diagnosis |
| Force rebuild produces the same fingerprint | Reuse the existing complete immutable artifact |
| Deployment cleanup encounters shared artifacts | Preserve them; delete only the invoking deployment's cache scope while its ownership lock is held |
| Old deployment-local cache exists | Ignore it; rebuild or select from the shared store |
| Incomplete final fingerprint directory exists | Fail closed with its exact path; do not delete or quarantine it |

The design intentionally accepts duplicate concurrent build work to avoid introducing a lock service or stale-lock recovery protocol. Atomic absent-to-complete publication owns correctness; deduplication is best effort until publication. Shared deletion, replacement, and garbage collection are absent, so publication does not need a cross-deployment mutation admission protocol.

### Cleanup call path

```text
current
agent-vm build ──► profile-local stale scan ──► delete old profile images
agent-vm cache clean --confirm ──► profile-local stale scan ──► delete old profile images

proposed
agent-vm build ──► publish/reuse immutable fingerprint ──► no deletion edge

agent-vm cache clean --confirm
  ──► acquire this deployment's controller-ownership lock
  ──► refuse if the deployment controller owns the lock
  ──► delete <deploymentCacheDir>/docker-contexts
  ──► delete <deploymentCacheDir>/zones/*/framework-cache
  ──► release ownership lock

forbidden edges
  cache clean / build / zone cleanup ──╳──► <cacheDir>/vm-images
  current deployment cleanup         ──╳──► sibling deployment cache scope
  cache clean                        ──╳──► <deploymentGeneratedDir>
```

The ownership lock serializes cache cleanup against controller startup for the invoking deployment. Because the complete deployment cache scope is covered, separate per-zone stopped evidence is unnecessary: cleanup runs only while that deployment's controller is offline.

## Cutover

This is a rebuild-only hard cut:

1. New code derives one host cache root, deployment-generated root, and their exact child paths.
2. Existing deployment-local cache directories and old effective configuration are ignored.
3. The next `agent-vm build` recreates shared images, Docker contexts, and image selections. Startup may recreate only Gateway-effective configuration and runtime-owned framework cache directories; a missing configured image selection fails before VM creation with the build instruction.
4. No automatic deletion or migration touches the old directories.

Rollback requires using the previous binary, which continues to read its old deployment-local cache. Durable state and authored configuration are unchanged in either direction.

## Requirement And Proof Realization

| Requirement | Owner | Proof seam |
| --- | --- | --- |
| R1 | Gondolin build pipeline and resolved storage layout | two deployments, equivalent fingerprint, one artifact path; concurrent publisher host test |
| R2 | prepared-image selection module | selection validation unit and startup integration |
| R3 | Gateway orchestrator and Tool Portal materializer | generated effective-config integration path inspection |
| R4 | managed Dockerfile generator | build integration path inspection |
| R5 | cache command and immutable host image store | deployment cleanup and force-build tests |
| R6 | config loader and startup/build paths | no-fallback integration plus protected-path assertions |
| R7 | resolved storage layout and Gateway lifecycle | built-CLI tree inspection and mount-path integration |

The release-shaped proof seam is the sibling `shravan-claw-beta` deployment: sync exact worktree tarballs, validate and build beta, inspect its resolved central-cache/generated paths, start it without invoking agent work, verify controller and configured Gateway health, and stop it cleanly. The harness takes pre/post checksums for `zone-files/agents/**` and existing backup artifacts; those must remain byte-identical. It does not directly write or delete `state`, `zone-files`, `controller-state`, or backups. Normal production runtime writes to framework/controller state are allowed, and clean stop must leave no new live runtime record. The proof grants no push or release authority.

## Rejected Alternatives

Keeping profile-local image directories preserves the current APIs but cannot deduplicate across profiles or deployments. Hard-linking deployment copies reduces blocks only on one filesystem and preserves confusing duplicate ownership.

Putting effective Gateway configuration in the host cache would mix small generated metadata with potentially huge disposable artifacts. Keeping it under `<deployment>/generated` preserves deployment and zone ownership without creating a second cache root.

A host image daemon, reference-count database, or host-root mutation lock would enable online garbage collection and replacement, but each adds coordination machinery not required for the initial sharing outcome. This change exposes no shared destructive operation; a later garbage-collection design must establish its own host-wide admission and runtime-use proof.
