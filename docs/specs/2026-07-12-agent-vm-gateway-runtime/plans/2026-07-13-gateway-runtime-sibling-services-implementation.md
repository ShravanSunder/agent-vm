# Tool Portal, OpenClaw, And Hermes Beta Completion Plan

Date: 2026-07-19
Status: user-corrected and ready for direct beta execution
Goal: `2026-07-19-openclaw-hermes-tool-portal-beta`

## Outcome

Make both real beta Gateways work through the designed common Tool Portal system:

- the existing OpenClaw `beta` Gateway;
- the dedicated `hermes-beta` Gateway;
- at least two configured agents/profiles in each Gateway;
- one common managed Tool Portal service contract for both frameworks;
- private UDS from each framework adapter to Tool Portal;
- one isolated Tool VM binding and maintained SSH connection per agent/profile;
- unrestricted SSH Sandbox API behavior inside the selected Tool VM;
- the separate Tool Portal Capability API;
- durable filtered `/workspace`, rootfs/COW `/work`, and controller-owned HTTPS workspace Git push;
- traces, logs, and metrics from the controller, Tool Portal, framework, and Tool VM operations in the same sink;
- GPT-5.6 Luna high acceptance for both Gateways;
- one implementation review/remediation cycle and a PR-ready, non-merged terminal.

Only packages and SDK surfaces required by these real beta paths are completion
gates. Existing standalone artifacts must not regress, but expanding standalone
behavior is not part of this goal.

## Hard Scope Rails

The following work is not part of this beta goal:

- backup-engine redesign;
- authoritative restore, rollback publication, or crash recovery;
- legacy archive or whole-zone Git migration;
- destructive administrative-consumer cleanup;
- repo-wide cleanup unrelated to a failing beta path;
- exhaustive fault permutations or performance-distribution studies;
- another spec or plan review/remediation cycle;
- Gondolin changes;
- OpenClaw or Hermes upstream source changes;
- a new launcher, supervisor, service graph, UID boundary, helper process, or
  compatibility path;
- npm/PyPI publication, release, production deployment, or merge.

If a real beta failure appears to require any of these, stop before editing that
architecture and bring the evidence and tradeoff to the user.

## Runtime Model

```text
host controller
  -> starts one Gateway VM from its existing lifecycle
       |
       +-- Tool Portal service sibling
       |     owns controller relationship
       |     owns per-agent Tool VM binding and SSH connection
       |     exposes private UDS inside the Gateway VM
       |
       `-- OpenClaw XOR Hermes framework sibling
             thin framework adapter
             one GatewayRuntimeClient
             private UDS
                  |
                  v
             Tool Portal service
                  |
                  +-- Capability API
                  |
                  `-- SSH Sandbox API
                        |
                        v
                   selected agent Tool VM
                   unrestricted shell/files/processes
                   within that Tool VM's mounts
```

UDS is only the framework-to-Tool-Portal transport inside the Gateway VM. Tool
Portal owns the Tool VM lease/binding and strict SSH connection. Capability API
calls and SSH Sandbox API operations are separate request surfaces even when a
capability implementation executes in the selected Tool VM.

Workspace Git push remains controller-owned HTTPS through Tool Portal. Tool VM
Git SSH remains read-only.

## Authoritative Sources

- `docs/specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md`
- `docs/specs/2026-07-17-agent-vm-storage-layout/2026-07-17-agent-vm-storage-layout.md`
- `docs/specs/2026-07-12-agent-vm-gateway-runtime/glossary.md`
- this plan
- `tmp/workflow-state/2026-07-19-openclaw-hermes-tool-portal-beta/details.md`

The storage spec applies only to the live workspace, Git, Tool VM layout, and
fresh-replacement paths exercised by beta. Its explicitly deferred backup,
restore, migration, and destructive-administration work does not enter this
plan.

The prior single spec and plan review/remediation cycles remain consumed. This
user-directed contraction does not start another review cycle.

