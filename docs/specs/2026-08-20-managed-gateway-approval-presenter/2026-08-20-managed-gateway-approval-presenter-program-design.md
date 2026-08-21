# Configurable Controller Execution and Managed Gateway Approval Program Design

## Governing contract

- [Requirements](./2026-08-20-managed-gateway-approval-presenter-requirements.md)
- [Specification](./2026-08-20-managed-gateway-approval-presenter-specification.md)

The fixed goal is one managed `controller_execution` capability plane. A reviewed operation is either a promoted `registered_action`, whose code-owned definition selects its target and executor, or a target-neutral `configured_cli`, whose generic policy binds exactly one `controller_host | ephemeral_managed_vm` target. Both use existing Tool Portal visibility, call classification, approval, and portable result boundaries.

Shipping `tool_vm_runner` is not part of this umbrella. It remains the Gateway-owned backend for the caller's current leased Tool VM over strict SSH. The design realizes U1–U11, R1–R23, and V1–V20 without adding a shell, a second ledger or registry, a new service, or a compatibility alias for `controller_host_action`.

## Current system and required deltas

| Current source | Current behavior | Target delta |
| --- | --- | --- |
| `packages/config-contracts/src/tool-portal-config.ts` | `controller_host_action` is an empty binding; `tool_vm_runner` alone has configured operations. | Hard-cut to `controller_execution.operations: registered_action | configured_cli`; configured CLI includes timeout class and exact target union. Keep `tool_vm_runner` unchanged. |
| `packages/tool-portal/src/cli-allowances/**` | Export/test-only allowance mirrors flag grammar, rejects positional/punctuation data, and carries obsolete target-coupled policy. | Replace in place with target-neutral exact-path/flag/pattern/stdin validation and quick/open public inputs. |
| `packages/gateway-runtime/src/backends/controller-host-action-*.ts` | Two compiled host-action catalog registrations and a hard-coded Gateway Control switch. | Build one profile-aware `controller_execution` catalog from safe projections and send a generic outer operation union. |
| `packages/agent-vm/src/controller/control-session/**` | Authorization/execution knows only `workspace_git_push` and `controller_host_probe`. | Resolve the current controller execution definition, revalidate exact intent, then dispatch registered action or configured target. |
| `packages/agent-vm/src/controller/runner/controller-host-action-registry.ts` | Generic typed registry is test-composed only. | Evolve it into the one production `ControllerExecutionRegistry` over reviewed definitions and normalized configured CLI policy. |
| `packages/agent-vm/src/controller/runner/managed-vm-controller-runner.ts` | A real operation/identity/containment scaffold exists with test factories and an older broad authorization shape. | Compose it with a production code-owned factory over `ManagedVmProvider`; narrow its authority to this target and complete stdin/output/timeout behavior. Do not claim it already ships. |
| `packages/managed-vm/src/managed-vm-contracts.ts` and application composition | Neutral `ManagedVmProvider` exposes image, factory, exact-termination, and VM exec capabilities. | Reuse the provider boundary to resolve immutable prepared images and create one code-owned runner VM per operation. |
| `packages/gateway-runtime/src/backends/tool-vm-runner-backend-port.ts` | Acquires current caller binding and uses `StrictToolVmSshClient` directly for command/file/process operations. | Intentionally unchanged; add regression enforcement that it makes no per-command controller execution RPC. |
| `packages/gateway-control-contracts/src/gateway-runtime-portal-semantic-revision.ts` | Controller host binding revision hashes only the backend kind. | Hash normalized controller execution policy including target, timeout, and immutable image fingerprint. |
| Hermes adapter tool handler and `pre_gateway_dispatch` hook | Returns `approval_required` as ordinary output, discards `session_id`, and currently discards the hook-provided live Gateway object. | Preserve the pinned Hermes Gateway/session route in the in-repo adapter, present the request through the selected native adapter, then perform private decision and exact retry. OpenClaw and Worker remain unsupported presenters. |

Existing Tool Portal call policy, controller approval ledger, caller-context registration, private UDS, Gateway Control session, registered action implementations, Managed VM provider abstraction, and leased Tool VM SSH backend remain authoritative.

## Structural crux and alternatives

### One policy form, two controller-owned targets

Three credible structures were considered:

1. Keep broad CLI host-only and add a separate VM-CLI backend. This duplicates catalog, policy, approval, and generic input while making target a backend choice.
2. Reuse `tool_vm_runner` for ephemeral execution. This confuses the current leased Tool VM and its Gateway SSH lifecycle with a controller-owned one-shot VM and violates U11/R19.
3. Make broad CLI target-neutral within `controller_execution`, then let the controller resolve the trusted target after one common admission path.

The design selects option 3. The cost is one target discriminant, target dispatcher, and real ephemeral-runner composition. Controller/config maintainers pay that cost. The gain is one public CLI altitude and honest, separately provable target guarantees. Revisit only if a future target cannot share the public CLI and approval contracts.

### Trusted policy remains controller-only

Sending complete operation policy to Gateway Runtime would simplify local dispatch but leak executable, target, image, cwd, environment, output, provisioning, and deadline authority. Instead the compiler emits a controller-only normalized registry and a separately constructed Gateway-safe catalog/admission projection. The Gateway can reject obvious public-input errors; the controller is always final authority.

### Managed approval remains controller-authoritative

Hermes renders and authenticates the native actor, but the controller ledger alone decides challenge state and arms dispatch. A Gateway-held reusable approval credential or framework-local command approval would either leak authority or bypass exact intent. The existing private principal-bound Runtime/Control path remains the selected decision seam.

## Integrated system

```text
managed Tool Portal config
  controller_execution.operations
    registered_action
    configured_cli { timeout, executionTarget }
  tools + withoutApproval + requiresApproval
                         │
                         ▼
Controller Execution Compiler
  validates definitions, profiles, effective command spaces, images, targets
  derives policy digest + two outputs
             ┌───────────┴──────────────────────────┐
             ▼                                      ▼
controller-only normalized registry          Gateway-safe projection
  executable/prefix/target/image/cwd/env       operation kind + timeout class
  stdin/output + registered executor           generic schema + admission grammar
             │                                      │
             │                               Tool Portal catalog/policy
             │                                      │
             │                         quick/open generic public input
             │                                      │
             │                      direct | approval challenge
             │                                      │
             │                      Hermes native presentation
             │                                      │
             │                      private controller decision
             │                                      │
             │                      exact approved resubmission
             │                                      │
             └──────────────────────┬───────────────┘
                                    ▼
                   Gateway Control controller_execution
                                    │
                    controller reloads current registry
                                    │
                    registered_action | configured_cli
                             ┌──────┴───────┐
                             ▼              ▼
                    controller_host   ephemeral_managed_vm
                     direct spawn      one-shot VM runner
                             └──────┬───────┘
                                    ▼
                       target-specific result certainty

SEPARATE AND UNCHANGED
tool_vm_runner → current caller Tool VM binding → strict SSH → leased Tool VM
```

