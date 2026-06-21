# Portable Agent Capability Interface Design Spec

Status: draft design spec.

This document defines the target architecture and naming model for portable
agent-facing capabilities in agent-vm. It captures concepts, contracts,
ownership boundaries, security invariants, and validation obligations. It does
not define work order.

This spec is a design artifact for the current branch. After implementation, the
settled terminology and behavior should be promoted into the long-lived
architecture docs.

## Design Goal And Non-Goals

The goal is to define the stable contracts and ownership boundaries for portable
agent capability access. A plan can stage implementation, but it must not change
these contracts silently.

Normative outcomes:

- agents get one capability vocabulary: list, search, describe, and call;
- every public input/output and every RPC boundary is represented as a Zod v4
  schema before values cross the boundary;
- MCP Portal remains the MCP provider portal;
- Tool Portal composes MCP Portal and controller-owned backends without making
  MCP Portal own VMs, host actions, or credentialed runners;
- controller-owned execution is re-authorized by the controller from
  controller-owned contracts;
- tests follow a performant TDD pyramid instead of proving contract decisions
  only through slow e2e paths.

Non-goals:

- no implementation work order is defined here;
- no reusable high-trust credentialed runner is defined here;
- no generic host command runner is introduced;
- no arbitrary credentialed shell is exposed to an agent;
- no second policy authority may be active for the same model-visible
  capability;
- no broad VM filesystem artifact publication is included until the artifact
  contract and no-follow path proof are implemented.

## Problem Statement

Agents need one simple way to discover, describe, and call external
capabilities. They should not need to know OpenClaw internals, upstream MCP
provider credentials, VM leases, SSH endpoints, runner process handles,
controller operations, or credential materialization rules.

The architecture has one model-visible interface and multiple private backends:

```text
model-visible capability call
  -> runtime adapter
  -> in-process core entrypoint
  -> catalog-static dispatch intent
  -> private backend
  -> structured result
```

The main separation is:

```text
call surface  != adapter
adapter                  != in-process core entrypoint
in-process entrypoint    != backend
backend                  != transport
transport                != credential custody
dispatch intent          != controller authorization
```

OpenClaw, MCP clients, CLI clients, SDK clients, and API clients may all expose
the same capability method. Trusted config and server-side identity decide where
the work runs.

## Current-State Anchors

This design is constrained by these current facts:

- Managed OpenClaw MCP Portal calls `@agent-vm/mcp-portal/core` in-process from
  the gateway VM. It does not start the external MCP Portal HTTP proxy in managed
  OpenClaw mode.
- MCP Portal currently exposes four model-facing tools:
  `mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`, and
  `mcp_portal_call`.
- MCP Portal core accepts a trusted agent scope. The adapter authenticates or
  derives identity before calling core.
- Current OpenClaw Tool VM execution uses a controller-created SSH lease. The
  controller owns VM lifecycle and active-use tracking. The OpenClaw gateway
  plugin owns command and filesystem bridge I/O over SSH.
- The controller is not a generic stdout/stderr or filesystem proxy for current
  OpenClaw Tool VMs.
- `ssh-sandbox` is the only implemented VM capability transport today.
- The docs reserve a future controller-owned `gondolin-rpc` shape for
  `ManagedVm.exec()` and `ManagedVm.fs`.
- Current MCP provider config owns upstream MCP transport, egress, and provider
  secrets. MCP Portal config owns agents, profiles, policy, approval, and
  external proxy auth material.

## Design Vocabulary

Use these names in this design:

```text
agent-visible facade
  The stable Zod-backed list/search/describe/call capability contract exposed
  to the agent.

runtime adapter
  A runtime-specific bridge that turns trusted runtime context into a trusted
  portal call. Examples: OpenClaw native tools, MCP proxy server, CLI wrapper,
  SDK wrapper, HTTP API wrapper.

in-process core entrypoint
  The process-local function/API that owns identity scope, catalog, Zod schema,
  approval, dispatch-intent construction, result normalization, and event
  normalization. Existing MCP Portal core is the current concrete example.
  For controller-owned backends, this entrypoint does not become execution
  authority; it sends a dispatch intent that the controller re-authorizes.

catalog-static dispatch intent
  Backend selection intent from trusted config and scoped catalog metadata. The
  model never chooses the backend at call time. Controller-owned backends still
  recompute and verify final execution authority in the controller.

backend adapter
  The private executor selected by trusted config. Backend adapters include MCP
  provider runtime, OpenClaw Sandbox SSH lease, ephemeral credentialed runner,
  and narrow controller host actions.
```

Avoid using `portal core` as the architectural term in new docs unless referring
to the existing MCP Portal TypeScript type. Use `in-process core entrypoint` for
the portable concept.

## System Map

```text
agent / model
  │
  │ list / search / describe / call
  ▼
agent-visible facade
  │
  │ runtime context, not model-supplied identity
  ▼
runtime adapter
  │
  │ trusted scope + validated request
  ▼
in-process core entrypoint
  │
  │ identity + catalog + Zod schema + approval + audit
  ▼
catalog-static dispatch intent
  │
  ├─ MCP provider backend
  │    provider runtime, no execution VM lease
  │
  ├─ OpenClaw Sandbox SSH lease backend
  │    named Tool VM lease, SSH transport, agent/runtime execution owner
  │
  ├─ ephemeral credentialed runner backend
  │    one-shot execution VM lifecycle, strict ManagedVm exec/fs,
  │    controller execution owner
  │
  └─ narrow host action backend
       typed controller-owned host operation, no generic host shell
```

## Owner And User Matrix

`user` means the principal the capability is for. `owner` means the component
allowed to control the execution substrate.

```text
Combination                    User       Execution owner       Lifetime
-----------------------------  ---------  --------------------  ----------------
agent-visible facade           agent      in-process entrypoint request/session
runtime adapter                agent      runtime adapter       runtime/session
MCP provider backend           agent      MCP Portal runtime    MCP session
OpenClaw Sandbox SSH lease     agent      OpenClaw plugin       named VM lease
ephemeral credentialed runner  agent      controller           one-shot run
narrow host action             agent      controller           operation scoped
```

```text
Combination                    Transport          Agent control
-----------------------------  -----------------  -----------------------------
agent-visible facade           core/SDK/CLI/API   can request capability
runtime adapter                in-process/API     cannot forge trusted identity
MCP provider backend           MCP/RPC            cannot see provider creds
OpenClaw Sandbox SSH lease     SSH over tcpHosts  can control sandbox execution
ephemeral credentialed runner  ManagedVm exec/fs  can request; never controls VM
narrow host action             host function      can request; never controls host
```

The critical invariant is:

```text
OpenClaw Sandbox SSH lease:
  user  = agent
  owner = agent runtime/plugin
  agent may control sandbox execution

ephemeral credentialed runner:
  user  = agent
  owner = controller
  agent may request an action
  agent must never control the runner VM
```

## Capability Interface

The portable capability interface has four operations:

```text
list
  Batch-list authorized namespaces and compact capability summaries.

search
  Batch-search only the caller-scoped catalog.

describe
  Batch-return exact Zod-derived schema, result expectations, approval posture,
  and safe calling hints for capabilities.

call
  Batch-validate arguments, apply approval policy, dispatch to configured
  backends, and return structured per-item results.
```

The portable contract preserves the current MCP Portal batch shape for all four
operations. Scalar CLI or SDK helpers may exist, but they are convenience helpers
that normalize into the same batched Zod contract before authorization,
approval, dispatch, or result normalization.

Every surface must preserve item-level results:

```text
request id
item id
status
structured output or structured error
diagnostics
truncation metadata when applicable
artifact references when applicable
audit correlation
```

The same Zod-backed contract can be exposed through:

```text
in-process entrypoint
MCP server
CLI
HTTP API
TypeScript SDK
Python SDK later when a Python runtime needs it
```

A wrapper is not an authorization boundary. Every wrapper must resolve to the
same trusted identity, policy, approval, backend dispatch, and Zod-backed result
contract.

## Zod Contract Schemas

Zod v4 schemas are the source of truth for portal contracts. Contracts are not
authored as JSON Schema first. JSON Schema is a generated interoperability
artifact for surfaces that require it, such as MCP tool descriptors.

Every contract named in this spec must be a Zod v4 schema or a value parsed from
a Zod v4 schema. Contracts must not be prose-only, TypeScript-interface-only, or
handwritten-JSON-Schema-only.

Every public contract and every RPC boundary must have an explicit Zod v4
schema. The schema lives at the boundary it protects and is used to parse
untrusted or cross-boundary input before the value is forwarded.

This applies to:

- MCP tool input and output contracts;
- MCP proxy requests and notifications;
- CLI stdin/stdout JSON contracts;
- HTTP API request and response contracts;
- SDK request and response contracts;
- in-process entrypoint requests and results;
- gateway-to-controller dispatch intent;
- controller-owned backend requests and results;
- credentialed runner action arguments and artifact records;
- Gondolin `ManagedVm.exec` and `ManagedVm.fs` operation contracts where agent
  or adapter data crosses into controller-owned execution.

These are the required surface contracts. The exact exported symbol names may
change during implementation, but the contract families and field boundaries are
normative.

Common primitives:

```ts
import { z } from "zod";

const RequestIdSchema = z.string().min(1);
const ItemIdSchema = z.string().min(1);
const NamespaceNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const CapabilityNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]*$/);
const ProfileIdSchema = z.string().min(1);
const CorrelationIdSchema = z.string().min(1);

const JsonValueSchema = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

const CapabilityRefSchema = z
	.object({
		namespace: NamespaceNameSchema,
		name: CapabilityNameSchema,
	})
	.strict();
```

Model-visible operation contracts:

```ts
const PortalListItemRequestSchema = z
	.object({
		id: ItemIdSchema,
		cursor: z.string().optional(),
		limit: z.number().int().positive().max(100).default(20),
		namespaces: z.array(NamespaceNameSchema).optional(),
		refs: z.array(z.string().min(1)).optional(),
		capabilities: z.array(CapabilityRefSchema).optional(),
	})
	.strict();

const PortalListRequestSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		requests: z.array(PortalListItemRequestSchema).min(1).max(50),
	})
	.strict();

const PortalSearchItemRequestSchema = z
	.object({
		id: ItemIdSchema,
		query: z.string().min(1).optional(),
		limit: z.number().int().positive().max(50).default(10),
		namespaces: z.array(NamespaceNameSchema).optional(),
		schemaDetail: z.enum(["none", "summary", "full"]).default("summary"),
	})
	.strict();

const PortalSearchRequestSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		requests: z.array(PortalSearchItemRequestSchema).min(1).max(50),
	})
	.strict();

const PortalDescribeItemRequestSchema = z
	.object({
		id: ItemIdSchema,
		capabilities: z.array(CapabilityRefSchema).min(1),
		includeJsonSchema: z.boolean().default(true),
		includeRelated: z.boolean().default(true),
		includeTypescriptHelper: z.boolean().default(false),
		includeZod: z.boolean().default(false),
	})
	.strict();

const PortalDescribeRequestSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		requests: z.array(PortalDescribeItemRequestSchema).min(1).max(50),
	})
	.strict();

const PortalCallItemSchema = z
	.object({
		id: ItemIdSchema,
		capability: CapabilityRefSchema,
		arguments: JsonObjectSchema,
	})
	.strict();

const PortalCallRequestSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		calls: z.array(PortalCallItemSchema).min(1).max(50),
	})
	.strict();
```

Model-visible descriptor and result contracts:

```ts
const JsonSchemaDocumentSchema = z.record(z.string(), JsonValueSchema);

const CapabilitySummarySchema = z
	.object({
		namespace: NamespaceNameSchema,
		name: CapabilityNameSchema,
		title: z.string().min(1),
		description: z.string(),
		approval: z.enum(["not_required", "required", "conditional"]),
	})
	.strict();

const ResultExpectationSchema = z
	.object({
		kind: z.enum(["json", "text", "binary_artifact", "mixed"]),
		outputJsonSchema: JsonSchemaDocumentSchema.optional(),
		canStream: z.boolean().default(false),
		canReturnArtifacts: z.boolean().default(false),
		truncation: z.enum(["none", "possible", "expected"]).default("possible"),
	})
	.strict();

const SafeCallingHintSchema = z
	.object({
		code: z.enum([
			"describe_before_call",
			"approval_may_be_required",
			"read_only",
			"write_or_external_effect",
			"large_output_possible",
			"artifact_output_possible",
		]),
		message: z.string().max(500),
	})
	.strict();

const CapabilityDescriptorSchema = z
	.object({
		namespace: NamespaceNameSchema,
		name: CapabilityNameSchema,
		title: z.string().min(1),
		description: z.string(),
		inputJsonSchema: JsonSchemaDocumentSchema,
		outputJsonSchema: JsonSchemaDocumentSchema.optional(),
		approval: z.enum(["not_required", "required", "conditional"]),
		result: ResultExpectationSchema,
		safeCallingHints: z.array(SafeCallingHintSchema),
	})
	.strict();

const PortalErrorSchema = z
	.object({
		code: z.enum([
			"invalid_request",
			"not_found",
			"not_authorized",
			"approval_required",
			"validation_failed",
			"execution_failed",
			"cancelled",
			"timeout",
		]),
		message: z.string().max(500),
		retryable: z.boolean().optional(),
	})
	.strict();

const ApprovalRequiredResultSchema = z
	.object({
		status: z.literal("error"),
		id: ItemIdSchema,
		error: z
			.object({
				code: z.literal("approval_required"),
				message: z.string().max(500),
				retryable: z.literal(false).optional(),
			})
			.strict(),
		auditCorrelationId: CorrelationIdSchema.optional(),
	})
	.strict();

const ArtifactReferenceSchema = z
	.object({
		id: z.string().min(1),
		mediaType: z.string().optional(),
		byteLength: z.number().int().nonnegative().optional(),
		expiresAt: z.string().datetime().optional(),
	})
	.strict();

const ArtifactRecordSchema = z
	.object({
		id: z.string().min(1),
		ownerAgentId: z.string().min(1),
		ownerProfileId: ProfileIdSchema,
		ownerUserId: z.string().min(1).optional(),
		createdAt: z.string().datetime(),
		expiresAt: z.string().datetime().optional(),
		mediaType: z.string().optional(),
		byteLength: z.number().int().nonnegative().optional(),
		auditCorrelationId: CorrelationIdSchema,
		storageClass: z.enum(["controller_buffer", "controller_file", "vm_stream"]),
	})
	.strict();

const ArtifactReadRequestSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		artifactId: z.string().min(1),
		maxBytes: z.number().int().positive().max(10_000_000),
	})
	.strict();

const ArtifactReadResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			requestId: RequestIdSchema.optional(),
			artifact: ArtifactReferenceSchema,
			contentBase64: z.string(),
			truncated: z.boolean().default(false),
			auditCorrelationId: CorrelationIdSchema,
		})
		.strict(),
	z
		.object({
			status: z.literal("error"),
			requestId: RequestIdSchema.optional(),
			error: PortalErrorSchema,
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
]);

const SafeDiagnosticCodeSchema = z.enum([
	"provider_unavailable",
	"capability_denied",
	"approval_required",
	"validation_failed",
	"execution_failed",
	"output_truncated",
	"timeout",
	"cancelled",
	"artifact_unavailable",
]);

const SafeDiagnosticSchema = z
	.object({
		level: z.enum(["debug", "info", "warn", "error"]),
		code: SafeDiagnosticCodeSchema,
		safeMessage: z.string().max(500),
		safeParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
	})
	.strict();

const ResultTruncationSchema = z
	.object({
		truncated: z.boolean(),
		reason: z.enum(["byte_limit", "item_limit", "timeout", "redaction"]),
		visibleBytes: z.number().int().nonnegative().optional(),
		originalBytes: z.number().int().nonnegative().optional(),
	})
	.strict();

const PortalListItemOutputSchema = z
	.object({
		namespaces: z.array(NamespaceNameSchema),
		capabilities: z.array(CapabilitySummarySchema),
		cursor: z.string().optional(),
	})
	.strict();

const PortalSearchItemOutputSchema = z
	.object({
		matches: z.array(CapabilitySummarySchema),
	})
	.strict();

const PortalDescribeItemOutputSchema = z
	.object({
		descriptors: z.array(CapabilityDescriptorSchema),
	})
	.strict();

const PortalListItemResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			id: ItemIdSchema,
			output: PortalListItemOutputSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			truncation: ResultTruncationSchema.optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			status: z.literal("error"),
			id: ItemIdSchema,
			error: PortalErrorSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
]);

const PortalSearchItemResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			id: ItemIdSchema,
			output: PortalSearchItemOutputSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			truncation: ResultTruncationSchema.optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			status: z.literal("error"),
			id: ItemIdSchema,
			error: PortalErrorSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
]);

const PortalDescribeItemResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			id: ItemIdSchema,
			output: PortalDescribeItemOutputSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			status: z.literal("error"),
			id: ItemIdSchema,
			error: PortalErrorSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
]);

const PortalCallItemResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			id: ItemIdSchema,
			output: JsonValueSchema,
			artifacts: z.array(ArtifactReferenceSchema).optional(),
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			truncation: ResultTruncationSchema.optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			status: z.literal("error"),
			id: ItemIdSchema,
			error: PortalErrorSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
]);

const PortalListResultSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		results: z.array(PortalListItemResultSchema),
		diagnostics: z.array(SafeDiagnosticSchema).optional(),
	})
	.strict();

const PortalSearchResultSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		results: z.array(PortalSearchItemResultSchema),
		diagnostics: z.array(SafeDiagnosticSchema).optional(),
	})
	.strict();

const PortalDescribeResultSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		results: z.array(PortalDescribeItemResultSchema),
		diagnostics: z.array(SafeDiagnosticSchema).optional(),
	})
	.strict();

const PortalCallResultSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		results: z.array(PortalCallItemResultSchema),
		diagnostics: z.array(SafeDiagnosticSchema).optional(),
	})
	.strict();
```

Event and cancellation contracts:

```ts
const PortalProgressEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("progress"),
			requestId: RequestIdSchema.optional(),
			callId: ItemIdSchema.optional(),
			safeMessage: z.string().max(500),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("partial_output"),
			requestId: RequestIdSchema.optional(),
			callId: ItemIdSchema,
			content: z.string(),
			truncation: ResultTruncationSchema.optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("diagnostic"),
			requestId: RequestIdSchema.optional(),
			callId: ItemIdSchema.optional(),
			diagnostic: SafeDiagnosticSchema,
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
]);

const CancellationRequestSchema = z
	.object({
		requestId: RequestIdSchema,
		reason: z.string().optional(),
	})
	.strict();

const CancellationResultSchema = z
	.object({
		requestId: RequestIdSchema,
		status: z.enum(["cancelled", "not_found", "already_finished"]),
	})
	.strict();
```

Adapter boundary contracts:

```ts
const TrustedAgentScopeSchema = z
	.object({
		agentId: z.string().min(1),
		profileId: ProfileIdSchema,
		userId: z.string().min(1).optional(),
	})
	.strict();

const AdapterEnvelopeSchema = z
	.object({
		surface: z.enum(["openclaw", "mcp", "cli", "http_api", "typescript_sdk", "python_sdk"]),
		scope: TrustedAgentScopeSchema,
		request: z.union([
			PortalListRequestSchema,
			PortalSearchRequestSchema,
			PortalDescribeRequestSchema,
			PortalCallRequestSchema,
		]),
		correlationId: CorrelationIdSchema.optional(),
	})
	.strict();
```

`TrustedAgentScopeSchema` is parsed from runtime adapter context. It is never
model-supplied input.

Gateway-to-controller dispatch contract:

```ts
const ApprovalDecisionRefSchema = z
	.object({
		id: z.string().min(1),
		expiresAt: z.string().datetime(),
	})
	.strict();

const ControllerDispatchIntentSchema = z
	.object({
		requestId: RequestIdSchema,
		callId: ItemIdSchema,
		scope: TrustedAgentScopeSchema,
		capability: CapabilityRefSchema,
		canonicalArguments: JsonObjectSchema,
		approval: ApprovalDecisionRefSchema.optional(),
		correlationId: CorrelationIdSchema.optional(),
	})
	.strict();
```

This dispatch contract must not contain executable paths, authoritative argv,
cwd, env, credential material, mount paths, host paths, VM profile overrides,
egress overrides, artifact output paths, shell command strings, or PTY requests.
`profileId` appears only inside `TrustedAgentScopeSchema`. If an implementation
adds a redundant profile field for logging, parsing must reject mismatches before
authorization or dispatch.

Controller-owned execution contracts:

```ts
const ExecutionFingerprintSchema = z
	.object({
		agentId: z.string().min(1),
		userId: z.string().min(1).optional(),
		capability: CapabilityRefSchema,
		canonicalArgumentHash: z.string().min(1),
		policyRevision: z.string().min(1),
		catalogRevision: z.string().min(1),
		backendBindingRevision: z.string().min(1),
		executableTemplateRevision: z.string().min(1).optional(),
		custodyMode: z.enum([
			"upstream_mcp_provider_secret",
			"host_mediated_placeholder",
			"ephemeral_material",
			"controller_durable_state",
			"host_owned_action_secret",
		]),
		egressPolicyHash: z.string().min(1).optional(),
		artifactIntentHash: z.string().min(1).optional(),
		outputLimitPolicy: z.string().min(1),
	})
	.strict();

const ControllerExecutionResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			output: JsonValueSchema,
			artifacts: z.array(ArtifactReferenceSchema).optional(),
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			status: z.literal("error"),
			error: PortalErrorSchema,
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			auditCorrelationId: CorrelationIdSchema.optional(),
		})
		.strict(),
]);
```

CLI allowance contracts:

```ts
const CliArgvTokenSchema = z.string().min(1);

const CliFlagRuleSchema = z
	.object({
		flag: CliArgvTokenSchema,
		value: z.enum(["none", "string", "number", "enum", "path", "host"]).default("none"),
		allowedValues: z.array(z.string()).optional(),
	})
	.strict();

const CwdPolicySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("fixed"), path: z.string().startsWith("/") }).strict(),
	z.object({ kind: z.literal("workspace_root") }).strict(),
	z.object({ kind: z.literal("runner_scratch") }).strict(),
]);

const EnvironmentPolicySchema = z
	.object({
		mode: z.enum(["empty", "allowlist", "controller_materialized"]),
		allowedVariables: z.array(z.string().min(1)).default([]),
		deniedPatterns: z.array(z.string()).default([]),
	})
	.strict();

const EgressPolicySchema = z
	.object({
		allowedHosts: z.array(z.string().min(1)),
		allowedPorts: z.array(z.number().int().positive().max(65535)).optional(),
		denyEndpointOverrides: z.boolean().default(true),
	})
	.strict();

const OutputPolicySchema = z
	.object({
		stdoutMaxBytes: z.number().int().positive(),
		stderrMaxBytes: z.number().int().positive(),
		modelVisibleStderr: z.enum(["none", "safe_summary"]).default("safe_summary"),
		redactionProfile: z.string().min(1),
		truncationMode: z.enum(["fail", "truncate", "artifact"]).default("truncate"),
	})
	.strict();

const ArtifactPolicySchema = z
	.object({
		mode: z.enum(["none", "controller_written", "bounded_stream", "vm_file_read"]),
		maxArtifacts: z.number().int().nonnegative().max(20).default(0),
		maxBytesPerArtifact: z.number().int().positive().optional(),
		noFollowRequired: z.boolean().default(true),
	})
	.strict();

const CancellationPolicySchema = z
	.object({
		timeoutMs: z.number().int().positive(),
		onCancel: z.enum(["abort_process", "close_vm"]),
	})
	.strict();

const CliAllowanceSchema = z
	.object({
		capability: CapabilityRefSchema,
		credentialProfileId: z.string().min(1),
		custodyMode: z.enum(["ephemeral_material", "controller_durable_state"]),
		executablePath: z.string().startsWith("/"),
		inputSchemaId: z.string().min(1),
		allowedSubcommands: z.array(z.array(CliArgvTokenSchema)).optional(),
		allowedFlags: z.array(CliFlagRuleSchema).optional(),
		deniedFlags: z.array(CliArgvTokenSchema),
		deniedPatterns: z.array(z.string()),
		cwd: CwdPolicySchema,
		environment: EnvironmentPolicySchema,
		egress: EgressPolicySchema,
		output: OutputPolicySchema,
		artifacts: ArtifactPolicySchema,
		cancellation: CancellationPolicySchema,
		approval: z.enum(["required", "conditional"]),
		safeHelp: z.string().max(4_000),
	})
	.strict();

const CliAllowanceInputSchema = z
	.object({
		argv: z.array(CliArgvTokenSchema).max(100),
		reason: z.string().min(1),
	})
	.strict();

const ValidatedCliInvocationSchema = z
	.object({
		executablePath: z.string().startsWith("/"),
		argv: z.array(CliArgvTokenSchema),
		cwd: CwdPolicySchema,
		environment: EnvironmentPolicySchema,
		egress: EgressPolicySchema,
		output: OutputPolicySchema,
		artifacts: ArtifactPolicySchema,
		cancellation: CancellationPolicySchema,
		fingerprint: ExecutionFingerprintSchema,
	})
	.strict();
```

`ValidatedCliInvocationSchema` is controller-created after parsing
`CliAllowanceInputSchema`, applying the allowance validator, applying approval,
and recomputing controller authority.

ManagedVm bridge contracts:

```ts
const CredentialedRunnerRequestSchema = z
	.object({
		dispatch: ControllerDispatchIntentSchema,
		invocation: ValidatedCliInvocationSchema,
		credentialProfileId: z.string().min(1),
	})
	.strict();

const ManagedVmExecRequestSchema = z
	.object({
		executablePath: z.string().startsWith("/"),
		argv: z.array(z.string()),
		cwd: CwdPolicySchema,
		env: z.record(z.string(), z.string()),
		pty: z.literal(false),
		shellMode: z.literal("none"),
		stdout: z.enum(["stream", "discard"]),
		stderr: z.enum(["stream", "discard"]),
		timeoutMs: z.number().int().positive(),
		stdin: z.string().optional(),
		abortSignalId: z.string().min(1).optional(),
	})
	.strict();

const ManagedVmFsReadArtifactRequestSchema = z
	.object({
		artifactId: z.string().min(1),
		maxBytes: z.number().int().positive(),
		noFollow: z.literal(true),
	})
	.strict();

const ControllerHostActionRequestSchema = z
	.object({
		dispatch: ControllerDispatchIntentSchema,
		hostActionName: z.string().min(1),
		canonicalArguments: JsonObjectSchema,
	})
	.strict();

const ControllerHostActionResultSchema = ControllerExecutionResultSchema;
```

These bridge contracts describe the portal/controller boundary. They do not
expose `ManagedVm` handles, SSH handles, VM ids, guest paths, or host paths to
the model.

Controller runner code must invoke `ManagedVm.exec()` only through values parsed
from `ManagedVmExecRequestSchema`. The broader Gondolin SDK surface is not the
portal contract: string commands, PTY, shell mode, ambient env, unchecked cwd,
and unbounded output modes are outside the allowed bridge shape.

Inbound payloads must be validated before forwarding to the next boundary.
Validation happens at every trust boundary, not only at the model-facing edge:

```text
adapter input
  -> Zod parse
  -> normalized typed request
  -> authorization / approval
  -> Zod parse of dispatch intent
  -> controller re-authorization
  -> Zod parse of backend request
  -> backend execution
```

For MCP and other schema-advertising surfaces, JSON Schema is generated from
the Zod v4 contract with `z.toJSONSchema()`. Boundary schemas that must be
advertised externally must stay representable as JSON Schema. If an internal
Zod construct cannot be represented, the boundary must wrap it in an explicit
JSON-native encoding before it crosses the boundary.

The portable contract should prefer JSON-native values at boundaries: objects,
arrays, strings, numbers, booleans, nulls, enums, discriminated unions, and
bounded records.

Generated JSON Schema is presentation and interoperability output. Runtime
authorization uses parsed Zod values, trusted identity, policy, approval, and
controller recomputation. A JSON Schema document is not an authorization
decision.

## CLI Capability Allowances

CLI-like capabilities are allowed, but they must be explicit capability
contracts. A CLI allowance is not permission for arbitrary shell text and not
permission for arbitrary process execution.

Each CLI allowance must define:

- capability namespace and name;
- credential profile and custody mode;
- fixed absolute executable path selected by trusted config;
- Zod v4 input schema for model/agent-provided arguments;
- argv normalization rules that turn parsed Zod values into trusted argv;
- argv validation rules applied after normalization and before execution;
- allowed subcommands, flags, flag value shapes, and positional argument shapes;
- denied flags and denied argument patterns;
- cwd policy;
- environment policy;
- egress policy;
- output, stderr, timeout, cancellation, and artifact policy;
- approval posture;
- safe help/describe text.

The allowed argument shape can be broad when the CLI family requires
exploration. For example, a CLI allowance may accept an `argv` array only if the
allowance also defines token-level validation:

```text
cli allowance
  executable = /trusted/bin/provider-cli
  input      = Zod v4 schema
  argv       = normalized from parsed input
  validate   = token-level rules + deny rules
  execute    = ManagedVm.exec([executable, ...validatedArgv])
```

CLI validators must reject:

- shell strings;
- pipes, redirects, command separators, and command substitution tokens;
- credential-file, config-file, token-printing, and debug-secret flags unless
  the allowance explicitly models that flag as safe;
- absolute or parent-relative paths unless the allowance explicitly models that
  path family;
