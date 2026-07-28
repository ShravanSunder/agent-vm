# Hermes Native Profile Configuration Implementation Plan

Status: Reviewed and ready for `implementation-execute-plan`

Date: 2026-07-26

## Goal

Implement the accepted Hermes configuration, native-profile, and profile-secret
ownership contract without changing runtime topology, storage ownership,
upstream Hermes, Gondolin, OpenClaw, Tool Portal, or adjacent Agent VM systems.

The final PR must provide:

```text
deployment common non-secret policy
  -> dedicated read-only /etc/hermes/config.yaml

stateDir RealFS
  -> /home/hermes/.hermes
     -> root/default native home
     -> profiles/clawfest native home
     -> profiles/beta native home
     -> exact profile .env paths overlaid by RAM shadows

zones[].secrets
  -> existing Agent VM resolution and injection policy

profileSecretProjectionsByAgent
  -> required agent + target -> source assignment
  -> raw Discord token or opaque mediated placeholder
  -> exact assigned profile RAM .env
```

The terminal is the existing PR updated and freshly proven ready, but not
merged. Package publication and non-beta deployment are out of scope.

## Source Contract And Coverage

Primary accepted specification:

- `docs/specs/2026-07-25-hermes-config-profile-secret-ownership/2026-07-25-hermes-config-profile-secret-ownership.md`
- coverage: 1,069/1,069 lines
- SHA-256:
  `1b87886e49fd450596ea5e3485a3e0395502ffe12a159ebe2c7a60de0f1307ef`

Preserved Discord-custody specification:

- `docs/specs/2026-07-23-hermes-discord-secret-mediation/2026-07-23-hermes-discord-secret-mediation.md`
- coverage: 316/316 lines

Review and goal context:

- `tmp/spec-review-workflows/2026-07-25-hermes-config-profile-secret-ownership/parent-reduction.md`
- coverage: 415/415 lines
- `tmp/workflow-state/2026-07-25-hermes-native-profile-config/details.md`
- coverage: 289/289 lines
- `tmp/workflow-state/2026-07-25-hermes-native-profile-config/events.jsonl`
- coverage: 11/11 events

Planning receipt:

- branch: `feat/tool-portal-openclaw-hermes-beta-pr`
- base HEAD: `7a2b6bf8294bfee3a70af4ba8385356cb613e875`
- pinned Hermes: `0.18.2`, tag `v2026.7.7.2`, commit
  `9de9c25f620ff7f1ce0fd5457d596052d5159596`
- the existing dirty candidate is evidence to classify and preserve, not a
  proven implementation baseline

## Confirmed Public Configuration

`zones[].agents` remains the only agent-definition authority.
`profilesByAgent` and `profileSecretProjectionsByAgent` reference those agent
IDs and must have exactly the same keys.

```jsonc
{
  "agents": [
    { "id": "clawfest" },
    { "id": "beta" }
  ],
  "gateway": {
    "type": "hermes",
    "profilesByAgent": {
      "clawfest": "clawfest",
      "beta": "beta"
    },
    "profileSecretProjectionsByAgent": {
      "clawfest": {
        "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_CLAWFEST",
        "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_CLAWFEST"
      },
      "beta": {
        "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_BETA",
        "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_BETA"
      }
    }
  }
}
```

The mapping direction is always:

```text
profile target environment name -> zones[].secrets source name
```

The field is required for every managed Hermes agent. Every agent has exactly
one `DISCORD_BOT_TOKEN` target. Other targets use HTTP-mediated sources.

This field exists only in the strict `type: "hermes"` branch of the existing
gateway discriminated union. OpenClaw retains `rawEnvSecrets` and
`authProfilesByAgent`; Worker retains neither. There is no cross-framework
target-name abstraction.

## Non-Goals And Hard Rails

- No new process, plugin, supervisor, sidecar, coordinator, or state machine.
- No upstream Hermes, upstream Gondolin, or OpenClaw change.
- No managed-VM contract or new mount kind.
- No config copy, synchronization, migration, compatibility, recovery,
  rollback, snapshot, watcher, or hot reload.
- No durable profile `.env` and no raw provider credential inside Hermes.
- No Tool Portal, Tool VM, lease, backup, Git, workspace, controller, CI,
  runner, or observability redesign.
- No generic cross-framework projection or secret-scanner framework.
- No optional or legacy Discord-only projection path.
- No package publication or PR merge.

