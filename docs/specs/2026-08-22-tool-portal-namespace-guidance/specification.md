# Tool Portal Namespace Discovery Summary Specification

Requirements authority: [`requirements.md`](requirements.md)

## Observable model

```text
MCP-backed namespace
  -> mcp.config provider namespace + discovery.summary
  -> effective Tool Portal namespace discovery

controller_execution | tool_vm_runner namespace
  -> tool-portal profile namespace key + discovery.summary
  -> effective Tool Portal namespace discovery

effective namespace discovery
  -> Tool Portal list | search | describe
  -> Hermes name + availability + optional summary orientation

negative space
  -> no guidance/instructions field, no duplicated MCP summary,
     no permission or dispatch effect, no per-tool prompt injection
```

## P1 — Current observable gap

`mcp.config.jsonc` already accepts `{ discovery: { summary? } }` for every MCP
provider. The normalized semantic revision retains that field, but the managed
provider runtime and Hermes orientation do not project its text. Hermes renders
only admitted namespace names and availability. Tool Portal namespace policy
contains only `backend`, `tools`, and `calls`, so non-MCP namespaces cannot
declare an equivalent summary.

## O1 — Desired observable outcome

Every admitted Tool Portal namespace has one effective optional discovery
summary. MCP-backed namespaces reuse their provider summary; non-MCP namespaces
may author the same summary shape. Tool Portal discovery and the existing Hermes
session-once orientation expose the effective value without changing authority.

## R1 — Discovery contains only a bounded optional summary

The shared discovery shape MUST be exactly:

```ts
const NamespaceDiscoverySchema = z
  .object({
    summary: z.string().min(1).max(500).optional(),
  })
  .strict()
```

`mcpProviderSchema.discovery` MUST continue to default to `{}` and MUST use this
bound. Empty, over-bound, structured, or unknown discovery fields MUST fail
configuration validation.

`discovery.summary` is concise model-visible namespace information. It is not a
tool description, schema, instruction document, policy object, secret/file
reference, template, URL, or authority claim.

Trace: U2, U3, U7.

## R2 — MCP-backed summaries have one authored owner

For an effective Tool Portal namespace whose backend kind is `mcp_provider`,
the summary MUST resolve from the unique active MCP provider whose authored
`namespace` equals the Tool Portal namespace key.

An MCP-backed Tool Portal namespace MUST reject an authored `discovery` field.
It MUST NOT override, merge, or duplicate the provider summary. If the matched
provider omits its summary, the effective namespace summary is absent.

Missing or ambiguous provider-to-namespace resolution MUST retain the existing
configuration/preflight failure and MUST NOT select a summary by provider record
order.

Trace: U2, U5, U7.

## R3 — Non-MCP Tool Portal namespaces may author discovery summary

For `controller_execution` and `tool_vm_runner`, the Tool Portal namespace
policy MUST accept optional `discovery: NamespaceDiscoverySchema.default({})`
beside `backend`, `tools`, and `calls`.

The namespace identity remains the key in
`profiles.<profile>.namespaces`; Tool Portal MUST NOT add a duplicate nested
`namespace` field. Omission produces an effective namespace discovery value
with no summary.

The authored managed, effective, Gateway Runtime, and generated Tool Portal
schemas MUST preserve the same field and bound. This specification does not
make privileged backends available in standalone Tool Portal.

Trace: U3, U5, U7.

## R4 — Effective namespace discovery is profile and surface scoped

Tool Portal MUST derive one immutable effective discovery entry for each
namespace admitted by the selected complete profile and active surface:

```ts
const EffectiveNamespaceDiscoverySchema = z
  .object({
    namespace: NamespaceNameSchema,
    summary: z.string().min(1).max(500).optional(),
  })
  .strict()
```

Entries MUST be unique by namespace and sorted with the existing deterministic
namespace ordering. The caller MUST NOT supply or override namespace discovery
metadata. Adding, changing, or removing a summary MUST change the applicable
catalog/profile semantic revision.

