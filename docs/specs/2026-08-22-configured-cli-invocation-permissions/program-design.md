# Configured CLI Invocation Permissions Program Design

## Governing contract

- [Requirements](./requirements.md)
- [Specification](./specification.md)

The fixed goal is one generic invocation classifier for configured CLI
operations. It classifies an already tokenized invocation from its exact
admitted command path and present flags, applies
`deny > requires_approval > without_approval`, and lets the existing controller
execution and Hermes approval paths enforce the result.

The design is intentionally not a CLI grammar framework. It does not learn a
CLI's aliases, decompose compact short-option clusters, match positional values,
deliver credentials, or add a presenter. The same policy and evaluator support
many CLIs because each deployment authors only the exact paths, flag aliases,
and values that matter for its permission boundary.

## What changes and what remains authoritative

| Current owner | Current behavior | Target delta |
| --- | --- | --- |
| `packages/config-contracts/src/controller-configured-cli.ts` | Configured CLI owns admitted paths, denied argument patterns, stdin, timeout, and per-path `deny | allowed_values` flag rules. | Add the required invocation `calls` contract, hard-remove flag-rule `deny`, and validate normalized matcher uniqueness and admitted-path references. |
| `packages/tool-portal/src/cli-allowances/cli-allowance-validator.ts` | One pure validator resolves a command path and checks patterns, flag rules, and stdin, but returns only admitted or denied. | Evolve it into the single pure evaluator that returns the matched command, admission result, matching disposition facts, and effective disposition from a supplied namespace baseline. |
| `packages/tool-portal/src/tool-portal-service-common.ts` | `callPolicyDecision` selects denied, direct, or approval solely from namespace and operation name. | For `configured_cli`, validate exact public input and ask the shared evaluator for advisory invocation disposition. Other backends retain operation-level classification. |
| `packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts` | Registration validates configured CLI input and admission before dispatch. | Consume the same evaluator/projection so public parsing and Tool Portal advice cannot disagree about argv interpretation. |
| `packages/agent-vm/src/controller/control-session/gateway-control-controller-execution-authorization.ts` | Reloads the effective policy but authorizes configured CLI dispatch from operation-wide selectors. | Recompute exact invocation disposition from the current trusted operation and require it to agree with direct or reserved approval authority before execution. |
| `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts` | Materializes authored policy, safe Gateway projection, approval-access requirements, and semantic revisions. | Carry normalized invocation calls into effective policy and safe projection; include them in freshness and protected-call preflight. |
| `packages/gateway-control-contracts/src/gateway-runtime-portal-semantic-revision.ts` | Owns canonical managed Tool Portal binding revisions but currently hashes configured operations with authored array order. | Own one canonical invocation-call revision projection so semantic reordering is stable and meaningful matcher changes stale authority. |
| Existing controller approval ledger and Hermes adapter | Bind and present exact operation intent, then arm at most one approved dispatch. | Unchanged authority and lifecycle; invocation classification only determines which exact calls enter it. |
| Host and one-shot Managed VM configured CLI executors | Revalidate admission and execute exact argv on the configured target. | Retain target behavior and require a final current-policy authorized evaluation immediately before process creation; do not add a runner. |
| `tool_vm_runner` | Calls the current leased Tool VM over strict Gateway SSH. | Intentionally unchanged and does not consume configured CLI invocation policy. |

Current behavior is compatibility-bound by the merged controller-execution,
approval, target, and Tool VM contracts. The configured CLI policy format itself
uses a synchronized hard cut, so there is no migration phase with dual
authority.

## Structural crux and selected direction

The crux is where argv interpretation lives. Gateway advice and controller
authority must reach the same answer while the controller remains free to
reject advice produced under stale policy.

Three structures are credible:

1. Implement matching separately in Gateway Runtime and the controller. This
   keeps each caller local but creates two semantic authorities and makes drift
   likely around inline values, repeated flags, positionals, and `--`.
2. Let Gateway Runtime classify once and send the disposition to the
   controller. This avoids duplicated logic but turns advisory, potentially
   stale Gateway state into execution authority.
3. Put one pure evaluator below both callers. Gateway Runtime uses it for
   advice; the controller reloads current trusted policy and independently uses
   it before process creation.

