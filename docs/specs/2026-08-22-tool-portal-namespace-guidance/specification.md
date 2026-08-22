# Tool Portal Namespace Guidance Specification

Requirements authority: [`requirements.md`](requirements.md)

## Observable model

```text
deployment operator
  -> authors optional guidance on one Tool Portal profile namespace
  -> validates the complete profile

Tool Portal agent
  -> list | search | describe
  -> receives authorized tools plus applicable namespace guidance
  -> uses per-tool descriptions and schemas for the exact call

negative space
  -> guidance does not alter visibility, admission, approval, or dispatch
  -> guidance is not injected into the system prompt or user message
```

## P1 — Current observable gap

`tool-portal.config.jsonc` namespaces currently contain only `backend`, `tools`,
and `calls`. Portal discovery returns capability summaries or descriptors but no
operator-authored namespace context. `configured_cli.safeHelp` can explain one
operation only. Repeating shared conventions in every operation is verbose and
can drift; omitting them leaves an agent to reconstruct namespace conventions
from individual schemas.

## O1 — Desired observable outcome

An operator can attach one bounded plain-text guide to a Tool Portal namespace.
Every authorized Tool Portal discovery path returns that guide once per
applicable namespace alongside, but separate from, tool-level metadata.

## R1 — Namespace configuration admits optional guidance

The common Tool Portal namespace policy used by managed and standalone modes
MUST accept exactly one optional `guidance` field:

```ts
const ToolPortalNamespacePolicySchema = z
  .object({
    backend: ToolPortalBackendBindingSchema,
    calls: ToolPortalCallPolicySchema,
    guidance: z.string().min(1).max(4_000).optional(),
    tools: ToolPortalToolSelectorSchema,
  })
  .strict()
```

The field is plain model-visible text. It MUST NOT accept a secret reference,
file reference, template, variable interpolation, URL fetch, backend-specific
variant, or structured authority claim. Omission means the namespace has no
authored guidance. Empty or over-bound values MUST fail configuration
validation.

The same field and bound MUST appear in authored, effective, managed Gateway
Runtime, and standalone Tool Portal configuration schemas. Generated
`tool-portal.schema.json` MUST expose the field and bound.

Trace: U2, U4, U5.

## R2 — Guidance is profile scoped and backend neutral

Guidance MUST belong to the namespace entry inside one complete Tool Portal
profile. It MUST NOT inherit or merge from another profile or namespace.

For a trusted invocation, Tool Portal MUST derive guidance from the same
selected profile and active surface eligibility used to derive the scoped
catalog. A caller MUST NOT supply a profile id, guidance value, or visibility
override in a list, search, describe, or call request.

The contract MUST behave identically for `mcp_provider`,
`controller_execution`, and `tool_vm_runner` namespaces when those backend kinds
are otherwise available in the selected Tool Portal mode. Guidance MUST NOT be
copied into backend-specific provider configuration or interpreted by a
backend.

Trace: U2, U3, U4.

## R3 — Portable discovery results carry namespace guidance

The portal-neutral SDK MUST define one strict result value:

```ts
const NamespaceGuidanceSchema = z
  .object({
    guidance: z.string().min(1).max(4_000),
    namespace: NamespaceNameSchema,
  })
  .strict()
```

Successful list, search, and describe item values MUST each contain a required
`namespaceGuidance` array. The array MUST be empty when no applicable namespace
has authored guidance. It MUST contain at most one item per namespace and MUST
be sorted by namespace using the same deterministic namespace ordering as the
existing portal contracts.

The applicable namespace set is:

- for list: guided namespaces present in the successful item's returned
  `namespaces` value after request filtering;
- for search: guided namespaces represented by the successful item's returned
  tool matches after request filtering;
- for describe: guided namespaces represented by the successful item's returned
  descriptors after request filtering.

A partial backend result MUST NOT cause guidance for an unrelated or filtered
namespace to appear. An error item carries its existing error and diagnostics
and MUST NOT fabricate a successful guidance value.

`PortalCallResult` MUST NOT add namespace guidance. Call results remain about
the exact attempted capability and its outcome.

Trace: U1, U3, U4.

## R4 — Guidance remains separate from tool metadata

Namespace guidance MUST NOT be duplicated into each `CapabilitySummary`,
`CapabilitySearchMatch`, or `CapabilityDescriptor`. Existing tool descriptions,
titles, annotations, schema hints, input/output schemas, safety summaries,
related values, TypeScript helpers, and Zod artifacts remain unchanged.

Search MUST NOT index or rank by namespace guidance in this slice. Guidance is
returned as context for the namespaces already selected by ordinary list,
search, or describe behavior.

`configured_cli.safeHelp` remains the exact operation description projected
into that operation's capability summary. Namespace guidance may explain shared
calling conventions but cannot replace an operation's `safeHelp`.

Trace: U1, U4.

## R5 — Guidance changes semantic freshness but not permission meaning

Changing, adding, or removing guidance MUST change the profile/catalog semantic
revision observed by Gateway Runtime clients so stale discovery snapshots are
not presented as current. It MUST NOT change which tools are visible or whether
a call is denied, direct, or approval-required. Existing direct and approval
fingerprints that already bind common semantic revisions MAY therefore become
stale after a guidance change; this is freshness invalidation, not new call
authority.