Stop and reconverge if implementation needs any forbidden owner or if pinned
Hermes cannot consume the accepted `/etc/hermes` and exact RAM-shadow paths.

## Current Code Re-Anchor

The current implementation still has these exact gaps:

1. `system-config.ts` owns optional
   `discordBotTokenSecretsByAgent` and Discord-only validation.
2. `GatewayZoneConfig`, `gateway-zone-support.ts`, and the lifecycle contract
   carry that obsolete field.
3. `hermes-lifecycle.ts` emits
   `discordBotTokenEnvironmentVariablesByProfile`.
4. The Python adapter consumes that Discord-only map and writes one hard-coded
   target.
5. The current dirty candidate contains useful `/etc/hermes`, native-home,
   finite-admission, exact-shadow, and pinned read-gap work, but its
   projection-specific edits remain stale.

## Execution DAG

The implementation is serial because Slices 1 and 2 both own
`hermes-lifecycle.ts`, and Slice 3 consumes the exact metadata contract frozen
by Slice 2.

```text
Gate 0: preserve and classify the dirty candidate
  |
Slice 1: common policy, native homes, and finite admission
  |
Checkpoint C1 + targeted proof
  |
Slice 2: required projection schema and TypeScript/controller join
  |
Slice 3: Python complete-map materialization and pinned read gaps
  |
Atomic C2/C3 projection-contract checkpoint
  (paired producer/consumer assertions; live interoperability at Slice 4)
  |
Slice 4: integrated Hermes E2E, docs/manual, and broad local gates
  |
Checkpoints C4/C5
  |
Exact beta runtime, security, restart, fallback, Tool VM, and OTel proof
  |
implementation-review-swarm
  |
implementation-pr-wrapup: ready and unmerged
```

No concurrent implementation owner may edit an overlapping file. Native agents
may run disjoint read-only review or mechanical proof operations; the parent
validates every receipt and owns every commit.

## Gate 0 — Preserve And Classify Existing Work

1. Record exact HEAD, branch, index state, working-tree state, and untracked
   files.
2. Preserve the unrelated untracked review note.
3. Classify each existing candidate hunk into Slice 1, Slice 2, Slice 3,
   Slice 4, rejected, or deferred.
4. Record a temporary ledger with:
   `path | hunk/line anchor | owner | disposition`. Before each commit, compare
   `git diff --cached` to only that checkpoint's ledger rows; afterward, verify
   every non-committed and user hunk remains present and unstaged.
5. Stop for direction if an owned edit overlaps a user/deferred hunk that
   cannot be separated without reset, checkout, or clean.
6. Do not reset, clean, checkout, rebase, or create a second implementation
   worktree.
7. Do not treat an existing passing test or dirty hunk as current proof.

No product checkpoint is created at Gate 0.

## Slice 1 — Native Common Policy, Homes, And Admission

Source requirements: R1-R6, R12-R13.

Behavior:

- admit one dedicated real directory containing exactly regular
  `config.yaml`;
- mount that directory read-only at `/etc/hermes`;
- remove common YAML from the finalizable `/run` input and rootfs required
  inventory;
- keep `HERMES_MANAGED_DIR` protected but unset;
- keep protected `GATEWAY_MULTIPLEX_PROFILES=true`;
- preserve direct `stateDir` RealFS plus tmpfs overlays only at exact
  configured profile `.env` paths;
- create missing-only mode-`0600` `{}` activation stubs for root/default and
  exact configured native profiles;
- preserve existing native configuration bytes and ordinary framework state;
- apply the accepted finite, value-free configuration and filesystem
  admission inventory.

Primary write surfaces:

- `packages/hermes-gateway/src/hermes-lifecycle.ts`
- `packages/hermes-gateway/src/hermes-managed-configuration.ts`
- `packages/hermes-gateway/src/hermes-profile-directory-materialization.ts`
- `packages/gateway-lifecycle/src/gateway-lifecycle.ts`
- `packages/agent-vm/src/gateway/managed-gateway-boot-input-materializer.ts`
- `packages/gondolin-vm-adapter/src/rootfs-init-extra.ts`
- focused unit, integration, and host-E2E tests

Proof:

1. Establish failing assertions for `/etc/hermes`, absent common YAML under
   `/run`, protected environment values, missing named stubs, and the finite
   rejected inventory.
2. Make the smallest existing-boundary implementation pass.
3. Run targeted lifecycle/config unit tests, config-validation integration,
   and the host profile-materialization E2E.