Raw summary text MUST NOT enter call requests, approval presentation, direct or
approval fingerprint payloads, backend arguments, provider transport, controller
execution requests, or Tool VM SSH operations. Existing opaque semantic
revisions may stale older authority after metadata changes.

Trace: U2-U7.

## R5 — Portal discovery returns effective namespace discovery

Successful list, search, and describe item values MUST contain a required
`namespaceDiscovery` array of effective entries:

- list returns entries for namespaces in that item's filtered `namespaces`;
- search returns entries for namespaces represented by returned tool matches;
- describe returns entries for namespaces represented by returned descriptors.

The array MUST contain exactly one entry for every represented namespace,
including `{ namespace }` when its summary is absent. It MUST contain at most
one entry per namespace and use deterministic namespace ordering. Existing tool
summaries/descriptors, ordering, filtering, pagination, diagnostics, partial
failure, and aggregate status remain unchanged.

Namespace discovery MUST remain separate from `CapabilitySummary`,
`CapabilitySearchMatch`, and `CapabilityDescriptor`. `PortalCallResult` MUST NOT
add namespace discovery metadata. Search MUST NOT index or rank by summary text
in this slice.

Trace: U4-U6.

## R6 — Hermes orientation renders name, availability, and summary

The existing managed Hermes startup inventory MUST receive the complete sorted
effective namespace-discovery projection for each admitted profile. Inventory
availability probes and authority semantics remain unchanged.

For every displayed namespace, the deterministic orientation MUST render:

```text
- <canonical namespace>: available | unavailable
  summary: <canonical JSON summary string, when present>
```

The summary line is omitted when absent. The renderer MUST encode the complete
summary with the shared canonical JSON string encoder so LF, CR, quotes,
backslashes, control characters, and supplementary Unicode remain one
deterministic escaped line. The complete orientation retains the existing
maximum of 20 displayed namespaces, 2,000 UTF-8 bytes, LF separators, and no
trailing newline. The renderer MUST choose the greatest sorted prefix of
complete namespace entries that fits; it MUST never truncate a summary or emit
a namespace without its complete available summary. Omitted-count behavior and
the list/search/describe/call workflow remain unchanged.

The injection identity, nonblocking observation, atomic session-once mark,
prompt-cache preservation, failure behavior, and no-Portal-I/O session path
remain exactly as defined by the existing Hermes orientation contract.

Trace: U1, U5, U6.

## R7 — Discovery metadata never changes call authority

Under a fresh active policy, summary presence or text MUST NOT change tool
visibility, call admission, direct/approval classification, approval display,
backend selection, arguments, execution, or result behavior.

`safeHelp` remains required for each `configured_cli` and continues to project
as that operation's capability description through Tool Portal discovery. MCP
tool descriptions and schemas remain upstream-owned. Neither is injected into
the namespace orientation.

Trace: U5, U6.

## R8 — Failures preserve existing availability truth

Invalid authored discovery metadata MUST fail static validation. Missing
optional summaries MUST NOT fail startup, discovery, or orientation.

Provider discovery/probe failure retains the existing namespace-unavailable
classification and orientation behavior. A configured summary MAY still explain
an unavailable namespace, but MUST NOT relabel it available. Partial backend
discovery failures retain existing item-level error and diagnostic behavior and
MUST NOT surface unrelated namespace metadata.

Trace: U1, U4, U5, U7.

## Observable contracts

### C1 — MCP provider configuration

An MCP provider may omit `discovery.summary` or author one non-empty string no
longer than 500 characters. Its public namespace remains the provider's explicit
`namespace` field, independent of the provider record key.

### C2 — Non-MCP Tool Portal configuration

A `controller_execution` or `tool_vm_runner` namespace may omit
`discovery.summary` or author the same bounded shape. Its namespace identity
remains the `namespaces` record key.

### C3 — Tool Portal discovery

