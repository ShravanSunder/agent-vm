# Configured CLI Invocation Permissions Specification

Requirements authority: [`requirements.md`](requirements.md)

## Observable model

```text
namespace call selector
  -> establishes operation baseline: denied | direct | approval

configured_cli argv
  -> existing admission checks
  -> command-path plus flag disposition matches
  -> strongest effective disposition

DENY > REQUIRES_APPROVAL > WITHOUT_APPROVAL
  -> reject | exact native approval | direct dispatch

controller
  -> reloads trusted policy and recomputes the same result before execution
```

## P1 — Current observable gap

Configured CLI policy currently validates command paths, deny patterns, stdin,
and per-command flag deny/value rules. Tool Portal then decides direct versus
approval-required from the operation name alone. Consequently, an operator must
split one CLI into multiple operation aliases to protect only selected flags,
and cannot express the confirmed `complete --project` versus
`complete --task` outcome inside one operation.

## O1 — Desired observable outcome

One configured CLI operation admits its normal tokenized grammar and derives a
deterministic disposition from the matched command path and flags present in the
exact invocation. Denial dominates approval; approval dominates direct use.

## R1 — Every invocation has one effective disposition

The effective disposition union MUST be exactly:

```ts
type ConfiguredCliInvocationDisposition =
  | 'deny'
  | 'requires_approval'
  | 'without_approval'
```

The total precedence MUST be:

```text
deny > requires_approval > without_approval
```

Evaluation MUST collect the namespace operation baseline, every applicable
admission outcome, and every matching configured-CLI call rule. The strongest
result is final. Rule order MUST NOT change the result.

Trace: U1, U3, U4.

## R2 — Existing namespace call selectors establish the baseline

The existing profile namespace `calls.withoutApproval` and
`calls.requiresApproval` selectors MUST continue to admit operation names
generically across backend kinds.

For a configured CLI operation:

- omission from both selectors establishes `deny`;
- effective admission through `calls.withoutApproval` establishes the
  `without_approval` baseline;
- effective admission through `calls.requiresApproval` establishes the
  `requires_approval` baseline;
- overlap between the two selectors remains a configuration error.

Invocation rules MAY strengthen that baseline and MUST NOT downgrade it. In
particular, no configured-CLI rule can make an operation selected through
`calls.requiresApproval` execute directly.

Registered actions and other backend kinds retain their existing operation-level
selector behavior.

Trace: U3, U4, U8, U9.

## R3 — Configured CLI declares strict invocation call policy

Every configured CLI operation MUST declare one strict `calls` policy:

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

Every matcher path MUST exactly equal one path in the operation's admitted
`commands` array. A missing or non-admitted matcher path MUST fail configuration
validation. Distinct normalized matchers MAY repeat the same admitted path.
The existing prohibition on duplicate or proper-prefix-overlapping paths in the
admitted `commands` array remains unchanged.

Names within one predicate and values within one predicate MUST be unique.
Semantically duplicate flag predicates inside one matcher and semantically
duplicate matchers inside one disposition bucket MUST fail configuration
validation. Array ordering MUST NOT create distinct policy meaning.

An empty `flags` array matches every admitted invocation of that exact command
path. This permits a whole command path to be denied or approval-required
without defining another operation.

`withoutApproval: "remaining_admitted"` is the sole supported direct-refinement
shape. Arbitrary allow rules, negative predicates, ordered rules, wildcard
paths, regex paths, and caller-authored disposition fields are rejected.

Trace: U1, U2, U3, U4.

## R4 — Matchers use exact path plus conjunctive flag predicates

A matcher applies only when:

1. the invocation resolved to the matcher's exact admitted command path; and
2. every flag predicate in that matcher is satisfied by at least one flag
   occurrence in the post-path argv tail.

Within one predicate, any listed `name` is an exact alias for satisfying that
predicate. Different predicates are conjunctive. Multiple matchers in one
disposition bucket are alternatives.

If `values` is absent, exact flag presence satisfies the predicate. If `values`
is present, the flag must have one listed exact value using the existing inline
or separated-value interpretation. A flag occurrence that lacks the required
value or carries an unlisted value does not satisfy that disposition matcher;
existing admission validation may still reject it independently.