The design selects option 3. The cost is a richer pure result and a baseline
input. Config and Tool Portal maintainers bear that cost. The gain is one argv
meaning with two independent policy reads, preserving controller authority.
Revisit only if a future CLI requires semantics that cannot be expressed by the
fixed exact-path and flag-predicate contract; such evidence would require a new
specification rather than hidden parser growth.

## Integrated system

```text
authored managed Tool Portal config
  namespace calls                         configured_cli operation
  operation-level baseline                exact paths + flag admission + calls
              │                                      │
              └──────────────────┬───────────────────┘
                                 ▼
                    effective config materializer
                    - strict cross-field validation
                    - normalized policy projection
                    - semantic/freshness revision
                                 │
                 ┌───────────────┴────────────────┐
                 ▼                                ▼
        Gateway-safe projection          controller-trusted snapshot
                 │                                │
        exact public call input                   │ reload on request
                 │                                │
                 ▼                                ▼
        shared pure evaluator             shared pure evaluator
        advisory disposition              authoritative disposition
                 │                                │
                 ├── deny ── bounded error        ├── mismatch/stale ── reject
                 ├── approval ── challenge        ├── deny ──────────── reject
                 └── direct ── authority RPC      └── authorized evaluation
                                                          │
                                               ┌──────────┴──────────┐
                                               ▼                     ▼
                                        final policy       final policy
                                        guard + spawn      guard + one-shot VM

SEPARATE AND UNCHANGED
tool_vm_runner ──► current leased Tool VM binding ──► strict SSH
```

The evaluator is shared code, not shared runtime state. Gateway Runtime and the
controller call it with different policy snapshots. Agreement proves the
request still carries the right authority; disagreement fails before any target
process begins.

## Components and singular ownership

| Component | Sole ownership | Consumers | Reason to change |
| --- | --- | --- | --- |
| Configured CLI invocation schemas | Matcher syntax, normalization constraints, hard-cut flag-rule union | Authored/effective config, JSON Schema, evaluator types | The portable permission contract changes. |
| Effective-config validator/projector | Cross-field admitted-path references, protected-call detection, safe projection, policy revision | Gateway startup, controller reload, approval preflight | Materialization or freshness rules change. |
| Gateway Runtime portal semantic revision | Canonical binding-revision material and stable semantic identity | Gateway fingerprinting, approval intent, controller freshness checks | Policy identity changes. |
| Configured CLI invocation evaluator | Exact command resolution, admission, flag occurrence interpretation, matcher truth, precedence, effective disposition | Tool Portal/Gateway Runtime, controller authorization, executor guard | Invocation semantics change. |
| Tool Portal policy decision | Surface/tool eligibility and advisory routing into denied, approval, or direct lifecycle | Managed Gateway call handling | Portal orchestration changes. |
| Configured CLI dispatch authority envelope | Exact direct binding or approval reservation plus Gateway binding revision | Gateway adapter, controller authorization, final executor guard | Authority transport changes. |
| Controller execution authorization | Current-policy reload, authority/disposition agreement, authorized-evaluation derivation, zero-effect rejection | Gateway Control controller-execution handler and target executors | Dispatch authority changes. |
| Controller approval ledger | Exact challenge, decision, reservation, expiry, and dispatch arm | Tool Portal and controller | Intentionally unchanged. |
| Hermes approval interaction | Native presentation and authenticated approve/deny callback | Existing framework approval bridge | Intentionally unchanged. |
| Configured CLI target executors | Exact argv execution and target-specific result certainty | Controller dispatcher | Intentionally unchanged. |
| Tool VM runner backend | Current lease binding and strict SSH execution | Tool Portal | Intentionally separate and unchanged. |

Allowed dependency direction is:

```text
config-contracts
      │ schemas and inferred types
      ▼
tool-portal/cli-allowances
      │ pure evaluation
      ├──────────────► gateway-runtime / Tool Portal advice
      └──────────────► agent-vm controller authorization
                              │
                              └──► existing target executors

effective Tool Portal config
      └──────────────► gateway-control-contracts semantic revision
                              └──► Gateway authority + controller freshness
```

Forbidden edges are:

- Gateway advice directly authorizing a process;
- caller input supplying a matcher, disposition, target, or namespace baseline;
- the evaluator reading config files, ledger state, clocks, processes, VMs, or
  framework state;
