# Tool Portal Composition Contract

Status: revision draft for `shravan-dev-workflow:spec-review-swarm`

Supersedes the design contract portions of
`docs/superpowers/specs/2026-06-20-portable-capability-interfaces-design.md`
where they conflict with this document.

This spec defines the contract. It does not define implementation order, worker
assignment, execution DAGs, or exact validation commands. A replacement plan must
derive those from this spec after spec review.

## Product Intent

Agents need one portable capability facade for external services and
controller-mediated actions.

The model-facing contract is:

```text
agent runtime
  -> one of the Tool Portal call surfaces
  -> Tool Portal in-process service
  -> Tool Router
  -> exactly one trusted backend binding
  -> backend-specific trusted executor
```

MCP Portal remains a standalone product for upstream MCP provider mediation.
Tool Portal composes MCP Portal when a portable capability is backed by an MCP
provider. In managed agent runtimes, the agent sees Tool Portal, not MCP Portal
internals.

## Terms

- **MCP Portal**: MCP-provider mediation service. It owns upstream MCP provider
  config, provider credentials, MCP provider catalog discovery, and MCP-specific
  policy evaluation.
- **Tool Portal**: portable capability service. It owns the model-visible
  capability catalog, cross-backend policy, backend binding, approval result
  shape, and runtime-neutral call surface.
- **Call surface**: a way to call a service: in-process TypeScript, SDK, CLI,
  HTTP API, external MCP server, or OpenClaw native plugin.
- **Tool Router**: Tool Portal's router from a portable capability reference to
  exactly one backend binding. It is not the MCP provider router.
- **MCP provider router**: MCP Portal's routing from MCP provider namespace/tool
  calls to upstream MCP providers.
- **Controller-owned execution**: actions where the controller recomputes the
  executable, argv, cwd, env, credential profile, VM profile, egress, output
  policy, and approval freshness from trusted config before anything runs.
- **Credentialed runner**: a controller-owned ephemeral runner VM with strict
  controller RPC/ManagedVm `exec`/`fs` control. The agent may request an action;
  the agent never controls this VM.
- **Sandbox runner**: the existing OpenClaw tool sandbox VM path. It is a named,
  lease-owned, agent-controlled sandbox reached through OpenClaw/SSH semantics.
  It is not a credentialed runner.

## Non-Goals

- Do not expose `mcp_portal_*` model-facing tools in managed Tool Portal mode.
- Do not keep an OpenClaw MCP Portal plugin as a managed-agent compatibility
  path after the cutover.
- Do not reuse `/zones/:zoneId/execute-command` for Tool Portal controller
  dispatch.
- Do not let the model choose backend kind, executable path, argv template, cwd,
  env, credential profile, VM profile, egress hosts, output cap, or approval
  token.
- Do not require a typed semantic catalog for every possible CLI command.
- Do not implement Python SDK in the first contract. Python SDK remains a later
  Hermes-driven surface.

## Threat Model

Security context is applicable. This spec touches auth, secrets, MCP provider
credentials, approval, plugins, subprocesses, controller routes, and VM
execution.

### Assets

- upstream MCP provider credentials
- controller-only host credentials such as GitHub tokens
- Tool Portal and MCP Portal approval records
- agent, profile, user, and session identity
- model-visible capability catalog
- Tool Portal caller credentials used by CLI, HTTP, MCP server, SDK, or native
  plugin call surfaces
- controller executable templates and credential profiles
- runner VM filesystem, stdout, stderr, and artifact references
- managed OpenClaw prompt/tool/event surface

### Actors

- **honest agent**: follows Tool Portal instructions and may make mistakes.
- **malicious or compromised agent**: can choose arguments, reason text, and
  ordinary sandbox commands, and can attempt token exfiltration from surfaces it
  can see.
- **operator**: approves actions and owns user-scoped credentials.
- **runtime adapter**: trusted only to derive caller identity from its runtime
  boundary and to call Tool Portal with a trusted adapter envelope.
- **controller**: trusted authority for controller-owned execution,
  re-authorization, approval verification, and credential custody.
- **upstream provider**: outside the trust boundary; its result payloads may
  contain hostile or sensitive fields.

### Trust Boundaries

```text
model request
  untrusted: arguments, reason text, capability reference

call surface
  trusted only for: authenticated caller provenance and transport I/O

Tool Portal
  trusted for: catalog scoping, policy, backend binding, result normalization

controller dispatch boundary
  trusted for: re-authorization, approval freshness, execution controls

runner VM / upstream MCP provider
  untrusted outputs: stdout, stderr, artifacts, provider result payloads
```

### Required Security Outcomes

- The model never receives upstream MCP provider credentials.
- The model never receives controller host credentials.
- The model never receives, forges, exports, or replays Tool Portal caller
  credentials or trusted adapter envelopes.
- The model never controls credentialed runner execution controls.
- Hidden capabilities are not disclosed through distinguishable errors.
- Approval cannot be replayed after relevant catalog, policy, binding,
  argument, identity, output, artifact, or execution fingerprints change.
- Managed Tool Portal mode does not leak MCP Portal tool, event, package, or
  plugin identity to the model.
- Backend success payloads are normalized before becoming model-visible.
- Standalone MCP Portal remains isolated from Tool Portal policy and controller
  execution contracts.

## Requirements

R1. Tool Portal is the managed-agent facade.
Managed OpenClaw and future managed Hermes integrations call Tool Portal. MCP
Portal internals are hidden from the model in those modes.

R2. MCP Portal remains independently usable.
Standalone MCP Portal mode may expose `mcp_portal_list`,
`mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call` to MCP Portal
consumers that explicitly choose MCP Portal.

R3. Tool Portal can be called through multiple surfaces.
The same Tool Portal operations are available through in-process TypeScript,
OpenClaw plugin, CLI, HTTP API, TS SDK, and a Tool Portal MCP server. These are
transports, not separate policy paths. Python SDK is not a first-version
requirement.

R4. Tool Router and MCP router are separate.
The Tool Router maps portable capabilities to Tool Portal backend bindings.
The MCP router maps MCP Portal calls to upstream MCP providers.

R5. Tool Portal composes MCP Portal only through the MCP-provider backend seam.
Tool Portal may call the exported MCP-provider backend adapter. Tool Portal must
not import MCP Portal core internals directly.

R6. Backend dispatch is catalog-static and fail-closed.
A listed portable capability must resolve to exactly one backend binding for the
active profile. An unbound capability is not listed. A call to an unbound or
ambiguous capability fails as `not_found` or `configuration_error`; it never
defaults to MCP.

R7. All boundary contracts are Zod v4 schemas.
Every request, result, config, backend dispatch, controller RPC, approval,
artifact, and CLI allowance boundary is defined in Zod v4. JSON Schema artifacts
are generated from those Zod schemas where a surface advertises JSON Schema.

R8. Public portable capability identity is `{ namespace, name }`.
Backend-specific vocabulary such as MCP `toolName` is an internal adapter
translation.

R9. Controller-owned execution is re-authorized at the controller.
For controller host actions and credentialed runners, the gateway or Tool Portal
adapter sends a control-field-free dispatch intent. The controller recomputes
the executable plan from trusted config and only then executes.

R10. Credentialed runners are ephemeral strict-RPC runners.
Credentialed runner actions run in controller-owned ephemeral VMs. They have no
agent SSH, no shell strings, no PTY, no inbound listener, and no model-selected
execution controls.

R11. CLI access uses capability envelopes plus promotion.
Generic CLI allowances are coarse, approval-gated capability envelopes. Common
operations can be promoted into typed tools with schema-validated arguments and
trusted argv templates.