For every long or short flag-shaped token containing `=`, the first `=` splits
the exact flag name from its inline value. Thus both `--flag=value` and
`-f=value` normalize to their exact configured names plus inline values.
Aliases remain exact independent names; `--force` does not imply `-f`. Compact
short-option clusters are not decomposed.

A flag-shaped token MUST remain independently subject to admission and
disposition inspection even when the same token is also interpreted as the
separated value of the preceding configured flag. For example, when
`allowed_values` admits `--scope --force`, a deny or approval predicate for
`--force` still matches. The token `--` creates no exemption from policy
inspection. Agent VM MUST NOT implement further CLI-specific parsing.

Positional tokens after the matched command path are ignored by disposition
matching. They remain ordinary admitted argv data and may occur before, between,
or after matched flags.

Trace: U1, U2, U4, U5.

## R5 — Admission and disposition are evaluated together without ambiguity

Existing command admission, denied-pattern, stdin, bound, timeout, and
allowed-value failures MUST contribute `deny` before process creation.

The existing `kind: "deny"` configured CLI flag rule is hard-cut from the flag
validation union. Equivalent path-scoped flag denial MUST be authored in
`configured_cli.calls.deny`. `allowed_values` remains a validation rule because
it constrains whether an invocation is admitted rather than assigning approval
posture.

The remaining flag-validation schema MUST be exactly:

```ts
const ConfiguredCliFlagRuleSchema = z
  .object({
    kind: z.literal('allowed_values'),
    names: z.array(ConfiguredCliFlagNameSchema).min(1),
    values: z.array(ConfiguredCliArgvTokenSchema).min(1),
  })
  .strict()
```

Unmentioned ordinary flags beneath an admitted command path remain admitted and
do not match a disposition rule merely because they are unknown. When no deny
or approval matcher strengthens an admitted invocation, the effective result
is its namespace-selector baseline.

Overlapping matchers across disposition buckets are valid and resolve by the
fixed precedence rather than author order. Exact duplicate matchers within one
bucket MUST fail configuration validation.

The confirmed examples MUST resolve as follows when the operation baseline is
`without_approval`:

| Invocation | Matching facts | Effective disposition |
| --- | --- | --- |
| `complete item --task` | admitted path; no deny or approval match | `without_approval` |
| `complete item --project` | admitted path plus deny flag predicate | `deny` |
| `project edit item --complete` | admitted path plus approval flag predicate | `requires_approval` |
| `project edit item --cancel` | admitted path plus approval flag predicate | `requires_approval` |
| `complete item --task --project` | direct remainder plus deny match | `deny` |
| admitted invocation matching approval and deny rules | both match | `deny` |

The corresponding configured-CLI policy fragment is:

```jsonc
{
  "commands": [
    { "path": ["complete"] },
    { "path": ["project", "edit"] }
  ],
  "calls": {
    "deny": [
      {
        "path": ["complete"],
        "flags": [{ "names": ["--project"] }]
      }
    ],
    "requiresApproval": [
      {
        "path": ["project", "edit"],
        "flags": [{ "names": ["--complete", "--cancel"] }]
      }
    ],
    "withoutApproval": "remaining_admitted"
  }
}
```

Within the approval predicate, `--complete` and `--cancel` are exact aliases for
satisfying the same predicate; either flag requires approval. Separate flag
predicate objects would instead require both flags to be present.

Trace: U2, U3, U4, U5.

## R6 — Gateway classification is advisory and controller classification is authoritative

Before reserving approval or direct dispatch, Tool Portal/Gateway Runtime MUST
classify the exact configured-CLI public input against its current effective
projection. A denied invocation returns the existing bounded proven
not-dispatched capability-denial outcome. An approval-required invocation enters
the existing item-level approval lifecycle. A direct invocation receives only
the existing direct-dispatch authority.

Before process creation, the controller MUST reload the current trusted
operation and independently repeat command admission, flag/value parsing,
matcher evaluation, precedence resolution, timeout resolution, target selection,
and policy-freshness checks.

The controller MUST reject:

- a direct request whose recomputed disposition is approval-required or denied;
- a request carrying an approval reservation whose recomputed disposition is
  direct or denied;
