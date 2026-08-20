# Configurable Controller Execution and Managed Gateway Approval Specification

## Authority and scope

This specification defines the observable configuration and runtime contract authorized by the [Requirements](./2026-08-20-managed-gateway-approval-presenter-requirements.md). It does not define internal component ownership or task order; those belong to the [Program Design](./2026-08-20-managed-gateway-approval-presenter-program-design.md) and implementation plan.

The confirmed goal is one generic managed controller-execution system: deployment configuration can expose target-neutral broad CLI allowances alongside typed registered actions, bind each broad operation to the controller host or an operation-scoped ephemeral ManagedVm runner, and present either operation through existing Tool Portal `requiresApproval` policy while preserving controller exact-intent authority. Shipping `tool_vm_runner` remains the separate current-leased-Tool-VM backend.

## Observable context

```text
deployment operator
  │
  ├── fixes operation, executable/prefix, commands, timeout class, target
  └── classifies operation as withoutApproval or requiresApproval
                              │
                              ▼
managed agent ── generic { argv, reason, stdin? } ──▶ Agent VM
                                                       │
                              ┌────────────────────────┴─────────────────────┐
                              │                                              │
                         direct admission                         controller challenge
                              │                                              │
                              │                                  native prompt + decision
                              │                                              ▲
                              └────────────────────────┬───────────────── human user
                                                       ▼
                                      trusted controller execution
                                               │
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                    controller host process       one-shot ephemeral ManagedVm

negative space: no caller-selected execution context, no shell evaluation,
                no per-command schema, no model-held approval proof,
                no manual controller call, no framework-specific call policy,
                no conflation with leased-Tool-VM `tool_vm_runner`
```

## Normative requirements

### R1 — Existing call policy remains the classification authority

Tool Portal profiles MUST continue to classify visible capability calls exclusively through the existing non-overlapping `calls.withoutApproval` and `calls.requiresApproval` selectors. The selectors MUST remain independent of managed framework type and backend kind.

If the same tool is effectively admitted by both selectors, static validation MUST reject the configuration. If a visible tool is admitted by neither selector, execution MUST remain denied.

Trace: U1, U3, U5 → O1, O3.

### R2 — Approval authorities use an explicit discriminated union

Each `zones[].approvalAccess.approvers[]` entry MUST declare exactly one authority variant:

```ts
type ApprovalAuthorityConfig =
  | {
      readonly kind: 'bearer'
      readonly approverId: string
      readonly secret: HostSecretReference
    }
  | {
      readonly kind: 'managed_gateway'
      readonly approverId: string
    }
```

The `kind` field MUST be the discriminant. Variant-inapplicable fields MUST be rejected. Existing bearer entries MUST cut over to `kind: "bearer"`; there is no implicit legacy variant.

`approverId` MUST remain unique within a zone. At least one configured authority MUST exist when any managed Tool Portal call is effectively admitted through `requiresApproval`.

At most one `kind: "managed_gateway"` authority MAY be configured per zone in this release. If more than one is configured, validation MUST reject the zone rather than selecting one by order. Bearer authorities MAY coexist with the one managed-Gateway authority.

Trace: U1, U3, U5 → O1, O3, O5.

### R3 — Managed-Gateway authority requires a native presenter capability

When `kind: "managed_gateway"` is configured, the selected managed Gateway lifecycle MUST declare that it supplies the native approval presenter capability. Hermes is the only lifecycle that declares and implements that capability in this release. Static validation or Gateway preflight MUST reject a Worker Gateway, OpenClaw Gateway, another unsupported managed Gateway, or a lifecycle whose runtime does not provide the declared capability.

No framework name is authored in Tool Portal capability policy. The configured zone Gateway selects the implementation.

Trace: U1, U4, U5 → O1, O2, O5.

### R4 — Each protected item receives an exact, bounded presentation request

For each item-level `approval_required` result, the framework bridge MUST construct one presentation request bound to that controller challenge and original call item. The request MUST contain:

- challenge identifier and expiry;
- original item identifier;
- capability namespace and name;
- bounded, redacted, human-readable call display;
- exactly the allowed decisions `approve` and `deny`.

The request MUST NOT contain controller credentials, reservation/grant material, raw secret values, or a model-asserted authority field. Display content informs the human but is not dispatch authority.

The presenter MUST bind each interaction to the originating authenticated framework surface/session and the exact presentation request. It MUST reuse that framework's existing actor-admission rule for the originating session; it MUST NOT invent a broader approval-only actor rule. Only an interaction from an admitted actor with the matching session and request binding MAY yield `approve` or `deny`.

An interaction from an unauthorized actor MUST NOT resolve or cancel the pending presentation, MUST NOT invoke the private controller decision operation, MUST leave the controller challenge pending and unchanged, and MUST produce zero backend effects. The framework MUST return bounded non-secret feedback to that actor. Native human identity remains framework-owned and MUST NOT be forwarded to the controller in this release.

The display MUST use the shared approval-display sanitization profile:

- maximum nesting depth: 6;
- maximum object entries or array items at one level: 32;
- maximum individual string length: 256 Unicode scalar values;
- maximum encoded argument preview: 4,096 UTF-8 bytes;
- keys matching credential shapes such as token, password, secret, authorization, cookie, API key, or private key MUST have their values replaced with `[REDACTED]`;
- credential-shaped string content MUST be replaced with `[REDACTED]`;
- omitted or over-bound content MUST be represented deterministically as `[TRUNCATED]` plus an omitted-count field.

This profile prevents credential disclosure; it is not general PII minimization. Frameworks MUST consume the portable sanitized display and MUST NOT re-read raw call arguments for rendering.

Trace: U2, U3, U4 → O2, O3, O4.

### R5 — Presenter outcomes are a discriminated union

The presenter MUST return exactly one outcome variant:

```ts
type ApprovalPresentationOutcome =
  | { readonly kind: 'approved' }
  | { readonly kind: 'denied' }
  | {
      readonly kind: 'cancelled'
      readonly reason: 'challenge-expired' | 'session-ended' | 'user-cancelled'
    }
  | {
      readonly kind: 'unavailable'
      readonly reason: 'presenter-missing' | 'presentation-failed'
    }
```