R12. Approval is a hook with a stable model-visible result.
The agent sees `approval_required` and stops. Approval tokens, fingerprints,
binding revisions, and replay prevention remain runtime/controller concerns.

R13. OpenClaw hard-cutovers to Tool Portal.
The existing `openclaw-mcp-portal-plugin` implementation may be renamed and
retrofitted, but the final managed architecture has
`@agent-vm/openclaw-tool-portal-plugin`, not an OpenClaw MCP Portal plugin.

## Boundary Map

```text
agent model
  owns: intent, arguments, reason text
  sees: portable capability names only

      |
      v

call surfaces
  owns: runtime auth context and I/O adaptation
  examples: OpenClaw plugin, Tool Portal MCP server, CLI, HTTP API, TS SDK
  contract: ToolPortalList/Search/Describe/Call schemas

      |
      v

Tool Portal in-process service
  owns: model-visible catalog, profile policy, backend binding, result shape
  exposes: one runtime-neutral entrypoint

      |
      v

Tool Router
  owns: capability -> backend binding totality
  exposes: backend dispatch intent

      +-----------------------+-------------------------+--------------------+
      |                       |                         |                    |
      v                       v                         v                    v

MCP backend            controller host action     credentialed runner     future backend
  owns adapter          owns narrow host           owns ephemeral          must define
  translation           controller operation       runner dispatch         same contracts
  calls MCP Portal      controller reauth          controller reauth

      |
      v

MCP Portal
  owns upstream MCP providers, MCP provider catalog, MCP credentials,
  MCP-specific schema validation, and upstream MCP routing
```

## Call Surfaces

All Tool Portal call surfaces expose the same four operations:

```text
tool_portal_list
tool_portal_search
tool_portal_describe
tool_portal_call
```

Surface names may follow surface conventions, but the model-visible operation
identity in Tool Portal mode is `tool_portal_*`.

### Surface Responsibilities

| Surface | Owns | Must Not Own |
| --- | --- | --- |
| In-process TypeScript | direct function calls inside trusted runtime | backend policy forks |
| OpenClaw plugin | OpenClaw trusted context, native tool registration, prompt hints, event conversion | MCP Portal core wiring or `mcp_portal_*` tools |
| Tool Portal MCP server | MCP transport over Tool Portal operations | MCP provider routing authority |
| CLI | stdin/stdout JSON, token/env discovery, shell-friendly wrappers | policy decisions |
| HTTP API | authenticated session transport | backend selection beyond Tool Router |
| TS SDK | typed client ergonomics | separate contracts |
| Python SDK | later surface for Hermes | first-version requirement |

### Trusted Caller Provenance

Public Tool Portal request schemas never carry trusted caller identity. Each
call surface wraps the public request in an adapter envelope before it reaches
Tool Portal.

Tool Portal caller credentials are runtime credentials, not model credentials.
Model-facing surfaces must derive trusted caller identity from protected runtime
state that is not readable, writable, forgeable, exportable, or replayable by
the model. Caller credentials must be scoped to the surface, agent/profile/user
assignment, and session or lease where applicable. Public request bodies, model
arguments, CLI argv, stdin, HTTP JSON bodies, MCP tool arguments, and SDK public
method arguments must not carry `trustedCaller` or raw caller credentials.

```ts
export const ToolPortalTrustedCallerSchema = z
  .object({
    agentId: z.string().min(1),
    profileId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    source: z.enum([
      "cli",
      "http-api",
      "in-process-sdk",
      "openclaw-plugin",
      "tool-portal-mcp-server",
    ]),
    userId: z.string().min(1).optional(),
  })
  .strict();

export const ControllerApprovalProofReferenceSchema = z
  .object({
    approvalRecordId: z.string().min(1),
    kind: z.literal("controller_approval_record"),
  })
  .strict();

export const ToolPortalApprovalProofReferenceSchema = z
  .object({
    approvalRecordId: z.string().min(1),
    kind: z.literal("tool_portal_approval_record"),
  })
  .strict();

export const ToolPortalTrustedApprovalProofSchema = z.discriminatedUnion("kind", [
  ControllerApprovalProofReferenceSchema,
  ToolPortalApprovalProofReferenceSchema,
]);

export const ToolPortalAdapterEnvelopeSchema = z
  .object({
    auditCorrelationId: z.string().min(1),
    trustedCaller: ToolPortalTrustedCallerSchema,
  })
  .strict();

export const ToolPortalBackendDispatchEnvelopeSchema = z
  .object({
    adapter: ToolPortalAdapterEnvelopeSchema,
    approval: ToolPortalTrustedApprovalProofSchema.optional(),
  })
  .strict();
```

| Surface | Trusted identity source |
| --- | --- |
| OpenClaw plugin | OpenClaw trusted tool context supplies agent/session; Tool Portal profile is resolved from trusted config |
| Tool Portal MCP server | local server auth/session maps to agent/profile/user before Tool Portal request parsing |
| CLI | lease/token-file or equivalent local runtime credential maps to agent/profile/user |
| HTTP API | authenticated HTTP session maps to agent/profile/user |
| In-process TypeScript/TS SDK | caller supplies an already trusted adapter envelope from the embedding runtime |

If a surface cannot derive trusted caller identity, it must fail before parsing
or forwarding the public Tool Portal request.

If a public request includes trusted identity fields or approval material, the
surface must reject it rather than silently ignoring those fields.

### Tool Portal MCP Server

The Tool Portal MCP server is a call surface. It does not make Tool Portal into
MCP Portal and does not expose MCP Portal tools.

Version 1 exposes the four universal Tool Portal MCP tools only:

```text
tool_portal_list
tool_portal_search
tool_portal_describe
tool_portal_call
```

Generated per-capability MCP tools are optional future adapter sugar. If added,
they must compile back to the same Tool Portal call contract and must not become
a second catalog or policy authority.

MCP and CLI surfaces may offer ergonomic single-item wrappers. Those wrappers
are surface sugar only: they compile into the canonical batch request envelope
before Tool Portal policy, routing, approval, or backend dispatch.

## Service Composition

```text
Standalone MCP Portal mode

MCP client / SDK / CLI
  -> MCP Portal call surface
  -> MCP Portal core
  -> upstream MCP providers

Managed Tool Portal mode

OpenClaw / Hermes / CLI / SDK / MCP client
  -> Tool Portal call surface
  -> Tool Portal service
  -> Tool Router
  -> MCP backend
  -> MCP Portal core
  -> upstream MCP providers
```

If a consumer explicitly installs both MCP Portal and Tool Portal, that consumer
has chosen two facades. Agent VM managed defaults install only Tool Portal for
managed agents.

## Public Zod Contracts

These schemas are normative contract sketches. The implementation may split them
across feature slices, but exported schemas must preserve these fields and
semantics.

Tool Portal public schemas must be exported as Tool Portal contracts. Existing
shared SDK schemas that expose `toolName` are MCP Portal or stale first-slice
contracts and must not remain the public Tool Portal request/result/controller
dispatch contracts. `toolName` may appear only in MCP Portal contracts and inside
the MCP backend adapter translation layer.

```ts
import { z } from "zod";

export const ToolPortalRequestIdSchema = z.string().min(1);
export const ToolPortalNamespaceSchema = z.string().min(1);
export const ToolPortalCapabilityNameSchema = z.string().min(1);

export const JsonValueSchema: z.ZodType<
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }
> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const ToolPortalJsonSchemaDocumentSchema = z
  .object({
    $schema: z.literal("https://json-schema.org/draft/2020-12/schema").optional(),
  })
  .catchall(JsonValueSchema);

export const PortableCapabilityReferenceSchema = z
  .object({
    namespace: ToolPortalNamespaceSchema,
    name: ToolPortalCapabilityNameSchema,
  })
  .strict();
```