## Components and singular ownership

| Component | Sole ownership | Consumers | Reason to change |
| --- | --- | --- | --- |
| Managed Tool Portal config schema | `controller_execution` operation, timeout, and target syntax | Config loader/compiler/JSON Schema | Authored contract changes. |
| Controller Execution Compiler | Definition resolution, applicability, effective-command uniqueness, immutable image resolution, normalization, safe projection, digest | Effective config, registry, semantic snapshot | Compilation semantics change. |
| Reviewed Registered-Action Definition | Stable identity, Zod input/output, derived catalog/control schema, target/executor, applicability | Compiler, safe projection, registry | One promoted action changes. |
| Controller Execution Registry | Current profile/operation lookup and complete resolved union | Controller authorization/dispatcher | Dispatch authority changes. |
| Gateway-safe Controller Execution Projection | Catalog descriptor, target kind/timeout class needed for public schema and RPC-envelope derivation, admission grammar | Gateway Runtime/Tool Portal | Public discovery or early rejection changes. |
| Configured CLI Validator and Timeout Resolver | Exact path/flag/pattern/stdin and quick/open requested/resolved runtime | Gateway advisory path and controller authoritative path | Generic call semantics change. |
| Controller Execution RPC Adapter | Strict public payload, caller context, approval reservation, controller-derived expiry | Gateway Runtime/Control session | Private wire changes. |
| Controller Execution Target Dispatcher | Exhaustive registered/configured and host/VM selection | Controller registry | Target composition changes. |
| Controller Host CLI Executor | Direct child argv/stdin/output/runtime and host certainty | Dispatcher | Host execution behavior changes. |
| Ephemeral Managed VM Runner | Operation ledger, VM factory/lifecycle, guest exec, containment certainty | Dispatcher | Isolated target behavior changes. |
| Ephemeral Managed VM Factory | Immutable image to code-owned `ManagedVmCreateRequest` | VM runner | Runner construction policy changes. |
| Fixed CLI stderr sanitizer | Code-owned 4,096-byte safe summary/fallback | Both configured targets | Summary behavior changes. |
| Framework Approval Bridge | Portable request + framework context, decision, exact retry, batch merge | Hermes adapter | Approval orchestration changes. |
| Hermes Gateway Approval Interaction | Session/request pending state, existing actor admission, native rendering/callback cleanup | Framework bridge | Pinned Hermes route/interaction binding changes. |
| Controller Approval Ledger | Exact challenge/decision/expiry/reservation/arm | Tool Portal/controller handler | Approval authority changes. |
| Tool VM Runner Backend | Current binding, strict SSH, retained process groups/artifacts | Tool Portal only | Intentionally unchanged. |

Allowed direction is config → compiler → controller registry or safe projection; projection → Gateway Tool Portal; Gateway Control → current registry → target dispatcher; VM dispatcher → Managed VM runner → provider factory; Tool VM runner → current binding → strict SSH. The controller execution path never imports or calls the Tool VM runner backend.

Forbidden edges:

- model/Gateway payload → executable, prefix, target, image, cwd, environment, output, provisioning budget, or raw deadline;
- `tool_vm_runner` → controller execution per-command RPC or ephemeral factory;
- controller execution → current Tool VM binding, lease, SSH client, retained process registry, or Tool VM artifacts;
- ephemeral runner → SSH, lease, mounts, reuse/adoption, mediated secrets, mediation, TCP mappings, caller-authored resources, or automatic replacement;
- host executor → Managed VM runner or a containment claim;
- presenter → controller dispatch without ledger decision/reservation;
- split Gateway/controller registered-action schemas → second definition truth.

## Type and schema boundaries

Zod owns config and wire validation; types are inferred. Every discriminated union is switched exhaustively with a `never` assertion. No public boundary accepts `any` or unvalidated `unknown`.

### Operation, timeout, and target configuration

```ts
const ConfiguredCliTimeoutPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quick') }).strict(),
  z.object({ kind: z.literal('open') }).strict(),
])

const ConfiguredCliEnvironmentPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }).strict(),
  z.object({
    kind: z.literal('inherit_allowlist'),
    names: z.array(PosixEnvironmentNameSchema).min(1),
  }).strict(),
])

const ConfiguredCliExecutionTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('controller_host'),
    cwd: AbsoluteControlFreePathSchema,
    environment: ConfiguredCliEnvironmentPolicySchema,
  }).strict(),
  z.object({
    kind: z.literal('ephemeral_managed_vm'),
    imageReference: ControlFreeImageRecipePathSchema,
    guestCwd: AbsoluteControlFreePathSchema,
    environment: ConfiguredCliEnvironmentPolicySchema,
    allowedHosts: z.array(z.string().min(1)).default([]),
  }).strict(),
])

const PreparedManagedVmImageIdentityPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  imageReference: z.string().min(1),
  fingerprint: z.string().min(1),
}).strict()

const PreparedManagedVmImageIdentitySchema = z.string()
  .startsWith('agent-vm-prepared-image:v1:')
  .transform(decodeBase64UrlJson)
  .pipe(PreparedManagedVmImageIdentityPayloadSchema)

const NormalizedEphemeralManagedVmTargetSchema = z.object({
  kind: z.literal('ephemeral_managed_vm'),
  preparedImage: PreparedManagedVmImageIdentityPayloadSchema,
  guestCwd: AbsoluteControlFreePathSchema,
  environment: ConfiguredCliEnvironmentPolicySchema,
  allowedHosts: z.array(z.string().min(1)),
}).strict()

const ControllerConfiguredCliOperationSchema = z.object({
  kind: z.literal('configured_cli'),
  safeHelp: BoundedSafeHelpSchema,
  executablePath: AbsoluteControlFreePathSchema,
  mandatoryArgvPrefix: z.array(CliArgvTokenSchema).max(64),
  commands: z.array(CliAllowedCommandSchema).min(1),
  deniedPatterns: z.array(CliPatternRuleSchema).default([]),
  stdin: CliStdinPolicySchema.default({ kind: 'none' }),
  timeout: ConfiguredCliTimeoutPolicySchema,
  executionTarget: ConfiguredCliExecutionTargetSchema,
  output: ConfiguredCliOutputPolicySchema,
}).strict()

const ControllerExecutionOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registered_action') }).strict(),
  ControllerConfiguredCliOperationSchema,
])
```

