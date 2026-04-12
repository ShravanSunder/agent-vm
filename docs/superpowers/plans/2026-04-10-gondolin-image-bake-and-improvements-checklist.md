# Gondolin Image Bake And Improvements Execution Checklist

Source plan:
`/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/superpowers/plans/2026-04-10-gondolin-image-bake-and-improvements.md`

This checklist captures the spec, the clarified scope we agreed on during execution, and the current audit result against the implemented code.

## Outcome Checklist

- [x] Gateway image bakes CA trust, `/dev/fd`, plugin files, and required directories into `postBuild`
- [x] Tool image bakes CA trust and `/dev/fd` into `postBuild`
- [x] `system.json` no longer carries dead `images.*.postBuild` config
- [x] Build fingerprint coverage includes `postBuild` changes
- [x] Gateway runtime setup only writes zone-specific environment profile
- [x] Gateway plugin source VFS mount is removed from runtime VM creation
- [x] `scripts/build-images.sh` exists and primes the runtime cache paths the controller actually reads
- [x] `.env.example` exists with default `*_REF` entries
- [x] Secret refs can come from `.env.local` via `${SECRET_NAME}_REF`
- [x] CLI loads `.env.local` at startup
- [x] `system.json` uses structural secret config without inline 1Password refs
- [x] `agent-vm init <zone>` scaffolds a runnable project skeleton
- [x] `agent-vm controller ssh-cmd` supports interactive mode and `--print`
- [x] Gateway checkpoint path infrastructure exists outside VFS-mounted `stateDir`
- [x] Gateway checkpoint encryption helpers exist
- [x] `ManagedVm` exposes `getVmInstance()` for future checkpoint work
- [x] `docs/SETUP.md` exists in `agent-vm`
- [x] `shravan-claw` architecture docs reflect baked images, env refs, and checkpoint infrastructure
- [x] `shravan-claw` secrets docs reflect env-backed refs and checkpoint encryption

## Clarified Scope

- [x] Checkpoint resume wiring is intentionally not implemented in this spec execution
  - Follow-up work remains to connect Gondolin `VmCheckpoint.load().resume()` into the gateway boot path
- [x] No fake public checkpoint resume API was shipped
  - We implemented `getVmInstance()` and the gateway checkpoint path/encryption infrastructure only
- [x] The plan’s older file-table mention of `checkpoint-adapter.ts` was treated as stale after clarification
  - The executed scope was the narrowed Task 9 we agreed on: prep the VM surface, do not ship a throwing resume adapter

## Phase Checklist

### Phase A: Image Baking

- [x] Task 1: gateway `build-config.json` includes `postBuild.copy` and `postBuild.commands`
- [x] Task 2: tool `build-config.json` includes `postBuild.commands`
- [x] Task 3: dead `postBuild` fields removed from `system-config.ts` and `system.json`
- [x] Task 4: build fingerprint test covers `postBuild`
- [x] Task 5: runtime CA update and plugin copy stripped from gateway setup
- [x] Task 6: image build script created and executable

### Phase B: .env Secret Refs

- [x] Task 7: `.env.example` created
- [x] Task 8: optional `ref`, env fallback resolution, CLI env loading, `system.json` migration

### Phase C: Checkpoint Infrastructure

- [x] Task 9: `ManagedVm.getVmInstance()` added and tested
- [x] Task 10: `gateway-checkpoint-manager.ts` path resolution and existence checks added

### Phase D: CLI Init

- [x] Task 11: `agent-vm init` implemented and tested

### Phase E: SSH UX

- [x] Task 12: interactive `ssh-cmd` implemented and tested

### Phase F: Checkpoint Encryption

- [x] Task 13: gateway checkpoint encryption helpers implemented and tested

### Phase G: Docs

- [x] Task 14: `shravan-claw/docs/01-architecture-v4.md` updated
- [x] Task 15: `shravan-claw/docs/05-secrets-security-model.md` updated
- [x] Task 16: `agent-vm/docs/SETUP.md` added

## File Audit

### agent-vm

- [x] [images/gateway/build-config.json](/Users/shravansunder/Documents/dev/project-dev/agent-vm/images/gateway/build-config.json)
- [x] [images/tool/build-config.json](/Users/shravansunder/Documents/dev/project-dev/agent-vm/images/tool/build-config.json)
- [x] [system.json](/Users/shravansunder/Documents/dev/project-dev/agent-vm/system.json)
- [x] [.env.example](/Users/shravansunder/Documents/dev/project-dev/agent-vm/.env.example)
- [x] [scripts/build-images.sh](/Users/shravansunder/Documents/dev/project-dev/agent-vm/scripts/build-images.sh)
- [x] [packages/agent-vm/src/controller/system-config.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/controller/system-config.ts)
- [x] [packages/gondolin-core/src/build-pipeline.test.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/build-pipeline.test.ts)
- [x] [packages/agent-vm/src/gateway/gateway-vm-setup.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-vm-setup.ts)
- [x] [packages/agent-vm/src/gateway/gateway-vm-configuration.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-vm-configuration.ts)
- [x] [packages/agent-vm/src/gateway/credential-manager.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/credential-manager.ts)
- [x] [packages/agent-vm/src/cli/agent-vm-entrypoint.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/agent-vm-entrypoint.ts)
- [x] [packages/agent-vm/src/cli/agent-vm-cli-support.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/agent-vm-cli-support.ts)
- [x] [packages/agent-vm/src/cli/init-command.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/init-command.ts)
- [x] [packages/agent-vm/src/cli/ssh-commands.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/cli/ssh-commands.ts)
- [x] [packages/gondolin-core/src/vm-adapter.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/gondolin-core/src/vm-adapter.ts)
- [x] [packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts](/Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts)
- [x] [docs/SETUP.md](/Users/shravansunder/Documents/dev/project-dev/agent-vm/docs/SETUP.md)

### shravan-claw

- [x] [/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/01-architecture-v4.md](/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/01-architecture-v4.md)
- [x] [/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/05-secrets-security-model.md](/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/05-secrets-security-model.md)

## Verification Snapshot

- [x] `pnpm check`
  - `pnpm lint:types` exited `0` with warnings only
  - `pnpm fmt:check` exited `0`
  - `pnpm typecheck` exited `0`
  - `pnpm test` exited `0`
- [x] `pnpm test:integration` exited `0`

Latest observed results:

- `pnpm test`: `38` files passed, `132` tests passed, `1` skipped
- `pnpm test:integration`: `4` files passed, `7` tests passed, `2` skipped

## Commit Checkpoints

- [x] `3659431` `feat: bake gateway and tool image setup`
- [x] `c80ec54` `feat: add env refs and init ssh workflow`
- [x] `58e9605` `feat: add checkpoint path and encryption helpers`
- [x] `690d0b5` `docs: add setup guide and verify env-backed config`
- [x] `9e23a4f` `docs: update gondolin boot and secret reference docs`