The discriminant MUST determine which fields are valid. `session`, `always`, YOLO, or another standing approval outcome MUST be rejected.

An unauthorized actor interaction is not a presenter outcome. The presenter continues waiting for an admitted actor, session end, cancellation, or challenge expiry.

Trace: U2, U3, U4 → O2, O3, O4.

### R6 — Only the controller records a decision

An `approved` or `denied` presenter outcome MUST be submitted through a private authenticated Gateway Runtime decision operation. The controller MUST derive zone, managed agent, profile, and Gateway authority from the accepted attachment/control session; those fields MUST NOT be accepted from public/model input.

The framework adapter MUST accompany the private decision request with the same non-public trusted invocation context used for the originating Portal call. Gateway Runtime MUST validate that context against the accepted attachment and derive the stable admission principal before sending the controller command. The decision payload itself remains limited to challenge id and decision.

The controller MUST confirm that:

- the zone configured a `managed_gateway` approval authority;
- the challenge exists and is pending;
- the challenge principal matches the authenticated managed Gateway principal;
- the challenge authority context and semantic revisions remain current;
- the challenge has not expired, been revoked, or already reached an incompatible terminal state.

Controller approval operator identity MUST be a discriminated union on `provenance`:

```ts
type ControllerApprovalOperatorIdentity =
  | {
      readonly provenance: 'approval-access'
      readonly approverId: string
      readonly audience: 'agent-vm-controller-approval'
      readonly credentialId: string
    }
  | {
      readonly provenance: 'managed-gateway'
      readonly approverId: string
      readonly audience: 'agent-vm-controller-approval'
      readonly stablePrincipal: string
    }
```

Variant-inapplicable evidence MUST be rejected. The controller MUST select the zone's sole managed-Gateway authority and derive `stablePrincipal`; neither value is caller-authored.

The controller records only the configured managed-Gateway authority and stable Gateway principal. It does not receive or authorize against the framework's native human identity.

Trace: U3, U4 → O3, O4.

### R7 — Decision results are explicit and fail closed

The private decision operation MUST return one result variant:

```ts
type GatewayApprovalDecisionResult =
  | {
      readonly kind: 'recorded'
      readonly state: 'approved' | 'denied'
    }
  | {
      readonly kind: 'rejected'
      readonly reason:
        | 'not-found'
        | 'expired'
        | 'stale-authority'
        | 'principal-mismatch'
        | 'already-decided'
        | 'presenter-not-authorized'
    }
```

A rejection, transport failure, unavailable presenter, cancellation, or timeout MUST NOT dispatch the protected backend call.

Trace: U2, U3 → O3, O4.

### R8 — Approval resumes only the identical item

After the controller records approval, the framework bridge MUST resubmit only the protected item using the same item id, namespace, capability name, arguments, and trusted principal. The controller MUST independently recompute and match the approval intent before issuing a one-use reservation.

Changed arguments—including an open operation's requested or resolved `timeoutMs`—changed execution target, or changed authority context MUST create or require a different challenge. No presenter outcome alone can authorize dispatch.

Trace: U2, U3 → O2, O3, O4.

### R9 — Batch partial success is preserved

For a batch containing approval-free and approval-required items:

- approval-free items MAY complete during the initial call and MUST NOT be repeated;
- every protected item MUST have an independent challenge and presentation outcome;
- only approved protected items MAY be resubmitted;
- denied, cancelled, unavailable, expired, or rejected items MUST remain proven not-dispatched;
- the final aggregate result MUST preserve original item ids and ordering.

The bridge MUST project every terminal interaction to an existing portable item-result shape:

| Interaction/controller outcome | Final item projection |
| --- | --- |
| Approved and exact retry returns a Portal item | Replace only the original protected item with that returned item, including any new `approval_required` challenge. |
| Denied and recorded | `status: "error"`, error/diagnostic code `capability_denied`, `retryable: false`, original proven not-dispatched outcome; remove the consumed challenge. |
| Cancelled because the challenge expired | `status: "error"`, code `timeout`, `retryable: false`, original proven not-dispatched outcome; remove the expired challenge. |
| Cancelled because the session ended or user cancelled | `status: "error"`, code `cancelled`, `retryable: false`, original proven not-dispatched outcome; remove the challenge from the final interaction result. |
| Presenter unavailable | `status: "error"`, code `provider_unavailable`, `retryable: false`, original proven not-dispatched outcome. |
| Decision rejected as not found | `status: "error"`, code `not_found`, `retryable: false`, original proven not-dispatched outcome. |
| Decision rejected as expired | `status: "error"`, code `timeout`, `retryable: false`, original proven not-dispatched outcome. |
| Decision rejected for stale authority, principal mismatch, or unauthorized presenter | `status: "error"`, code `not_authorized`, `retryable: false`, original proven not-dispatched outcome. |

If an approved decision submission returns `already-decided` or its transport result is unknown, the bridge MUST perform at most one identical Portal resubmission as reconciliation. The controller state then determines whether the item dispatches, returns a denial, or returns an approval challenge. A denied, cancelled, or unavailable presenter outcome MUST never use reconciliation that could dispatch.

After replacement/projection, aggregate `ok` MUST be recomputed using the existing Portal aggregate-status contract. Approval-free successes MUST remain byte-for-byte equivalent to their initial portable items.

Trace: U2, U3, U4 → O2, O3, O4.

### R10 — Existing bearer approval remains available

Bearer-configured approvers and authenticated controller approval HTTP routes MUST retain their current behavior after the explicit `kind: "bearer"` cutover. A managed-Gateway authority MUST NOT receive or reuse a bearer credential.

Trace: U1, U3, U5 → O3, O5.

### R11 — Framework failures remain non-authoritative

If the framework process exits, restarts, loses its surface session, or cannot render the prompt, the controller challenge MAY remain pending until its existing expiry, but no backend dispatch may occur. Recovery requires a new submission of the exact call and a current controller admission result; the framework MUST NOT reconstruct dispatch authority from local state.

Trace: U2, U3, U5 → O3, O4, O5.

### R12 — Diagnostics are bounded and non-secret