The hard-cutover backend kind is exactly `controller_execution`; `controller_host_action` is rejected rather than aliased. Configured CLI has no credential, numeric configured timeout, caller target, configurable sanitizer, runner resource, mount, SSH, lease, mediation, secret, TCP mapping, or raw deadline field.

### Derived generic public inputs and resolved timeout

```ts
const ConfiguredCliCommonInputShape = {
  argv: z.array(CliArgvTokenSchema).min(1).max(100),
  reason: z.string().min(1).max(2_000),
  stdin: z.string().max(1_048_576).optional(),
} as const

const QuickConfiguredCliInputSchema = z.object(ConfiguredCliCommonInputShape).strict()
const OpenConfiguredCliInputSchema = z.object({
  ...ConfiguredCliCommonInputShape,
  timeoutMs: z.number().int().positive().max(28_800_000).optional(),
}).strict()

const ResolvedConfiguredCliTimeoutSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('quick'),
    requestedTimeoutMs: z.null(),
    resolvedTimeoutMs: z.literal(5_000),
  }).strict(),
  z.object({
    kind: z.literal('open'),
    requestedTimeoutMs: z.number().int().positive().max(28_800_000).nullable(),
    resolvedTimeoutMs: z.number().int().positive().max(28_800_000),
  }).strict(),
])
```

Quick rejects `timeoutMs`. Open omission resolves to 120,000 ms; an authored value resolves to itself. The resolver is pure and code-owned. Both requested and resolved values bind approval intent and execution fingerprint.

### Reviewed registered-action definition

```ts
interface ReviewedControllerExecutionDefinition<
  TInput extends JsonObject,
  TResult extends JsonValue,
> {
  readonly identity: { readonly namespace: string; readonly name: string }
  readonly inputSchema: z.ZodType<TInput>
  readonly outputSchema: z.ZodType<TResult>
  readonly catalog: ReviewedCapabilityCatalogMetadata
  readonly evaluateApplicability: (
    context: ControllerExecutionApplicabilityContext,
  ) => Promise<RegisteredActionApplicabilityResult>
  readonly execute: (
    request: ControllerExecutionRequest<TInput>,
  ) => Promise<TResult>
}
```

The definition owns its target through `execute`; config cannot replace it. `defineReviewedControllerExecution` derives JSON Schema, compact summary, and typed Gateway projection from the same Zod schemas. The compiler and controller use the same definition and applicability hook. `workspace_git_push` retains remote-workspace eligibility, controller lock, and controller Git credentials; `controller_host_probe` retains its existing environment gate. Duplicate identities or schema/catalog drift fail composition.

### Controller-only normalized registry

```ts
const NormalizedControllerExecutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('registered_action'),
    identity: ControllerExecutionIdentitySchema,
    definitionName: z.string().min(1),
    policyDigest: PolicyDigestSchema,
  }).strict(),
  z.object({
    kind: z.literal('configured_cli'),
    identity: ControllerExecutionIdentitySchema,
    policyDigest: PolicyDigestSchema,
    executablePath: AbsoluteControlFreePathSchema,
    mandatoryArgvPrefix: z.array(CliArgvTokenSchema),
    commands: z.array(CliAllowedCommandSchema),
    deniedPatterns: z.array(CliPatternRuleSchema),
    stdin: CliStdinPolicySchema,
    timeout: ConfiguredCliTimeoutPolicySchema,
    executionTarget: z.discriminatedUnion('kind', [
      NormalizedControllerHostTargetSchema,
      NormalizedEphemeralManagedVmTargetSchema,
    ]),
    output: ConfiguredCliOutputPolicySchema,
  }).strict(),
])
```

The authored parser accepts only `ControlFreeImageRecipePathSchema` in `executionTarget.imageReference` and rejects the reserved `agent-vm-prepared-image:` prefix. The effective-generation loader requires `PreparedManagedVmImageIdentitySchema` in that same persisted field, decodes it once, and constructs `NormalizedEphemeralManagedVmTargetSchema`. An authored recipe string, malformed prefix/base64url/JSON, unknown schema version, extra field, or missing/empty returned value cannot enter the normalized registry. The normalized target stores the decoded provider-local `preparedImage.imageReference` and `preparedImage.fingerprint`; unresolved recipes never enter a current generation.

### Gateway-safe projection and public request

```ts
const GatewayControllerExecutionProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('registered_action'),
    descriptor: CapabilityDescriptorSchema,
    summary: CapabilitySummarySchema,
  }).strict(),
  z.object({
    kind: z.literal('configured_cli'),
    timeoutKind: z.enum(['quick', 'open']),
    targetKind: z.enum(['controller_host', 'ephemeral_managed_vm']),
    descriptor: DerivedConfiguredCliDescriptorSchema,
    summary: CapabilitySummarySchema,
    admission: z.object({
      commands: z.array(CliAllowedCommandSchema),
      deniedPatterns: z.array(CliPatternRuleSchema),
    }).strict(),
  }).strict(),
])

const GatewayControlControllerExecutionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('registered_action'),
    action: GatewayControlRegisteredActionPayloadSchema,
  }).strict(),
  z.object({
    kind: z.literal('configured_cli'),
    capability: GatewayControlCapabilityRefSchema,
    input: z.union([QuickConfiguredCliInputSchema, OpenConfiguredCliInputSchema]),
    callerContext: GatewayControlCallerContextRefSchema,
    correlation: GatewayControlToolCallCorrelationSchema,
    approvalReservation: ControllerExecutionDispatchReservationSchema.optional(),
  }).strict(),
])

const GatewayControlControllerExecutionResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('registered_action'),
    action: GatewayControlRegisteredActionResultSchema,
  }).strict(),
  z.object({
    kind: z.literal('configured_cli'),
    execution: ControllerExecutionResultSchema,
  }).strict(),
])
```

Target kind and timeout class are safe projection metadata only because Gateway needs them to choose the derived public schema and ask a code-owned envelope resolver for a response window. They are not caller choice. The controller payload has no target or timeout-policy field beyond public optional open `timeoutMs`, and no raw `expiresAtMs`.

### Controller-derived RPC window

```ts
interface ControllerExecutionRpcWindow {
  readonly expiresAtMs: number
  readonly provisioningBudgetMs: number
  readonly resolvedCommandRuntimeMs: number
  readonly fixedDeliveryCleanupMarginMs: number
}
```

The Gateway asks a code-owned resolver keyed by trusted safe target kind, timeout class, and validated public input. The resolver applies fixed per-target provisioning budgets and a fixed delivery/cleanup margin:

