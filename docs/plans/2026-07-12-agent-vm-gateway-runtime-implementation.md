# Agent VM Gateway runtime implementation plan

Date: 2026-07-12
Status: reviewed and remediated once; executable
Goal ID: `2026-07-12-agent-vm-gateway-runtime`
Implementation baseline: `mcp-portal-runtime-fixes` at
`fb8605ad31ca660946add99172ee2ac42d3abf7b` or a descendant

## Goal

Hard-cut managed OpenClaw and Hermes onto one Gateway-runtime-owned Tool Portal
and sandbox service while preserving controller authority, backend-neutral VM
contracts, durable process identity, owned-directory fencing, Tool VM leases,
recovery, health, and real stock-VM behavior.

The implementation is complete only when the code, package graph, generated
contracts, Python distributions, images, docs, CI/release gates, real framework
paths, beta deployment, implementation review, and PR readiness prove the
accepted contract. A partial package migration or mock-only green suite is not
completion.

## Normative sources and coverage

- Primary contract:
  `/Users/shravansunder/Documents/dev/project-dev/agent-vm.gateway-runtime-architecture/docs/specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md`
  — 1,686/1,686 lines read.
- Normative glossary:
  `/Users/shravansunder/Documents/dev/project-dev/agent-vm.gateway-runtime-architecture/docs/specs/2026-07-12-agent-vm-gateway-runtime/glossary.md`
  — 799/799 lines read.
- Retained Managed VM boundary:
  `docs/specs/2026-07-12-gateway-managed-vm-package-boundaries.md` — live
  source and enforcement inspected at `fb8605ad`.
- Retained Hermes behavior contract:
  `/Users/shravansunder/Documents/dev/project-dev/agent-vm.hermes-agent-vm-integration/docs/specs/2026-07-12-hermes-agent-vm-integration.md`
  — 929/929 lines read. Its direct-MCP and same-VM child-recovery topology is
  superseded. Its BaseEnvironment, operation-group, process, strict-SSH,
  lifecycle, result, backpressure, and real-proof constraints remain inputs.
- Current package manifests, owner modules, tests, `vitest.config.ts`, CI,
  publish scripts, exact-HEAD inspector, boundary audits, image Dockerfile,
  OpenClaw `2026.6.8`, and Gondolin `0.12.0` were inspected against the baseline.

Before implementation, promote the exact remediated primary spec and glossary
into this branch under
`docs/specs/2026-07-12-agent-vm-gateway-runtime/`. The sibling architecture
worktree is eighteen commits behind and is never an implementation base.

## Hard boundaries

- No compatibility aliases, deprecated runtime route, dual service, feature
  flag, or old/new package path.
- No Gondolin source edit, fork, patch, package override, file dependency, or
  pnpm patch. Live inspection found no current patch residue; keep and extend
  the existing fail-closed audit.
- Only
  `packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts` and
  `packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts` may import
  `@agent-vm/gondolin-vm-adapter` in production. Only the adapter may import the
  Gondolin SDK.
- Controller domains receive narrow `managed-vm` capabilities, never aggregate
  `ManagedVmProvider`, native VM handles, or a general guest filesystem.
- `OwnedHostDirectory` remains single-use and is never reduced to a raw path.
- Worker remains `direct-gateway-process` and never depends on Gateway runtime.
- The controller remains sole durable authority. Gateway runtime owns
  current-epoch mechanics and custody only.
- Gateway runtime, OpenClaw/Hermes, the managed plugin, and the execution bridge
  are one trusted Gateway-VM subsystem. Do not add an agent-vm-owned Zig/native
  helper, separate runtime/framework UID boundary, privileged launcher, or new
  HMAC/bearer authentication between those in-VM components.
- A new long-lived process, OS principal/capability, privileged helper, daemon,
  cryptographic trust boundary, or process-topology change is an architecture
  decision and stops implementation until explicitly aligned.
- Tests, CI, tooling, or environment failures outside the agreed path do not
  authorize infrastructure edits.
- No shared production process restart and no PR merge in this goal.

## Current delta

The hard package rename, neutral Managed VM substrate, Gate A source custody,
and Slice 2a portable-contract parity are already landed. The remaining cut is
substantial:

- the uncommitted `@agent-vm/gateway-runtime` TypeScript skeleton contains the
  initial private-UDS and child-supervision groundwork;
- no `@agent-vm/hermes-gateway` or Python Hermes package exists;
- Tool Portal is an in-process entry point hosted by the OpenClaw plugin;
- gateway control, lease, Tool VM SSH, and native Tool Portal ownership still
  live in the plugin;
- `GatewayProcessSpec` is one direct-process shape and the controller starts
  OpenClaw itself;
- ManagedVm streaming does not expose pipe/discard/window choices;
- approval-required managed calls are rejected;
- current atomic file replacement does not fsync file and parent directory;
- current recovery requires service-probe corroboration for sustained control
  death;
- CI and release do not own all check, exact-package, OpenClaw, Worker, or
  future Hermes proof.

## Resolved implementation choices

These choices operationalize plan-owned parts of the corrected spec. A Gate A
or Slice 1 VM-boundary proof failure returns to the architecture contract; it
does not invite a native, cryptographic, or additional-principal substitute.

### Gateway VM trust and local process topology

- Gateway runtime, OpenClaw/Hermes, the managed plugin, and the execution bridge
  are trusted together inside one Gateway VM and share its unprivileged service
  account. VM isolation is the security boundary.
- Gateway runtime directly spawns the typed managed-framework child with the
  stock Node/Python process API, records its lifecycle identity, supervises its
  exit, and treats framework death as Gateway-fatal. There is no privileged
  launcher, file capability, UID/GID transition, or same-VM child restart.
- The one Gateway runtime in each Gateway VM owns
  `/run/agent-vm/gateway-runtime/managed-plugin.sock` beneath its mode-`0700`
  runtime directory. It is never exposed through ingress, a Tool VM mount, or
  persistent state. Epoch fencing remains protocol and lifecycle state rather
  than filesystem hierarchy.
- Strict handshake state binds protocol/schema version, Gateway/runtime/
  framework epochs, client kind, configured agent set, and attachment
  generation. Gateway runtime derives surface and operation authority from the
  controller-authored snapshot and current lifecycle state. It admits one
  active connection per attachment and rejects method-before-handshake,
  duplicate, replay, stale-generation, wrong-agent-set, wrong-client-kind, and
  retired-epoch attempts.
- The SDK-owned OpenClaw bridge is a packaged JavaScript/Node entrypoint. It may
  carry the non-secret operation ID needed to select one exact pending
  reservation; dispatch begins only after atomic one-use consumption. It has no
  Tool Portal, lease, SSH, profile, credential, or policy authority.
- The hard trust-boundary rule above applies only to the new in-VM link. The
  existing controller/Gateway caller-context proof and standalone MCP approval
  contracts cross different boundaries and remain unchanged.

### Filesystem and artifact operations

- Tool VM filesystem methods stay on the existing strict-SSH data path and use
  stock guest operations with normalized `/work`-relative paths plus explicit
  entry/depth/byte/time bounds. Guest symlink, mount, and rename behavior is
  contained by the disposable Tool VM; no agent-vm native/openat helper is
  introduced.
- Controller host-path authorization, fresh single-use `OwnedHostDirectory`
  acquisition/revalidation, and stock Gondolin mount fencing remain unchanged.
  Client filesystem paths never become controller-host paths or a general
  ManagedVm/Gondolin filesystem surface.
- Controller runner artifact readback uses one fixed controller-authored stock
  guest-tool argv over neutral streaming exec. Only a validated controller-
  selected scratch artifact identifier varies, and controller byte/type/time
  bounds apply to stdout. There is no agent-vm-owned runner helper.

### Durable controller records

- Add one reusable crash-durable record writer under
  `packages/agent-vm/src/controller/durable-state/`: mode `0700` directories,
  `0600` files, per-record async locks, write-to-new-file, file fsync, atomic
  rename, and parent-directory fsync before the protected next action.
- Approval and runner state each use one discriminated record per operation.
  Atomic check/consume occurs while holding the record lock.
- A runner whose host PID/start identity was not published before a controller
  crash is `owner-unsafe` unless the real Slice 1 stock-image proof establishes
  that the process died with the controller. Missing PID is never containment
  evidence. The durable barrier is per zone and survives Gateway epoch changes;
  it blocks all controller runner and host-action successors in that zone until
  positive containment or protected operator clearance.