- controller authorization trusting a Gateway disposition without current
  recomputation;
- target execution accepting a bare boolean authorization or an authority
  created under a different binding revision;
- configured CLI policy acquiring a lease or calling Tool VM SSH;
- `tool_vm_runner` parsing configured CLI invocation matchers;
- a CLI-specific parser or credential mechanism entering the evaluator.

## Authored and normalized policy contracts

The strict authored contract follows the Specification exactly:

```ts
const ConfiguredCliInvocationFlagPredicateSchema = z
  .object({
    names: z.array(ConfiguredCliFlagNameSchema).min(1),
    values: z.array(ConfiguredCliArgvTokenSchema).min(1).optional(),
  })
  .strict()

const ConfiguredCliInvocationMatcherSchema = z
  .object({
    flags: z.array(ConfiguredCliInvocationFlagPredicateSchema).default([]),
    path: z.array(ConfiguredCliArgvTokenSchema).min(1).max(100),
  })
  .strict()

const ConfiguredCliInvocationCallPolicySchema = z
  .object({
    deny: z.array(ConfiguredCliInvocationMatcherSchema).default([]),
    requiresApproval: z.array(ConfiguredCliInvocationMatcherSchema).default([]),
    withoutApproval: z.literal('remaining_admitted'),
  })
  .strict()
```

`configuredCliPolicySchema` requires `calls`. Each matcher's `path` must equal
one admitted `commands[].path`. The schema normalizes semantic identity for
validation by treating predicate names, predicate values, predicates, and
matchers as unordered sets. It rejects duplicates within the place where the
Specification forbids them; it does not reorder the authored arrays or make
configuration order observable at runtime.

`configuredCliFlagRuleSchema` hard-cuts to the one admission rule:

```ts
const ConfiguredCliFlagRuleSchema = z
  .object({
    kind: z.literal('allowed_values'),
    names: z.array(ConfiguredCliFlagNameSchema).min(1),
    values: z.array(ConfiguredCliArgvTokenSchema).min(1),
  })
  .strict()
```

The effective controller operation retains the complete call policy. The
Gateway-safe configured CLI projection retains only the policy needed for exact
public-input admission and advisory classification. Neither projection carries
credentials, environment material, executable paths, image references, or
caller-selectable authority beyond its existing contract.

### Configured CLI dispatch authority

Gateway Control carries one strict configured-CLI authority union rather than
an optional approval field:

```ts
const ConfiguredCliDispatchAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('without_approval'),
    bindingRevision: z.string().min(1),
    fingerprint: z.string().min(1),
    operationId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('controller_approval_reservation'),
    reservation: GatewayRuntimeControllerExecutionDispatchReservationSchema,
  }).strict(),
])
```

The direct variant carries the existing Tool Portal direct fingerprint and
operation identity plus the exact Gateway binding revision from which they were
derived. The approval variant retains the existing reservation, whose binding
revision and exact intent already participate in ledger validation. Neither
variant accepts a disposition, matcher, or revision from model input.

Controller authorization returns a configured-CLI authorized evaluation, not
only a boolean. It binds the current operation, exact input, recomputed
disposition, current binding revision, authority kind, fingerprint/operation
identity, and target kind. The target path receives a code-owned callback that
reloads current policy and reproduces that evaluation. The host executor calls
it as its final asynchronous step and then synchronously validates the returned
evaluation before `spawn`. The Managed VM path supplies it to the existing
runner recomputation seam before VM creation and guest execution. A changed
revision, operation, target, admission result, disposition, or authority binding
fails before a process or VM is created.

## Shared evaluator interface

The pure evaluator owns one complete interpretation of configured CLI argv:

```ts
type ConfiguredCliInvocationDisposition =
  | 'deny'
  | 'requires_approval'
  | 'without_approval'

type ConfiguredCliOperationBaseline =
  | 'deny'
  | 'requires_approval'
  | 'without_approval'

type ConfiguredCliInvocationEvaluation =
  | {
      readonly kind: 'denied'
      readonly reason: ConfiguredCliAdmissionFailure
      readonly disposition: 'deny'
    }
  | {
      readonly kind: 'admitted'
      readonly argv: readonly string[]
      readonly matchedCommandPath: readonly string[]
      readonly disposition: ConfiguredCliInvocationDisposition
      readonly matchedDenyRule: boolean
      readonly matchedRequiresApprovalRule: boolean
    }

interface EvaluateConfiguredCliInvocationProps {
  readonly baseline: ConfiguredCliOperationBaseline
  readonly input: ConfiguredCliInput
  readonly policy: ConfiguredCliPolicy
}
```