```text
expiresAtMs = now
            + provisioningBudget(targetKind)
            + resolveRuntime(timeoutKind, publicInput)
            + fixedDeliveryCleanupMargin
```

Approval waiting occurs before the controller execution RPC and is excluded. The controller repeats the derivation from current trusted policy and rejects an envelope whose response window does not match. The caller/Gateway cannot provide a deadline.

Gateway Control uses this resolved window for the `controller_execution` result wait instead of the current fixed controller-host-action timeout entry. The transport carries no caller-authored timeout field and introduces no second clock or deadline authority.

### Result certainty is target-specific

One misleading common process result is forbidden. Both branches eventually project into the portable Portal algebra, but they retain different internal evidence:

```ts
type ControllerHostExecutionResult =
  | { readonly kind: 'not_started'; readonly reason: HostPreSpawnReason }
  | { readonly kind: 'exited'; readonly exitCode: number; readonly output: BoundedCliOutput }
  | { readonly kind: 'terminated'; readonly reason: 'cancelled' | 'timed_out' | 'overflow' }
  | { readonly kind: 'started_unresolved'; readonly reason: HostUnresolvedReason }

type EphemeralManagedVmExecutionResult =
  | { readonly kind: 'not_dispatched'; readonly reason: VmPreDispatchReason }
  | { readonly kind: 'completed_contained'; readonly exitCode: number; readonly output: BoundedCliOutput }
  | { readonly kind: 'terminated_contained'; readonly reason: 'cancelled' | 'timed_out' | 'overflow' }
  | { readonly kind: 'ambiguous'; readonly reason: 'dispatch_armed' | 'containment_unproven' }
```

Host pre-spawn is proven not dispatched. After host start, observed direct-child exit/termination does not prove descendant or external-effect containment; retry remains manual/forbidden according to the portable outcome. VM safe terminal results require the lifecycle ledger to record positive containment after close/exact termination. Dispatch-armed or containment-unproven always maps to ambiguous/forbidden. Every mapper exhaustively switches its own union and ends in `never`.

The current neutral `ManagedVm.exec` surface has no separate guest-start acknowledgement. The runner therefore excludes VM provisioning and final admission from command runtime, then arms the monotonic command timer immediately before invoking `ManagedVm.exec`. This uses the existing provider contract and requires no upstream Gondolin change or new provider observation system.

## Configuration compilation and freshness

The effective-config boundary produces one atomic generation with two trust-zone outputs:

```text
authored config + registered definitions + prepared image inventory
                              │
                    Controller Execution Compiler
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
 normalized registry    safe projection   policy revision
 controller-only        Gateway-only      semantic cohort
```

The existing effective-config materializer is the preparation caller. For each distinct authored ephemeral `imageReference`, it resolves the recipe path relative to the authored Tool Portal config directory and calls `ManagedVmImageCapability.prepareImage` with `cacheDir/gateways/<zoneId>/tool-portal-effective/controller-execution-images/<recipe-path-digest>`. Static configuration validation checks only the authored shape; Gateway startup preflight and runtime materialization require successful preparation.

The returned pair is validated by `PreparedManagedVmImageIdentityPayloadSchema`, encoded as base64url canonical JSON after the literal `agent-vm-prepared-image:v1:` prefix, and persisted only in the atomic effective Tool Portal generation at the operation's existing `executionTarget.imageReference` field. That field choice is an internal authored/effective parser boundary, not an authored format, image profile, registry entry, or second image authority. The effective loader decodes the pair into the normalized target; the compiler hashes the fingerprint into policy freshness; the controller executor passes only the provider-local reference to `ManagedVmFactory`. The safe Gateway projection carries neither the authored recipe, prepared reference, fingerprint, nor encoded identity.

For every effective profile the compiler:

- resolves explicit selectors against declared operations;
- resolves registered keys to one definition and evaluates applicability for every assigned agent/profile;
- parses target and timeout variants and rejects variant-inapplicable fields;
- resolves ephemeral `imageReference` to an immutable prepared image fingerprint;
- validates POSIX unique inherited environment names, stdin/output bounds, and regexes;
- builds `[...mandatoryArgvPrefix, ...commandPath]` for every configured path sharing an executable and rejects duplicate/proper-prefix relationships across namespaces, approval posture, target, and prefix/path splits;
- rejects duplicate capability/definition identities;
- derives a new safe projection rather than redacting/spreading trusted policy.

The atomic manifest selects one complete controller registry and matching Gateway projection. The controller reloads the current snapshot on every execution and compares the operation digest before approval arm and target dispatch.

`controllerExecutionPolicyRevision` includes operation kind, registered-definition identity/applicability, executable, prefix, effective paths, flag/pattern/stdin/output policy, timeout class, target kind, host cwd/environment or VM image fingerprint/guest cwd/environment/allowed hosts. It contributes to existing `bindingRevision` and `activeRevision`:

```text
controllerExecutionPolicyRevision → bindingRevision → activeRevision
  → exact approval intent/fingerprint → challenge → reservation → dispatch arm
```

Changing target, timeout class, requested/resolved timeout, immutable image fingerprint, or any other trusted field stales old challenges/reservations and produces zero dispatch effects.

The image path is therefore:

```text
tool-portal.config.jsonc recipe path
  -> effective-config materializer
  -> ManagedVmImageCapability.prepareImage
  -> strict prepared identity(reference + fingerprint)
  -> bindingRevision / approval freshness
  -> controller executor decode
  -> ManagedVmFactory.createManagedVm(provider-local reference)
```

Preparation failure, a malformed controller-only identity, or a missing reference/fingerprint fails before VM creation. Re-materializing changed recipe contents yields a changed prepared fingerprint and therefore a changed binding revision; an old challenge or reservation cannot dispatch it.

## Broad CLI validation and timeout semantics

Path resolution is exact leading-token equality. Configuration guarantees one match, so runtime never relies on insertion order. After the path:

- positional values and unmentioned flags remain ordinary admitted grammar;
- `--flag=value` normalizes only for exact long-name rule lookup;
- separated allowed values consume the next token;
- aliases are independent; short clusters remain one token;
- `--` creates no policy exemption—later tokens still pass deny/allowed-value checks;
- deny patterns apply by token shape;
- punctuation remains literal data because neither target invokes a shell;
- control characters and invalid stdin fail before target process start.

Quick input resolves 5,000 ms and rejects `timeoutMs`. Open input resolves omitted timeout to 120,000 ms and accepts only positive integers through 28,800,000 ms. The command clock begins on host `spawn` success or immediately before `ManagedVm.exec` after provisioning and final admission—not at approval, controller request acceptance, image resolution, VM creation, VM start, or identity publication.

## Catalog and Gateway composition