### Operation Requests

```ts
export const ToolPortalBatchMaxItems = 50;

export const ToolPortalListItemRequestSchema = z
  .object({
    id: ToolPortalRequestIdSchema,
    namespaces: z.array(ToolPortalNamespaceSchema).optional(),
  })
  .strict();

export const ToolPortalSearchItemRequestSchema = z
  .object({
    id: ToolPortalRequestIdSchema,
    query: z.string().min(1),
    namespaces: z.array(ToolPortalNamespaceSchema).optional(),
  })
  .strict();

export const ToolPortalDescribeItemRequestSchema = z
  .object({
    id: ToolPortalRequestIdSchema,
    capabilities: z.array(PortableCapabilityReferenceSchema).min(1),
  })
  .strict();

export const ToolPortalCallItemRequestSchema = z
  .object({
    arguments: JsonObjectSchema,
    id: ToolPortalRequestIdSchema,
    namespace: ToolPortalNamespaceSchema,
    name: ToolPortalCapabilityNameSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

export const ToolPortalListRequestSchema = z
  .object({
    requestId: ToolPortalRequestIdSchema.optional(),
    requests: z.array(ToolPortalListItemRequestSchema).min(1).max(ToolPortalBatchMaxItems),
  })
  .strict();

export const ToolPortalSearchRequestSchema = z
  .object({
    requestId: ToolPortalRequestIdSchema.optional(),
    requests: z.array(ToolPortalSearchItemRequestSchema).min(1).max(ToolPortalBatchMaxItems),
  })
  .strict();

export const ToolPortalDescribeRequestSchema = z
  .object({
    requestId: ToolPortalRequestIdSchema.optional(),
    requests: z.array(ToolPortalDescribeItemRequestSchema).min(1).max(ToolPortalBatchMaxItems),
  })
  .strict();

export const ToolPortalCallRequestSchema = z
  .object({
    calls: z.array(ToolPortalCallItemRequestSchema).min(1).max(ToolPortalBatchMaxItems),
    requestId: ToolPortalRequestIdSchema.optional(),
  })
  .strict();
```

Batch item IDs must be unique inside each request. The implementation must add a
Zod `superRefine` duplicate-ID check to each batch schema.

### Operation Results

```ts
export const ToolPortalErrorCodeSchema = z.enum([
  "approval_required",
  "approval_denied",
  "approval_expired",
  "approval_invalid",
  "approval_replayed",
  "capability_denied",
  "configuration_error",
  "execution_failed",
  "invalid_arguments",
  "not_found",
  "transport_failed",
]);

export const ToolPortalErrorSchema = z
  .object({
    code: ToolPortalErrorCodeSchema,
    message: z.string().min(1),
    safeParams: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const ToolPortalTruncationSchema = z
  .object({
    omittedBytes: z.number().int().nonnegative().optional(),
    reason: z.enum(["output_limit", "redaction"]),
    truncated: z.literal(true),
    visibleBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ToolPortalArtifactReferenceSchema = z
  .object({
    artifactId: z.string().min(1),
    kind: z.literal("tool_portal_artifact"),
  })
  .strict();

export const ToolPortalCapabilitySummarySchema = z
  .object({
    description: z.string().optional(),
    name: ToolPortalCapabilityNameSchema,
    namespace: ToolPortalNamespaceSchema,
    requiresApproval: z.boolean(),
  })
  .strict();

export const ToolPortalCapabilityDescriptorSchema = ToolPortalCapabilitySummarySchema.extend({
  inputSchema: ToolPortalJsonSchemaDocumentSchema,
  outputSchema: ToolPortalJsonSchemaDocumentSchema.optional(),
  safeCallingHint: z.string().optional(),
}).strict();

export const ToolPortalListItemResultSchema = z
  .object({
    id: ToolPortalRequestIdSchema,
    namespaces: z.array(ToolPortalNamespaceSchema),
    status: z.literal("ok"),
    tools: z.array(ToolPortalCapabilitySummarySchema),
  })
  .strict()
  .or(
    z.object({
      error: ToolPortalErrorSchema,
      id: ToolPortalRequestIdSchema,
      status: z.literal("error"),
    }).strict(),
  );

export const ToolPortalSearchItemResultSchema = z
  .object({
    id: ToolPortalRequestIdSchema,
    status: z.literal("ok"),
    tools: z.array(
      ToolPortalCapabilitySummarySchema.extend({
        score: z.number().min(0).max(1).optional(),
      }).strict(),
    ),
  })
  .strict()
  .or(
    z.object({
      error: ToolPortalErrorSchema,
      id: ToolPortalRequestIdSchema,
      status: z.literal("error"),
    }).strict(),
  );

export const ToolPortalDescribeItemResultSchema = z
  .object({
    id: ToolPortalRequestIdSchema,
    status: z.literal("ok"),
    tools: z.array(ToolPortalCapabilityDescriptorSchema),
  })
  .strict()
  .or(
    z.object({
      error: ToolPortalErrorSchema,
      id: ToolPortalRequestIdSchema,
      status: z.literal("error"),
    }).strict(),
  );

export const ToolPortalCallItemResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: ToolPortalRequestIdSchema,
    output: JsonValueSchema,
    status: z.literal("ok"),
    truncation: ToolPortalTruncationSchema.optional(),
  }).strict(),
  z.object({
    error: ToolPortalErrorSchema,
    id: ToolPortalRequestIdSchema,
    status: z.literal("error"),
  }).strict(),
]);

export const ToolPortalListResultSchema = z
  .object({ items: z.array(ToolPortalListItemResultSchema), ok: z.boolean() })
  .strict();

export const ToolPortalSearchResultSchema = z
  .object({ items: z.array(ToolPortalSearchItemResultSchema), ok: z.boolean() })
  .strict();

export const ToolPortalDescribeResultSchema = z
  .object({ items: z.array(ToolPortalDescribeItemResultSchema), ok: z.boolean() })
  .strict();

export const ToolPortalCallResultSchema = z
  .object({ items: z.array(ToolPortalCallItemResultSchema), ok: z.boolean() })
  .strict();
```

`ToolPortalJsonSchemaDocumentSchema` is generated with Zod v4
`z.toJSONSchema()` targeting JSON Schema Draft 2020-12. Unrepresentable Zod
schemas must fail generation rather than silently becoming `{}` unless the
individual capability explicitly marks a field as opaque.

Top-level `ok` means every item in the batch has `status: "ok"`. Mixed results
return `ok: false` and preserve each per-item result.

Batch result invariants:

- Every input item produces exactly one result item.
- Result item IDs must exactly match input item IDs.
- Result item order must match input item order.
- Duplicate result IDs are invalid.
- Top-level `ok` must be derived from item statuses with a Zod `superRefine`.

For `ToolPortalTruncationSchema.reason: "output_limit"`, exact
`omittedBytes`/`visibleBytes` may be returned when they do not include redaction
effects. For `reason: "redaction"`, exact secret-derived byte counts must not be
returned; counts are omitted or bucketed by policy outside the public schema.

Describe item semantics are all-or-nothing per item: if any requested
capability in one describe item is absent, hidden, or denied, that item returns a
single error. Successful describe items preserve request capability order.

Error mapping:

| Case | Public error code |
| --- | --- |
| capability absent from the effective scoped catalog | `not_found` |
| capability hidden by profile policy | `not_found` |
| capability unbound in trusted config | `not_found` |
| capability resolves to more than one binding | `configuration_error` |
| visible capability exists but operation is denied by policy | `capability_denied` |
| approval is required before execution | `approval_required` |
| approval is denied by the operator | `approval_denied` |
| approval proof is expired | `approval_expired` |
| approval proof is stale, mismatched, malformed, or absent when required | `approval_invalid` |
| approval proof was already used | `approval_replayed` |
| arguments fail the capability input schema | `invalid_arguments` |
| backend cannot be reached | `transport_failed` |
| backend executes but fails | `execution_failed` |

