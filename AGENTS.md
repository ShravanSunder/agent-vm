# agent-vm

Sandboxed QEMU micro-VM controller and worker packages for autonomous coding agents.

## Rules

@.cursor/rules/ts-rules.md
@.cursor/rules/monorepo-rules.md

## Agent Orientation

Use progressive disclosure when learning this repo:

1. Start with `README.md` for the five-minute mental model.
2. Use `docs/README.md` as the docs map.
3. Use `docs/architecture/overview.md` for the system model.
4. Use [docs/architecture/storage-model.md](docs/architecture/storage-model.md)
   before changing cache, state, workspace, work mount, or backup behavior. Its
   [Lease Path Vocabulary](docs/architecture/storage-model.md#lease-path-vocabulary)
   section is the canonical name/location/storage table.
5. Use mode-specific gateway docs only when needed:
   - `docs/architecture/agent-worker-gateway.md` — Agent Worker Gateway, in-VM pipeline, event log, executors.
   - `docs/architecture/openclaw-gateway.md` — OpenClaw Gateway, long-running gateway VM, tool VM leases.
6. Use subsystem docs for implementation details:
   - `docs/subsystems/controller.md` — HTTP routes, controller runtime, lease manager.
   - `docs/subsystems/gateway-lifecycle.md` — `GatewayLifecycle`, Agent Worker Gateway vs OpenClaw Gateway implementations.
   - `docs/subsystems/gondolin-vm-layer.md` — Gondolin adapter, VFS, `tcpHosts`, image build.
   - `docs/subsystems/worker-task-pipeline.md` — host-side Agent Worker task lifecycle, repo resources, teardown.

For configuration questions, start at `docs/reference/configuration/README.md`,
then drill down:

- `docs/reference/configuration/system-json.md` — host/controller config, zones, gateway config, secrets, resource policy.
- `docs/reference/configuration/worker-json.md` — Agent Worker Gateway phases, prompts, verification, MCP servers.
- `docs/reference/configuration/project-config-json.md` — repo-local `.agent-vm/config.json` overrides.
- `docs/reference/configuration/resource-contracts.md` — `.agent-vm/` repo resources and task external resources.
- `docs/reference/configuration/prompt-files.md` — prompt file references and resolution.

For package ownership, use the package map below first, then inspect the package
README/source. Keep boundaries explicit: gateway packages produce VM/process
specs; `agent-vm` owns controller/CLI orchestration; `agent-vm-worker` owns the
in-VM task loop.

## Docs And Manuals

Repo docs under `docs/**` are the maintainer source of truth. Generated
deployment manuals are not rendered from `docs/**`; they come from
`packages/agent-vm/src/cli/manual-templates.ts` and are written into user repos
as `docs/manual/**` by `agent-vm manual update`.

Treat generated manuals as agent operating contracts for helping end users set
up and operate agent-vm deployments. Humans direct the agents; agents read the
manuals before touching deployment config or runtime systems.
When changing behavior that deployment agents need to know, update both layers
with progressive disclosure:

1. Update the canonical repo doc that explains the system or subsystem.
2. Update the generated manual template with the short operational guidance.
3. Update `manual-templates.test.ts` and run a built-CLI `agent-vm manual update`
   smoke check when the generated output matters.

Keep manuals concise, procedural, and safe-by-default. Do not teach forbidden
command shapes as examples. Point agents toward deeper repo docs conceptually;
do not copy full architecture docs into deployment manuals.

## Repo Tooling

This is a pnpm TypeScript monorepo targeting Node 24. It uses the OXC stack for
fast formatting and linting.

- Use `mise exec -- <command>` for commands that depend on pinned local tools.
  The repo `mise.toml` pins Zig for Gondolin image builds and smoke tests.
- Install/build: `pnpm install`, then `pnpm build`.
- Unit tests: `pnpm test:unit`.
- Integration tests: `pnpm test:integration`.
- Smoke tests: `pnpm test:smoke`.
- Full quality gate: `pnpm check`.
  This includes the `@agent-vm/*` package version sync guard used by the
  publish script.
- OXC formatting: `pnpm fmt:check` to verify, `pnpm fmt` to apply Oxfmt.
- OXC linting: `pnpm lint` for Oxlint, `pnpm lint:types` for type-aware Oxlint.
- Typecheck: `pnpm typecheck`.
- Local npm publish: `set -a; source .env.local; set +a; scripts/publish-local.sh`.
  This script reads the npm token from
  `op://agent-vm/npm-token/credential` through 1Password,
  writes it only to a temporary npm user config, and runs `pnpm -r publish`.
  Do this before trying browser `npm login` or assuming npm auth is blocked.
  Verify publication with `npm view <package> version` for every
  `@agent-vm/*` package before saying a release is published.

Prefer targeted commands while iterating, then run the broad gate before
claiming done. Do not use `npm` or `yarn` in this repo.

For CLI, scaffold, default-value, and generated-config changes, add a local
black-box smoke test in a temporary directory. Exercise the actual command a
user would run, inspect the generated files, and run the relevant validation
command against that generated output before claiming the default is safe.

## Release Process

Keep every published `@agent-vm/*` package version in sync for normal releases.
`pnpm check` and `scripts/publish-local.sh` both fail when package versions
drift.
If any package version has already been published incorrectly, do not try to
reuse that version. Bump the whole package set to a fresh patch version and
publish all packages together.

Managed image release pins are a separate release train from npm package
versions. Do not change `packages/agent-vm/managed-images.json` base image tags
just to match npm versions. Keep that manifest focused on managed base image
metadata such as GHCR tags and the OpenClaw upstream version; do not add
`@agent-vm/*` npm package pins to it.

Before publishing, pack and inspect `@agent-vm/agent-vm` from the exact commit
that will be released. Confirm the packed `package/package.json` has sibling
`@agent-vm/*` dependencies on the intended version. Confirm packed
`package/managed-images.json` has the intended managed image tags and no npm
package version pins. Generated OpenClaw gateway Dockerfiles derive the
`@agent-vm/openclaw-agent-vm-plugin` install spec from the installed package
metadata.

Because there is no separate user-authored image cache identifier, VM image
fingerprints rely on image recipe contents plus the package/runtime version
inputs. Cache-contract changes must ship with a package version bump for the
full `@agent-vm/*` set.

Publish only after the release PR is merged and local `master` is
fast-forwarded to `origin/master`. After publishing, verify with `npm view` for
every package and inspect the published `@agent-vm/agent-vm` tarball before
calling the release done.

## Security Invariants

`agent-vm controller ssh` is an interactive admin shell only. Do not add support
for `controller ssh -- <remote command>`, `--print`, or any other mode that
turns the SSH command into an exposed remote-command runner. Admin convenience
belongs in explicit, protected flows such as `auth-interactive` or
`controller ssh --with-secrets`, where the operator gets an interactive shell and
the controller still resolves zone admin access first.

The HTTP `/zones/:zoneId/execute-command` route is a separate controller
operation for internal/admin workflows and must remain protected by zone admin
authorization when `adminAccess` is configured. Do not re-expose that capability
through the public SSH CLI surface.

## TypeScript Standards

Follow `.cursor/rules/ts-rules.md`; key points:

- No `any`; use explicit, narrow types or generics.
- Prefer `satisfies` over `as` casts.
- Explicit parameter and return types.
- Use discriminated unions for variants.
- Use `readonly` for immutable arrays/properties.
- Use descriptive multi-word file and folder names.
- Use tabs and Oxfmt formatting.
- Keep Zod schemas and inferred types in sync; derive schema variants with Zod helpers.
- Use direct async filesystem imports from `node:fs/promises` for all new code
  and tests. Do not introduce `fs.promises` or `fs.*Sync` calls.

## Packages

```text
gondolin-adapter          → VM build pipeline, adapter, secret resolver (no internal deps)
gateway-interface         → Types: GatewayLifecycle, VmSpec, ProcessSpec (→ gondolin-adapter)
openclaw-gateway          → OpenClaw lifecycle (→ gateway-interface, gondolin-adapter)
worker-gateway            → Worker lifecycle (→ gateway-interface, gondolin-adapter)
openclaw-agent-vm-plugin  → OpenClaw sandbox backend (→ gondolin-adapter)
agent-vm-worker           → Worker process, runs inside VM (standalone)
agent-vm                  → Controller CLI + HTTP server (→ all above)
```

## Layout

`config/` holds `system.json`, gateway config, and prompts.

`vm-images/` holds Gondolin VM image recipes.

`vm-host-system/` is optional boot plumbing for a generic container host that
runs Docker, QEMU, Zig, and the controller.

Storage boundaries are load-bearing. Durable zone state belongs in `stateDir`
and is included in encrypted backups. Rebuildable artifacts belong in
`cacheDir` and must not be made backup state just to survive a copy-on-write VM
reboot. See `docs/architecture/storage-model.md` before moving generated files
between repo config, state, cache, workspace, or backup directories.

Lease path vocabulary is intentionally layered; see
[Lease Path Vocabulary](docs/architecture/storage-model.md#lease-path-vocabulary)
before renaming or threading these fields. `workMountDir` is the untrusted
OpenClaw gateway path in `POST /lease`; `hostWorkMountDir` is the
controller-validated host path; Tool VMs always see the selected mount at
`/work`. OpenClaw SDK `workspaceDir` exists only at the plugin boundary and
must be translated immediately to controller `workMountDir`.

## Controller API

- `GET /health` — readiness
- `GET /zones/:zoneId/health` — live OpenClaw gateway health probe
- `POST /zones/:zoneId/worker-tasks` — start worker task, returns `202 { taskId, status: "accepted" }`
- `GET /zones/:zoneId/tasks/:taskId` — replayed worker task state snapshot
- `POST /zones/:zoneId/tasks/:taskId/push-branches` — controller-side git push
- `POST /zones/:zoneId/tasks/:taskId/pull-default` — controller-side default/current branch refresh
- `POST /zones/:zoneId/tasks/:taskId/close` — request task cancellation

`pull-default` returns a discriminated result. `kind: "advanced"` means the
default branch ref was updated; `kind: "refused-not-fast-forward"` means the
controller refused to rewrite an unsafe default branch; `kind: "failed"` means
transport, auth, or git plumbing failed. For current branch refresh, read
`currentBranchSync.status`: `fast-forwarded` means the agent branch and worktree
moved, `up-to-date` means no branch change, `ahead` usually means push,
`diverged` needs a merge/rebase plan, `dirty-worktree` needs commit/stash first,
`no-upstream` needs an upstream push, `detached` needs a branch, and
`default-branch` means the current branch was the protected/default branch.

## Key Files

- `packages/agent-vm/src/controller/controller-runtime.ts` — startup, gateway type dispatch
- `packages/agent-vm/src/controller/worker-task-runner.ts` — per-task VM lifecycle
- `packages/agent-vm/src/controller/git-push-operations.ts` — host-side push
- `packages/agent-vm-worker/src/coordinator/coordinator.ts` — worker loop
- `packages/agent-vm-worker/src/config/worker-config.ts` — worker config schema
- `packages/worker-gateway/src/worker-lifecycle.ts` — VM spec + process spec

## Secrets

Zone secrets: `source: "1password"` (op:// ref) or `source: "environment"`
(env var). Injection is either `"http-mediation"` (proxy layer, VM never sees
the raw value) or `"env"` (VM environment variable). `host.githubToken` is
controller-only for git operations and never enters the VM.

## Gateway Image Security Boundary

Do not bake auth tokens or credential material into gateway images. Runtime
auth must flow through controller HTTP mediation. Keep token env names,
registry auth files, and build args out of every generated gateway Dockerfile
so a future edit cannot accidentally turn a runtime secret into image state.

Forbidden in gateway Dockerfiles:

- `ARG`, `ENV`, or `RUN` referencing token names, even with escaped `${VAR}`
- writing or copying `.npmrc`, `.docker/config.json`, `.netrc`, or auth files
- `_authToken`, `_password`, or `_secret` literal substrings

Allowed runtime auth path:

1. `system.json` declares the secret with `injection: "http-mediation"` and the
   allowed `hosts`.
2. `system.json` declares `runtimeAuthHints` for service tokens the agent should
   know about.
3. The controller generates `runtimeInstructions` and the agent-facing
   `/agent-vm/agents.md` runtime index at task boot. Worker repo docs live at
   `/work/repos/AGENTS.md` with a `CLAUDE.md` symlink for Claude-compatible
   discovery. OpenClaw Tool VMs mount the validated lease work mount at `/work`.
4. Gondolin runtime puts a placeholder in the VM env at boot; the proxy swaps it
   for the real token only on outbound calls to allowed hosts.

Common prompt defaults live in `common-agent-instructions.md`. Runtime
paths/auth/resources are generated by the controller into `runtimeInstructions`
and `/agent-vm/agents.md`. `/state` is mounted in the VM for worker/controller
plumbing, not as the primary agent documentation surface. Gateway images must
stay redistributable without secret pinning.