Validation, presentation, decision, and retry outcomes MUST expose bounded safe diagnostics sufficient to distinguish configuration denial, unauthorized native actor, presenter unavailability, human denial, expiry, stale authority, and successful dispatch. They MUST NOT expose raw credentials, native human identity, controller-only authority material, or unredacted sensitive arguments.

Trace: U2, U3, U5 → O2, O3, O4.

### R13 — Controller-owned operations use one explicit backend and operation union

A managed `controller_execution` backend MUST define a non-empty `operations` record. It replaces `controller_host_action` as the honest umbrella for controller-owned host and ephemeral-runner execution. Each record key is the operation name exposed in that namespace. Each value MUST parse as exactly one operation variant:

```ts
const ControllerRegisteredOperationSchema = z
  .object({
    kind: z.literal('registered_action'),
  })
  .strict()

const ControllerConfiguredCliOperationSchema = z
  .object({
    commands: z.array(CliAllowedCommandSchema).min(1),
    deniedPatterns: z.array(CliPatternRuleSchema).default([]),
    executablePath: z
      .string()
      .startsWith('/')
      .regex(/^[^\u0000-\u001F\u007F-\u009F]*$/u),
    executionTarget: ConfiguredCliExecutionTargetSchema,
    kind: z.literal('configured_cli'),
    mandatoryArgvPrefix: z.array(CliArgvTokenSchema).max(64),
    output: ConfiguredCliOutputPolicySchema,
    safeHelp: z.string().min(1).max(4_000),
    stdin: CliStdinPolicySchema.default({ kind: 'none' }),
    timeout: ConfiguredCliTimeoutPolicySchema,
  })
  .strict()

const ControllerExecutionOperationSchema = z.discriminatedUnion('kind', [
  ControllerRegisteredOperationSchema,
  ControllerConfiguredCliOperationSchema,
])

const ControllerExecutionBackendSchema = z
  .object({
    kind: z.literal('controller_execution'),
    operations: z.record(z.string().min(1), ControllerExecutionOperationSchema),
  })
  .strict()
  .refine((backend) => Object.keys(backend.operations).length > 0)
```

A `registered_action` operation name MUST resolve to one reviewed typed action in the controller registry. Its registered definition owns its execution target and executor. An unknown registered operation MUST fail validation; configuration cannot supply or replace its typed schema, target, or executor.

A `configured_cli` definition MUST fully declare its trusted executable binding, admitted command paths, stdin policy, timeout class, and exactly one controller-owned execution target. It MUST NOT contain a per-command public input schema, credential profile/reference, controller-materialized environment, configurable redaction profile, or caller-selected target field. Variant-inapplicable or unknown fields MUST be rejected.

`configured_cli` is uncredentialed in this release. An operation on either target that requires credential material MUST be promoted to a reviewed `registered_action` until a separate credential authority is authorized.

`ConfiguredCliExecutionTargetSchema` MUST be the strict R18 discriminated union on `kind` with exactly the variants `controller_host` and `ephemeral_managed_vm`. Neither target may fall back to the other or reuse `tool_vm_runner`.

Trace: U6, U8, U10, U11 → O6, O9, O11, O12.

### R14 — Timeout class derives one of two generic public inputs

Every `configured_cli` operation MUST author exactly one timeout class:

```ts
const ConfiguredCliTimeoutPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quick') }).strict(),
  z.object({ kind: z.literal('open') }).strict(),
])
```

The timeout policy contains no operator-authored milliseconds. `quick` resolves to the code-owned 5,000 ms maximum command runtime. `open` accepts optional caller `timeoutMs`; omission resolves to the code-owned 120,000 ms default, and a supplied value MUST be a positive integer no greater than 28,800,000 ms.

The catalog MUST automatically derive one of two strict generic public JSON Schemas, not one schema per command:

```ts
const CliArgvTokenSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[^\u0000-\u001F\u007F-\u009F]*$/u)

const ConfiguredCliCommonInputShape = {
  argv: z.array(CliArgvTokenSchema).min(1).max(100),
  reason: z.string().min(1).max(2_000),
  stdin: z.string().max(1_048_576).optional(),
} as const

const QuickConfiguredCliInputSchema = z
  .object(ConfiguredCliCommonInputShape)
  .strict()

const OpenConfiguredCliInputSchema = z
  .object({
    ...ConfiguredCliCommonInputShape,
    timeoutMs: z.number().int().positive().max(28_800_000).optional(),
  })
  .strict()
```

`argv` is the tokenized tail after the trusted executable and `mandatoryArgvPrefix`; it is not a command string. `reason` is audit and presentation context and MUST NOT alter execution. `stdin` is accepted only when the operation's configured stdin policy permits it and only within that policy's narrower byte limit. Quick input MUST omit and reject `timeoutMs`; open input MAY provide it.

Resolved timeout is child-command runtime beginning when the host child starts or, for ManagedVm, immediately before `ManagedVm.exec` after provisioning and final admission. It excludes approval waiting, target provisioning, and pre-dispatch setup. Gateway RPC lifetime MUST be controller-derived from the target's bounded provisioning budget plus resolved execution timeout plus a fixed result/cleanup margin. Neither caller nor Gateway may author a raw RPC expiry or deadline.

The generated catalog schema MUST NOT enumerate individual commands, positional fields, or ordinary CLI flags as separate public properties. Requested and resolved timeout values MUST participate in exact approval intent; timeout-policy changes MUST participate in semantic freshness.

Trace: U3, U6, U7, U8 → O3, O6, O7, O9.

### R15 — Allowed command paths are exact token prefixes

Each configured command entry MUST contain a non-empty exact-token path and optional flag rules:

```ts
const CliAllowedCommandSchema = z
  .object({
    flagRules: z.array(CliFlagRuleSchema).default([]),
    path: z.array(CliArgvTokenSchema).min(1).max(100),
  })
  .strict()
```

An invocation is command-admitted when at least one configured path exactly equals the corresponding leading `argv` tokens. String-prefix, substring, case-folded, and normalized-text matching are forbidden.

After a path match, remaining tokens are ordinary CLI grammar and MAY contain positional arguments or flags. A matched path does not require the remaining tail to start with a flag.