- network endpoint overrides unless the allowance explicitly models that target;
- subprocess launcher flags that would let the CLI execute arbitrary commands;
- attempts to override cwd, env, executable, credential profile, or egress.

Promoted typed tools and broad CLI allowances can coexist:

```text
promoted typed tool
  narrow Zod schema
  trusted argv template
  lower approval burden

broad CLI allowance
  broader Zod schema
  stricter argv validator
  usually approval-gated
```

The promotion ladder is therefore:

```text
unknown workflow
  -> help/search-help capability
  -> approval-gated CLI allowance
  -> promoted typed tool when repeated and stable
```

## Model Visibility Contract

The model may see:

- namespace and capability identifiers;
- capability descriptions;
- Zod-derived input schemas;
- Zod-derived result schemas or result summaries;
- approval-required errors;
- safe diagnostics;
- artifact references;
- progress events when the surface supports them;
- next-action guidance.

The model must not see or choose:

- trusted `agentId`;
- backend kind;
- provider transport;
- provider URLs;
- secret refs;
- raw secrets;
- generated env names;
- approval tokens;
- lease ids;
- VM ids;
- runner ids;
- SSH host, port, user, key, or TCP slot;
- executable paths;
- authoritative argv;
- cwd;
- env maps;
- credential mount paths;
- host filesystem paths outside scoped artifact references;
- controller operation URLs;
- egress allowlists.

Backend dispatch is trusted-config-owned. The model asks for a capability. It
does not choose `ssh-sandbox`, MCP transport, strict exec/fs, or host execution.

Model-visible diagnostics use `SafeDiagnosticSchema`. Controller-owned backends
must map raw exceptions, stderr, SDK errors, host paths, executable paths, env
names, provider URLs, and credential-state errors into allowlisted diagnostic
codes and safe messages. Raw backend details belong in audit-only records.
`PortalErrorSchema.message` is also model-visible and must be a generated safe
message, not raw exception text.

## Backend Dispatch Matrix

```text
Backend                    Config owner         Execution owner
-------------------------  -------------------  -----------------------------
MCP provider backend       MCP Portal policy    MCP Portal/provider runtime
OpenClaw Sandbox SSH lease system + portal cfg  OpenClaw gateway/plugin
ephemeral credentialed     Tool Portal + ctrl   controller
narrow host action         Tool Portal + ctrl   controller
```

```text
Backend                    Lifecycle authority  Transport
-------------------------  -------------------  -----------------------------
MCP provider backend       MCP session/provider MCP/RPC
OpenClaw Sandbox SSH lease controller lease mgr SSH over tcpHosts
ephemeral credentialed     controller run rec  ManagedVm exec/fs
narrow host action         controller          host internal function
```

```text
Backend                    Credential posture
-------------------------  --------------------------------------------------
MCP provider backend       upstream provider secrets owned by MCP Portal runtime
OpenClaw Sandbox SSH lease host-mediated placeholders only; no durable auth state
ephemeral credentialed     per-run materialization; controller-owned custody
narrow host action         host-only controller credential
```

The matrix is intentionally axis-based. A backend is a combination of user,
owner, lifecycle, transport, and custody. It is not a model-selected tool kind.

## Deployment Modes And Active Surfaces

Only one model-visible policy authority may be active for a capability in a
deployment.

```text
standalone MCP Portal mode
  model-visible surface = mcp_portal_list/search/describe/call
  policy authority      = mcp-portal.config.jsonc
  backend authority     = MCP Portal runtime

Tool Portal mode
  model-visible surface = Tool Portal list/search/describe/call adapters
  policy authority      = tool-portal.config.jsonc
  MCP execution         = MCP Portal backend adapter behind Tool Portal
```

In Tool Portal mode, direct native `mcp_portal_*` registration is disabled for
agents whose MCP-backed capabilities are exposed through Tool Portal. A runtime
may expose compatibility names only if those names forward into Tool Portal and
use Tool Portal policy, approval, audit correlation, and result contracts. They
must not load an independent `mcp-portal.config.jsonc` policy for the same
model-visible capability.

Standalone MCP Portal mode continues to use current MCP Portal surfaces directly.
The deployment must choose the mode per agent/profile before tool registration,
not per call.

## MCP Provider Backend

The MCP provider backend delegates to MCP Portal.

Use it when the capability is already represented as an upstream MCP tool.

The composition seam is a package export, not an implied import of current
`mcp_portal_*` tool handlers:

```text
@agent-vm/mcp-portal/mcp-provider-backend
  createMcpProviderCapabilityBackend(...)
    accepts Tool Portal effective MCP projection
    accepts agent-portal-sdk batch operation contracts
    calls MCP Portal runtime/core internally
    returns agent-portal-sdk batch result contracts
```

Tool Portal depends on this backend adapter. It must not depend on
`mcp_portal_*` model tool names, current OpenClaw MCP Portal plugin glue, or
upstream MCP provider credentials.

MCP Portal owns:

- upstream MCP provider discovery;
- MCP provider sessions;
- Streamable HTTP, SSE, and stdio MCP transport handling;
- upstream MCP schema validation;
- upstream provider credential resolution and presentation;
- provider result redaction;
- MCP Portal profile policy and approval evaluation;
- MCP-specific diagnostics and upstream notification handling.

The broader Tool Portal, if present, owns:

- whether the MCP-backed capability appears in the Tool Portal catalog;
- Tool Portal namespace and policy projection;
- cross-backend approval and audit correlation;
- Tool Portal result wrapping when needed.

Standalone MCP Portal mode is MCP Portal-authoritative: `mcp-portal.config.jsonc`
owns profiles, policy, and approval.

When Tool Portal exposes MCP-backed capabilities, Tool Portal is the
authoritative cross-backend policy surface. It must project or generate the
effective MCP Portal policy needed for those MCP-backed capabilities. Tool
Portal must not list an MCP-backed capability that the effective MCP Portal
policy will deny. MCP Portal still owns upstream MCP provider sessions,
transport handling, provider secret resolution, upstream schema validation, and
MCP-specific redaction.

The projection artifact is the effective MCP backend policy consumed by
`createMcpProviderCapabilityBackend`. It contains only the MCP-backed
capabilities Tool Portal has authorized for the trusted agent/profile. It is
derived from `tool-portal.config.jsonc` plus MCP provider discovery, not from an
independently user-authored MCP Portal policy for the same Tool Portal surface.

MCP Portal must remain MCP-specific. It must not become the owner of VM leases,
credentialed runner execution, OpenClaw path semantics, or host actions.

Managed OpenClaw uses MCP Portal through an in-process adapter:

```text
OpenClaw native mcp_portal_* tool
  -> trusted ctx.agentId
  -> MCP Portal in-process core entrypoint
  -> MCP provider runtime
  -> upstream MCP tool
```

External MCP clients use the external MCP proxy adapter:

```text
external MCP client
  -> loopback /agents/:agentId/mcp
  -> bearer auth verification
  -> trusted agent scope
  -> MCP Portal in-process core entrypoint
```

## OpenClaw Sandbox SSH Lease Backend

OpenClaw Sandbox SSH lease is the current Tool VM execution shape.

It is a named, reusable VM lease for agent-controlled sandbox execution. The
agent runtime/plugin owns command execution. The controller owns lifecycle.

Current path:

```text
OpenClaw gateway/plugin
  -> POST /lease
  -> controller validates agent/profile/work mount
  -> controller creates or reuses Tool VM
  -> controller enables SSH
  -> controller returns SSH capability
  -> gateway/plugin connects over SSH
  -> command and file bridge data flow over SSH
```

The controller owns:

- lease creation;
- agent/profile/work-mount compatibility checks;
- VM creation and reuse;
- SSH enablement;
- active-use start, heartbeat, and end;
- idle TTL and release;
- stale lease eviction;
- lease records and health state.

The OpenClaw gateway/plugin owns:

- SSH command execution;
- stdin/stdout/stderr data path;
- OpenClaw filesystem bridge;
- OpenClaw workspace semantics;
- OpenClaw sandbox handle behavior;
- SSH session cleanup.

The controller must not become a generic command/file proxy for this backend.
Raw SSH over `tcpHosts` is not HTTP mediation. Do not treat SSH transport and
Gondolin HTTP secret mediation as the same security mechanism.

This backend may receive host-mediated placeholders for declared hosts. It must
not receive durable provider credential state.

## Ephemeral Credentialed Runner Backend

The ephemeral credentialed runner is the controlled execution backend for
credentialed actions.

It is always controller-owned and one-shot in this design. This intentionally
supersedes earlier warm/reusable credentialed-runner wording. If a reusable
high-trust runner is ever needed, it requires a separate design with its own
custody, recovery, identity, and cleanup model.

The agent may request a credentialed capability. The agent must never receive
control of the runner VM.

```text
agent capability call
  -> trusted scope and Zod v4 validation
  -> approval policy
  -> controller re-authorizes backend dispatch
  -> controller creates one-shot execution VM lifecycle
  -> controller materializes only run-scoped credentials/inputs
  -> controller executes fixed operation over ManagedVm.exec
  -> controller drains stdout/stderr while process runs
  -> controller streams or summarizes artifacts through ManagedVm.fs
  -> controller destroys VM and cleans run-scoped material
  -> in-process entrypoint returns structured result
```

`ManagedVm.exec` and `ManagedVm.fs` are the strict RPC surface for this backend.
Strict RPC means:

- no SSH into the runner VM;
- no ingress service in the runner VM;
- no reusable lease id;
- no create/peek/renew/release lease API surface;
- no arbitrary shell controlled by the agent;
- no string-form `ManagedVm.exec`;
- no PTY;
- no shell launchers unless the catalog-owned action executable is itself the
  shell boundary being explicitly modeled;
- no model-supplied executable;
- no model-supplied authoritative argv;
- no model-supplied cwd;
- no model-supplied env map;
- no model-supplied host paths;
- no exposed `ManagedVm` handle.

Runner execution uses array-form process execution only:

```text
ManagedVm.exec([absoluteCatalogOwnedExecutablePath, ...trustedArgv])
```