Each successful list, search, or describe item returns effective summaries only
for represented namespaces in the caller's selected profile and surface.

### C4 — Hermes model context

The one orientation-bearing model request for a session identity contains each
displayed namespace's name, availability, and complete optional summary. Later
requests for the same identity contain no new orientation block.

## Compatibility and cutover

This is a synchronized hard cut across MCP discovery bounds, Tool Portal
configuration/projections, portable discovery results, managed-agent projection,
and Hermes adapter models/rendering. All in-repository producers, consumers,
generated schemas, fixtures, and Python/TypeScript contracts MUST move together.
There is no `guidance`/`instructions` alias and no dual result parser.

Existing MCP summaries shorter than the new bound remain valid. Existing Tool
Portal configurations remain valid because non-MCP `discovery` is optional and
MCP-backed Tool Portal namespaces continue to source metadata from
`mcp.config.jsonc`.

## Proof obligations

| ID | Observable obligation | Evidence class |
| --- | --- | --- |
| V1 | MCP and Tool Portal authored/effective/generated schemas accept omission and valid summary while rejecting empty, over-bound, unknown, duplicated-source, and backend-inapplicable variants. | Automated schema behavior and generated-schema inspection |
| V2 | Provider-id and namespace remain distinct; a unique MCP provider summary resolves to the matching effective Tool Portal namespace, while missing/ambiguous matches fail or omit exactly as specified. | Config materialization integration |
| V3 | Distinct profiles and surfaces return only their admitted effective namespace discovery without cross-agent/profile leakage. | Tool Portal service integration |
| V4 | List, search, and describe return sorted represented namespace discovery while preserving tool metadata, ordering, filtering, pagination, diagnostics, and partial failure. | Portable-contract and service integration behavior |
| V5 | MCP-provider, controller-execution, and Tool-VM-runner namespaces produce the same effective discovery shape from their single authored source. | Cross-backend integration |
| V6 | A unique raw-summary marker is absent from call/approval/fingerprint/backend/controller/SSH payloads while only common semantic revisions reflect the metadata change. | Boundary payload inspection and integration spies |
| V7 | Hermes rendering covers summary present/absent, available/unavailable, LF, CR, quotes, backslashes, control characters, supplementary Unicode, deterministic canonical encoding and ordering, complete-entry truncation, omitted counts, and the 20-name/2,000-byte limits. | Deterministic renderer behavior |
| V8 | One real Hermes model request contains the configured MCP and non-MCP summaries with correct availability; a later same-session request contains no orientation; system prompt and tool definitions remain unchanged. | Real Hermes VM end-to-end transcript and model-request inspection |
| V9 | Fresh calls retain identical visibility, direct/approval classification, backend effects, and per-tool descriptions before and after a summary-only change. | Call-policy and backend regression integration |

Requirement coverage:

| Requirements | Problem | Outcome | Contracts | Proof |
| --- | --- | --- | --- | --- |
| U1 | P1 | O1 | R4, R6, R8, C4 | V3, V7, V8 |
| U2 | P1 | O1 | R1-R2, R4, C1 | V1-V2, V5 |
| U3 | P1 | O1 | R1, R3-R4, C2 | V1, V3, V5 |
| U4 | P1 | O1 | R4-R5, R8, C3 | V3-V5 |
| U5 | P1 | O1 | R4, R6, R8, C3-C4 | V3-V4, V7-V8 |
| U6 | P1 | O1 | R5-R7 | V4, V6, V9 |
| U7 | P1 | O1 | R1-R3, R8, C1-C2 | V1-V2 |

## Undefined behavior and negative space

- Summary wording and factual accuracy are operator-owned.
- Summary text is not searched, ranked, interpreted, or acknowledged by Tool
  Portal or Hermes.
- A summary does not promise upstream provider or CLI compatibility.
- Discovery metadata creates no prompt-delivery transaction, refresh, polling,
  persistence, or cross-epoch behavior.