The Gateway builds one `controller_execution` catalog from safe projections:

- registered actions use the definition-derived domain schema;
- configured quick CLI uses strict `{ argv, reason, stdin? }`;
- configured open CLI adds only optional bounded `timeoutMs`;
- descriptors contain no executable, prefix, target, image, cwd, environment, stdin/output policy, provisioning budget, raw RPC window, or runner construction;
- `tools` controls discovery and existing `calls` selectors control direct versus approval-required admission.

The outer backend call accepts one item per controller execution reservation, validates the projected operation/public schema, registers caller context, derives the bounded response window, and sends one strict Gateway Control `registered_action | configured_cli` request. The controller response carries target-specific execution evidence already projected into the controller execution result union; Gateway does not reinterpret containment.

## Controller execution call paths

### Current typed host action to target umbrella

```text
CURRENT
model → tool_portal_call → ToolPortalService
  → hard-coded controller_host_action registration
  → Gateway Control actionId
  → controller authorization switch
  → probe or Git-push executor
  ← typed bounded result

TARGET
model → tool_portal_call → ToolPortalService                 unchanged
  → profile-aware controller_execution projection            changed
  → registered/configured public validation                  changed
  → Gateway Control controller_execution union               changed
  → current ControllerExecutionRegistry                      added
  → registered definition OR configured target dispatcher    added
  ← target-specific controller execution result              changed
  ← portable Portal item                                     unchanged shape
```

Registered `workspace_git_push` and probe preserve their executors/applicability through one definition owner; only the umbrella/catalog/control composition changes.

### Configured controller-host target

```text
configured_cli request
  → current policy/timeout/path/stdin revalidation
  → resolve fixed cwd + empty/allowlisted inherited environment
  → spawn(executable, [...prefix, ...argv], shell=false)
  → start command clock on spawn event
  → concurrently write bounded stdin/drain bounded stdout+stderr
  → timeout/cancel/overflow acts on direct child
  ← host-specific certainty → portable result
```

This production-complete generic host executor is new. It provides invocation/I/O/runtime bounds only. It does not promise filesystem, network, descendant, or external-side-effect containment.

### Configured ephemeral Managed VM target

```text
configured_cli request
  → current policy/image/timeout/path/stdin revalidation
  → operation ledger successor admission + reservation
  → record creation-started
  → EphemeralManagedVmFactory.create immutable code-owned request
  → record VM id + start + host-process identity
  → recheck authorization/epochs/image fingerprint
  → record dispatch-armed/running
  → arm command clock
  → vm.exec([executable, ...prefix, ...argv], { pty:false, shell:none })
  → bounded stdin/output/timeout/cancellation
  → record result
  → record containment-started → close/exact termination → contained
  ← safe terminal only after positive containment
```

`ManagedVmControllerRunner` supplies the existing reservation/identity/containment state machine, but production composition and narrowed configured-CLI authority are added. The production factory uses `ManagedVmProvider.factory.createManagedVm` with:

```ts
{
  imageReference: resolvedImmutableImageReference,
  rootfsMode: 'cow',
  mounts: {},
  allowedHosts: authoredAllowedHosts, // defaults []
  environment: resolvedNonSecretEnvironment,
  mediatedSecrets: [],
  tcpHosts: [],
  resources: CODE_OWNED_EPHEMERAL_RUNNER_RESOURCES,
  sessionLabel: codeOwnedOperationLabel,
  // no mediation, sshEgress, ingress, SSH enablement, or lease
}
```

The handle wraps `ManagedVm.start/exec/close/getHostProcessId` only. It never calls `enableSsh`, creates mounts, publishes a Tool VM binding, or exposes the VM to Gateway. One operation creates one VM; no reuse, adoption, replacement, or persistence exists.

### Preserved leased Tool VM path

```text
CURRENT = TARGET (intentionally unchanged)
model → ToolPortalService tool_vm_runner backend
  → profile catalog operation
  → acquisitionPort.acquire(trustedContext)
  → current caller lease/binding + active-use authority
  → StrictToolVmSshClient.connect
  → execute/read/write/process registry over SSH
  ← Gateway-owned result/artifact path

forbidden: tool_vm_runner → controller_execution RPC → ephemeral runner
```

No controller per-command RPC, image reference, ephemeral dispatch, or Managed VM factory call is added. Conversely controller execution never acquires this binding, lease, SSH client, retained process handle, or artifact writer.

## Approval presentation and exact retry

The settled approval design is target-independent. Existing operation-level selectors classify both operation forms; target/argv inspection never selects approval posture.

The bridge carries two separate values: portable bounded `GatewayApprovalPresentationRequest` and framework-local `HermesGatewayApprovalInteractionContext`. The latter routes the native prompt and supplies existing actor admission but never enters the controller intent, decision RPC, or model result.

```text
user → Hermes tool handler → initial portal.call
  ← approval_required challenge
  → Hermes Gateway Approval Interaction(session, request)
      unauthorized actor → bounded feedback; pending entry remains; no RPC/effect
      admitted actor → approved | denied | cancelled
  → private UDS approval.decide(challengeId, decision, trusted context)
  → existing caller_context_register(purpose=tool_portal_approval_decision)
  → Gateway Control approval decision { callerContext, decision }
  → controller ledger recorded | rejected
  → exact resubmission only when approved
  → current policy recomputes target + timeout + fingerprint
  → one admitted target dispatch
  ← replacement item merged by original id/order
```

The pinned Hermes `tools.clarify_gateway` module owns the transient pending entry, session index, callback resolution, blocking wait, and one-shot removal. The Agent VM adapter owns only its bounded captured route and one presentation call. It derives `clarify_id = "gwappr-" + challengeId`, registers exactly that id with the captured Hermes session key and choices `Approve | Deny`, schedules the captured platform adapter's `send_clarify` on the captured Gateway event loop, and waits through `wait_for_response` only until the controller challenge expiry. It maps only the exact returned choices to the generic outcome.

Pinned platform callbacks perform their existing actor admission before calling `resolve_gateway_clarify`; an unauthorized native interaction receives framework-bounded feedback, sends no decision RPC, and leaves the Hermes clarify entry pending. `wait_for_response` removes the exact entry on resolution or timeout. Existing Hermes session/Gateway teardown calls `clear_session`; the Agent VM route store does not clear a whole Hermes session or invent a second callback payload/registry. If native send fails, the presenter resolves only its own `clarify_id` with the existing primitive so its waiter can remove that exact entry. This path never reads or writes Hermes `tools.approval` FIFO, YOLO, session, or permanent approval caches. Native identity remains framework-owned.