`argv[0]` is always a catalog-owned absolute executable path selected by
trusted backend config. The model may supply typed arguments. Trusted code
turns those typed arguments into authoritative argv after Zod v4 validation,
CLI allowance validation or typed-tool argv templating, approval, and
controller re-authorization.

The controller owns:

- action-to-backend authorization;
- runner VM lifecycle;
- executable selection;
- argv construction from trusted templates;
- cwd selection;
- env selection;
- credential materialization;
- egress and mediation policy;
- output and artifact caps;
- stdout/stderr drain;
- artifact publication;
- cancellation and cleanup;
- audit events.

Ephemeral means:

- no warm reuse;
- no durable credential mount inside the VM;
- no SSH capability returned;
- no ingress capability returned;
- no leaked VM or process handle;
- cleanup on success, failure, timeout, and cancellation.

Durable credential state, when needed for refresh or account binding, belongs to
controller-owned host state. The runner receives only the scoped material needed
for one run.

## Narrow Host Action Backend

Some capabilities belong on the controller host because the controller owns the
secret, state, or repository authority.

Examples:

- push an agent branch;
- refresh default/current branch;
- perform a typed pull request operation through a controller-owned integration.

Host actions must be typed, named operations. They must not become a generic
host command runner.

```text
agent capability call
  -> trusted scope and Zod v4 validation
  -> approval policy
  -> controller action authorization
  -> typed host operation
  -> structured result
```

The model must not supply shell text, arbitrary executable names, host paths, or
controller admin route names.

## Controller-Owned Execution Contract

Controller-owned backends include ephemeral credentialed runner and narrow host
action. Their execution authority lives in the controller, even when the
agent-facing adapter and in-process entrypoint live in a gateway process.

The in-process entrypoint may send a dispatch intent to the controller:

```text
dispatch intent
  request id
  trusted agent id
  user id / operator context when available
  capability namespace and name
  canonical arguments
  approval decision reference, if present
  trusted scope carrying profile id
  caller cancellation signal
  diagnostic correlation id
```

The dispatch intent must not contain authoritative execution fields:

```text
forbidden in dispatch intent
  executable path
  authoritative argv
  cwd
  env map
  credential material
  credential mount path
  host path
  VM image/profile override
  egress override
  artifact output path
  shell command string
  PTY request
```

The controller must recompute or verify:

- trusted agent authorization for the controller operation;
- current profile/policy revision;
- capability catalog revision;
- backend binding;
- custody mode;
- executable template;
- authoritative argv;
- cwd;
- env;
- credential materialization;
- egress policy;
- VM image/profile;
- output and artifact limits;
- approval freshness and single-use status.

For approval-bound calls, the controller creates an execution fingerprint:

```text
execution fingerprint
  agent id
  user/operator context when available
  namespace
  capability name
  canonical argument hash
  policy/catalog revision
  backend binding revision
  executable/template revision
  custody mode
  egress policy hash
  artifact intent hash
  output limit policy
```

An approval becomes stale if any fingerprint field changes before execution.
The controller rejects stale approvals instead of silently changing what the
operator approved.

## In-Process Core Entrypoint

The in-process core entrypoint is the local API that every adapter calls after
identity is trusted.

It owns:

- trusted identity scope;
- scoped catalog;
- catalog-static dispatch-intent construction;
- Zod v4 validation;
- approval evaluation;
- approval token verification when the runtime uses approval tokens;
- item-level result normalization;
- safe diagnostics;
- event normalization;
- audit correlation.

Adapters own runtime-specific authentication and context translation:

```text
OpenClaw adapter
  trusted OpenClaw ctx.agentId
  OpenClaw approval prompt integration
  OpenClaw native tool registration
  in-process core call

MCP proxy adapter
  bearer auth
  MCP session management
  in-process core call

CLI adapter
  local token/env/lease bootstrap
  stdin/stdout JSON normalization
  in-process or API call

SDK adapter
  typed wrapper
  in-process or API call
```

The in-process core entrypoint must not depend on OpenClaw SDK glue. Runtime
adapters translate runtime context into core requests.

Topology depends on deployment mode:

```text
managed OpenClaw MCP Portal
  OpenClaw gateway process
  -> MCP Portal in-process entrypoint
  -> MCP provider runtime

Tool Portal with controller-owned backend
  runtime adapter process
  -> Tool Portal in-process entrypoint
  -> controller dispatch intent
  -> controller re-authorization
  -> controller-owned execution
```

The first topology is gateway-local because MCP Portal already owns the MCP
provider runtime. The second topology is controller-authoritative because the
backend uses controller-owned credentials, host authority, or runner VMs.

## Runtime Adapter Auth Classes

Runtime adapters are not equal trust classes. A surface that can load config and
resolve secrets locally is an operator surface, not a model-facing agent surface.

```text
Adapter class                  Trust posture
-----------------------------  -----------------------------------------------
in-process OpenClaw adapter    trusted runtime context; no agent-supplied token
external MCP proxy             authenticated local/remote client session
operator CLI                   high-trust admin/operator entrypoint
agent CLI wrapper              low-trust code-mode agent client
TypeScript SDK in-process      trusted only when called by trusted runtime code
TypeScript SDK remote/client   low-trust client unless backed by a lease
Python SDK later               same rules as TypeScript SDK
HTTP API                       authenticated client session
```

Rules:

- wrappers never receive upstream provider credentials;
- generated agent bundles must not contain raw secrets, provider credentials, or
  long-lived bearer tokens;
- agent-facing CLI/SDK/API access uses a scoped token, token file, or runtime
  identity issued outside the repo and bound to agent id, profile id, expiry,
  and revocation state;
- token files must be outside the repository and intended for `0600` storage;
- write-capable local agent access requires approval semantics before execution;
- operator CLIs may load config and resolve secrets, but they are not the
  contract for arbitrary code-mode agents.

`mcp-portal call --config-dir ...` is an operator/admin CLI. A future
`mcp-portal-call` or `tool-portal-call` wrapper is an agent-facing adapter that
normalizes stdin JSON into the batched Zod contract and authenticates through
agent-scoped local identity. These must stay separate in code and docs.

## Package Boundaries

Target package/product shape:

```text
@agent-vm/agent-portal-sdk
  portal-neutral Zod v4 contracts and adapter helpers

@agent-vm/mcp-portal
  MCP provider portal

@agent-vm/controller-execution-contracts
  controller-owned execution and host-action Zod v4 RPC contracts

@agent-vm/tool-portal
  broader capability portal that composes MCP Portal and controlled backends

@agent-vm/openclaw-mcp-portal-plugin
  current OpenClaw adapter for MCP Portal

@agent-vm/openclaw-agent-vm-plugin
  current OpenClaw sandbox adapter for SSH Tool VM execution

future OpenClaw Tool Portal adapter
  OpenClaw adapter for Tool Portal
```

`@agent-vm/agent-portal-sdk` may own:

- identity and scope primitives;
- catalog descriptor primitives;
- list/search/describe/call Zod v4 operation contracts;
- batch request and per-item result shapes;
- structured error and diagnostic shapes;
- progress and partial-content event vocabulary;
- approval decision primitives;
- call-surface adapter helpers;
- portal-neutral catalog search helpers.

It must not own:

- MCP provider transports;
- upstream MCP provider credentials;
- `mcp_portal_*` names;
- OpenClaw SDK glue;
- VM lifecycle;
- SSH execution;
- strict ManagedVm runner execution;
- host actions;
- provider-specific auth behavior.

`@agent-vm/controller-execution-contracts` owns:

- gateway-to-controller dispatch intent schemas;
- controller execution result schemas;
- execution fingerprint schemas;
- credentialed runner request schemas;
- strict ManagedVm exec/fs bridge schemas;
- controller host action request/result schemas.

It must not own:

- model-visible descriptors;
- runtime adapter registration;
- MCP provider sessions;
- OpenClaw SDK glue;
- controller runtime side effects;
- VM lifecycle implementation.

Dependency direction:

```text
agent-portal-sdk
  no dependency on mcp-portal or tool-portal

mcp-portal
  depends on agent-portal-sdk
  owns MCP-specific runtime
  exports MCP provider backend adapter for Tool Portal

tool-portal
  depends on agent-portal-sdk
  depends on controller-execution-contracts for controller RPC contracts
  composes mcp-portal through the MCP provider backend adapter
  owns Tool Portal catalog-static dispatch intent and non-MCP backends

controller-execution-contracts
  depends on agent-portal-sdk
  no dependency on mcp-portal or tool-portal

openclaw-mcp-portal-plugin
  depends on mcp-portal
  owns OpenClaw-native registration for MCP Portal capabilities

openclaw-agent-vm-plugin
  owns OpenClaw sandbox SSH execution and filesystem bridge semantics

OpenClaw adapters
  depend on their portal package
  own OpenClaw-specific registration, hooks, approval, and path semantics
```

Forbidden dependency directions:

- Agent Portal SDK must not import MCP Portal.
- Agent Portal SDK must not import controller execution contracts.
- MCP Portal must not import Tool Portal.
- MCP Portal must not import VM runner code.
- Controller execution contracts must not import MCP Portal, Tool Portal, or
  OpenClaw adapters.
- Tool Portal core must not import OpenClaw SDK glue.
- Backend adapters must not depend on model-facing tool names.

Public package API shape:

```text
Package                               Public exports
------------------------------------  -----------------------------------------
@agent-vm/agent-portal-sdk            .
                                      ./portal-call-surface
                                      ./capability-description-surface
                                      ./adapter-boundary
                                      ./approval-surface
                                      ./artifact-surface
                                      ./portal-event-surface
                                      ./testing

@agent-vm/mcp-portal                  existing root/core/mcp-proxy/cli/
                                      portal-config/portal-auth/testing exports
                                      ./mcp-provider-backend

@agent-vm/controller-execution-contracts
                                      .
                                      ./controller-dispatch-boundary
                                      ./credentialed-runner-boundary
                                      ./controller-host-action-boundary
                                      ./testing

@agent-vm/tool-portal                 .
                                      ./in-process-entrypoint
                                      ./cli
                                      ./mcp-proxy
                                      ./http-api
                                      ./testing

@agent-vm/openclaw-tool-portal-plugin .
```