- Approval and runner authority records live in named per-zone subtrees below
  `stateDir`, never `runtimeDir`. Their schemas bind controller/Gateway epochs,
  use durable first-directory creation, retain terminal/ambiguous/owner-unsafe
  evidence for configured bounded retention, and fsync create, replace, and
  delete transitions. Restored records from backup fail closed under a new
  controller epoch and are contained or cleared through the protected recovery
  flow before dispatch.

### Contract generation and Python distribution

- Keep Zod as authored source. Add a registry of named portable refinement
  descriptors and generate JSON Schema refinement identities plus matching
  TypeScript and Pydantic v2 validators. Anonymous shared `.refine`,
  `.superRefine`, and transforms fail a structural guard.
- Create `python/agent-vm-agent-portal-sdk/` with PyPI distribution
  `agent-vm-agent-portal-sdk` and import module
  `agent_vm_agent_portal_sdk`.
- Create `python/agent-vm-hermes-gateway/` with PyPI distribution
  `agent-vm-hermes-gateway` and import module `agent_vm_hermes_gateway`.
- Both names returned 404 from PyPI on 2026-07-12; recheck before publication.
  PR proof builds and inspects wheel/sdist artifacts but does not publish them.
- Add a root uv workspace/lock and keep Python MCP and UDS imports isolated.

### Protocol and route choices

- UDS path:
  `/run/agent-vm/gateway-runtime/managed-plugin.sock`.
- Artifact root: `/run/agent-vm/gateway-runtime/artifacts`.
- Managed MCP guest route: `/agent-vm/tool-portal/mcp` on an explicit non-root
  ingress mapping and separate MCP audience.
- Controller execution route:
  `/agent-vm/controller-execution` on a distinct private non-root ingress
  mapping and audience.
- UDS uses JSON-RPC 2.0 with strict bounded `Content-Length` framing, no batch,
  and bounded chunks. Controller execution uses a separate authenticated
  WebSocket with explicit stream credits; sender pause/drain remains a second
  guard and no library queue may bypass declared bounds.
- MCP exposes exactly `tool_portal_list`, `tool_portal_search`,
  `tool_portal_describe`, and `tool_portal_call`; artifacts use authenticated
  MCP resources, not a fifth tool.

### Approval and artifacts

- Add controller `approvalAccess` configuration with explicit approver IDs and
  secret refs. Approval-required configuration fails validation unless this
  protected operator surface is configured. Existing `adminAccess.mode=none`
  is never silently treated as authenticated approval.
- Only an authenticated current-Gateway/control intent emitted by
  ToolPortalService may create a challenge record. The separate operator API
  may list/read and decide/deny/revoke, but cannot create or mutate challenge
  identity, fingerprint, principal, capability, arguments, revisions, or
  epochs. `approvalAccess` credentials travel in the authorization header under
  an approval-only audience, map to persisted approver identity/provenance, and
  reject admin, MCP, control, execution, body-token, public approver-ID, stale,
  and wrong-epoch credentials. Surface adapters render challenges but cannot
  approve.
- Gateway artifacts use bounded runtime-only files plus immutable in-memory
  indices. Metadata binds principal, surface, agent/profile/subject,
  capability, operation/generation, fingerprint, expiry, size/hash, and allowed
  range. Every MCP/UDS read reauthorizes; IDs never authorize.
- Artifact quota is reserved atomically before write and reconciled on every
  partial write, cancel, disk-full, and cleanup failure; concurrent writers
  cannot each pass a finalized-size check and exceed byte/count limits.

## Execution DAG

```text
Gate A: baseline descendant, source custody, no-patch/import invariants
  |
  +-- Slice 1: runtime and private UDS groundwork ----------------+
  |                                                               |
  +-- Slice 2a: portable contracts/refinement generation --------+|
                                                                  ||
                Slice 2b: TS/Python clients + bounded UDS <-------+
                                  |
                     integration gate B: contract/package ceilings
                                  |
                Slice 3: one ToolPortalService + MCP/CLI/config
                                  |
                Slice 4: durable approval + artifact lifecycle
                                  |
                 parent backend-interface freeze
                                  |
                 +----------------+----------------+
                 |                                 |
                 v                                 v
       Slice 5: persistent sandbox       Slice 6: controller execution
                 +----------------+----------------+
                                  |
                     integration gate C: real backends
                                  |
                parent gate D: common lifecycle cut
                                  |
                 +----------------+----------------+
                 |                                 |
                 v                                 v
       Slice 7: OpenClaw cutover          Slice 8: Hermes integration
                 +----------------+----------------+
                                  |
            Slice 9a: recovery/health convergence
                                  |
            Slice 9b: package/CI/docs enforcement
                                  |
                  implementation-review-swarm
                                  |
              accepted remediation + affected gates
                                  |
            Slice 9c: exact-HEAD repository and beta proof
                                  |
                    implementation-pr-wrapup, no merge
```

Gate A and each slice end in a parent-owned checkpoint. Sidekick completion is
not an integration gate. At each checkpoint the parent reads the diff, verifies
source anchors, runs the local proof, records red/green evidence, and commits
only scoped verified files when repository policy permits.

## Gate A — baseline and source custody

### Work

1. Verify `fb8605ad` is an ancestor of the current implementation HEAD and the
   worktree has no unrelated change collision.
2. Promote the exact remediated spec/glossary into the live branch and add them
   to `docs/README.md`.
3. Record exact hashes for the promoted spec, glossary, retained Managed VM
   spec, OpenClaw package, Gondolin package, and retained Hermes spec.
4. Run the existing managed-VM ownership and patch audits before product edits.
5. Add the goal/plan provenance to the implementation handoff ledger; do not
   copy architecture-worktree code.

### Proof and checkpoint

- `git merge-base --is-ancestor fb8605ad HEAD` exits 0.
- `pnpm test:managed-vm-boundaries`, `pnpm test:managed-vm-contracts`, and
  `pnpm test:vm-ownership-boundaries` pass.
- Search shows no `patchedDependencies`, `@patch:`, patch hash, patch file, old
  production package directory, or third adapter importer.
- Parent confirms promoted artifact hashes match the remediated sources.

Stop if baseline ancestry or artifact custody is false.

## Slice 1 — Gateway runtime and private UDS groundwork

Source: R5b–R6a, R21–R25b, R49–R51.

### Red first

- Add attachment-policy tests for method-before-handshake, duplicate active
  connection, protocol/schema skew, stale Gateway/runtime/framework epoch,
  stale attachment generation, wrong client kind, wrong configured-agent set,
  public authority injection, replay, and retirement.
- Add path/lifecycle tests proving the socket uses the one fixed VM-local path,
  remains private to the runtime directory, is removed on retirement, and is
  never projected into ingress, Tool VM mounts, or persistent state.
- Add the pre-identity ManagedVm crash probe: interrupt controller startup after
  the VM process starts but before durable identity publication. This permanent
  test owns the runner containment branch.

### Implement

- Reduce `@agent-vm/gateway-runtime` to a TypeScript-only package skeleton.
- Add the strict UDS frame codec, fixed VM-local path contract, attachment state
  reducer, one-active-connection rule, and server-derived authority boundary.
- Add framework-neutral child-supervision contracts using the stock runtime
  process API; full OpenClaw/Hermes composition remains in Gate D/S7/S8.

### Green and real gate

- Unit/integration tests prove the path, handshake, attachment, replay, and
  retirement state machines.
- A no-skip stock Gondolin/QEMU proof verifies the packaged runtime directory,
  socket visibility boundary, current-epoch handshake, stale/duplicate
  rejection, direct child lifecycle observation, and Gateway-fatal child exit.
- Pre-identity runner crash either proves child death or proves owner-unsafe
  successor blocking. Slice 6 encodes that result before runner dispatch.

Hard stop: do not cross any hard boundary above to satisfy this gate.

## Slice 2a — portable contracts and refinement generation

Source: R8, R13/R13b and the canonical outcome algebra.

### Red first

- Add fixtures that expose current JSON Schema loss: duplicate/reserved IDs,
  default application, numeric bounds, canonical JSON, illegal terminal outcome
  combinations, and anonymous refinements/transforms.

### Implement

- Complete canonical portal, sandbox, identity, error, result, artifact,
  approval, stream, attachment, and version modules in
  `@agent-vm/agent-portal-sdk`.
- Add portable refinement descriptors, generated validator/schema identity
  manifests, shared fixtures, and a temp-regenerate/byte-compare verifier.
- Add Python SDK Pydantic v2 models generated from the same descriptors and
  fixtures, without either transport dependency.

### Green and checkpoint 2a