## Current Checkpoint

Source checkpoint `52403524` contains the common Tool Portal/Gateway Runtime,
OpenClaw adapter, Hermes adapter/Gateway, managed Tool VM Sandbox API, controller
Git push, and exact OTLP mediation work needed for beta proof.

The main source worktree also contains unfinished backup/restore work from the
discarded S6 lane. Those files are unrelated dirty work for this goal: do not
edit, stage, package, or commit them.

The beta deployment is
`/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`. It already
contains the existing OpenClaw `beta` Gateway and authored `hermes-beta`
configuration. Preserve authored and pre-existing generated changes. Never
stage its local package-store cache.

## Remaining Execution

### B1. Prove the common real Tool VM path

Build once, then prove private UDS to Tool Portal to strict SSH to a real Tool
VM. The proof must cover unrestricted shell execution, file write/read,
`/workspace`, rootfs/COW `/work`, and one Capability API call.

### B2. Prove the OpenClaw framework path

Run the focused real OpenClaw fixtures. Then start the existing `beta` Gateway
and exercise both configured agents through real Discord turns. HTTP or direct
API probes may supplement this proof, but they do not replace Discord ingress.

Required beta behavior:

- native OpenClaw tool request reaches GatewayRuntimeClient;
- private UDS reaches the common Tool Portal service;
- the selected agent receives only its Tool VM binding and workspace;
- shell, file, edit, process, Capability API, and controller Git push work;
- configured-default-branch push is rejected;
- the second agent cannot reuse the first agent's binding, handles, or files;
- Sandbox operations keep the selected Tool VM lease, active-use heartbeat,
  binding, and SSH health green while their operation outcomes are surfaced;
- Capability list/search/describe/call operations, including one configured MCP
  provider call, surface successful Tool Portal outcomes and telemetry.

### B3. Prove the Hermes framework path

Run the focused real two-profile Hermes fixture. Then start `hermes-beta` and
exercise both configured profiles through real Discord turns. HTTP or direct
API probes may supplement this proof, but they do not replace Discord ingress.

Required beta behavior matches OpenClaw while preserving Hermes-native profile
routing and BaseEnvironment behavior. No implicit `default`, local execution
fallback, cross-profile binding, or shared process/file state is admitted. The
same positive Sandbox lease/heartbeat/binding/SSH health and Tool Portal
Capability-operation evidence required for OpenClaw is required for Hermes.

### B4. Prove replacement and storage once per framework

For one selected identity in each Gateway:

- make a durable `/workspace` edit;
- create disposable data under `/work`;
- force the normal unhealthy Tool VM replacement path;
- observe the old binding unrouted and closing while the successor boots;
- prove `/workspace` survives, `/work` is fresh, and only the successor routes.

Do not add backup, restore, project reconstruction, checkpoint/resume, or a new
fencing subsystem.

### B5. Prove the shared OTEL sink

Across the two serialized Gateway runs, query the existing collector/Victoria
stack for:

- controller signals;
- Tool Portal service signals;
- the selected framework signals;
- Tool VM operation spans/logs/metrics;
- one framework to UDS to Tool Portal to backend trace relation.

Use safe markers and verify no secret value or file content appears. Do not
build another observability stack or exhaustive telemetry fault suite.

### B6. Luna high beta acceptance

Run GPT-5.6 Luna high against OpenClaw `beta`, stop it cleanly, then run against
`hermes-beta`. The Gateways share Discord/service credentials and must not run
concurrently.

Luna verifies the same user-visible journeys above. The parent independently
checks critical runtime, filesystem, Git, identity, and OTEL receipts.

For both configured identities in both frameworks, Luna runs multiple sequential
Tool Portal calls, multiple parallel Sandbox calls, and a mixed parallel Sandbox
plus Capability API group. Every call must complete authoritatively and OTEL must
show distinct successful UDS/backend operations without cross-agent streams,
sessions, results, leases, or workspace access.