The existing pinned Hermes `pre_gateway_dispatch` hook already supplies the live Gateway object and `MessageEvent.source`. The Agent VM hook preserves a bounded immutable route containing the admitted profile/session source, the Gateway-selected platform adapter from `_adapter_for_source(source)`, and the existing actor-admission callback `_is_user_authorized(source)`. The tool handler preserves trusted `session_id` rather than deleting it and uses that route to call the adapter's existing native interaction surface. This is a version-pinned in-repo integration: it changes no upstream Hermes source, creates no fork or monkeypatch, and does not reuse Hermes command-approval FIFO/YOLO/session/permanent caches.

The generic presentation request/outcome and Framework Approval Bridge live in the portable Python Agent Portal SDK so a framework integration can coordinate its native interaction with the request/response-only private UDS. They remain framework-neutral. Hermes is the only concrete presenter wired in this release. OpenClaw and Worker lifecycles declare no presenter capability, receive no adapter/UI implementation, and fail validation/preflight if selected for `managed_gateway` approval.

Gateway Runtime exposes `approval.decide` only over authenticated private UDS. It validates the original trusted context, reuses `caller_context_register` with the approval-decision purpose, and sends one strict Gateway Control wrapper containing the resulting opaque caller-context reference plus the canonical `{ challengeId, decision }` value. The controller resolves the caller context against the accepted session, derives stable principal, selects the sole managed authority, and calls the existing ledger. No principal is caller-authored, and presenter outcome alone never authorizes execution.

Batch coordination keeps approval-free items byte-identical and unrepeated; protected items are independent and replace only their original ids. Denied/cancelled/unavailable never reconcile through dispatch. Only an approved `already-decided`/unknown decision transport may perform one identical Portal resubmission. Aggregate status and original order are recomputed/preserved.

## State and lifecycle

### Effective policy

| State | Owner | Transition/guard | Illegal path |
| --- | --- | --- | --- |
| Authored | Deployment config | Strict backend/operation/timeout/target parse | Old umbrella, mixed variants, target override, invalid recipe path, overlap reject. |
| Compiled | Controller Execution Compiler | Definitions/applicability/images/profile invariants pass | Partial registry/projection generation forbidden. |
| Current | Atomic manifest | Select matching registry/projection/digest | Mixed generation cannot authorize. |
| Superseded | Manifest | New complete generation current | Old challenge/reservation cannot dispatch. |

### Approval

```text
pending → approved → reserved → consumed → dispatch-armed
   ├────→ denied
   ├────→ expired
   └────→ revoked
```

The controller ledger owns all transitions. Target/timeout/image/policy/principal mismatch blocks reserve/arm.

### Ephemeral runner

```text
admitted → reserved → creation-started → vm-created → identity-published
  → admission-validated → dispatch-armed → running → result
  → containment-started → contained

before dispatch failure → proven not-dispatched
after arm failure       → ambiguous dispatch-armed
close/termination gap   → ambiguous containment-unproven
```

The existing controller runner operation ledger is durable source of truth. A predecessor with unproven containment blocks successor admission. No state authorizes reuse/adoption.

### Host process

```text
policy-resolved → input/context-resolved → spawning
  ├─ failure before spawn event → not-started
  └─ spawn-observed → running
       ├─ exit observed
       ├─ direct-child termination observed
       └─ termination/result unknown → ambiguous
```

Host termination does not equal containment of descendants or external effects.

## Failure and recovery

| Failure | Owner | Result/recovery |
| --- | --- | --- |
| Invalid backend/target/timeout/overlap/image | Schema/compiler | Reject generation before startup. |
| Quick carries `timeoutMs`; open out of range | Public schema/controller resolver | Proven pre-dispatch denial. |
| Forged target/policy/raw deadline in Gateway payload | Strict wire schema | Reject before domain handling. |
| RPC response window mismatch | Controller resolver | Stale/not authorized before target dispatch. |
| Policy/target/timeout/image changes after challenge | Registry/ledger | Stale fingerprint; zero effects; new intent required. |
| Host cwd/env/executable unavailable | Host executor | Proven not-started. |
| Host controller-owned timeout/cancel/overflow after start | Host executor | Abort/terminate the direct child through the call-scoped signal; possible effects remain; no automatic replay. |
| VM image/setup/identity failure before arm | VM runner/ledger | Proven runner-setup-failed; cleanup attempted. |
| VM failure after arm | VM runner | Ambiguous dispatch-armed until containment. |
| VM close/exact termination cannot prove absence | VM runner/ledger | Ambiguous containment-unproven; successor blocked. |
| VM controller-owned timeout/cancel | VM runner | Abort the existing `ManagedVm.exec` call, then close/exact termination; safe terminal only if contained, otherwise ambiguous. No Gateway cancellation RPC is added. |
| Fixed stderr sanitizer failure | Code-owned sanitizer | Fixed non-secret unavailable summary; raw stderr hidden. |
| Tool VM binding/SSH failure | Existing Tool VM runner | Existing not-bound/ambiguous result; no fallback to controller execution. |
| Unauthorized native actor | Hermes interaction | Fixed bounded feedback, pending prompt/challenge unchanged, no decision/effect. |
| Presenter unavailable/session ends | Framework bridge | Proven not-dispatched item; challenge may expire. |
| Approved decision response lost | Bridge | At most one identical Portal reconciliation. |
| Framework crash before retry | Ledger | Zero target effects; later exact call remains controller-gated. |

Neither target auto-replays after process start/dispatch arm. Recovery truth is current registry + approval ledger + target-specific execution/lifecycle evidence.

## Concurrency and consistency

- Atomic effective generation prevents registry/projection/image-digest skew.
- Controller reload and digest comparison happen before reservation arm and again before target dispatch.
- Effective-command uniqueness removes order-dependent CLI resolution even across target and prefix/path splits.
- Controller ledger is the atomic decision/dispatch-arm boundary.
- Ephemeral operation ledger atomically reserves one operation/runner identity and blocks unsafe predecessors; one operation creates one VM.
- Host configured operations may run concurrently; no generic CLI lock is invented. Registered definitions retain domain locks.
- VM provisioning and approval waiting do not consume command runtime. One injected monotonic clock boundary begins at target process start.
- RPC response window bounds provisioning + runtime + cleanup/delivery, while command timeout bounds only execution.
- The derived RPC lifetime and controller shutdown are the only target cancellation owners; Gateway/framework/model payloads gain no cancellation operation.
- Output streams are drained concurrently and bounded per stream.
- Hermes `tools.clarify_gateway` serializes exact `(session_key, clarify_id)` resolution; platform actor admission rejects unauthorized callbacks before resolution, and mismatched ids cannot remove the entry.
- `tool_vm_runner` retains existing active-use/current-generation checks and process-group lifecycle independently.

