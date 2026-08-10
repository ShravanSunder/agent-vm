# Hermes Tool Portal Orientation Specification

Requirements authority: [`requirements.md`](requirements.md)

## Observable model

```text
Gateway epoch
  -> immutable admitted namespace names per Hermes profile
  -> background Tool Portal existence probes
  -> cached namespace availability

Hermes user turn
  -> pre_llm_call performs bounded in-memory observations only
  -> zero or one compact orientation block is returned
```

## R1 — Profile and epoch inventory

For every admitted Hermes profile, the plugin MUST start one inventory operation
during managed Gateway startup after Tool Portal requests can be served. Gateway
readiness and message handling MUST NOT wait for this operation.

The immutable profile projection MUST contain the complete, duplicate-free set
of namespace names admitted on the managed `protected_uds` Tool Portal surface.
It MUST contain names only, not schemas, descriptions, backend configuration,
credentials, or availability claims. The admitted name set MUST participate in
the existing profile assignment revision and projection-cohort identity.

Inventory MUST classify every projected namespace as `available` or
`unavailable`. A namespace is `available` only when a complete valid attempt
confirms at least one profile-visible tool. An admitted namespace without such
confirmation is `unavailable`. Results from another profile MUST NOT be reused.

Discovery MUST use the existing namespace-filtered Tool Portal list operation as
an existence probe with one namespace, `limit=1`, and no cursor. It MUST NOT
enumerate later pages or retain capability summaries. An attempt is invalid if
aggregate items are missing, duplicated, mismatched, malformed, cross namespace
boundaries, or return more than the requested single tool; observations from an
invalid attempt MUST be discarded.

One operation consists of one initial attempt and at most two retries within one
60-second deadline measured from its start. A successful attempt stops retrying.
Invalid authority, plugin shutdown, or epoch replacement stops retrying. Each
failed attempt MUST produce one bounded structured log with profile/epoch
correlation, attempt number, failure class, and retry disposition, without raw
diagnostics, credentials, or tool data.

Inventory MUST NOT refresh within an epoch. A successor epoch MUST start new
inventory and MUST NOT observe predecessor values.

## R2 — Orientation content

A ready inventory MUST render a deterministic orientation that:

1. identifies Tool Portal as the capability discovery and calling surface;
2. explains the compact purpose of `tool_portal_list`, `tool_portal_search`,
   `tool_portal_describe`, and `tool_portal_call`;
3. includes namespace availability for no more than 20 names; and
4. tells the model to list or search, describe the exact schema, then call.

The complete block MUST be no more than 2,000 UTF-8 bytes, use LF separators,
and have no trailing newline. Names MUST be sorted case-sensitively by ascending
Unicode code point and rendered with the shared canonical JSON string encoder.
If names are omitted, the block MUST state the omitted count and direct the
model to search. The renderer MUST choose the greatest sorted prefix that fits
the complete byte-bounded block. If even the zero-name form cannot fit, it MUST
fail closed and no orientation is available.

The block MUST NOT contain tool schemas, tool descriptions, capability summaries,
credentials, arguments, results, or the complete catalog.

## R3 — Session-once injection

The injection identity MUST be exactly:

```text
(Gateway epoch, admitted profile identity, exact Hermes session_id)
```

For each `pre_llm_call`, the plugin MUST sample inventory state once through a
nonblocking in-memory read.

- If inventory is unresolved or terminally failed, the hook MUST return no
  orientation and MUST NOT mark the identity.
- If inventory is ready, the hook MUST atomically mark the identity if absent.
- The caller that successfully creates the mark MUST return the ready orientation.
- A caller observing an existing mark MUST return no orientation.

The successful atomic mark and returned orientation are one plugin operation.
Returning the orientation counts as injected. Later provider behavior MUST NOT
change that mark.

Concurrent first ready turns for the same identity MUST produce exactly one
orientation result. Different profile, session, or epoch identities MUST be
independent. A child session ID created by compaction is independently eligible.
A successor epoch is independently eligible even when the session ID is reused.

The session call path MUST perform no Tool Portal I/O, start or join no inventory
future, wait on no inventory deadline, and receive no inventory exception.

## R4 — Prompt-cache preservation

Orientation MUST be returned only through Hermes's existing `pre_llm_call`
user-context result. The plugin MUST NOT mutate or rebuild the system prompt or
tool definitions. Later turns for a marked identity MUST add no new orientation
bytes. Historical message handling remains owned by Hermes; this plugin defines
no provider-content confirmation or replay protocol.

## R5 — Typed plugin state

Consumer-visible keys, values, snapshots, terminal results, and eviction records
MUST be frozen Pydantic-v2 models. The managed Tool Portal plugin boundary MUST
use explicit typed Python contracts and MUST contain no `Any`, `TypedDict`,
dataclass, `NamedTuple`, variadic untyped callback, unchecked cast, or loose
state dictionary.

The generic cache MUST provide atomic key operations, single-flight population,
nonblocking observation, close/epoch invalidation, and bounded diagnostic
eviction information. Tool Portal inventory and session-injection marks MAY use
separate typed instances or typed facades over that cache. No session state is
required beyond the presence of the injection identity.

## Observable contracts

### C1 — Background inventory

No later than 60 seconds after inventory begins, the profile has either a ready
complete availability value or a typed terminal failure. No more than three
attempts occur. Gateway readiness and user calls remain independent of that
outcome.

### C2 — User turn

`pre_llm_call` returns either `{"context": <orientation>}` for the one atomic
winner or no context. An unresolved or failed inventory does not consume the
identity. A ready inventory does not cause Portal I/O in this path.

### C3 — State validity

Cache consumers can distinguish unresolved, populating, ready, failed, and
evicted inventory outcomes through typed values. Session state answers only
whether the complete injection identity was already marked.

## Failure and quality obligations

- Inventory and rendering failure MUST NOT prevent a user turn or broaden
  profile authority.
- Unconfirmed namespaces MUST NOT be presented as available.
- Cache state and logs MUST NOT contain user-message content, credentials,
  approval tokens, raw tool arguments/results, or raw Portal diagnostics.
- Successful per-turn cache observations need not emit telemetry.
- All state is process-local and ends with the Gateway/plugin epoch.
- Existing Tool Portal operation behavior remains unchanged.

## Proof obligations

Evidence MUST cover:

- eager per-profile startup, single flight, attempt limit, shared deadline,
  logging, shutdown, and successor-epoch isolation;
- availability classification from bounded existence probes, including invalid
  and partial aggregate results;
- deterministic Unicode ordering, truncation, unavailable labels, and the
  20-name/2,000-byte limits;
- first ready turn injects and marks; later same-identity turn does not;
- unresolved and failed inventory do not mark; a later ready turn may inject;
- independent session, profile, and epoch identities;
- concurrent first turns produce exactly one injection;
- session-path absence of Tool Portal I/O and waiting;
- unchanged system-prompt bytes and absence of catalog content; and
- strict type checks plus a source scan proving transaction machinery is absent.

## Undefined behavior

- Tool Portal changes within an epoch are outside this version.
- Ordering of inventory work across different profiles is not observable.
- Later provider delivery, retry, fan-out, or persistence behavior does not
  change the injection mark.