4. Parent inspects the complete slice and commits C1.

Split/reconverge if this needs a new mount kind, config copy, generic parser or
scanner, state rewrite, watcher, migration, or upstream change.

## Slice 2 — Required Projection Schema And TypeScript Join

Source requirements: R8-R10 and the accepted public/internal projection
boundary.

Behavior:

- hard-remove `discordBotTokenSecretsByAgent`;
- add required `profileSecretProjectionsByAgent` only to the strict Hermes
  gateway schema and lifecycle type;
- require exact key parity between configured agents, `profilesByAgent`, and
  `profileSecretProjectionsByAgent`;
- require exactly one `DISCORD_BOT_TOKEN` target per agent backed by a distinct
  `env`/`gateway` source;
- require every other target to use a Gateway-reaching
  `http-mediation` source;
- reject projected `source: "config"` credentials;
- reject unknown agents/sources, unsafe names, reserved source or target
  names, `API_SERVER_KEY`, non-Discord raw targets, invalid audiences, and
  unassigned authored Gateway-reaching mediated sources;
- preserve `agentAccess` as an independent Tool-VM delivery selector;
- export the fixed Hermes source/target predicates from `hermes-gateway`;
- join agent assignments in the TypeScript Hermes lifecycle and emit only:

```text
profileEnvironmentSourceNamesByProfile
  profile -> target -> source
```

- create one placeholder per distinct mediated source per Gateway epoch;
- reuse it for every explicit assignment of that source in the epoch;
- project it only into Hermes framework staging for the explicit profile
  assignments;
- preserve destination-specific Tool Portal runtime sources, the existing
  authored/runtime collision rejection, and `agentAccess` as the independent
  Tool-VM selector; profile projection grants neither Tool Portal nor Tool-VM
  custody;
- reject a source collision against the completely constructed Hermes
  framework environment before placeholders are merged;
- generalize exact `.env` shadow declarations to every configured projection
  profile without adding another mount or file.

Primary write surfaces:

- `packages/agent-vm/src/config/system-config.ts`
- `packages/agent-vm/src/config/system-config.unit.test.ts`
- `packages/agent-vm/src/gateway/gateway-zone-support.ts`
- `packages/agent-vm/src/gateway/gateway-zone-support.unit.test.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
- `packages/gateway-lifecycle/src/gateway-lifecycle.ts`
- `packages/gateway-lifecycle/contract-fixtures/python-managed-gateway-lifecycle/index.ts`
- `packages/hermes-gateway/src/hermes-lifecycle.ts`
- `packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts`

Proof:

1. Add failing schema cases for exact parity, required mappings, same-source
   profile fanout, same target with distinct profile sources, and completeness.
   Cover every fixed Hermes-reserved source and target, pinned process-global
   exact names and prefixes, one allowed ordinary provider target, the
   `gateway`/`both`/`tool-vm` audience matrix, and generated process mediation
   excluded from authored completeness.
2. Add failing controller/lifecycle cases for one placeholder per source,
   distinct-source separation, epoch freshness, names-only metadata, and a
   collision against one dynamically constructed runtime/OTel environment key
   at the final pre-placeholder merge.
3. Add the asymmetric authorization case: source X is projected only to Hermes
   profile A while `agentAccess` selects only Tool VM B. Prove Hermes B and Tool
   VM A receive nothing, Tool Portal receives nothing from either selector,
   and neither selector widens the other.
4. Implement the hard cut without compatibility parsing.
5. Remove all legacy runtime/schema/controller/contract-fixture references and
   confirm with a scoped `rg`; defer only named Hermes E2E/manual references to
   Slice 4.
6. Run targeted unit and orchestrator integration tests.
7. Parent inspects the serialized JSON shape, but does not commit or boot the
   producer-only state.

The TypeScript shape is frozen before Python edits, but the hard cut is committed
only after both producer and consumer accept the same serialized shape. No
compatibility path or intentionally broken deployable checkpoint is created.

Split/reconverge if this requires a second mediation system, OpenClaw changes,
Tool Portal authorization changes, a generic cross-framework projection, or
raw provider delivery.

## Slice 3 — Python Complete Profile Maps And Pinned Read Gaps

Source requirements: R7-R10.

Behavior:

- replace the Discord-only optional metadata field with required
  `profileEnvironmentSourceNamesByProfile`;
- validate the exact admitted profile cohort and complete target/source maps;
- validate the pinned Hermes profile-local target predicate;
- capture every staged source value;
- remove every mapped source name from Python `os.environ` before stock Hermes
  starts;
- write each complete target map in ascending ASCII target-name order to only
  the exact mode-`0600` RAM-shadowed profile `.env` path;
- create no root `.env`, temporary file, lock, journal, backup, or sibling;
- remove every exact shadow created by the attempt after partial failure;
- never start stock Hermes after any projection failure;
- retain the two bounded, fail-closed Hermes 0.18.2 managed-policy read-gap
  bindings and restore exact originals after success, partial installation,
  stock-run failure, and cleanup failure.

Primary write surfaces:

- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py`
- `python/agent-vm-hermes-adapter/tests/test_managed_gateway_bootstrap.py`
- existing adjacent Python adapter tests only when directly required