The exact exported names may follow existing package naming, but callers depend
on these behavioral guarantees:

- the function is synchronous, deterministic, side-effect free, and total over
  schema-valid inputs;
- it resolves exactly one admitted command path under the existing
  no-overlap invariant;
- it performs existing pattern, allowed-value, stdin, and bound admission
  checks before returning an admitted result;
- it parses flag occurrences once from the argv tail and uses that same
  occurrence view for allowed-value validation and disposition matching;
- it evaluates every matcher and selects the strongest outcome independently
  of authored rule order;
- it never returns a weaker result than the supplied namespace baseline;
- positional tokens remain data, `--` does not stop inspection, the first `=`
  splits inline values for long and short flag names, and compact clusters
  remain opaque;
- errors remain bounded and do not echo stdin or uncontrolled argv content.

An admitted result exposes matched facts for proof and diagnostics, but these
facts are not accepted from callers and are not execution authority.

## Flag occurrence and matcher semantics

After exact command resolution, the evaluator derives a transient ordered list
of occurrences from the post-path argv tail:

```ts
interface ConfiguredCliFlagOccurrence {
  readonly name: string
  readonly inlineValue?: string
  readonly separatedValue?: string
}
```

The list is derived, never persisted. Every token beginning with `-` other than
the bare `--` creates its own occurrence. The first `=` splits an inline value
for both long and short names. A configured value-aware rule or predicate may
also view the immediately following token as the preceding occurrence's
separated value, but that view never consumes or removes the following token's
own flag occurrence. Therefore `--scope --force` can satisfy an allowed value
of `--force` for `--scope` while the independently derived `--force` occurrence
still matches a deny or approval predicate. The same inspection applies after
the bare `--` sentinel.

A predicate without `values` matches presence of any listed exact name. A
predicate with `values` matches when one occurrence has an exact listed name and
exact inline or separated value. Repeated flags provide multiple candidate
occurrences; one matching occurrence satisfies the predicate. Different
predicates are AND, names/values within one predicate are OR, and matchers
within one bucket are OR.

```text
one matcher
  exact command path
  AND
  predicate 1: name A OR alias B; optional value X OR Y
  AND
  predicate 2: name C; optional value Z

one bucket
  matcher 1 OR matcher 2 OR ...
```

The evaluator does not infer whether an arbitrary following positional token is
semantically a value for an unconfigured flag. Only authored predicates and
`allowed_values` rules ask for values, keeping the system at the fixed
command-and-flag contract rather than recreating each CLI grammar.

## Current-to-target call paths

### Advisory classification

```text
CURRENT
Tool Portal call entry
  ──► callPolicyDecision
      reads surface/tool selectors + operation-name call selectors
  ◄── denied | requires-approval | without-approval
      [configured argv does not affect disposition]

TARGET
Tool Portal call entry
  ──► callPolicyDecision
      reads surface/tool selectors + operation-name baseline       [changed]
      ──► configured operation lookup + public input validation     [added]
      ──► shared invocation evaluator                               [added]
          reads safe projected policy; no side effects
      ◄── deny | requires_approval | without_approval               [changed]
  ◄── existing bounded denial | approval lifecycle | direct path    [unchanged]

Evidence anchors:
  packages/tool-portal/src/tool-portal-service-common.ts
  packages/gateway-runtime/src/backends/controller-execution-gateway-control-adapter.ts
  packages/tool-portal/src/cli-allowances/cli-allowance-validator.ts
```

### Controller-authoritative dispatch