- TS and Python accept/reject the exact same fixture corpus and defaults.
- Structural guard rejects any unregistered shared refinement/transform.
- Root imports remain contract-only. Generated declarations, Python models,
  schemas, fixtures, and refinement identity manifests byte-compare from a
  clean temporary regeneration.

Parallel Sidekicks may own TS and Python fixture files. The parent owns schema
exports, descriptor registry, generators, package wiring, and the checkpoint.

## Slice 2b — two real clients and bounded private UDS

Source: R9–R10, R21–R25b, R42, R49–R50.

This slice starts only after Slice 1 and checkpoint 2a are green.

### Red first

- Add strict frame negatives: duplicate/malformed headers, bad lengths, invalid
  UTF-8/JSON, partial/oversized frames, batches, unknown methods/fields, version
  skew, stale epochs, and public authority-field injection.
- Add the mandatory attachment handshake state machine: reject every method
  before handshake; bind protocol/schema version, Gateway/runtime/framework
  epochs, client kind, configured agent set, and attachment generation; permit
  one active connection per attachment; reject wrong client kind, wrong agent
  set, duplicate/replay, and reconnect outside still-valid epochs.
- Add slow/frozen consumer tests that currently retain too much data or block
  terminal/cancellation parsing.
- Add import failures for an SDK root that eagerly loads a client, MCP client
  loading UDS/runtime dependencies, UDS client loading MCP/SSH/VM/controller
  dependencies, and Python equivalents.

### Implement

- Add isolated TS subpaths:
  `./tool-portal-mcp-client`, `./gateway-runtime-client`,
  `./openclaw-execution-bridge`, and `./cli`.
- Add isolated Python ToolPortalMcpClient and GatewayRuntimeClient modules over
  the generated contracts.
- Implement strict UDS codec, request lifecycle, reconnect fencing, bounded
  chunks, global read pause, deadline, local discard-drain escape, and measured
  parser/Node/kernel high-water accounting. Attachment admission consumes only
  Slice 1's server-derived lifecycle state.

### Green and integration gate B

- Real TS and Python clients negotiate against the same local MCP/UDS harness,
  call, cancel, reconnect within valid epochs, reject skew/stale handles and
  preserve typed results/errors.
- Pressure proof asserts source/parser/Node/kernel retained-byte caps and
  terminal/cancel access behind stalled data.
- A no-skip stock-VM UDS pressure proof exercises the packaged runtime and
  records source/parser/Node/kernel high-water values, pause deadline,
  discard-drain escape, cancellation, and authoritative terminal access.
- Each client import loads only its allowed dependency graph. Built declarations
  and packed npm/wheel contents pass isolated module-load/import inspection.

Parallel Sidekicks may own strict framing, pressure, TS client, and Python
client tests in disjoint files. The parent owns UDS integration and exports.

## Slice 3 — one Tool Portal service, MCP projection, CLI, and epoch config

Source: R1–R7b, R5d, R9–R12, R13a, R50.

### Red first

- Add structural failures for a plugin/CLI/adapter constructing
  ToolPortalService and for Gateway runtime importing ManagedVm/Gondolin.
- Add a runtime-composition test that fails unless MCP and UDS hold the exact
  same service object and semantic snapshot.
- Add standard MCP tests for the four names, non-root ingress, independent auth,
  credential rotation/drain, stale credentials, session isolation, bounded
  progress/text, and epoch retirement.
- Add one-client multi-agent tests in which every call carries the complete R5d
  trusted context outside public arguments: agent, authenticated subject,
  session, run and tool-call correlation where available, workspace,
  environment scope, and profile-assignment revision. Vary each dimension
  independently; reject unconfigured agents, changed revisions, cross-framework
  substitution, and public identity/authority fields before visibility or
  backend admission.
- Add bounded-surface negatives proving MCP advertises no PTY, attach, raw
  streams/stdin, SSH, lease, PID, Gateway lifecycle, or rich artifact authority,
  while the protected UDS client exposes only its authenticated rich groups.
- Add an explicit standalone MCP Portal regression that boots its existing
  `mcp_portal_*` service independently of Gateway runtime and Tool Portal.
- Add config-ownership failures proving managed Gateway consumes authored
  `mcp.config.jsonc` plus authored `tool-portal.config.jsonc`, standalone MCP
  Portal consumes `mcp.config.jsonc` plus `mcp-portal.config.jsonc`, and neither
  path accepts the other product's policy/authentication fields.
- Add multi-agent tests that fail if managed composition constructs an MCP
  provider backend per agent, lets trusted context select a backend, or accepts
  standalone bearer/HMAC material as managed Tool Portal authority.
- Add packed CLI black-box failures for mixed stdout/stderr, wrong exit class,
  forbidden implicit credential discovery, and lost interrupt cancellation.

### Implement

- Refactor `tool-portal` around a named `ToolPortalService` with trusted
  invocation options, surface eligibility, one profile-revision binding, and
  backend ports for `mcp_provider`, `tool_vm_runner`, and host actions.
- Thread one server-verified trusted invocation-context object through both
  projections and resolve surface/profile/subject before catalog visibility or
  routing. Never merge that context into the public request schema.
- Move framework-neutral invocation-context schemas/validation into the
  Gateway/control contract layer. Controller domains accept the same attested
  context for OpenClaw and Hermes and do not parse plugin-owned session or agent
  identity vocabulary.
- Preserve standalone MCP Portal behind its distinct `mcp-portal.config.jsonc`
  schema. Managed Gateway consumes one exported shared MCP-provider runtime seam
  and does not construct projection-bound provider backends per agent.
- Compose exactly one service in Gateway runtime; project it through MCP and
  UDS without a second cache/router/policy instance.
- Compile the managed semantic snapshot from authored `mcp.config.jsonc`,
  authored `tool-portal.config.jsonc`, and controller-owned surface/lifecycle
  data. Do not generate managed Tool Portal policy from
  `mcp-portal.config.jsonc`; do not add `portal.config.jsonc` or an implicit
  merge/inheritance path.
- Add controller-authored immutable semantic snapshot and desired/active
  revisions. Only MCP credential versions hot-rotate.
- Add explicit ingress/audience/config materialization and fail readiness on
  revision mismatch.
- Implement the TS `tool-portal` CLI over ToolPortalMcpClient for HTTP/scoped
  stdio. The CLI never executes locally or owns policy.

### Green

- Exact object identity and matched cohort prove same visibility, approval
  disposition, binding, canonical result/error/artifact/outcome semantics.
- One long-lived GatewayRuntimeClient safely serves configured agents with
  per-invocation context; cross-agent/context-revision and public authority
  injection attempts fail before backend admission.
- Every configured agent reaches one shared MCP-provider runtime while profile,
  visibility, call, and approval decisions remain per-invocation
  ToolPortalService decisions from the active Tool Portal snapshot.
- Separate fixture proves intentional surface denial without a second router.
- MCP bounded-vs-UDS-rich method and declaration ceilings pass, and standalone
  MCP Portal remains independently runnable with `mcp_portal_*` operations.
- Standard MCP integration and packed CLI host e2e pass all auth, result,
  cancellation, and exit-contract cases.
- Exact package ceilings pass from source, declaration, module load, root
  export, tarball, wheel, and Python import graph.

## Slice 4 — durable approval and authenticated artifacts

Source: R11c, R31–R33, R54/R54a.

### Red first

- Approval: double-consume, replay, deny, revoke, expiry, changed fingerprint,
  cross-principal/surface, restart, operator-create/fingerprint mutation,
  cross-audience/body-token/stale-credential/wrong-epoch access, and every
  before/after-consumption crash cut.
- Artifacts: ID-only read, cross-principal/surface/generation, stale epoch,
  fingerprint mismatch, expired/range-overflow, concurrent quota reservation,
  partial write, disk-full, cancellation, cleanup failure, cap exhaustion, and
  path leak.

### Implement

- Add approvalAccess schemas, approver-secret resolution, protected routes,
  challenge/decision/grant contracts, and the fsync-ordered controller ledger.
- ToolPortalService decides approval requirement; controller persists the
  challenge and authenticated human decision. Controller consumes one decision
  atomically before dispatch and issues one operation-bound grant where the
  backend executes in Gateway runtime.
- Record `consumed-not-dispatched` and `dispatch-armed`. Only proven pre-dispatch
  cuts return `not-dispatched`; otherwise retain `ambiguous` and never replay.
- Add bounded epoch-local artifact store, shared authorization resolver, MCP
  resources, TS/Python `artifacts.read`, UDS readback, range limits, and epoch
  cleanup.
