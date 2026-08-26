# Tool Portal Namespace Discovery Summary Requirements

## Purpose

Agent VM already accepts `mcp.config.jsonc.providers.*.discovery.summary` as the
concise description of an MCP namespace. The value participates in semantic
freshness, but the managed Hermes orientation currently renders only namespace
name and `available | unavailable` status. Non-MCP Tool Portal namespaces have
no equivalent summary field.

The required improvement is to make the existing MCP discovery summary
model-visible and extend the same `discovery.summary` vocabulary to non-MCP Tool
Portal namespaces. The feature reuses the current Hermes session-once
orientation and ordinary Tool Portal discovery; it does not create a second
guidance or instruction system.

## Decision authority and source

The deployment owner confirmed on 2026-08-22 that:

- namespace identity and `discovery.summary` are the canonical discovery
  vocabulary;
- `discovery` contains only optional `summary` in this slice;
- existing MCP provider summaries must be injected rather than re-authored;
- Tool Portal must provide the same summary capability for
  `controller_execution` and `tool_vm_runner` namespaces;
- `safeHelp` remains required per configured CLI operation and is supplied
  through capability discovery rather than prompt injection.

Current configuration schemas, the `shravan-claw` deployment, Tool Portal
contracts, and the Hermes orientation renderer are observational evidence for
the existing foundation and missing projection.

## Consumers

- A managed Hermes agent needs a concise explanation beside each admitted
  namespace name and availability status.
- A Tool Portal caller needs the same effective namespace summary through
  ordinary list, search, and describe discovery.
- An MCP deployment operator needs the existing provider summary to remain the
  sole authored source for MCP-backed namespaces.
- A Tool Portal operator needs an equivalent summary field for non-MCP backend
  namespaces.

## Authorized needs

| ID | Affected class | Priority | Authorized need | Evidence and authority |
| --- | --- | --- | --- | --- |
| U1 | Hermes agent | Must | Receive each displayed admitted namespace's effective `discovery.summary` beside its name and availability in the existing session-once orientation. | Owner-authorized, 2026-08-22 |
| U2 | MCP operator | Must | Continue authoring an MCP-backed namespace summary exactly once at `mcp.config.jsonc.providers.*.discovery.summary`. | Owner-authorized, 2026-08-22 |
| U3 | Tool Portal operator | Must | Author the same optional `discovery.summary` shape for `controller_execution` and `tool_vm_runner` namespaces. | Owner-authorized, 2026-08-22 |
| U4 | Tool Portal caller | Must | Receive effective namespace discovery metadata through list, search, and describe without duplicating it into every tool. | Owner-authorized extension, 2026-08-22 |
| U5 | Agent and operator | Must | Preserve exact profile/surface isolation, availability truth, deterministic ordering, prompt-cache behavior, and bounded orientation rendering. | Existing Hermes orientation contract retained by owner |
| U6 | Capability owner | Must | Keep `safeHelp`, upstream tool descriptions/schemas, visibility, call admission, approval, and backend dispatch behavior unchanged. | Existing Tool Portal contract retained by owner |
| U7 | Deployment operator | Must | Receive deterministic schema and validation feedback for absent, valid, empty, over-bound, duplicated-source, and backend-inapplicable summary configuration. | Owner-authorized operability need |

All priorities are assigned by the deployment owner.

## Desired observable journey

```text
MCP operator (U2)
  -> authors provider namespace + discovery.summary once in mcp.config.jsonc
  -> Tool Portal materializes that summary for each admitted MCP namespace

Tool Portal operator (U3)
  -> authors discovery.summary on a non-MCP namespace policy
  -> Tool Portal materializes the same effective discovery shape

Hermes agent (U1, U5)
  -> receives name + availability + optional summary once per session identity

Tool Portal caller (U4)
  -> receives the same effective summary through list, search, or describe
```

## Goal boundary

The change may extend:

- the existing MCP provider discovery-summary bound;
- non-MCP Tool Portal namespace configuration;
- effective/Gateway Runtime namespace discovery projections;
- portal-neutral list, search, and describe results;
- the existing Hermes managed Tool Portal projection, inventory, and renderer;
- generated schema, manuals, and configuration reference material.

The change must preserve:

- `mcp.config.jsonc` as the sole summary owner for MCP-backed namespaces;
- complete, non-inheriting Tool Portal profiles and active-surface filtering;
- existing Hermes startup inventory and session-once `pre_llm_call` injection;
- per-tool `safeHelp`, descriptions, schemas, and search behavior;
- Tool Portal visibility, call policy, approval, and backend dispatch;
- all controller-execution and leased Tool VM boundaries.

## Acceptable complexity

One bounded `discovery.summary` string shape, one effective namespace-discovery
projection, and extensions to existing discovery/orientation results are
acceptable. A new prompt pipeline, provider override/merge rule, summary
database, inheritance system, templating language, refresh protocol, or
framework-generic instruction engine is not.

## Non-goals

- Adding `guidance`, `instructions`, descriptions, schemas, policy, or arbitrary
  metadata beneath `discovery`.
- Re-authoring or overriding an MCP provider summary in
  `tool-portal.config.jsonc`.
- Injecting `safeHelp` or every individual tool description into Hermes
  orientation.
- Searching or ranking tools by namespace summary text.
- Changing standalone MCP Portal's legacy OpenClaw prompt-context hook.
- Letting discovery metadata grant visibility, call authority, approval, or
  execution permission.
- Adding OpenClaw or Worker prompt injection.

## Success evidence

Evidence must distinguish authored configuration, effective projection,
portable discovery, and real Hermes model input. It must show single-source MCP
summary ownership, non-MCP Tool Portal authoring, exact profile isolation,
bounded deterministic rendering, summary presence in one real Hermes model
request, absence on the later same-session request, and unchanged tool/call
authority and per-tool description behavior.

## Unresolved decisions

None. `discovery` contains only optional `summary`; MCP-backed summaries come
from `mcp.config.jsonc`, non-MCP summaries come from the Tool Portal namespace,
and both become one effective namespace-discovery value.