Proof:

1. Add failing Python tests for complete multi-target maps, exact cohort,
   target/source rejection, same target across profiles, source removal,
   sorted output, exact paths/modes, partial-write cleanup, and no stock start.
   Include empty and NUL/CR/LF-containing values, a missing/unsafe last source
   before any write, and a later write failure followed by one unlink failure.
   Prove cleanup continues, every mapped source name is removed, stock Hermes
   never starts, and diagnostics contain no canary bytes.
2. Retain or add failing pinned-binding tests for effective fallback/provider
   routing and exact restoration.
3. Implement only inside the existing adapter.
4. Run focused modern-`uv` pytest and the broad Python quality/build gates
   relevant to the slice.
5. Run paired TypeScript producer and Python consumer contract assertions.
   Slice 4 Hermes E2E owns real serialized producer-to-consumer interoperability.
6. Parent inspects custody and binding cleanup and commits the atomic C2/C3
   projection-contract checkpoint.

Split/reconverge if Python must resolve secrets, reconstruct agent-to-profile
assignment, add a process/plugin, write durable files, or add a third upstream
binding.

## Slice 4 — Integrated Runtime, Docs, And Local Proof

Source requirements: integrated R1-R13.

Behavior:

- convert existing Hermes fixtures to the dedicated
  `hermes-managed/config.yaml` directory;
- use required generic projections for both Discord and mediated provider
  targets;
- remove raw provider keys, webhook acceptance, authored multiplex,
  `secrets.preserve_existing`, and obsolete Discord-only configuration;
- prove live default `/etc/hermes` discovery with `HERMES_MANAGED_DIR` absent;
- prove root/default alone owns API/health and has no Discord identity;
- prove root/default and both named homes consume common model, fallback,
  provider-routing, and plugin policy while distinct local leaves survive;
- prove exact RAM shadows and supported stop/update/start marker A-to-B
  behavior;
- rewrite the two existing Hermes E2E files to prove generic target maps,
  distinct sources under the same target, producer-to-consumer interoperability,
  exact RAM custody, root-without-Discord, native RealFS state, and
  epoch/placeholder change;
- update canonical configuration documentation, generated manual templates,
  and manual-template tests;
- run a built-CLI `agent-vm manual update` smoke against an OS-temp deployment.

Primary write surfaces:

- existing Hermes E2E harness and Hermes E2E tests
- `docs/reference/configuration/system-json.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`

Proof:

1. Convert runtime assertions first and observe the expected failure.
2. Run focused Hermes E2E with zero skips/todos.
3. Remove all remaining legacy E2E/manual references and confirm with a final
   scoped `rg`.
4. Run manual-template unit proof plus the existing built-CLI OS-temp smoke:
   `mise exec -- pnpm run test:e2e:host -- packages/agent-vm/src/integration-tests/manual-cli.host.e2e.test.ts`.
   Its two generations must exit zero, create the expected manual files, and
   retain identical hashes on the second run.
5. Run broad local proof gates below.
6. Parent commits runtime C4 and docs/manual C5 separately when each is
   independently proven.

Root API turns, loader inspection, or file presence do not substitute for
named-profile provider turns. Those require real beta Discord identities.
Credentialed beta therefore owns profile-attributed mediation, one Tool-VM
capability per profile, denial without Tool VM dispatch, and fallback
activation.

## Requirements / Proof Matrix