- Add packed CLI `artifact-read` over authenticated MCP resources after the
  store exists; it shares the CLI's canonical stdout, diagnostics stderr,
  stable exit, explicit credential, and cancellation contracts.

### Green

- Durable restart/crash integration proves approval ordering and exactly one
  dispatch for `mcp_provider` first; Slices 5/6 close the other backend rows.
- MCP/UDS/Python/TS read the same stored artifact with per-read authorization.
- The packed CLI reads an authorized range and rejects expired,
  cross-principal, wrong-generation, and oversized reads.
- Store count/bytes/lifetime and retirement cleanup counters prove bounds.
- References contain no path, credential, lease, SSH material, or authority.

## Backend interface freeze — parent checkpoint before Slices 5 and 6

Freeze the ToolPortalService backend port, approval/artifact contracts, and
Gateway-control intent/grant/result contracts after Slice 4. S5 owns only
Gateway-runtime sandbox/SSH/filesystem/process modules and their tests. S6 owns
only controller runner/typed-host-action/execution-data modules and their tests.
The parent alone changes Gateway-runtime composition, shared exports, frozen
contracts, manifests, and controller orchestration. Test authoring may overlap;
production changes to shared seams remain serialized.

The frozen MCP port is service-wide, accepts required trusted invocation context
and dispatch authority, and cannot be constructed or cached per agent. The
MCP-provider leaf owns provider mechanics only; it does not own agent/profile
authorization or standalone MCP Portal bearer/HMAC semantics.

The checkpoint builds/typechecks both consumers, runs structural guards that
forbid Gateway runtime from importing `managed-vm`, and records the exact frozen
declarations. Gate C must integrate both backends without revising those types.

## Slice 5 — persistent sandbox, strict SSH, filesystem, and processes

Source: R12, R19, R34–R34c, R38–R40a, R52.

### Red first

- Add public-selector attacks for backend/profile/SSH/executable/cwd/egress.
- Add generation/replacement tests for environment/process/stream handles and
  background start/status/wait/log/write/EOF/cancel semantics.
- Add path-contract tests for absolute/NUL/`..` rejection, normalized `/work`
  resolution, bounded symlink/error behavior, and entry/depth/byte/time caps.
  Prove no client path is translated to a controller-host path or a general
  ManagedVm/Gondolin filesystem surface.
- Add a real standard MCP test that initially cannot reach strict-pinned SSH.
- Add a real active predecessor SSH writer that attempts to mutate `/work`
  during leaf replacement and successor rebind.

### Implement

- Add `sandbox_ssh` Tool Portal binding and Gateway-runtime Tool VM client.
- Move gateway-side control, lease/renew/reacquire/release, active-use,
  strict-pinned SSH, process, stream, and filesystem mechanics out of the
  OpenClaw plugin into Gateway runtime.
- Preserve the full control proof contract during that move: server-derived
  `safety`, `authority`, `liveness`, and `diagnostic` admission classes;
  transient reconnect without Gateway or healthy Tool VM replacement; renew,
  reacquire, stale-key rejection, and independent bounded queues.
- Require current generation/lease/use at every operation. Preserve compatible
  `/work`, never VM/rootfs/process/key/socket continuity.
- Use stock guest filesystem operations over strict SSH; keep direct command/
  file/process bytes on SSH and off controller/Socket.IO/OTLP.
- Controller Tool VM lifecycle alone acquires, revalidates, transfers, closes,
  and freshly reacquires `OwnedHostDirectory` around replacement after positive
  predecessor quiescence. Gateway runtime requests and observes replacement but
  never receives the directory authority or imports `managed-vm`.
- Close the approval and artifact rows for `sandbox_ssh`.

### Green

- Unit/integration prove binding authority, active use, process outcomes,
  cancellation/ambiguity, and rich UDS pressure.
- Stock Tool VM proves normalized `/work` behavior and operation bounds while
  existing Gondolin/OwnedHostDirectory mount fencing remains green.
- A framework-neutral no-skip stock Gateway-runtime harness proves MCP ->
  ToolPortalService -> `sandbox_ssh` -> strict SSH before Gate C; S7 repeats the
  same path through managed OpenClaw. Both perform exec/fs/process work, modify
  `/work`, replace a leaf, reject old host key/handles, and rebind persistent
  state without preserving processes.
- The predecessor writer is positively stopped before fresh
  `OwnedHostDirectory` acquisition/rebind; inability to prove this yields
  owner-unsafe and no successor.

## Slice 6 — controller runner, host actions, and execution data plane

Source: R7a, R14–R20a, R26/R26a, R41a.

### Red first

- Add neutral exec tests showing current adapter defaults do not expose
  pipe/discard/window.
- Add policy attacks for shell tokens, launchers, config/credential/endpoint/
  plugin overrides, response files, path/host escape, and policy flags.
- Add host-action tests requiring a registered typed operation and rejecting
  generic command payloads, the HTTP `execute-command` route, public executable/
  prefix/OS-context selection, and unregistered actions as Tool Portal backends.
- Add runner crash cuts at reservation, create, pre-identity start, identity
  publication, admission, dispatch, side effect, stream, result, containment,
  Gateway retirement, and controller restart.
- Add saturated stream tests that miss current configured heartbeat,
  safety-cancel, or recovery-admission deadlines.
- Add execution handshake/frame attacks for stale/cross-audience credentials,
  old Gateway/runtime epoch, wrong principal/operation/fingerprint/channel,
  duplicate/out-of-order/gapped sequence, over-credit, replay, cross-channel
  frames, duplicate EOF/cancel, and reconnect after ambiguity.

### Implement

- Extend ManagedVm exec options with agent-vm-owned structural pipe/discard
  modes and bounded `windowBytes`; translate to stock Gondolin only inside the
  adapter.
- Add controller runner reservation/identity/parentage ledger and narrow
  factory capability. Runners have no SSH, lease, reuse, adoption, replacement,
  PTY, or interactive stdin.
- Recompute the complete R17 set—executable, mandatory prefix, credentials,
  cwd, environment, egress, output, artifacts, cancellation policy, and target—
  and revalidate approval/fingerprint immediately before `dispatch-armed`.
- Implement `controller_host_action` only as registered typed controller
  operations with fixed trusted executable/prefix/OS context and bounded input.
  Keep `/zones/:zoneId/execute-command` a separate admin operation; it is never
  a capability backend or exposed through Tool Portal/SSH CLI.
- Use fixed controller-authored stock guest-tool argv for runner artifact
  readback; only the validated controller-selected artifact identifier varies.
- Add controller-initiated private execution WebSocket, explicit credits,
  bounded codec work, independent auth/queues/scheduling, and no Socket.IO/OTLP
  bulk bytes.
- Bind the WebSocket handshake and every frame to audience, current controller/
  Gateway/runtime epochs, principal, operation, execution fingerprint, channel,
  sequence, credit, EOF, and cancellation state. Replay or reconnect never
  converts ambiguous work into redispatch.
- Add exact structural allowlist for aggregate `ManagedVmProvider` imports and
  preserve the two Gondolin adapter importers.
- Close approval/artifact rows for `controller_rpc` and host actions.

### Green

- Unit/integration prove policy, durable ordering, no adoption, authenticated
  data route, bounded pressure, and truthful outcomes.
- Typed host-action integration proves the registered operation succeeds after
  complete controller recomputation while generic execute-command-shaped,
  cancellation/target mutations, and public authority payloads fail before
  dispatch.
- Stock VM proves pipe/discard/window translation and bounded fixed-argv
  artifact readback.
- Pre-identity crash follows Slice 1's proven branch: contained, or durable
  owner-unsafe with successor blocked.
- Sustained offered work at every cap preserves existing configured heartbeat,
  cancellation, and recovery deadlines with recorded high-water bounds.
- A framework-neutral no-skip Gateway-runtime runner/data-plane proof is green
  before Gate C; S7 repeats the saturated path through managed OpenClaw.

Slices 5 and 6 may run in parallel only after Tool Portal/control contracts are
frozen and their Gateway-runtime directories are disjoint.

## Integration gate C — real backends

Before framework cutover:

- all three backend kinds use one service and one approval state machine;
- MCP and UDS matched cohort is green;
- real `sandbox_ssh` and real `controller_rpc` paths are green;
- artifact readback works on both paths;
- aggregate provider and third-adapter imports fail structurally;
- no plugin production file owns ToolPortalService, lease, SSH, or controller
  policy in the target diff prepared for Slice 7.

