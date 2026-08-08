# Hermes v0.20 Docker Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Hermes Agent v0.20.0 from its immutable upstream Docker release while preserving Agent VM's single-process, multi-profile gateway contract and proving two profile-scoped Discord bots in beta.

**Architecture:** The managed Hermes image recipe will use `nousresearch/hermes-agent@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e` as its base instead of reconstructing Hermes from PyPI. Agent VM will layer only its gateway runtime and Python adapter wheels, preserve its own Gondolin boot entry, mounts, and secret projection, and invoke Hermes from the upstream `/opt/hermes/.venv`. Hermes remains one process with native profile multiplexing.

**Tech Stack:** TypeScript, Vitest, Docker/OCI, Gondolin/QEMU, Python/uv, Hermes Agent v0.20.0.

## Global Constraints

- Pin Hermes v0.20.0 by immutable multi-architecture OCI digest and exact source revision `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`.
- Do not run the Hermes shell installer, resolve a moving Git branch, or recreate upstream's dependency graph.
- Do not adopt upstream s6 process supervision; Agent VM and Gondolin retain process ownership.
- Preserve one Hermes process and native named-profile multiplexing; do not port multi-process worktree machinery.
- Preserve Agent VM's `/home/hermes/.hermes` durable state contract unless runtime evidence proves that boundary invalid and the maintainer accepts a redesign.
- Never bake credentials into the image.

---

### Task 1: Immutable Hermes Runtime Base

**Files:**
- Modify: `packages/hermes-gateway/src/hermes-distribution.ts`
- Modify: `packages/hermes-gateway/src/hermes-managed-image-recipe.ts`
- Test: `packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts`

**Interfaces:**
- Produces: `HERMES_AGENT_DISTRIBUTION` identifying v0.20.0 and release commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`.
- Produces: `renderHermesManagedImageRecipe()` whose Dockerfile begins from the immutable upstream OCI index digest and installs only Agent VM-owned artifacts into the upstream runtime.

- [ ] Change the existing version/provenance assertions to require v0.20.0, the exact release commit, and the immutable upstream image digest; require the recipe not to contain `hermes-agent[messaging]`, a Hermes Git clone, or upstream installer invocation.
- [ ] Run `pnpm vitest run packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts` and confirm failure against the v0.19.0/PyPI recipe.
- [ ] Add typed upstream-image provenance to `hermes-distribution.ts` and render the smallest overlay Dockerfile: upstream `FROM` digest, Agent VM artifact installation into `/opt/hermes/.venv`, stable executable links, Agent VM-owned directories, and shell environment.
- [ ] Run the targeted test and require all assertions to pass.

### Task 2: Runtime Compatibility and Profile Contract

**Files:**
- Modify if required by observed v0.20 behavior: `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py`
- Modify if required by observed v0.20 behavior: `packages/hermes-gateway/src/hermes-lifecycle.ts`
- Test: `python/agent-vm-hermes-adapter/tests/test_managed_gateway_bootstrap.py`
- Test: `packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts`
- Test: `packages/agent-vm/src/integration-tests/hermes-discord-profile-secrets.hermes.e2e.test.ts`

**Interfaces:**
- Consumes: the upstream `/opt/hermes/.venv` and native v0.20 profile gateway.
- Preserves: Agent VM profile materialization, profile secret projections, one framework process, and existing gateway-runtime control attachment.

- [ ] Build the generated Hermes image and run immutable runtime probes for Hermes version, baked source revision, Node 26, SQLite at least 3.51.3, Discord import, and the Agent VM adapter entrypoint.
- [ ] If a probe fails, add the smallest failing automated test that captures the exact compatibility contract before changing adapter or lifecycle code.
- [ ] Make only the compatibility changes required by the failing probe; do not introduce a second process or lifecycle owner.
- [ ] Run the adapter Python tests and targeted Hermes package tests until green.
- [ ] Run `mise exec -- pnpm test:e2e:hermes` and require the no-skip evidence lane to pass.

### Task 3: Beta Multi-Profile Discord Proof

**Files:**
- Generated deployment artifacts only: `../shravan-claw-beta/vm-images/gateways/hermes/**`
- Generated dependency pins only: `../shravan-claw-beta/package.json`, `../shravan-claw-beta/pnpm-lock.yaml`
- Existing beta configuration: `../shravan-claw-beta/config/system.jsonc`
- Existing profiles: `../shravan-claw-beta/config/gateways/hermes-beta/hermes-managed/**`

**Interfaces:**
- Consumes: `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`.
- Proves: one Hermes gateway process runs the `clawfest` and `beta` profiles with distinct Discord tokens, settings, sessions, and Tool Portal authority.

- [ ] Run `pnpm check` in Agent VM and require zero errors.
- [ ] Sync the exact local package/image artifacts into beta with `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`.
- [ ] From the beta root run `mise exec -- pnpm build`, `pnpm validate`, and live MCP validation before boot.
- [ ] Start the `hermes-beta` zone and capture process/readiness evidence showing one Hermes process and both named profiles.
- [ ] Send a distinct prompt through each Discord bot and record the returned profile/agent identity, separate session state, expected Tool Portal caller authority, and absence of cross-profile delivery.
- [ ] Restart the single Hermes gateway and repeat one message per bot to prove recovery.
- [ ] Report every proof layer separately; if live Discord interaction is unavailable, stop short of claiming beta completion.