### B7. One implementation review and PR readiness

Run exactly one implementation review against the beta-proven HEAD. Fix only
accepted findings inside this goal, rerun affected focused proof, and prepare a
PR at the same HEAD without merging.

GitHub Actions availability is external. Do not poll or troubleshoot a platform
outage. If Actions remains unavailable, record local and beta proof as complete
and the remote CI receipt as externally blocked.

## Requirements And Proof

```text
claim                              required proof
---------------------------------  --------------------------------------------
common Tool Portal path            real VM UDS -> Tool Portal -> SSH -> Tool VM
OpenClaw beta                      two real configured agents
Hermes beta                        two real configured profiles
Discord ingress                    real turn for both identities in both Gateways
identity isolation                 distinct bindings, workspaces, handles
sandbox behavior                   shell, files, edit, process, terminal
Capability API                     list/call through common service
runtime health                      positive lease/heartbeat/binding/SSH evidence
Tool Portal health                 surfaced successful capability/backend outcomes
workspace durability               /workspace survives Tool VM replacement
hot-work semantics                 /work is rootfs/COW and is fresh after replacement
Git push                           controller HTTPS path; default branch rejected
observability                      all four service/operation sources in one sink
beta acceptance                    provider-verified Luna high for both Gateways
quality                            touched-package gates plus pnpm check
review                             one implementation review/remediation cycle
PR                                 exact beta-proven HEAD, not merged
```

No backup, restore, migration, destructive-consumer, exhaustive-fault, or
performance-benchmark receipt is required.

## Focused Validation

From the source repo:

```text
pnpm build

mise exec -- env \
  AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 \
  AGENT_VM_GONDOLIN_E2E=1 \
  pnpm tsx scripts/run-vitest-evidence-project.ts \
  e2e-vm \
  packages/agent-vm/src/integration-tests/gateway-runtime-sandbox.vm.e2e.test.ts

mise exec -- env \
  AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 \
  AGENT_VM_OPENCLAW_E2E=1 \
  pnpm tsx scripts/run-vitest-evidence-project.ts \
  e2e-openclaw \
  packages/agent-vm/src/integration-tests/openclaw-mcp-portal.openclaw.e2e.test.ts \
  packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts

mise exec -- env \
  AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 \
  AGENT_VM_HERMES_E2E=1 \
  pnpm tsx scripts/run-vitest-evidence-project.ts \
  e2e-hermes \
  packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts

pnpm check
```

When a focused failure leads to source changes, run the owned unit/integration
tests first and then rerun only the affected real framework lane plus
`pnpm check`. Broader unrelated proof is not a beta completion requirement.

From the beta deployment:

```text
mise exec -- pnpm validate
mise exec -- pnpm build

pnpm start:openclaw
pnpm stop

pnpm start:hermes
pnpm stop
```

The beta journeys, OTEL queries, and Luna receipts are runtime proof; successful
configuration validation or image build alone is not.

## Checkpoint Commits

Commit only when a scoped checkpoint is green:

```text
docs: focus Tool Portal plan on OpenClaw and Hermes beta
fix: <real OpenClaw beta blocker, if found>
fix: <real Hermes beta blocker, if found>
fix: <shared Tool Portal or OTEL blocker, if found>
test: prove OpenClaw and Hermes Tool Portal beta
```

Do not stage unrelated backup/restore files, beta package-store caches, or
pre-existing generated beta files whose ownership has not been established.

## Stop Conditions

Continue through beta proof without pausing at phase boundaries. Stop only when:

- a real beta failure breaks the accepted runtime model and requires architecture
  outside the hard rails;
- continuing risks user-owned data or secret exposure;
- required external authority is unavailable.

Ordinary build, test, image, startup, Tool Portal, framework, or OTEL failures
are implementation work, not reasons to expand the design.