Gate C uses one permanent E2E-only harness built from the production Gateway
runtime entrypoint and real controller boundaries. The harness is excluded from
production exports and configuration and cannot add a production selector,
second service host, or alternate controller orchestration path. Source/package
guards enforce that exclusion.

## Common lifecycle cut gate D — parent-owned

Before S7/S8 framework work can run in parallel, hard-cut
`GatewayProcessSpec` to exact `direct-gateway-process` and
`managed-framework-runtime` payloads, add the isolated
`gateway-lifecycle/runtime-contracts` child recipe, convert Worker to direct,
and land framework-neutral Gateway-runtime supervision plus controller
sole-runtime admission. A fixed Gateway-runtime service descriptor outside
framework lifecycle packages owns runtime bootstrap/start/readiness/routes;
managed lifecycle packages return only typed child recipes. The parent owns
shared manifests, aliases, image/test-taxonomy wiring, controller registry/
orchestrator seams, and runtime records.

Gate D proof builds/types/checks declarations and packed packages, proves the
managed controller branch never executes framework commands directly, and runs
Worker unit plus real Worker behavior before either framework lane begins.

## Slice 7 — OpenClaw managed-runtime hard cutover

Source: R5a–R6a and the OpenClaw bridge contract.

### Red first

- Make old undifferentiated GatewayProcessSpec, OpenClaw direct process, Worker
  wrong discriminator, second client/service, pre-attach dispatch, wrong or
  duplicate reservation, expiry, spawn failure, signal, timeout, disconnect,
  late terminal, PTY/stdin/EOF, and finalize mismatch fail tests.

### Implement

- Consume Gate D's managed discriminant and child recipe. OpenClaw returns only
  its managed recipe; controller starts Gateway runtime as the only admitted
  guest service, and runtime supervises the child and reports readiness
  after required planes.
- Plugin constructs one long-lived GatewayRuntimeClient, derives trusted
  per-invocation context, registers thin framework-native tools/sandbox
  adapters, and owns no service/control/lease/SSH/policy state.
- Managed Gateway loads the Tool Portal semantic snapshot compiled from
  `mcp.config.jsonc` plus `tool-portal.config.jsonc`. Remove the transitional
  managed projection from `mcp-portal.config.jsonc`; retain that file and its
  bearer/HMAC fields only for the independently runnable standalone/external
  MCP Portal path.
- BuildExecSpec returns only the fixed SDK bridge entrypoint plus the non-secret
  operation ID. Dispatch begins after current-epoch attachment and atomic
  reservation consumption. Finalize uses authoritative remote evidence.
- Preserve bridge-local environment separation: the packaged bridge runs by
  absolute path with a fixed minimal environment; model-authored remote
  environment exists only in the pre-admitted operation.
- Delete plugin-owned control/SSH/Tool Portal runtime paths and the deprecated
  private `packages/openclaw-mcp-portal-plugin` package. Update manifests/lock in
  the same hard cut.
- Delete the obsolete `@agent-vm/tool-portal/in-process-entrypoint` export and
  runtime files/dependencies. Remove or make structurally unreachable the
  controller-owned OpenClaw process supervisor, process-epoch owner,
  `replaceCurrentProcess`, same-Gateway process-recovery coordinator, runtime
  handle fields, and guest helper. Framework death has only the atomic Gateway
  replacement path.
- Move OpenClaw session-key/agent-ID parsing behind the adapter/runtime
  validation boundary. A production-source/declaration/package guard forbids
  controller domains from importing OpenClaw or Hermes plugin packages; any
  retained `agent-vm` dependency on the OpenClaw plugin is build/image-discovery
  only and follows an exact build-module importer allowlist.
- Preserve selected OpenClaw `2026.6.8` and image secret boundaries.

### Green

- Unit/integration and packed host e2e prove the full bridge state machine and
  zero forbidden plugin imports/residue.
- Source/declaration/module/tarball negatives prove the old in-process subpath,
  same-G process symbols, and controller-to-plugin reverse imports are absent.
- Process inspection proves one controller-admitted runtime, its directly
  supervised OpenClaw child, and one plugin client.
- Real OpenClaw no-skip lane proves Tool Portal capabilities, sandbox work,
  bridge I/O/finalization, artifact/approval, runtime/framework death replacing
  the Gateway, Tool leaf replacement, and no same-VM restart.
- Gate D's real Worker receipt remains green after S7 manifest/lock changes.

## Slice 8 — Hermes Gateway and BaseEnvironment

Source: primary R5/R6a/R34b and retained Hermes behavior/proof sections.

### Red first

- Add TS lifecycle failures for wrong process discriminant and forbidden
  ManagedVm/Gondolin/OpenClaw dependency.
- Add Python fixtures for CWD/export snapshot, missing-CWD fallback, re-entrant
  execute_code polling, operation-group/active-use ownership, foreground and
  background ProcessHandle behavior, cancellation, ambiguity, replacement, and
  stale handles.

### Implement

- Add `@agent-vm/hermes-gateway` TypeScript host lifecycle producing a typed
  `managed-framework-runtime` child recipe.
- Add Python Hermes adapter that constructs one GatewayRuntimeClient only and
  maps BaseEnvironment/ProcessHandle semantics onto protected UDS operations.
  Python never imports controller, Socket.IO, lease, SSH, ManagedVm, or
  Gondolin code.
- Add reproducibly pinned Hermes artifact/image provenance and a dedicated
  `*.hermes.e2e.test.ts` taxonomy/project/evidence wrapper.
- Complete the production composition cut: gateway type/config projection,
  system validation/path resolution, framework-neutral controller runtime/
  registry dispatch, orchestrator/runtime records, managed image base/manifest/
  generator and package installation, CLI validation, release inventory, E2E
  harness, and docs. Hermes registers into Gate D's neutral seam and does not
  copy OpenClaw orchestration.
- Fence one stable agent/profile/workspace/trusted-user-when-available identity
  per Hermes runtime; when trusted user is unavailable make no per-user claim,
  and reject unsupported multiplexing or process-global registry reuse across
  admitted identities.
- Preserve one re-entrant operation group/active use for non-local execute_code
  and loss of live process state across replacement while `/work` persists.

### Green

- Shared TS/Python fixtures and local process integration pass.
- Real no-skip Hermes lane proves boot/readiness, Tool Portal capability,
  terminal/file sharing, CWD/snapshot, execute_code re-entrancy, complete
  ProcessHandle lifecycle, cancellation/ambiguity, Tool leaf replacement,
  runtime/framework Gateway replacement, and contract parity through stock
  Gondolin.
- The retained live manifest also proves two independently admitted Hermes
  Gateway identities, bounded control reconnect without healthy leaf
  replacement, repeated SSH/Portal/queue/telemetry faults, identity isolation,
  and a measured stable no-flap window. Direct-MCP topology and same-VM child
  restart remain superseded.

OpenClaw and Hermes may run in parallel only after Gates C and D freeze the
shared runtime/client/lifecycle interfaces. Each then has independent files and
proof receipts.

## Slice 9a — atomic recovery and complete health convergence

Source: R35–R47 and the recovery, containment, restart, health, saturation, and
observability proof rows.

### Red first

- Add R37 regression: `/health` remains green while sustained accepted control
  is dead; current policy must fail it.
- Add table-driven missing-plane and cross-plane-reset failures for Gateway VM,
  runtime, framework, ToolPortalService/catalog, MCP provider, control, lease,
  active use, Tool VM, SSH, UDS, execution stream, and telemetry.
- Add telemetry-loss/exporter-pressure, repeated control/SSH/Portal/queue faults,
  transient reconnect, admission-class isolation, and measured no-flap failures
  using the existing control/lease reliability scenarios or an explicitly
  mapped exact-HEAD successor.

### Implement

- Remove only service-probe corroboration from sustained control-death recovery.
  Preserve source fencing, grace, thresholds, cooldown, failed-recovery budget,
  stabilization, in-flight exclusion, containment, no-flap, and escalation.
- Treat runtime/framework/UDS-fatal loss as Gateway replacement and Tool VM/SSH
  loss as leaf replacement. Include controller runners in Gateway parent
  fencing and controller-restart cleanup.
- Extend health/readiness/telemetry with independent reason/age/state and
  bounded cardinality. One green plane never resets another.

### Green and recovery/health checkpoint

- Unit policy proof makes sustained current-source control death independently
  recovery-sufficient while preserving grace, thresholds, cooldown, failed-
  recovery budget, stabilization, in-flight exclusion, no-flap, and escalation.
