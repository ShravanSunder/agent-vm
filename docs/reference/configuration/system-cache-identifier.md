# systemCacheIdentifier.json

`systemCacheIdentifier.json` is required and must live next to `system.jsonc`
or `system.json`.
Its parsed JSON contents are hashed into every Gondolin image fingerprint.

This file describes the outer build environment: things that can change the VM
image contents even when `build-config.jsonc` does not change.

## Default Shape

```json
{
  "$comment": "Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change cacheProfile or cacheFormat when the outer cache contract changes.",
  "schemaVersion": 1,
  "os": "darwin",
  "hostSystemType": "bare-metal",
  "cacheProfile": "default",
  "cacheFormat": "gondolin-cache-v1"
}
```

The loader only requires valid JSON. The fields above are the scaffolded
convention, not a strict schema.

`cacheProfile` names the broad cache compatibility profile. `cacheFormat`
names the expected cache layout/contract. Change either value when the outer
cache contract changes in a way that should invalidate shared Gondolin image
fingerprints.

## Local vs Container

Local scaffold:

```json
{
  "schemaVersion": 1,
  "os": "darwin",
  "hostSystemType": "bare-metal",
  "cacheProfile": "default",
  "cacheFormat": "gondolin-cache-v1"
}
```

Container-host scaffold:

```json
{
  "schemaVersion": 1,
  "os": "darwin",
  "hostSystemType": "container",
  "cacheProfile": "default",
  "cacheFormat": "gondolin-cache-v1"
}
```

The `os` value is captured from the machine that ran `agent-vm init`. Container
host scaffolds use the same checked-in compatibility identifier instead of
rewriting it during image builds.

## Failure Behavior

Commands that need image fingerprints fail fast when the file is missing or
malformed. `agent-vm validate` and `agent-vm doctor` report the file path and
parse error in their check output.

## What Not To Put Here

Do not put package versions here. Runtime package versions are resolved from
the running controller and adapter packages when the image fingerprint is
computed. The identifier file should stay focused on the outer host/build
environment.