`safeParams` is allowlist-only. Error messages and safe params must not contain
raw tokens, upstream provider credentials, host secret paths, controller-only
credential profile IDs unless explicitly model-safe, approval tokens, or VM
paths.

Model-visible success payloads must also be normalized. Tool Portal must strip
or redact hidden control fields, transport details, upstream provider
identifiers not intended for the model, host/VM paths, credential profile IDs,
approval material, and execution fingerprints before returning `output`.

List/search/describe outputs are model-visible payloads. Capability descriptions,
safe-calling hints, JSON Schema titles, descriptions, examples, defaults, enum
labels, safe help, and projection metadata must pass the same normalization
boundary before exposure.

## Config Authority

```text
mcp.config.jsonc
  owns: upstream MCP server transports, upstream MCP egress, upstream MCP secret refs

mcp-portal.config.jsonc
  owns: standalone MCP Portal agent/profile policy

tool-portal.config.jsonc
  owns: model-visible portable capability catalog, profile policy,
        approval class, backend references

controller trusted config / registry
  owns: executable templates, credential profiles, VM profiles,
        host action implementations, runner policies, egress defaults,
        output/artifact policies, approval verifier
```

Managed Agent VM deployment config uses a Tool Portal root for managed agents.
The managed field is `zones[].toolPortal`. It points at the authored Tool Portal
config and any managed Tool Portal materialization settings. Generated OpenClaw
plugin materialization uses `runtimePluginConfigs.gondolin.toolPortal`. The
controller materializes the effective Tool Portal config into the managed gateway
state directory under a Tool Portal-owned filename, not the MCP Portal effective
config filename.

`zones[].toolPortal` is the managed OpenClaw Tool Portal root after the hard
cutover. Generated `runtimePluginConfigs["mcp-portal"]` and direct MCP Portal
plugin config remain stale managed OpenClaw paths. They may remain only for
standalone MCP Portal deployments that explicitly choose MCP Portal.

Tool Portal MCP-backed projections are generated from `tool-portal.config.jsonc`
plus MCP provider discovery. They are not a second user-authored policy source.
Every listed MCP-backed Tool Portal capability must be provably allowed by the
derived MCP Portal core policy.

The existing namespace-selector `tool-portal.config.jsonc` shape is a stale
first-slice implementation detail for this contract. The final authored Tool
Portal config is per-capability and catalog-static: every listed capability has
exactly one concrete backend reference.

The authored Tool Portal catalog is keyed by public portable
`{ namespace, name }`. Backend-specific names such as MCP `toolName`,
controller host action IDs, and runner capability IDs live only inside the
backend binding. Tool Portal owns projection from authored Tool Portal config
into neutral backend projection contracts.

## Tool Router Contract

```ts
export const ToolPortalBackendBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mcp"),
    mcpNamespace: z.string().min(1),
    mcpToolName: z.string().min(1),
  }).strict(),
  z.object({
    hostActionId: z.string().min(1),
    kind: z.literal("controller_host_action"),
  }).strict(),
  z.object({
    kind: z.literal("credentialed_runner"),
    runnerCapabilityId: z.string().min(1),
  }).strict(),
]);

export const ToolPortalCapabilityBindingSchema = z
  .object({
    approval: z.enum(["not_required", "required", "conditional"]),
    backend: ToolPortalBackendBindingSchema,
    capability: PortableCapabilityReferenceSchema,
    inputSchema: ToolPortalJsonSchemaDocumentSchema,
    outputPolicyRef: z.string().min(1).optional(),
    policyRevision: z.string().min(1),
  })
  .strict();

export const ToolPortalProfileConfigSchema = z
  .object({
    capabilities: z.record(
      ToolPortalNamespaceSchema,
      z.record(
        ToolPortalCapabilityNameSchema,
        z.object({
          approval: z.enum(["not_required", "required", "conditional"]),
          backend: ToolPortalBackendBindingSchema,
          description: z.string().optional(),
          inputSchema: ToolPortalJsonSchemaDocumentSchema,
          outputPolicyRef: z.string().min(1).optional(),
        }).strict(),
      ),
    ),
  })
  .strict();

export const ToolPortalAgentAssignmentSchema = z
  .object({
    agentId: z.string().min(1),
    profileId: z.string().min(1),
    userId: z.string().min(1).optional(),
  })
  .strict();

export const ToolPortalConfigSchema = z
  .object({
    agents: z.array(ToolPortalAgentAssignmentSchema).default([]),
    profiles: z.record(z.string().min(1), ToolPortalProfileConfigSchema),
    schemaVersion: z.literal(1),
  })
  .strict();
```

Router invariants:

- The scoped catalog is the only source of model-visible capabilities.
- The scoped catalog contains only capabilities with exactly one backend
  binding for the active profile.
- The model submits `{ namespace, name, arguments }`; trusted config selects the
  backend.
- A backend may reject for policy, approval, or execution reasons, but it must
  not change the capability binding selected by the Tool Router.
- MCP-backed calls translate `{ namespace, name }` to MCP
  `{ namespace, toolName }` only inside the MCP backend adapter.
- The Tool Router receives the trusted adapter envelope and public request
  together; it never accepts caller-supplied trusted identity from the public
  request body.

## Backend Contracts

### MCP Backend

The MCP backend composes MCP Portal. It validates Tool Portal request shapes,
consumes a Tool-Portal-created MCP projection, translates portable capability
references to MCP provider references, calls MCP Portal core, and re-validates
the normalized Tool Portal result.

It must not expose `mcp_portal_*` operation names in model-visible Tool Portal
results, prompts, OpenClaw tool registrations, CLI help, HTTP routes, or Tool
Portal MCP tool descriptors.

The MCP-provider backend must not read authored `tool-portal.config.jsonc`.
Tool Portal or config contracts create the neutral MCP projection before the
adapter boundary. MCP Portal core remains responsible for upstream MCP provider
schema validation and provider routing.

The MCP backend adapter receives normalized Tool Portal trusted provenance from
`ToolPortalAdapterEnvelopeSchema`. It must not hard-code OpenClaw provenance or
otherwise collapse CLI, HTTP, SDK, Tool Portal MCP server, and OpenClaw calls
into one source. If MCP Portal core needs a different internal scope vocabulary,
the adapter performs that translation at the MCP backend seam.

Approval-required MCP-backed capabilities are approved and replay-checked by
Tool Portal before MCP backend dispatch. The MCP backend receives an already
authorized backend dispatch envelope. Managed Tool Portal mode must not delegate
approval verification to MCP Portal HMAC tokens, `portalApprovalToken`, or
`mcp_portal_call` hook gating.

### Controller Host Action Backend

Controller host actions are narrow controller-owned operations such as
controller-side git actions. They are not arbitrary host command execution and
must not reuse `/zones/:zoneId/execute-command`.

The first controller host action family is Git-only: push branch, refresh
default/current branch, and zone-git status/push operations built from existing
controller Git primitives. Adding another host action family requires an explicit
new typed action contract. A controller host action never accepts arbitrary shell
text, executable paths, argv, cwd, env, or filesystem paths from the model.