## Trust and containment boundaries

```text
model-controlled
  generic quick/open input
        │ schema + profile policy
        ▼
Gateway Runtime
  safe projection only; no target authority
        │ authenticated UDS + strict Gateway Control
        ▼
controller execution authority
  current registry + digest + approval reservation
        │
   ┌────┴──────────────────┐
   ▼                       ▼
host process            ephemeral Managed VM
controller OS authority COW rootfs, no mounts/SSH/lease/secrets/TCP
no containment claim    authored allowed hosts, positive close containment

separate Gateway boundary
tool_vm_runner → current leased Tool VM over strict SSH
```

Assets are trusted policy, immutable image identity, approval state, registered-action authority, host authority, VM containment state, and current Tool VM binding. Enforcement points are strict schemas, caller context, current registry, semantic digest, ledger arm, code-owned VM create request, operation lifecycle identity, exact termination, and strict SSH binding checks.

Host configured CLI is uncredentialed but inherits controller OS filesystem/network authority. Ephemeral CLI is also uncredentialed and gets only the code-owned COW/no-mount/no-SSH/no-mediation/no-TCP construction plus authored allowed hosts/environment/guest cwd. Its positive containment claim is limited to Managed VM process/lifecycle evidence. Tool VM runner retains its distinct lease/SSH/workspace/artifact authority.

## Compatibility and cutover

| Boundary | New authority | Version skew behavior |
| --- | --- | --- |
| Backend kind | `controller_execution` only | `controller_host_action` rejected; no alias/dual parser. |
| Configured CLI | Target + timeout discriminants | Old host-only/fixed-timeout shapes rejected. |
| Safe projection | Derived quick/open schema + target/timeout metadata | Mixed semantic cohort fails attachment/readiness. |
| Gateway Control | Outer `registered_action | configured_cli` | Old peers fail protocol/preflight; no trusted-field fallback. |
| Host executor | New production direct executor | Feature remains disabled until exact release is present. |
| Ephemeral target | Existing scaffold + new production factory/composition | Feature remains disabled until real VM proof passes. |
| Hermes interaction | In-repo adapter against the pinned Gateway hook/adapter surface | Hermes declares presenter capability; OpenClaw and Worker remain unsupported with no fallback. |
| Tool VM runner | Existing backend/SSH contracts | No schema, call path, or runtime cutover. |
| Approval records | Existing ledger + managed operator variant | Old semantic intent becomes stale, never migrated into dispatch. |

No configured controller execution is enabled until registry, projections, Control contracts, host executor, target dispatcher, and relevant target composition ship together. Rollback restores one complete prior package/image/config set; it never aliases the new backend to the old host name.

## Proof architecture

### Unit observation floor

Unit proof owns:

- strict backend/operation/target/timeout/environment/stdin/output/flag/pattern and approval/presenter/decision/result schemas plus generated JSON Schema;
- old umbrella rejection, mixed target fields, mutable/unresolved image, caller runner fields, raw deadline, duplicate POSIX env, unsupported configured credentials/containment fields;
- quick rejection of timeout, exact 5,000 resolution, open 120,000 default and bounded override;
- RPC window formula for host/VM provisioning budgets and fixed margin;
- exact effective-command overlap including different prefix/path splits and targets;
- path/positional/flag/`--`/punctuation/control/stdin/deny tables;
- policy digest determinism and mutation for target, timeout, requested/resolved runtime, image fingerprint, and every trusted field;
- safe projection forbidden-field inspection and quick/open catalog derivation;
- one reviewed definition identity/schema/catalog/control/applicability/executor with host action eligibility regressions;
- host result mapper and VM containment result mapper as separate exhaustive unions;
- code-owned VM create request exactly COW/no mounts/no SSH/lease/mediation/secrets/TCP and fixed resources;
- sanitizer and presenter/actor/result/batch exhaustive tables;
- static forbidden-edge proof that Tool VM runner has no controller execution RPC and controller execution has no Tool VM binding/SSH types.

Unit tests replace processes/providers/transports only for pure decisions.

### Cross-process integration floor

Integration uses real Framework Approval Bridge, `ToolPortalService`, private UDS, Gateway Runtime, Gateway Control session/contracts, caller context, controller ledger, current registry/compiler, target dispatcher, and operation ledger. Final host executor, Managed VM provider, and native presenter may be observable fakes at this floor.

It proves:

- catalogs/projections omit all trusted target/process/deadline fields;
- forged target/image/policy/deadline fails before controller execution;
- quick/open public schemas and controller-derived RPC windows agree;
- approval-free and approved calls select the configured fake target once; denial/stale/changed target/timeout/image selects zero;
- requested/resolved timeout is exact intent and runtime starts only on host start or the post-provisioning `ManagedVm.exec` boundary;
- typed registered and both configured targets coexist under one catalog/policy/result path;
- current policy reload, applicability, batches, rejection of removed bearer approval config and routes, unsupported presenter, wrong principal, unauthorized actor, and crash-before-retry retain settled behavior;
- ephemeral fake provider observes one operation reservation/create/start/identity/arm/exec/close sequence;
- Tool VM runner uses a real acquisition/strict-SSH seam, produces no controller execution RPC call, and receives no ephemeral image; controller execution never acquires its binding.

A fake VM provider cannot prove actual VM lifecycle, network containment, COW/no-mount isolation, or host process termination.

### Host e2e floor

Production host executor plus permanent fixture observes exact executable/prefix/argv/punctuation/stdin/cwd/allowlisted environment, shell sentinel absence, process-start clock boundary, quick/open runtime, stdout/stderr bounds/sanitizer, exit/non-zero/overflow/cancel/timeout, and target-specific certainty. It proves no shell and no automatic replay, but makes no containment claim.

### Real Managed VM e2e floor

Real `ManagedVmProvider`, production ephemeral factory, production runner, operation ledger, and immutable fixture image observe:

- prepared immutable image/fingerprint resolution;
- one fresh VM and one code-owned create request with COW rootfs, no mounts, no SSH enabling/egress, no lease/binding, no reuse/adoption/replacement, no mediation/secrets/TCP mappings, fixed resources;
- exact guest argv/stdin/guest cwd/empty-or-allowlisted environment;
- command timer arms immediately before `ManagedVm.exec`, after image resolution, VM creation/start, identity publication, and final admission;
- `allowedHosts: []` network denial and explicitly allowed-host behavior;
- provisioning excluded from command runtime and the clock starts immediately before `ManagedVm.exec`;
- output/timeout/cancel behavior, identity record before arm, close/exact termination, positive containment, and successor blocking when containment is unproven.

