# systemCacheIdentifier.json

`systemCacheIdentifier.json` is required and must live next to `system.jsonc`
or `system.json`.
Its parsed JSON contents are hashed into every Gondolin image fingerprint.

This file describes the outer build environment: things that can change the VM
image contents even when `build-config.jsonc` does not change.

## Default Shape

```json
{
  "$comment": "Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change imageCacheFormat when the image cache contract changes.",
  "schemaVersion": 1,
  "hostSystemType": "bare-metal",
  "imageCacheFormat": "gondolin-image-cache-v1"
}
```

Versioned identifiers use a strict schema. Legacy unversioned identifiers stay
permissive so existing caches remain readable.

`imageCacheFormat` names the expected image cache layout/contract. Change it
when the image cache contract changes in a way that should invalidate shared
Gondolin image fingerprints.

## Local vs Container

Local scaffold:

```json
{
  "$comment": "Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change imageCacheFormat when the image cache contract changes.",
  "schemaVersion": 1,
  "hostSystemType": "bare-metal",
  "imageCacheFormat": "gondolin-image-cache-v1"
}
```

Container-host scaffold:

```json
{
  "$comment": "Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change imageCacheFormat when the image cache contract changes.",
  "schemaVersion": 1,
  "hostSystemType": "container",
  "imageCacheFormat": "gondolin-image-cache-v1"
}
```

`hostSystemType` distinguishes local bare-metal controllers from generic
container-host deployments. The identifier intentionally does not capture host
operating system names; the current image cache contract is the same across
macOS and Linux for matching Tool VM and gateway image inputs.

## Failure Behavior

Commands that need image fingerprints fail fast when the file is missing or
malformed. `agent-vm validate` and `agent-vm doctor` report the file path and
parse error in their check output.

## What Not To Put Here

Do not put package versions here. Runtime package versions are resolved from
the running controller and adapter packages when the image fingerprint is
computed. The identifier file should stay focused on the outer host/build
environment.
