# Hermes Tool Portal Orientation Requirements

## Purpose

Hermes exposes four Tool Portal operations, but the model is not told what the
Portal is or which profile-admitted namespaces are usable. The plugin must give
the model a compact orientation without injecting the capability catalog,
performing discovery in the user-call path, or changing the cacheable system
prompt.

## Consumers

- The Hermes agent needs a small, truthful map of the Tool Portal surface.
- The Gateway operator needs bounded startup discovery and no added latency on
  user turns.
- The Tool Portal capability owner needs the admitted profile to remain the
  authority boundary; orientation must not grant or imply additional access.

## Authorized needs

| ID | Priority | Need |
| --- | --- | --- |
| U1 | must | Tell Hermes what Tool Portal is, what its four operations do, and how to discover, describe, and call tools. |
| U2 | must | Show only bounded namespace availability, not tool schemas, tool descriptions, or the full catalog. |
| U3 | must | Derive availability once per admitted profile and Gateway epoch, out of band from session calls, and reuse it across sessions. |
| U4 | must | Inject the orientation at most once for each exact `(Gateway epoch, admitted profile identity, session_id)` identity. |
| U5 | must | If inventory is not ready, let the turn continue without waiting and preserve eligibility for a later turn. |
| U6 | must | Preserve prompt-cache stability by leaving the system prompt and tool-schema prefix unchanged. |
| U7 | must | Keep plugin state typed, process-local, Pydantic-v2 validated at consumer boundaries, and explicit about validity and eviction. |
| U8 | must | Bound inventory to one initial attempt plus at most two retries within one 60-second overall deadline, with redacted failure logging. |

## Desired journey

```text
Gateway startup
  -> start one background inventory per admitted profile
  -> cache the profile's ready or terminal inventory for this Gateway epoch

pre_llm_call(epoch, profile, session_id)
  -> read inventory state without waiting
  -> if unresolved or failed: return no orientation and do not mark the session
  -> if ready and session was already marked: return no orientation
  -> if ready and session was not marked: atomically mark it and return orientation
```

Returning the orientation from `pre_llm_call` is the injection event. The
plugin does not prove or track later provider delivery.

## Boundaries

The feature may use the managed Hermes adapter, its existing startup and
`pre_llm_call` seams, a cohesive plugin-owned typed cache, and the existing
managed-agent startup projection extended with the complete admitted namespace
name set.

The orientation:

- explains `tool_portal_list`, `tool_portal_search`, `tool_portal_describe`,
  and `tool_portal_call`;
- contains at most 20 namespace names and at most 2,000 UTF-8 bytes;
- labels bounded namespace availability truthfully;
- directs the model to list or search, describe the exact schema, then call;
- contains no tool schemas, tool descriptions, credentials, arguments, results,
  or complete capability catalog.

## Non-goals

- Downstream provider-delivery tracking or session-cleanup behavior for
  orientation injection.
- Tool Portal discovery from a user turn or session.
- Polling, push invalidation, or refresh within a Gateway epoch.
- System-prompt mutation or dynamic tool-schema mutation.
- Cross-epoch persistence.
- A repository-wide cache framework or a new service, database, IPC channel,
  or public configuration surface.

## Fixed assumptions

- Tool Portal and profile admission are stable within one Gateway epoch.
- Gateway replacement creates a new epoch and therefore new inventory and
  session-injection identities.
- Exact session IDs are opaque. A compaction-created child session ID is a new
  identity and may receive its own orientation once.
- Once `pre_llm_call` returns orientation for an identity, later failure in the
  provider path does not make that identity eligible again.
- Inventory failure never blocks Gateway readiness or a user turn.

## Success evidence

Evidence must show bounded startup inventory and retry behavior, profile and
epoch isolation, deterministic bounded rendering, one atomic injection under
concurrent first turns, no mark while inventory is unresolved or failed, later
eligibility after readiness, no Portal I/O or waiting on the session path,
unchanged system-prompt bytes, strict typing, and absence of delivery-transaction
machinery.
