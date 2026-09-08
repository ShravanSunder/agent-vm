# Shared Image Cache Requirements

Date: 2026-09-01
Authority: repository owner decisions in the cache-layout discussion

## Users And Outcomes

### U1 — Operator storage clarity

Authority: authorized  
Priority: critical

An operator must be able to distinguish immutable VM image artifacts, generated deployment configuration, runtime evidence, and durable zone data from their paths. A zone is an ownership boundary, not a cache classification.

### U2 — Cross-deployment image reuse

Authority: authorized  
Priority: critical

Independent Agent VM deployments under the same Agent VM host root must reuse identical fingerprinted VM image artifacts instead of storing one copy per deployment and image profile.

### U3 — Deployment and zone ownership

Authority: authorized  
Priority: critical

Generated effective Gateway configuration must remain isolated by deployment and zone. Durable zone state, zone files, controller authority, and runtime evidence must retain their existing durability and ownership semantics.

### U4 — One cache namespace

Authority: authorized  
Priority: critical

Operators must see exactly one `cache/` namespace beneath the Agent VM host root. Potentially large disposable artifacts and mutable runtime caches belong there. Small deployment-generated metadata belongs under that deployment's `generated/` directory instead of a second deployment-local `cache/`.

## Goal Boundary

The change covers host placement, naming, lifecycle, and proof for VM image artifacts, image-selection receipts, generated Docker build contexts, mutable Gateway framework caches, and effective Gateway configuration.

The change does not alter guest paths, authored Gateway or Tool Portal configuration, zone durable data, backup membership, VM image contents, or Gateway behavior.

The change is a hard cut. Existing deployment-local image artifacts and old effective-configuration paths are rebuildable and are not migrated or read through compatibility fallbacks.