Raw guidance text MUST NOT enter controller execution requests, approval
presentation arguments, direct or approval fingerprint payloads, backend call
arguments, provider requests, or Tool VM SSH operations. Only the existing
opaque common semantic revisions may reflect that the active catalog changed.

Trace: U3, U4.

## R6 — Existing framework orientation remains unchanged

Hermes's session-once Tool Portal orientation MUST continue to expose bounded
namespace availability and the list/search/describe/call journey without
embedding authored namespace guidance. Authored guidance is obtained only by a
Tool Portal discovery result.

No managed framework adapter may mutate its system prompt, tool schemas, or
user message solely to surface namespace guidance. Framework-specific prompt
presentation is outside this specification.

Trace: U6.

## R7 — Failure behavior is deterministic and non-authoritative

Invalid authored guidance MUST fail static configuration validation. A missing
optional guide MUST NOT fail startup or discovery. If an otherwise successful
discovery result has no applicable guidance, it MUST return
`namespaceGuidance: []`.

Backend discovery failures retain their existing item-level error, diagnostic,
partial-success, and aggregate-status behavior. Guidance projection MUST NOT
turn a backend failure into success, suppress an existing diagnostic, or broaden
the set of namespaces represented by a successful result.

Trace: U3, U4, U5.

## Observable contracts

### C1 — Authored configuration

An operator can omit guidance or author one non-empty string of at most 4,000
characters on any Tool Portal namespace. Unknown adjacent fields, empty strings,
and longer strings are rejected by the strict generated and runtime schemas.

### C2 — Agent discovery

Every successful list, search, or describe item contains a deterministic
`namespaceGuidance` array derived from the caller's active profile and the
namespaces represented by that item. An agent never receives guidance for a
namespace outside that result or outside its active profile/surface.

### C3 — Capability execution

Under the fresh active policy, adding or changing guidance alone does not change
whether an identical call is visible, admitted, approval-required, or
dispatchable. Authority derived from an older common semantic revision may fail
freshness checks. The call and result shapes remain unchanged.

## Compatibility and cutover

This is a synchronized hard cut of the portable Tool Portal result contracts.
All in-repository producers, consumers, generated JSON Schema artifacts, and
contract fixtures MUST move together. There is no dual result parser and no
legacy alias for namespace guidance. Existing authored configurations remain
valid because `guidance` is optional.

Standalone MCP Portal remains unchanged. This contract applies to Tool Portal
managed and standalone modes only.

## Proof obligations

| ID | Observable obligation | Evidence class |
| --- | --- | --- |
| V1 | Authored/effective/managed/standalone config and generated JSON Schema accept omission and valid guidance while rejecting empty, over-bound, structured, and unknown-field variants. | Automated schema behavior and generated-schema inspection |
| V2 | Managed and standalone profiles return only the selected profile's guidance for the active surface, with no cross-agent/profile leakage. | Service integration with two agents and distinct complete profiles |
| V3 | List returns sorted unique guidance for returned namespaces and preserves filtering, pagination fields, diagnostics, and partial failure. | Portable-contract and service integration behavior |
| V4 | Search and describe return guidance only for namespaces represented by their returned tools and preserve tool ordering and metadata. | Portable-contract and service integration behavior |
| V5 | MCP-provider, controller-execution, and Tool-VM-runner namespaces expose the same guidance contract without backend-specific interpretation. | Cross-backend Tool Portal integration |
| V6 | Capability summaries/descriptors and call requests/results remain free of duplicated guidance; search ranking is unchanged. | Contract/schema inspection and search regression behavior |
| V7 | A guidance-only policy change refreshes discovery revisions and stales prior common-revision authorities while leaving direct, denied, and approval-required classification unchanged under a fresh request. | Semantic-revision and call-policy integration evidence |
| V8 | Hermes orientation/system-prompt behavior remains byte-stable while an ordinary discovery call returns the authored guide. | Hermes integration or real runtime transcript plus prompt-byte inspection |
| V9 | A unique raw-guidance marker is absent from controller-execution requests, approval presentation payloads, direct/approval fingerprint inputs, backend/provider calls, and Tool VM SSH operations while the opaque common semantic revision alone reflects the catalog change. | Boundary payload/schema inspection and integration spies at every R5 authority/execution seam |

Requirement coverage:

| Requirements | Problem | Outcome | Contracts | Proof |
| --- | --- | --- | --- | --- |
| U1 | P1 | O1 | R3, R4, C2 | V3, V4, V6 |
| U2 | P1 | O1 | R1, R2, C1 | V1, V5 |
| U3 | P1 | O1 | R2, R3, R7, C2 | V2, V3, V4 |
| U4 | P1 | O1 | R4, R5, R7, C3 | V6, V7, V9 |
| U5 | P1 | O1 | R1, R7, C1 | V1 |
| U6 | P1 | O1 | R6, C3 | V8 |

## Undefined behavior and negative space

- Guidance wording, headings, and examples are operator-owned plain text.
- Tool Portal does not validate factual accuracy or completeness of authored
  guidance.
- Discovery callers decide whether and how to use returned guidance.
- Guidance is not a compatibility promise for an upstream CLI or MCP provider.
- Guidance does not create prompt-delivery, acknowledgement, refresh, or
  persistence semantics.