| Row | Requirement | Owner | Proof layers | Freshness | Red/green |
| --- | --- | --- | --- | --- | --- |
| M1 | R1 common `/etc/hermes` authority | Slice 1 | unit, integration, Hermes E2E | exact HEAD/image; live variable absent | yes |
| M2 | R2 no copied YAML or managed-dir override | Slice 1 | unit, integration, live guest inspection | exact boot inventory | yes |
| M3 | R3 direct RealFS plus exact RAM shadows | Slices 1, 4 | unit, host E2E, Hermes restart E2E | fresh state root/epoch | yes |
| M4 | R4 exact cohort and protected multiplex | Slices 1, 2, 4 | unit, integration, beta | current config/epoch | yes |
| M5 | R5 finite profile admission/stubs | Slice 1 | unit, integration, host E2E | fresh OS-temp trees | yes |
| M6 | R6 root-only listener/no root Discord | Slice 4 | integration, Hermes E2E, beta | live process/identity | yes |
| M7 | R7 pinned managed-policy reads | Slices 3, 4 | Python, Hermes E2E, beta fallback | exact Hermes 0.18.2 | yes |
| M8 | R8 credential admission/collisions | Slices 1, 2 | unit, integration, mediation E2E, beta canary | fresh canaries | yes |
| M9 | R9 required projection and epoch semantics | Slice 2 | unit, integration, restart E2E | two fresh epochs | yes |
| M10 | R10 exact adapter maps and cleanup | Slice 3 | Python, host E2E, Hermes/beta | fresh values and paths | yes |
| M11 | R11 retained OTel behavior | beta terminal | logs, traces, metrics | bounded fresh query | no behavior change |
| M12 | R12 one existing runtime topology | Slices 1, 4 | structural, integration, live process inventory | current VM epoch | yes |
| M13 | R13 stop/update/start only | Slice 4 and beta | Hermes E2E, beta | distinct A/B epochs | yes |
| M14 | Docs/manual and PR-ready terminal | terminal | manual smoke, broad gates, review, GitHub | exact final HEAD/PR state | template yes |

Every row is sized so its owned lower proof can pass before the terminal beta
composition. A failing required proof outside the owned code path invokes the
scope guard rather than authorizing adjacent edits.

## Validation Commands

Run from the Agent VM monorepo root.

Targeted TypeScript unit:

```text
pnpm vitest run --config vitest.config.ts --project unit \
  packages/agent-vm/src/config/system-config.unit.test.ts \
  packages/agent-vm/src/gateway/gateway-zone-support.unit.test.ts \
  packages/agent-vm/src/gateway/managed-gateway-boot-input-materializer.unit.test.ts \
  packages/gondolin-vm-adapter/src/managed-gateway-rootfs-init.unit.test.ts \
  packages/hermes-gateway/src/hermes-managed-configuration.unit.test.ts \
  packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts
```

Targeted integration:

```text
pnpm vitest run --config vitest.config.ts --project integration \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts \
  packages/agent-vm/src/operations/config-validation.integration.test.ts
```

Host E2E:

```text
mise exec -- pnpm run test:e2e:host -- \
  packages/hermes-gateway/src/hermes-profile-directory-materialization.host.e2e.test.ts
```

Python:

```text
uv run pytest python/agent-vm-hermes-adapter/tests/test_managed_gateway_bootstrap.py
pnpm python:fmt:check
pnpm python:lint
pnpm python:typecheck
pnpm python:test
pnpm python:build
```

Hermes E2E:

```text
mise exec -- pnpm run test:e2e:hermes -- \
  packages/agent-vm/src/integration-tests/hermes-discord-profile-secrets.hermes.e2e.test.ts \
  packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts

mise exec -- pnpm test:e2e:hermes
```

Broad local gates:

```text
pnpm check
pnpm test:unit
pnpm test:integration
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e
git diff --check
```

`test:e2e:inventory` proves inventory only. Default `test:e2e` does not replace
the separate Hermes E2E lane. Record exit codes, counts, skips/todos, and
durations.

## Exact Beta Acceptance

Beta worktree:

`/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`

Before mutation:

1. Record beta HEAD, branch, status, intended-file overlap, installed package
   provenance, image identity, and OTel query start.
2. Preserve every existing dirty file.
3. Sync exact locally proven artifacts using:

```text
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
```

Beta config cutover:

- move the common YAML to
  `config/gateways/hermes-beta/hermes-managed/config.yaml`;
- point `gateway.config` to that file;
- hard-replace the obsolete Discord map with required
  `profileSecretProjectionsByAgent`;
- assign distinct Discord sources and distinct provider sources to the stock
  profile target names;