Examples for paths `['add']` and `['remove', 'one']`:

| Caller `argv` | Result |
| --- | --- |
| `['add', 'Buy milk']` | admitted |
| `['add', 'Buy milk', '--when', 'tomorrow']` | admitted unless an explicit rule rejects it |
| `['remove', 'one', 'task-id']` | admitted |
| `['remove', 'all', 'project-id']` | rejected |
| `['remove']` | rejected |
| `['addendum', 'Buy milk']` | rejected |

Within one `configured_cli` operation, duplicate paths and proper-prefix-overlapping paths MUST fail configuration validation. For example, `['remove']` MAY exist alone and intentionally grants ordinary descendants such as `remove one` and `remove all`, but it MUST NOT coexist in that operation with `['remove', 'one']`. Each admitted invocation therefore resolves to exactly one configured command entry. Duplicate flag names within that entry MUST also fail configuration validation.

Trace: U7, U9 → O7, O8.

### R16 — Flag rules are optional deny or allowed-value carve-outs

Config authors MUST NOT enumerate every allowed flag. The absence of a rule means an ordinary flag is admitted beneath an admitted command path.

Flag rules MUST use a strict discriminated union:

```ts
const CliFlagNameSchema = z
  .string()
  .regex(/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/u)

const CliFlagRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('deny'),
      names: z.array(CliFlagNameSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('allowed_values'),
      names: z.array(CliFlagNameSchema).min(1),
      values: z.array(CliArgvTokenSchema).min(1),
    })
    .strict(),
])
```

For matching, a long-form token such as `--force=true` MUST normalize to flag name `--force` and inline value `true`. A deny rule for `--force` therefore rejects both `--force` and `--force=true`. An `allowed_values` rule MUST accept either `--flag=value` or `--flag`, `value`, and reject missing or unlisted values.

Aliases are exact independent names. A rule for `--force` does not imply `-f`; both MUST be named when both are restricted. Compact short-option clusters are not decomposed into inferred aliases. Agent VM MUST NOT recreate the CLI's full flag or alias grammar.

An `allowed_values` rule restricts the named flag if it appears; it does not require that flag to appear. Positional values remain admitted unless another explicit rule rejects them.

Flag rules and deny patterns apply by token shape to every caller token after the admitted command path. Agent VM assigns no special end-of-options meaning to `--`: tokens after `--` remain subject to the same exact deny and allowed-value checks. This prevents a CLI-specific terminator interpretation from bypassing reviewed restrictions while avoiding a broader reimplementation of the CLI parser.

Trace: U6, U7, U9 → O7, O8, O10.

### R17 — Direct argv preserves data punctuation without shell semantics

The system MUST execute the trusted executable, mandatory prefix, and validated caller tail as an argument array with no shell interpolation. Because no shell parses the array, punctuation embedded in a valid data token—including spaces, `;`, `$`, `&`, `|`, redirection characters, backticks, quotes, and parentheses—MUST remain literal argument data and MUST NOT be rejected merely because it resembles shell syntax.

Tokens containing NUL, newline, carriage return, or another forbidden control character MUST be rejected. A configured deny pattern MAY reject punctuation or another token shape for a specific CLI. The public input MUST NOT carry an executable, shell, prefix, cwd, environment, credential, or process-launch field.

Argument-file expansion, endpoint overrides, child-process launch commands, or other CLI-specific indirection are part of the admitted CLI grammar only when they remain reachable under the reviewed command paths and deny rules. Operators MUST use narrow paths and explicit deny rules for such CLI-specific authority. Agent VM MUST NOT infer undocumented aliases or reject ordinary data through a universal punctuation-substring ban.

Trace: U7, U8, U9 → O7, O9.

### R18 — Common bounds and target-specific guarantees are explicit

Configured deny patterns MUST be explicit strict variants:

```ts
const CliPatternRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('regex'), value: z.string().min(1) }).strict(),
])
```

A literal pattern uses exact substring matching. A regex pattern uses the documented host regular-expression semantics and MUST compile during configuration validation. An invalid regex MUST reject configuration, not defer failure until a call. Deny patterns apply to caller `argv`; a bounded-text stdin policy MAY separately define stdin deny patterns.

Stdin policy MUST use this strict discriminated shape:

```ts
const CliStdinPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      deniedPatterns: z.array(CliPatternRuleSchema).default([]),
      kind: z.literal('bounded_text'),
      maxBytes: z.number().int().positive().max(1_048_576),
    })
    .strict(),
  z
    .object({
      kind: z.literal('json'),
      maxBytes: z.number().int().positive().max(1_048_576),
      schema: ToolPortalJsonSchemaDocumentSchema,
    })
    .strict(),
])
```

Stdin policy MUST be a discriminated union of `none`, bounded text, and schema-validated bounded JSON. Its absolute maximum MUST be 1 MiB, and each operation MUST set a concrete lower or equal byte limit when stdin is enabled. Providing stdin to `none`, exceeding the byte limit, invalid UTF-8 where text is required, invalid JSON, or JSON that fails the configured stdin schema MUST reject the call before process creation.

Every configured CLI MUST use one strict common output policy:

```ts
const ConfiguredCliOutputPolicySchema = z
  .object({
    modelVisibleStderr: z.enum(['none', 'fixed_safe_summary']),
    overflow: z.enum(['fail', 'truncate']),
    stderrMaxBytes: z.number().int().positive().max(16_777_216),
    stdoutMaxBytes: z.number().int().positive().max(16_777_216),
  })
  .strict()
```

Output crossing a configured bound MUST fail or truncate as configured and remain a bounded portable result. `modelVisibleStderr: "none"` exposes no stderr content. `fixed_safe_summary` invokes one code-owned sanitizer that never exposes raw stderr, replaces credential-shaped content with `[REDACTED]`, bounds the encoded summary to 4,096 UTF-8 bytes with deterministic truncation, and returns a fixed non-secret unavailable summary if sanitization fails.

The controller-host target MUST use only controls the host runner can enforce:

```ts
const ControllerHostEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)

const ConfiguredCliEnvironmentPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }).strict(),
  z
    .object({
      kind: z.literal('inherit_allowlist'),
      names: z.array(ControllerHostEnvironmentNameSchema).min(1),
    })
    .strict(),
])

const ControllerHostExecutionTargetSchema = z
  .object({
    cwd: z
      .string()
      .startsWith('/')
      .regex(/^[^\u0000-\u001F\u007F-\u009F]*$/u),
    environment: ConfiguredCliEnvironmentPolicySchema,
    kind: z.literal('controller_host'),
  })
  .strict()

const EphemeralManagedVmExecutionTargetSchema = z
  .object({
    allowedHosts: z.array(z.string().min(1)).default([]),
    environment: ConfiguredCliEnvironmentPolicySchema,
    guestCwd: z
      .string()
      .startsWith('/')
      .regex(/^[^\u0000-\u001F\u007F-\u009F]*$/u),
    imageReference: z.string().min(1),
    kind: z.literal('ephemeral_managed_vm'),
  })
  .strict()

const ConfiguredCliExecutionTargetSchema = z.discriminatedUnion('kind', [
  ControllerHostExecutionTargetSchema,
  EphemeralManagedVmExecutionTargetSchema,
])
```

Inherited environment names MUST be POSIX-compatible by the schema above and unique. `empty` starts the child with no inherited host environment. `inherit_allowlist` copies exactly the named non-secret operational values from the controller process environment; if any requested name is absent, the call MUST fail before spawn. No other host environment value may reach the child. Agent VM does not introduce a value-classification or credential registry in this release, so deployment operators MUST NOT use `inherit_allowlist` to pass credential material; an operation that needs such material is a `registered_action`.

The controller MUST start a host child in the configured absolute cwd, begin the resolved command-runtime clock when the child starts, terminate it on timeout or cancellation, and apply the common stdin/output bounds. Invalid cwd, missing inherited environment, or spawn failure is proven pre-dispatch. Once the child starts, timeout, cancellation, output overflow, non-zero exit, or lost result MUST preserve possible-side-effect uncertainty and MUST NOT auto-replay.

The host target provides process invocation bounds, not containment. Its child runs with the controller process's host OS filesystem and network authority. This release provides no generic host filesystem/network sandbox, artifact capture, custody mode, or descendant-process containment guarantee.

The `ephemeral_managed_vm` target MUST resolve `imageReference` to one immutable prepared-image fingerprint before admission; mutable or unresolved references fail validation. `guestCwd`, the empty/inherited non-secret environment policy, and `allowedHosts` are its only authored runner fields. `allowedHosts` defaults to no network destinations.

The target MUST create one new controller-owned ManagedVm for the exact operation. The controller MUST reserve and record operation, VM, host-process identity, parent epochs/principal, image fingerprint, and authorization fingerprint before dispatch; execute array argv with no shell or PTY; expose no agent SSH; create no Tool VM lease; never reuse, adopt, or automatically replace the runner; begin command-runtime timing immediately before invoking `ManagedVm.exec` after VM provisioning and final admission; close the VM after result, controller-owned cancellation, or timeout; and positively prove containment before returning a safe terminal result. Setup failure before dispatch is proven not-dispatched. Dispatch-armed failure or unproven containment is ambiguous and forbids replay.

Cancellation in this release is controller-owned and call-scoped: the derived RPC lifetime or controller shutdown may abort the active target through the executor's existing `AbortSignal`. Gateway, framework, model, and caller payloads do not gain a new cancellation operation or cancellation authority. A presenter cancellation before approved resubmission remains proven not-dispatched.

VM provisioning occurs outside command-runtime timeout but inside the controller-derived RPC lifetime. VM construction uses code-owned resources, copy-on-write rootfs, no mounts, no SSH egress, no mediation, no mediated secrets, and no TCP host mappings. Configuration cannot request or override those fields. The VM target is uncredentialed in this release and adds no credential profile, custody, artifact, or controller-materialized environment contract. It may claim filesystem/network/process containment only to the extent the ManagedVm lifecycle and immutable runner image positively prove it.

Trace: U7, U8, U11 → O9, O12.

### R19 — Catalog resolution preserves controller execution and leased Tool VM boundaries

For `controller_execution`, `tools`, `calls.withoutApproval`, and `calls.requiresApproval` selectors MUST resolve against the backend's declared operation names after registered actions have been verified and configured CLI operations have parsed. An explicit selector name that does not resolve MUST fail configuration validation.

The effective catalog MUST reject duplicate `{namespace, operationName}` identities, including a collision between configured and registered sources, rather than selecting one by insertion order. A registered action may appear at most once under one capability identity in a namespace. Operation record keys and capability identities use exact string equality; no normalization creates hidden aliases.

Within one effective profile, every `configured_cli` operation sharing an exact `executablePath` participates in one effective-command comparison. For each configured command, validation MUST concatenate `[...mandatoryArgvPrefix, ...path]`; duplicate sequences or a proper-prefix relationship between any two concatenated sequences MUST reject the effective profile, regardless of namespace, visibility, approval posture, or how tokens were divided between prefix and path. This prevents an approval-free operation from aliasing a protected command through a different prefix/path split and guarantees that one final executable/prefix/argv invocation resolves to one configured operation and one command path.

The model-visible catalog MUST contain only the automatically derived quick/open generic public input schema, bounded safe help, operation identity, and ordinary Tool Portal metadata. It MUST NOT contain executable path, mandatory prefix, execution target, image reference/fingerprint, fixed/guest cwd, environment policy, stdin policy or bounds, output policy, provisioning budget, RPC lifetime, or code-owned runner-construction fields.

A private managed-Gateway projection MAY contain the generic descriptor, `timeoutKind`, `targetKind`, and command-path/flag/deny admission grammar needed to derive the public schema, reject invalid public input early, and select the code-owned bounded RPC-envelope formula. `targetKind` is limited to `controller_host | ephemeral_managed_vm`; it is non-authoritative metadata and is not model-visible or caller-selected. The projection MUST NOT carry executable path, mandatory prefix, target-specific configuration, image reference/fingerprint, cwd, environment policy, output policy, provisioning budget, raw RPC lifetime, or runner-construction fields. Gateway Control requests likewise MUST NOT accept target kind or any of those trusted fields. The controller's effective configuration remains their sole dispatch authority and re-derives the target and response window from current policy.

