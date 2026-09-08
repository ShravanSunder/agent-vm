# Validate and Doctor

`validate` and `doctor` answer different questions.

## validate

Question: are these files coherent?

`validate` is static. It should run from a repo checkout, CI, or a generated
scaffold directory without requiring the target runtime host.

```bash
agent-vm validate --config config/system.jsonc
```

It checks:

- `system.jsonc` / `system.json` schema and cross-field validation.
- Removed config fields fail at schema load time. Delete stale raw WebSocket
  TCP passthrough config and declare native `websocketUpgrades` plus matching
  `egressHosts` instead.
- Gateway and tool VM image recipe files exist.
- Hermes Tool VM profile mappings reference existing `toolVmProfiles`.
- Schema load rejects Hermes Tool VM-reaching mediated secrets unless they
  declare `agentAccess: "all"` or a non-empty list of declared zone agents, and
  the zone declares at least one agent.
- Hermes declared agents, unique profile assignments, profile-secret
  projections, Tool Portal assignments, and Tool VM policy stay aligned.
- Profile environment targets and loaded Tool VM mediated secret access entries
  are visible as named inventory checks.
- Worker gateway configs load successfully.
- Worker prompt file references exist and stay under `prompts/`.
- Hermes configuration passes the managed Hermes configuration loader.
- MCP Portal config shape, profile references, provider materialization, stdio
  network declarations, mediated hosts, and raw-env exceptions are coherent.
- Container runtime paths like `/etc/agent-vm/...` map back to checkout files
  when `system.jsonc` or `system.json` lives under a scaffold `config/` directory.
- `vm-host-system/` is complete when present in a checked-out container
  runtime layout.

Use `validate` after editing config, prompts, scaffold files, or image recipe
paths.

For Discord and other WebSocket channels, `validate` owns static policy shape:
the broad destination belongs in `egressHosts`, and the native upgrade policy
belongs in `websocketUpgrades`. Runtime raw TCP slots are internal VM plumbing;
deployment configs should not carry a raw WebSocket TCP passthrough field.

Use `agent-vm validate --config config/system.jsonc --mcp-live` after changing
MCP providers, provider secrets, or MCP Portal profile tool names. The live MCP
pass resolves configured secrets, starts each referenced provider, runs
`tools/list`, checks discovered tool input schemas can build validators, and
reports namespace, transport, phase, and hints for provider failures. A
referenced namespace may still be reported as `unavailable` for operator
diagnostics, but it fails validation proof. That live upstream proof belongs to
`validate --mcp-live`, not `doctor`.

## doctor

Question: can this machine run this config now?

`doctor` is runtime readiness. It checks the current host, not just the files.

```bash
agent-vm doctor --config config/system.jsonc
```

It checks:

- Node.js version.
- QEMU availability.
- Controller and gateway ports.
- Disk and memory budget.
- Configured 1Password token source, if the config uses one.
- 1Password CLI service-account fallback readiness for 1Password-backed
  configs, using `op whoami` under an isolated service-account environment.
- Hermes managed image inputs and configuration availability for Hermes zones.
- Hermes Tool Portal adapter material, native approval presenter capability,
  Tool VM profile mappings, profile assignments, profile-secret projections,
  and loaded Tool VM mediated secret access entries are visible as named
  inventory checks.
- Hermes Tool VM deployment requirements use the same finding IDs as
  `validate`, so a config that would fail startup is visible before boot.
- Worker configs using the paths as the current host sees them.
- `vm-host-system/` files when present in a checked-out container runtime
  layout, or runtime host files when running from `/etc/agent-vm/system.json`.

`doctor` does not treat age, 1Password CLI, or macOS Keychain as universal
requirements. They are only relevant to flows that use them:

- 1Password CLI is required for the SDK-fallback/headless recovery probe when a
  config uses 1Password secrets.
- macOS Keychain access is required only for `tokenSource.type: "keychain"`.
- age is used by encrypted backup/local key generation flows, not by every
  Worker runtime.

For 1Password-backed local configs, doctor verifies that the configured access
method is available on the current host. It also verifies that `op whoami`
reports `SERVICE_ACCOUNT` when run with only the resolved service-account token,
an isolated `OP_CONFIG_DIR`, `OP_BIOMETRIC_UNLOCK_ENABLED=false`, and
`OP_CACHE=false`. This check does not resolve deployment secret refs and redacts
child-process stdout/stderr on failure.

`tokenSource.type: "op-cli"` is not supported for controller startup or recovery
because it must use ambient `op read` authentication to fetch the service-account
token before service-account auth exists. Use `tokenSource.type: "env"` or
`"keychain"` for unattended controller startup and recovery.

## Hard Cutover From A Pre-Hermes-Only Release

The cutover has no compatibility parser or state migration. Perform predecessor
termination with the old release while its configuration and runtime records
are still valid:

1. Keep the pre-cutover binaries and configuration installed.
2. Stop the controller-managed legacy Gateway through the old release's normal
   protected shutdown path. If that controller is unavailable, use that same
   old release's scoped offline-cleanup command.
3. Verify its Gateway and Tool VM runtime records are cleared, exact managed
   processes are absent, leases are released, and the ingress port is no longer
   owned.
4. Only after that proof, replace the package train and generated contracts as
   one unit.
5. Author a new valid Hermes or Worker configuration, then run `validate` and
   `doctor` before startup.

The Hermes-only release rejects legacy configuration and does not interpret,
migrate, rewrite, or delete operator-owned legacy framework data. Rollback means
restoring the complete older binaries/contracts/configuration set, not mixing
old and new controller or Gateway components.

## Container Runtime Example

From a scaffold or checked-out container runtime layout:

```bash
agent-vm validate --config config/system.jsonc
```

Inside the container host:

```bash
agent-vm doctor --config /etc/agent-vm/system.jsonc
```

Container-host scaffolds intentionally use paths such as
`/etc/agent-vm/gateways/coding-agent/worker.jsonc`. `validate` understands how
to map those back to local scaffold files. `doctor` does not pretend the
current Mac is the container host; it should fail when runtime paths do not
exist on the current machine.

## Local Scaffold Example

```bash
agent-vm init coding-agent --type worker --preset macos-local
# or: agent-vm init coding-agent --type hermes --preset macos-local
agent-vm validate --config config/system.jsonc
agent-vm doctor --config config/system.jsonc
```

For a local scaffold, validate and doctor usually run from the same checkout
because the generated paths are local relative paths.

## Image Cache Cleanup

`agent-vm build` publishes complete VM-image fingerprints atomically into the
shared image cache. It does not prune or replace complete fingerprints.

`agent-vm cache clean --confirm` is an explicit deployment-scoped cleanup
command. It acquires the same ownership lock as the controller, refuses while
that controller is active, and deletes only the invoking deployment's Docker
contexts and zone framework caches. Shared VM images, generated image
selections, sibling deployment scopes, and durable/runtime roots are preserved.

Cleanup requires Python 3 with symlink-resistant filesystem operations. Each
target is opened without following symlinks in any path component; recursive
deletion stays anchored to that opened directory in an isolated subprocess.
Ancestor symlink substitutions cannot redirect deletion. Unsupported hosts or
changed targets fail closed rather than falling back to path-based recursion.