```ts
export const ToolPortalTrustedScopeSchema = z
  .object({
    agentId: z.string().min(1),
    profileId: z.string().min(1),
    userId: z.string().min(1).optional(),
  })
  .strict();

export const ToolPortalDispatchIntentSchema = z
  .object({
    auditCorrelationId: z.string().min(1),
    canonicalArguments: JsonObjectSchema,
    capability: PortableCapabilityReferenceSchema,
    trustedScope: ToolPortalTrustedScopeSchema,
  })
  .strict();

export const ControllerHostActionRequestSchema = z
  .object({
    adapter: ToolPortalAdapterEnvelopeSchema,
    approval: ControllerApprovalProofReferenceSchema.optional(),
    dispatch: ToolPortalDispatchIntentSchema,
    hostActionId: z.string().min(1),
  })
  .strict();

export const ControllerExecutionChannelSchema = z
  .object({
    omittedBytes: z.number().int().nonnegative().optional(),
    redactionApplied: z.boolean(),
    truncated: z.boolean(),
    visibleText: z.string(),
  })
  .strict();

export const ControllerExecutionArtifactSummarySchema = z
  .object({
    artifact: ToolPortalArtifactReferenceSchema,
    contentType: z.string().min(1).optional(),
    omittedFromModel: z.boolean(),
  })
  .strict();

export const ControllerExecutionSuccessSchema = z
  .object({
    artifacts: z.array(ControllerExecutionArtifactSummarySchema).default([]),
    exitCode: z.number().int().optional(),
    output: JsonValueSchema,
    status: z.literal("ok"),
    stderr: ControllerExecutionChannelSchema.optional(),
    stdout: ControllerExecutionChannelSchema.optional(),
    truncation: ToolPortalTruncationSchema.optional(),
  })
  .strict();

export const ControllerExecutionFailureSchema = z
  .object({
    error: ToolPortalErrorSchema,
    status: z.literal("error"),
  })
  .strict();

export const ControllerExecutionResultSchema = z.discriminatedUnion("status", [
  ControllerExecutionSuccessSchema,
  ControllerExecutionFailureSchema,
]);

export const ControllerHostActionResultSchema = ControllerExecutionResultSchema;
```

For user-scoped credentials, `userId` is required. A profile-scoped capability
may omit `userId` only when the trusted credential profile is explicitly
profile-owned.

The controller must reject mismatches between `adapter.trustedCaller` and
`dispatch.trustedScope`. It must also reject a `hostActionId` that does not match
the Tool Router binding for `dispatch.capability`.

Controller host action results must be parsed with
`ControllerHostActionResultSchema` before conversion to public
`ToolPortalCallItemResultSchema`. The result schema is backend-native but
already redacted and path-free; public normalization still runs after it.

### Credentialed Runner Backend

Credentialed runners use controller-owned ephemeral runner VMs.

```text
agent request
  -> Tool Portal call surface
  -> Tool Router
  -> controller dispatch intent
  -> controller re-authorizes from trusted config
  -> controller creates ephemeral runner VM
  -> ManagedVm.exec with array argv, pty:false, shellMode:none
  -> streamed stdout/stderr/artifacts through controller caps
  -> Tool Portal result
```

The runner VM is never agent-controlled. It has no SSH access path for the
agent, no shell command string, no in-VM HTTP listener, no custom guest RPC
server, and no persistent lease reused by the agent.

```ts
export const ToolPortalExecutionFingerprintSchema = z
  .object({
    agentId: z.string().min(1),
    artifactIntentHash: z.string().min(1),
    backendBindingRevision: z.string().min(1),
    canonicalArgumentHash: z.string().min(1),
    capability: PortableCapabilityReferenceSchema,
    catalogRevision: z.string().min(1),
    credentialProfileIdHash: z.string().min(1),
    custodyMode: z.enum([
      "controller_durable_state",
      "ephemeral_material",
      "host_brokered",
      "host_mediated",
      "profile_scoped_stateless",
    ]),
    egressPolicyHash: z.string().min(1),
    executableTemplateRevision: z.string().min(1),
    outputPolicyHash: z.string().min(1),
    policyRevision: z.string().min(1),
    resolvedCwdHash: z.string().min(1),
    resolvedEnvHash: z.string().min(1),
    timeoutPolicyHash: z.string().min(1),
    userId: z.string().min(1).optional(),
  })
  .strict();
```

For user-scoped custody modes, `userId` is required. The approval verifier must
reject fingerprints missing required user identity.

```ts
export const CredentialedRunnerDispatchRequestSchema = z
  .object({
    adapter: ToolPortalAdapterEnvelopeSchema,
    approval: ControllerApprovalProofReferenceSchema.optional(),
    dispatch: ToolPortalDispatchIntentSchema,
    runnerCapabilityId: z.string().min(1),
  })
  .strict();

export const CredentialedRunnerDispatchResultSchema = ControllerExecutionResultSchema;
```

Approval proof is never part of the public Tool Portal request and never part of
the control-field-free dispatch intent. It is a trusted runtime/controller
reference to a controller-side approval record.

The controller must reject a `runnerCapabilityId` that does not match the Tool
Router binding for `dispatch.capability`, and must apply the same
`adapter.trustedCaller` versus `dispatch.trustedScope` consistency rule as host
actions.

Credentialed runner results must be parsed with
`CredentialedRunnerDispatchResultSchema` before conversion to public
`ToolPortalCallItemResultSchema`. Raw ManagedVm stdout, stderr, filesystem paths,
exit metadata, and artifact locations are never returned directly.

## Controller Re-Authorization

Controller-owned backends must enforce this sequence:

```text
parse Tool Portal request with Zod
  -> locate capability binding from trusted catalog
  -> canonicalize arguments with capability input schema
  -> build control-field-free dispatch intent
  -> controller parses dispatch intent with Zod
  -> controller recomputes execution plan from trusted config
  -> controller verifies approval/fingerprint freshness if required
  -> controller executes exact trusted plan
  -> controller parses result with Zod before returning
```

The controller dispatch boundary is a dedicated Tool Portal dispatch interface.
It may be implemented as an internal service, controller route, or injected
client, but it must parse the controller-owned request schemas above and must
authenticate the trusted caller before re-authorization. `@agent-vm/tool-portal`
must not import `@agent-vm/agent-vm` controller runtime internals directly.

The dispatch intent must not contain:

```text
argv
cwd
env
executablePath
credentialProfileId
credential material
VM profile
egress hosts
artifact paths
approval token
shell string
```

## CLI Allowance Contract

Generic CLI access is allowed only as a controller-owned capability envelope.
It is not a model-owned shell.

```ts
export const CliArgvTokenSchema = z.string().min(1);

export const CliDeniedArgvTokenSchema = z.enum([
  ";",
  "&&",
  "||",
  "|",
  ">",
  ">>",
  "<",
  "$(",
  "`",
  "\\n",
]);

export const CliDeniedLauncherSchema = z.enum([
  "bash",
  "dash",
  "env",
  "fish",
  "node",
  "perl",
  "python",
  "python3",
  "ruby",
  "sh",
  "sudo",
  "zsh",
]);

export const CliPatternRuleSchema = z
  .object({
    kind: z.enum(["literal", "regex"]),
    value: z.string().min(1),
  })
  .strict();

export const CliFlagRuleSchema = z
  .object({
    allowedValues: z.array(z.string()).optional(),
    flag: CliArgvTokenSchema,
    value: z.enum(["none", "string", "number", "enum", "path", "host"]),
  })
  .strict();

export const CliStdinPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("bounded_text"),
    maxBytes: z.number().int().positive().max(1024 * 1024),
    deniedPatterns: z.array(CliPatternRuleSchema).default([]),
  }).strict(),
  z.object({
    kind: z.literal("json"),
    maxBytes: z.number().int().positive().max(1024 * 1024),
    schema: ToolPortalJsonSchemaDocumentSchema,
  }).strict(),
]);