- Controller integration proves independent health reason/age and no cross-plane
  reset for every named plane.
- Real no-skip faults prove `/health` green plus control dead replaces the
  Gateway; runtime/OpenClaw/Hermes death replaces the Gateway; Tool VM/SSH death
  replaces only the leaf; controller restart adopts nothing; runner records are
  fenced; and active predecessor SSH writes cannot overlap successor rebind.
- Exact reliability evidence preserves transient reconnect, lease renew/
  reacquire, healthy Tool VM identity, stale-key rejection, four-class control
  admission, telemetry-pressure isolation, repeated faults, and stable no-flap.
- Unproven termination becomes owner-unsafe and blocks successor admission.
  Recovery/health must be green before enforcement, broad terminal gates, or
  beta may begin.

## Slice 9b — package, CI, release, and documentation enforcement

Source: retained Managed VM enforcement plus the package ceilings, CI/release,
documentation terminology, and artifact proof rows.

### Red first

- Add enforcement negatives for aggregate provider import, third adapter
  importer, native filesystem escape, old package name in canonical docs,
  missing exact-HEAD npm/Python artifact, omitted check gate, omitted real
  Gateway framework lane, and a skipped/zero live proof.
- Add evidence-manifest negatives for mixed HEAD, same-status/different-content
  diffs, stale markers, changed artifact/image hashes, omitted Python or
  framework lanes, and skipped/zero/todo results.

### Implement

- Generalize portal and Managed VM audits, declaration verifier, runtime module
  loader, docs terminology audit, and exact-HEAD inspector to all new npm and
  Python artifacts.
- Generalize the evidence manifest/validator across every live lane. Capture
  pre/post HEAD, a content-state hash over tracked/untracked diff bytes rather
  than filenames, exact npm/wheel/sdist hashes, image fingerprints, pinned
  framework/Gondolin versions, config revisions, runtime/generation identities,
  and run markers; reject mixed or changed state.
- Make `pnpm check` authoritative in CI; shard no-skip VM, OpenClaw, Worker, and
  Hermes jobs rather than demoting them. Add exact-HEAD artifact inspection to
  PR/release/local-publish prerequisites.
- Add the root uv workspace commands to the authoritative check orchestrator and
  CI: `uv sync --locked --all-packages`, `uv run ruff format --check python`,
  `uv run ruff check python`, `uv run ty check python`, and
  `uv run pytest python`. Build both artifacts with
  `uv build --package agent-vm-agent-portal-sdk` and
  `uv build --package agent-vm-hermes-gateway` into an inspector-owned clean
  directory. Add the new npm packages to full/overlay tarball inventories and
  prove no stale registry resolution.
- Extend image/package enforcement for the Gateway runtime package, private UDS
  runtime paths, packaged bridge entrypoint, generated Dockerfile installation,
  and image fingerprints. Missing packages, wrong paths, stale overlays, or
  exposed socket directories fail readiness.
- Reconcile README/docs map, architecture/subsystem/config docs, package
  READMEs, generated manual templates/tests, and stale
  `docs/subsystems/secrets-and-credentials.md` package names.

The Python type-checker cut is fail-closed: ty runs with Python 3.13 and
`[tool.ty.rules] all = "error"`, while Ruff `ALL` plus `ANN` owns annotation,
`Any`, unused-code, import, and style enforcement. ty directly covers missing
imports, argument/assignment/return mismatches, invalid calls and overrides,
unused awaitables, redundant casts, deprecations, and unused ignore comments.
Pyright's broad `reportAny`, `reportExplicitAny`, unknown-type reports, import
cycles, missing-stub report, and several style/unused reports have no one-to-one
ty rule; Ruff closes the overlapping annotation/style gaps, and this plan does
not claim the remaining differently modeled checks are equivalent.

### Green and enforcement checkpoint

- Every induced forbidden source/declaration/module/package/Python/docs variant
  fails the authoritative guard, and positive packages/wheels load only allowed
  dependencies.
- The exact-HEAD inspector performs a clean build, verifies the complete npm
  closure plus Python wheels/sdists, bridge entrypoint, and image metadata, and binds
  all hashes to unchanged HEAD.
- CI/release workflow unit/static tests prove `pnpm check`, no-skip real VM,
  OpenClaw, Worker and Hermes jobs, and exact-HEAD artifact inspection are
  mandatory. Sharding is allowed; inventory is not behavioral proof.
- The mandatory reliability wrapper preserves or explicitly maps every current
  control/lease scenario, and Python omission tests fail the check/CI plan.
- Canonical docs/manual templates use only hard package/runtime terms and match
  final config/routes/operator behavior.

## Slice 9c — terminal repository and beta proof

This slice starts only after the Slice 9a recovery/health checkpoint, Slice 9b
enforcement checkpoint, implementation-review swarm, accepted remediation, and
rerun of every affected owning-slice gate are green. It binds all proof to the
post-remediation exact HEAD, composes already-local proof, and owns no deferred
feature implementation.

### Terminal repository gates

Run and retain exact commands/counts/exit codes:

1. targeted slice unit/integration/host/VM/framework commands;
2. `pnpm check`;
3. `pnpm test:unit`;
4. `pnpm test:integration`;
5. `pnpm test:e2e:host`;
6. `pnpm test:e2e:inventory` — labelled inventory only;
7. `mise exec -- pnpm test:e2e:vm`;
8. `mise exec -- pnpm test:e2e:vm-mediation`;
9. `mise exec -- pnpm test:e2e:openclaw`;
10. `mise exec -- pnpm test:e2e:worker`;
11. `mise exec -- pnpm test:e2e:control-lease-reliability` or its mandatory
    scenario-mapped successor;
12. `mise exec -- pnpm test:e2e:hermes`;
13. `uv sync --locked --all-packages`, Ruff format/check, strict ty, and
    `uv run pytest python`;
14. clean `uv build --package` for both Python distributions;
15. `mise exec -- pnpm test:e2e` after it owns the required default lanes;
16. exact-HEAD npm tarball/image and Python wheel/sdist inspector from a clean
    source worktree.

The terminal evidence ledger separately accounts for every retained Managed VM
behavior: closed structural variants; neutral adapter translation; HTTP
mediation and ingress; managed image/cache fingerprints; strict SSH creation and
cleanup; unsupported backend variants; OwnedHostDirectory acquire/revalidate/
single-transfer/close; durable PID/start/command identity; controller restart;
real OpenClaw Gateway behavior; and real direct Worker behavior. A new higher
Gateway-runtime test does not replace these substrate receipts.

Each live receipt binds HEAD, content-state hash, package/wheel hashes, image
fingerprints, pinned framework/Gondolin versions, config revisions, runtime and
generation identities, and run-specific evidence markers.

### Beta proof — Luna xhigh Delegate

After the repo and package gates pass, verify the exact available Luna model ID
and xhigh reasoning option. Dispatch one bounded Delegate to:

1. run `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta` from this
   exact implementation HEAD;
2. verify beta resolves the freshly packed local package sources and image
   overlays, with no pnpm/Gondolin patch;
3. run beta static validation and its documented `mise exec -- pnpm build`;
4. start beta through its normal command, prove controller/Gateway/Tool Portal
   health, one portable capability, one real sandbox operation, and a scoped
   recovery/credential check required by the final diff;
5. capture package/image/config/runtime identities and bounded logs;
6. stop beta normally.

The Delegate first records beta HEAD and a content-state hash, classifies every
pre-existing change, and stops on overlap with sync/build/runtime outputs rather
than overwriting it. It verifies the complete new package/overlay inventory,
exact tarball hashes, resolved local `file:` sources, overlay hashes, and image
identities. Before start it proves no unowned beta controller is active; if one
exists it stops and reports. It records the exact process identity it creates,
captures bounded logs, and in `finally` stops only that process and proves its
absence. Unexplained pre/post beta drift invalidates the receipt.

The parent verifies the receipt and reruns cheap provenance/health checks. Beta
proof does not replace repository real VM/OpenClaw/Hermes evidence and never
touches a shared production process.

## Per-slice executable command ledger

Every listed target is a permanent planned file. The red command must fail on
the named new assertion before production implementation; the same command is
the green command afterward. Each file executes at least one test with zero
skip/todo; receipts record actual test/file counts and exit code. Live commands
also record the evidence-manifest identities described in S9b.