```text
CURRENT
Gateway Control request
  ──► authorizeGatewayControlControllerExecution
      reloads effective config and operation-wide selectors
      checks direct request OR approval reservation
  ◄── authorized | bounded policy rejection
  ──► existing configured target executor on authorization

TARGET
Gateway Control request
  ──► authorizeGatewayControlControllerExecution
      receives direct binding + binding revision OR approval reservation [added]
      reloads current effective config                              [unchanged]
      validates exact operation and RPC window                      [unchanged]
      derives current operation-name baseline                       [changed]
      ──► shared invocation evaluator                               [added]
          reads full trusted configured operation
      compares revision, exact binding, and disposition authority    [added]
      verifies freshness includes invocation calls                  [changed]
  ◄── authorized evaluation | bounded stale/mismatch/deny rejection [changed]
  ──► existing controller_host | ephemeral_managed_vm executor      [changed input]
      ──► final current-policy reload + evaluator                    [added]
      ──► compare authorized evaluation immediately before start    [added]
      side effect: zero or one process/VM creation                   [unchanged]

Evidence anchors:
  packages/agent-vm/src/controller/control-session/
    gateway-control-controller-execution-authorization.ts
  packages/agent-vm/src/gateway/mcp-portal-effective-config.ts
```

### Approval-required invocation

```text
agent exact call
  ──► Gateway advisory evaluator = requires_approval
  ──► existing portable challenge
  ──► existing Hermes native presenter
  ──► human approve | deny
  ──► existing private decision and identical retry
  ──► controller current-policy evaluator
      ├── still requires_approval + valid reservation ──► one dispatch
      └── direct | deny | stale | mismatch ─────────────► zero dispatch
  ◄── existing portable exact result
```

No edge is added to an OpenClaw or Worker presenter. No approval state or
transition is added; the existing exact-intent state machine is reused.

## Authority agreement and failure containment

The controller compares two independent facts:

| Gateway request authority | Current controller disposition and revision | Result |
| --- | --- | --- |
| direct binding | `without_approval`, same binding revision and exact binding | final guard may dispatch at most once |
| direct binding | `requires_approval`, `deny`, or changed binding revision | reject; zero process creation |
| approval reservation | `requires_approval`, same binding revision and exact reservation | continue existing reservation checks; final guard may dispatch at most once |
| approval reservation | `without_approval`, `deny`, or changed binding revision | reject; zero process creation |
| either | admission failure | reject; zero process creation |
| authorized evaluation | final guard sees any revision, operation, target, disposition, or binding mismatch | stale-policy rejection; zero process creation |

Policy-unavailable, malformed projection, invalid public input, admission
failure, matcher failure, unsupported presenter, missing approval access,
direct-binding mismatch, reservation mismatch, final-guard mismatch, and
target-authority mismatch all fail before process creation. Existing
result-certainty rules take over only after the final guard has passed and the
existing executor starts its target.

There is no retry inside classification. Tool Portal retains its existing exact
approval retry; the controller reload on that retry is the recovery source of
truth. Mixed batches retain item-level independence: one denied or protected
item neither replays nor suppresses a different direct item.

## Consistency, ordering, and freshness

The authored config and effective projection are generation-scoped immutable
values. Evaluation itself has no mutable state and is safe under concurrent
calls. Gateway Runtime can classify calls concurrently from one generation.
Controller authorization independently loads the current generation for each
dispatch request.

The Gateway Runtime portal semantic-revision component owns a dedicated
canonical invocation-call revision projection before deriving the existing
binding and applicable runtime revisions. It preserves the `deny` and
`requiresApproval` buckets and exact token order within each command path, while
sorting predicate names, predicate values, predicates within a matcher, and
matchers within each bucket by their canonical JSON semantic identity. The
literal remaining-admitted rule is included. Runtime policy arrays retain their
authored order because evaluation is order-independent.

Therefore:

- semantically equivalent reordering does not create different policy meaning;
- changing a path, name, value, or bucket changes policy freshness;
- old direct authority, challenge, or reservation cannot survive a semantic
  policy change;
- direct and approval authority carry the relevant binding revision through
  Gateway Control and the final pre-start guard;
- concurrent requests under the same generation remain independent;
- no lock, ledger, cache, or reconciliation system is added.

The synchronized cutover updates authored config, effective config, safe
projection, generated JSON Schema, examples, manuals, and in-repository
fixtures together. Old `flagRules.kind: "deny"` and missing
`configured_cli.calls` fail parsing. Rollback is source/config rollback as one
cohort; mixed old/new policy readers are unsupported.

## Protected-call preflight

Effective configuration derives whether a visible configured CLI can produce
`requires_approval`:

```text
operation is tool-visible
AND operation baseline is without_approval
AND configured_cli.calls.requiresApproval is non-empty
  ──► protected calls are effectively possible
```

