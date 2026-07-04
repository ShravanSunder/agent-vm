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
- OpenClaw Tool VM profile mappings reference existing `toolVmProfiles`.
- Schema load rejects OpenClaw Tool VM-reaching mediated secrets unless they
  declare `agentAccess: "all"` or a non-empty list of declared zone agents, and
  the zone declares at least one agent.
- OpenClaw Tool VM deployment requirements are enforced for OpenClaw zones:
  `agents.*.sandbox.backend: "gondolin"`, `mode: "all"`, `scope: "agent"`,
  `workspaceAccess: "rw"`, and a non-root agent workspace.
- Per-agent auth profiles, sandbox seeds, and loaded Tool VM mediated secret
  access entries are visible as named inventory checks.
- Worker gateway configs load successfully.
- Worker prompt file references exist and stay under `prompts/`.
- OpenClaw gateway configs pass `openclaw config validate --json` for
  OpenClaw zones.
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
pass resolves configured secrets, starts each provider, runs `tools/list`, and
reports namespace, transport, phase, and hints for provider failures. That
live upstream proof belongs to `validate --mcp-live`, not `doctor`.

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
- OpenClaw CLI availability for OpenClaw zones.
- OpenClaw gateway configs pass the catalog's own OpenClaw CLI validation.
- OpenClaw Tool Portal native tool wiring through the `gondolin` plugin and
  plugin approval routing for OpenClaw zones.
- OpenClaw Tool VM profile mappings, per-agent auth profile entries, sandbox
  seed entries, and loaded Tool VM mediated secret access entries are visible as
  named inventory checks.
- OpenClaw Tool VM deployment requirements use the same finding IDs as
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

For OpenClaw-backed local configs, keep OpenClaw loosely coupled by installing
it in the catalog rather than inside `@agent-vm/agent-vm`:

```bash
pnpm add -D openclaw@2026.6.8
```

When you run `pnpm doctor`, pnpm places `node_modules/.bin` on `PATH`, so
doctor validates `config/gateways/*/openclaw.json` with that catalog-pinned
OpenClaw version. The generated OpenClaw config intentionally contains
VM-internal plugin paths such as `/home/openclaw/.openclaw/extensions`; host
validation ignores that host-only plugin path existence failure while still
failing schema, model, channel, and other config issues.

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
agent-vm validate --config config/system.jsonc
agent-vm doctor --config config/system.jsonc
```

For a local scaffold, validate and doctor usually run from the same checkout
because the generated paths are local relative paths.

## Image Cache Cleanup

`agent-vm build` performs a retention prune after successful builds. For each
gateway or Tool VM image profile, it keeps the current fingerprint plus the two
newest previous generations. Failed builds do not prune cache entries.

`agent-vm cache clean --confirm` is an explicit manual cleanup command. It
deletes every stale image generation that is not the current fingerprint, so it
is more aggressive than the automatic build cleanup.