| Owner | Permanent targets | Red/green commands and prerequisites |
| --- | --- | --- |
| S1 | `packages/gateway-runtime/src/uds/managed-plugin-attachment-policy.unit.test.ts`; `packages/gateway-runtime/src/uds/gateway-runtime-paths.unit.test.ts`; `packages/agent-vm/src/integration-tests/gateway-runtime-vm-boundary.vm.e2e.test.ts` | targeted unit Vitest; after one parent build/image preparation, filtered `mise exec -- pnpm test:e2e:vm -- <vm-file>` |
| S2a | `packages/agent-portal-sdk/src/portable-contract-parity.unit.test.ts`; `python/agent-vm-agent-portal-sdk/tests/test_contract_parity.py` | targeted unit Vitest; `uv run pytest <python-file>`; `pnpm generate:portal-contracts -- --check-clean` byte-compares clean regeneration |
| S2b | `packages/gateway-runtime/src/uds/gateway-runtime-protocol.unit.test.ts`; `packages/gateway-runtime/src/uds/gateway-runtime-clients.integration.test.ts`; `python/agent-vm-agent-portal-sdk/tests/test_clients.py`; `packages/agent-vm/src/integration-tests/gateway-runtime-uds-pressure.vm.e2e.test.ts` | targeted unit/integration Vitest and pytest; after S1 runtime package and S2a contracts, filtered no-skip VM evidence |
| S3 | `packages/tool-portal/src/tool-portal-service.unit.test.ts`; `packages/gateway-runtime/src/tool-portal-projections.integration.test.ts`; `packages/agent-vm/src/integration-tests/tool-portal-cli.host.e2e.test.ts`; `packages/mcp-portal/src/standalone-mcp-portal.integration.test.ts` | targeted unit/integration Vitest; filtered host e2e after packed exact-HEAD CLI; standalone integration stays independent of Gateway runtime |
| S4 | `packages/agent-vm/src/controller/approval/approval-ledger.integration.test.ts`; `packages/gateway-runtime/src/artifacts/artifact-store.unit.test.ts`; `packages/agent-vm/src/integration-tests/tool-portal-artifact-cli.host.e2e.test.ts` | targeted unit/integration Vitest with crash cuts; filtered packed CLI host e2e after S3 |
| S5 | `packages/gateway-runtime/src/sandbox/sandbox-service.unit.test.ts`; `packages/agent-vm/src/integration-tests/gateway-runtime-sandbox.integration.test.ts`; `packages/agent-vm/src/integration-tests/gateway-runtime-sandbox.vm.e2e.test.ts` | targeted unit/integration Vitest; filtered stock VM evidence after backend-interface freeze and one image preparation |
| S6 | `packages/managed-vm/src/managed-vm-streaming.unit.test.ts`; `packages/agent-vm/src/controller/runner/controller-runner.integration.test.ts`; `packages/agent-vm/src/integration-tests/gateway-runtime-controller-execution.vm.e2e.test.ts` | targeted unit/integration Vitest; filtered stock VM evidence after Slice 1 containment and backend-interface freeze |
| Gate D | `packages/gateway-lifecycle/src/gateway-process-spec.unit.test.ts`; `packages/agent-vm/src/gateway/managed-framework-runtime.integration.test.ts`; Worker proof files | targeted unit/integration Vitest, build, typecheck, boundary/declaration guards, then `mise exec -- pnpm test:e2e:worker` |
| S7 | `packages/openclaw-agent-vm-plugin/src/execution-bridge.unit.test.ts`; `packages/agent-vm/src/integration-tests/openclaw-execution-bridge.host.e2e.test.ts`; `packages/agent-vm/src/integration-tests/gateway-runtime-openclaw.openclaw.e2e.test.ts` | targeted unit and host bridge proof, then filtered `mise exec -- pnpm test:e2e:openclaw` after Gates C/D and image preparation |
| S8 | `packages/hermes-gateway/src/hermes-lifecycle.unit.test.ts`; `python/agent-vm-hermes-gateway/tests/test_base_environment.py`; `packages/agent-vm/src/integration-tests/gateway-runtime-hermes.hermes.e2e.test.ts` | targeted unit Vitest and pytest, built-CLI Hermes config integration, then filtered `mise exec -- pnpm test:e2e:hermes` after Gate D/image preparation |
| S9a | `packages/agent-vm/src/controller/recovery/gateway-runtime-recovery.unit.test.ts`; `packages/agent-vm/src/controller/recovery/gateway-runtime-health.integration.test.ts`; reliability scenario manifest | targeted unit/integration Vitest and mandatory no-skip control/lease reliability command |
| S9b | `scripts/audit-gateway-runtime-boundaries.unit.test.ts`; `scripts/verify-gateway-runtime-evidence.unit.test.ts`; CI/release/manual tests | targeted script unit tests; new audit/evidence scripts; Python static commands; `pnpm check` |
| S9c | terminal list above and beta receipt | only after review remediation and affected slice reruns; commands start and end at one unchanged, clean source HEAD |

Targeted Vitest means `pnpm vitest run --config vitest.config.ts --project
<unit|integration> <file...>`. The parent may refine a filename before its first
red commit only when owner, layer, and proof stay explicit in the controller
brief. An S9b static guard rejects any ledger row missing target, red/green
command, layer, prerequisite, minimum count, or receipt identity fields.

## Requirements/proof matrix