export const CwdPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), path: z.string().startsWith("/") }).strict(),
  z.object({ kind: z.literal("workspace_root") }).strict(),
  z.object({ kind: z.literal("runner_scratch") }).strict(),
]);

export const EnvironmentPolicySchema = z
  .object({
    allowedVariables: z.array(z.string().min(1)).default([]),
    deniedPatterns: z.array(z.string()).default([]),
    mode: z.enum(["empty", "allowlist", "controller_materialized"]),
  })
  .strict();

export const EgressPolicySchema = z
  .object({
    allowedHosts: z.array(z.string().min(1)),
    allowedPorts: z.array(z.number().int().positive().max(65535)).optional(),
    denyEndpointOverrides: z.boolean().default(true),
  })
  .strict();

export const OutputPolicySchema = z
  .object({
    modelVisibleStderr: z.enum(["none", "safe_summary"]).default("safe_summary"),
    redactionProfile: z.string().min(1),
    stderrMaxBytes: z.number().int().positive().max(16 * 1024 * 1024),
    stdoutMaxBytes: z.number().int().positive().max(16 * 1024 * 1024),
    truncationMode: z.enum(["fail", "truncate"]).default("truncate"),
  })
  .strict();

export const ArtifactPolicySchema = z
  .object({
    maxArtifacts: z.number().int().nonnegative().max(20).default(0),
    maxBytesPerArtifact: z.number().int().positive().max(16 * 1024 * 1024).optional(),
    mode: z.enum(["none", "controller_written", "bounded_stream", "vm_file_read"]),
    noFollowRequired: z.boolean().default(true),
  })
  .strict();

export const CancellationPolicySchema = z
  .object({
    onCancel: z.enum(["abort_process", "close_vm"]),
    timeoutMs: z.number().int().positive().max(8 * 60 * 60 * 1000),
  })
  .strict();

export const CliExecutionPolicySchema = z
  .object({
    artifacts: ArtifactPolicySchema,
    cancellation: CancellationPolicySchema,
    custodyMode: z.enum([
      "controller_durable_state",
      "ephemeral_material",
      "host_brokered",
      "host_mediated",
      "profile_scoped_stateless",
    ]),
    cwd: CwdPolicySchema,
    egress: EgressPolicySchema,
    environment: EnvironmentPolicySchema,
    output: OutputPolicySchema,
  })
  .strict();

export const CliAllowanceSchema = z
  .object({
    allowedFlags: z.array(CliFlagRuleSchema).default([]),
    allowedSubcommands: z.array(z.array(CliArgvTokenSchema).min(1)).min(1),
    approval: z.enum(["required", "conditional"]),
    capability: PortableCapabilityReferenceSchema,
    credentialProfileId: z.string().min(1),
    deniedFlags: z.array(CliArgvTokenSchema),
    deniedPatterns: z.array(CliPatternRuleSchema),
    execution: CliExecutionPolicySchema,
    executablePath: z.string().startsWith("/"),
    inputSchema: ToolPortalJsonSchemaDocumentSchema,
    safeHelp: z.string().max(4000),
    stdin: CliStdinPolicySchema.default({ kind: "none" }),
  })
  .strict();

export const CliAllowanceInputSchema = z
  .object({
    argv: z.array(CliArgvTokenSchema).max(100),
    reason: z.string().min(1),
    stdin: z.string().optional(),
  })
  .strict();
```

Generic CLI allowances must carry the full controller-execution policy bundle:
cwd, environment, egress, output, artifacts, cancellation, custody mode,
executable path, and credential profile. The agent supplies only argv-like
intent, reason text, and optional stdin subject to `CliStdinPolicySchema`.
Missing execution-control fields are configuration errors, not runtime defaults.

CLI validation semantics:

- `CliArgvTokenSchema` is already-tokenized argv. The model never supplies a
  shell command string.
- Any argv token containing shell separators, redirection, command substitution,
  backticks, newlines, NUL bytes, or unescaped control characters is rejected.
- The first argv token after the trusted executable must not be a denied
  launcher unless the allowance explicitly names that launcher as the executable
  and all downstream arguments are controlled by typed templates.
- `CliPatternRuleSchema.kind: "literal"` uses byte-for-byte substring matching.
  `kind: "regex"` uses the host JavaScript regular-expression engine after the
  pattern itself has parsed from config; invalid regex config fails config
  validation.
- `CliFlagRuleSchema.value: "none"` forbids a following value and `--flag=value`.
  `"string"` requires a non-empty string value. `"number"` requires canonical
  decimal text that parses to a finite number without trailing characters.
  `"enum"` requires `allowedValues` and rejects values outside that set.
- `value: "path"` requires canonicalization against controller-approved roots,
  rejects traversal, rejects disallowed absolute paths, and rejects symlink
  escapes where the policy requires no-follow behavior.
- `value: "host"` requires canonical host parsing and must match
  `EgressPolicySchema.allowedHosts`; endpoint override aliases and IP literal
  bypasses are rejected unless explicitly allowed by egress policy.
- If `stdin.kind` is `"none"`, provided stdin is invalid. For bounded text,
  `deniedPatterns` apply to stdin content before execution. For JSON stdin, the
  parsed JSON value must match `stdin.schema`.

Validation order:

```text
parse input with Zod
  -> normalize argv
  -> reject shell metacharacters, launchers, pipes, redirects, substitution
  -> reject denied flags and denied patterns
  -> require allowed command family
  -> validate allowed flags and flag values
  -> validate stdin policy
  -> controller recomputes final invocation
  -> controller executes with strict ManagedVm exec
```

CLI promotion ladder:

```text
generic credentialed CLI capability
  -> approved exploratory use
  -> repeated safe pattern
  -> promoted typed capability with trusted argv template
```

## Approval Hook

Model-visible approval result:

```ts
export const ToolPortalApprovalRequiredSchema = z
  .object({
    error: z.object({
      code: z.literal("approval_required"),
      message: z.string().min(1),
    }).strict(),
    id: ToolPortalRequestIdSchema,
    status: z.literal("error"),
  })
  .strict();
```

Runtime/controller approval binding must include:

- agent identity
- user identity when user-scoped
- profile ID
- capability reference
- canonical argument hash
- catalog revision
- policy revision
- backend binding revision
- execution fingerprint for controller-owned actions
- artifact intent hash
- expiry
- single-use replay protection

Agents do not receive approval tokens. The runtime may attach a one-use
approval proof after the operator approves.

```ts
export const ToolPortalApprovalDecisionSchema = z.enum([
  "approved",
  "denied",
  "expired",
  "revoked",
]);