`controller_execution` remains managed-only. Standalone Tool Portal configuration MUST reject it before startup.

`tool_vm_runner` remains a separate managed backend whose shipping `sandbox_ssh` profile resolves the authenticated caller's current leased Tool VM and executes through Gateway-owned strict SSH. It MUST NOT dispatch to `ephemeral_managed_vm`, consume an ephemeral runner image reference, or become an alias for `controller_execution`. Conversely, the ephemeral runner MUST NOT acquire a Tool VM lease, SSH connection, or current Tool VM binding.

No per-command controller execution RPC is added to `tool_vm_runner`; its command/file/process bytes remain on the existing Gateway-to-leased-Tool-VM strict-SSH path. The private controller execution RPC applies only to `controller_execution` targets because the managed agent and Gateway have no direct host-process or operation-scoped ManagedVm authority.

Trace: U6, U8, U10, U11 → O6, O9, O11, O12.

### R20 — The controller recomputes and revalidates the final invocation

Gateway or model input MUST carry only the derived quick/open public input plus ordinary Tool Portal call identity. For `controller_execution`, the Gateway sends one private controller execution request; before executing either controller-owned target, the controller MUST resolve the operation from its current trusted effective configuration and recompute:

- absolute executable and mandatory argv prefix;
- validated caller argv tail and stdin;
- timeout class, requested timeout where allowed, and resolved command runtime;
- controller-host cwd/environment or immutable ephemeral image, guest cwd, environment, and allowed hosts;
- target-specific provisioning budget, common output policy, and fixed result/cleanup margin;
- current principal, profile, capability, semantic revision, and approval fingerprint.

The controller MUST repeat command-path, flag-rule, deny-pattern, stdin, and bound validation against the trusted operation definition. Gateway-side acceptance alone is not execution authority. Any mismatch, stale semantic identity, unavailable executable, invalid policy, or validation failure MUST fail before process creation with a bounded non-secret denial.

The normalized trusted operation policy MUST participate in controller authorization and execution freshness. Changing executable, prefix, command paths, flag rules, deny patterns, stdin policy/bounds, timeout class, execution-target kind, host policy, immutable image fingerprint, guest cwd, inherited environment names, allowed hosts, output bounds/overflow, or model-visible stderr mode MUST change the applicable semantic revision or execution fingerprint even when namespace, operation name, and caller input are unchanged. A challenge or reservation created under the prior policy MUST become stale and MUST dispatch zero effects after that policy change.

Requested and resolved command timeout and the selected execution target MUST enter the exact approval intent. The target dispatcher MUST receive exactly `[executablePath, ...mandatoryArgvPrefix, ...argv]` as array argv and only controller-selected target context. The controller MUST NOT invoke a shell or concatenate these fields into a command string.

Gateway/control RPC expiry MUST be derived from target provisioning budget + resolved command runtime + fixed result/cleanup margin. Caller, model, and Gateway payloads MUST NOT supply or override that expiry. A timeout before process start is proven not-dispatched; a command-runtime timeout after start follows R18's target-specific certainty and containment rules.

Trace: U3, U7, U8, U11 → O3, O9, O12.

### R21 — Intentional CLI upgrades reopen the admitted authority surface

An allowed command path delegates ordinary post-path argument grammar to the configured CLI version. If an intentionally upgraded executable introduces a new ordinary flag beneath an already admitted path, that flag becomes admitted unless an explicit rule rejects it.

Executable, host package, or immutable runner-image upgrade is therefore the operator's authority-surface review boundary. Agent VM MUST expose the trusted operation-policy identity and target-appropriate executable/image revision in validation or effective-configuration diagnostics sufficient for an operator to identify what changed; it MUST NOT silently maintain a second mirrored CLI grammar.

If a CLI command requires credential material, it is outside `configured_cli` in this release and MUST be promoted to a reviewed `registered_action` rather than adding credential or controller-materialized-environment fields to the broad allowance.

Trace: U6, U9, U10 → O7, O10, O11.

### R22 — Typed registered actions remain the promotion target

A reviewed repeated operation MAY be exposed as `registered_action` with a domain-specific public schema and trusted compilation. Its registered definition owns its target and executor. Promotion MUST narrow the public contract; it MUST NOT create a second catalog, approval owner, or controller-execution authority.

Broad and registered operations MUST use the same namespace policy, visibility selectors, approval classification, exact-intent fingerprinting, dispatch admission, bounded result, and managed-Gateway presenter behavior. Configuration MUST NOT be able to replace a registered action's public schema or executor with caller-authored argv.

Trace: U10 → O11.

### R23 — Approval policy applies to operation names, not CLI subcommands

Existing capability-level `calls.withoutApproval` and `calls.requiresApproval` selectors classify each configured CLI or registered operation as a whole. The system MUST NOT make approval depend on inspecting caller flags or positional values within one operation.

When command families require different approval posture, configuration MUST define separate broad operations over disjoint command paths, such as one approval-free read operation and one approval-required write operation. Both MAY select the same fixed executable and prefix, but their command spaces MUST satisfy R19's no-overlap rule and each has its own complete timeout, target, and output policy.

A protected configured CLI operation MUST enter the same challenge, native presentation, controller decision, exact retry, reservation, and at-most-one dispatch lifecycle defined by R1–R12. Approval binds the exact derived generic input, selected execution target and immutable target revision, requested/resolved command timeout, `argv`, `reason`, and stdin; changing any requires a different challenge.

Trace: U1, U2, U3, U6, U9 → O1, O2, O3, O4, O6.

## Configuration examples

One namespace may expose approval-free reads, protected writes, and a promoted typed operation together:

```jsonc
{
  "backend": {
    "kind": "controller_execution",
    "operations": {
      "read_cli": {
        "kind": "configured_cli",
        "safeHelp": "Read information through the configured host CLI.",
        "executablePath": "/opt/example/bin/example",
        "mandatoryArgvPrefix": [],
        "commands": [
          { "path": ["list"] },
          { "path": ["show"] },
          { "path": ["search"] }
        ],
        "deniedPatterns": [],
        "stdin": { "kind": "none" },
        "timeout": { "kind": "quick" },
        "executionTarget": {
          "kind": "controller_host",
          "cwd": "/var/empty",
          "environment": { "kind": "empty" }
        },
        "output": {
          "modelVisibleStderr": "fixed_safe_summary",
          "overflow": "truncate",
          "stderrMaxBytes": 65536,
          "stdoutMaxBytes": 65536
        }
      },
      "write_cli": {
        "kind": "configured_cli",
        "safeHelp": "Create or change one item through the configured host CLI.",
        "executablePath": "/opt/example/bin/example",
        "mandatoryArgvPrefix": [],
        "commands": [
          { "path": ["add"] },
          {
            "path": ["remove", "one"],
            "flagRules": [
              { "kind": "deny", "names": ["--force", "-f"] },
              {
                "kind": "allowed_values",
                "names": ["--scope"],
                "values": ["personal", "shared"]
              }
            ]
          }
        ],
        "deniedPatterns": [],
        "stdin": { "kind": "none" },
        "timeout": { "kind": "open" },
        "executionTarget": {
          "kind": "controller_host",
          "cwd": "/var/empty",
          "environment": { "kind": "empty" }
        },
        "output": {
          "modelVisibleStderr": "fixed_safe_summary",
          "overflow": "truncate",
          "stderrMaxBytes": 65536,
          "stdoutMaxBytes": 65536
        }
      },
      "isolated_inspect_cli": {
        "kind": "configured_cli",
        "safeHelp": "Inspect data in one isolated ephemeral runner.",
        "executablePath": "/usr/local/bin/inspect",
        "mandatoryArgvPrefix": [],
        "commands": [{ "path": ["inspect"] }],
        "deniedPatterns": [],
        "stdin": { "kind": "none" },
        "timeout": { "kind": "quick" },
        "executionTarget": {
          "kind": "ephemeral_managed_vm",
          "imageReference": "runner-image@sha256:0123456789abcdef",
          "guestCwd": "/run",
          "environment": { "kind": "empty" },
          "allowedHosts": []
        },
        "output": {
          "modelVisibleStderr": "fixed_safe_summary",
          "overflow": "truncate",
          "stderrMaxBytes": 65536,
          "stdoutMaxBytes": 65536
        }
      },
      "workspace_git_push": {
        "kind": "registered_action"
      }
    }
  },
  "tools": {
    "allow": [
      "read_cli",
      "write_cli",
      "isolated_inspect_cli",
      "workspace_git_push"
    ],
    "deny": []
  },
  "calls": {
    "withoutApproval": {
      "allow": ["read_cli", "isolated_inspect_cli"],
      "deny": []
    },
    "requiresApproval": {
      "allow": ["write_cli", "workspace_git_push"],
      "deny": []
    }
  }
}
```

The example intentionally contains no credential, controller-materialized environment, configurable stderr-redaction, filesystem mount, artifact, custody, SSH, lease, mediation, secret, TCP mapping, resource, or rootfs field. Those are outside `configured_cli`; ephemeral runner resources and copy-on-write/no-mount/no-SSH construction are code-owned.

Valid bearer authority after hard cutover:

```jsonc
{
  "approvalAccess": {
    "audience": "agent-vm-controller-approval",
    "approvers": [
      {
        "kind": "bearer",
        "approverId": "operations",
        "secret": { "source": "environment", "envVar": "APPROVAL_TOKEN" }
      }
    ]
  }
}
```

Valid native managed-Gateway authority:

```jsonc
{
  "approvalAccess": {
    "audience": "agent-vm-controller-approval",
    "approvers": [
      {
        "kind": "managed_gateway",
        "approverId": "native-gateway"
      }
    ]
  }
}
```

Both authority kinds MAY coexist. Their decisions converge on the same controller ledger.

## Proof obligations