- any reservation or direct fingerprint created under a different invocation
  call policy.

Gateway acceptance alone is never execution authority.

Trace: U4, U6, U7.

## R7 — Invocation policy participates in exact freshness and approval intent

The normalized invocation call policy, including matcher paths, flag aliases,
values, disposition buckets, and the fixed remaining-admitted rule, MUST
participate in the existing configured-CLI semantic revision and direct/approval
fingerprints.

Changing any invocation rule MUST stale a challenge, reservation, or direct
dispatch authority created under the prior policy and MUST produce zero backend
effects under that stale authority.

Approval remains bound to the complete existing intent: trusted principal,
profile, capability identity, exact `argv`, `reason`, optional stdin, requested
and resolved timeout, execution target and immutable target revision, current
policy revisions, and presentation authority. No matcher or disposition field
is accepted from model input.

Trace: U3, U4, U6.

## R8 — Existing approval interaction and batch behavior are reused

An invocation classified `requires_approval` MUST use the existing managed
Gateway approval challenge, portable sanitized display, Hermes-native approve
or deny interaction, private decision operation, identical item retry,
controller reservation, and at-most-one dispatch behavior.

Mixed Tool Portal batches retain item-level independence. Direct items may
complete during the initial call and are not repeated. Each approval-required
item receives its own exact challenge. Denied items dispatch zero effects.

Hermes remains the only implemented native presenter. OpenClaw, Worker, and
unsupported Gateways continue to fail preflight when protected calls are
effectively possible; no presenter is added for them by this specification.

Static validation and Gateway preflight MUST treat a non-empty
`configured_cli.calls.requiresApproval` matcher set as effectively protected
when the operation is visible and admitted through the namespace's
`calls.withoutApproval` baseline. Such a zone requires the same sole
`managed_gateway` approval authority and native presenter capability as an
operation admitted directly through the namespace's `calls.requiresApproval`
selector. Empty matcher sets create no protected-call requirement by themselves.

Trace: U6, U8.

## R9 — Both controller targets share policy and retain their execution contracts

The same invocation matcher and precedence semantics MUST apply to
`controller_host` and `ephemeral_managed_vm`. Callers and matchers MUST NOT
select or override the configured target.

This specification changes no quick/open timeout, stdin, output, environment,
host-process, one-shot Managed VM, immutable-image, cleanup, containment, or
result-certainty obligation. Denial and unapproved outcomes occur before either
target starts a process.

Trace: U6, U7.

## R10 — Leased Tool VM execution remains separate

`tool_vm_runner` MUST retain its current operation-level Tool Portal call policy
and direct Gateway-to-current-leased-Tool-VM strict-SSH path. It MUST NOT parse
configured-CLI invocation matchers, send a per-command controller-execution RPC,
or acquire an ephemeral runner target.

Configured CLI execution MUST NOT acquire a Tool VM lease, SSH binding, or
current leased Tool VM identity.

Trace: U9.

## Observable contracts

### C1 — Operator configuration

An operator can place exact admitted command paths into deny and approval
matcher buckets, optionally requiring exact flag names and values. Direct use is
the remaining admitted invocation under the existing operation baseline.

### C2 — Agent call

The agent continues to submit only the existing generic configured-CLI input.
It cannot request a disposition. The returned portable item is denied,
approval-required, or an ordinary direct execution result according to current
trusted policy.

### C3 — Human approval

The human receives a prompt only when the exact invocation's effective
disposition is approval-required. Approval authorizes only an identical retry
under the same current policy; denial and stronger deny matches dispatch zero
effects.

### C4 — Controller execution

The controller starts the selected target only after its recomputed disposition
matches the presented direct or approval authority. Mismatch and stale policy
fail before process creation.

## Compatibility and cutover

This is a synchronized hard cut for `configured_cli` policy:

- `configured_cli.calls` becomes required;
- `flagRules.kind: "deny"` is removed and replaced by
  `configured_cli.calls.deny` matchers;
- operation-wide namespace call selectors remain the baseline;
- registered actions and other backend kinds retain their current call policy.

Authored and effective schemas, Gateway projections, generated JSON Schema,
manuals, examples, semantic revisions, and every in-repository configured CLI
fixture MUST move together. There is no legacy parser, implicit conversion,
deprecated alias, or dual policy evaluator.