export const ToolPortalApprovalBindingSchema = z
  .object({
    agentId: z.string().min(1),
    approvalRecordId: z.string().min(1),
    artifactIntentHash: z.string().min(1),
    backendApprovalFingerprintHash: z.string().min(1),
    backendBindingRevision: z.string().min(1),
    backendKind: z.enum(["mcp", "controller_host_action", "credentialed_runner"]),
    canonicalArgumentHash: z.string().min(1),
    capability: PortableCapabilityReferenceSchema,
    catalogRevision: z.string().min(1),
    createdAtIso: z.string().datetime({ offset: true }),
    decision: ToolPortalApprovalDecisionSchema,
    expiresAtIso: z.string().datetime({ offset: true }),
    policyRevision: z.string().min(1),
    profileId: z.string().min(1),
    singleUseNonceHash: z.string().min(1),
    userId: z.string().min(1).optional(),
    usedAtIso: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ControllerApprovalBindingSchema = z
  .object({
    agentId: z.string().min(1),
    approvalRecordId: z.string().min(1),
    artifactIntentHash: z.string().min(1),
    backendBindingRevision: z.string().min(1),
    canonicalArgumentHash: z.string().min(1),
    capability: PortableCapabilityReferenceSchema,
    catalogRevision: z.string().min(1),
    createdAtIso: z.string().datetime({ offset: true }),
    decision: ToolPortalApprovalDecisionSchema,
    expiresAtIso: z.string().datetime({ offset: true }),
    executionFingerprint: ToolPortalExecutionFingerprintSchema,
    policyRevision: z.string().min(1),
    profileId: z.string().min(1),
    singleUseNonceHash: z.string().min(1),
    userId: z.string().min(1).optional(),
    usedAtIso: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
```

The controller computes whether approval is required from trusted controller
policy for the bound host action or runner capability. Optional `approval`
references mean only that some trusted policies do not require approval for a
specific capability; they do not let Tool Portal or the adapter skip controller
approval verification. When approval is required, the controller rejects absent,
denied, expired, stale, mismatched, malformed, or already-used approval proof
before execution.

Tool Portal computes whether approval is required for every backend kind from
trusted Tool Portal/controller policy. Non-controller backends such as MCP use
`ToolPortalApprovalBindingSchema` and `ToolPortalApprovalProofReferenceSchema`.
Controller-owned backends use `ControllerApprovalBindingSchema` and
`ControllerApprovalProofReferenceSchema`. All approval bindings share identity,
capability, canonical argument, catalog, policy, backend binding, artifact
intent, expiry, decision, and single-use replay fields.

Every controller-owned backend, including Git host actions, binds approval
freshness to `ToolPortalExecutionFingerprintSchema`. If a host action needs a
host-action-specific execution fingerprint, that schema must be a Zod-derived
variant that preserves the same identity, revision, argument, credential,
output, artifact, egress, cwd/env, and timeout freshness fields.

## Artifacts, Streaming, And Events

Version 1 Tool Portal results are bounded JSON/text responses. Event and
artifact contracts may exist as hooks, but a surface must not advertise
streaming, cancellation, or artifact readback until that surface has a real
implementation and proof.

Version 1 public Tool Portal call surfaces expose only request/response
operations. Dormant internal schemas are allowed so controller-owned execution
can be shaped correctly, but they must not appear in OpenClaw tool descriptors,
Tool Portal MCP tool descriptors, CLI help, HTTP documentation, or SDK public API
until implemented.

```ts
export const ToolPortalArtifactReadRequestSchema = z
  .object({
    adapter: ToolPortalAdapterEnvelopeSchema,
    artifact: ToolPortalArtifactReferenceSchema,
    capability: PortableCapabilityReferenceSchema,
    executionFingerprint: ToolPortalExecutionFingerprintSchema,
    maxBytes: z.number().int().positive().max(16 * 1024 * 1024),
    requestId: ToolPortalRequestIdSchema.optional(),
  })
  .strict();

export const ToolPortalArtifactReadResultSchema = z.discriminatedUnion("status", [
  z.object({
    bytesBase64: z.string().min(1),
    contentType: z.string().min(1).optional(),
    status: z.literal("ok"),
    truncation: ToolPortalTruncationSchema.optional(),
  }).strict(),
  z.object({
    error: ToolPortalErrorSchema,
    status: z.literal("error"),
  }).strict(),
]);

export const ToolPortalProgressEventSchema = z
  .object({
    auditCorrelationId: z.string().min(1),
    capability: PortableCapabilityReferenceSchema,
    eventId: z.string().min(1),
    kind: z.literal("tool_portal_progress"),
    message: z.string().min(1),
  })
  .strict();

export const ToolPortalPartialOutputEventSchema = z
  .object({
    auditCorrelationId: z.string().min(1),
    capability: PortableCapabilityReferenceSchema,
    eventId: z.string().min(1),
    kind: z.literal("tool_portal_partial_output"),
    visibleText: z.string(),
  })
  .strict();

export const ToolPortalCancellationRequestSchema = z
  .object({
    auditCorrelationId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
```

Artifact references are opaque IDs. They must not expose host paths, VM paths,
credential profile IDs, or storage implementation details.

Artifact readback is controller-authorized against trusted caller, session or
lease when present, capability, artifact ownership, and execution fingerprint.
Opaque artifact IDs are not bearer credentials. Cross-agent, cross-profile,
cross-user, cross-session, and stale-fingerprint reads must fail.

Credentialed runner stdout/stderr must be drained as streams and capped by
controller policy. Buffering the entire process output before applying caps is
not allowed.

OpenClaw v1 must not emit public Tool Portal streaming/update events unless the
OpenClaw adapter, Tool Portal service, and backend involved all parse and emit
the schemas above at real runtime boundaries.

Internal controller progress/output events may carry richer execution metadata,
but model-visible events must use sanitized Tool Portal event schemas and pass
the same redaction, output-cap, descriptor-residue, and credential/path
normalization boundary as final results.

## OpenClaw Cutover Contract

Final managed OpenClaw shape:

```text
@agent-vm/openclaw-tool-portal-plugin
  registers: tool_portal_list/search/describe/call
  calls: @agent-vm/tool-portal in-process entrypoint
  receives: trusted OpenClaw agent/session context
  emits: Tool Portal result/event vocabulary

@agent-vm/openclaw-mcp-portal-plugin
  final managed role: none
```

The existing MCP Portal plugin may be renamed and retrofitted instead of
rewritten. The hard-cutover rule still applies: final managed OpenClaw builds,
generated manuals, docs, deployment doctor, e2e tests, plugin manifests, package
exports, image overlays, and prompts must not teach or register MCP Portal as
the managed OpenClaw facade.

OpenClaw approval UI may remain an adapter concern, but managed Tool Portal mode
must not keep MCP Portal HMAC approval tokens, `portalApprovalToken`, or
`mcp_portal_call` hook gating. Any approved OpenClaw action attaches a
`ControllerApprovalProofReferenceSchema` or equivalent Tool Portal/controller
approval proof reference before controller dispatch.

Residue audit must fail managed Tool Portal mode when these appear in
model-facing or managed OpenClaw installation paths:

- `mcp_portal_list`
- `mcp_portal_search`
- `mcp_portal_describe`
- `mcp_portal_call`
- `@agent-vm/openclaw-mcp-portal-plugin`
- OpenClaw plugin id `mcp-portal`
- direct OpenClaw plugin import from `@agent-vm/mcp-portal/core`
- `mcp_portal_progress`
- `mcp_portal_partial_content`
- `mcp_portal_upstream_notification`
- `portalApprovalToken`
- `runtimePluginConfigs["mcp-portal"]`
- a top-level `tool-portal` entry in `runtimePluginConfigs` as the managed Tool
  Portal trigger

Standalone MCP Portal docs and tests may still contain `mcp_portal_*` when they
are clearly outside managed Tool Portal mode.

Managed OpenClaw residue audit scope includes:

- OpenClaw Tool Portal plugin package, manifest, source, and tests.
- Agent VM generated OpenClaw config and image overlay package installation.
- Deployment doctor and deployment requirements checks.
- Generated manual templates and manual-template tests.
- Managed OpenClaw architecture/docs and getting-started guidance.
- OpenClaw e2e harnesses and managed gateway proof lanes.
- Package exports, package references, TypeScript project references, and
  workspace dependency lists.
- Runtime prompt/context builders that mention available tools or events.
- System config schema, gateway zone orchestration, effective config
  materialization, init scaffolds, and generated plugin config names.

## Package Boundaries

```text
agent-portal-sdk
  owns: portable request/result/event schemas and generated JSON Schema helpers
  may import: zod
  must not import: mcp-portal, tool-portal, controller runtime, OpenClaw

mcp-portal
  owns: MCP Portal core, standalone MCP surfaces, MCP provider backend adapter
  may import: agent-portal-sdk for shared result vocabulary
  must not import: tool-portal or controller execution runtime

tool-portal
  owns: Tool Portal in-process service, Tool Router, policy projection,
        CLI allowance validation, backend adapters
  may import: agent-portal-sdk, config-contracts,
              @agent-vm/mcp-portal/mcp-provider-backend,
              controller-execution-contracts
  must not import: @agent-vm/mcp-portal/core

controller-execution-contracts
  owns: Zod schemas for controller-owned action boundaries
  must not import: runtime portal packages

openclaw-tool-portal-plugin
  owns: OpenClaw call surface for Tool Portal
  may import: tool-portal, config-contracts
  must not import: @agent-vm/mcp-portal/core

agent-vm controller
  owns: Tool Portal controller dispatch route, re-authorization executor,
        host action registry, runner VM lifecycle
```

Folder and file naming rules:

- Feature slices own local `models/` folders where useful.
- Do not use package-wide `src/models`.
- Do not use bucket folders named `schemas`, `validation`, `mapping`, or
  `test-support`.
- New source files must use descriptive multi-word names except `index.ts`.
- Test harnesses belong under `tests/harness/<domain>/` or package-local
  testing slices with descriptive names.

## Current-State Evidence

Direct observations from this worktree:

- `packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.ts`
  parses Tool Portal requests but only constructs an MCP backend.
- `packages/config-contracts/src/tool-portal-config.ts` already names `mcp`,
  `controller_host_action`, and `credentialed_runner` backend kinds, but its
  current namespace-selector shape is stale for this final per-capability binding
  contract.
- Current shared SDK/controller schemas still expose `toolName` in places that
  are stale for Tool Portal public contracts; final Tool Portal public contracts
  use `{ namespace, name }`.
- `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts`
  composes MCP Portal core through internal `mcp_portal_*` calls.
- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts` imports
  `@agent-vm/mcp-portal/core`, registers MCP Portal native tools, and uses
  `mcp_portal_*` event names.
- `packages/openclaw-mcp-portal-plugin/openclaw.plugin.json` exposes
  `mcp_portal_*` tools.
- `packages/controller-execution-contracts/src/**` contains strict Zod
  contracts for dispatch and ManagedVm exec, but some current request shapes
  carry stale fields such as action names, credential profile IDs, or resolved
  invocations that must become controller-recomputed internals for this
  contract. `ValidatedCliInvocationSchema` remains internal-only.
- `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts`
  currently hard-codes OpenClaw-style provenance; final Tool Portal MCP backend
  consumes normalized trusted provenance from the Tool Portal adapter envelope.
- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
  exposes `/zones/:zoneId/execute-command`; this route is an admin/gateway
  operation and is not the Tool Portal controller-owned action path.
- Managed OpenClaw config currently uses `zones[].toolPortal` and generated
  `runtimePluginConfigs.gondolin.toolPortal`; generated
  `runtimePluginConfigs["mcp-portal"]` remains a stale managed path after the
  Tool Portal hard cutover.

## Requirement-To-Proof Matrix

The implementation plan must map each row to concrete files, tests, and commands.
This table is not an implementation sequence.

| Requirement | Proof expectation |
| --- | --- |
| R1 Tool Portal managed facade | Managed OpenClaw runtime proof exposes only `tool_portal_*` model-facing operations and calls the Tool Portal entrypoint. |
| R2 MCP Portal standalone continuity | Standalone MCP Portal proof still exposes and exercises `mcp_portal_list/search/describe/call` for consumers that explicitly choose MCP Portal. |
| R3 Call surfaces | Contract-equivalence proof for in-process TypeScript, OpenClaw plugin, CLI, HTTP API, TS SDK, and Tool Portal MCP server. Each surface must compile to the same adapter envelope and public Zod request/result schemas. |
| R4 Router separation | Unit/integration proof distinguishes Tool Router capability binding from MCP Portal provider routing. |
| R5 MCP composition seam | MCP-backed Tool Portal integration proof calls MCP Portal through the MCP backend adapter, consumes trusted caller provenance from the adapter envelope, and does not import MCP Portal core from Tool Portal or OpenClaw Tool Portal plugin code. |
| R6 Catalog-static dispatch | Config/router proof parses authored `tool-portal.config.jsonc`, derives the effective scoped catalog, and covers total binding, ambiguity rejection, unbound rejection, hidden capability `not_found`, and no default-to-MCP behavior. |
| R7 Zod v4 contracts | Unit proof covers every public request/result/config/backend/controller result/controller request/approval/artifact/CLI schema, including strict unknown-field rejection, batch `ok` refinements, and generated JSON Schema snapshots where advertised. |
| R8 Public `{ namespace, name }` identity | Contract proof verifies public schemas, descriptors, list/search/describe/call results, and OpenClaw/CLI/HTTP/MCP/SDK surfaces use `name`, with MCP `toolName` confined to the MCP backend adapter. |
| R9 Controller re-authorization | Controller-boundary proof shows Tool Portal sends only dispatch intent plus trusted adapter envelope, and the controller recomputes execution plan from trusted config before execution. |
| R10 Credentialed runner strict RPC | Runner proof covers ephemeral VM lifecycle, no SSH, no PTY, no shell strings, array argv, strict ManagedVm `exec`/`fs`, streamed output caps, stdin policy, and approval/fingerprint freshness. |
| R11 CLI promotion | CLI allowance proof covers argv normalization before validation, denied shell tokens/launchers, denied flags/patterns, exact flag value kinds, path/host canonicalization, stdin policy, and promoted typed capability templates. |
| R12 Approval hook | Approval proof covers model-visible approval errors, hidden proof references, Tool Portal approval binding for MCP-backed capabilities, controller approval binding for controller-owned capabilities, denial, expiry, stale/mismatched proof, and single-use replay rejection. |
| R13 OpenClaw hard cutover | Residue audit proof fails managed OpenClaw paths containing banned MCP Portal tool/event/plugin/config/approval names, verifies `zones[].toolPortal` and `runtimePluginConfigs.gondolin.toolPortal`, and confirms standalone MCP Portal paths remain allowed. |
| Package boundaries | Architecture gate proves dependency direction, package exports, descriptive multi-word filenames, no banned bucket folders, and no controller runtime imports from Tool Portal packages. |
| Caller credential custody | Surface proof attempts forged public trusted identity and model-visible caller credential exfil/replay for CLI, HTTP, Tool Portal MCP server, TS SDK embedding, and OpenClaw plugin paths. |
| Descriptor normalization | MCP-backed descriptor proof injects hostile provider schema metadata and verifies managed Tool Portal list/search/describe outputs do not leak backend/package/credential/path identity. |

## Decisions Still Open For Planning

These are not allowed to silently drift into implementation.

Plan-owned implementation choices:

- Exact call-surface packaging: whether CLI, HTTP API, Tool Portal MCP server,
  and TS SDK live in `@agent-vm/tool-portal` entrypoints or split subpackages.
  The contract requires all first-version surfaces; the plan chooses package
  layout and proof mapping.
- Exact controller dispatch interface shape: internal injected client,
  controller HTTP route, or both. The contract requires dedicated Tool Portal
  dispatch semantics and forbids reuse of `/zones/:zoneId/execute-command`.

Non-blocking defaults already pinned by this spec:

- First narrow controller host action family is Git-only.
- First-version Tool Portal MCP server exposes only the four universal
  `tool_portal_*` operations. Generated per-capability MCP tools are future
  sugar.
- Approval UI is not specified. The approval hook and controller proof contract
  are specified.
- Artifact readback is not public v1 surface. Bounded JSON/text results are the
  v1 public result contract.
- Python SDK remains deferred for Hermes.
