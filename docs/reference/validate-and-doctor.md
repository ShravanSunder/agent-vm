# Validate and Doctor

`validate` and `doctor` answer different questions.

## validate

Question: are these files coherent?

`validate` is static. It should run from a repo checkout, CI, or a generated
scaffold directory without requiring the target runtime host.

```bash
agent-vm validate --config config/system.json
```

It checks:

- `system.json` schema and cross-field validation.
- `systemCacheIdentifier.json` exists and is valid JSON.
- Gateway and tool VM image recipe files exist.
- Worker gateway configs load successfully.
- Worker prompt file references exist and stay under `prompts/`.
- OpenClaw gateway configs pass `openclaw config validate --json` for
  OpenClaw zones.
- Container runtime paths like `/etc/agent-vm/...` map back to checkout files
  when `system.json` lives under a scaffold `config/` directory.
- `vm-host-system/` exists when the identifier says
  `hostSystemType: "container"`.

Use `validate` after editing config, prompts, scaffold files, or image recipe
paths.

## doctor

Question: can this machine run this config now?

`doctor` is runtime readiness. It checks the current host, not just the files.

```bash
agent-vm doctor --config config/system.json
```

It checks:

- Node.js version.
- QEMU availability.
- Controller and gateway ports.
- Disk and memory budget.
- Configured 1Password token source, if the config uses one.
- OpenClaw CLI availability for OpenClaw zones.
- OpenClaw gateway configs pass the catalog's own OpenClaw CLI validation.
- `systemCacheIdentifier.json`.
- Worker configs using the paths as the current host sees them.
- `vm-host-system/` files for container configs.

`doctor` does not treat age or 1Password CLI as universal requirements. They
are only relevant to flows that use them:

- 1Password CLI is required only for `tokenSource.type: "op-cli"`.
- macOS Keychain access is required only for `tokenSource.type: "keychain"`.
- age is used by encrypted backup/local key generation flows, not by every
  Worker runtime.

For 1Password-backed local configs, doctor verifies that the configured access
method is available on the current host. It does not resolve every secret
during the offline prerequisite check.

For OpenClaw-backed local configs, keep OpenClaw loosely coupled by installing
it in the catalog rather than inside `@agent-vm/agent-vm`:

```bash
pnpm add -D openclaw@2026.4.24
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
agent-vm validate --config config/system.json
```

Inside the container host:

```bash
agent-vm doctor --config /etc/agent-vm/system.json
```

Container-host scaffolds intentionally use paths such as
`/etc/agent-vm/gateways/coding-agent/worker.json`. `validate` understands how
to map those back to local scaffold files. `doctor` does not pretend the
current Mac is the container host; it should fail when runtime paths do not
exist on the current machine.

## Local Scaffold Example

```bash
agent-vm init coding-agent --type worker --preset macos-local
agent-vm validate --config config/system.json
agent-vm doctor --config config/system.json
```

For a local scaffold, validate and doctor usually run from the same checkout
because the generated paths are local relative paths.