Relative to the 2026-08-20 Configurable Controller Execution and Managed
Gateway Approval Specification, this specification supersedes R1 and R23 for
configured CLI invocation classification, supersedes R16's `kind: "deny"`
flag-rule shape, and extends the configured-CLI portions of R13, R20, and R21.
The prior requirements remain authoritative for registered actions, approval
presentation and decision behavior, execution targets, timeout, stdin, output,
environment, containment, and leased Tool VM separation except where this
specification explicitly says otherwise.

## Proof obligations

| ID | Observable obligation | Evidence class |
| --- | --- | --- |
| V1 | Strict authored/effective/Gateway schemas accept valid call policies and reject missing required policy, old deny rules, unknown fields, duplicate matchers, missing paths, malformed flags/values, and inapplicable variants. | Automated schema behavior and generated JSON Schema inspection |
| V2 | Exact-path, positional-tail, alias, inline/separated value, `--`, multi-predicate, multi-matcher, and unmentioned-flag tables resolve the expected matches without recreating CLI grammar. | Pure automated behavior |
| V3 | Precedence tables prove deny over approval over direct regardless of rule order, including `--task --project` and overlapping deny/approval matches. | Pure automated behavior |
| V4 | Gateway advisory classification and controller authoritative recomputation agree for direct, approval, and deny; forged/mismatched disposition authority fails before process creation. | Controller/Gateway integration with dispatch counts |
| V5 | A policy-only mutation invalidates prior direct fingerprints, challenges, and reservations and produces zero effects. | Semantic-freshness integration with state and side-effect inspection |
| V6 | A real host executable receives one direct allowed invocation, one approved protected invocation, and zero denied/unapproved invocations with exact argv transcripts. | Host end-to-end behavior |
| V7 | A real one-shot Managed VM produces the same disposition outcomes while retaining immutable target, timeout, cleanup, and containment evidence. | Real Managed VM integration |
| V8 | Hermes presents and approves one matched protected invocation, denies another, and never prompts for the direct or denied examples; observed effects are respectively one, zero, one, and zero as applicable. | Real Hermes interaction and controller-side effect inspection |
| V9 | Mixed batches preserve direct successes, independent protected challenges, denied zero-effects items, item order, and aggregate status. | Cross-process integration |
| V10 | Registered actions retain operation-level approval behavior, and `tool_vm_runner` retains direct leased-Tool-VM strict SSH with zero per-command controller-execution RPCs. | Integration and Tool VM regression evidence |
| V11 | A visible direct-baseline configured CLI with a non-empty approval matcher fails static validation and Gateway preflight when `approvalAccess` or a supported native presenter is absent, succeeds with Hermes and the sole managed-Gateway authority, and does not create that requirement when its approval matcher set is empty. | Static validation and Gateway startup/preflight integration |

Requirement coverage:

| Requirements | Problem | Outcome | Contracts | Proof |
| --- | --- | --- | --- | --- |
| U1, U2 | P1 | O1 | R1, R3-R5, C1-C2 | V1-V4 |
| U3, U4 | P1 | O1 | R1-R5, R8, C1-C3 | V2-V5, V8-V9, V11 |
| U5 | P1 | O1 | R4-R5, C1-C2 | V1-V3 |
| U6 | P1 | O1 | R6-R8, C3-C4 | V4-V5, V8-V9, V11 |
| U7 | P1 | O1 | R9, C4 | V6-V7 |
| U8 | P1 | O1 | R8, C3 | V8, V11 |
| U9 | P1 | O1 | R10 | V10 |

## Undefined behavior and negative space

- Positional values after the command path do not participate in disposition
  matching.
- An unmentioned ordinary flag is interpreted by the intentionally selected CLI
  version and remains subject to existing bounds and explicit policy.
- Agent VM does not infer aliases, compact option decomposition, response files,
  mutually exclusive flags, required flags, or command-specific semantic
  validity beyond the authored rules.
- A configured CLI upgrade remains an operator review of the admitted authority
  surface.
- Invocation policy does not add session-wide approval, new credentials, new
  execution targets, or new presenter implementations.
