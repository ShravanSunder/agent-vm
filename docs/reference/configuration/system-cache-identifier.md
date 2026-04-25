# systemCacheIdentifier.json

`systemCacheIdentifier.json` is required and must live next to `system.json`.
Its parsed JSON contents are hashed into every Gondolin image fingerprint.

This file describes the outer build environment: things that can change the VM
image contents even when `build-config.json` does not change.

## Default Shape

```json
{
  "$comment": "System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha='local' is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.",
  "schemaVersion": 1,
  "os": "darwin",
  "hostSystemType": "bare-metal",
  "gitSha": "local"
}
```

The loader only requires valid JSON. The fields above are the scaffolded
convention, not a strict schema.

## Local vs Container

Local scaffold:

```json
{
  "schemaVersion": 1,
  "os": "darwin",
  "hostSystemType": "bare-metal",
  "gitSha": "local"
}
```

Container-host scaffold:

```json
{
  "schemaVersion": 1,
  "os": "darwin",
  "hostSystemType": "container",
  "gitSha": "local"
}
```

The `os` value is captured from the machine that ran `agent-vm init`. In the
real container-host runtime, `vm-host-system/Dockerfile` rewrites the file with
Linux runtime data and a required `GIT_SHA` build arg.

Despite the field name, `gitSha` does not have to come from GitHub. It is just
the build provenance string that should participate in the image fingerprint.
Using a git commit SHA is a good default, but any stable per-build identifier
works if that better matches your release flow.

## Failure Behavior

Commands that need image fingerprints fail fast when the file is missing or
malformed. `agent-vm validate` and `agent-vm doctor` report the file path and
parse error in their check output.

## What Not To Put Here

Do not put package versions here. Runtime package versions are resolved from
the running controller and adapter packages when the image fingerprint is
computed. The identifier file should stay focused on the outer host/build
environment.
