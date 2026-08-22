# Tool Portal Namespace Guidance Requirements

## Purpose

Tool Portal can describe individual capabilities, and a configured controller
CLI can provide per-operation `safeHelp`, but an operator cannot explain the
shared usage conventions of a namespace once for every capability in that
namespace. Agents therefore receive exact tool schemas without the small domain
map needed to use those tools coherently.

The required improvement is one optional, backend-neutral namespace guidance
field that is visible through normal Tool Portal discovery. It complements
per-tool descriptions; it does not replace them or create another instruction
injection system.

## Decision authority and source

The deployment owner authorized this requirement on 2026-08-22: Tool Portal
must allow general namespace-level guidance in the same cross-backend policy
surface used by MCP-provider, controller-execution, and Tool-VM-runner
namespaces. The current source tree is observational evidence for the missing
field and the existing discovery/result boundaries.

## Consumers

- Managed and standalone Tool Portal agents need shared namespace conventions
  before choosing or calling an individual capability.
- Deployment operators need to author those conventions once per complete
  profile namespace instead of repeating them in every tool description.
- Backend owners need namespace guidance to remain independent of backend kind
  and incapable of changing visibility, call admission, approval, or dispatch.

## Authorized needs

| ID | Affected class | Priority | Authorized need | Evidence and authority |
| --- | --- | --- | --- | --- |
| U1 | Tool Portal agent | Must | Discover concise namespace-level usage guidance through the ordinary list, search, and describe journey. | Owner-authorized, 2026-08-22 |
| U2 | Deployment operator | Must | Author guidance once on a namespace in a complete Tool Portal profile and reuse it for every backend kind in managed or standalone Tool Portal. | Owner-authorized, 2026-08-22 |
| U3 | Tool Portal agent | Must | See guidance only for namespaces admitted by the agent's selected profile and active surface. | Existing profile-scoped discovery boundary plus owner-authorized extension |
| U4 | Capability owner | Must | Keep per-tool descriptions, schemas, `safeHelp`, call policy, and approval semantics unchanged; namespace guidance adds context but no authority. | Existing Tool Portal contract and owner boundary |
| U5 | Deployment operator | Must | Receive deterministic validation and generated-schema feedback for absent, valid, empty, and over-bound guidance. | Owner-authorized operability need |
| U6 | Managed Gateway operator | Must | Preserve the existing Hermes session-once orientation and prompt-cache behavior; namespace guidance is fetched through Tool Portal discovery rather than injected into prompts. | Existing Hermes orientation contract and owner boundary |

All priorities are assigned by the deployment owner.

## Desired observable journey

```text
operator (U2, U5) authors one namespace guide in tool-portal.config.jsonc
  -> config validation accepts and projects it for the selected profile
  -> agent (U1, U3) lists, searches, or describes profile-visible capabilities
  -> discovery result returns the applicable namespace guide once
  -> agent uses the guide together with exact per-tool descriptions and schemas
```

For a Things-like namespace, guidance can explain that `argv` is a JSON token
array, that callers omit the executable name, which command prefixes exist, and
which status operations are unavailable. Individual configured operations still
own their exact `safeHelp`, input schema, and examples.

## Goal boundary

The change may extend:

- the shared managed/standalone Tool Portal namespace configuration contract;
- profile-scoped effective and Gateway Runtime projections;
- portal-neutral list, search, and describe results;
- generated JSON Schema, manuals, and configuration reference material.

The change must preserve:

- complete non-inheriting Tool Portal profiles;
- existing tool visibility and call selectors;
- all backend bindings and dispatch behavior;
- per-tool descriptions, schemas, annotations, and `safeHelp`;
- Hermes's current bounded availability orientation and cache-safe injection;
- standalone MCP Portal as a separate product and policy authority.

## Acceptable complexity

One optional bounded string on a Tool Portal namespace and one portable
namespace-guidance result shape are acceptable. A new prompt pipeline, guidance
database, inheritance system, templating language, dynamic refresh protocol, or
backend-specific guidance variant is not.

## Non-goals

- Injecting authored guidance into the system prompt or every user turn.
- Searching or ranking tools by guidance text.
- Replacing individual tool descriptions, schemas, examples, or `safeHelp`.
- Letting guidance grant visibility, direct-call authority, approval, or
  execution permission.
- Adding guidance to standalone MCP Portal configuration in this slice.
- Guidance inheritance or merging across profiles or namespaces.
- Secret references, variable interpolation, attachments, rich text, or remote
  guidance URLs.

## Success evidence

Evidence must distinguish configuration acceptance from model-visible runtime
behavior. It must show schema/editor support, exact profile isolation, stable
portable list/search/describe results across backend kinds, unchanged call
classification under fresh policy, absence of raw guidance from authority
payloads, correct common-revision freshness, unchanged per-tool contracts, and
unchanged Hermes prompt-orientation behavior.

## Unresolved decisions

None. Guidance is optional, bounded plain text, profile-and-namespace scoped,
backend-neutral, discovery-visible, and non-authoritative.