Internal-only folders are any slice folders not exported by the package map.
Testing exports may expose contract factories, fake backends, and assertion
helpers; they must not expose credential material, real provider helpers, or
privileged controller bypasses.

## Separation Of Concerns

The code structure should mirror the surface boundaries. A layer owns one reason
to change, and cross-layer data moves through Zod v4 contracts.

```text
Layer                         Owns
----------------------------  -----------------------------------------------
agent-portal-sdk              portal-neutral Zod contracts and helpers
controller-execution-contracts controller-owned RPC Zod contracts
runtime adapters              runtime auth/context and surface I/O
in-process entrypoint         catalog, policy, approval, normalization
MCP Portal                    MCP provider runtime and MCP-specific policy mode
Tool Portal                   cross-backend catalog and dispatch intent
backend adapters              private backend protocol implementation
controller execution          re-authorization, custody, lifecycle, execution
config contracts              config parsing and effective config projection
tests/proof lanes             boundary, no-leak, and backend behavior proof
```

```text
Layer                         Must not own
----------------------------  -----------------------------------------------
agent-portal-sdk              MCP transports, OpenClaw glue, VM lifecycle
controller-execution-contracts runtime side effects, model-visible descriptors
runtime adapters              independent policy, backend dispatch authority
in-process entrypoint         runtime-specific auth, raw credentials
MCP Portal                    VM leases, credentialed runners, host actions
Tool Portal                   upstream MCP provider sessions or secrets
backend adapters              model-facing tool names or approval prompts
controller execution          model-visible descriptors or adapter UI
config contracts              runtime side effects or process execution
tests/proof lanes             weakened contracts to fit implementation
```

Layer responsibilities:

- `agent-portal-sdk` owns Zod v4 contracts, shared result/event/error
  primitives, adapter helper types, and JSON Schema generation helpers. It is
  the contract package, not a runtime package.
- `controller-execution-contracts` owns Zod v4 schemas for controller RPC,
  dispatch intent, execution fingerprints, credentialed runner requests,
  ManagedVm bridge requests, and controller host action requests/results. It is
  a contract package, not the controller runtime.
- runtime adapters own conversion from their host runtime into trusted portal
  calls: OpenClaw native tools, MCP server/proxy, CLI stdin/stdout, HTTP API,
  TypeScript SDK, and future Python SDK. They do not fork policy.
- the in-process entrypoint owns scoped catalog lookup, Zod v4 parsing,
  approval evaluation, dispatch-intent construction, result normalization, and
  safe diagnostics.
- MCP Portal owns upstream MCP provider sessions, MCP transport behavior,
  provider schema handling, provider redaction, standalone MCP Portal profiles,
  and standalone MCP approval.
- Tool Portal owns the cross-backend capability catalog, Tool Portal profiles,
  projection into MCP-backed capabilities, non-MCP dispatch intent, and
  cross-backend audit correlation.
- backend adapters own only their private backend protocol: MCP provider call,
  OpenClaw Sandbox SSH lease bridge, ephemeral credentialed runner execution, or
  narrow host action call.
- controller execution owns final authority for controller-owned backends:
  re-authorization, execution fingerprinting, credential custody, VM lifecycle,
  fixed executable selection, argv construction, egress, artifact policy,
  cancellation, and cleanup.
- config contracts own Zod v4 config schemas and effective-config projection.
  They do not execute calls or hold runtime state.

Vertical slice rule:

```text
new capability or surface
  -> define/update Zod contract
  -> expose descriptor from the same contract
  -> parse at adapter boundary
  -> parse at in-process entrypoint
  -> parse dispatch intent when crossing to controller
  -> controller recomputes authority
  -> backend adapter executes only trusted normalized input
  -> normalized result returns through Zod-backed result/event contracts
```

Implementation plans should use vertical slices that preserve these boundaries.
A valid vertical slice may touch several layers, but it must not blur ownership.
For example, adding CLI access to a capability may touch SDK contracts, a CLI
adapter, Tool Portal catalog, and a backend adapter. It must not put CLI parsing
inside credential custody code or backend policy inside the CLI wrapper.

Horizontal refactors are acceptable only when they strengthen a named layer
boundary, such as extracting shared Zod contracts into `agent-portal-sdk` before
multiple adapters depend on them.

Folder and file naming rules:

- top-level folders inside a package are vertical slices or named surface
  boundaries;
- `models` may exist only under a vertical slice or named surface boundary;
- Zod schema files live in slice-local `models` folders because schemas are the
  validation contracts;
- no `schemas`, `validation`, `mapping`, or `test-support` bucket folders for
  new portal work;
- tests are colocated beside the file under test using the repo suffix rules;
- shared cross-package harness files live under `tests/harness`;
- file names are descriptive, multi-word responsibility names;
- single-word files are not allowed for new portal work except package
  entrypoints such as `index.ts`;
- a file name should answer what boundary, contract, parser, evaluator,
  projector, validator, invoker, publisher, or redactor it owns.

Target file and folder structure:

```text
packages/
  agent-portal-sdk/
    src/
      index.ts

      contract-primitives/
        models/
          json-value-schema.ts
          request-id-schema.ts
          capability-reference-schema.ts

      portal-call-surface/
        models/
          portal-list-item-request-schema.ts
          portal-list-request-schema.ts
          portal-search-item-request-schema.ts
          portal-search-request-schema.ts
          portal-describe-item-request-schema.ts
          portal-describe-request-schema.ts
          portal-call-request-schema.ts
          portal-list-result-schema.ts
          portal-list-item-result-schema.ts
          portal-search-result-schema.ts
          portal-search-item-result-schema.ts
          portal-describe-result-schema.ts
          portal-describe-item-result-schema.ts
          portal-call-result-schema.ts
          portal-call-item-result-schema.ts
          portal-error-schema.ts
        portal-call-json-schema-exporter.ts

      capability-description-surface/
        models/
          capability-descriptor-schema.ts
          capability-json-schema-document-schema.ts
          capability-summary-schema.ts
          result-expectation-schema.ts
          safe-calling-hint-schema.ts
        capability-descriptor-json-schema-exporter.ts

      adapter-boundary/
        models/
          trusted-agent-scope-schema.ts
          adapter-envelope-schema.ts
        adapter-envelope-parser.ts

      approval-surface/
        models/
          approval-required-result-schema.ts
          approval-decision-reference-schema.ts

      artifact-surface/
        models/
          artifact-reference-schema.ts
          artifact-record-schema.ts
          artifact-read-request-schema.ts
          artifact-read-result-schema.ts
        artifact-reference-redactor.ts

      portal-event-surface/
        models/
          safe-diagnostic-schema.ts
          portal-progress-event-schema.ts
          portal-partial-output-event-schema.ts
          portal-diagnostic-event-schema.ts
        safe-diagnostic-redactor.ts

  mcp-portal/
    src/
      mcp-provider-backend/
        mcp-provider-capability-backend.ts
        mcp-provider-backend-result-normalizer.ts
        mcp-provider-backend-policy-projector.ts

  controller-execution-contracts/
    src/
      index.ts

      controller-dispatch-boundary/
        models/
          controller-dispatch-intent-schema.ts
          execution-fingerprint-schema.ts
          controller-execution-result-schema.ts

      credentialed-runner-boundary/
        models/
          credentialed-runner-request-schema.ts
          managed-vm-exec-request-schema.ts
          managed-vm-artifact-read-request-schema.ts

      controller-host-action-boundary/
        models/
          controller-host-action-request-schema.ts
          controller-host-action-result-schema.ts

  tool-portal/
    src/
      index.ts

      tool-portal-capability-catalog/
        models/
          tool-portal-capability-descriptor-schema.ts
          tool-portal-profile-schema.ts
          tool-portal-policy-schema.ts
        tool-portal-capability-catalog.ts
        capability-descriptor-projector.ts
        capability-search-index.ts

      tool-portal-policy/
        tool-portal-policy-evaluator.ts
        approval-policy-evaluator.ts
        mcp-backed-capability-policy-projector.ts

      controller-dispatch/
        controller-dispatch-client.ts
        controller-dispatch-result-normalizer.ts

      cli-allowances/
        models/
          cli-argv-token-schema.ts
          cli-flag-rule-schema.ts
          cli-allowance-schema.ts
          cli-allowance-input-schema.ts
          cwd-policy-schema.ts
          environment-policy-schema.ts
          egress-policy-schema.ts
          output-policy-schema.ts
          artifact-policy-schema.ts
          cancellation-policy-schema.ts
          validated-cli-invocation-schema.ts
        cli-argv-normalizer.ts
        cli-argv-validator.ts
        cli-deny-rule-evaluator.ts

      mcp-backed-capabilities/
        mcp-backed-capability-dispatcher.ts

      credentialed-runner-capabilities/
        credentialed-runner-capability-dispatcher.ts

      controller-host-actions/
        controller-host-action-dispatcher.ts

      portal-result-normalization/
        backend-result-normalizer.ts
        portal-diagnostic-redactor.ts
        portal-artifact-reference-redactor.ts

  openclaw-tool-portal-plugin/
    src/
      index.ts
      openclaw-tool-portal-plugin-registration.ts
      openclaw-tool-portal-native-tools.ts
      openclaw-tool-portal-approval-adapter.ts
      openclaw-tool-portal-scope-builder.ts
      openclaw-tool-portal-result-writer.ts

  config-contracts/
    src/
      tool-portal-config.ts
      tool-portal-config.unit.test.ts

  agent-vm/
    src/
      controller/
        tool-portal-dispatch/
          controller-dispatch-routes.ts
          controller-dispatch-request-parser.ts
          controller-dispatch-reauthorizer.ts
          controller-execution-fingerprint-builder.ts

        credentialed-runner/
          models/
            credentialed-runner-run-record-schema.ts
            credentialed-runner-invocation-request-schema.ts
          credentialed-runner-service.ts
          credentialed-runner-vm-spec-builder.ts
          managed-vm-exec-invoker.ts
          runner-output-drainer.ts
          runner-artifact-publisher.ts
          runner-cleanup-manager.ts

        controller-host-actions/
          controller-host-action-registry.ts
          git-branch-push-host-action.ts
          git-default-branch-refresh-host-action.ts

tests/
  harness/
    agent-portal/
      fake-tool-portal-controller.ts
      fake-managed-vm-runner.ts
      fake-mcp-provider-server.ts
      portal-contract-assertions.ts
```