| Requirement / claim | Source | Owner | Proof modality and layer | Evidence source | Freshness guard | Red/green | Size fit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hard package names, exact adapter fence, narrow ManagedVm capabilities, no patches/aliases | retained Managed VM spec; R20a | Gate A, S6, S9b, S9c | structural, declaration, module-load, exact tarball/wheel, real VM | parent repo gates | exact HEAD, clean artifacts | required for new guards | split enforcement early/late |
| One semantic ToolPortalService and immutable snapshot | R1–R7b, R11a | S3 | unit object identity, integration MCP+UDS, stock VM cohort | Portal/runtime tests | semantic revisions in receipt | required | fits S3 |
| Four managed MCP tools, thin CLI, and CLI artifact-read | R9, R11, R13a; CLI contract | S3, S4 | standard MCP integration and packed host e2e including authenticated bounded resource read | SDK/CLI tests | packed exact-head binary and artifact epoch | required | commands S3, artifact-read S4 |
| Trusted invocation context is server-derived, complete per R5d, and outside public arguments | R5d, R7b | S3 | one-client/multi-agent attacks varying every context field before visibility/routing | ToolPortalService/runtime tests | agent/subject/session/run/tool-call/workspace/environment/profile revision | required | fits S3 before admission |
| MCP remains bounded while protected UDS exposes only authenticated rich operation groups | R9–R10, R25b | S2b, S3 | declaration/module ceilings plus negative standard-MCP and authenticated-UDS integration | SDK/runtime surface tests | exact declarations and negotiated protocol version | required | client isolation in S2b, service projection in S3 |
| Standalone MCP Portal remains independently runnable | R7b; retained current behavior | S3, S9c | independent service integration plus terminal regression outside Gateway runtime | standalone MCP Portal tests | exact HEAD and service config | required | fits S3; rerun at terminal |
| TS/Python semantic parity and portable refinements | R8, R13/R13b | S2a, S2b | structural guard, shared fixtures, client integration, wheel inspection | generator + pytest/Vitest | fixture/schema hashes | required | generation in S2a, clients in S2b |
| Mandatory private-UDS handshake and attachment lifecycle | R21–R23, R49 | S1, S2b | hostile raw-client state machine plus stock VM path/lifecycle proof | handshake/runtime tests | epochs/client kind/agent set/attachment generation | required | groundwork S1, protocol S2b |
| UDS framing, bounded pressure, local escape | R21–R25b, R28 | S2b | unit codec/state, real local UDS, stock VM pressure | protocol counters | configured bounds/image | required | local and packaged VM proof |
| Control admission, reconnect, and lease continuity remain independent | R27, R35–R40 | S5, S9a, S9c | scheduler unit, identity-preserving integration, no-skip reliability manifest | control/lease receipts | exact HEAD, Gateway/Tool identities, stable window | required | migration S5, convergence S9a |
| Gateway VM trust boundary and reservation-only bridge admission | R5b–R5c, R49 | S1, S7 | attachment reducer, packed bridge host proof, exact stock VM process/path inspection | runtime/bridge e2e | epochs/generations/operation/image hashes | required | groundwork S1, bridge S7 |
| Cross-surface secret and authority custody | R51; retained Hermes proof | S1, S5, S7, S8, S9b | negative env/argv/file/work/log/telemetry/package scans plus stock VM inspection | custody and exact-artifact receipts | package/image hashes and runtime identities | required | local ownership per surface |
| Shared approval authority and atomic consumption | R54/R54a | S4–S6 | reducer/store unit, durable stateDir integration, audience/backend crash cuts | controller records | controller/Gateway epochs and revisions | required | common core then closures |
| Authenticated bounded artifact readback | R11c, R29/R31 | S4–S6 | store/quota unit, MCP/UDS/CLI/TS/Python integration, epoch VM proof | store counters | epoch/fingerprint/hash | required | core then closures |
| Real MCP to strict-pinned Tool VM | R12/R19/R38–R40a | S5, S7 | binding unit, SSH integration, neutral stock VM then OpenClaw repetition | real MCP receipts | Gateway/Tool generations/SSH fingerprint | required | before Gate C and repeat |
| Tool VM filesystem API remains contained by `/work`, VM, and owned-mount boundary | R52 | S5 | path-contract unit/integration and stock Tool VM behavior | SSH/VM receipt | Tool generation/mount identity/image | required | fits S5 |
| Neutral controller runner and fixed-argv artifact readback | R7a/R20a/R41a | S1/S6 | contract/adapter unit, durable integration, real VM crash cuts | runner records/VM receipt | VM/PID/start/generation | required | neutral exec, ledger, stream subtasks |
| Controller host actions use complete R17 recomputation and registered typed operations, never generic execute-command payloads | R7a, R14–R20a | S6 | field-mutation/policy unit, controller integration success/denial, structural route separation | runner/host-action tests | operation revision/fingerprint/exact HEAD | required | fits S6 before dispatch |
| Controller stream isolation, replay safety, and deadline saturation | R26/R26a | S6, S7 | state unit, neutral VM saturated route, managed OpenClaw repetition | high-water/deadline/sequence counters | current epochs/fingerprint/deadlines | required | before Gate C and repeat |
| Hard lifecycle process discriminant; Worker direct | R6a | Gate D | compile/unit, controller integration, declarations/packages, real Worker | process tree/runtime receipts | packed declarations/images | required | parent hard cut before S7/S8 |
| OpenClaw bridge/finalize fidelity | R5a–R5c | S7 | state unit, pinned host e2e, real OpenClaw VM | bridge operations | OpenClaw 2026.6.8/hash | required | fits S7 |
| Hermes BaseEnvironment/process/identity and production-composition fidelity | R34b and retained Hermes | Gate D, S8, S9a | shared fixtures, Python/TS/config integration, two-identity real Hermes/reliability VM | wheel/image/runtime receipt | pinned Hermes/wheel/config/identity hashes | required | neutral seam then S8 |
| Atomic Gateway/leaf/runner recovery and no adoption | R35–R42 | S5, S6, S9a, S9c | reducer/integration, real fault matrix/controller restart | runtime records/fault receipts | before/after identities | R37 required | backend semantics before convergence and terminal faults |
| Complete independent health vector and bounded/lossy telemetry | R43–R47 | S9a, S9c | table unit, integration fault ports, exporter-pressure and real faults/saturation | health/OTel/reliability evidence | marker/time/content state | required | deterministic/live split |
| Retained Managed VM behavior remains proven after neutral extension and runtime cutover | retained Managed VM spec and terminal evidence table | Gate A, S5–S7, S9b, S9c | structural variants, adapter translation, mediation/ingress, image/cache, SSH, ownership, identity, restart, real OpenClaw and Worker | retained and new parent-run proof lanes | exact HEAD, package/image fingerprints, runtime identities | required | early guards plus terminal behavioral ledger |
| Python quality and behavior are authoritative | R8/R13b/R34b; proof table | S2a, S2b, S8, S9b, S9c | locked uv, Ruff, strict ty, pytest, regeneration, wheel/sdist inspection | parent check/CI and slice tests | lock/schema/wheel hashes and exact HEAD | required | local red/green plus closure |
| CI/release/docs/evidence manifests enforce the whole boundary | proof table | S9b | negative workflow/evidence tests, docs audit, exact package/image gates | CI/release receipts | same content state and commit | required | fits S9b closure |
| Fresh beta behavior | goal/user instruction | S9c | deployment sync/build/runtime/fault proof | Luna xhigh Delegate + parent checks | exact HEAD/fresh tarballs | required | only after repo gates |

No row has a red/green waiver. Any task whose real gate cannot pass within its
scope is split before implementation; its requirement is not moved to a generic
terminal test task.

## Sidekick and Delegate write ownership

Use Sidekicks for sustained test-first slices and Delegates for bounded proofs.
Every packet names exact files, current HEAD, allowed imports, required red
command, green command, security context, stop condition, and receipt. Suggested
disjoint test-first ownership:

- S1: attachment policy/path tests and stock-VM boundary test;
- S2a: TS and Python parity fixtures;
- S2b: strict framing, UDS pressure, and isolated TS/Python client tests;
- S3: MCP/service identity tests, CLI host e2e, controller config tests;
- S4: approval crash cuts and artifact authorization tests;
- S5: filesystem attacks, process-handle semantics, real MCP-to-SSH e2e;
- S6: neutral exec/adapter tests, runner crash cuts, saturation harness;
- Gate D: Worker discriminator and neutral managed-runtime orchestration tests;
- S7: bridge state tests, plugin residue/reverse-import guards, OpenClaw tests;
- S8: Python BaseEnvironment tests and TS lifecycle/registry tests;
- S9a: individual health-plane and recovery fault tests;
- S9b: package/declaration/docs enforcement tests;
- S9c: bounded Luna xhigh beta Delegate after parent-run terminal gates.

The parent owns shared exports/manifests, generated-file integration, control
contracts, Gateway runtime composition, controller orchestrator, plugin cutover,
root package/lock/vitest/CI scripts, final merges of Sidekick changes, and all
broad validation.

## Rollback and recovery during implementation

- New packages and proofs may build before the cut, but no runtime flag or dual
  path ships. The OpenClaw cutover is one checkpoint.
- Runtime/image rollback always creates a fresh Gateway epoch and rotates
  credentials. Never restart an old framework under retained custody.
- Before reverting controller code, use the new code to fence and positively
  contain all Gateway, Tool VM, and runner records. Old code cannot start while
  new-format records might represent live VMs.
- Preserve malformed, mismatched, ambiguous, or owner-unsafe records. Cleanup
  failure is not permission to delete evidence or admit a successor.
- Artifact bytes may be discarded on epoch retirement. Approval and execution
  terminal evidence remains for its configured bounded retention.

## Replan and model-break triggers

Stop product edits and return to the shared model if any is true:

- exact stock QEMU cannot keep the fixed VM-local socket private to the Gateway VM
  or cannot prove current/stale attachment and direct-child lifecycle behavior;
- pre-identity runner survival cannot be contained or blocked owner-unsafe;
- approval consumption cannot be fsync-ordered atomically;
- a Node/WebSocket/library queue exceeds its declared cap or misses configured
  heartbeat/cancel/recovery deadlines;
- the selected OpenClaw build cannot support reservation-bound bridge
  attachment or finalize fidelity;
- the pinned Hermes BaseEnvironment contract materially differs from the
  retained source;
- any production code needs a Gondolin/pnpm patch, third adapter importer,
  native VM handle, general ManagedVm filesystem, compatibility alias, second
  semantic router, or controller-proxied persistent Tool VM bytes.

An unrelated test/tool/environment failure stops edits at the scope gate and is
reported separately; it does not authorize fixing that layer.

## Review and terminal workflow

1. The single `plan-review-swarm` and one parent remediation pass are complete;
   do not rerun either cycle.
2. `orchestrator-goal` records the transition to
   `implementation-execute-plan`.
3. Execute through S9b with local proof and checkpoint commits.
4. Run one implementation-review swarm, verify and remediate accepted findings,
   and rerun every affected owning-slice gate.
5. Run S9c exact-HEAD repository and Luna xhigh beta proof.
6. Open/update the PR and prove fresh checks, comments, unresolved threads,
   mergeability, package/image artifacts, and readiness. Do not merge.

## Open decisions

No product or architecture decision is open. Gate A validates source custody
and Slice 1 validates the private UDS and standard child-lifecycle groundwork.
If either fails, the plan returns to the accepted architecture with evidence
rather than selecting a different trust or process model.

phase_result: complete
evidence: `docs/plans/2026-07-12-agent-vm-gateway-runtime-implementation.md`
recommended_next_workflow: `shravan-dev-workflow:implementation-execute-plan`
recommended_transition_reason: The single plan review and remediation are complete; the plan now has source-mapped slices, executable red/green commands, exact authority and packaging cuts, fresh terminal ordering, and hard model-break gates.