- remove webhook, preserve-existing, explicit Discord enablement, authored
  multiplex, raw provider values, and native Hermes secret sources.

Run:

```text
mise exec -- pnpm build
pnpm validate
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
pnpm start:hermes
```

Use `pnpm force-stop:hermes` followed by `pnpm start:hermes` for the
Hermes-only A-to-B restart. Do not use controller-wide `pnpm stop` while the
OpenClaw beta zone may be running.

Retain one compact evidence row per action with: setup/action, positive
observable, required negative observable, bounded command/query, redacted
fields, and cleanup. The protocol is:

1. `controller logs --zone hermes-beta` proves exactly `clawfest` and `beta`
   Discord identities connect and root/default does not;
2. each real named identity completes a uniquely marked provider turn through
   its assigned placeholder; retain only profile ID, marker, correlation ID,
   provider status, and source/placeholder digests;
3. distinct sources satisfy the same stock provider target in different
   profiles;
4. controller/Tool Portal evidence proves one real Tool-VM-backed capability
   per profile;
5. one disallowed capability returns a correlated denial without backend or
   Tool VM dispatch;
6. a bounded invalid-primary test activates the configured fallback, then
   restores the intended primary;
7. the Hermes-only stop/update/start applies marker A-to-B, reconnects both
   bots, rotates
   placeholders, and preserves non-overlapping native state;
8. synthetic canary inspection uses existing image/build-context inspection,
   controller SSH/path inspection, Tool Portal/real Tool-VM observation, and
   backup-input inventory. Separate zero-match predicates prove: raw provider
   bytes are absent from the entire Gateway VM, Tool Portal, and Tool VM; raw
   Discord bytes exist only in approved bootstrap RAM and exact profile
   shadows; placeholders exist only in approved bootstrap RAM and assigned
   profile shadows. Scan durable state, cache, backup inputs, images, and `/run`
   outside approved inputs without retaining values;
9. bounded existing Victoria log/trace/metric queries correlate one success per
   profile plus one denial and return zero canary/credential matches;
10. final intended policy is restored and static/live validation reruns.

Retained evidence contains only hashes, counts, safe IDs, operation markers,
timestamps, correlation IDs, and zero-match predicates. It contains no raw
credential, placeholder, canary, environment dump, resolved 1Password
reference, or copied secret-bearing log body.

Create a beta checkpoint commit only if the required beta diff is isolated
from preserved user changes. Do not publish packages.

## Implementation Review And PR Terminal

After beta proof:

1. Run `shravan-dev-workflow:implementation-review-swarm`.
2. Parent validates every candidate finding against exact source, diff, tests,
   and HEAD.
3. Accepted findings return to `implementation-execute-plan` and receive
   focused proof and a narrow checkpoint.
   Any runtime/config/security correction also resyncs exact artifacts and
   reruns affected beta acceptance so the final PR HEAD and beta receipt share
   one implementation/package/image lineage.
4. Run `shravan-dev-workflow:implementation-pr-wrapup`.
5. Push scoped commits and update the existing PR.
6. Freshly inspect checks, comments, review threads, mergeability, PR HEAD, and
   readiness.
7. Stop with the PR ready and unmerged.

## Checkpoint Commits

```text
C0  accepted reviewed plan
C1  native common policy, homes, and admission
C2/C3  atomic TypeScript/Python profile-projection contract
C4  integrated Hermes runtime proof
C5  canonical docs and generated manual
C6  narrow accepted implementation-review correction, if any
C7  isolated beta config checkpoint, when safe
C8  PR-ready wrap-up, when scoped files changed
```

The parent stages exact scoped paths, verifies the diff and proof, and never
stages unrelated work.

## Rollback And Recovery

There is no product rollback or migration mechanism.

- Before a checkpoint, correct only the current scoped slice.
- After a checkpoint, a correction is a new narrow commit.
- A failed beta attempt uses the existing stop/cleanup/start flow.
- Durable native Hermes state is never deleted, rewritten, or restored by this
  work.

## Open Questions

None.

## Phase Receipt

```text
phase_result: complete
evidence:
  docs/specs/2026-07-25-hermes-config-profile-secret-ownership/plans/2026-07-25-hermes-native-profile-configuration.md
  tmp/plan-review-workflows/2026-07-26-hermes-native-profile-configuration/parent-review.md
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Parent-validated plan review corrected the
  Tool Portal boundary, atomic producer/consumer cutover, and proof precision
  without changing architecture, authority, persistence, or scope.
```