| ID | Observable obligation | Evidence class |
| --- | --- | --- |
| V1 | Generic config accepts both explicit variants and rejects mixed/implicit variants. | Automated behavior and generated-schema inspection |
| V2 | OpenClaw, Worker, other unsupported Gateways, and missing authorities fail before protected execution; Hermes declares the sole presenter capability. | Automated integration and startup/preflight evidence |
| V3 | The in-repo Hermes presenter shows one session-and-request-bound approve/deny interaction through the pinned Hermes Gateway surface selected by Program Design; an admitted actor can resolve it, while an unauthorized actor receives bounded feedback and leaves it pending. | Real Hermes interaction or visual evidence with admitted and unauthorized native-surface actors |
| V4 | Approved exact item dispatches once; changed, denied, expired, duplicated, stale, or unauthorized-actor attempts dispatch zero times; an unauthorized attempt sends no decision RPC and leaves controller challenge state unchanged. | Controller/Gateway integration with decision-call, challenge-state, and backend side-effect observation |
| V5 | Mixed batches do not repeat approval-free successes, exhaustively map every presenter/decision outcome, recompute aggregate status, and preserve item order. | Cross-process integration with call-count and result inspection |
| V6 | Framework crash/presenter failure leaves protected work non-dispatched. | Process-boundary integration or real managed-Gateway proof |
| V7 | Bearer approval remains functional after the discriminated-union cutover. | Controller HTTP integration and config migration proof |
| V8 | The fixed display sanitizer enforces depth, collection, string, and byte bounds; unauthorized-actor feedback is bounded and non-secret; credential-shaped values, native human identity, and raw content never enter controller/model-visible output. | Security misuse cases and bounded-output inspection |
| V9 | Strict `controller_execution` operation, execution-target, timeout, environment, stdin, output, pattern, and flag schemas accept valid variants while rejecting old umbrella names, mixed targets, mutable image references, caller-selected runner construction, unknown registered actions, invalid/duplicate environment names, credential/materialized-environment/configurable-redaction fields, duplicate/proper-prefix-overlapping effective command sequences across different prefix/path splits, approval-free aliases, selector misses, collisions, invalid regex, and standalone controller execution. | Automated schema/effective-config behavior and generated JSON Schema inspection |
| V10 | Exact command-path matching admits ordinary positional tails and flags, rejects siblings and partial-token matches, and resolves every admitted final executable/prefix/argv invocation to exactly one operation and one effective path. | Table-driven automated behavior covering valid, boundary, same-prefix overlap, cross-prefix overlap, and invalid argv |
| V11 | `--flag=value` and separated values obey deny and allowed-value rules; aliases remain exact; unmentioned flags stay admitted; `--` creates no exemption from flag or deny-pattern enforcement. | Table-driven automated behavior for every flag-rule variant, normalization boundary, and end-of-options-shaped input |
| V12 | Spaces and shell-like punctuation embedded in valid argv data reach the selected target literally; NUL/control/newline, deny rules, invalid stdin, bounds, missing inherited environment, and invalid quick/open timeout input fail before process start; fixed-safe-summary failure exposes only the fixed fallback. | Table-driven validator/sanitizer behavior plus host and ManagedVm argv/stdin/environment transcript |
| V13 | Quick catalog entries expose strict `{ argv, reason, stdin? }` and reject `timeoutMs`; open entries add only optional bounded `timeoutMs`; model catalogs omit all target metadata, while private Gateway projections expose only non-authoritative `targetKind`/`timeoutKind` and omit executable, prefix, target configuration, image, cwd, environment, output, provisioning, RPC lifetime, and runner construction. | Generated JSON Schema, effective-catalog inspection, and private-projection shape inspection |
| V14 | Effective managed configuration carries only operation identity, non-authoritative target/timeout kind, and admission grammar through private Gateway Runtime; Gateway Control carries only operation identity and public input. Forged target/policy/RPC deadline fields are rejected, and one private controller execution RPC reloads/revalidates then selects host versus ephemeral execution. | Cross-process integration through real private UDS/control contracts with both controller-owned targets observed |
| V15 | A real host fixture executable receives exactly the configured executable/prefix/caller argv, bounded stdin, fixed cwd, and only allowlisted inherited environment without shell evaluation; pre-spawn failures remain proven not-started; timeout/cancellation/output overflow after start preserve possible-side-effect uncertainty and never auto-replay; stdout/stderr and fixed safe summaries stay bounded. | Host-process end-to-end transcript and process-side observation |
| V16 | Approval-free configured CLI calls dispatch once; an admitted actor's approved protected call dispatches once on each target; denied, unauthorized-actor, changed target/timeout, expired, duplicated, stale, presenter-unavailable, or trusted-policy-mutated calls dispatch zero times. | Managed Gateway integration and real presenter admitted-actor approve/deny plus unauthorized-actor proof with target-specific side-effect counts |
| V17 | A typed registered action and a configured CLI operation coexist in one catalog and retain independent typed/generic schemas while sharing selectors, approval, and result behavior. | Effective-config/catalog integration and registered-action regression evidence |
| V18 | `ephemeral_managed_vm` resolves an immutable image, creates one fresh COW/no-mount/no-SSH runner, records identity before dispatch, executes array argv, applies empty/allowlisted environment and allowed-host policy, starts timeout immediately before `ManagedVm.exec` after provisioning/final admission, never leases/reuses/adopts, and proves cleanup/containment; dispatch-armed or containment failure remains ambiguous. | Real ManagedVm integration with lifecycle-ledger, provider-request, process, network-denial, and containment observations |
| V19 | Shipping `tool_vm_runner` continues to use the authenticated caller's current leased Tool VM over Gateway-owned strict SSH, never calls per-command controller execution RPC, and never receives an ephemeral image/dispatch; controller execution never acquires its binding, lease, SSH client, or process handles. | Gateway Runtime integration covering both backend ports, controller-RPC call counts, and exact target/connection observations |
| V20 | Quick resolves exactly 5,000 ms and rejects public timeout; open resolves omission to 120,000 ms and accepts only positive values through 28,800,000 ms; command timing excludes approval and ManagedVm provisioning and begins at host child start or immediately before `ManagedVm.exec`; RPC lifetime equals target provisioning budget plus resolved command runtime plus fixed margin; no public raw deadline is accepted. | Deterministic schema/resolver tests and host/ManagedVm integration with injected clocks and RPC deadline inspection |

Requirement coverage:

| Requirements | Proof obligations |
| --- | --- |
| R1–R3 | V1, V2 |
| R4–R5 | V3, V8, V16 |
| R6–R8 | V4 |
| R9 | V5 |
| R10 | V7 |
| R11 | V6 |
| R12 | V8 |
| R13, R19 | V9, V13, V14, V17, V19 |
| R14 | V9, V13, V20 |
| R15–R16 | V10, V11 |
| R17–R18 | V12, V15, V18 |
| R20 | V14, V15, V16, V18, V20 |
| R21 | V9, V13, V17 |
| R22 | V17 |
| R23 | V14, V16, V17, V20 |

## Undefined behavior and negative space

- Presentation layout and wording may vary by framework while retaining the required fields and decisions.
- Hermes is the only implemented presenter. OpenClaw and Worker presenter behavior is unsupported rather than implicitly inherited from the generic contracts.
- Independent framework sessions have no global prompt-order guarantee.
- The controller does not guarantee automatic re-presentation after framework restart.
- Framework-native human identity attribution remains framework-owned; the controller ledger identifies the configured managed-Gateway approver authority in this release.
- The meaning of undocumented CLI tokens after an admitted command path is owned by the intentionally selected executable version, subject to explicit policy and controller execution bounds.
- Agent VM does not infer undocumented flag aliases, compact short-option decomposition, response-file grammar, or a CLI's child-process behavior.
- A configured CLI operation does not promise semantic compatibility across executable or immutable runner-image upgrades; the operator reviews and accepts that authority change.
- A `controller_host` child runs with the controller process's host OS filesystem and network authority. This release does not provide generic host filesystem/network containment, descendant-process isolation, artifact capture, or custody guarantees.
- An `ephemeral_managed_vm` operation promises only the code-owned COW/no-mount/no-SSH construction, authored allowed-host boundary, operation lifecycle, and positive containment stated in R18. It does not promise artifacts, credentials, workspace access, persistent VM state, or reuse.
- `tool_vm_runner` remains the current leased Tool VM backend. No behavior in this specification changes its SSH, lease, process-handle, filesystem, or artifact contracts.