Colocated tests use the same path as the file they verify:

```text
packages/tool-portal/src/cli-allowances/cli-argv-validator.ts
packages/tool-portal/src/cli-allowances/cli-argv-validator.unit.test.ts

packages/agent-portal-sdk/src/portal-call-surface/models/portal-call-request-schema.ts
packages/agent-portal-sdk/src/portal-call-surface/models/portal-call-request-schema.unit.test.ts
```

Testing follows a performant TDD pyramid:

```text
unit
  many fast tests
  Zod contracts, parsers, validators, redactors, normalizers,
  policy decisions, argv normalization, deny rules, fingerprints

integration
  fewer boundary tests
  adapter-to-entrypoint parsing, Tool Portal to MCP Portal projection,
  controller dispatch re-authorization with fake backend edges

host e2e / VM e2e / OpenClaw e2e
  narrow production-shaped proof
  CLI wrapper behavior, real controller route wiring, real ManagedVm
  lifecycle where required, OpenClaw adapter behavior where required
```

New behavior should start with the smallest failing proof at the correct layer.
Unit tests should stay process-local and deterministic. Integration tests should
prove module and protocol boundaries without booting live VMs or providers. E2E
tests should be reserved for production-shaped runtime paths that lower layers
cannot prove.

Performance expectations:

- Zod contract, parser, validator, redactor, and policy tests belong in unit
  suites and should stay cheap enough to run constantly while developing;
- integration tests should use fake MCP providers, fake controller dispatch, or
  fake ManagedVm edges unless the real boundary is the behavior under test;
- live VM/OpenClaw/host e2e tests should be targeted proof gates, not the main
  design feedback loop;
- tests must not use broad sleeps when an event, fake clock, or bounded protocol
  wait can prove the behavior.

The target structure intentionally does not create these folders:

```text
packages/*/src/models/
packages/*/src/schemas/
packages/*/src/validation/
packages/*/src/mapping/
packages/*/src/test-support/
```

## Config Ownership

Config composes by ownership. It must not hide policy through inheritance or
default-profile merging.

Current MCP ownership:

```text
mcp.config.jsonc
  upstream MCP providers
  MCP transports
  provider egress
  provider secrets
  provider secret injection policy

mcp-portal.config.jsonc
  MCP Portal agents
  MCP Portal profiles
  MCP Portal policy
  MCP Portal approval
  external MCP proxy auth material
```

Target Tool Portal ownership:

```text
tool-portal.config.jsonc
  Tool Portal agents/profiles
  capability namespaces
  catalog-static dispatch intent
  backend adapter references
  credential custody policy
  output and artifact limits
  composed MCP Portal references
  OpenClaw Sandbox SSH lease exposure policy
  ephemeral credentialed runner policy
  narrow host action bindings
```

Controller-owned backends must be re-authorized by the controller before they
touch credentials, argv, cwd, env, host paths, VM profiles, or egress policy.
Gateway-effective config may shape the catalog; it must not be the only
authority for controller-owned execution.

For MCP-backed capabilities exposed through Tool Portal, Tool Portal owns the
cross-backend policy and projects the effective MCP Portal policy. There must
not be two independent policy authorities for the same model-visible
capability. Standalone MCP Portal deployments continue to use MCP Portal policy
directly.

In Tool Portal mode:

- `tool-portal.config.jsonc` is the only user-authored policy for
  Tool Portal-exposed capabilities;
- `mcp.config.jsonc` still owns upstream MCP provider transport, egress, and
  provider secret references;
- MCP Portal receives an effective policy projection for MCP-backed Tool Portal
  capabilities;
- `mcp-portal.config.jsonc` may still exist for standalone agents/profiles, but
  it must not authorize the same model-visible capability for an agent/profile
  that is routed through Tool Portal;
- generated or in-memory MCP Portal policy projections are implementation
  artifacts, not a second operator-owned config surface.

Profiles are complete policies. There is no profile inheritance and no hidden
merge with a default profile.

## Credential Custody

Credential custody is independent from call surface.

```text
Custody mode                  Allowed posture
----------------------------  -----------------------------------------------
upstream MCP provider secret  MCP Portal/provider runtime only
host-mediated placeholder     MCP provider or OpenClaw Sandbox SSH lease path
ephemeral material            ephemeral credentialed runner only
controller durable state      controller host state; materialized per run
host-owned action secret      narrow controller host action only
```

Rules:

- agents must not receive upstream MCP provider credentials;
- OpenClaw Sandbox SSH lease must not receive durable provider credential state;
- credentialed runner must receive only per-run material inside the VM;
- durable credential state for credentialed actions must be controller-owned
  host state, not VM state;
- host-owned action secrets must never be exposed as portal inputs;
- raw env credentials require explicit allowlist and are not the default;
- allowed egress hosts are a trust boundary because any readable data can be
  exfiltrated to those hosts.

## Approval Contract

Approval is evaluated against trusted identity, capability identity, canonical
arguments, and policy. Approval tokens, when used, are server-side plumbing and
not model-visible proof.

Approval-required calls must return structured `approval_required` results when
approval is not already granted.

Approval for credentialed actions must bind to:

- trusted agent identity;
- user/operator context when available;
- capability namespace and name;
- canonical argument hash;
- policy/catalog revision when available;
- controller execution fingerprint;
- artifact intent when the call can publish artifacts;
- expiration;
- single-use replay protection when approval tokens are used.

The model sees `approval_required` or a normal result. Approval tokens, dispatch
tokens, and execution fingerprints are runtime/controller plumbing and must not
be emitted in model-visible results or diagnostics.

Mixed batches should preserve item-level behavior: approval-free calls may run;
approval-required calls should return item-level approval errors unless the
runtime has a homogeneous approval prompt path.

## Streaming, Cancellation, And Artifacts

Streaming is backend-owned. The portal Zod-backed contract exposes normalized
events, structured summaries, truncation metadata, and artifact references.

Rules:

- no backend may require unbounded stdout/stderr buffering;
- long outputs must be capped, summarized, truncated, or stored as artifacts;
- truncation must be explicit in structured results;
- binary or large artifacts should return scoped artifact references;
- artifact references must be auditable and scoped to the caller;
- artifact references must be opaque controller-minted handles;
- artifact references must not encode backend kind, lease id, runner id, VM id,
  host path, guest path, provider URL, credential profile, or executable path;
- artifact readback, when exposed, must go through `ArtifactReadRequestSchema`
  and `ArtifactReadResultSchema` with caller-scope re-authorization, byte caps,
  expiry checks, audit correlation, and no raw backend path disclosure;
- raw backend streams are not the Zod-backed model-facing contract.

Backend-specific rules:

```text
OpenClaw Sandbox SSH lease
  command data flows over SSH between gateway/plugin and VM.
  The controller tracks active use, not stdout/stderr bytes.

ephemeral credentialed runner
  stdout/stderr must be piped and drained while the process runs.
  artifacts should stream through ManagedVm.fs.
  byte caps, abort, and truncation are controller-owned.
```

Cancellation is security-sensitive for ephemeral credentialed runners:

```text
caller cancel / timeout
  -> adapter abort signal
  -> in-process core cancellation
  -> controller runner cancellation
  -> ManagedVm.exec abort
  -> credential/artifact cleanup
  -> VM close
  -> structured cancellation result
```

File artifact publication needs typed runtime path mapping and a
no-follow/symlink-safe proof before broad support. Until that proof exists,
artifact support should prefer explicit controller-written outputs or bounded
streams whose source path is not model-controlled. Artifact code must not use ad
hoc path concatenation across host, guest, workspace, or runner paths.

The first implementation plan may defer broad VM filesystem artifact publication
as long as it keeps the artifact reference/read schemas and result fields
path-free. If a slice returns artifact references, it must also implement the
readback authorization and proof obligations for those references. If a slice
does not return artifact references, artifact publication tests are out of scope
for that slice.

## Security Context

Assets:

- upstream MCP credentials;
- portal access tokens;
- approval signing keys and approval tokens;
- SSH private keys for OpenClaw Sandbox SSH leases;
- runner credential material;
- controller-owned durable credential state;
- host-only action credentials;
- VM filesystem artifacts;
- stdout/stderr logs;
- workspace files;
- controller runtime and execution records.

Untrusted inputs:

- model tool arguments;
- MCP client requests;
- CLI argv and stdin JSON;
- SDK request objects;
- provider outputs;
- artifact names;
- file paths supplied by agents;
- repo and branch names;
- capability arguments for credentialed actions.

Trust boundaries:

```text
agent/model
  -> call surface adapter
  -> in-process core entrypoint
  -> backend adapter
  -> provider / sandbox / runner / controller action
```

Must-not rules:

- do not give agents upstream MCP credentials;
- do not expose SSH private keys through portal catalog or result surfaces;
- do not expose secrets or hidden backend fields through errors, progress
  events, stdout/stderr summaries, truncation metadata, artifact references, or
  suggested next actions;
- do not let model values become shell text for credentialed execution;
- do not let model values choose executable, argv, cwd, env, VM profile, egress,
  or host path for credentialed execution;
- do not expose backend names as model-selected tools;
- do not mount durable credential state into OpenClaw Sandbox SSH lease;
- do not build a generic host subprocess portal;
- do not make approval tokens model-visible;
- do not write portal tokens or credential files into repositories;
- do not turn the controller into a generic OpenClaw Sandbox command/file proxy;
- do not bypass MCP Portal policy/redaction when composing MCP-backed
  capabilities.