An operation selected directly by namespace `calls.requiresApproval` remains
protected regardless of invocation matchers. Either case requires the existing
managed-Gateway approval authority and Hermes presenter preflight. Empty
approval matchers under a direct baseline do not create that requirement.
Registered actions and `tool_vm_runner` retain their existing preflight logic.

## Generic CLI applicability and `gog` fixture

The engine knows no executable names. A deployment can use the same matcher for
any configured executable whose meaningful permission boundary is expressible
as exact command paths plus flags.

Representative `gog` grammar exercises the generic seams:

```text
gog drive ls
gog calendar events
gog gmail send
gog drive delete <fileId> --permanent --force
```

A realistic policy can admit `drive delete`, require approval when
`--permanent` is present, and deny a selected flag combination without adding
`gog` code to Agent VM. Aliases such as `drive | drv`, `delete | rm | del`, and
`--force | --yes | --assume-yes | -y` are exact authored paths or flag names;
Agent VM does not infer their equivalence.

These fixtures prove portability of the argv contract. They do not authorize
or implement OAuth, keyrings, access tokens, ADC, service accounts, or any
credential-bearing environment. Authenticated ephemeral CLI execution requires
a separately authorized credential-delivery contract. Tokens are never
smuggled into argv or added to this policy.

## Proof architecture

The proof pyramid deliberately concentrates semantic coverage in the pure
evaluator, then uses fewer broad tests to prove authority and runtime wiring.

### Pure schema and evaluator matrix

| Area | Cases that must be distinguished | Observation |
| --- | --- | --- |
| Strict policy shape | required `calls`; defaults for both matcher arrays and matcher `flags`; literal remaining-admitted; unknown fields; old deny flag rule | parse success or exact bounded failure |
| Cross-field paths | exact admitted path; missing path; proper prefix; longer path; same path across buckets | valid reference or config rejection; cross-bucket overlap remains valid |
| Duplicate semantics | duplicate names; duplicate values; reordered duplicate predicates; reordered duplicate matchers; same path with distinct predicates | forbidden semantic duplicates reject; distinct matchers remain valid |
| Command resolution | exact one-token and multi-token paths; ordinary positional tail; non-matching path; path-prefix ambiguity blocked by schema | matched path or admission denial |
| Flag presence | long and short names; exact aliases; unknown flag; compact cluster; repeated flag; flag before/between/after positionals | exact authored occurrence behavior |
| Values | inline `--x=v` and `-x=v`; separated `--x v`; flag-shaped separated value that remains independently inspected; missing value; allowed/unlisted value; repeated mixed values; exact case and punctuation | predicate/admission result uses the one preserved exact interpretation |
| `--` | matcher flag before and after sentinel; sentinel alone; positionals around sentinel; flag-shaped separated value after sentinel | sentinel is not a policy-inspection escape |
| Predicate algebra | empty flags; one presence predicate; name aliases; value alternatives; two conjunctive predicates; unsatisfied conjunct | whole-path, OR-within, AND-between semantics |
| Matcher algebra | one matcher; alternative matchers; overlapping deny and approval; nonmatching rules; reordered rules | all matches collected; order independence |
| Baseline strengthening | denied, approval, and direct baselines crossed with no match, approval match, deny match, both matches | result never weakens baseline |
| Canonical Things cases | `complete item --task`; `complete item --project`; project edit complete/cancel; both task/project | direct, deny, approval, and deny precedence |
| Representative `gog` cases | drive/calendar/gmail paths; authored aliases; permanent/force presence and values; delete with positional file id | CLI-independent exact-path/flag behavior |
| Existing admission | denied patterns; stdin none/bounded/json; allowed values; invalid timeout input | every failure contributes deny before disposition |
| Diagnostics | very long/control-free argv and invalid stdin/pattern outcomes | bounded error; no stdin or uncontrolled argv echo |
| Semantic revision | reorder-only names/values/predicates/matchers; path token order; path/name/value/bucket mutation; remaining rule | canonical call projection keeps semantic reorder stable; meaningful mutation changes revision |

The core precedence cross-product is exhaustive, not sampled:

| Baseline | Approval match | Deny match | Effective result |
| --- | --- | --- | --- |
| `without_approval` | no | no | `without_approval` |
| `without_approval` | yes | no | `requires_approval` |
| `without_approval` | no | yes | `deny` |
| `without_approval` | yes | yes | `deny` |
| `requires_approval` | no | no | `requires_approval` |
| `requires_approval` | yes | no | `requires_approval` |
| `requires_approval` | no | yes | `deny` |
| `requires_approval` | yes | yes | `deny` |
| `deny` | no | no | `deny` |
| `deny` | yes | no | `deny` |
| `deny` | no | yes | `deny` |
| `deny` | yes | yes | `deny` |

### Integration seams

| Seam | Real components | Replaceable boundary | Required observation |
| --- | --- | --- | --- |
| Authored to effective config | Real Zod schemas, config materialization, safe projection, semantic revisions | Image/provider preparation may remain fake when unrelated | strict cutover, exact projection, protected-call requirement, freshness mutation |
| Gateway advice to controller recomputation | Real Tool Portal decision, Gateway authority payload, controller authorization, final host/VM guard | Process/VM creation replaced with a dispatch counter | same-policy agreement; policy mutation that remains direct, forged direct/approval mismatch, and mutation between authorization and start produce zero dispatch |
| Mixed batch | Real Portal item orchestration and approval challenge creation | Framework presenter and executor controlled at their existing seams | direct result retained, protected challenges independent, deny zero effects, stable order/status |
| Registered action regression | Real operation-level selector and authorization | Existing reviewed executor seam | no invocation matcher behavior leaks into registered actions |
| Tool VM regression | Real Tool VM backend routing | SSH transport may use existing fake at integration level | strict SSH path used and zero controller-execution RPCs |

### Runtime proof floor

| Runtime seam | Must be real | Observation |
| --- | --- | --- |
| Host configured CLI | Controller request path and host executable | direct and approved exact argv each create one effect; denied and unapproved create zero |
| Ephemeral configured CLI | Prepared immutable image, real one-shot Managed VM lifecycle, guest command | same disposition outcomes plus existing timeout, cleanup, containment, and target identity evidence |
| Hermes | Real adapter, active native interaction, controller ledger and retry | one protected approve dispatches once; deny dispatches zero; direct/denied calls never prompt |
| Tool VM | Existing leased Tool VM and strict SSH path | behavior unchanged and no per-command controller-execution RPC |

Synthetic tables are authoritative because they cover the complete algebra.
Things and `gog` cases are permanent representative fixtures proving the engine
serves materially different CLI shapes without CLI-specific code.

## Requirement realization

| Requirement | Structural realization | Primary proof seam |
| --- | --- | --- |
| U1-U3 | Required strict calls policy plus pure exact-path/flag evaluator | Schema/evaluator matrix and representative CLI fixtures |
| U4 | Fixed precedence fold over baseline and all matched buckets | Exhaustive baseline/match cross-product and rule-order permutations |
| U5 | One occurrence parser shared by existing admission and disposition matching | Path/position/alias/value/repetition/`--` unit tables |
| U6 | Gateway authority envelope plus controller recomputation and final pre-start revision/disposition guard | Authority mismatch, remains-direct policy mutation, and authorization-to-start mutation integration with dispatch counts |
| U7 | Evaluator before the unchanged target dispatcher | Host and real Managed VM runtime proofs |
| U8 | Existing exact challenge and Hermes-native interaction reused | Real Hermes approve/deny/no-prompt proof |
| U9 | No dependency edge from Tool VM runner to invocation evaluator or controller execution | Integration and real Tool VM regression |

The load-bearing rules are enforced by strict schemas, inferred types, pure
automated behavior, controller runtime guards, semantic revisions, and real
effect-count observations. No manual policy judgment is required at dispatch.

## Design limits

This design spends complexity on one strict matcher schema, one pure evaluator,
two callers, and existing revision/preflight plumbing. It adds no durable state,
new RPC authority, parser plugin, policy service, presenter, executor, lease,
credential path, expression language, or compatibility shim.

The deployment operator pays the explicitness cost of authoring aliases and
meaningful flags. That is intentional: the operator, not Agent VM, knows which
CLI version and flag meanings are trusted. A future request for positional
matching, response-file expansion, semantic alias discovery, or authenticated
ephemeral credential delivery reopens the observable contract rather than
silently expanding this evaluator.