This is the minimum proof of V18. Fake runner/provider evidence cannot substitute.

### Hermes e2e floor

The updated in-repo Hermes adapter installed on the pinned immutable Hermes image, plus real controller, Runtime, Tool Portal, native presenter, ledger, target dispatcher, production host fixture, and real Managed VM fixture prove admitted approval dispatches exactly once on each target; denial/unauthorized actor/changed target or timeout/stale image/duplicate/session mismatch dispatch zero; unauthorized feedback leaves challenge pending and sends no decision RPC; mixed batch order remains stable; crash before retry produces zero effects; and no credential, native identity, target policy, reservation, raw deadline, or unredacted content leaks.

### Leased Tool VM regression floor

Gateway Runtime integration with the real Tool VM runner backend and strict SSH client seam proves the current caller lease/binding is acquired, bytes follow direct Gateway→SSH, no per-command controller execution RPC occurs, no ephemeral provider is invoked, and existing file/process/artifact behavior remains. A paired controller-execution call proves it never acquires the Tool VM binding or SSH seam.

## Requirement/design/proof trace

| Contract | Structural realization | Minimum proof |
| --- | --- | --- |
| R1–R3 | Existing selectors, managed-Gateway-only authority, lifecycle presenter capability | Unit/config integration/Hermes preflight. |
| R4–R5, R12 | Portable sanitized request + framework context + Hermes actor-bound component | Unit interaction tables, component integration, Hermes e2e. |
| R6–R8 | Private decision RPC, derived principal, ledger, exact target/timeout intent | Real UDS/Control/ledger integration and Hermes e2e. |
| R9 | Per-item bridge coordinator/projector | Unit outcome matrix and batch integration/e2e. |
| R10–R11 | Absent external approval routes and non-authoritative framework state | Controller route/config hard-cut integration and crash e2e. |
| R13 | `controller_execution` operation union + reviewed definition + target-neutral CLI | Schema/JSON Schema and typed/both-target integration. |
| R14 | Quick/open derived schemas, resolver, RPC window | Unit clocks/resolver and host/VM integration. |
| R15–R17 | Effective paths, flag/`--` rules, direct argv | Unit tables plus host and VM transcripts. |
| R18 | Common bounds, host executor, ephemeral factory/runner/containment | Host e2e and real Managed VM e2e. |
| R19 | Safe catalog plus explicit leased Tool VM separation | Projection integration and leased Tool VM regression. |
| R20 | Current reload, target dispatch, full digest, derived deadline | Cross-process integration and both target e2e. |
| R21 | Upgrade identity diagnostics and no grammar mirror | Config validation/digest inspection. |
| R22 | Definition-owned registered target/executor sharing policy/result | Schema-drift/applicability/typed coexistence regression. |
| R23 | Operation-level approval with exact target/timeout binding | Integration and Hermes both-target proof. |

| Proof obligation | Owning floor |
| --- | --- |
| V1–V2 | Unit config + startup/preflight integration |
| V3–V8 | Approval unit/integration/Hermes e2e |
| V9–V13 | Schema/validator/catalog unit + integration + target transcripts |
| V14 | Real private UDS/Control integration across both targets |
| V15 | Host e2e |
| V16–V17 | Hermes both-target and typed coexistence integration |
| V18 | Real Managed VM e2e |
| V19 | Leased Tool VM regression integration |
| V20 | Deterministic timeout/window unit + host/VM injected-clock integration |

Stable proof identities are all covered without supersession: V1 by managed-Gateway-only operation/config variants; V2 by preflight; V3 by native interaction; V4 by exact dispatch counts; V5 by batch projection; V6 by crash/presenter failure; V7 by approval-route absence and bearer-config rejection; V8 by sanitizer/feedback leakage checks; V9 by strict controller-execution schema; V10 by effective-path uniqueness; V11 by flag and `--` behavior; V12 by target transcripts and invalid-input rejection; V13 by quick/open catalog and safe projection; V14 by private UDS/Control target selection; V15 by host e2e; V16 by managed approval on both targets; V17 by typed/configured coexistence; V18 by real one-shot Managed VM containment; V19 by unchanged leased Tool VM strict SSH; and V20 by timeout/window clocks.

Accepted needs remain covered without supersession: U1 by unchanged call policy; U2 by native presentation; U3 by exact ledger intent; U4 by framework-owned actor admission; U5 by reuse of existing Runtime/Control/ledger/provider seams; U6 by target-neutral CLI config; U7 by derived quick/open public input; U8 by controller-only target/deadline authority and honest guarantees; U9 by exact paths/flag carve-outs; U10 by reviewed definitions; and U11 by the one-shot Managed VM factory/ledger and explicit Tool VM separation.

Stable specification identities are all realized without supersession: R1 selectors; R2 managed-Gateway-only approval authority; R3 presenter capability; R4 bounded actor-bound request; R5 presenter outcome union; R6 controller-only decision; R7 fail-closed decision results; R8 exact target/timeout retry; R9 batch partial success; R10 external approval HTTP/config hard cut; R11 framework non-authority; R12 diagnostics; R13 backend/operation/target union; R14 timeout/public-schema/window derivation; R15 exact paths; R16 optional flag rules and no `--` bypass; R17 array argv; R18 common bounds and target-specific guarantees; R19 catalog and leased Tool VM separation; R20 controller revalidation/dispatch; R21 upgrade review boundary; R22 definition-owned typed actions; and R23 operation-level approval.

## Deliberate simplifications and revisit signals

- No target-specific CLI backend: one target-neutral policy is sufficient. Revisit only if a target cannot share public input/approval/result contracts.
- No Tool VM runner reuse: its leased SSH lifecycle remains distinct. Revisit only through a separate owner decision changing that product meaning.
- No configured credentials: credentialed work promotes to a registered definition.
- No caller/resource/runner-construction surface: ephemeral resources and isolation stay code-owned. Revisit only with an authorized capacity/config requirement.
- No VM reuse/adoption: one-shot lifecycle is the containment boundary. Revisit only with a new persistence/ownership specification.
- No host containment claim: host target proves invocation, I/O, and runtime only.
- No per-CLI grammar mirror: executable/image upgrade reopens ordinary admitted grammar.
- No presenter registry, identity federation, standing approval, or durable presentation state: one first presenter and framework-owned actor identity are sufficient.
- No OpenClaw or Worker presenter: the generic contract ships with only the Hermes adapter implementation.
- No upstream framework/provider work: pinned in-repo adapter and existing ManagedVm contracts are the implementation boundary.
- No automatic dispatch recovery: a current exact call must re-enter controller admission.