Security non-goals:

- A local code agent authorized to call a portal may exfiltrate its own portal
  access token. The goal is scoped, revocable capability access, not perfect
  containment of an already-authorized local agent.
- Portal redaction is not general PII minimization.
- Trusted deployment config remains trusted. Less-trusted provider onboarding
  requires a separate design.

## Alternatives Considered

### Put Everything In MCP Portal

Rejected.

MCP Portal has the right portal method: trusted identity, scoped catalog,
Zod-backed schema validation, approval, redaction, and structured results. That
method should be reused. The MCP Portal package should not become the owner of
SSH sandbox leases, credentialed runner execution, or host actions.

### Let The Model Choose Backend Tools

Rejected.

Backend names such as `ssh-sandbox`, MCP transport, strict exec/fs, and host
action routing are operational choices. Exposing them as model-selected tools
would make security depend on agent behavior instead of trusted config.

### Keep Reusable Credentialed Runner In The Main Design

Rejected for this design.

Reusable controller-owned runners may be useful for performance or complex
credential caches, but they increase custody, recovery, and isolation risk. This
spec defines credentialed runner as ephemeral and one-shot. A reusable
high-trust credentialed runner requires a separate design.

### Treat Sandbox And Credentialed Runner As One Backend

Rejected.

OpenClaw Sandbox SSH lease and ephemeral credentialed runner have different
owners. The sandbox path is agent/runtime-controlled over SSH. The credentialed
runner path is controller-controlled over strict ManagedVm exec/fs. Collapsing
them would produce the wrong security model.

### Share Whole Config Documents

Rejected.

Whole-document inheritance blurs ownership. MCP provider config, MCP Portal
policy, Tool Portal dispatch, credential custody, and controller actions have
different reasons to change. Shared policy primitives are appropriate; hidden
profile inheritance is not.

## Design Decisions

1. Use `in-process core entrypoint` for the portable local API concept.
2. Treat OpenClaw native tools, MCP proxy, CLI, API, and SDK wrappers as runtime
   adapters.
3. Keep dispatch intent catalog-static and trusted-config-owned.
4. Define OpenClaw Sandbox SSH lease as the current named Tool VM SSH backend
   where the agent runtime/plugin owns execution.
5. Define credentialed runner as an ephemeral, controller-owned, one-shot
   execution backend over strict ManagedVm exec/fs.
6. Keep MCP Portal as the MCP provider backend and do not absorb VM/controller
   execution into MCP Portal.
7. Introduce Agent Portal SDK/base Zod v4 contracts only for portal-neutral
   identity, catalog, operation, result, event, and approval primitives.
8. Keep OpenClaw-specific registration, hooks, approval prompts, workspace, and
   filesystem bridge behavior in OpenClaw adapters.
9. Re-authorize controller-owned backends at the controller before credentials
   or host authority are used.
10. Keep reusable high-trust credentialed runners out of this design.
11. Tool Portal exposes the same four operation vocabulary as MCP Portal:
    list, search, describe, and call. The portable public contract is batched for
    all four operations.
12. Narrow host actions are first-class Tool Portal capabilities when exposed to
    agents, not private controller APIs hidden behind selected adapters.
13. Controller-owned backends are controller-authoritative. Gateway-local
    in-process entrypoints may build dispatch intent, but the controller
    recomputes final execution authority.
14. Zod v4 schemas are the source of truth for contracts. JSON Schema is
    generated from Zod only for schema-advertising surfaces.
15. CLI-like capabilities require explicit CLI allowance contracts with Zod v4
    input schemas, argv normalization, argv validation, and deny rules before
    execution.
16. Code layers follow the separation-of-concerns table: each layer owns one
    reason to change, and vertical slices cross layers only through Zod v4
    contracts.
17. New portal files use descriptive multi-word names. Slice-local `models` or
    similar subfolders are allowed; package-wide bucket folders and single-word
    files are not.
18. Tool Portal mode and standalone MCP Portal mode are exclusive per
    agent/profile for the same model-visible capability. Tool Portal mode may
    compose MCP Portal only through the MCP provider backend adapter.
19. `tool-portal.config.jsonc` is the only user-authored policy for Tool
    Portal-exposed capabilities. MCP Portal policy under Tool Portal is an
    effective projection, not a second config authority.
20. Controller RPC schemas live in `@agent-vm/controller-execution-contracts`;
    Tool Portal consumes them but does not own controller execution authority.
21. Agent-facing CLI/SDK/API wrappers are separate trust classes from operator
    CLIs that load config and resolve secrets.
22. Artifact references and readback are opaque, path-free Zod contracts. Broad
    VM filesystem artifact publication is deferred until no-follow typed path
    proof exists.

## Open Design Questions

1. What is the final noun for the one-shot credentialed runner lifecycle record:
   `run record`, `invocation record`, or another non-lease term?

## Planning Handoff

The package boundaries, trust boundaries, public contract families, and
deployment-mode exclusivity rules are normative for any implementation plan. The
target file tree is the intended end-state structure, not a requirement that one
implementation slice create every file before useful proof exists.

Must preserve in the first plan:

- batched list/search/describe/call public contracts;
- Zod v4 as the contract source of truth;
- model-visible result schemas for all four operations;
- Tool Portal mode as a single policy authority;
- MCP Portal composition through the MCP provider backend adapter;
- controller RPC schemas outside Tool Portal in
  `@agent-vm/controller-execution-contracts`;
- agent-facing adapter auth separated from operator/admin CLI auth;
- CLI allowance policy fields represented in parsed Zod contracts;
- performant TDD pyramid gates, with unit tests for contracts and decision logic
  before broader integration/e2e proof.

May stage across later slices:

- Python SDK;
- HTTP API adapter;
- external stdio/Streamable HTTP Tool Portal MCP server;
- broad VM filesystem artifact publication;
- additional promoted typed tools;
- e2e coverage for runtimes that are not touched by the implemented slice.

Plans must state which end-state files are created in the slice and which are
intentionally deferred. Deferral is acceptable only when the active slice still
preserves the public contract and authority boundaries it exposes.

## Validation Obligations

This is not an implementation plan, but the design imposes proof obligations on
any implementation:

- Zod v4 validation must reject model-supplied backend/control fields;
- every contract named in this spec must have an explicit Zod v4 schema;
- every public contract and RPC boundary must have an explicit Zod v4 schema;
- schema-advertising surfaces must generate JSON Schema from the Zod v4
  contract, not maintain a separate hand-written schema;
- inbound payloads must be parsed at each trust boundary before forwarding;
- list/search/describe/call request and result schemas must be unit-tested,
  including batch item ids, duplicate/reserved ids, item-level errors,
  diagnostics, truncation, audit correlation, and approval-required results;
- dependency checks must prove the forbidden dependency directions remain
  absent and that vertical slices cross layers through Zod v4 contracts instead
  of ad hoc objects;
- structure checks or review gates must reject new single-word portal files and
  package-wide bucket folders for new portal work;
- the architecture/structure proof must be a unit-style audit command included
  in `pnpm check`, either by extending `pnpm test:taxonomy` or by adding a
  dedicated `pnpm test:portal-architecture` gate backed by a repo script;
- proof plans must preserve the performant TDD pyramid: cheap unit tests for
  contracts and decisions, bounded integration for real module/protocol
  boundaries, and narrow e2e only for production-shaped runtime proof;
- unit tests should keep process-local contract/parser/validator/policy coverage
  in the repo's fast lane, targeting p95 under 25ms where practical;
- integration tests should use fake MCP providers, fake controller dispatch, and
  fake ManagedVm edges unless the real boundary is the behavior under test,
  targeting p95 under 250ms where practical;
- e2e tests must be narrow proof gates for CLI wrappers, real controller route
  wiring, real ManagedVm lifecycle, or OpenClaw adapter behavior. Do not use e2e
  as the primary proof for Zod schemas, argv validators, policy evaluators, or
  redactors;
- generated model-visible schemas, results, errors, diagnostics, progress
  events, truncation metadata, and artifact references must not leak hidden
  backend fields;
- list/search/describe/call behavior must be equivalent across OpenClaw native,
  MCP proxy, CLI, API, and SDK adapters for the same trusted scope;
- managed OpenClaw MCP Portal mode must remain in-process and must not require
  the external MCP proxy;
- OpenClaw Sandbox SSH lease tests must preserve controller lifecycle ownership
  and plugin SSH data-path ownership;
- ephemeral credentialed runner VM specs must expose no SSH, no ingress, no
  unintended `tcpHosts`, and only declared egress;
- credentialed runner execution must use fixed absolute executable selection,
  array-form `ManagedVm.exec`, trusted argv construction, stdout/stderr
  draining, byte caps, cancellation, cleanup, and exact secret redaction;
- CLI allowance tests must prove Zod v4 input parsing, argv normalization, argv
  validation, deny-rule enforcement, approval posture, and rejection of
  shell-like tokens before execution;
- credentialed runner execution tests must reject string-form exec, shell
  command strings, PTY requests, model-supplied executable/cwd/env, and shell
  launchers unless the launcher is the catalog-owned executable being modeled;
- controller-owned backend tests must prove the controller recomputes and
  re-authorizes backend binding, executable template, argv, custody, egress, VM
  profile, and output/artifact policy instead of trusting gateway dispatch
  intent;
- approval tests must bind approval to trusted identity, capability identity,
  canonical arguments, execution fingerprint, policy/catalog revision,
  artifact intent, and replay/expiration semantics;
- artifact reference/readback tests must prove opaque path-free handles, caller
  scoping, expiry, byte caps, audit correlation, and hidden metadata redaction;
- VM filesystem artifact publication tests are required only for slices that
  publish VM file artifacts, and must then prove typed runtime path mapping,
  traversal rejection, symlink/no-follow behavior, caller scoping, and hidden
  metadata redaction;
- host actions must prove they are typed controller operations, not generic host
  subprocess execution.
