# agent-vm

Sandboxed QEMU micro-VM controller and managed Gateway packages for autonomous coding agents.

## Rules

@.cursor/rules/ts-rules.md
@.cursor/rules/monorepo-rules.md

### Gondolin patch approval

Every Gondolin dependency patch requires Shravan's explicit approval before it
is added or changed, including rebases, expanded scope, runtime monkeypatches,
guest/helper changes, and fork adoption. Existing approval is not blanket authority
for future patches. Document each patch and its proof/distribution limits in
[Gondolin patches](docs/architecture/gondolin-patches.md).
Keep that document's upstream tracker current for every carried patch: PR URL,
pinned revision, last verified status/date, fixed release and removal gate.
Track a missing PR as not submitted; never equate merged with released or deployed.

No Gondolin patches are currently carried. Shravan approved retiring the two
PR #136 completion-promise handlers with the obsolete rootfs-transfer path on
2026-09-09. Reintroduction or any new patch requires fresh approval. The separate
experimental duplex guest patch is not approved for adoption.

## Agent Orientation

Use progressive disclosure when learning this repo:

1. Start with `README.md` for the five-minute mental model.
2. Use `docs/README.md` as the docs map.
3. Use `docs/architecture/overview.md` for the system model.
4. Use [docs/architecture/storage-model.md](docs/architecture/storage-model.md)
   before changing cache, state, workspace, work mount, or backup behavior. Its
   [Lease Path Vocabulary](docs/architecture/storage-model.md#lease-path-vocabulary)
   section is the canonical name/location/storage table.
5. Use `docs/reference/configuration/system-json.md` for Hermes managed Gateway configuration, profiles, Tool VM policy, and ingress.
6. Use subsystem docs for implementation details:
   - `docs/subsystems/controller.md` — HTTP routes, controller runtime, lease manager.
   - `docs/subsystems/gateway-lifecycle.md` — the managed Hermes `GatewayLifecycle` implementation.
   - `docs/subsystems/gondolin-vm-layer.md` — Gondolin adapter, VFS, `tcpHosts`, image build.

For gateway serving, streaming, WebSocket, or exposed webserver port work, read
`docs/subsystems/gondolin-vm-layer.md` and the `gateway.ingress` section of
`docs/reference/configuration/system-json.md` before editing. Keep the boundary
clear: `zones[].gateway.port` is the host-facing Gondolin ingress listener, and
arbitrary extra guest webservers require explicit ingress routes.

For gateway health, agent-vm controller communication, lease-heartbeat,
lease-renew, Tool VM SSH, or Gondolin `tcpHosts` timeout debugging, read
`docs/subsystems/controller.md`, `docs/subsystems/gondolin-vm-layer.md`, and
`docs/subsystems/gateway-lifecycle.md` before changing runtime behavior. Keep
the health boundaries separate: host-side agent-vm controller, gateway VM,
gateway-service process, gateway-to-controller control link, lease routes, and
gateway-to-Tool-VM SSH are different failure surfaces.

For configuration questions, start at `docs/reference/configuration/README.md`,
then drill down:

- `docs/reference/configuration/system-json.md` — host/controller config, zones, gateway config, secrets, Tool VM policy.

For package ownership, use the package map below first, then inspect the package
README/source. Keep boundaries explicit: `hermes-gateway` produces the managed
Gateway VM specification and `agent-vm` owns controller/CLI orchestration.

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
3. Update `manual-templates.unit.test.ts` and run a built-CLI `agent-vm manual update`
   smoke check when the generated output matters.

Keep manuals concise, procedural, and safe-by-default. Do not teach forbidden
command shapes as examples. Point agents toward deeper repo docs conceptually;
do not copy full architecture docs into deployment manuals.

## Repo Tooling

This is a pnpm TypeScript monorepo targeting Node 24. It uses the OXC stack for
fast formatting and linting.

- Use `mise exec -- <command>` for commands that depend on pinned local tools.
  The repo `mise.toml` pins Zig for Gondolin image builds and e2e tests.
- Install/build: `pnpm install`, then `pnpm build`.
- Test taxonomy audit: `pnpm test:taxonomy`.
  This is part of `pnpm test:unit` and `pnpm check`. It fails when test files
  use an ambiguous suffix or when a unit test crosses a real host/process
  boundary.
- Unit tests: `pnpm test:unit`.
- Integration tests: `pnpm test:integration`.
  Unit and integration Vitest projects use the `threads` pool for fast local and
  CI feedback. Do not move live VM, Hermes, 1Password, LLM, or host
  e2e lanes onto that pool without proving teardown and process isolation still
  hold.
- E2E inventory: `pnpm test:e2e:inventory`.
  This discovers e2e files with gates closed. It may report skips and is not
  proof that a VM, gateway, provider, secret resolver, or model path worked.
- Default non-secret E2E proof: `mise exec -- pnpm test:e2e`.
  This runs `pnpm build` once, then runs the host and VM/Gondolin proof lanes
  with `AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1` where a lane needs built workspace
  artifacts.
- Additional E2E proof lanes:
  - Host proofs: `pnpm test:e2e:host`.
  - Generic VM/Gondolin: `mise exec -- pnpm test:e2e:vm`.
  - VM/Gondolin HTTP mediation: `mise exec -- pnpm test:e2e:vm-mediation`.
  - Hermes gateway: `mise exec -- pnpm test:e2e:hermes`.
  - 1Password test account: `pnpm test:e2e:secrets`.
  - LLM/model roundtrip: `pnpm test:e2e:llm`.
  Proof lanes run directly through their named Vitest projects and use
  Vitest's exit status for pass/fail. `test:e2e:inventory` is the discovery
  lane and may report skipped tests by design.
- E2E VM/Hermes lanes require Docker, QEMU, and the pinned Zig from
  `mise.toml`. Use `mise exec --` for those lanes. The e2e harness uses a
  shared rebuildable image/local-package cache by default and honors
  `AGENT_VM_E2E_CACHE_DIR` when you want to pin that cache location.
  `AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1` is only for callers that already ran
  `pnpm build` and want build-once, test-many behavior.
- Secret/model e2e lanes use test-only env names:
  `AGENT_VM_LLM_E2E`, `AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN`,
  `AGENT_VM_TEST_OP_REFS`, `AGENT_VM_TEST_OP_VAULT_PREFIX`,
  `AGENT_VM_TEST_OPENAI_API_KEY`, and `AGENT_VM_TEST_ZONE_GIT_TOKEN`.
  `AGENT_VM_LLM_E2E=1` is required before the LLM/model roundtrip lane can
  run; credentials alone must not make inventory execute live model work.
  `AGENT_VM_TEST_OP_REFS` must contain only refs from the test vault prefix,
  defaulting to `op://agent-vm-testing/`. Never use personal or deployment
  1Password refs for repo tests.

### Test File Naming And Classification

The suffix is the contract. Do not use plain `*.test.ts` for new tests.

- Unit tests must use `*.unit.test.ts` or `*.unit.spec.ts`.
- Integration tests must use `*.integration.test.ts`.
- Host e2e tests must use `*.host.e2e.test.ts`.
- VM e2e tests must use `*.vm.e2e.test.ts`.
- Hermes e2e tests must use `*.hermes.e2e.test.ts`.
- 1Password e2e tests must use `*.secrets.e2e.test.ts`.
- LLM-gated e2e tests must use `*.llm.e2e.test.ts`.

Coverage must not be deleted or weakened to make a layer faster. If a slow
real-boundary test leaves a lower lane, keep the real coverage in the proper
higher lane and add or keep pure unit coverage for the underlying decision
logic.

Unit tests are process-local and deterministic. They may use mocks, stubs, fake
timers, pure temp-file serialization, and injected clocks. They must not run real
`git`, `pnpm`, `npm`, `tar`, `docker`, `qemu`, `ssh`, `op`, or shell commands;
bind real TCP/HTTP listeners; boot a controller; build packages or images; or
wait on wall-clock time for internal logic. Use fake timers or injected clocks
for retry, timeout, heartbeat, polling, and reaper behavior.

Integration tests prove boundaries between modules without expensive host
subprocess proofs: real Node/controller wiring, HTTP server wiring, temp state
dirs, temp deployment roots, built CLI/manual generation, config validation, and
lifecycle orchestration with fake VM/provider edges. They should be fast,
parallel, deterministic, and event-driven. They must not use wall-clock sleeps
for internal retry, timeout, heartbeat, polling, or reaper behavior; inject
clocks or wait on explicit events instead.

E2E tests prove production-shaped behavior from outside the system. E2E tests
should also be parallel-safe through temp roots, dynamic ports, shared build
caches, and explicit setup/teardown. If an e2e test cannot be parallel safe,
document the exact shared resource in the test and keep that exception narrow.
E2E test control flow must wait on real process, filesystem, protocol, or VM
events instead of wall-clock sleeps. A protocol timeout that rejects a hung
WebSocket/request is allowed; an `await sleep(...)` between probes is not.
When a bounded protocol retry has no event source, use a named helper such as
`waitForProtocolRetryInterval`; test files must not import
`node:timers/promises` directly.
Live e2e tests must not write deployment `config/`, `runtime/`, `state/`, or
`zone-files/` under the source checkout. Use the e2e harness scaffolds so each
deployment gets an owned OS-temp project root, and use `AGENT_VM_E2E_CACHE_DIR`
only for the shared image cache. The Vitest global setup makes this cache root
explicit for live e2e projects even when `AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1`
is set after a prior `pnpm build`.

For live gateway e2e tests, finalize the temp project and local overlay first,
then call `prepareGatewayE2eProjectImages` before starting the controller. Do
not hide VM image preparation inside controller startup, and do not call
package `prepack` from e2e overlay packing. Local overlay tarballs belong in the
shared e2e cache, not in repo `tmp`, so repeated test files reuse the exact same
package inputs. The intended loop is build once, pack with scripts disabled into
the shared cache, prepare images into the shared cache, then run the runtime
proof.

Host e2e tests are the home for expensive host-boundary proofs that do not boot
a VM but do execute production-shaped host behavior: real `git`, `tar`, `age`,
package-manager-style CLI entrypoints, shell bootstrap rendering, real
controller HTTP wiring, host process lifecycle, and other external
process behavior. These tests must keep temp roots isolated and must be
included in the default `pnpm test:e2e` proof lane so coverage is not lost when
`pnpm test:integration` stays fast.

### Testing Pyramid And Evidence Names

Name test evidence by the highest real layer it exercised. Do not relabel lower
layers as e2e.

- Unit: pure functions, reducers, schemas, config parsing, policy decisions,
  error classification, and deterministic helpers. No real controller process,
  VM, network service, provider, real host command, or wall-clock wait is
  required.
- Integration: real Node/controller wiring, HTTP routes, temp state dirs,
  lifecycle orchestration with fake or stubbed VM/provider boundaries, built
  CLI/manual generation, and config validation. These tests prove contracts
  between modules, but they are not e2e if the VM/provider/product path is
  fake.
- Host e2e: production-shaped host proofs that do not boot a VM, such as real
  Git, archive/encryption tools, package-manager-style CLI entrypoints, shell
  bootstrap rendering, real controller HTTP wiring, and host process
  lifecycle. They are higher than integration because they execute external host
  programs or production-shaped host services and are allowed to be slower.
- Real VM integration: boots the real Gondolin/QEMU path or a real managed image
  path and proves host/guest wiring, ingress, control link, runtime records, or
  Tool VM SSH with the pinned toolchain active through `mise exec --`.
- E2E: proves production-shaped behavior from the outside of the system. For
  Hermes reliability, this means a real controller, real Hermes Gateway VM,
  real adapter path, real lease/tool path when relevant, and observable user or
  operator behavior. Fake clients, fake VM factories, schema-only checks, and
  manual-template checks are useful tests, but they are not e2e evidence.

When a change claims to fix VM, Hermes Gateway, Tool VM SSH, lease lifecycle,
gateway recovery, control-link, or provider runtime behavior, the final report
must climb the pyramid explicitly:

```text
unit          -> exact command and pass/fail count
integration   -> exact command and pass/fail count
e2e host      -> exact no-skip command, pass/fail count, and host prerequisites
e2e inventory -> exact command and pass/fail/skip count, marked inventory only
e2e proof     -> exact no-skip command, pass/fail count, and prerequisites
```

If a layer cannot run, name the blocker and keep the claim scoped to the layer
that actually ran. Skipped e2e tests prove only that the inventory gate works;
they do not prove the live feature.

- Full quality gate: `pnpm check`.
  This includes the `@agent-vm/*` package version sync guard used by the
  publish script. `pnpm check` is intentionally owned by
  `scripts/run-check-gate.ts`: it runs quick independent guards in parallel,
  then runs heavier static checks in parallel with grouped logs and duration
  evidence. Keep root-level quality-gate orchestration there instead of adding
  more `&&` chains to `package.json`. Use pnpm recursive concurrency for
  package-wide scripts, not for unrelated root scripts.
- Default live VM e2e gate: `pnpm test:e2e`.
  This is intentionally owned by `scripts/run-e2e-proof-lanes.ts`: it runs one
  workspace build, then runs independent host and VM proof lanes in parallel
  with `AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1` for lanes that consume the build.
  Keep build-once/test-many orchestration there instead of adding shell `&&`
  chains to `package.json`.
- OXC formatting: `pnpm fmt:check` to verify, `pnpm fmt` to apply Oxfmt.
- OXC linting: `pnpm lint` for Oxlint, `pnpm lint:types` for type-aware Oxlint.
- Typecheck: `pnpm typecheck`.
- Local npm publish must use the release-specific 1Password item:
  `set -a; source .env.local; set +a; AGENT_VM_NPM_TOKEN_OP_REF='op://agent-vm/npm-token-agent-vm-publish/credential' scripts/publish-local.sh`.
  The script defaults to that same item, reads the token through 1Password,
  writes it only to a temporary npm user config, builds the workspace once, and
  runs `pnpm -r publish` with package lifecycle scripts disabled so per-package
  `prepack` cannot rebuild the full workspace repeatedly.
  Do this before trying browser `npm login` or assuming npm auth is blocked.
  If 1Password times out, verify the same item with
  `op read 'op://agent-vm/npm-token-agent-vm-publish/credential' >/dev/null`
  and rerun the exact publish command above. Verify publication with
  `npm view <package> version` for every `@agent-vm/*` package before saying a
  release is published.

Prefer targeted commands while iterating, then run the broad gate before
claiming done. Do not use `npm` or `yarn` in this repo.

For CLI, scaffold, default-value, and generated-config changes, add a local
black-box integration/e2e test in a temporary directory. Exercise the actual
command a user would run, inspect the generated files, and run the relevant
validation command against that generated output before claiming the default is
safe.

## MCP Portal Fast Loop

Keep managed Tool Portal config separate from standalone MCP Portal config.
Both modes use `mcp.config.jsonc` for upstream MCP providers, transports,
egress, and secrets.

- Managed Gateway mode authors `tool-portal.config.jsonc` for agent profile
  assignments and complete cross-backend capability policies. Every capability
  declares `backend.kind`; managed config uses `capabilities`, not standalone
  MCP Portal `namespaces`.
- Standalone/external MCP Portal mode authors `mcp-portal.config.jsonc` for MCP
  namespace policy, bearer credentials, HMAC approval tokens, `externalAuth`,
  and `mcpProxy`. Managed Gateway mode never loads that file as policy authority.

In both policy files, a profile is complete: there is no profile inheritance or
merge with a default profile.

Use targeted config tests first:

- Shared MCP provider config: `pnpm vitest run packages/config-contracts/src/mcp-config.unit.test.ts`.
- Managed Tool Portal config: `pnpm vitest run packages/config-contracts/src/tool-portal-config.unit.test.ts`.
- Standalone MCP Portal config: `pnpm vitest run packages/config-contracts/src/mcp-portal-config.unit.test.ts`.
- Portal tool result shapes: `pnpm vitest run packages/mcp-portal/src/core/portal-tools.unit.test.ts`.
- Live validation behavior: `pnpm vitest run packages/agent-vm/src/operations/config-validation.integration.test.ts`.

When testing a deployment, run static validation before boot work, then live MCP
validation after provider/profile edits:

- `pnpm validate`
- `pnpm exec agent-vm validate --config config/system.jsonc --mcp-live`

Managed live validation follows only Tool Portal capabilities whose
`backend.kind` is `mcp_provider`; it does not validate controller-host-action or
Tool VM runner capabilities as MCP namespaces.

If any managed `calls.requiresApproval` selector effectively admits a tool, the
zone must declare `approvalAccess`. Static validation and gateway preflight fail
closed when it is absent; there is no approval-access default.

For tight beta iteration before publishing, pack local tarballs from this repo
and install them into the deployment with `pnpm add --force` or the deployment's
existing package-update helper. Verify the installed package source afterward;
do not leave beta pinned to stale local tarballs when the intent is to test a
published registry version.

## Testing Worktree Changes In Beta

For beta validation, use `pnpm dev:sync-tarballs -- --deployment
../shravan-claw-beta`. It builds once, packs local `@agent-vm/*` tarballs,
updates beta's host dependency pins, runs `pnpm install` in beta, and refreshes
the Hermes Gateway and Tool VM overlay artifacts. Then run beta's normal
`mise exec -- pnpm build` and `pnpm start` commands.

## Release Process

Keep every published `@agent-vm/*` package version in sync for normal releases.
Create the release PR with `pnpm release:version -- <version>` so all npm and
Python manifests, the Hermes adapter SDK pin, `pnpm-lock.yaml`, and `uv.lock`
move together. `pnpm check` and both publishing paths fail when package versions
drift.
If any package version has already been published incorrectly, do not try to
reuse that version. Bump the whole package set to a fresh patch version and
publish all packages together.

After a release PR merges, `.github/workflows/release.yml` waits for the exact
`master` CI commit to pass, publishes missing npm and PyPI artifacts through
GitHub OIDC, verifies the complete registry train, then creates the tag and
GitHub release in a separate contents-write job. Rerun the same failed workflow
to recover a partial cross-registry publication; never reuse the version from a
different commit.

Trusted publishing is external registry state. Every npm package must trust the
`release.yml` workflow, configured with
`npm trust github <package> --file release.yml --repo ShravanSunder/agent-vm --allow-publish --yes`.
Both PyPI projects must name the same owner, repository, and workflow. Configure
those relationships before the first OIDC release. `scripts/publish-local.sh`
remains the break-glass publisher and retains the release-specific 1Password
path described above.

Managed image release pins are a separate release train from npm package
versions. Do not change `packages/agent-vm/managed-images.json` base image tags
just to match npm versions. Keep that manifest focused on managed base image
metadata such as GHCR tags; do not add `@agent-vm/*` npm package pins to it.
The Hermes upstream distribution pin is
owned by `@agent-vm/hermes-gateway`, not this manifest, and must not change
without explicit maintainer permission and qualification.

Before publishing, pack and inspect `@agent-vm/agent-vm` from the exact commit
that will be released. Confirm the packed `package/package.json` has sibling
`@agent-vm/*` dependencies on the intended version. Confirm packed
`package/managed-images.json` has the intended managed image tags and no npm
package version pins. Confirm the packed `@agent-vm/hermes-gateway` artifact
retains the intended immutable Hermes distribution inputs.

Because there is no separate user-authored image cache identifier, VM image
fingerprints rely on image recipe contents plus the package/runtime version
inputs. Cache-contract changes must ship with a package version bump for the
full `@agent-vm/*` set.

For break-glass local publishing, publish only after the release PR is merged
and local `master` is fast-forwarded to `origin/master`. After either publishing
path, verify every npm and Python artifact and inspect the published
`@agent-vm/agent-vm` tarball before calling the release done.

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
secret-management        → SecretRef/SecretResolver contracts, env + 1Password resolution
managed-vm               → Backend-neutral VM capabilities and structural contracts
gateway-lifecycle        → managed GatewayLifecycle and VM requirements (→ managed-vm)
gondolin-vm-adapter      → Gondolin provider and image tooling (→ managed-vm, Gondolin SDK)
hermes-gateway           → Hermes lifecycle and managed image recipe (→ gateway-lifecycle, managed-vm)
agent-vm                 → Controller CLI + HTTP server; composes the selected provider
```

Hermes itself is an upstream Docker image, not a library dependency. Agent VM
overlays its own `hermes-gateway` and Python adapter components into that
managed image; do not model upstream Hermes as an npm or Python library.

`agent-vm` has a regular runtime dependency on `gondolin-vm-adapter`, but only
`packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts` and
`packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts` may import
it. Controller domains, Gateway and Tool VM orchestration, leases, health, and
recovery consume narrow `managed-vm` capabilities. Do not expose native
Gondolin handles, filesystem objects, or `getVmInstance()` across that boundary.

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
managed-Gateway caller path in `POST /lease`; `hostWorkMountDir` is the
controller-validated host path; Tool VMs always see the selected mount at
`/work`.

## Controller API

- `GET /health` — readiness
- `GET /zones/:zoneId/health` — live managed Gateway health probe
- `POST /zones/:zoneId/credentialed-runtime/retire` — retire the authenticated agent's singleton credentialed Managed runtime using existing zone admin authorization

## Key Files

- `packages/agent-vm/src/controller/controller-runtime.ts` — startup, gateway type dispatch
- `packages/agent-vm/src/controller/workspace-git/workspace-git-operations.ts` — controller-owned managed workspace Git

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
2. The controller generates protected managed Gateway inputs before boot.
   Hermes Tool VMs mount the controller-selected agent workspace at `/workspace`
   and use disposable `/work` as the default command directory.
3. Gondolin runtime puts a placeholder in the VM env at boot; the proxy swaps it
   for the real token only on outbound calls to allowed hosts.

Runtime paths and authorization inputs are generated by the controller as
protected managed Gateway material. Hermes durable framework state lives under
`/home/hermes/.hermes`. Gateway images must stay
redistributable without secret pinning.
